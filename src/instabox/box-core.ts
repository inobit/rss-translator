/**
 * instabox 核心逻辑：解析 / 翻译 / 缓存 的执行者。
 *
 * 角色：唯一执行 cheerio 提取和 LLM 翻译的一方。
 * KV 只存「成品」：整个 RSS XML（cache:rssout:）与文章 HTML（cache:article:）。
 * 本文不负责 HTTP 入站，仅提供被 server.ts 调用的编排函数。
 */

import type {
  WorkerEnv,
  RssConfig,
  RssSource,
  ParsedRss,
} from '../types';
import {
  getArticleCache,
  setArticleCache,
  tryMarkArticlePending,
  tryMarkRssPending,
  getRssMeta,
  getRssOutCache,
  setRssOutCache,
  urlHash,
} from '../storage/kv';
import { parseRssXml, getChannelMetadata, buildRssXml } from '../services/rss';
import {
  fetchAndTranslatePage,
  fetchAndRenderPage,
} from '../services/content';
import { getSourceEngines, resolveProviders } from '../services/translate';
import {
  USER_AGENT,
  fetchBounded,
  daysToSeconds,
  translateMetaTexts,
  writeMetaBack,
  type MetaTextData,
  type TranslatedMeta,
} from './helpers';
import { createLogger } from '../utils/logger';

const DEFAULT_TTL_DAYS = 30;
const DEFAULT_SOURCES_PER_RUN = 5;
const DEFAULT_ARTICLES_PER_SOURCE = 8;
const DEFAULT_ARTICLE_CONCURRENCY = 5;

/** 解析文章翻译并发度（env.BOX_ARTICLE_CONCURRENCY 优先，默认 5） */
function resolveConcurrency(env: WorkerEnv): number {
  const raw = env.BOX_ARTICLE_CONCURRENCY;
  const v = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : DEFAULT_ARTICLE_CONCURRENCY;
}

/**
 * 简单并发池：同时最多跑 limit 个任务，全部完成才返回。
 * Promise.all 会等待所有 runner，任一任务抛错会中断整体（调用方各自 try/catch）。
 */
async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

/**
 * 严格 percent-encode：在 encodeURIComponent 基础上，把其保留的 `! ~ * ' ( )` 也转义成 %XX。
 * 这样产物 <link> 的 url 值只含 [A-Za-z0-9%&=._-]，worker 端正则 /raw\?url=[\w%&=.-]+ 总能完整捕获，
 * 不会被 `(` `)` `!` `'` `*` `~` 截断。
 */
function strictEncodeComponent(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*~]/g, (ch) => {
    return '%' + ch.charCodeAt(0).toString(16).toUpperCase();
  });
}

/** round-robin 游标 key 前缀 */
const CURSOR_PREFIX = 'cache:rssout:cursor:';

function daysToSec(days?: number): number {
  return daysToSeconds(days ?? DEFAULT_TTL_DAYS);
}

function sourceEnabled(s: RssSource): boolean {
  return s.enabled !== false;
}

async function fetchRssParsed(url: string): Promise<ParsedRss | null> {
  const resp = await fetchBounded(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!resp.ok) return null;
  const xml = await resp.text();
  return parseRssXml(xml);
}

/** 组装单源成品 RSS XML（文章 link 相对路径，不含 token/domain）。翻译 title/desc 通过 merged meta 覆盖。 */
function assembleRssOut(
  source: RssSource,
  parsed: ParsedRss,
  merged: Record<string, unknown> | Record<string, TranslatedMeta> | null,
): string {
  const { channel } = parsed;
  const channelMeta = getChannelMetadata(channel);
  if (source.title) channelMeta.title = source.title;
  if (source.logo) {
    const imageTitle = source.title || (channelMeta.title as string) || source.name;
    const imageLink = (channelMeta.link as string) || source.url;
    channelMeta['webfeeds:icon'] = source.logo;
    channelMeta.image = { url: source.logo, title: imageTitle, link: imageLink };
    if (parsed.rssAttrs) parsed.rssAttrs['@_xmlns:webfeeds'] = 'http://webfeeds.org/rss/1.0';
  }

  const itemsOutput = channel.items.map((item) => {
    const output: Record<string, unknown> = { ...item };
    const hash = urlHash(item.link ?? '');
    const hit = merged ? (merged as Record<string, TranslatedMeta>)[hash] : undefined;
    if (hit && 'title' in hit) {
      if (hit.title) output.title = hit.title;
      if (output.description && hit.description) output.description = hit.description;
    }
    if (item.link) {
      // 生产端严格编码 url / source，保证 worker 端正则捕获完整、不吞参、不拼坏 CDATA
      output.link = `/raw?url=${strictEncodeComponent(item.link)}&source=${strictEncodeComponent(source.id)}`;
    }
    return output;
  });

  return buildRssXml(channelMeta as Record<string, unknown>, itemsOutput, parsed.rssAttrs);
}

