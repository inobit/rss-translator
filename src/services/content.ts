import * as cheerio from 'cheerio';
import { createLogger } from '../utils/logger';
import type { WorkerEnv } from '../types';
import { translateTexts, type LlmProviderConfig } from './translate';

export interface ArticleImage {
  src: string;
  alt: string;
  copyright?: string;
}

export type ContentBlock =
  | { type: 'text'; texts: string[] }
  | { type: 'image'; image: ArticleImage };

export interface ArticleData {
  title: string;
  author?: string;
  role?: string;
  date?: string;
  images: ArticleImage[];
  paragraphs: string[];
  /** 按原文顺序排列的内容块（图文穿插） */
  blocks: ContentBlock[];
}

/** 每个 source 的解析规则 */
const SOURCE_RULES: Record<string, {
  contentSelector?: string;
  removeSelector?: string;
}> = {
  'bbc-world': {
    contentSelector: '[data-testid="metadata"], [data-block="text"]',
  },
};

/** 默认移除元素 */
const DEFAULT_REMOVE_SELECTORS = [
  'script', 'style', 'noscript',
  'nav', 'footer', 'aside',
  '.social-share', '.advertisement',
  '[role="navigation"]', '[role="banner"]',
  '[data-testid="topic-list"]',
  '[data-component="topic-list"]',
  '[data-block="promoList"]',
  '[class*="-TopicList"]', '[class*="-RelatedContent"]',
  '[class*="-MoreOnThis"]', '[class*="-PromoSwitch"]',
  'section[class*="comments"]',
];

/**
 * 从原文 HTML 提取结构化内容（给 /raw 端点用）
 */
async function extractArticle(html: string, sourceId?: string): Promise<ArticleData> {
  const $ = cheerio.load(html);
  const rules = sourceId ? SOURCE_RULES[sourceId] : undefined;
  const removeSel = rules?.removeSelector || DEFAULT_REMOVE_SELECTORS.join(', ');

  $(removeSel).remove();

  // 标题
  const title = $('h1[data-testid="headline"], [data-testid="headline"] h1, #main-heading')
    .first().text().trim() || $('title').first().text().trim() || 'Untitled';

  // 作者和角色
  let author: string | undefined;
  let role: string | undefined;
  const byline = $('[data-testid="single-byline"], [data-testid="byline"]').first();
  if (byline.length) {
    author = byline.find('.ssrcss-nsjd43-TextContributorName, [class*="ContributorName"]')
      .first().text().trim() || undefined;
    role = byline.find('.ssrcss-dqo7s5-ContributorDetails, [class*="ContributorDetails"]')
      .first().text().trim() || undefined;
  }

  // 日期
  let date: string | undefined;
  const meta = $('[data-testid="metadata"]').first();
  if (meta.length) {
    date = meta.find('time, [class*="MetadataStrip"] li, [class*="Timestamp"]')
      .first().text().trim() || undefined;
    if (!date) date = meta.find('li, span').first().text().trim() || undefined;
  }

  // 图片和正文按原文顺序穿插
  const images: ArticleImage[] = [];
  const paragraphs: string[] = [];
  const blocks: ContentBlock[] = [];

  const $article = $('article').first();
  // 按 data-block 顺序遍历 content 块
  if ($article.length) {
    $article.find('[data-block]').each((_i, el) => {
      const $el = $(el);
      const blockType = $el.attr('data-block');

      if (blockType === 'text') {
        const blockParas: string[] = [];
        $el.find('p').each((_j, pEl) => {
          const text = $(pEl).text().trim();
          if (text && text.length > 10) {
            paragraphs.push(text);
            blockParas.push(text);
          }
        });
        if (blockParas.length > 0) {
          blocks.push({ type: 'text', texts: blockParas });
        }
      } else if (blockType === 'image' || blockType === 'video') {
        const $img = $el.find('img').first();
        if ($img.length) {
          const src = $img.attr('src');
          const alt = $img.attr('alt') || '';
          if (src) {
            const copyright = $el.find('[class*="Copyright"], [class*="copyright"]')
              .first().text().trim() || undefined;
            const image: ArticleImage = { src, alt, copyright };
            images.push(image);
            blocks.push({ type: 'image', image });
          }
        }
      }
    });
  }

  // 降级：如果没有 data-block 结构，尝试从 JSON-LD / meta 提取视频页内容
  if (blocks.length === 0) {
    const jsonLd = extractJsonLd($);
    if (jsonLd?.['@type'] === 'VideoObject') {
      // 视频页：从 JSON-LD 取缩略图和描述
      const ldThumb = jsonLd.thumbnailUrl;
      const ldName = jsonLd.name as string | undefined;
      const ldDesc = jsonLd.description as string | undefined;
      const ldDate = jsonLd.uploadDate as string | undefined;

      if (ldThumb) {
        const thumbUrl = Array.isArray(ldThumb)
          ? (ldThumb[0] as string)
          : (ldThumb as string);
        const img: ArticleImage = { src: thumbUrl, alt: ldName || '' };
        images.push(img);
        blocks.push({ type: 'image', image: img });
      }
      if (ldDesc) {
        paragraphs.push(ldDesc);
        blocks.push({ type: 'text', texts: [ldDesc] });
      }
      if (ldDate) {
        date = date || ldDate;
      }
    } else {
      // 通用降级：用 og:image + meta description
      const ogImage = $('meta[property="og:image"]').attr('content');
      const ogAlt = $('meta[property="og:image:alt"]').attr('content') || '';
      const metaDesc = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';

      if (ogImage) {
        images.push({ src: ogImage, alt: ogAlt });
        blocks.push({ type: 'image', image: { src: ogImage, alt: ogAlt } });
      }
      if (metaDesc) {
        paragraphs.push(metaDesc);
        blocks.push({ type: 'text', texts: [metaDesc] });
      }
    }

    // 仍尝试从 DOM 提取图片
    if (images.length === 0) {
      $('picture img').each((_i, el) => {
        const src = $(el).attr('src');
        const alt = $(el).attr('alt') || '';
        if (src && images.length < 10) {
          const img: ArticleImage = { src, alt };
          images.push(img);
          blocks.push({ type: 'image', image: img });
        }
      });
    }
  }

  // 如果还是没有任何段落，用全文降级
  if (paragraphs.length === 0) {
    let $container: ReturnType<typeof $> = $();
    if (rules?.contentSelector) $container = $(rules.contentSelector);
    if (!$container.length) $container = $('article, [role="main"], main');
    if ($container.length) {
      const fullText = $container.text().trim();
      const parts = fullText.split(/\n{2,}/).filter(p => p.length > 10);
      paragraphs.push(...parts);
      if (parts.length > 0) blocks.push({ type: 'text', texts: parts });
    }
  }

  return { title, author, role, date, images, paragraphs, blocks };
}

