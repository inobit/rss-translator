import type { WorkerEnv } from "./types";
import { getConfig } from "./storage/kv";
import { parseRssXml } from "./services/rss";
import {
  getArticleCache,
  setArticleCache,
  getRssMeta,
  setRssMeta,
  urlHash,
} from "./storage/kv";
import { fetchAndTranslatePage } from "./services/content";
import {
  resolveProviders,
  getSourceEngines,
  translateTexts,
} from "./services/translate";
import { createLogger } from "./utils/logger";

/** 每次运行最多预缓存的文章数（默认值） */
const DEFAULT_MAX_ARTICLES = 5;

/**
 * scheduled 事件处理器
 */
export async function handleScheduled(
  event: ScheduledEvent,
  env: WorkerEnv,
): Promise<void> {
  const logger = createLogger(env);
  logger.info(`Cron triggered: ${event.cron}`);
  switch (event.cron) {
    case "*/10 * * * *":
      // CASE: 对应 wrangler.toml 第一个 cron，修改时两边同步
      // 每 10 分钟：预缓存文章正文
      await preCacheArticles(env);
      break;
    case "0 */1 * * *":
      // CASE: 对应 wrangler.toml 第二个 cron，修改时两边同步
      // 每小时整点：预缓存 RSS 元信息
      await preCacheRssMetadata(env);
      break;
  }
}

/**
 * 预缓存翻译后的文章正文（每 10 分钟）
 */
