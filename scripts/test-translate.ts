/**
 * 本地翻译管道测试脚本
 *
 * 用法：
 *   pnpm run test:translate <URL> [source-id]
 *
 * 示例：
 *   pnpm run test:translate "https://www.bbc.co.uk/news/videos/cjrggj051pvo" bbc-world
 *
 * 模拟完整翻译流水线：抓取原文 → 提取正文（含链接占位符）→ 翻译 → 渲染 HTML
 * 不读 KV、不写缓存，纯本地验证。
 */

import * as cheerio from "cheerio";
import { load } from "js-yaml";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

// ====== 复用自 test-provider.ts 的翻译逻辑（已适配链接文本批次） ======

const TRANSLATE_TIMEOUT_MS = 180_000;

interface TranslateProvider {
  type?: "deeplx" | "cloudflare" | "llm";
  endpoint: string;
  model?: string;
  max_input_tokens?: number;
  api_key_name?: string;
}

interface LlmProviderConfig {
  endpoint: string;
  model: string;
  apiKey: string;
  maxInputTokens?: number;
}

interface CloudflareProviderConfig {
  endpoint: string;
  model: string;
  apiKey: string;
}

type ResolvedProvider =
  | { name: string; type: "llm"; config: LlmProviderConfig }
  | { name: string; type: "deeplx"; config: { endpoint: string; apiKey: string } }
  | { name: string; type: "cloudflare"; config: CloudflareProviderConfig }
  | { name: string; type: "mock"; config: Record<string, never> };

function getSourceEngines(
  source: { engines?: string[]; engine?: string },
  defaults?: { engines?: string[]; engine?: string },
): string[] {
  if (source.engines && source.engines.length > 0) return source.engines;
  if (source.engine) return [source.engine];
  if (defaults?.engines && defaults.engines.length > 0) return defaults.engines;
  if (defaults?.engine) return [defaults.engine];
  return ["deeplx"];
}

function resolveProvider(
  engine: string,
  env: Record<string, string | undefined>,
  providers?: Record<string, TranslateProvider>,
): ResolvedProvider | null {
  if (engine === "mock") return { name: "mock", type: "mock", config: {} };

  const provider = providers?.[engine];
  if (provider) {
    const secretName = provider.api_key_name ?? `${engine.replace(/-/g, "_").toUpperCase()}_API_KEY`;
    const apiKey = env[secretName];
    if (!apiKey) return null;

    if (provider.type === "deeplx") {
      return { name: engine, type: "deeplx", config: { endpoint: provider.endpoint, apiKey } };
    }
    if (provider.type === "cloudflare") {
      return { name: engine, type: "cloudflare", config: { endpoint: provider.endpoint, model: provider.model ?? "@cf/meta/m2m100-1.2b", apiKey } };
    }
    return { name: engine, type: "llm", config: { endpoint: provider.endpoint, model: provider.model ?? "default", apiKey, maxInputTokens: provider.max_input_tokens } };
  }
  return null;
}