// ============ RSS 元信息：翻译 + 写成品 ============

/** 翻译单源 title/desc（去重后），写回 per-source meta 缓存 + 成品 RSS XML。返回新翻译条数。 */
export async function translateAndCacheRssOut(
  env: WorkerEnv,
  source: RssSource,
  config: RssConfig,
): Promise<number> {
  const logger = createLogger(env);
  const targetLang = config.defaults?.target_lang ?? 'ZH';
  const xml = await fetchRssXml(source.url);
  if (!xml) {
    logger.warn(`Failed to fetch RSS for ${source.id}`);
    return 0;
  }
  const parsed = parseRssXml(xml);
  if (!parsed) return 0;

  const items = parsed.channel.items;

  // translate=false：不翻译，只组装成品并对比（无需读记忆表）
  if (!source.translate) {
    const outXml = assembleRssOut(source, parsed, null);
    await writeIfChanged(env, source.id, targetLang, outXml, config);
    return 0;
  }

  // 只有需要翻译时才读翻译记忆表
  const memory = (await getRssMeta(env, source.id, targetLang)) ?? {};

  // 收集未缓存条目
  const uncached: MetaTextData[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].link && !memory[urlHash(items[i].link)]) {
      uncached.push({ index: i, title: items[i].title ?? '', description: items[i].description ?? '' });
    }
  }

  let translated: TranslatedMeta[] = uncached.map((u) => ({ title: u.title, description: u.description }));
  if (uncached.length > 0) {
    translated = await translateMetaTexts(env, source, uncached, config.providers, {
      targetLang,
      llm_prompt: config.llm_prompt,
      max_input_tokens: config.defaults?.max_input_tokens,
      request_interval_ms: config.defaults?.request_interval_ms,
      defaults: { engines: config.defaults?.engines, engine: config.defaults?.engine },
    });
  }

  // 用未缓存条目的原索引取 link，避免翻译写到错误的 urlHash 上
  const entries = uncached.map((u, i) => ({
    link: items[u.index]?.link ?? '',
    meta: translated[i],
  }));
  const merged = await writeMetaBack(env, source.id, entries, memory, targetLang, daysToSec(config.defaults?.rss_cache_ttl));

  const outXml = assembleRssOut(source, parsed, merged);
  await writeIfChanged(env, source.id, targetLang, outXml, config);
  if (uncached.length > 0) {
    logger.info(`RSS output updated: ${source.id} (${uncached.length} new)`);
  }
  return uncached.length;
}

/**
 * 比较用的归一化：剔除易变的 lastBuildDate。
 * 源站可能周期刷新该时间戳，不剔除的话「内容未变也会判定为变化」，KV 写入优化失效。
 */
function normalizeForCompare(xml: string): string {
  return xml.replace(/<lastBuildDate>[^<]*<\/lastBuildDate>/g, '<lastBuildDate/>');
}

/**
 * 只在成品实质内容变化（或尚无缓存）时写 KV。
 * 避免每轮无脑重写全部源——KV 免费计划仅 1000 写入/天，全量重写会直接打满。
 */
async function writeIfChanged(
  env: WorkerEnv,
  sourceId: string,
  targetLang: string,
  outXml: string,
  config: RssConfig,
): Promise<void> {
  const logger = createLogger(env);
  const existing = await getRssOutCache(env, sourceId, targetLang);
  if (existing !== null && normalizeForCompare(existing) === normalizeForCompare(outXml)) {
    logger.debug(`RSS output unchanged, skip write: ${sourceId}`);
    return;
  }
  await setRssOutCache(
    env,
    sourceId,
    targetLang,
    outXml,
    daysToSec(config.defaults?.rss_cache_ttl),
  );
  logger.info(`RSS output cached: ${sourceId}`);
}

async function fetchRssXml(url: string): Promise<string | null> {
  const resp = await fetchBounded(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!resp.ok) return null;
  return resp.text();
}

// ============ 文章：翻译 + 写成品 ============

