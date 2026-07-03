import type { Hono } from 'hono';
import type { WorkerEnv, RssSource } from '../types';
import { parseRssXml, buildRssXml, getChannelMetadata } from '../services/rss';
import { translateTexts, resolveProviders, getSourceEngines } from '../services/translate';
import { getConfig, getRssMeta, setRssMeta, urlHash, RssItemMeta, tryMarkRssPending } from '../storage/kv';
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
        translate: config?.defaults?.engine || config?.defaults?.engines ? true : false,
        translate_body: false,
        engines: config?.defaults?.engines ?? (config?.defaults?.engine ? [config.defaults.engine] : ['deeplx']),
      };
    }

    const engines = engineOverride
      ? [engineOverride]
      : getSourceEngines(source, config?.defaults);
    const resolvedProviders = resolveProviders(engines, c.env, config?.providers);
    const primary = resolvedProviders[0] ?? null;
    const fallbacks = resolvedProviders.slice(1);
    const llmConfig = primary?.type === 'llm' ? primary.config : undefined;
    const deeplxConfig = primary?.type === 'deeplx' ? primary.config : undefined;
    const cloudflareConfig = primary?.type === 'cloudflare' ? primary.config : undefined;
    const effectiveEngine = primary?.name ?? engineOverride ?? source.engine ?? config?.defaults?.engine ?? 'deeplx';
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

    // 翻译：从 per-source 聚合缓存取，命中跳过 LLM，未命中异步翻译后合并写回
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

      // 收集未命中（需翻译）的条目
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
        if (refreshCache) {
          // refresh=1：同步翻译
          const allTexts: string[] = [];
          for (const u of uncached) {
            allTexts.push(u.title);
            allTexts.push(u.description);
          }

          try {
            const allResults = await translateTexts({
              engine: effectiveEngine,
              texts: allTexts,
              targetLang, sourceLang: 'EN',
              env: c.env, prompt: config?.llm_prompt,
              llm: llmConfig, deeplx: deeplxConfig, cloudflare: cloudflareConfig,
              fallbackProviders: fallbacks.length > 0 ? fallbacks : undefined,
              maxInputTokens: config?.defaults?.max_input_tokens,
            });

            for (let j = 0; j < uncached.length; j++) {
              const idx = uncached[j].index;
              cachedItems[idx] = {
                title: allResults[j * 2] ?? channel.items[idx].title,
                description: allResults[j * 2 + 1] || channel.items[idx].description || '',
              };
            }
          } catch (e) {
            logger.error('RSS metadata translation failed, using originals', e as Error);
          }
        } else {
          // 缓存未命中：异步翻译，当前请求直接返回原文
          c.executionCtx.waitUntil((async () => {
            const acquired = await tryMarkRssPending(c.env, cacheKey, targetLang);
            if (!acquired) {
              logger.info(`RSS translation already pending for: ${cacheKey}`);
              return;
            }
            logger.info(`Async RSS translation started: ${cacheKey} (${uncached.length} items)`);
            try {
              const allTexts: string[] = [];
              for (const u of uncached) {
                allTexts.push(u.title);
                allTexts.push(u.description);
              }
              const allResults = await translateTexts({
                engine: effectiveEngine,
                texts: allTexts,
                targetLang, sourceLang: 'EN',
                env: c.env, prompt: config?.llm_prompt,
                llm: llmConfig, deeplx: deeplxConfig, cloudflare: cloudflareConfig,
                fallbackProviders: fallbacks.length > 0 ? fallbacks : undefined,
                maxInputTokens: config?.defaults?.max_input_tokens,
              });
              const merged = { ...(metaCache || {}) };
              for (let j = 0; j < uncached.length; j++) {
                const item = channel.items[uncached[j].index];
                if (item.link) {
                  merged[urlHash(item.link)] = {
                    title: allResults[j * 2] ?? uncached[j].title,
                    description: allResults[j * 2 + 1] || uncached[j].description || '',
                  };
                }
              }
              await setRssMeta(c.env, cacheKey, targetLang, merged);
              logger.info(`Async RSS translation done: ${cacheKey}`);
            } catch (err) {
              logger.error(`Async RSS translation failed: ${cacheKey}`, err as Error);
            }
          })());
        }
      }

      // 应用翻译到 channel.items（仅 KV 缓存命中的，未命中保留原文）
      for (let i = 0; i < channel.items.length; i++) {
        const translated = cachedItems[i];
        if (translated) {
          if (translated.title) channel.items[i].title = translated.title;
          if (channel.items[i].description && translated.description) {
            channel.items[i].description = translated.description;
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
