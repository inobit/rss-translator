import { Hono } from 'hono';
import type { WorkerEnv } from './types';
import { authMiddleware } from './middleware/auth';
import { registerRssRoute } from './routes/rss';
import { registerRawRoute } from './routes/raw';
import { handleScheduled } from './cron';

const app = new Hono<{ Bindings: WorkerEnv }>();

// 健康检查端点（无需鉴权）
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// 需要鉴权的端点
app.use('/rss', authMiddleware);
app.use('/raw', authMiddleware);

registerRssRoute(app);
registerRawRoute(app);

export default {
  fetch: app.fetch,
  scheduled: async (
    _event: ScheduledEvent,
    env: WorkerEnv,
    _ctx: ExecutionContext,
  ) => {
    await handleScheduled(env);
  },
};