/**
 * 翻译一篇文章并写成品缓存.
 * claim（tryMarkArticlePending）是唯一权威入口：若不传 skipClaim 则自行 claim，
 * claim 失败（已有 pending 或已缓存）直接返回。调用方可传 skipClaim 复用外部已持有的 claim。
 */
export async function translateAndCacheArticle(
  env: WorkerEnv,
  source: RssSource,
  url: string,
  config: RssConfig,
  opts?: { skipClaim?: boolean },
): Promise<void> {
  const logger = createLogger(env);
  const targetLang = config.defaults?.target_lang ?? 'ZH';

  if (!opts?.skipClaim) {
    const claimed = await tryMarkArticlePending(env, source.id, url, targetLang);
    if (!claimed) {
      logger.debug(`Article already pending/cached, skip: ${url}`);
      return;
    }
  }

  const engines = getSourceEngines(source, {
    engines: config.defaults?.engines,
    engine: config.defaults?.engine,
  });
  const resolved = resolveProviders(engines, env, config.providers);
  const primary = resolved[0] ?? null;
  const fallbacks = resolved.slice(1);
  const llmProvider = primary?.type === 'llm' ? primary.config : undefined;
  const deeplxProvider = primary?.type === 'deeplx' ? primary.config : undefined;
  const cloudflareProvider = primary?.type === 'cloudflare' ? primary.config : undefined;

  try {
    const html = await fetchAndTranslatePage(
      url,
      env,
      source.id,
      primary?.name,
      llmProvider,
      deeplxProvider,
      cloudflareProvider,
      config.defaults?.max_input_tokens,
      config.defaults?.request_interval_ms,
      fallbacks.length > 0 ? fallbacks : undefined,
    );
    await setArticleCache(env, source.id, url, targetLang, html, daysToSec(config.defaults?.article_cache_ttl));
    logger.info(`Article translated & cached: ${url}`);
  } catch (e) {
    const err = e as Error;
    logger.warn(`Article async translate failed: ${err.message}`);
  }
}

/** 仅格式化原文并写缓存（translate_body=false 的源，不调 LLM）。 */
export async function formatAndCacheArticle(
  env: WorkerEnv,
  source: RssSource,
  url: string,
  config: RssConfig,
): Promise<void> {
  const logger = createLogger(env);
  const targetLang = config.defaults?.target_lang ?? 'ZH';

  const claimed = await tryMarkArticlePending(env, source.id, url, targetLang);
  if (!claimed) {
    logger.debug(`Article already pending/cached, skip: ${url}`);
    return;
  }

  try {
    const { html } = await fetchAndRenderPage(url, env, source.id);
    await setArticleCache(env, source.id, url, targetLang, html, daysToSec(config.defaults?.article_cache_ttl));
    logger.info(`Article formatted & cached: ${url}`);
  } catch (e) {
    const err = e as Error;
    logger.warn(`Article format failed: ${err.message}`);
  }
}

// ============ 转发入口 ============

/** /forward/meta：命中成品返回；miss 则现场组装（未翻译）+ 后台翻译写成品 */
export async function getOrBuildRssOut(
  env: WorkerEnv,
  sourceId: string,
  config: RssConfig,
): Promise<string | null> {
  const source = config.sources.find((s) => s.id === sourceId);
  if (!source) throw new Error(`Source not found: ${sourceId}`);
  const targetLang = config.defaults?.target_lang ?? 'ZH';

  const cached = await getRssOutCache(env, sourceId, targetLang);
  if (cached) return cached;

  // 后台翻译 + 写成品
  if (await tryMarkRssPending(env, sourceId, targetLang)) {
    translateAndCacheRssOut(env, source, config)
      .catch(() => {})
      .finally(() => { });
  }

  // miss 现场返回未翻译成品
  const xml = await fetchRssXml(source.url);
  const parsed = xml ? parseRssXml(xml) : null;
  if (!parsed) return null;
  return assembleRssOut(source, parsed, null);
}

