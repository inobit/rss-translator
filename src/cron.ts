import type { WorkerEnv } from './types';
import { getConfig } from './storage/kv';
import { parseRssXml, buildRssXml, getChannelMetadata } from './services/rss';
import { getArticleCache, setArticleCache, getRssCache, setRssCache, hashString } from './storage/kv';
import { fetchAndTranslatePage } from './services/content';
import { resolveProvider, translateTexts } from './services/translate';
import { createLogger } from './utils/logger';

/** 每次运行最多预缓存的文章数（默认值） */
const DEFAULT_MAX_ARTICLES = 10;

/**
 * scheduled 事件处理器
 */
export async function handleScheduled(
  event: ScheduledEvent,
  env: WorkerEnv,
): Promise<void> {
  switch (event.cron) {
    case '0 */2 * * *':
      // CASE: 对应 wrangler.toml 第一个 cron，修改时两边同步
      // 每 2 小时整点：预缓存文章正文
      await preCacheArticles(env);
      break;
    case '0 17,1,9 * * *':
      // CASE: 对应 wrangler.toml 第二个 cron，修改时两边同步
      // 每天 UTC 1:00/9:00/17:00（北京时间 9:00/17:00/次日 1:00）：预缓存 RSS 元信息
      await preCacheRssMetadata(env);
      break;
  }
}

/**
 * 预缓存翻译后的文章正文（每 2 小时）
 */
export async function preCacheArticles(env: WorkerEnv): Promise<void> {
  const logger = createLogger(env);
  const config = await getConfig(env);
  if (!config) {
    logger.error('No config found, skipping pre-cache');
    return;
  }

  const targetLang = config.defaults?.target_lang ?? 'ZH';
  const maxArticles = config.defaults?.max_articles_per_run ?? DEFAULT_MAX_ARTICLES;
  const sources = config.sources.filter(s => s.translate_body);

  if (sources.length === 0) {
    logger.info('No sources with translate_body enabled');
    return;
  }

  let cachedCount = 0;

  for (const source of sources) {
    if (cachedCount >= maxArticles) break;

    logger.info(`Pre-caching articles for: ${source.id}`);
    try {
      const resp = await fetch(source.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.199 Safari/537.36' },
      });
      if (!resp.ok) {
        logger.error(`Failed to fetch RSS for ${source.id}: ${resp.status}`);
        continue;
      }

      const xml = await resp.text();
      const parsed = parseRssXml(xml);
      if (!parsed) {
        logger.error(`Failed to parse RSS for ${source.id}`);
        continue;
      }

      for (const item of parsed.channel.items) {
        if (cachedCount >= maxArticles) break;
        if (!item.link) continue;

        // 检查是否已有缓存
        const cached = await getArticleCache(env, item.link, targetLang);
        if (cached) {
          logger.debug(`Already cached: ${item.link}`);
          continue;
        }

        logger.info(`Pre-caching article: ${item.title.slice(0, 60)}`);
        try {
          const engine = source.engine ?? config.defaults.engine ?? 'deeplx';
          const resolved = resolveProvider(engine, env, config.providers);
          const llmProvider = resolved?.type === 'llm' ? resolved.config : undefined;
          const html = await fetchAndTranslatePage(
            item.link,
            env,
            source.id,
            engine,
            llmProvider,
          );
          await setArticleCache(env, item.link, targetLang, html);
          cachedCount++;
          logger.info(`Cached article ${cachedCount}/${maxArticles}: ${item.link}`);
        } catch (e) {
          const err = e as Error;
          logger.warn(`Failed to pre-cache article: ${err.message}`);
        }
      }
    } catch (e) {
      const err = e as Error;
      logger.error(`Error processing source ${source.id}: ${err.message}`);
    }
  }

  logger.info(`Pre-cache run complete: cached ${cachedCount} articles`);
}

/**
 * 预缓存翻译后的 RSS 元信息（标题翻译）
 * 逻辑与 /rss 路由一致：获取原始 RSS → hash 比对缓存 → 翻译标题 → 构建 XML → 写入缓存
 */
export async function preCacheRssMetadata(env: WorkerEnv): Promise<void> {
  const logger = createLogger(env);
  const config = await getConfig(env);
  if (!config) {
    logger.error('No config found, skipping RSS metadata pre-cache');
    return;
  }

  const targetLang = config.defaults?.target_lang ?? 'ZH';
  const sources = config.sources.filter(s => s.translate);

  if (sources.length === 0) {
    logger.info('No sources with translate enabled');
    return;
  }

  let updatedCount = 0;
  let skippedCount = 0;

  for (const source of sources) {
    logger.info(`Pre-caching RSS metadata for: ${source.id}`);
    try {
      const resp = await fetch(source.url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.199 Safari/537.36' },
      });
      if (!resp.ok) {
        logger.error(`Failed to fetch RSS for ${source.id}: ${resp.status}`);
        continue;
      }

      const xml = await resp.text();
      const currentHash = hashString(xml);

      // hash 比对：原始 RSS 未变则跳过
      const cached = await getRssCache(env, source.id, targetLang);
      if (cached && cached.hash === currentHash) {
        logger.info(`RSS metadata unchanged, skipping: ${source.id}`);
        skippedCount++;
        continue;
      }

      const parsed = parseRssXml(xml);
      if (!parsed) {
        logger.error(`Failed to parse RSS for ${source.id}`);
        continue;
      }

      const { channel } = parsed;
      const channelMeta = getChannelMetadata(channel);

      if (source.title) {
        channelMeta.title = source.title;
      }

      // 翻译标题
      if (channel.items.length > 0) {
        const titles = channel.items.map((item) => item.title);

        const engine = source.engine ?? config.defaults.engine ?? 'deeplx';
        const resolved = resolveProvider(engine, env, config.providers);
        const llmConfig = resolved?.type === 'llm' ? resolved.config : undefined;
        const deeplxConfig = resolved?.type === 'deeplx' ? { endpoint: resolved.endpoint, apiKey: resolved.apiKey } : undefined;

        const translatedTitles = await translateTexts({
          engine,
          texts: titles,
          targetLang,
          sourceLang: 'EN',
          env,
          prompt: config.llm_prompt,
          llm: llmConfig,
          deeplx: deeplxConfig,
        });

        for (let i = 0; i < channel.items.length; i++) {
          channel.items[i].title = translatedTitles[i] ?? channel.items[i].title;
        }
      }

      // 构建翻译后的 RSS XML
      const rssXml = buildRssXml(channelMeta as Record<string, unknown>, channel.items, parsed.rssAttrs);

      // 写入缓存
      await setRssCache(env, source.id, targetLang, xml, rssXml);
      updatedCount++;
      logger.info(`RSS metadata cached: ${source.id}`);
    } catch (e) {
      const err = e as Error;
      logger.error(`Error pre-caching RSS metadata for ${source.id}: ${err.message}`);
    }
  }

  logger.info(`RSS metadata pre-cache complete: updated ${updatedCount}, skipped ${skippedCount}`);
}
