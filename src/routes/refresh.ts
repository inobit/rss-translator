import type { Hono } from 'hono';
import type { WorkerEnv } from '../types';
import { preCacheArticles, preCacheRssMetadata } from '../cron';

export function registerRefreshRoute(app: Hono<{ Bindings: WorkerEnv }>) {
  app.get('/refresh', async (c) => {
    const type = c.req.query('type');

    if (type === 'rss') {
      c.executionCtx.waitUntil(preCacheRssMetadata(c.env));
      return c.json({ status: 'started', message: 'RSS metadata pre-cache triggered' });
    }

    if (type === 'articles') {
      c.executionCtx.waitUntil(preCacheArticles(c.env));
      return c.json({ status: 'started', message: 'Article pre-cache triggered' });
    }

    c.executionCtx.waitUntil(
      Promise.all([
        preCacheRssMetadata(c.env),
        preCacheArticles(c.env),
      ]),
    );
    return c.json({ status: 'started', message: 'Full pre-cache triggered' });
  });
}
