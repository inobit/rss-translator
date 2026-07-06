/**
 * VPS 端定时任务入口
 *
 * 用法：
 *   node --experimental-strip-types cron-vps.ts articles
 *   node --experimental-strip-types cron-vps.ts metadata
 *
 * 复用 src/cron.ts 中的 preCacheArticles / preCacheRssMetadata，
 * 通过 REST API 读写 Cloudflare KV，翻译结果 Worker 端直接读取。
 *
 * 环境变量（.env）：
 *   CLOUDFLARE_ACCOUNT_ID       — Cloudflare 账户 ID
 *   CF_KV_API_TOKEN     — API Token（Workers KV Storage 编辑权限，命名避免与 wrangler 冲突）
 *   CF_KV_CONFIG_ID     — RSS_CONFIG namespace ID
 *   CF_KV_CACHE_ID      — RSS_CACHE namespace ID
 *   DEEPSEEK_API_KEY    — 翻译 API key（或对应 provider 的 key）
 *   LOG_LEVEL           — 日志级别（可选，默认 info）
 */

import { createVpsEnv } from "./src/storage/kv-rest.ts";
import {
  preCacheArticles,
  preCacheRssMetadata,
} from "./src/cron.ts";
import { createLogger } from "./src/utils/logger.ts";

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "articles";
  const startedAt = Date.now();

  const env = createVpsEnv();
  const logger = createLogger(env);

  logger.info(`VPS cron started: mode=${mode}`);

  try {
    if (mode === "articles") {
      await preCacheArticles(env);
    } else if (mode === "metadata") {
      await preCacheRssMetadata(env);
    } else {
      logger.error(`Unknown mode: ${mode}. Use "articles" or "metadata"`);
      process.exit(1);
    }
  } catch (e) {
    const err = e as Error;
    logger.error(`VPS cron failed: ${err.message}`, err.stack);
    process.exit(1);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  logger.info(`VPS cron finished: mode=${mode} elapsed=${elapsed}s`);
  // 显式退出，避免 Node.js fetch 的 keep-alive 连接阻止进程退出
  process.exit(0);
}

main();
