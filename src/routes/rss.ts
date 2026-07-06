import type { Hono } from 'hono';
import type { WorkerEnv, RssSource } from '../types';
import { parseRssXml, buildRssXml, getChannelMetadata } from '../services/rss';
import { getConfig, getRssMeta, urlHash } from '../storage/kv';
import { createLogger } from '../utils/logger';

export function registerRssRoute(app: Hono<{ Bindings: WorkerEnv }>) {
  app.get('/rss', async (c) => {
    const logger = createLogger(c.env);
    const sourceId = c.req.query('source');
    const dynamicUrl = c.req.query('url');
    const noRewrite = c.req.query('links') === 'original';

    if (!sourceId && !dynamicUrl) {
      return c.json({ error: 'Missing "source" or "url" parameter' }, 400);
    }

    // 获取配置
    const config = await getConfig(c.env);
    let source: RssSource | null = null;

    if (sourceId) {
      if (!config) {
        return c.json({ error: 'No config found in KV' }, 500);
      }
      source = config.sources.find((s) => s.id === sourceId) ?? null;
      if (!source) {
        return c.json({ error: `Source "${sourceId}" not found` }, 404);
      }
    } else {
      // 动态 URL 模式
      source = {
        id: '__dynamic__',
        name: 'Dynamic Feed',
        url: dynamicUrl!,
        title: c.req.query('title'),
        translate: config?.defaults?.engine || config?.defaults?.engines ? true : false,
        translate_body: false,
        engines: config?.defaults?.engines ?? (config?.defaults?.engine ? [config.defaults.engine] : ['deeplx']),
      };
    }

    const targetLang = config?.defaults?.target_lang ?? 'ZH';
    const cacheKey = sourceId || '__dynamic__';

    // 抓取原始 RSS
    logger.info(`Fetching RSS: ${source.url}`);
    const resp = await fetch(source.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.199 Safari/537.36' },
    });
    if (!resp.ok) {
      logger.error(`Failed to fetch RSS: ${resp.status}`);
      return c.json({ error: `Failed to fetch RSS: ${resp.status}` }, 502);
    }

    const xml = await resp.text();

    const parsed = parseRssXml(xml);
    if (!parsed) {
      return c.json({ error: 'Failed to parse RSS XML' }, 500);
    }

    const { channel } = parsed;
    const channelMeta = getChannelMetadata(channel);

    if (source.title) {
      channelMeta.title = source.title;
    }

    // 翻译：从 per-source 聚合缓存取，未命中保留原文（VPS cron 负责写入缓存）
    if (source.translate && channel.items.length > 0) {
      const metaCache = await getRssMeta(c.env, cacheKey, targetLang);
      if (metaCache) {
        for (let i = 0; i < channel.items.length; i++) {
          const item = channel.items[i];
          if (!item.link) continue;
          const cached = metaCache[urlHash(item.link)];
          if (cached) {
            if (cached.title) item.title = cached.title;
            if (item.description && cached.description) {
              item.description = cached.description;
            }
          }
        }
      }
    }

    // 替换正文链接为代理 URL
    const token = c.req.query('token') ?? '';
    const itemsOutput = channel.items.map((item) => {
      const output: Record<string, unknown> = {
        ...item,
      };

      if (!noRewrite && source.translate_body && item.link) {
        const encodedUrl = encodeURIComponent(item.link);
        const sourceParam = sourceId ? `&source=${encodeURIComponent(sourceId)}` : '';
        const baseUrl = new URL(c.req.url).origin;
        output.link = `${baseUrl}/raw?url=${encodedUrl}${sourceParam}&token=${encodeURIComponent(token)}`;
      }

      return output;
    });

    const rssXml = buildRssXml(channelMeta as Record<string, unknown>, itemsOutput, parsed.rssAttrs);

    return new Response(rssXml, {
      headers: {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      },
    });
  });
}
