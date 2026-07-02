import type { RssConfig } from '../types';
import { createLogger } from '../utils/logger';
import type { WorkerEnv } from '../types';

const CONFIG_KEY = 'config:rss';

const ARTICLE_CACHE_PREFIX = 'cache:article:';
const ARTICLE_CACHE_VERSION = 'v1';
const ARTICLE_CACHE_TTL = 7 * 24 * 60 * 60; // 7 天

/** 简单字符串哈希 */
function hashString(s: string): string {
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
  } catch (e) {
    logger.error('Failed to read config from KV', e);
    return null;
  }
}

export async function setConfig(env: WorkerEnv, config: RssConfig): Promise<void> {
  await env.RSS_CONFIG.put(CONFIG_KEY, JSON.stringify(config));
}

/** 生成文章 HTML 缓存的 key */
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
