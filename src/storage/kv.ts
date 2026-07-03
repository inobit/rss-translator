import type { RssConfig } from '../types';
import { createLogger } from '../utils/logger';
import type { WorkerEnv } from '../types';

const CONFIG_KEY = 'config';

const ARTICLE_CACHE_PREFIX = 'cache:article:';
const ARTICLE_CACHE_VERSION = 'v1';
const ARTICLE_CACHE_TTL = 7 * 24 * 60 * 60; // 7 天

const RSS_CACHE_PREFIX = 'cache:rss:';
const RSS_CACHE_VERSION = 'v2';

/** 简单字符串哈希（djb2） */
export function hashString(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return (hash >>> 0).toString(16);
}

const logger = createLogger();

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
  // 仅用于本地脚本更新配置，线上通过 Dashboard 或 wrangler 变量管理
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

/** 获取缓存的 RSS（返回 { hash, xml }） */
export async function getRssCache(
  env: WorkerEnv,
  sourceId: string,
  targetLang: string,
): Promise<{ hash: string; xml: string } | null> {
  const key = `${RSS_CACHE_PREFIX}${RSS_CACHE_VERSION}:${sourceId}:${targetLang}`;
  try {
    const raw = await env.RSS_ARTICLE_CACHE.get(key);
    if (!raw) return null;
    logger.debug('RSS cache hit', { key });
    return JSON.parse(raw) as { hash: string; xml: string };
  } catch (e) {
    logger.error('Failed to read RSS cache', { key, error: e });
    return null;
  }
}

/** 缓存 RSS XML 和其原始内容的 hash */
export async function setRssCache(
  env: WorkerEnv,
  sourceId: string,
  targetLang: string,
  originalXml: string,
  translatedXml: string,
): Promise<void> {
  const key = `${RSS_CACHE_PREFIX}${RSS_CACHE_VERSION}:${sourceId}:${targetLang}`;
  const rawHash = hashString(originalXml);
  const entry = JSON.stringify({ hash: rawHash, xml: translatedXml });
  await env.RSS_ARTICLE_CACHE.put(key, entry, {
    expirationTtl: ARTICLE_CACHE_TTL,
  });
  logger.debug('RSS cache set', { key, hash: rawHash });
}
