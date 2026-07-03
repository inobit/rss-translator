import type { Hono } from 'hono';
import type { WorkerEnv, RssSource } from '../types';
import { parseRssXml, buildRssXml, getChannelMetadata } from '../services/rss';
import { translateTexts, resolveProvider } from '../services/translate';
import { getConfig, getRssMeta, setRssMeta, urlHash, RssItemMeta } from '../storage/kv';
import { createLogger } from '../utils/logger';

export function registerRssRoute(app: Hono<{ Bindings: WorkerEnv }>) {
  app.get('/rss', async (c) => {
    const logger = createLogger(c.env);
    const sourceId = c.req.query('source');
    const dynamicUrl = c.req.query('url');
    const engineOverride = c.req.query('engine');
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
        translate: config?.defaults?.engine ? true : false,
        translate_body: false,
        engine: config?.defaults?.engine ?? 'deeplx',
      };
    }

    const effectiveEngine = engineOverride ?? source.engine ?? config?.defaults?.engine ?? 'deeplx';
    const targetLang = config?.defaults?.target_lang ?? 'ZH';
    const cacheKey = sourceId || '__dynamic__';

    const resolved = effectiveEngine !== 'deeplx' || config?.providers?.[effectiveEngine]
      ? resolveProvider(effectiveEngine, c.env, config?.providers)
      : null;
    const llmConfig = resolved?.type === 'llm' ? resolved.config : undefined;
    const deeplxConfig = resolved?.type === 'deeplx' ? { endpoint: resolved.endpoint, apiKey: resolved.apiKey } : undefined;

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
    const refreshCache = c.req.query('refresh') === '1';

    const parsed = parseRssXml(xml);
    if (!parsed) {
      return c.json({ error: 'Failed to parse RSS XML' }, 500);
    }

    const { channel } = parsed;
    const channelMeta = getChannelMetadata(channel);

    if (source.title) {
      channelMeta.title = source.title;
    }

    // 翻译：从 per-source 聚合缓存取，命中跳过 LLM，未命中批量翻译后合并写回
    if (source.translate && channel.items.length > 0) {
      const metaCache = refreshCache ? null : await getRssMeta(c.env, cacheKey, targetLang);
      const cachedItems: Record<number, RssItemMeta> = {}; // index → cached meta

      if (metaCache) {
        for (let i = 0; i < channel.items.length; i++) {
          const item = channel.items[i];
          if (item.link) {
            const hash = urlHash(item.link);
            const cached = metaCache[hash];
            if (cached) cachedItems[i] = cached;
          }
        }
      }

      // 收集未命中（需 LLM 翻译）的条目
      const uncached: { index: number; title: string; description: string }[] = [];
      for (let i = 0; i < channel.items.length; i++) {
        if (!cachedItems[i]) {
          uncached.push({
            index: i,
            title: channel.items[i].title,
            description: channel.items[i].description || '',
          });
        }
      }

      if (uncached.length > 0) {
        const titleResults = await translateTexts({
          engine: effectiveEngine,
          texts: uncached.map(u => u.title),
          targetLang, sourceLang: 'EN',
          env: c.env, prompt: config?.llm_prompt,
          llm: llmConfig, deeplx: deeplxConfig,
        });

        const descResults = await translateTexts({
          engine: effectiveEngine,
          texts: uncached.map(u => u.description),
          targetLang, sourceLang: 'EN',
          env: c.env, prompt: config?.llm_prompt,
          llm: llmConfig, deeplx: deeplxConfig,
        });

        for (let j = 0; j < uncached.length; j++) {
          const idx = uncached[j].index;
          cachedItems[idx] = {
            title: titleResults[j] ?? channel.items[idx].title,
            description: descResults[j] || channel.items[idx].description || '',
          };
        }
      }

      // 应用翻译到 channel.items
      for (let i = 0; i < channel.items.length; i++) {
        const translated = cachedItems[i];
        if (translated) {
          if (translated.title) channel.items[i].title = translated.title;
          if (channel.items[i].description && translated.description) {
            channel.items[i].description = translated.description;
          }
        }
      }

      // 异步写回聚合缓存（合并新翻译条目）
      if (uncached.length > 0 && !refreshCache) {
        const merged = { ...(metaCache || {}) };
        for (let i = 0; i < channel.items.length; i++) {
          const item = channel.items[i];
          if (item.link) {
            const hash = urlHash(item.link);
            const meta = cachedItems[i];
            if (meta) merged[hash] = meta;
          }
        }
        c.executionCtx.waitUntil(
          setRssMeta(c.env, cacheKey, targetLang, merged),
        );
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
