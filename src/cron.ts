import type { WorkerEnv } from './types';
import { getConfig } from './storage/kv';
import { parseRssXml } from './services/rss';
import { getArticleCache, setArticleCache } from './storage/kv';
import { fetchAndTranslatePage } from './services/content';
import { resolveProvider } from './services/translate';
import { createLogger } from './utils/logger';

/** 每次运行最多预缓存的文章数（默认值） */
const DEFAULT_MAX_ARTICLES = 10;

/**
 * scheduled 事件处理器：预缓存翻译后的文章正文
 */
export async function handleScheduled(
  env: WorkerEnv,
): Promise<void> {
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
      const resp = await fetch(source.url);
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
          const engine = source.engine ?? 'llm';
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
