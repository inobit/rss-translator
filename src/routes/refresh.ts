import type { Hono } from 'hono';
import type { WorkerEnv } from '../types';
import { preCacheArticles, preCacheRssMetadata } from '../cron';
import { createLogger } from '../utils/logger';

export function registerRefreshRoute(app: Hono<{ Bindings: WorkerEnv }>) {
  app.get('/refresh', async (c) => {
    const logger = createLogger(c.env);
    const type = c.req.query('type');
    const startedAt = Date.now();

    try {
      if (type === 'rss') {
        logger.info('Manual refresh: RSS metadata pre-cache triggered');
        await preCacheRssMetadata(c.env);
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        return c.json({ status: 'done', message: 'RSS metadata pre-cache completed', elapsed_sec: elapsed });
      }

      if (type === 'articles') {
        logger.info('Manual refresh: article pre-cache triggered');
        await preCacheArticles(c.env);
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        return c.json({ status: 'done', message: 'Article pre-cache completed', elapsed_sec: elapsed });
      }

      logger.info('Manual refresh: full pre-cache triggered');
      await preCacheRssMetadata(c.env);
      await preCacheArticles(c.env);
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      return c.json({ status: 'done', message: 'Full pre-cache completed', elapsed_sec: elapsed });
    } catch (e) {
      const err = e as Error;
      logger.error(`Manual refresh failed: ${err.message}`);
      return c.json({ status: 'error', message: err.message }, 500);
    }
  });
}