export async function preCacheArticles(env: WorkerEnv): Promise<void> {
  const logger = createLogger(env);
  const config = await getConfig(env);
  if (!config) {
    logger.error("No config found, skipping pre-cache");
    return;
  }

  const targetLang = config.defaults?.target_lang ?? "ZH";
  const maxArticles =
    config.defaults?.max_articles_per_run ?? DEFAULT_MAX_ARTICLES;
  const requestIntervalMs = config.defaults?.request_interval_ms ?? 0;
  const sources = config.sources.filter((s) => s.translate_body);

  if (sources.length === 0) {
    logger.info("No sources with translate_body enabled");
    return;
  }

  let cachedCount = 0;

  for (const source of sources) {
    if (cachedCount >= maxArticles) break;

    logger.info(`Pre-caching articles for: ${source.id}`);
    try {
      const resp = await fetch(source.url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.199 Safari/537.36",
        },
      });
      if (!resp.ok) {
        logger.error(`Failed to fetch RSS for ${source.id}: ${resp.status}`);
        continue;
      }

      const xml = await resp.text();
      logger.info(`Fetched RSS for ${source.id}: ${xml.length} bytes`);
      const parsed = parseRssXml(xml);
      if (!parsed) {
        logger.error(`Failed to parse RSS for ${source.id}`);
        continue;
      }

      const items = parsed.channel.items;
      logger.info(`Parsed ${items.length} articles from ${source.id}`);

      for (const item of items) {
        if (cachedCount >= maxArticles) break;
        if (!item.link) continue;

        const cached = await getArticleCache(env, source.id, item.link, targetLang);
        if (cached) {
          logger.info(`Article cache hit: ${item.link}`);
          continue;
        }

        logger.info(
          `Article cache miss, translating: ${item.title.slice(0, 60)}`,
        );
        try {
          const engines = getSourceEngines(source, config.defaults);
          const resolvedProviders = resolveProviders(
            engines,
            env,
            config.providers,
          );
          const primary = resolvedProviders[0] ?? null;
          const fallbacks = resolvedProviders.slice(1);
          const llmProvider =
            primary?.type === "llm" ? primary.config : undefined;
          const deeplxProvider =
            primary?.type === "deeplx" ? primary.config : undefined;
          const cloudflareProvider =
            primary?.type === "cloudflare" ? primary.config : undefined;
          const html = await fetchAndTranslatePage(
            item.link,
            env,
            source.id,
            primary?.name,
            llmProvider,
            deeplxProvider,
            cloudflareProvider,
            config.defaults.max_input_tokens,
            requestIntervalMs,
            fallbacks.length > 0 ? fallbacks : undefined,
          );
          await setArticleCache(env, source.id, item.link, targetLang, html);
          cachedCount++;
          logger.info(
            `Article cache written ${cachedCount}/${maxArticles}: ${item.link}`,
          );
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

  logger.info(
    `Article pre-cache complete: cached ${cachedCount} new articles across ${sources.length} sources`,
  );
}

/**
 * 预缓存翻译后的 RSS 标题和描述
 * per-source 聚合缓存：一个 source 一条 KV，value 内 { urlHash → { title, description } }
 */
export async function preCacheRssMetadata(env: WorkerEnv): Promise<void> {
  const logger = createLogger(env);
  const config = await getConfig(env);
  if (!config) {
    logger.error("No config found, skipping RSS metadata pre-cache");
    return;
  }

  const targetLang = config.defaults?.target_lang ?? "ZH";
  const requestIntervalMs = config.defaults?.request_interval_ms ?? 0;
  const sources = config.sources.filter((s) => s.translate);

  if (sources.length === 0) {
    logger.info("No sources with translate enabled");
    return;
  }

  let updatedCount = 0;
  let skippedCount = 0;

  for (const source of sources) {
    logger.info(`Pre-caching RSS metadata for: ${source.id}`);
    try {
      const resp = await fetch(source.url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.199 Safari/537.36",
        },
      });
      if (!resp.ok) {
        logger.error(`Failed to fetch RSS for ${source.id}: ${resp.status}`);
        continue;
      }

      const xml = await resp.text();
      logger.info(`Fetched RSS for ${source.id}: ${xml.length} bytes`);

      const parsed = parseRssXml(xml);
      if (!parsed) {
        logger.error(`Failed to parse RSS for ${source.id}`);
        continue;
      }

      const { channel } = parsed;
      logger.info(`Parsed RSS for ${source.id}: ${channel.items.length} items`);

      // 读取 per-source 聚合缓存
      const metaCache = (await getRssMeta(env, source.id, targetLang)) || {};

      // 收集未缓存的条目
      const uncached: { index: number; title: string; description: string }[] =
        [];
      for (let i = 0; i < channel.items.length; i++) {
        const item = channel.items[i];
        if (item.link && !metaCache[urlHash(item.link)]) {
          uncached.push({
            index: i,
            title: item.title,
            description: item.description || "",
          });
        }
      }

      if (uncached.length === 0) {
        logger.info(`All items cached for ${source.id}, skipping`);
        skippedCount++;
        continue;
      }

      logger.info(
        `${uncached.length}/${channel.items.length} items need translation for ${source.id}`,
      );

      const engines = getSourceEngines(source, config.defaults);
      const resolvedProviders = resolveProviders(
        engines,
        env,
        config.providers,
      );
      const primary = resolvedProviders[0] ?? null;
      const fallbacks = resolvedProviders.slice(1);
      const llmConfig = primary?.type === "llm" ? primary.config : undefined;
      const deeplxConfig =
        primary?.type === "deeplx" ? primary.config : undefined;
      const cloudflareConfig =
        primary?.type === "cloudflare" ? primary.config : undefined;

      // 合并标题和描述为交错列表，按 token 限制自动分批
      const allTexts: string[] = [];
      for (const u of uncached) {
        allTexts.push(u.title);
        allTexts.push(u.description);
      }

      let allResults: string[];
      try {
        allResults = await translateTexts({
          engine: primary?.name ?? "deeplx",
          texts: allTexts,
          targetLang,
          sourceLang: "EN",
          env,
          prompt: config.llm_prompt,
          llm: llmConfig,
          deeplx: deeplxConfig,
          cloudflare: cloudflareConfig,
          fallbackProviders: fallbacks.length > 0 ? fallbacks : undefined,
          maxInputTokens: config.defaults.max_input_tokens,
          batchDelayMs: requestIntervalMs,
        });
      } catch (e) {
        const err = e as Error;
        logger.error(
          `RSS metadata translation failed for ${source.id}: ${err.message}, skipping cache`,
        );
        continue;
      }

      // 合并新翻译条目到缓存
      for (let j = 0; j < uncached.length; j++) {
        const item = channel.items[uncached[j].index];
        if (item.link) {
          metaCache[urlHash(item.link)] = {
            title: allResults[j * 2] ?? item.title,
            description: allResults[j * 2 + 1] || item.description || "",
          };
        }
      }

      // 一次性写回聚合缓存
      await setRssMeta(env, source.id, targetLang, metaCache);
      updatedCount++;
      logger.info(
        `RSS metadata cached for ${source.id}: ${uncached.length} items`,
      );
    } catch (e) {
      const err = e as Error;
      logger.error(
        `Error pre-caching RSS metadata for ${source.id}: ${err.message}`,
      );
    }
  }

  logger.info(
    `RSS metadata pre-cache complete: updated ${updatedCount}, skipped ${skippedCount} across ${sources.length} sources`,
  );
}