/** /forward/article：命中成品返回；miss 现场渲染原文返回 + 后台翻译写成品 */
export async function getOrBuildArticleHtml(
  env: WorkerEnv,
  sourceId: string,
  url: string,
  config: RssConfig,
): Promise<string> {
  const source = config.sources.find((s) => s.id === sourceId);
  if (!source) throw new Error(`Source not found: ${sourceId}`);
  const targetLang = config.defaults?.target_lang ?? 'ZH';

  const cached = await getArticleCache(env, sourceId, url, targetLang);
  if (cached) return cached;

  // 提前 claim（缩小并发重复窗口）：render 之前先占位，避免多并发请求同时抓取+渲染同一篇。
  // claim 失败（已有 pending/缓存）则跳过后台翻译（已有别的 run 在翻）。
  const claimed = await tryMarkArticlePending(env, source.id, url, targetLang);
  if (!claimed) {
    // 未 claim 成功仍应现场渲染返回原文，只是不启动后台补译
    const { html: rendered } = await fetchAndRenderPage(url, env, sourceId);
    return rendered;
  }

  // claim 成功：渲染（若 render 失败借助 PENDING_TTL 60s 自动失效，循环有兜底）
  const { html } = await fetchAndRenderPage(url, env, sourceId);

  // 后台写成品：translate_body !== false 才翻译正文；false 直接用已渲染结果写缓存
  if (source.translate_body !== false) {
    translateAndCacheArticle(env, source, url, config, { skipClaim: true }).catch(() => {});
  } else {
    setArticleCache(
      env,
      source.id,
      url,
      targetLang,
      html,
      daysToSec(config.defaults?.article_cache_ttl),
    ).catch(() => {});
  }

  return html;
}

// ============ /run 定时任务 ============

export interface RunOptions {
  mode: 'full' | 'meta' | 'articles';
  deadline: number;
}

