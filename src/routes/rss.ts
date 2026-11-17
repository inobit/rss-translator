import type { Hono } from 'hono';
import type { WorkerEnv } from '../types';
import { getRssOutCache, getConfig } from '../storage/kv';
import { makeBoxBytes } from '../instabox/box-http';

/**
 * GET /rss — 纯读 KV 成品 XML；miss 转发到 instabox box 即时组装并后台补译。
 *
 * 成品 RSS XML 中文章 <link> 用的是相对路径 `/raw?url=<enc>&source=<id>`（不含 token/domain）。
 * 命中缓存时 worker 用当前请求的 origin 补绝对地址、用当前请求 token 补 &token=，
 * 保持 worker 纯读 + 极轻字符串替换（不放 fetch/cheerio/LLM 进 worker）。
 */
export function registerRssRoute(app: Hono<{ Bindings: WorkerEnv }>) {
  app.get('/rss', async (c) => {
    const sourceId = c.req.query('source');
    const noRewrite = c.req.query('links') === 'original';

    if (!sourceId) {
      return c.json({ error: 'Missing "source" parameter' }, 400);
    }

    const token = c.req.query('token') ?? '';
    const boxUrl = c.env.INSTABOX_BOX_URL;
    const boxToken = c.env.INSTABOX_TOKEN ?? '';

    // targetLang 与 box 写成品 RSS 的 key 一致：轻量读 config（不跑 cheerio/LLM）
    const config = await getConfig(c.env);
    const targetLang = config?.defaults?.target_lang ?? 'ZH';

    // 1) 命中成品直接返回
    let xml = await getRssOutCache(c.env, sourceId, targetLang);

    // 2) miss：转发到 box 即时组装（未翻译），box 后台补翻译写成品
    if (xml === null) {
      if (!boxUrl) {
        return c.json({ error: 'Cache miss and box not configured' }, 502);
      }
      const fwd = await makeBoxBytes(boxUrl, {
        path: '/forward/meta',
        query: `source=${encodeURIComponent(sourceId)}${noRewrite ? '' : `&token=${encodeURIComponent(token)}`}`,
        token: boxToken,
      });
      if (!fwd.boxOk) {
        // box 无法返回：按原样报错（用户接受）
        return c.json({ error: `Forward to box failed: ${fwd.status}` }, fwd.status >= 400 && fwd.status < 600 ? fwd.status : 502);
      }
      xml = fwd.body;
    }

    // 3) 用当前请求 origin 补绝对地址、用当前 token 补 &token=，保持轻量字符串替换
    //    成品里链接是 CDATA 包住的相对路径 /raw?url=<enc>&source=<id>（不含 token/domain）
    if (!noRewrite) {
      const origin = new URL(c.req.url).origin;
      const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
      // URL-safe 字符捕获相对路径（不含 ]>" 等分隔符），避免吞掉 CDATA 结尾
      xml = xml.replace(/(\/raw\?url=[\w%&=.-]+)/g, (_m, rel) => `${origin}${rel}${tokenParam}`);
    }

    return new Response(xml, {
      headers: {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      },
    });
  });
}