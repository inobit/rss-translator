import * as cheerio from 'cheerio';
import { createLogger } from '../utils/logger';
import type { WorkerEnv, ResolvedProvider } from '../types';
import { translateTexts, type LlmProviderConfig } from './translate';

export interface ArticleImage {
  src: string;
  alt: string;
  copyright?: string;
}

export type ContentBlock =
  | { type: 'text'; texts: string[] }
  | { type: 'heading'; text: string }
  | { type: 'image'; image: ArticleImage }
  | { type: 'disclaimer'; text: string }
  | { type: 'references'; title: string; items: string[] }
  | { type: 'code'; code: string; language?: string }
  | { type: 'quote'; texts: string[] };

export interface ArticleData {
  title: string;
  author?: string;
  authorUrl?: string;
  role?: string;
  date?: string;
  summary?: string;
  images: ArticleImage[];
  paragraphs: string[];
  blocks: ContentBlock[];
}

/** 每个 source 的文章提取器 */
interface SourceExtractor {
  extract($: ReturnType<typeof cheerio.load>, rawHtml?: string): ArticleData;
}

/** 默认移除元素 */
const DEFAULT_REMOVE_SELECTORS = [
  'script', 'style', 'noscript',
  'nav', 'footer', 'aside',
  '.social-share', '.advertisement',
  '[role="navigation"]', '[role="banner"]',
];

// ================ 通用工具函数 ================

/** 从原始 HTML 用正则提取 JSON-LD，不依赖 cheerio（cheerio 对部分页面的 script 选择器不稳定） */
function extractJsonLdFromRaw(html: string): Record<string, unknown> | null {
  const ldRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  let firstValid: Record<string, unknown> | null = null;

  while ((match = ldRegex.exec(html)) !== null) {
    try {
      const text = match[1].trim();
      if (!text) continue;
      const parsed = JSON.parse(text);

      const items: Record<string, unknown>[] = Array.isArray(parsed) ? parsed : [parsed];

      for (const item of items) {
        if (!firstValid) firstValid = item;
        if (item['@type'] === 'NewsArticle' || item['@type'] === 'Article') {
          return item;
        }
      }
    } catch {
      continue;
    }
  }
  return firstValid;
}

/** 从页面提取 JSON-LD，兼容正则和 cheerio 两种方式 */
function extractJsonLd($: ReturnType<typeof cheerio.load>, rawHtml?: string): Record<string, unknown> | null {
  // 优先用正则从原始 HTML 提取（不依赖 cheerio 的 script 选择器）
  if (rawHtml) {
    const result = extractJsonLdFromRaw(rawHtml);
    if (result) return result;
  }

  // 降级：cheerio 选择器（对 BBC、SciAm 等有效）
  const scripts = $('script[type="application/ld+json"]').toArray();
  let firstValid: Record<string, unknown> | null = null;
  for (const el of scripts) {
    try {
      const text = $(el).text();
      if (!text) continue;
      const parsed = JSON.parse(text);
      const items: Record<string, unknown>[] = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (!firstValid) firstValid = item;
        if (item['@type'] === 'NewsArticle' || item['@type'] === 'Article') {
          return item;
        }
      }
    } catch {
      continue;
    }
  }
  return firstValid;
}

/** 通用标题降级：h1 → [data-testid="headline"] → <title> → og:title */
function fallbackTitle($: ReturnType<typeof cheerio.load>): string {
  return $('h1').first().text().trim()
    || $('[data-testid="headline"]').first().text().trim()
    || $('title').first().text().trim()
    || $('meta[property="og:title"]').attr('content')
    || 'Untitled';
}

/** 通用日期降级 */
function fallbackDate($: ReturnType<typeof cheerio.load>): string | undefined {
  const time = $('time[datetime]').first().attr('datetime')
    || $('time').first().text().trim()
    || undefined;
  return time;
}

/** 去除 HTML 标签，保留纯文本 */
function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]*>/g, '').trim();
}

/** 英文月份名 → 中文数字 */
const MONTH_NAMES: Record<string, string> = {
  january: '1', february: '2', march: '3', april: '4', may: '5', june: '6',
  july: '7', august: '8', september: '9', october: '10', november: '11', december: '12',
  jan: '1', feb: '2', mar: '3', apr: '4', jun: '6', jul: '7', aug: '8', sep: '9',
  oct: '10', nov: '11', dec: '12',
};

/**
 * 将日期字符串本地格式化为中文，避免 LLM 翻译日期导致的时区/格式错误
 * 支持 ISO 8601 和常见英文日期文本
 */
