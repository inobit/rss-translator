import type { Hono } from 'hono';
import type { WorkerEnv } from '../types';
import { makeBoxBytes } from '../instabox/box-http';
import { rewriteRelativeLinks } from './link-rewrite';

/**
 * GET /merge — 合并所有源的成品 RSS，输出单一 feed。
 *
 * 纯转发：box 从 KV 读各源成品组装（不现场拉取、不触发翻译），
 * 元信息（标题/描述/logo）与 item 来源标注由 config.merge 控制。
 * Worker 只补全相对链接的 origin/token。
 */
export function registerMergeRoute(app: Hono<{ Bindings: WorkerEnv }>) {
  app.get('/merge', async (c) => {
    const token = c.req.query('token') ?? '';
    const boxUrl = c.env.INSTABOX_BOX_URL;
    const boxToken = c.env.INSTABOX_TOKEN ?? '';

    if (!boxUrl) {
      return c.json({ error: 'Box not configured' }, 502);
    }

    const fwd = await makeBoxBytes(boxUrl, {
      path: '/merge',
      query: '',
      token: boxToken,
    });

    if (!fwd.boxOk) {
      const status = fwd.status >= 400 && fwd.status < 600 ? fwd.status : 502;
      // box 在无任何成品时返回 404，对客户端更友好地转为 503（尚无内容）
      if (fwd.status === 404) {
        return c.json({ error: 'No merged feed available yet (no source cached)' }, 503);
      }
      return c.json({ error: `Forward to box failed: ${fwd.status}` }, status);
    }

    const origin = new URL(c.req.url).origin;
    const xml = rewriteRelativeLinks(fwd.body, origin, token);

    return new Response(xml, {
      headers: {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      },
    });
  });
}
