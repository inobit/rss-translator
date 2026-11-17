/// <reference types="@cloudflare/workers-types" />
import { Hono } from 'hono';
import type { WorkerEnv } from './types';
import { authMiddleware } from './middleware/auth';
import { registerRssRoute } from './routes/rss';
import { registerRawRoute } from './routes/raw';
// import { registerRefreshRoute } from './routes/refresh';        // 见下方注释

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
// [VPS 迁移后回退旧版] 若需人工刷新，取消下面注释：
//   registerRefreshRoute(app);
// ================================================================
// registerRefreshRoute(app);

/**
 * 触发 instabox box 执行定时任务（纯触发器，不阻塞、不求响应内容）。
 * box 后台执行解析/翻译，Worker 只发出唤醒。请求 header 带鉴权 token。
 */
async function wakeInstabox(env: WorkerEnv, mode: string): Promise<void> {
  const wakeUrl = env.INSTABOX_WAKE_URL;
  const token = env.INSTABOX_TOKEN;
  if (!wakeUrl || !token) return;
  try {
    const sep = wakeUrl.includes('?') ? '&' : '?';
    await fetch(`${wakeUrl}${sep}mode=${mode}`, {
      method: 'POST',
      headers: { 'X-Instabox-Token': token },
    });
  } catch {
    // 纯触发器：失败静默，下一轮再触发
  }
}

// CF Worker 标准导出（fetch 路由 + scheduled 定时触发）
const worker = {
  fetch: app.fetch,
  // [instabox] Cron 定时任务：每 10 分钟唤醒 box（mode=full）。
  // box 是唯一解析/翻译执行者，Worker 只做纯触发。
  async scheduled(_controller: { waitUntil(p: Promise<unknown>): void }, env: WorkerEnv): Promise<void> {
    _controller.waitUntil(wakeInstabox(env, 'full'));
  },
};

export default worker;
