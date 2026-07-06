import { Hono } from 'hono';
import type { WorkerEnv } from './types';
import { authMiddleware } from './middleware/auth';
import { registerRssRoute } from './routes/rss';
import { registerRawRoute } from './routes/raw';
// import { registerRefreshRoute } from './routes/refresh';        // 见下方注释
// import { handleScheduled } from './cron';                         // 见下方注释

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
app.use('/refresh', authMiddleware);

registerRssRoute(app);
registerRawRoute(app);
// ================================================================
// [付费计划后恢复] 取消下面注释即可恢复 refresh 路由和 cron 逻辑：
//   registerRefreshRoute(app);
// ================================================================
// registerRefreshRoute(app);

export default {
  fetch: app.fetch,
  // ================================================================
  // [付费计划后恢复] Cron 定时任务已迁移至 VPS（systemd timer）。
  //   升级到 Workers Paid (Unbound) 后可取消注释恢复 CF cron：
  //   scheduled: async (
  //     event: ScheduledEvent,
  //     env: WorkerEnv,
  //     _ctx: ExecutionContext,
  //   ) => {
  //     await handleScheduled(event, env);
  //   },
  // ================================================================
};
