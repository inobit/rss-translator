import type { Hono } from 'hono';
import type { WorkerEnv } from '../types';
import { preCacheArticles, preCacheRssMetadata } from '../cron';
import { createLogger } from '../utils/logger';

export function registerRefreshRoute(app: Hono<{ Bindings: WorkerEnv }>) {
  app.get('/refresh', async (c) => {
    const logger = createLogger(c.env);
    const type = c.req.query('type');

    if (type === 'rss') {
      logger.info('Manual refresh: RSS metadata pre-cache triggered');
      c.executionCtx.waitUntil(preCacheRssMetadata(c.env));
      return c.json({ status: 'started', message: 'RSS metadata pre-cache triggered' });
    }

    if (type === 'articles') {
      logger.info('Manual refresh: article pre-cache triggered');
      c.executionCtx.waitUntil(preCacheArticles(c.env));
      return c.json({ status: 'started', message: 'Article pre-cache triggered' });
    }

    logger.info('Manual refresh: full pre-cache triggered');
    c.executionCtx.waitUntil(
      Promise.all([
        preCacheRssMetadata(c.env),
        preCacheArticles(c.env),
      ]),
    );
    return c.json({ status: 'started', message: 'Full pre-cache triggered' });
  });
}
