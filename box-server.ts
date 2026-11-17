/**
 * instabox box HTTP 服务入口（Node 直接运行）
 *
 * 用法：
 *   node --experimental-strip-types box-server.ts
 *
 * 复用 src/instabox/server.ts（createVpsEnv + buildAuthHeaderGuard）。
 *
 * 环境变量（.env）：
 *   CLOUDFLARE_ACCOUNT_ID / CF_KV_API_TOKEN / CF_KV_CONFIG_ID / CF_KV_CACHE_ID
 *   INSTABOX_TOKEN — 共享鉴权 token（与 Worker 的 secret 同值）
 *   INSTABOX_PORT  — 监听端口（默认 8788）
 *   各 provider API key（如 DEEPSEEK_API_KEY）
 */

import { startBoxServer } from "./src/instabox/server.ts";

async function main(): Promise<void> {
  try {
    const { port } = await startBoxServer();
    console.log(`[instabox] box server ready on :${port}`);
  } catch (e) {
    const err = e as Error;
    console.error(`[instabox] failed to start: ${err.message}`);
    process.exit(1);
  }
}

main();