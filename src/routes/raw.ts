import type { Hono } from 'hono';
import type { WorkerEnv } from '../types';
import { getArticleCache, getConfig } from '../storage/kv';
import { makeBoxBytes } from '../instabox/box-http';
import { createLogger } from '../utils/logger';

/**
 * GET /raw — 纯读 KV 成品文章 HTML；miss 转发到 instabox box 即时格式化返回 + 后台翻译。
 * box 无法返回（原文抓取失败等）则按原样报错（用户接受）。
 */
export function registerRawRoute(app: Hono<{ Bindings: WorkerEnv }>) {
  app.get('/raw', async (c) => {
    const logger = createLogger(c.env);
    const url = c.req.query('url');
    const sourceId = c.req.query('source');

    if (!url) {
      return c.json({ error: 'Missing "url" parameter' }, 400);
    }
    if (!sourceId) {
      return c.json({ error: 'Missing "source" parameter' }, 400);
    }

    const decodedUrl = decodeURIComponent(url);
    // target_lang 与 box 写缓存时用的 key 需一致：轻量读 config（不跑 cheerio/LLM）
    const config = await getConfig(c.env);
    const targetLang = config?.defaults?.target_lang ?? 'ZH';

    // 域名白名单校验（与旧版语义一致，防止 worker/box 代理任意 URL）
    const source = config?.sources.find((s) => s.id === sourceId);
    if (!source) {
      return c.json({ error: 'Missing or invalid "source" parameter' }, 400);
    }
    if (source.domains?.length) {
      let reqHost = '';
      try { reqHost = new URL(decodedUrl).host; } catch { /* 非法 URL */ }
      if (!reqHost || !source.domains.some((d) => reqHost === d || reqHost.endsWith('.' + d))) {
        return c.json({ error: 'URL not from allowed source domain' }, 403);
      }
    }

    // 1) 命中成品直接返回
    const cached = await getArticleCache(c.env, sourceId, decodedUrl, targetLang);
    if (cached) {
      logger.info(`Serving cached article: ${decodedUrl}`);
      return new Response(cached, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // 2) miss：转发到 box 即时格式化返回（后台翻译写成品）
    const boxUrl = c.env.INSTABOX_BOX_URL;
    const boxToken = c.env.INSTABOX_TOKEN ?? '';
    if (!boxUrl) {
      return c.json({ error: 'Cache miss and box not configured' }, 502);
    }
    const fwd = await makeBoxBytes(boxUrl, {
      path: '/forward/article',
      query: `url=${encodeURIComponent(url)}&source=${sourceId}`,
      token: boxToken,
    });
    if (!fwd.boxOk) {
      // box 无法返回 → 按原样报错
      return c.json({ error: `Forward to box failed: ${fwd.status}` }, fwd.status >= 400 && fwd.status < 600 ? fwd.status : 502);
    }

    return new Response(fwd.body, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  });
}