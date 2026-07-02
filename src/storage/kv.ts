import type { RssConfig } from '../types';
import { createLogger } from '../utils/logger';
import type { WorkerEnv } from '../types';

const CONFIG_VAR = 'RSS_CONFIG';

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
    const raw = env[CONFIG_VAR];
    if (!raw) return null;
    // Dashboard JSON 类型变量直接是对象，Text 类型变量是字符串
    if (typeof raw === 'object') return raw as RssConfig;
    return JSON.parse(raw as string) as RssConfig;
  } catch {
    return null;
  }
}

export async function setConfig(_env: WorkerEnv, config: RssConfig): Promise<void> {
  // 仅用于本地脚本更新配置，线上通过 Dashboard 或 wrangler 变量管理
  console.log(JSON.stringify(config));
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