function formatDateZh(dateStr: string): string {
  // ISO 8601: "2026-06-30T13:00:00-04:00"
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})[T ]/.exec(dateStr);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10);
    const day = parseInt(isoMatch[3], 10);
    return `${year}年${month}月${day}日`;
  }

  // "June 30, 2026" / "July 2, 2026" / "June 23rd, 2026"（月份在前）
  const patternMDY = /(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/i;
  const matchMDY = patternMDY.exec(dateStr);
  if (matchMDY) {
    const month = MONTH_NAMES[matchMDY[1].toLowerCase()];
    const day = parseInt(matchMDY[2], 10);
    return `${matchMDY[3]}年${month}月${day}日`;
  }

  // "2 July 2026" / "30 June 2026" / "23rd June 2026"（日期在前）
  const patternDMY = /(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i;
  const matchDMY = patternDMY.exec(dateStr);
  if (matchDMY) {
    const month = MONTH_NAMES[matchDMY[2].toLowerCase()];
    const day = parseInt(matchDMY[1], 10);
    // 提取时间和时区（如 ", 02:55 BST"）
    const afterDate = dateStr.slice(matchDMY.index + matchDMY[0].length);
    const timeMatch = /(\d{2}:\d{2})/.exec(afterDate);
    let suffix = '';
    if (timeMatch) {
      suffix += ` ${timeMatch[1]}`;
      // 时区缩写
      const tzMatch = /\b([A-Z]{2,4})\b/.exec(afterDate.slice((timeMatch.index ?? 0) + timeMatch[0].length));
      if (tzMatch && tzMatch[1] !== '00') suffix += ` ${tzMatch[1]}`;
    }
    return `${matchDMY[3]}年${month}月${day}日${suffix}`;
  }

  // 无法解析，返回原文
  return dateStr;
}

/** 按 data-block 提取正文和图片（通用逻辑） */
function extractDataBlocks($: ReturnType<typeof cheerio.load>): ArticleData {
  const images: ArticleImage[] = [];
  const paragraphs: string[] = [];
  const blocks: ContentBlock[] = [];

  const $article = $('article').first();
  $article.find('[data-block]').each((_i, el) => {
    const $el = $(el);
    const blockType = $el.attr('data-block') || '';

    if (blockType.includes('text') || blockType.endsWith('/paragraph')) {
      const $pTags = $el.is('p') ? $el : $el.find('p');
      const blockParas: string[] = [];
      $pTags.each((_j, pEl) => {
        const text = $(pEl).text().trim();
        if (text && text.length > 10) {
          paragraphs.push(text);
          blockParas.push(text);
        }
      });
      // 同时提取子标题（h2/h3/h4），作为独立 heading 块
      $el.find('h2, h3, h4').each((_j, hEl) => {
        const text = $(hEl).text().trim();
        if (text && text.length > 2) {
          blocks.push({ type: 'heading', text });
        }
      });
      if (blockParas.length > 0) {
        blocks.push({ type: 'text', texts: blockParas });
      }
    } else if (blockType.includes('heading')) {
      const text = $el.text().trim();
      if (text && text.length > 2) {
        blocks.push({ type: 'heading', text });
      }
    } else if (blockType.includes('image') || blockType === 'video') {
      const $img = $el.find('img').first();
      if ($img.length) {
        const src = $img.attr('src');
        const alt = $img.attr('alt') || '';
        if (src) {
          const copyright = $el.find('[class*="Copyright"], [class*="copyright"]')
            .first().text().trim() || undefined;
          const img: ArticleImage = { src, alt, copyright };
          images.push(img);
          blocks.push({ type: 'image', image: img });
        }
      }
    }
  });

  return { title: '', images, paragraphs, blocks };
}

/** JSON-LD / meta 降级（视频页或没有 data-block 的页面） */
function fallbackFromMeta($: ReturnType<typeof cheerio.load>): ArticleData {
  const images: ArticleImage[] = [];
  const paragraphs: string[] = [];
  const blocks: ContentBlock[] = [];
  let date: string | undefined;

  const jsonLd = extractJsonLd($);
  if (jsonLd?.['@type'] === 'VideoObject') {
    const ldThumb = jsonLd.thumbnailUrl;
    const ldName = jsonLd.name as string | undefined;
    const ldDesc = jsonLd.description as string | undefined;
    const ldDate = jsonLd.uploadDate as string | undefined;

    if (ldThumb) {
      const thumbUrl = Array.isArray(ldThumb) ? (ldThumb[0] as string) : (ldThumb as string);
      const img: ArticleImage = { src: thumbUrl, alt: ldName || '' };
      images.push(img);
      blocks.push({ type: 'image', image: img });
    }
    if (ldDesc) {
      paragraphs.push(ldDesc);
      blocks.push({ type: 'text', texts: [ldDesc] });
    }
    if (ldDate) date = ldDate;
  } else {
    const ogImage = $('meta[property="og:image"]').attr('content');
    const ogAlt = $('meta[property="og:image:alt"]').attr('content') || '';
    const metaDesc = $('meta[name="description"]').attr('content')
      || $('meta[property="og:description"]').attr('content') || '';

    if (ogImage) {
      images.push({ src: ogImage, alt: ogAlt });
      blocks.push({ type: 'image', image: { src: ogImage, alt: ogAlt } });
    }
    if (metaDesc) {
      paragraphs.push(metaDesc);
      blocks.push({ type: 'text', texts: [metaDesc] });
    }
  }

  $('picture img').each((_i, el) => {
    const src = $(el).attr('src');
    const alt = $(el).attr('alt') || '';
    if (src && images.length < 10) {
      const img: ArticleImage = { src, alt };
      images.push(img);
      blocks.push({ type: 'image', image: img });
    }
  });

  return { title: '', author: undefined, role: undefined, date, images, paragraphs, blocks };
}


// ================ BBC 提取器 ================

function bbcExtract($: ReturnType<typeof cheerio.load>): ArticleData {
  // 移除 BBC 特有噪音
  $('[data-testid="topic-list"], [data-component="topic-list"], [data-block="promoList"]').remove();
  $('[class*="-TopicList"], [class*="-RelatedContent"], [class*="-MoreOnThis"], [class*="-PromoSwitch"]').remove();
  $('section[class*="comments"]').remove();

  const title = $('h1[data-testid="headline"], [data-testid="headline"] h1, #main-heading')
    .first().text().trim() || fallbackTitle($);

  let author: string | undefined;
  let role: string | undefined;
  const byline = $('[data-testid="single-byline"], [data-testid="byline"]').first();
  if (byline.length) {
    author = byline.find('.ssrcss-nsjd43-TextContributorName, [class*="ContributorName"]')
      .first().text().trim() || undefined;
    role = byline.find('.ssrcss-dqo7s5-ContributorDetails, [class*="ContributorDetails"]')
      .first().text().trim() || undefined;
  }

  let date: string | undefined;
  const meta = $('[data-testid="metadata"]').first();
  if (meta.length) {
    // 优先使用 time 元素的 datetime 属性（ISO 8601），更可靠
    const $time = meta.find('time').first();
    date = $time.attr('datetime') || $time.text().trim() || undefined;
    if (!date) date = meta.find('[class*="MetadataStrip"] li, [class*="Timestamp"]')
      .first().text().trim() || undefined;
    if (!date) date = meta.find('li, span').first().text().trim() || undefined;
  }

  const data = extractDataBlocks($);
  if (data.blocks.length === 0) {
    const fallback = fallbackFromMeta($);
    data.images.push(...fallback.images);
    data.paragraphs.push(...fallback.paragraphs);
    data.blocks.push(...fallback.blocks);
    date = date || fallback.date;
  }

  return { title, author, role, date, images: data.images, paragraphs: data.paragraphs, blocks: data.blocks };
}


// ================ SciAm 提取器 ================

/** 从 JSON-LD author/editor 字段提取名称，兼容单对象和数组格式 */
function extractPersonName(value: unknown): string | undefined {
  if (!value) return undefined;
  if (!Array.isArray(value)) {
    return (value as { name?: string })?.name || undefined;
  }
  return (value[0] as { name?: string })?.name || undefined;
}

/** 从 JSON-LD author 字段提取个人主页 URL（sameAs 或 url） */
function extractPersonUrl(value: unknown): string | undefined {
  if (!value) return undefined;
  if (!Array.isArray(value)) {
    return (value as { sameAs?: string; url?: string })?.sameAs
      || (value as { sameAs?: string; url?: string })?.url
      || undefined;
  }
  return (value[0] as { sameAs?: string; url?: string })?.sameAs
    || (value[0] as { sameAs?: string; url?: string })?.url
    || undefined;
}

/** 从 meta 标签提取内容 */
function extractMeta($: ReturnType<typeof cheerio.load>, selector: string): string | undefined {
  return $(selector).attr('content')?.trim() || undefined;
}

function sciamExtract($: ReturnType<typeof cheerio.load>, _rawHtml?: string): ArticleData {
  // 移除 SciAm 特有的募捐/订阅广告和转载声明
  $('[class*="subscriptionPlea"], [class*="donation"], [class*="inlineNewsletter"]').remove();

  // 过滤转载声明段落（This article was originally published by...）
  const isReprintNote = (text: string) =>
    /originally published|originally appeared|read the original|最初发表|最初刊登|原文|转载|本文最初|Stand Up for Science|stand up for science/i.test(text);

  const jsonLd = extractJsonLd($);
  const title = (jsonLd?.headline as string) || fallbackTitle($);
  const date = (jsonLd?.datePublished as string)
    || extractMeta($, 'meta[property="article:published_time"]')
    || extractMeta($, 'meta[name="pubdate"]')
    || extractMeta($, 'meta[name="date"]')
    || $('[class*="article_pub_date"]').first().text().trim()
    || fallbackDate($);
  const author = extractPersonName(jsonLd?.author)
    || extractMeta($, 'meta[name="author"]')
    || undefined;
  const summary = (jsonLd?.description as string)
    || extractMeta($, 'meta[name="description"]')
    || extractMeta($, 'meta[property="og:description"]')
    || undefined;
  const data = extractDataBlocks($);

  // 从 JSON-LD 或 og:image 提取题图
  if (data.images.length === 0) {
    const ldImg = jsonLd?.thumbnailUrl || jsonLd?.image;
    const ldImgUrl: string | undefined = Array.isArray(ldImg)
      ? (ldImg[0] as string)
      : ldImg as string | undefined;
    const ogImg = $('meta[property="og:image"]').attr('content');
    const heroUrl = ldImgUrl || ogImg;
    if (heroUrl) {
      const alt = (jsonLd?.name as string) || $('meta[property="og:image:alt"]').attr('content') || '';
      data.images.unshift({ src: heroUrl, alt });
      data.blocks.unshift({ type: 'image', image: { src: heroUrl, alt } });
    }
  }

  // 过滤转载声明段落
  data.blocks = data.blocks.filter(b => {
    if (b.type === 'text') {
      b.texts = b.texts.filter(t => !isReprintNote(t));
      return b.texts.length > 0;
    }
    if (b.type === 'heading') {
      return !isReprintNote(b.text);
    }
    return true;
  });
  data.paragraphs = data.paragraphs.filter(p => !isReprintNote(p));
  if (data.blocks.length === 0) {
    const fallback = fallbackFromMeta($);
    data.images.push(...fallback.images);
    data.paragraphs.push(...fallback.paragraphs);
    data.blocks.push(...fallback.blocks);
  }

  return { title, author, date, summary, images: data.images, paragraphs: data.paragraphs, blocks: data.blocks };
}


// ================ Guardian 提取器 ================

function guardianExtract($: ReturnType<typeof cheerio.load>, rawHtml?: string): ArticleData {
  // 移除 Guardian 特有噪音：sign-in-gate、newsletter、rich link
  $('#sign-in-gate').remove();
  $('figure[data-spacefinder-type*="NewsletterSignup"]').remove();
  $('figure[data-spacefinder-type*="RichLink"]').remove();
  $('gu-island').remove();

  const jsonLd = extractJsonLd($, rawHtml);

  const title = (jsonLd?.headline as string)
    || $('h1').first().text().trim()
    || fallbackTitle($);

  const author = extractPersonName(jsonLd?.author)
    || extractMeta($, 'meta[property="article:author"]')
    || undefined;

  const authorUrl = extractPersonUrl(jsonLd?.author)
    || undefined;

  const date = (jsonLd?.datePublished as string)
    || extractMeta($, 'meta[property="article:published_time"]')
    || undefined;

  const summary = (jsonLd?.description as string)
    || extractMeta($, 'meta[name="description"]')
    || extractMeta($, 'meta[property="og:description"]')
    || undefined;

  const images: ArticleImage[] = [];
  const paragraphs: string[] = [];
  const blocks: ContentBlock[] = [];
  const addedImageSrcs = new Set<string>();

  // 提取主图（Guardian 使用 picture 元素包裹 lead image）
  const $mainPicture = $('picture').first();
  if ($mainPicture.length) {
    const $img = $mainPicture.find('img').first();
    const src = $img.attr('src');
    let alt = $img.attr('alt') || '';
    if (src) {
      // Guardian DCR 格式下，主图完整说明通常在 <figure> 的 <figcaption> 中，
      // <img alt> 可能缺失或不完整，优先取 figcaption 文本
      const $parentFigure = $mainPicture.closest('figure');
      if ($parentFigure.length) {
        const $figcaption = $parentFigure.find('figcaption').first();
        if ($figcaption.length) {
          const captionText = $figcaption.text().trim();
          if (captionText) alt = captionText;
        }
      }
      addedImageSrcs.add(src);
      images.push({ src, alt });
      blocks.push({ type: 'image', image: { src, alt } });
    }
  }

  // 提取正文段落
  // 优先使用旧版 DCR 格式（[class*="article-body"] 容器）
  const $body = $('[class*="article-body"]').first();

  // 新版 DCR 格式：无统一容器，通过内容特征元素定位
  let $dcrContainer: ReturnType<ReturnType<typeof cheerio.load>> | null = null;
  if (!$body.length) {
    const $anchor = $('p.dcr-1s160rg, figure[data-spacefinder-type*="ImageBlockElement"], h2.dcr-8418j6').first();
    if ($anchor.length) {
      $dcrContainer = $anchor.parent();
    }
  }

  const $container = $body.length ? $body : $dcrContainer;
  if ($container?.length) {
    $container.children().each((_i, el) => {
      const $el = $(el);
      const tag = (el as { tagName?: string }).tagName?.toLowerCase() || '';
      const cls = $el.attr('class') || '';

      if ($el.is('#sign-in-gate')) return;

      // 图片
      if (tag === 'figure') {
        const $img = $el.find('img').first();
        const $figcaption = $el.find('figcaption').first();

        let imgAlt = '';
        let imgSrc = '';

        if ($img.length) {
          imgSrc = $img.attr('src') || '';
          imgAlt = $img.attr('alt') || '';
        }

        // figcaption 作为图片说明文字，覆盖 img 的 alt
        if ($figcaption.length) {
          const capText = $figcaption.text().trim();
          if (capText) imgAlt = capText;
        }

        if (imgSrc && !addedImageSrcs.has(imgSrc)) {
          addedImageSrcs.add(imgSrc);
          images.push({ src: imgSrc, alt: imgAlt });
          blocks.push({ type: 'image', image: { src: imgSrc, alt: imgAlt } });
        }
        return;
      }

      // 子标题
      if (tag === 'h2' && (cls.includes('dcr-') || cls.includes('article-'))) {
        const text = $el.text().trim();
        if (text && text.length > 2) {
          blocks.push({ type: 'heading', text });
        }
        return;
      }

      // 段落
      if (tag === 'p') {
        const text = $el.text().trim();
        if (text && text.length > 10) {
          paragraphs.push(text);
          blocks.push({ type: 'text', texts: [text] });
        }
        return;
      }

      // 列表
      if (tag === 'ul' || tag === 'ol') {
        const items: string[] = [];
        $el.find('li').each((_j, liEl) => {
          const text = $(liEl).text().trim();
          if (text && text.length > 5) items.push(text);
        });
        if (items.length > 0) {
          paragraphs.push(...items);
          blocks.push({ type: 'text', texts: items });
        }
        return;
      }

      // blockquote
      if (tag === 'blockquote') {
        const texts: string[] = [];
        $el.find('p').each((_j, pEl) => {
          const text = $(pEl).text().trim();
          if (text && text.length > 2) texts.push(text);
        });
        if (texts.length > 0) {
          paragraphs.push(...texts);
          blocks.push({ type: 'text', texts });
        }
        return;
      }
    });
  }

  // 正文为空时降级为 meta 提取
  if (blocks.filter(b => b.type === 'text' || b.type === 'heading').length === 0) {
    if (images.length === 0) {
      const ogImg = extractMeta($, 'meta[property="og:image"]');
      if (ogImg) {
        images.push({ src: ogImg, alt: '' });
        blocks.push({ type: 'image', image: { src: ogImg, alt: '' } });
      }
    }
    const fallback = fallbackFromMeta($);
    for (const fb of fallback.blocks) {
      if (fb.type === 'image' && !addedImageSrcs.has(fb.image.src)) {
        addedImageSrcs.add(fb.image.src);
        images.push(fb.image);
      }
    }
    paragraphs.push(...fallback.paragraphs);
    blocks.push(...fallback.blocks);
  }

  return { title, author, authorUrl, date, summary, images, paragraphs, blocks };
}


// ================ 通用提取器（降级） ================

function genericExtract($: ReturnType<typeof cheerio.load>, _rawHtml?: string): ArticleData {
  const jsonLd = extractJsonLd($);
  const title = (jsonLd?.headline as string) || fallbackTitle($);

  const data = extractDataBlocks($);
  if (data.blocks.length === 0) {
    const fallback = fallbackFromMeta($);
    data.images.push(...fallback.images);
    data.paragraphs.push(...fallback.paragraphs);
    data.blocks.push(...fallback.blocks);
  }

  return {
    title,
    images: data.images,
    paragraphs: data.paragraphs,
    blocks: data.blocks,
  };
}


// ================ MIT News 提取器 ================

function mitNewsExtract($: ReturnType<typeof cheerio.load>, _rawHtml?: string): ArticleData {
  // 移除噪音元素
  $('.news-article--press-inquiries, .news-article--press-inquiries--download-images').remove();
  $('.news-article--related, .news-article--related-archive').remove();
  $('.news-article--images-gallery').remove();
  $('.news-article--content--side-column').remove();
  $('.news-article--content-block--inline-image--items-nav').remove();

  const title = $('h1 [itemprop="name headline"]').first().text().trim()
    || fallbackTitle($);

  const summary = $('.news-article--dek').first().text().trim() || undefined;

  const author = $('.news-article--authored-by .news-article--author').first().text().trim()
    || $('.news-article--author').first().text().trim()
    || extractMeta($, 'meta[name="author"]')
    || undefined;

  let date = $('.news-article--publication-date time[datetime]').first().attr('datetime')
    || $('.news-article--publication-date time').first().text().trim()
    || fallbackDate($);

  const images: ArticleImage[] = [];
  const paragraphs: string[] = [];
  const blocks: ContentBlock[] = [];

  // 提取 lead image（og:image）
  const ogImage = $('meta[property="og:image"]').attr('content');
  if (ogImage) {
    const ogAlt = $('meta[property="og:image:alt"]').attr('content') || '';
    images.push({ src: ogImage, alt: ogAlt });
    blocks.push({ type: 'image', image: { src: ogImage, alt: ogAlt } });
  }

  // 提取正文（.news-article--content--body--inner）
  const $body = $('.news-article--content--body--inner').first();
  if ($body.length) {
    // 先提取所有 inline image items（它们可能嵌套在 wrapper 中）
    $body.find('.news-article--inline-image--item').each((_i, el) => {
      const $item = $(el);
      const $img = $item.find('img[loading="lazy"]').first();
      const src = $img.attr('data-src') || $img.attr('src');
      const alt = $img.attr('alt') || '';
      if (src && !images.some(i => i.src === src)) {
        const caption = $item.find('.news-article--inline-image--caption').first().text().trim();
        const credits = $item.find('.news-article--inline-image--credits').first().text().trim();
        const altText = [alt, caption].filter(Boolean).join(' - ');
        const copyright = credits || undefined;
        const img: ArticleImage = { src, alt: altText, copyright };
        images.push(img);
        blocks.push({ type: 'image', image: img });
      }
    });

    // 遍历所有子元素，按顺序提取文本
    $body.children().each((_i, el) => {
      const $el = $(el);

      // 跳过已处理的 inline image wrapper
      if ($el.hasClass('news-article--content-block--inline-image--items--wrapper')
        || $el.hasClass('news-article--content-block--inline-image--items')) {
        return;
      }

      // text blocks
      if ($el.hasClass('paragraph--type--content-block-text')) {
        const $pTags = $el.find('p');
        $pTags.each((_j, pEl) => {
          const text = $(pEl).text().trim();
          if (text && text.length > 10) {
            // 子标题（加粗段落）
            const $strong = $(pEl).find('strong').first();
            if ($strong.length && $strong.text().trim().length > 2
              && $strong.text().trim().length < 60
              && $(pEl).text().trim().length < 100) {
              blocks.push({ type: 'heading', text: $strong.text().trim() });
              return;
            }
            paragraphs.push(text);
            blocks.push({ type: 'text', texts: [text] });
          }
        });
      }
    });
  }

  // 正文为空时降级
  if (blocks.length === 0) {
    const fallback = fallbackFromMeta($);
    images.push(...fallback.images);
    paragraphs.push(...fallback.paragraphs);
    blocks.push(...fallback.blocks);
    date = date || fallback.date;
  }

  return { title, author, date, summary, images, paragraphs, blocks };
}


// ================ The Register 提取器 ================

function registerExtract($: ReturnType<typeof cheerio.load>, _rawHtml?: string): ArticleData {
  // 移除广告、相关文章列表等噪音
  $('.bodytext .google-ad, .bodytext .articleList').remove();
  $('.articleFooter').remove();
  $('[class*="paywall"]').remove();

  const title = $('.articleHeader h1.headline').first().text().trim()
    || $('h1').first().text().trim()
    || fallbackTitle($);

  const summary = $('.articleHeader .subtitle').first().text().trim() || undefined;

  // author: 优先 itemprop="name"，降级 .byline .name 内文字
  const author = $('.byline [itemprop="name"]').first().text().trim()
    || $('.byline .name .firstname').text().trim() + ' ' + $('.byline .name .lastname').text().trim()
    || extractMeta($, 'meta[property="article:author"]')
    || undefined;

  const authorUrl = $('.byline a[rel="author"]').first().attr('href') || undefined;

  let date = $('.meta .datePublished time[datetime]').first().attr('datetime')
    || extractMeta($, 'meta[property="article:published_time"]')
    || fallbackDate($);

  const images: ArticleImage[] = [];
  const paragraphs: string[] = [];
  const blocks: ContentBlock[] = [];

  // lead image（og:image）
  const ogImage = $('meta[property="og:image"]').attr('content');
  if (ogImage) {
    const ogAlt = $('meta[property="og:image:alt"]').attr('content') || title;
    images.push({ src: ogImage, alt: ogAlt });
    blocks.push({ type: 'image', image: { src: ogImage, alt: ogAlt } });
  }

  // 提取正文：.bodytext 中所有 p 标签
  const $body = $('.bodytext').first();
  if ($body.length) {
    $body.find('p').each((_i, el) => {
      const $p = $(el);
      // 跳过广告和噪音内部的 p
      if ($p.closest('.google-ad, .articleList, .paywall').length) return;
      const text = $p.text().trim();
      if (text && text.length > 10) {
        paragraphs.push(text);
        blocks.push({ type: 'text', texts: [text] });
      }
    });
  }

  // 正文为空时降级
  if (blocks.length === 0) {
    const fallback = fallbackFromMeta($);
    images.push(...fallback.images);
    paragraphs.push(...fallback.paragraphs);
    blocks.push(...fallback.blocks);
    date = date || fallback.date;
  }

  return { title, author, authorUrl, date, summary, images, paragraphs, blocks };
}


// ================ Towards Data Science 提取器 ================

function tdsExtract($: ReturnType<typeof cheerio.load>, rawHtml?: string): ArticleData {
  // 移除广告、newsletter 等噪音
  $('.ad-section, .wp-block-tds-ad-slot, .tds-cta-box, .tds-subscribe-newsletter').remove();
  $('[class*="newsletter"], [class*="paywall"]').remove();

  const jsonLd = extractJsonLd($, rawHtml);

  const title = $('h1.wp-block-post-title').first().text().trim()
    || (jsonLd?.headline as string)
    || fallbackTitle($);

  const author = $('.wp-block-post-author-name').first().text().trim()
    || extractPersonName(jsonLd?.author)
    || extractMeta($, 'meta[name="author"]')
    || undefined;

  const authorUrl = $('.wp-block-post-author-name__link').first().attr('href')
    || extractPersonUrl(jsonLd?.author)
    || undefined;

  const date = $('.wp-block-post-date time[datetime]').first().attr('datetime')
    || (jsonLd?.datePublished as string)
    || extractMeta($, 'meta[property="article:published_time"]')
    || undefined;

  const summary = $('.tds-theme-post-subheading').first().text().trim()
    || (jsonLd?.description as string)
    || extractMeta($, 'meta[property="og:description"]')
    || undefined;

  const images: ArticleImage[] = [];
  const paragraphs: string[] = [];
  const blocks: ContentBlock[] = [];

  // 提取 featured image
  const $featuredImg = $('.wp-block-post-featured-image img').first();
  if ($featuredImg.length) {
    const src = $featuredImg.attr('src');
    const alt = $featuredImg.attr('alt') || '';
    if (src) {
      images.push({ src, alt });
      blocks.push({ type: 'image', image: { src, alt } });
    }
  }

  // 从 JSON-LD 或 og:image 降级取题图
  if (images.length === 0) {
    const ldThumb = jsonLd?.thumbnailUrl;
    const ldThumbUrl: string | undefined = Array.isArray(ldThumb)
      ? (ldThumb[0] as string)
      : ldThumb as string | undefined;
    const ogImg = extractMeta($, 'meta[property="og:image"]');
    const heroUrl = ldThumbUrl || ogImg;
    if (heroUrl) {
      images.push({ src: heroUrl, alt: '' });
      blocks.push({ type: 'image', image: { src: heroUrl, alt: '' } });
    }
  }

  // 提取正文
  const $content = $('.entry-content').first();
  // 参考文献区检测：遇到 References/Bibliography 等标题后，后续段落归为参考文献（不翻译）
  let inReferences = false;
  let refTitle = '';
  const refItems: string[] = [];
  const isReferencesHeading = (text: string) =>
    /^(references?|bibliography|further reading|citations?|works cited|参考文献|参考资料|延伸阅读)\s*:?\s*$/i.test(text);

  if ($content.length) {
    $content.children().each((_i, el) => {
      const $el = $(el);

      // 标题
      if ($el.is('h2, h3, h4') || $el.hasClass('wp-block-heading')) {
        const text = $el.text().trim();
        if (isReferencesHeading(text)) {
          inReferences = true;
          refTitle = text;
          return;
        }
        if (text && text.length > 2) {
          blocks.push({ type: 'heading', text });
        }
        return;
      }

      // 段落
      if ($el.is('p') || $el.hasClass('wp-block-paragraph')) {
        const html = ($el.html() || '').trim();
        const text = $el.text().trim();
        if (!text || text.length <= 10) return;
        // 参考文献区：保留原文（含 URL），不翻译
        if (inReferences) {
          // 保留 <a> 可点击链接（使用原始锚文本），仅清理危险标签并添加 target
          const $clone = $el.clone();
          $clone.find('script, style, iframe, object, embed, link, meta').remove();
          $clone.find('a').each((_j, aEl) => {
            $(aEl).attr('target', '_blank').attr('rel', 'noopener noreferrer');
          });
          const refHtml = ($clone.html() || '').trim();
          if (refHtml) refItems.push(refHtml);
          return;
        }
        // <em> 包裹的整段内容视为声明/作者注脚，使用特殊样式
        const isEmphasis = html.startsWith('<em>') && html.endsWith('</em>');
        if (isEmphasis || $el.hasClass('has-caption-2-font-size')) {
          blocks.push({ type: 'disclaimer', text });
        } else {
          paragraphs.push(text);
          blocks.push({ type: 'text', texts: [text] });
        }
        return;
      }

      // 参考文献区内的图片/列表等不再提取
      if (inReferences) return;

      // 图片（Gutenberg image block）
      if ($el.is('figure') || $el.hasClass('wp-block-image')) {
        const $img = $el.find('img').first();
        if ($img.length) {
          const src = $img.attr('src');
          const alt = $img.attr('alt') || '';
          if (src && !images.some(i => i.src === src)) {
            const img: ArticleImage = { src, alt };
            images.push(img);
            blocks.push({ type: 'image', image: img });
          }
        }
        return;
      }

      // 列表
      if ($el.is('ul, ol') || $el.hasClass('wp-block-list')) {
        const items: string[] = [];
        $el.find('li').each((_j, liEl) => {
          const text = $(liEl).text().trim();
          if (text && text.length > 5) items.push(text);
        });
        if (items.length > 0) {
          paragraphs.push(...items);
          blocks.push({ type: 'text', texts: items });
        }
        return;
      }

      // 代码块跳过
      if ($el.is('pre') || $el.hasClass('wp-block-code')) return;
    });
  }

  // 收集到的参考文献作为独立 block
  if (refItems.length > 0) {
    blocks.push({ type: 'references', title: refTitle || 'References', items: refItems });
  }

  // 正文为空时降级
  if (blocks.length === 0) {
    const fallback = fallbackFromMeta($);
    images.push(...fallback.images);
    paragraphs.push(...fallback.paragraphs);
    blocks.push(...fallback.blocks);
  }

  return { title, author, authorUrl, date, summary, images, paragraphs, blocks };
}


// ================ Simon Willison 提取器 ================

/** 从 highlight 类名推断语言，如 highlight-source-shell → shell */
function inferLanguage($el: ReturnType<ReturnType<typeof cheerio.load>>): string | undefined {
  const cls = $el.attr('class') || '';
  const m = /highlight-source-(\w+)/.exec(cls);
  return m ? m[1] : undefined;
}

function simonwExtract($: ReturnType<typeof cheerio.load>, _rawHtml?: string): ArticleData {
  // 移除 side column、footer、recent articles 等噪音
  $('#secondary, #sponsored-banner, #ft, .recent-articles, .entryFooter, .edit-page-link').remove();
  $('.metabox section[style*="promo"], .metabox .promo').remove();

  const $entry = $('.entry.entryPage').first();
  const isBeat = $entry.find('.beat').length > 0;

  // 标题
  let title: string;
  if (isBeat) {
    title = $entry.find('.beat-title a').first().text().trim()
      || $entry.find('h2').first().text().trim()
      || fallbackTitle($);
  } else {
    title = $entry.find('[data-permalink-context] h2').first().text().trim()
      || $entry.find('h2').first().text().trim()
      || fallbackTitle($);
  }

  const author = $('meta[name="author"]').attr('content')?.trim() || undefined;

  // 日期: 兼容 p.mobile-date-eyebrow / p.mobile-date 两种格式
  const dateStr = $entry.find('p.mobile-date-eyebrow').first().text().trim()
    || $entry.find('p.mobile-date').first().text().trim()
    || undefined;

  // beat 条目有 .beat-commit 作为副标题/摘要（如 "An open source multi-tool for..."）
  // 普通博文没有独立摘要元素，不取
  let summary: string | undefined;
  if (isBeat) {
    const beatCommit = $entry.find('.beat-commit').first().text().trim();
    if (beatCommit) {
      summary = beatCommit.replace(/^[—\-–]\s*/, '').trim() || undefined;
    }
  }

  const images: ArticleImage[] = [];
  const paragraphs: string[] = [];
  const blocks: ContentBlock[] = [];

  // 确定内容容器：beat 页在 .beat-note，博客页在 [data-permalink-context]
  let $content: ReturnType<ReturnType<typeof cheerio.load>>;
  if (isBeat) {
    $content = $entry.find('.beat-note').first();
  } else {
    $content = $entry.find('[data-permalink-context]').first();
    if (!$content.length) $content = $entry;
  }

  // 收集已添加的图片 src 用于去重
  const addedImageSrcs = new Set<string>();

  /** 处理单个元素 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function processElement(el: any): void {
    const $el = $(el);
    const tag = (el.tagName || '').toLowerCase();

    // 跳过作为文章标题的 h2（已在外部提取）
    if (tag === 'h2') return;
    // 跳过日期行
    if (tag === 'p' && ($el.hasClass('mobile-date') || $el.hasClass('mobile-date-eyebrow'))) return;

    // 裸 <video>（不在 p/div 内），提取 poster 作为封面图
    if (tag === 'video') {
      const poster = $el.attr('poster');
      const ariaLabel = $el.attr('aria-label') || '';
      if (poster && !addedImageSrcs.has(poster)) {
        addedImageSrcs.add(poster);
        images.push({ src: poster, alt: ariaLabel });
        blocks.push({ type: 'image', image: { src: poster, alt: ariaLabel } });
      }
      return;
    }

    // highlight 代码块
    if ($el.hasClass('highlight') || $el.closest('.highlight').length) {
      if ($el.is('pre')) {
        const $highlightDiv = $el.closest('.highlight');
        const language = inferLanguage($highlightDiv.length ? $highlightDiv : $el);
        blocks.push({ type: 'code', code: $el.text(), language });
        return;
      }
      // highlight div 本身：提取内部 <pre> 内容，不递归处理子元素
      if (tag === 'div' && $el.hasClass('highlight')) {
        const $pre = $el.find('pre').first();
        if ($pre.length) {
          blocks.push({ type: 'code', code: $pre.text(), language: inferLanguage($el) });
        }
        return;
      }
    }

    // <pre><code> 代码块
    if (tag === 'pre') {
      const $code = $el.find('code').first();
      blocks.push({ type: 'code', code: $code.length ? $code.text() : $el.text() });
      return;
    }

    // <blockquote>
    if (tag === 'blockquote') {
      const quoteTexts: string[] = [];
      $el.children().each((_i, child) => {
        const $child = $(child);
        const childTag = (child as { tagName?: string }).tagName?.toLowerCase() || '';
        // blockquote 内可能是 <p>/<ul>/<ol> 等，取全部文本
        if (childTag === 'p') {
          const text = $child.text().trim();
          if (text && text.length > 2) quoteTexts.push(text);
        } else if (childTag === 'ul' || childTag === 'ol') {
          $child.find('li').each((_j, liEl) => {
            const text = $(liEl).text().trim();
            if (text && text.length > 5) quoteTexts.push(`• ${text}`);
          });
        }
      });
      if (quoteTexts.length > 0) {
        paragraphs.push(...quoteTexts);
        blocks.push({ type: 'quote', texts: quoteTexts });
      }
      return;
    }

    // 标题
    if (['h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
      const text = $el.text().trim();
      if (text && text.length > 2) {
        blocks.push({ type: 'heading', text });
      }
      return;
    }

    // 段落（含内嵌 <video>/<img> 的段落）
    if (tag === 'p') {
      // 段落内嵌图片
      const $img = $el.find('img').first();
      if ($img.length) {
        const src = $img.attr('src');
        const alt = $img.attr('alt') || '';
        if (src && !addedImageSrcs.has(src)) {
          addedImageSrcs.add(src);
          const img: ArticleImage = { src, alt };
          images.push(img);
          blocks.push({ type: 'image', image: img });
        }
        // 如果段落内只有图片没有文字，直接返回
        const textWithoutImg = $el.clone().find('img, video').remove().end().text().trim();
        if (!textWithoutImg) return;
      }
      // 段落内嵌视频
      const $video = $el.find('video').first();
      if ($video.length) {
        const poster = $video.attr('poster');
        const ariaLabel = $video.attr('aria-label') || '';
        if (poster && !addedImageSrcs.has(poster)) {
          addedImageSrcs.add(poster);
          const img: ArticleImage = { src: poster, alt: ariaLabel };
          images.push(img);
          blocks.push({ type: 'image', image: img });
        }
        // 提取视频前后的文字
        const $clone = $el.clone();
        $clone.find('video, img').remove();
        const text = $clone.text().trim();
        if (text && text.length > 10) {
          paragraphs.push(text);
          blocks.push({ type: 'text', texts: [text] });
        }
        return;
      }

      const text = $el.text().trim();
      if (text && text.length > 10) {
        paragraphs.push(text);
        blocks.push({ type: 'text', texts: [text] });
      }
      return;
    }

    // 列表
    if (tag === 'ul' || tag === 'ol') {
      const items: string[] = [];
      $el.find('li').each((_j, liEl) => {
        const text = $(liEl).text().trim();
        if (text && text.length > 5) items.push(text);
      });
      if (items.length > 0) {
        paragraphs.push(...items);
        blocks.push({ type: 'text', texts: items });
      }
      return;
    }

    // 图表
    if (tag === 'table') {
      const rows: string[] = [];
      $el.find('tr').each((_j, trEl) => {
        const cells: string[] = [];
        $(trEl).find('th, td').each((_k, cellEl) => {
          cells.push($(cellEl).text().trim());
        });
        if (cells.length > 0) rows.push(cells.join(' | '));
      });
      if (rows.length > 0) {
        const tableText = rows.join('\n');
        paragraphs.push(tableText);
        blocks.push({ type: 'text', texts: [tableText] });
      }
      return;
    }

    // div/figure/picture 包装器（含 img 或 video）
    if (tag === 'div' || tag === 'figure' || tag === 'picture') {
      // video poster 作为封面图
      const $video = $el.find('video').first();
      if ($video.length) {
        const poster = $video.attr('poster');
        const ariaLabel = $video.attr('aria-label') || '';
        if (poster && !addedImageSrcs.has(poster)) {
          addedImageSrcs.add(poster);
          images.push({ src: poster, alt: ariaLabel });
          blocks.push({ type: 'image', image: { src: poster, alt: ariaLabel } });
        }
        return;
      }
      // 图片
      const $img = $el.find('img').first();
      if ($img.length) {
        const src = $img.attr('src');
        const alt = $img.attr('alt') || '';
        if (src && !addedImageSrcs.has(src)) {
          addedImageSrcs.add(src);
          images.push({ src, alt });
          blocks.push({ type: 'image', image: { src, alt } });
        }
        return;
      }
    }

    // 独立 <img>（不在 p/div/figure 内）
    if (tag === 'img') {
      const src = $el.attr('src');
      const alt = $el.attr('alt') || '';
      if (src && !addedImageSrcs.has(src)) {
        addedImageSrcs.add(src);
        images.push({ src, alt });
        blocks.push({ type: 'image', image: { src, alt } });
      }
      return;
    }

    // 递归处理子元素（保持文档顺序）
    $el.children().each((_i, child) => {
      processElement(child);
    });
  }

  $content.children().each((_i, el) => {
    processElement(el);
  });

  // 如果内容中没找到图片，用 og:image 作为题图放在最前面
  if (images.length === 0) {
    const ogImage = $('meta[property="og:image"]').attr('content');
    if (ogImage) {
      images.push({ src: ogImage, alt: '' });
      blocks.unshift({ type: 'image', image: { src: ogImage, alt: '' } });
    }
  }

  // 正文为空时降级
  if (blocks.filter(b => b.type === 'text').length === 0) {
    const fallback = fallbackFromMeta($);
    images.push(...fallback.images);
    paragraphs.push(...fallback.paragraphs);
    blocks.push(...fallback.blocks);
  }

  return { title, author, date: dateStr, summary, images, paragraphs, blocks };
}


// ================ 注册表 ================

const SOURCE_EXTRACTORS: Record<string, SourceExtractor> = {
  'bbc-world': { extract: bbcExtract },
  'bbc-business': { extract: bbcExtract },
  'bbc': { extract: bbcExtract },
  'sciam': { extract: sciamExtract },
  'guardian-ai': { extract: guardianExtract },
  'guardian-china': { extract: guardianExtract },
  'mit-news': { extract: mitNewsExtract },
  'theregister-ai': { extract: registerExtract },
  'tds': { extract: tdsExtract },
  'simonw': { extract: simonwExtract },
};


// ================ 入口 ================

/**
 * 从原文 HTML 提取结构化内容
 */
async function extractArticle(html: string, sourceId?: string): Promise<ArticleData> {
  const $ = cheerio.load(html);

  // 移除通用噪音元素
  $(DEFAULT_REMOVE_SELECTORS.join(', ')).remove();

  const extractor = sourceId ? SOURCE_EXTRACTORS[sourceId] : undefined;
  const result = extractor ? extractor.extract($, html) : genericExtract($);
  if (result.summary) {
    result.summary = stripHtmlTags(result.summary);
  }
  return result;
}

/**
 * 翻译文章内容，保留结构化数据
 */
async function translateArticle(
  article: ArticleData,
  env: WorkerEnv,
  engine: string,
  llm?: LlmProviderConfig,
  maxInputTokens?: number,
  batchDelayMs?: number,
  fallbackProviders?: ResolvedProvider[],
): Promise<ArticleData> {
  const toTranslate: string[] = [];

  if (article.title) toTranslate.push(article.title);
  if (article.role) toTranslate.push(article.role);
  if (article.summary) toTranslate.push(article.summary);

  // 日期不经过 LLM 翻译，本地格式化避免时区/格式错误
  if (article.date) article.date = formatDateZh(article.date);

  for (const block of article.blocks) {
    if (block.type === 'image') {
      if (block.image.alt) toTranslate.push(block.image.alt);
    } else if (block.type === 'heading') {
      toTranslate.push(block.text);
    } else if (block.type === 'disclaimer') {
      toTranslate.push(block.text);
    } else if (block.type === 'references') {
      // 参考文献条目不翻译（含作者名、期刊名、DOI 等），仅翻译标题
      if (block.title) toTranslate.push(block.title);
    } else if (block.type === 'code') {
      // 代码块不翻译
    } else if (block.type === 'quote') {
      for (const t of block.texts) toTranslate.push(t);
    } else {
      for (const t of block.texts) toTranslate.push(t);
    }
  }

  if (toTranslate.length === 0) return article;

  let translated: string[];
  try {
    translated = await translateTexts({
      engine, texts: toTranslate, targetLang: 'ZH',
      sourceLang: 'EN', env, llm,
      maxInputTokens,
      batchDelayMs,
      fallbackProviders,
    });
  } catch { return article; }

  let idx = 0;

  if (article.title) article.title = translated[idx++] || article.title;
  if (article.role) article.role = translated[idx++] || article.role;
  if (article.summary) article.summary = translated[idx++] || article.summary;

  for (const block of article.blocks) {
    if (block.type === 'image') {
      if (block.image.alt) block.image.alt = translated[idx++] || block.image.alt;
    } else if (block.type === 'heading') {
      block.text = translated[idx++] || block.text;
    } else if (block.type === 'disclaimer') {
      block.text = translated[idx++] || block.text;
    } else if (block.type === 'references') {
      if (block.title) block.title = translated[idx++] || block.title;
    } else if (block.type === 'code') {
      // 代码块不翻译，不消耗 idx
    } else if (block.type === 'quote') {
      for (let i = 0; i < block.texts.length; i++) {
        block.texts[i] = translated[idx++] || block.texts[i];
      }
    } else {
      for (let i = 0; i < block.texts.length; i++) {
        block.texts[i] = translated[idx++] || block.texts[i];
      }
    }
  }

  article.paragraphs = article.blocks
    .filter(b => b.type === 'text')
    .flatMap(b => b.texts);
  article.images = article.blocks
    .filter(b => b.type === 'image')
    .map(b => b.image);

  return article;
}

/**
 * 渲染 BBC 风格文章页面
 */
function renderArticleHtml(article: ArticleData, originalUrl: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  let bylineHtml = '';
  if (article.author || article.role || article.date) {
    bylineHtml = '<div class="byline">';
    if (article.author) {
      if (article.authorUrl) {
        bylineHtml += `<a href="${esc(article.authorUrl)}" class="author" target="_blank" rel="noopener">${esc(article.author)}</a>`;
      } else {
        bylineHtml += `<span class="author">${esc(article.author)}</span>`;
      }
    }
    if (article.role) bylineHtml += `<span class="role">${esc(article.role)}</span>`;
    if (article.date) bylineHtml += `<time class="date">${esc(article.date)}</time>`;
    bylineHtml += '</div>';
  }

  let summaryHtml = '';
  if (article.summary) {
    summaryHtml = `<div class="summary">${esc(article.summary)}</div>`;
  }

  let bodyHtml = '';
  for (const block of article.blocks) {
    if (block.type === 'image') {
      const img = block.image;
      bodyHtml += `<figure class="article-image">
        <img src="${esc(img.src)}" alt="${esc(img.alt)}" loading="lazy">
        ${img.alt ? `<figcaption>${esc(img.alt)}</figcaption>` : ''}
        ${img.copyright ? `<span class="copyright">${esc(img.copyright)}</span>` : ''}
      </figure>`;
    } else if (block.type === 'heading') {
      bodyHtml += `<h2 class="subheading">${esc(block.text)}</h2>`;
    } else if (block.type === 'disclaimer') {
      bodyHtml += `<aside class="disclaimer"><p>${esc(block.text)}</p></aside>`;
    } else if (block.type === 'references') {
      const items = block.items.map(it => `<p class="reference-item">${it}</p>`).join('\n');
      bodyHtml += `<section class="references"><h2 class="references-title">${esc(block.title)}</h2>${items}</section>`;
    } else if (block.type === 'code') {
      const langClass = block.language ? ` class="language-${esc(block.language)}"` : '';
      bodyHtml += `<pre class="code-block"><code${langClass}>${esc(block.code)}</code></pre>`;
    } else if (block.type === 'quote') {
      bodyHtml += `<blockquote class="article-quote">${block.texts.map(t => `<p>${esc(t)}</p>`).join('\n')}</blockquote>`;
    } else {
      bodyHtml += block.texts.map(p => `<p>${esc(p)}</p>`).join('\n');
    }
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(article.title)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "BBC Reith Sans", Helvetica, Arial, sans-serif; color: #141414; background: #fff; line-height: 1.6; }
  article { max-width: 700px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 28px; font-weight: 700; line-height: 1.25; color: #141414; margin-bottom: 16px; }
  .byline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #e6e6e6; font-size: 14px; color: #545658; }
  .author { font-weight: 700; color: #141414; }
  a.author { text-decoration: none; }
  a.author:hover { text-decoration: underline; }
  .role { color: #545658; }
  .date { color: #8a8c8e; }
  .date::before { content: "·"; margin: 0 8px; }
  .summary { font-size: 18px; font-weight: 500; color: #242424; line-height: 1.6; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #e6e6e6; }
  .article-image { margin: 24px 0; }
  .article-image img { width: 100%; height: auto; display: block; }
  .article-image figcaption { font-size: 13px; color: #545658; padding: 8px 0 0; line-height: 1.4; }
  .article-image .copyright { font-size: 11px; color: #8a8c8e; }
  p { font-size: 18px; line-height: 1.7; margin-bottom: 18px; color: #141414; }
  .subheading { font-size: 20px; font-weight: 700; line-height: 1.3; margin: 32px 0 12px; color: #141414; }
  .disclaimer { font-size: 13px; font-style: italic; color: #8a8c8e; line-height: 1.6; margin: 28px 0 16px; padding: 14px 16px; background: #f7f7f7; border-radius: 6px; }
  .disclaimer p { font-size: inherit; color: inherit; margin: 0; }
  .code-block { margin: 20px 0; padding: 16px; background: #1e1e1e; border-radius: 8px; overflow-x: auto; font-size: 13px; line-height: 1.55; }
  .code-block code { font-family: "SF Mono", Menlo, Monaco, "Cascadia Code", Consolas, monospace; color: #d4d4d4; white-space: pre; word-wrap: normal; }
  .article-quote { border-left: 4px solid #ccc; padding: 4px 0 4px 18px; margin: 20px 0; color: #545658; }
  .article-quote p { font-size: 16px; line-height: 1.65; margin-bottom: 10px; color: inherit; }
  .article-quote p:last-child { margin-bottom: 0; }
  .references { margin: 32px 0 16px; padding: 18px 20px; background: #f7f7f7; border-radius: 6px; }
  .references-title { font-size: 18px; font-weight: 700; margin: 0 0 12px; color: #141414; }
  .reference-item { font-size: 13px; line-height: 1.6; color: #545658; margin: 0 0 8px; word-break: break-word; }
  .reference-item:last-child { margin-bottom: 0; }
  .reference-item a { color: #5A7690; text-decoration: none; word-break: break-all; }
  .reference-item a:hover { text-decoration: underline; }
  .original-link { margin-top: 32px; padding-top: 16px; border-top: 1px solid #e6e6e6; font-size: 14px; }
  .original-link a { color: #545658; text-decoration: none; }
  .original-link a:hover { text-decoration: underline; }
  @media (max-width: 600px) {
    h1 { font-size: 24px; }
    p { font-size: 16px; }
    article { padding: 16px 12px 32px; }
  }
</style>
</head>
<body>
<article>
  <h1>${esc(article.title)}</h1>
  ${bylineHtml}
  ${summaryHtml}
  ${bodyHtml}
  <div class="original-link"><a href="${esc(originalUrl)}" target="_blank" rel="noopener">查看原文</a></div>
</article>
</body>
</html>`;
}

/**
 * 获取原文并翻译为格式化页面
 */
export async function fetchAndTranslatePage(
  url: string,
  env: WorkerEnv,
  sourceId?: string,
  engine?: string,
  llm?: LlmProviderConfig,
  maxInputTokens?: number,
  batchDelayMs?: number,
  fallbackProviders?: ResolvedProvider[],
): Promise<string> {
  const logger = createLogger(env);

  logger.info(`Fetching article: ${url}`);
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.199 Safari/537.36' },
  });
  if (!resp.ok) throw new Error(`Failed to fetch article: ${resp.status}`);

  const html = await resp.text();
  const article = await extractArticle(html, sourceId);
  logger.info(`Extracted: title="${article.title.slice(0, 60)}", imgs=${article.images.length}, paras=${article.paragraphs.length}`);

  const translated = await translateArticle(article, env, engine ?? 'deeplx', llm, maxInputTokens, batchDelayMs, fallbackProviders);

  return renderArticleHtml(translated, url);
}

/**
 * 从 URL 获取纯文本（给 RSS 端点用）
 */
export async function fetchAndExtractContent(
  url: string,
  env: WorkerEnv,
  sourceId?: string,
): Promise<{ title: string; content: string }> {
  const logger = createLogger(env);
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.199 Safari/537.36' },
  });
  if (!resp.ok) throw new Error(`Failed to fetch article: ${resp.status}`);

  const html = await resp.text();
  const article = await extractArticle(html, sourceId);
  // 合并所有可读文本（段落、引文、代码块），代码块用 [代码] 标记包裹
  const parts: string[] = [];
  for (const block of article.blocks) {
    if (block.type === 'text') parts.push(...block.texts);
    else if (block.type === 'quote') parts.push(...block.texts);
    else if (block.type === 'code') parts.push(`[代码]\n${block.code}\n[/代码]`);
  }
  const content = parts.length > 0 ? parts.join('\n\n') : article.paragraphs.join('\n\n');

  logger.info(`Extracted for RSS: title="${article.title.slice(0, 60)}", body=${content.length} chars`);
  return { title: article.title, content };
}

export { cheerio, extractArticle };