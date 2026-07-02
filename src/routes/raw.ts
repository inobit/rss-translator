import type { Hono } from 'hono';
import type { WorkerEnv } from '../types';
import { fetchAndTranslatePage } from '../services/content';
import { getConfig, getArticleCache, setArticleCache, deleteArticleCache } from '../storage/kv';
import { resolveProvider } from '../services/translate';
import { createLogger } from '../utils/logger';

export function registerRawRoute(app: Hono<{ Bindings: WorkerEnv }>) {
  app.get('/raw', async (c) => {
    const logger = createLogger(c.env);
    const url = c.req.query('url');
    const sourceId = c.req.query('source');

    if (!url) {
      return c.json({ error: 'Missing "url" parameter' }, 400);
    }

    const decodedUrl = decodeURIComponent(url);
    const refreshCache = c.req.query('refresh') === '1';

    // 获取源配置
    const config = await getConfig(c.env);
    const source = (sourceId && config)
      ? config.sources.find((s) => s.id === sourceId)
      : undefined;

    // 必须提供有效的 source 参数
    if (!source) {
      return c.json({ error: 'Missing or invalid "source" parameter' }, 400);
    }

    const translateBody = source.translate_body ?? true;

    // URL 白名单校验：只允许访问配置中 source 域名下的 URL
    if (source.domains?.length) {
      const reqHost = new URL(decodedUrl).host;
      if (!source.domains.some(d => reqHost === d || reqHost.endsWith('.' + d))) {
        return c.json({ error: 'URL not from allowed source domain' }, 403);
      }
    }

    if (!translateBody) {
      // 不翻译，直接代理原文
      const resp = await fetch(decodedUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.199 Safari/537.36' },
      });
      return new Response(resp.body, {
        headers: { 'Content-Type': resp.headers.get('Content-Type') || 'text/html' },
      });
    }

    const targetLang = config?.defaults?.target_lang ?? 'ZH';

    // 优先从缓存取翻译好的 HTML
    if (!refreshCache) {
      const cached = await getArticleCache(c.env, decodedUrl, targetLang);
      if (cached) {
        logger.info(`Serving cached article: ${decodedUrl}`);
        return new Response(cached, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
    }

    try {
      // 缓存未命中，实时翻译并缓存
      logger.info(`Translating on demand: ${decodedUrl}`);
      const engine = source.engine ?? 'llm';
      const resolved = resolveProvider(engine, c.env, config?.providers);
      const llmConfig = resolved?.type === 'llm' ? resolved.config : undefined;
      const translatedHtml = await fetchAndTranslatePage(
        decodedUrl, c.env, sourceId || undefined, engine, llmConfig,
      );

      // 先删旧缓存（防止配额耗尽后旧缓存残留），再异步写新缓存
      if (refreshCache) {
        await deleteArticleCache(c.env, decodedUrl, targetLang);
      }
      c.executionCtx.waitUntil(
        setArticleCache(c.env, decodedUrl, targetLang, translatedHtml),
      );

      return new Response(translatedHtml, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    } catch (e) {
      const err = e as Error;
      logger.error(`Failed to process /raw: ${err.message}`, err);
      return c.json({ error: err.message }, 502);
    }
  });
}
