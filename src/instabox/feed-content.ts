/**
 * 全文 RSS 的正文来源：直接从源 feed 的 content:encoded 里取文章 HTML。
 *
 * 只在 box 进程内做短期内存缓存：文章是按需访问的，
 * 没必要为了 300 篇文章往 KV 写 300 次（免费额度只有 1000 次/天）。
 */

import type { RssSource } from '../types';
import { parseRssXml } from '../services/rss';
import { USER_AGENT } from './helpers';

interface FeedCache {
  url: string;
  fetchedAt: number;
  map: Map<string, string>;
  pending?: Promise<Map<string, string>>;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const caches = new Map<string, FeedCache>();

async function loadFeed(source: RssSource): Promise<Map<string, string>> {
  const resp = await fetch(source.url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) throw new Error(`feed fetch failed: ${resp.status}`);

  const parsed = parseRssXml(await resp.text());
  const map = new Map<string, string>();
  for (const item of parsed?.channel.items ?? []) {
    if (item.link && item.content) map.set(item.link, item.content);
  }
  return map;
}

/** 取某篇文章在源 feed 里的完整 HTML；非全文源或未找到时返回 undefined */
export async function getFeedArticleHtml(source: RssSource, url: string): Promise<string | undefined> {
  if (!source.fulltext_from_feed) return undefined;

  const entry = caches.get(source.id);
  if (entry && entry.url === source.url && Date.now() - entry.fetchedAt < CACHE_TTL_MS) {
    if (entry.pending) return (await entry.pending).get(url);
    return entry.map.get(url);
  }

  const next: FeedCache = { url: source.url, fetchedAt: Date.now(), map: new Map() };
  caches.set(source.id, next);
  const pending = loadFeed(source)
    .then((map) => {
      next.map = map;
      next.fetchedAt = Date.now();
      return map;
    })
    .finally(() => { next.pending = undefined; });
  next.pending = pending;

  try {
    return (await pending).get(url);
  } catch {
    return undefined;
  }
}
