/**
 * 删除指定 source 的所有 article cache
 *
 * 通过 CF KV REST API list 接口匹配前缀，无需解析 RSS 或计算 hash。
 * 自动匹配任意版本号（v1/v2/...）和语言后缀。
 *
 * 用法：
 *   pnpm run clear-article-cache <source-id>
 *
 * 示例：
 *   pnpm run clear-article-cache bbc-world
 *   pnpm run clear-article-cache --dry-run bbc-world   # 仅预览，不删除
 */

import { load } from "js-yaml";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const API_BASE = "https://api.cloudflare.com/client/v4/accounts";
const ARTICLE_CACHE_PREFIX = "cache:article:";

// ====== KV REST API ======

interface ListKeysResponse {
  result: { name: string }[];
  result_info: { count: number; cursor?: string };
  success: boolean;
  errors: unknown[];
}

async function listKeys(
  accountId: string,
  namespaceId: string,
  apiToken: string,
  prefix: string,
  limit: number,
  cursor?: string,
): Promise<ListKeysResponse> {
  let url = `${API_BASE}/${accountId}/storage/kv/namespaces/${namespaceId}/keys?prefix=${encodeURIComponent(prefix)}&limit=${limit}`;
  if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`List keys failed: ${resp.status} ${body}`);
  }
  return resp.json() as Promise<ListKeysResponse>;
}

async function deleteKey(
  accountId: string,
  namespaceId: string,
  apiToken: string,
  key: string,
): Promise<boolean> {
  const url = `${API_BASE}/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(key)}`;
  const resp = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (!resp.ok && resp.status !== 404) {
    console.error(`  ❌ ${key}: ${resp.status} ${await resp.text().catch(() => "")}`);
    return false;
  }
  return true;
}

async function listAllKeys(
  accountId: string,
  namespaceId: string,
  apiToken: string,
  prefix: string,
): Promise<string[]> {
  const allKeys: string[] = [];
  let cursor: string | undefined;
  const pageSize = 1000;

  do {
    const res = await listKeys(accountId, namespaceId, apiToken, prefix, pageSize, cursor);
    if (!res.success) throw new Error(`List keys API error: ${JSON.stringify(res.errors)}`);
    for (const entry of res.result) allKeys.push(entry.name);
    cursor = res.result_info.cursor;
    console.log(`  已列出 ${allKeys.length} 个 key${cursor ? " (还有更多...)" : ""}`);
  } while (cursor);

  return allKeys;
}

// ====== 主流程 ======

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const args = process.argv.filter((a) => !a.startsWith("--"));
  const sourceId = args[2];

  if (!sourceId) {
    console.error("用法: pnpm run clear-article-cache [--dry-run] <source-id>");
    console.error('示例: pnpm run clear-article-cache bbc-world');
    process.exit(1);
  }

  // 1. 验证 source 存在
  const configPath = resolve(import.meta.dirname!, "..", "config.yaml");
  if (!existsSync(configPath)) { console.error("config.yaml not found"); process.exit(1); }
  const raw = load(readFileSync(configPath, "utf8")) as any;
  const source = (raw.sources as any[])?.find((s: any) => s.id === sourceId);
  if (!source) {
    console.error(`Source "${sourceId}" not found in config.yaml`);
    console.error(`可用: ${(raw.sources as any[])?.map((s: any) => s.id).join(", ")}`);
    process.exit(1);
  }

  // 2. 加载凭证
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CF_KV_API_TOKEN;
  const cacheNsId = process.env.CF_KV_CACHE_ID;
  if (!accountId || !apiToken || !cacheNsId) {
    console.error("缺少环境变量: CLOUDFLARE_ACCOUNT_ID, CF_KV_API_TOKEN, CF_KV_CACHE_ID");
    process.exit(1);
  }

  if (dryRun) console.log("🔍 DRY RUN — 仅预览，不删除\n");

  const prefix = `${ARTICLE_CACHE_PREFIX}`;
  console.log(`列出所有 article cache，匹配 source: ${sourceId}\n`);

  // 3. 列出所有 article cache key
  console.log("列出 KV keys...");
  let keys: string[];
  try {
    keys = await listAllKeys(accountId, cacheNsId, apiToken, prefix);
  } catch (e) {
    console.error(`列出失败: ${(e as Error).message}`);
    process.exit(1);
  }

  // 4. 过滤匹配指定 source 的 key（忽略版本号 v1/v2/...）
  const matched = keys.filter((k) => {
    // key 格式: cache:article:{version}:{sourceId}:{hash}:{lang}
    const parts = k.split(":");
    // parts[0]=cache, parts[1]=article, parts[2]=version, parts[3]=sourceId
    return parts.length >= 4 && parts[3] === sourceId;
  });

  if (matched.length === 0) {
    console.log(`\n无匹配的缓存 key（source: ${sourceId}，共扫描 ${keys.length} 个 article key）`);
    process.exit(0);
  }

  console.log(`\n找到 ${matched.length} 个 key（共扫描 ${keys.length} 个 article key）:`);
  matched.forEach((k) => console.log(`  ${k}`));

  if (dryRun) {
    console.log(`\n[DRY RUN] 将删除 ${matched.length} 个 key`);
    process.exit(0);
  }

  // 5. 确认删除
  console.log(`\n⚠ 即将删除 ${matched.length} 个缓存条目`);
  console.log("按 Ctrl+C 取消，或等待 3 秒后自动执行...");
  await new Promise((r) => setTimeout(r, 3000));

  // 6. 批量删除
  let deleted = 0;
  let failed = 0;
  for (const key of matched) {
    const ok = await deleteKey(accountId, cacheNsId, apiToken, key);
    if (ok) deleted++;
    else failed++;
  }

  console.log(`\n删除完成: ${deleted} 成功, ${failed} 失败`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
