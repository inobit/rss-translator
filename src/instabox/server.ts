/**
 * instabox Hono HTTP 服务（Docker box）
 *
 * 作用：唯一执行 cheerio 提取与 LLM 翻译的一方。入口从环境变量构造 WorkerEnv
 * （复用 src/storage/kv-rest.ts.createVpsEnv() 读写 CF KV）。
 *
 * 鉴权：所有端点校验 header `X-Instabox-Token === env.INSTABOX_TOKEN`。
 *
 * 端点：
 *   GET  /health         健康检查（无需鉴权）
 *   POST /run?mode=...   202 立即返回，后台执行定时任务
 *   GET  /forward/meta?source=
 *   GET  /forward/article?url=&source=
 *   GET  /merge          纯读 KV 组装合并 RSS
 *
 * 启动：NODE_ENV=production node src/instabox/server.ts
 */

import { Hono } from 'hono';
import type { WorkerEnv } from '../types';
import { createVpsEnv } from '../storage/kv-rest';
import { getConfig } from '../storage/kv';
import { createLogger } from '../utils/logger';
import {
  runScheduled,
  getOrBuildRssOut,
  getOrBuildArticleHtml,
  buildMergedRss,
} from './box-core';


/** box 后台任务默认最长执行时长（watchdog 截止，毫秒）；可用 BOX_WATCHDOG_MS 覆盖 */
const DEFAULT_WATCHDOG_MS = 30 * 60_000;

/** 解析 watchdog 时长（env.BOX_WATCHDOG_MS 优先） */
function resolveWatchdogMs(env: WorkerEnv): number {
  const raw = env.BOX_WATCHDOG_MS;
  const v = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_WATCHDOG_MS;
}

/** 从 Runner token（与 INSTABOX_TOKEN 从同一处读取）校验共享鉴权 */
function buildAuthHeaderGuard(app: Hono<{ Bindings: WorkerEnv }>, token: string) {
  app.use('*', async (c, next) => {
    if (c.req.path === '/health') return next();
    const headerToken = c.req.header('X-Instabox-Token');
    if (headerToken && token && headerToken === token) {
      return next();
    }
    // 兜底：允许 query 带 token（部署便利，生产仍推荐 header）
    if (token && c.req.query('token') === token) {
      return next();
    }
    return c.json({ error: 'Unauthorized' }, 401);
  });
}

export function createBoxServer(env: WorkerEnv) {
  const app = new Hono<{ Bindings: WorkerEnv }>();
  const logger = createLogger(env);
  const token = env.INSTABOX_TOKEN ?? '';
  const watchdogMs = resolveWatchdogMs(env);

  app.get('/health', (c) => {
    return c.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  buildAuthHeaderGuard(app, token);

  app.post('/run', async (c) => {
    const mode = (c.req.query('mode') as 'full' | 'meta' | 'articles') ?? 'full';
    const deadline = Date.now() + watchdogMs;
    // 202 立即返回，后台执行
    const task = (async () => {
      const config = await getConfig(env);
      if (!config) {
        logger.error('[run] no config found');
        return;
      }
      try {
        await runScheduled(env, config, { mode, deadline });
      } catch (e) {
        const err = e as Error;
        logger.error(`[run] failed: ${err.message}`);
      }
    })();
    void task;
    return c.json({ status: 'accepted', mode, watchdog_ms: watchdogMs }, 202);
  });

  app.get('/forward/meta', async (c) => {
    const source = c.req.query('source');
    const config = await getConfig(env);
    if (!config) return c.json({ error: 'No config' }, 500);
    try {
      const xml = await getOrBuildRssOut(env, source ?? '', config);
      if (!xml) return c.json({ error: `Failed to build RSS for ${source}` }, 502);
      return new Response(xml, {
        headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
      });
    } catch (e) {
      const err = e as Error;
      return c.json({ error: err.message }, 400);
    }
  });

  app.get('/forward/article', async (c) => {
    const source = c.req.query('source') ?? '';
    const url = c.req.query('url');
    if (!url) return c.json({ error: 'Missing url' }, 400);
    const decoded = decodeURIComponent(url);
    const config = await getConfig(env);
    if (!config) return c.json({ error: 'No config' }, 500);
    try {
      const html = await getOrBuildArticleHtml(env, source, decoded, config);
      return new Response(html, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    } catch (e) {
      const err = e as Error;
      return c.json({ error: err.message }, 502);
    }
  });

  app.get('/merge', async (c) => {
    const config = await getConfig(env);
    if (!config) return c.json({ error: 'No config' }, 500);
    const xml = await buildMergedRss(env, config);
    // 无任何源成品时返回 404（语义：暂无内容），worker 侧转 503
    if (!xml) return c.json({ error: 'No merged RSS available' }, 404);
    return new Response(xml, {
      headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' },
    });
  });

  return app;
}

/** 启动 box HTTP server（供 box-server.ts 入口调用） */
export async function startBoxServer(): Promise<{ port: number }> {
  let env: WorkerEnv;
  try {
    env = createVpsEnv();
  } catch (e) {
    const err = e as Error;
    console.error(`[instabox] init failed: ${err.message}`);
    throw err;
  }

  const port = Number(process.env.INSTABOX_PORT ?? 8788);
  const app = createBoxServer(env);

  // 轻量 Node HTTP server（不引入 @hono/node-server 依赖）
  const { createServer } = await import('node:http');
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const query = url.search;
      let body = '';
      for await (const chunk of req) body += Buffer.from(chunk).toString('utf-8');

      // Node req.headers → 纯 plain object（避免引用 DOM 类型 HeadersInit/Headers）
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v;
      }

      const init: { method: string; headers: Record<string, string>; body?: string } = {
        method: req.method ?? 'GET',
        headers,
      };
      if (['POST', 'PUT'].includes(req.method ?? '')) init.body = body;

      const webRequest = new Request(url.origin + url.pathname + query, init);
      const webResponse = await app.fetch(webRequest, env);

      res.statusCode = webResponse.status;
      webResponse.headers.forEach((v, k) => res.setHeader(k, v));
      const text = await webResponse.text();
      res.end(text);
    } catch (e) {
      const err = e as Error;
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      console.log(`[instabox] server listening on :${port}`);
      resolve({ port });
    });
  });
}