async function translateViaLlm(texts: string[], provider?: LlmProviderConfig): Promise<string[]> {
  if (!provider?.endpoint || !provider?.apiKey) throw new Error("LLM provider is not configured");

  const isSingle = texts.length === 1;
  const LLM_PROMPT = `将以下英文新闻内容翻译为中文。要求：
- 使用新闻体的专业中文
- 精确传达原意
- 只返回纯文本，不要添加任何 HTML 标签或 Markdown 格式
- 保留 [↗数字] 格式的链接编号标记不变

原文：`;

  const userContent = isSingle
    ? `${LLM_PROMPT}\n\n${texts[0]}`
    : `${texts.map((t, i) => `[${i + 1}] ${t}`).join("\n\n")}\n\n请将以上各段分别翻译为中文，保持编号格式 [1] [2] ... 返回。`;

  const requestBody: Record<string, unknown> = {
    messages: [
      { role: "system", content: LLM_PROMPT },
      { role: "user", content: userContent },
    ],
    temperature: 0.3,
    max_tokens: 32768,
  };
  if (provider.model) requestBody.model = provider.model;

  const resp = await fetch(provider.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
  });

  if (!resp.ok) throw new Error(`LLM translation failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  const data = (await resp.json()) as any;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error(`Unexpected LLM response: ${JSON.stringify(data).slice(0, 200)}`);

  if (isSingle) return [content.trim()];

  // 解析编号结果
  const results: string[] = new Array(texts.length).fill("");
  let currentIdx = -1;
  let currentText: string[] = [];
  for (const line of content.split("\n")) {
    const match = /^\s*\[(\d+)\]\s*(.*)$/.exec(line);
    if (match) {
      if (currentIdx >= 0) results[currentIdx] = currentText.join("\n").trim();
      currentIdx = parseInt(match[1], 10) - 1;
      currentText = [match[2]];
    } else if (currentIdx >= 0) {
      currentText.push(line);
    }
  }
  if (currentIdx >= 0) results[currentIdx] = currentText.join("\n").trim();
  return results.map((r, i) => r || texts[i]);
}

async function translateTexts(
  texts: string[],
  provider: ResolvedProvider,
): Promise<string[]> {
  const pendingTexts = texts.filter((t) => t);
  if (pendingTexts.length === 0) return texts.map(() => "");
  if (provider.type === "mock") {
    console.log(`[INFO] Mock translate ${pendingTexts.length} texts (identity pass-through)`);
    return texts;
  }
  console.log(`[INFO] Translating ${pendingTexts.length} texts via ${provider.name} (${provider.type})`);
  let results: string[];
  if (provider.type === "llm") {
    results = await translateViaLlm(pendingTexts, provider.config);
  } else if (provider.type === "deeplx") {
    results = await translateViaDeeplx(pendingTexts, "ZH", "EN", provider.config);
  } else {
    results = await translateViaCloudflare(pendingTexts, "ZH", "EN", provider.config);
  }
  const final = mapResults(texts, results);
  console.log(`[INFO] Translation done`);
  return final;
}

async function translateViaDeeplx(texts: string[], targetLang: string, sourceLang: string, config: { endpoint: string; apiKey: string }): Promise<string[]> {
  const results: string[] = [];
  for (const text of texts) {
    const resp = await fetch(`${config.endpoint}/${config.apiKey}/translate`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, target_lang: targetLang, source_lang: sourceLang }),
      signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`DeepLX failed: ${resp.status}`);
    const data = (await resp.json()) as any;
    results.push(data.translations?.[0]?.text ?? data.data ?? text);
  }
  return results;
}

const CLOUDFLARE_LANG_MAP: Record<string, string> = { ZH: "chinese", EN: "english", JA: "japanese", KO: "korean" };

async function translateViaCloudflare(texts: string[], targetLang: string, sourceLang: string, config: CloudflareProviderConfig): Promise<string[]> {
  const results: string[] = [];
  for (const text of texts) {
    const resp = await fetch(`${config.endpoint}/${config.model}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ text, source_lang: CLOUDFLARE_LANG_MAP[sourceLang] ?? sourceLang.toLowerCase(), target_lang: CLOUDFLARE_LANG_MAP[targetLang] ?? targetLang.toLowerCase() }),
      signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error(`Cloudflare AI failed: ${resp.status}`);
    const data = (await resp.json()) as any;
    results.push(data.success && data.result?.translated_text ? data.result.translated_text : text);
  }
  return results;
}

function mapResults(texts: string[], translated: string[]): string[] {
  const results: string[] = [];
  let idx = 0;
  for (const t of texts) { results.push(t ? (translated[idx++] ?? t) : ""); }
  return results;
}

// ====== 内容提取类型 ======

interface ArticleLinkMeta {
  n: number;
  url: string;
  text: string;
}

interface ArticleImage {
  src: string;
  alt: string;
}

interface ContentBlock {
  type: "text" | "heading" | "image" | "disclaimer" | "references" | "code" | "quote";
  texts?: string[];
  text?: string;
  image?: ArticleImage;
  title?: string;
  items?: string[];
  code?: string;
  language?: string;
}

interface ArticleData {
  title: string;
  author?: string;
  date?: string;
  summary?: string;
  images: ArticleImage[];
  paragraphs: string[];
  blocks: ContentBlock[];
  links?: ArticleLinkMeta[];
}

// ====== 内容提取（html 链接占位符收集） ======

