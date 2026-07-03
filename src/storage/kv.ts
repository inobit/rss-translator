import type { RssConfig } from '../types';
import { createLogger } from '../utils/logger';
import type { WorkerEnv } from '../types';

const CONFIG_KEY = 'config';

const ARTICLE_CACHE_PREFIX = 'cache:article:';
const ARTICLE_CACHE_VERSION = 'v1';
const ARTICLE_CACHE_TTL = 7 * 24 * 60 * 60; // 7 天

const RSS_META_PREFIX = 'cache:rss:';
const RSS_META_VERSION = 'v3';

export interface RssItemMeta {
  title: string;
  description: string;
}

const logger = createLogger();

/** 简单字符串哈希（djb2） */
export function hashString(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return (hash >>> 0).toString(16);
}

/** 对 URL 做 djb2 hash，用作子 key */
export function urlHash(url: string): string {
  return hashString(url);
}

function rssMetaKey(sourceId: string, targetLang: string): string {
  return `${RSS_META_PREFIX}${RSS_META_VERSION}:${sourceId}:${targetLang}`;
}

/** 读取某个 source 的翻译元数据缓存（{ urlHash → { title, description } }） */
export async function getRssMeta(
  env: WorkerEnv,
  sourceId: string,
  targetLang: string,
): Promise<Record<string, RssItemMeta> | null> {
  const key = rssMetaKey(sourceId, targetLang);
  try {
    const raw = await env.RSS_ARTICLE_CACHE.get(key);
    if (!raw) return null;
    logger.debug('RSS meta cache hit', { key });
    return JSON.parse(raw) as Record<string, RssItemMeta>;
  } catch (e) {
    logger.error('Failed to read RSS meta cache', { key, error: e });
    return null;
  }
}

/** 写入某个 source 的翻译元数据缓存 */
export async function setRssMeta(
  env: WorkerEnv,
  sourceId: string,
  targetLang: string,
  meta: Record<string, RssItemMeta>,
): Promise<void> {
  const key = rssMetaKey(sourceId, targetLang);
  await env.RSS_ARTICLE_CACHE.put(key, JSON.stringify(meta), {
    expirationTtl: ARTICLE_CACHE_TTL,
  });
  logger.debug('RSS meta cache set', { key, entries: Object.keys(meta).length });
}

export async function getConfig(env: WorkerEnv): Promise<RssConfig | null> {
  try {
    const raw = await env.RSS_CONFIG.get(CONFIG_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as RssConfig;
  } catch {
    return null;
  }
}

export async function setConfig(_env: WorkerEnv, config: RssConfig): Promise<void> {
  console.log(JSON.stringify(config));
}

/** 删除文章 HTML 缓存 */
export async function deleteArticleCache(
  env: WorkerEnv,
  url: string,
  targetLang: string,
): Promise<void> {
  const key = articleCacheKey(url, targetLang);
  try {
    await env.RSS_ARTICLE_CACHE.delete(key);
    logger.debug('Article cache deleted', { key });
  } catch (e) {
    logger.warn('Failed to delete article cache', { key, error: e });
  }
}

function articleCacheKey(url: string, targetLang: string): string {
  const hash = hashString(url);
  return `${ARTICLE_CACHE_PREFIX}${ARTICLE_CACHE_VERSION}:${hash}:${targetLang}`;
}

/** 获取缓存的翻译后文章 HTML（独立 KV namespace） */
export async function getArticleCache(
  env: WorkerEnv,
  url: string,
  targetLang: string,
): Promise<string | null> {
  const key = articleCacheKey(url, targetLang);
  try {
    const raw = await env.RSS_ARTICLE_CACHE.get(key);
    if (!raw) return null;
    logger.debug('Article cache hit', { key });
    return raw as string;
  } catch (e) {
    logger.error('Failed to read article cache', { key, error: e });
    return null;
  }
}

/** 缓存翻译后的文章 HTML（独立 KV namespace） */
export async function setArticleCache(
  env: WorkerEnv,
  url: string,
  targetLang: string,
  html: string,
): Promise<void> {
  const key = articleCacheKey(url, targetLang);
  await env.RSS_ARTICLE_CACHE.put(key, html, {
    expirationTtl: ARTICLE_CACHE_TTL,
  });
  logger.debug('Article cache set', { key });
}
