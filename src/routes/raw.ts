import type { Hono } from 'hono';
import type { WorkerEnv } from '../types';
import { fetchAndTranslatePage, fetchAndRenderPage, translateArticle, renderArticleHtml } from '../services/content';
import { getConfig, getArticleCache, setArticleCache, deleteArticleCache, tryMarkArticlePending } from '../storage/kv';
import { resolveProviders, getSourceEngines } from '../services/translate';
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
      const cached = await getArticleCache(c.env, source.id, decodedUrl, targetLang);
      if (cached) {
        logger.info(`Serving cached article: ${decodedUrl}`);
        return new Response(cached, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }

      // 缓存未命中：返回原文 HTML，异步翻译
      try {
        logger.info(`Cache miss, serving original: ${decodedUrl}`);
        const { html: untranslatedHtml, article } = await fetchAndRenderPage(
          decodedUrl, c.env, sourceId || undefined,
        );

        // 异步翻译并写入缓存（复用缓存 key，pending 由 setArticleCache 覆盖）
        c.executionCtx.waitUntil((async () => {
          const acquired = await tryMarkArticlePending(c.env, source.id, decodedUrl, targetLang);
          if (!acquired) {
            logger.info(`Translation already pending for: ${decodedUrl}`);
            return;
          }
          logger.info(`Async translation started: ${decodedUrl}`);
          try {
            const engines = getSourceEngines(source, config?.defaults);
            const resolvedProviders = resolveProviders(engines, c.env, config?.providers);
            const primary = resolvedProviders[0] ?? null;
            const fallbacks = resolvedProviders.slice(1);
            const llmConfig = primary?.type === 'llm' ? primary.config : undefined;
            const translated = await translateArticle(
              article, c.env, primary?.name ?? 'deeplx', llmConfig,
              config?.defaults?.max_input_tokens,
              undefined,
              fallbacks.length > 0 ? fallbacks : undefined,
            );
            const translatedHtml = renderArticleHtml(translated, decodedUrl);
            await setArticleCache(c.env, source.id, decodedUrl, targetLang, translatedHtml);
            logger.info(`Async translation done: ${decodedUrl}`);
          } catch (err) {
            logger.error(`Async translation failed: ${decodedUrl}`, err as Error);
          }
        })());

        return new Response(untranslatedHtml, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      } catch (e) {
        const err = e as Error;
        logger.error(`Failed to process /raw (no cache): ${err.message}`, err);
        return c.json({ error: err.message }, 502);
      }
    }

    // refresh=1：同步翻译
    try {
      logger.info(`Translating on demand (refresh): ${decodedUrl}`);
      const engines = getSourceEngines(source, config?.defaults);
      const resolvedProviders = resolveProviders(engines, c.env, config?.providers);
      const primary = resolvedProviders[0] ?? null;
      const fallbacks = resolvedProviders.slice(1);
      const llmConfig = primary?.type === 'llm' ? primary.config : undefined;
      const translatedHtml = await fetchAndTranslatePage(
        decodedUrl, c.env, sourceId || undefined, primary?.name, llmConfig,
        config?.defaults?.max_input_tokens,
        undefined,
        fallbacks.length > 0 ? fallbacks : undefined,
      );

      // 先删旧缓存（防止配额耗尽后旧缓存残留），再异步写新缓存
      if (refreshCache) {
        await deleteArticleCache(c.env, source.id, decodedUrl, targetLang);
      }
      c.executionCtx.waitUntil(
        setArticleCache(c.env, source.id, decodedUrl, targetLang, translatedHtml),
      );

      return new Response(translatedHtml, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    } catch (e) {
      const err = e as Error;
      logger.error(`Failed to process /raw (refresh): ${err.message}`, err);
      return c.json({ error: err.message }, 502);
    }
  });
}