function extractHtmlText(
  $el: cheerio.Cheerio<any>,
  $: cheerio.CheerioAPI,
  linksCollector?: ArticleLinkMeta[],
): string {
  const html = $el.html();
  if (!html) return "";

  const baseUrl = $("meta[property=\"og:url\"]").attr("content")
    || $('link[rel="canonical"]').attr("href")
    || "";

  const withMarkers = html.replace(
    /<a\b[^>]*?\bhref\s*=\s*["']([^"']*)["'][^>]*>(.*?)<\/a>/gi,
    (_m, href, content) => {
      let resolved = href;
      try { resolved = new URL(href, baseUrl || "http://localhost/").href; } catch { /* keep */ }
      const text = content.replace(/<[^>]*>/g, "").trim();
      if (!text) return "";
      if (linksCollector) {
        const n = linksCollector.length + 1;
        linksCollector.push({ n, url: resolved, text });
        return `[↗${n}]`;
      }
      return text;
    },
  );

  return withMarkers.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function extractDataBlocks($: cheerio.CheerioAPI, linksCollector: ArticleLinkMeta[]): ArticleData {
  const lc = linksCollector;
  const images: ArticleImage[] = [];
  const paragraphs: string[] = [];
  const blocks: ContentBlock[] = [];

  const $article = $("article").first();
  $article.find("[data-block]").each((_i, el) => {
    const $el = $(el);
    const blockType = $el.attr("data-block") || "";

    if (blockType.includes("text") || blockType.endsWith("/paragraph")) {
      const $pTags = $el.is("p") ? $el : $el.find("p");
      const blockParas: string[] = [];
      $pTags.each((_j, pEl) => {
        const text = extractHtmlText($(pEl), $, lc);
        if (text && (text.length > 10 || text.includes("[↗"))) { paragraphs.push(text); blockParas.push(text); }
      });
      $el.find("h2, h3, h4").each((_j, hEl) => {
        const text = extractHtmlText($(hEl), $, lc);
        if (text && text.length > 2) blocks.push({ type: "heading", text });
      });
      if (blockParas.length > 0) blocks.push({ type: "text", texts: blockParas });
    } else if (blockType.includes("heading") || blockType === "subheadline") {
      const text = extractHtmlText($el, $, lc);
      if (text && text.length > 2) blocks.push({ type: "heading", text });
    } else if (blockType.includes("image") || blockType === "video") {
      const $img = $el.find("img").first();
      if ($img.length) {
        const img: ArticleImage = { src: $img.attr("src") || "", alt: $img.attr("alt") || "" };
        images.push(img);
        blocks.push({ type: "image", image: img });
      }
    } else if (blockType === "links" || blockType === "topicList" || blockType === "promoList") {
      return false;
    }
    return;
  });

  return { title: "", images, paragraphs, blocks };
}

function extractInDomOrder($: cheerio.CheerioAPI, linksCollector: ArticleLinkMeta[]): ArticleData {
  const images: ArticleImage[] = [];
  const paragraphs: string[] = [];
  const blocks: ContentBlock[] = [];

  const $container = $("article").first().length ? $("article").first() : $('main, [role="main"]').first();
  if (!$container.length) return { title: "", images, paragraphs, blocks };

  const elements: Array<{ type: "text"; text: string } | { type: "image"; img: ArticleImage }> = [];

  $container.find("p, img, picture, figure, video").each((_i, el) => {
    const tagName = (el as any).tagName?.toLowerCase() || "";
    if (["img", "picture", "figure", "video"].includes(tagName)) {
      const $img = $(el).find("img").first();
      if ($img.length) {
        const img: ArticleImage = { src: $img.attr("src") || "", alt: $img.attr("alt") || "" };
        if (!images.some((e) => e.src === img.src)) { images.push(img); elements.push({ type: "image", img }); }
      }
      return;
    }
    if (tagName === "p") {
      const text = extractHtmlText($(el), $, linksCollector);
      if (text && (text.length > 10 || /\[↗\d+\]/.test(text))) { paragraphs.push(text); elements.push({ type: "text", text }); }
    }
  });

  let i = 0;
  while (i < elements.length) {
    const el = elements[i];
    if (el.type === "image") { blocks.push({ type: "image", image: el.img }); i++; }
    else {
      const textGroup: string[] = [el.text];
      i++;
      while (i < elements.length && elements[i].type === "text") { textGroup.push((elements[i] as { type: "text"; text: string }).text); i++; }
      blocks.push({ type: "text", texts: textGroup });
    }
  }

  return { title: "", images, paragraphs, blocks };
}

function bbcExtract($: cheerio.CheerioAPI): ArticleData {
  $('[data-testid="topic-list"], [data-component="topic-list"], [data-block="promoList"]').remove();
  const title = $('h1[data-testid="headline"], [data-testid="headline"] h1, #main-heading').first().text().trim() || $("h1").first().text().trim();
  let author: string | undefined;
  let date: string | undefined;
  const byline = $('[data-testid="single-byline"], [data-testid="byline"]').first();
  if (byline.length) {
    author = byline.find('.ssrcss-nsjd43-TextContributorName, [class*="ContributorName"]').first().text().trim() || undefined;
  }
  const meta = $('[data-testid="metadata"]').first();
  if (meta.length) {
    const $time = meta.find("time").first();
    date = $time.attr("datetime") || $time.text().trim() || undefined;
  }
  const linksCollector: ArticleLinkMeta[] = [];
  const data = extractDataBlocks($, linksCollector);
  if (data.blocks.length === 0) {
    const domData = extractInDomOrder($, linksCollector);
    data.paragraphs.push(...domData.paragraphs);
    data.images.push(...domData.images);
    data.blocks.push(...domData.blocks);
  }
  if (data.images.length === 0) {
    const ogImg = $('meta[property="og:image"]').attr("content");
    if (ogImg) {
      const alt = $('h1').first().text().trim() || "";
      data.images.push({ src: ogImg, alt });
      data.blocks.unshift({ type: "image", image: { src: ogImg, alt } });
    }
  }
  return { title, author, date, images: data.images, paragraphs: data.paragraphs, blocks: data.blocks, links: linksCollector.length > 0 ? linksCollector : undefined };
}

/** 新华网（news.cn）提取器 */
function newsCnExtract($: cheerio.CheerioAPI): ArticleData {
  $(".fix-ewm, .topAd, .adv, ins[data-ycad-slot], .main-right, .relatedNews, .nextpage, .bookList, .foot").remove();

  const title = $("#wxtitle").text().trim()
    || $(".header.domPC h1 .title").first().text().trim()
    || $(".mheader.domMobile h1 .title").first().text().trim()
    || $("h1").first().text().trim();

  // 日期：优先结构化的 meta + PC 端时间，降级到移动端
  let date: string | undefined;
  const metaDate = $("meta[name=\"publishdate\"]").attr("content");
  const timeText = $(".header-time .time").first().text().trim();
  if (metaDate) date = metaDate + (timeText ? ` ${timeText}` : "");
  if (!date) {
    const year = $(".header-time .year em").first().text().trim();
    const month = $(".header-time .day em").first().text().trim();
    const day = $(".header-time .day em").eq(1).text().trim();
    if (year && month && day) {
      date = `${year}/${month}/${day}${timeText ? " " + timeText : ""}`;
    }
  }
  if (!date) {
    const mobileInfo = $(".mheader.domMobile .info").first().text().trim();
    if (mobileInfo) {
      const dateMatch = /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/.exec(mobileInfo);
      if (dateMatch) date = dateMatch[1];
    }
  }

  // 作者/来源：格式为 "来源 责任编辑: 编辑名"
  const metaAuthor = $("meta[name=\"author\"]").attr("content");
  const metaSource = $("meta[name=\"source\"]").attr("content");
  const editorText = $("#articleEdit .editor").first().text().trim();
  let editorName: string | undefined;
  if (editorText) {
    const name = editorText.replace(/^【?责任编辑[：:]\s*/, "").replace(/\s*】?$/, "").trim();
    if (name) editorName = name;
  }
  const source = metaAuthor?.trim() || metaSource?.trim();
  let author: string | undefined;
  if (source && editorName) {
    author = `${source} 责任编辑: ${editorName}`;
  } else if (editorName) {
    author = `责任编辑: ${editorName}`;
  } else if (source) {
    author = source;
  }

  const contentId = $("meta[name=\"contentid\"]").attr("content");
  let baseUrl: string | undefined;
  if (contentId) {
    const datePart = contentId.slice(0, 8);
    const idPart = contentId.slice(8);
    baseUrl = `http://www.news.cn/${datePart}/${idPart}/`;
  }

  const isCaptionText = ($el: cheerio.Cheerio<any>, text: string): boolean => {
    if (text.length > 120) return false;
    const $span = $el.find("span").first();
    if ($span.length) {
      const style = $span.attr("style") || "";
      if (style.includes("楷体") || style.includes("KaiTi")) return true;
    }
    return false;
  };

  const images: ArticleImage[] = [];
  const paragraphs: string[] = [];
  const blocks: ContentBlock[] = [];
  const linksCollector: ArticleLinkMeta[] = [];

  const $content = $("#detailContent");
  if ($content.length) {
    const children = $content.children().toArray();

    for (let i = 0; i < children.length; i++) {
      const el = children[i];
      const $el = $(el);
      const tagName = el.type === "tag" ? (el as any).name?.toLowerCase() : "";
      if (tagName !== "p") continue;

      const $video = $el.find("span.pageVideo").first();
      if ($video.length) {
        const poster = $video.attr("poster");
        if (poster) {
          images.push({ src: poster, alt: "" });
          blocks.push({ type: "image", image: { src: poster, alt: "" } });
        }
        continue;
      }

      const $img = $el.find("img").first();
      if ($img.length) {
        let src = $img.attr("src") || "";
        if (src.startsWith("//")) src = "https:" + src;
        else if (!src.startsWith("http") && baseUrl) {
          try { src = new URL(src, baseUrl).href; } catch { /* keep */ }
        }

        let alt = "";
        const nextEl = children[i + 1];
        if (nextEl) {
          const $next = $(nextEl);
          const nextText = $next.text().trim();
          if (nextText && isCaptionText($next, nextText)) {
            alt = nextText;
            i++;
          }
        }

        images.push({ src, alt });
        blocks.push({ type: "image", image: { src, alt } });
        continue;
      }

      let text = extractHtmlText($el, $, linksCollector);
      if (!text) continue;
      text = text.replace(/^[\u3000\s]+/g, "");
      if (!text) continue;

      paragraphs.push(text);
      blocks.push({ type: "text", texts: [text] });
    }
  }

  if (blocks.filter(b => b.type === "text").length === 0) {
    const ogImg = $('meta[property="og:image"]').attr("content");
    const metaDesc = $('meta[name="description"]').attr("content") || "";
    if (ogImg) {
      images.push({ src: ogImg, alt: title });
      blocks.push({ type: "image", image: { src: ogImg, alt: title } });
    }
    if (metaDesc) {
      paragraphs.push(metaDesc);
      blocks.push({ type: "text", texts: [metaDesc] });
    }
  }

  return { title, author, date, images, paragraphs, blocks, links: linksCollector.length > 0 ? linksCollector : undefined };
}

/** 人民日报提取器 */
function peopleDailyExtract($: cheerio.CheerioAPI): ArticleData {
  $(".top, .nav, .paper-box, .swiper-box, .date-box, .art-btn, #articleContent").remove();
  $(".news, .art-btn, #go-top, script, input, [class*=\"Copyright\"]").remove();

  const $h1 = $(".article h1").first();
  const title = ($h1.find("p").first().text() || $h1.text()).trim();

  const $h2 = $(".article h2").first();
  const subtitle = ($h2.find("p").first().text() || $h2.text()).trim() || undefined;

  const secText = $(".sec").first().text().trim() || "";
  let author: string | undefined;
  let date: string | undefined;
  if (secText) {
    const authorMatch = /^(.+?)(?:\s|\u00A0)+《人民日报》/.exec(secText);
    if (authorMatch && authorMatch[1].trim()) author = authorMatch[1].trim();
    const dateMatch = /（(\d{4}年\d{1,2}月\d{1,2}日)/.exec(secText);
    if (dateMatch) date = dateMatch[1];
  }

  // 从 #ozoom 内 enpproperty 注释提取元数据（#articleContent 已在上方 remove）
  let pageUrl: string | undefined;
  const enpSource = $("#ozoom").html() || "";
  const enpMatch = /<!--enpproperty\s+([\s\S]*?)\/enpproperty-->/i.exec(enpSource);
  if (enpMatch) {
    const xml = enpMatch[1].trim();
    if (!date) {
      const dm = /<date>([^<]+)<\/date>/i.exec(xml);
      if (dm) {
        const isoDate = dm[1].trim().replace(/\s.*$/, "");
        const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
        if (isoMatch) date = `${isoMatch[1]}年${parseInt(isoMatch[2], 10)}月${parseInt(isoMatch[3], 10)}日`;
      }
    }
    if (!author) { const am = /<author>([^<]+)<\/author>/i.exec(xml); if (am) author = am[1].trim(); }
    const um = /<url>([^<]+)<\/url>/i.exec(xml);
    if (um) pageUrl = um[1].trim();
  }

  const images: ArticleImage[] = [];
  const paragraphs: string[] = [];
  const blocks: ContentBlock[] = [];

  const ogImage = $('meta[property="og:image"]').attr("content");
  if (ogImage) { images.push({ src: ogImage, alt: title }); blocks.push({ type: "image", image: { src: ogImage, alt: title } }); }

  const $ozoom = $("#ozoom");
  if ($ozoom.length) {
    if (subtitle && subtitle.length > 1) blocks.push({ type: "heading", text: subtitle });
    const isReporterCredit = (text: string) => /^[（(](?:本报记者|新华社).+[）)]$/.test(text) && text.length < 150;

    $ozoom.find("p").each((_i, el) => {
      const $p = $(el);

      // 结构性选择器：p.patt 或 p 包含 img.picture-illustrating → 图片段落
      const $img = $p.hasClass("patt")
        ? $p.find("img").first()
        : $p.find("img.picture-illustrating").first();
      if ($img.length) {
        const imgSrc = $img.attr("src") || "";
        if (imgSrc) {
          let resolvedSrc = imgSrc;
          if (pageUrl) { try { resolvedSrc = new URL(imgSrc, pageUrl).href; } catch { /* keep */ } }

          let alt = "";
          const dataTitle = $img.attr("data-original-title");
          if (dataTitle) {
            alt = cheerio.load(dataTitle)("body").text()
              .replace(/[\u00A0\u3000\s]+/g, " ")
              .trim();
          }
          if (!alt) alt = $img.attr("alt") || "";

          images.push({ src: resolvedSrc, alt });
          blocks.push({ type: "image", image: { src: resolvedSrc, alt } });
        }
        return;
      }

      let text = $p.text().trim();
      if (!text) return;
      if (/版 权 所 有/.test(text) || /Copyright\s*[©&]/.test(text)) return;
      if (text === "*** ***" || text === "***" || text === "（相关报道见第二版）") return;
      if (isReporterCredit(text)) return;
      const $strong = $p.find("strong, b").first();
      if ($strong.length && $strong.text().trim() === text) {
        text = text.replace(/^\u3000+/g, "");
        if (text.length > 2 && text.length < 80) { blocks.push({ type: "heading", text }); return; }
      }
      text = text.replace(/^[\u3000\s]+/g, "");
      paragraphs.push(text);
      blocks.push({ type: "text", texts: [text] });
    });
  }

  if (blocks.filter(b => b.type === "text").length === 0) {
    const ogImg = $('meta[property="og:image"]').attr("content");
    const metaDesc = $('meta[name="description"]').attr("content") || "";
    if (ogImg) { images.push({ src: ogImg, alt: title }); blocks.push({ type: "image", image: { src: ogImg, alt: title } }); }
    if (metaDesc) { paragraphs.push(metaDesc); blocks.push({ type: "text", texts: [metaDesc] }); }
  }

  return { title, author, date, images, paragraphs, blocks };
}

function extractArticle(html: string, sourceId?: string): ArticleData {
  const $ = cheerio.load(html);
  $("script, style, noscript, nav, footer, aside").remove();
  if (sourceId === "news-cn") return newsCnExtract($);
  if (sourceId === "people-daily") return peopleDailyExtract($);
  return bbcExtract($);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderWithLinks(rawText: string, linkLookup: Map<number, { url: string; text: string }>): string {
  let result = "";
  let lastIndex = 0;
  const re = /\[↗(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(rawText)) !== null) {
    result += esc(rawText.slice(lastIndex, match.index));
    const n = parseInt(match[1], 10);
    const entry = linkLookup.get(n);
    if (entry) {
      result += `<a href="${esc(entry.url)}" target="_blank" rel="noopener noreferrer">${esc(entry.text)}</a>`;
    } else {
      result += esc(match[0]);
    }
    lastIndex = re.lastIndex;
  }
  result += esc(rawText.slice(lastIndex));
  return result;
}

function renderArticleHtml(article: ArticleData, originalUrl: string, linkLookup?: Map<number, { url: string; text: string }>): string {
  let bylineHtml = "";
  if (article.author || article.date) {
    bylineHtml = '<div class="byline">';
    if (article.author) bylineHtml += `<span class="author">${esc(article.author)}</span>`;
    if (article.date) bylineHtml += `<time class="date">${esc(article.date)}</time>`;
    bylineHtml += "</div>";
  }

  let summaryHtml = "";
  if (article.summary) {
    summaryHtml = `<div class="summary">${linkLookup ? renderWithLinks(article.summary, linkLookup) : esc(article.summary)}</div>`;
  }

  let bodyHtml = "";
  for (const block of article.blocks) {
    if (block.type === "image") {
      const img = block.image;
      bodyHtml += `<figure class="article-image"><img src="${esc(img.src)}" alt="${esc(img.alt)}" loading="lazy">${img.alt ? `<figcaption>${esc(img.alt)}</figcaption>` : ""}</figure>`;
    } else if (block.type === "heading") {
      bodyHtml += `<h2 class="subheading">${linkLookup ? renderWithLinks(block.text, linkLookup) : esc(block.text)}</h2>`;
    } else if (block.type === "disclaimer") {
      bodyHtml += `<aside class="disclaimer"><p>${linkLookup ? renderWithLinks(block.text, linkLookup) : esc(block.text)}</p></aside>`;
    } else if (block.type === "quote") {
      bodyHtml += block.texts.map((p) => `<p>${linkLookup ? renderWithLinks(p, linkLookup) : esc(p)}</p>`).join("\n");
    } else if (block.type === "code") {
      bodyHtml += `<pre><code>${esc(block.code)}</code></pre>`;
    } else if (block.type === "references") {
      bodyHtml += block.items.map((it) => `<p class="reference-item">${it}</p>`).join("\n");
    } else {
      bodyHtml += block.texts.map((p) => `<p>${linkLookup ? renderWithLinks(p, linkLookup) : esc(p)}</p>`).join("\n");
    }
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(article.title)}</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:"BBC Reith Sans",Helvetica,Arial,sans-serif;color:#141414;background:#fff;line-height:1.6}
  article{max-width:700px;margin:0 auto;padding:24px 16px 48px}
  h1{font-size:28px;font-weight:700;line-height:1.25;margin-bottom:16px}
  .byline{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid #e6e6e6;font-size:14px;color:#545658}
  .author{font-weight:700;color:#141414}
  .date{color:#8a8c8e}.date::before{content:"·";margin:0 8px}
  .summary{font-size:18px;font-weight:500;color:#242424;line-height:1.6;margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid #e6e6e6}
  .article-image{margin:24px 0}.article-image img{width:100%;height:auto;display:block}
  .article-image figcaption{font-size:13px;color:#545658;padding:8px 0 0}
  p{font-size:18px;line-height:1.7;margin-bottom:18px}
  p a{color:#2e6ab0;text-decoration:none}
  .subheading{font-size:20px;font-weight:700;line-height:1.3;margin:32px 0 12px}
  .original-link{margin-top:32px;padding-top:16px;border-top:1px solid #e6e6e6;font-size:14px}
  .original-link a{color:#545658;text-decoration:none}
  @media (max-width:600px){h1{font-size:24px}p{font-size:16px}article{padding:16px 12px 32px}}
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

// ====== 主流程 ======

async function main() {
  const url = process.argv[2];
  const sourceId = process.argv[3] ?? "bbc-world";

  if (!url) {
    console.error("用法: pnpm run test:translate <URL> [source-id]");
    console.error('示例: pnpm run test:translate "https://www.bbc.co.uk/news/videos/cjrggj051pvo" bbc-world');
    process.exit(1);
  }

  // 1. 加载配置
  const configPath = resolve(import.meta.dirname!, "..", "config.test.yaml");
  if (!existsSync(configPath)) { console.error(`config.yaml not found: ${configPath}`); process.exit(1); }
  const raw = load(readFileSync(configPath, "utf8")) as any;
  const providers = (raw.providers ?? {}) as Record<string, TranslateProvider>;
  const defaults = raw.defaults as any;

  const source = (raw.sources as any[])?.find((s: any) => s.id === sourceId);
  if (!source) { console.error(`Source not found: ${sourceId}`); process.exit(1); }

  // 2. 构建 env
  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) env[k] = v;

  // 3. 解析 provider
  const engines = getSourceEngines(source, defaults);
  console.log(`Engines: [${engines.join(", ")}]`);

  const resolved = engines.map((e: string) => resolveProvider(e, env, providers)).filter(Boolean) as ResolvedProvider[];
  if (resolved.length === 0) { console.error("No provider resolved (check .env)"); process.exit(1); }
  const primary = resolved[0];
  console.log(`Using: ${primary.name} (${primary.type})`);

  // 4. 抓取原文
  console.log(`\nFetching: ${url}`);
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.199 Safari/537.36" },
  });
  if (!resp.ok) { console.error(`Fetch failed: ${resp.status}`); process.exit(1); }
  const html = await resp.text();

  // 5. 提取
  const article = await extractArticle(html, sourceId);
  console.log(`Title: ${article.title.slice(0, 60)}`);
  console.log(`Blocks: ${article.blocks.length}, Images: ${article.images.length}, Links: ${article.links?.length ?? 0}`);
  if (article.links && article.links.length > 0) {
    console.log("Links collected:");
    article.links.forEach((l) => console.log(`  [↗${l.n}] "${l.text}" → ${l.url.slice(0, 80)}`));
  }

  // 6. 翻译（段落 + 链接文本一起）
  const toTranslate: string[] = [];
  if (article.title) toTranslate.push(article.title);
  if (article.summary) toTranslate.push(article.summary);
  for (const b of article.blocks) {
    if (b.type === "heading") toTranslate.push(b.text);
    else if (b.type === "text" || b.type === "quote") for (const t of b.texts) toTranslate.push(t);
    else if (b.type === "disclaimer") toTranslate.push(b.text);
    else if (b.type === "references" && b.title) toTranslate.push(b.title);
  }
  let linkOffset = 0;
  if (article.links && article.links.length > 0) {
    linkOffset = toTranslate.length;
    for (const l of article.links) toTranslate.push(l.text);
  }

  if (toTranslate.length === 0) { console.error("Nothing to translate"); process.exit(1); }
  console.log(`\nTranslating ${toTranslate.length} texts (${linkOffset} content + ${article.links?.length ?? 0} links)...`);
  const startedAt = Date.now();

  let translated: string[];
  try {
    translated = await translateTexts(toTranslate, primary);
  } catch (e) {
    console.error(`Translation failed: ${(e as Error).message}`);
    process.exit(1);
  }

  // 7. 应用翻译结果
  let idx = 0;
  if (article.title) article.title = translated[idx++] || article.title;
  if (article.summary) article.summary = translated[idx++] || article.summary;
  for (const b of article.blocks) {
    if (b.type === "heading") b.text = translated[idx++] || b.text;
    else if (b.type === "text" || b.type === "quote") for (let i = 0; i < b.texts.length; i++) b.texts[i] = translated[idx++] || b.texts[i];
    else if (b.type === "disclaimer") b.text = translated[idx++] || b.text;
    else if (b.type === "references" && b.title) b.title = translated[idx++] || b.title;
  }

  // 8. 构建链接查找表
  let linkLookup: Map<number, { url: string; text: string }> | undefined;
  if (article.links && linkOffset > 0) {
    linkLookup = new Map();
    for (let i = 0; i < article.links.length; i++) {
      const link = article.links[i];
      const translatedText = translated[linkOffset + i] || link.text;
      linkLookup.set(link.n, { url: link.url, text: translatedText });
    }
    console.log("Translated links:");
    article.links.forEach((l) => console.log(`  [↗${l.n}] "${linkLookup!.get(l.n)?.text}"`));
  }

  // 9. 渲染
  const result = renderArticleHtml(article, url, linkLookup);
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  // 10. 输出
  const outDir = resolve(import.meta.dirname!, "..", "test-output");
  mkdirSync(outDir, { recursive: true });
  const sanitized = url.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 60);
  const outPath = resolve(outDir, `${sourceId}-${sanitized}.html`);
  writeFileSync(outPath, result, "utf8");

  const rawMarkerCount = (result.match(/\[↗\d+\]/g) || []).length;
  const finalLinkCount = (result.match(/<a\b/g) || []).length;
  console.log(`\n完成 (${elapsed}s)`);
  console.log(`输出: ${result.length} 字符, ${finalLinkCount} 个 <a> 链接`);
  if (rawMarkerCount > 0) console.warn(`⚠ ${rawMarkerCount} 个未还原占位符 [↗N]`);
  else console.log("✅ 所有链接占位符已正确还原");
  console.log(`文件: ${outPath}`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