/** 读取 round-robin 游标（本期实现渐进推进：记录每个源处理到第几篇） */
async function readCursor(env: WorkerEnv): Promise<number> {
  try {
    const raw = await env.RSS_CACHE.get(CURSOR_PREFIX + 'global');
    return raw ? parseInt(raw, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

async function writeCursor(env: WorkerEnv, value: number): Promise<void> {
  await env.RSS_CACHE.put(CURSOR_PREFIX + 'global', String(value));
}

/** 定时任务执行体 */
export async function runScheduled(
  env: WorkerEnv,
  config: RssConfig,
  opts: RunOptions,
): Promise<{ processed: number; mode: string }> {
  const logger = createLogger(env);
  const targetLang = config.defaults?.target_lang ?? 'ZH';
  const sourcesPerRun = config.defaults?.sources_per_run ?? DEFAULT_SOURCES_PER_RUN;
  const articlesPerSource = config.defaults?.articles_per_source ?? DEFAULT_ARTICLES_PER_SOURCE;

  // enabled !== false 的源全部参与：translate=false 只是不调 LLM，仍要刷新成品
  const activeSources = config.sources.filter(sourceEnabled);
  let processed = 0;

  if (opts.mode === 'meta' || opts.mode === 'full') {
    for (const source of activeSources) {
      if (Date.now() > opts.deadline) break;
      if (await tryMarkRssPending(env, source.id, targetLang)) {
        processed += await translateAndCacheRssOut(env, source, config);
      }
    }
  }

  if (opts.mode === 'articles' || opts.mode === 'full') {
    // round-robin：游标偏移选择起始源，处理 sourcesPerRun 个源 × articlesPerSource 篇
    const cursor = await readCursor(env);
    const n = activeSources.length;
    const windowSources: RssSource[] = [];
    if (n > 0) {
      for (let i = 0; i < n && windowSources.length < sourcesPerRun; i++) {
        const src = activeSources[(cursor + i) % n];
        windowSources.push(src);
      }
    }

    let interrupted = false; // 是否因 deadline 提前中断（未跑完本窗口）
    const concurrency = resolveConcurrency(env);
    for (const source of windowSources) {
      if (Date.now() > opts.deadline) { interrupted = true; break; }
      const parsed = await fetchRssParsed(source.url);
      if (!parsed) continue;
      // translate_body=false：只格式化正文，不调 LLM
      const needTranslateBody = source.translate_body !== false;

      // 先串行挑出本源的待处理条目（已缓存 / 超限额则跳过）
      const targets: string[] = [];
      for (const item of parsed.channel.items) {
        if (targets.length >= articlesPerSource) break;
        if (!item.link) continue;
        const cached = await getArticleCache(env, source.id, item.link, targetLang);
        if (cached) continue;
        targets.push(item.link);
      }

      // 并发处理（并发度可配，默认 5）。watchdog 到点仅停止发起新任务，
      // 已在飞行的请求会自然跑完——避免将半成品丢给下一轮重复抓取。
      await runPool(targets, concurrency, async (link) => {
        if (Date.now() > opts.deadline) { interrupted = true; return; }
        // claim 权威在 translateAndCacheArticle / formatAndCacheArticle 内部发生一次
        if (needTranslateBody) {
          await translateAndCacheArticle(env, source, link, config);
        } else {
          await formatAndCacheArticle(env, source, link, config);
        }
        processed++;
      });
    }

    // 仅在完整跑完本窗口时才推进游标，避免 deadline 提前中断丢源；
    // 中断则保留当前游标，下一轮重新覆盖这些源。
    // 取舍：低频单 box 场景下 read-then-write 无并发竞争；配合「中断不推进」保证按期按序覆盖不丢源。
    if (!interrupted) {
      await writeCursor(env, cursor + sourcesPerRun);
    }
  }

  logger.info(`[instabox] run ${opts.mode} complete: processed=${processed}`);
  return { processed, mode: opts.mode };
}

// ============ /merge 汇总 ============

/**
 * /merge：纯读 KV 组装合并 RSS（不现场拉取、不触发翻译）。
 * 把所有源成品 item 合并进单一 feed；某源无成品则跳过。
 */
export async function buildMergedRss(
  env: WorkerEnv,
  config: RssConfig,
): Promise<string | null> {
  const logger = createLogger(env);
  const mergeCfg = config.merge ?? {};
  const targetLang = config.defaults?.target_lang ?? 'ZH';
  const titlePrefix = mergeCfg.title_prefix ?? '[{name}] ';
  const addCategory = mergeCfg.add_category ?? true;

  const allItems: { item: Record<string, unknown>; pubDate: number }[] = [];
  let firstLink = '';
  // 汇总各源成品的命名空间声明（media:/dc:/content:/atom: 等），
  // 否则带前缀元素在合并 XML 中会变成 unbound prefix，不符合 XML 规范
  const mergedAttrs: Record<string, unknown> = { '@_version': '2.0' };

  for (const source of config.sources) {
    if (!sourceEnabled(source)) continue;
    const out = await getRssOutCache(env, source.id, targetLang);
    if (!out) continue;
    const parsed = parseRssXml(out);
    if (!parsed) continue;
    if (!firstLink && typeof parsed.channel.link === 'string') {
      firstLink = parsed.channel.link;
    }
    if (parsed.rssAttrs) {
      for (const [k, v] of Object.entries(parsed.rssAttrs)) {
        if (k.startsWith('@_xmlns') && !(k in mergedAttrs)) mergedAttrs[k] = v;
      }
    }

    const sourceLabel = source.title || source.name || source.id;
    for (const raw of parsed.channel.items) {
      const item = { ...(raw as unknown as Record<string, unknown>) };

      // 标题前缀：让合并流里能一眼区分来源
      if (titlePrefix && typeof item.title === 'string') {
        item.title = titlePrefix.replace(/\{name\}/g, sourceLabel) + item.title;
      }

      // <category> 标准元素标注来源（与原 category 共存）
      if (addCategory) {
        const existing = item.category;
        if (Array.isArray(existing)) {
          item.category = [...existing, sourceLabel];
        } else if (typeof existing === 'string') {
          item.category = [existing, sourceLabel];
        } else {
          item.category = sourceLabel;
        }
      }

      allItems.push({ item, pubDate: parsePubDate(item.pubDate) });
    }
    logger.debug(`[merge] included ${source.id}: ${parsed.channel.items.length} items`);
  }

  if (allItems.length === 0) return null;

  // 按发布时间倒序（无 pubDate 的排到最后）
  allItems.sort((a, b) => b.pubDate - a.pubDate);

  const channelMeta: Record<string, unknown> = {
    title: mergeCfg.title ?? 'RSS Translator 综合',
    description: mergeCfg.description ?? '整合各源翻译后的 RSS',
    link: mergeCfg.link ?? firstLink,
    language: 'zh-CN',
  };
  // logo 取 config.merge.logo；未配置则不输出 image
  if (mergeCfg.logo) {
    channelMeta.image = {
      url: mergeCfg.logo,
      title: mergeCfg.title ?? 'RSS Translator 综合',
      link: mergeCfg.link ?? firstLink,
    };
  }

  return buildRssXml(channelMeta, allItems.map((x) => x.item), mergedAttrs);
}

/** 解析 RSS pubDate 为时间戳，失败返回 0（排序靠后） */
function parsePubDate(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const ts = Date.parse(value);
  return Number.isNaN(ts) ? 0 : ts;
}