/** 从页面提取 JSON-LD 结构化数据 */
function extractJsonLd($: ReturnType<typeof cheerio.load>): Record<string, unknown> | null {
  try {
    const script = $('script[type="application/ld+json"]').first().html();
    if (!script) return null;
    const parsed: unknown = JSON.parse(script);
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 翻译文章内容，保留结构化数据
 */
async function translateArticle(
  article: ArticleData,
  env: WorkerEnv,
  engine: string,
  llm?: LlmProviderConfig,
): Promise<ArticleData> {
  const toTranslate: string[] = [];

  if (article.title) toTranslate.push(article.title);
  if (article.role) toTranslate.push(article.role);
  if (article.date) toTranslate.push(article.date);

  // 按 blocks 顺序收集所有文本
  for (const block of article.blocks) {
    if (block.type === 'image') {
      if (block.image.alt) toTranslate.push(block.image.alt);
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
    });
  } catch { return article; }

  let idx = 0;

  if (article.title) article.title = translated[idx++] || article.title;
  if (article.role) article.role = translated[idx++] || article.role;
  if (article.date) article.date = translated[idx++] || article.date;

  for (const block of article.blocks) {
    if (block.type === 'image') {
      if (block.image.alt) block.image.alt = translated[idx++] || block.image.alt;
    } else {
      for (let i = 0; i < block.texts.length; i++) {
        block.texts[i] = translated[idx++] || block.texts[i];
      }
    }
  }

  // 同步到旧的 flat 数组以保持兼容
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
    if (article.author) bylineHtml += `<span class="author">${esc(article.author)}</span>`;
    if (article.role) bylineHtml += `<span class="role">${esc(article.role)}</span>`;
    if (article.date) bylineHtml += `<time class="date">${esc(article.date)}</time>`;
    bylineHtml += '</div>';
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
    } else {
      bodyHtml += block.texts.map(p => `<p>${esc(p)}</p>`).join('\n');
    }
  }

  // 零散图片（不在 blocks 里的）
  for (const img of article.images) {
    if (bodyHtml.includes(esc(img.src))) continue;
    bodyHtml += `<figure class="article-image">
      <img src="${esc(img.src)}" alt="${esc(img.alt)}" loading="lazy">
      ${img.alt ? `<figcaption>${esc(img.alt)}</figcaption>` : ''}
    </figure>`;
  }
  // 零散段落（不在 blocks 里的）
  for (const p of article.paragraphs) {
    if (bodyHtml.includes(esc(p.slice(0, 40)))) continue;
    bodyHtml += `<p>${esc(p)}</p>`;
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
  .role { color: #545658; }
  .date { color: #8a8c8e; }
  .date::before { content: "·"; margin: 0 8px; }
  .article-image { margin: 24px 0; }
  .article-image img { width: 100%; height: auto; display: block; }
  .article-image figcaption { font-size: 13px; color: #545658; padding: 8px 0 0; line-height: 1.4; }
  .article-image .copyright { font-size: 11px; color: #8a8c8e; }
  p { font-size: 18px; line-height: 1.7; margin-bottom: 18px; color: #141414; }
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
): Promise<string> {
  const logger = createLogger(env);

  logger.info(`Fetching article: ${url}`);
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSS-Translator/1.0)' },
  });
  if (!resp.ok) throw new Error(`Failed to fetch article: ${resp.status}`);

  const html = await resp.text();
  const article = await extractArticle(html, sourceId);
  logger.info(`Extracted: title="${article.title.slice(0, 60)}", imgs=${article.images.length}, paras=${article.paragraphs.length}`);

  const translated = await translateArticle(article, env, engine ?? 'llm', llm);

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
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSS-Translator/1.0)' },
  });
  if (!resp.ok) throw new Error(`Failed to fetch article: ${resp.status}`);

  const html = await resp.text();
  const article = await extractArticle(html, sourceId);
  const content = article.paragraphs.join('\n\n');

  logger.info(`Extracted for RSS: title="${article.title.slice(0, 60)}", body=${content.length} chars`);
  return { title: article.title, content };
}

export { cheerio, extractArticle };
