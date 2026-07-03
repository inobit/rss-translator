#!/usr/bin/env node

/**
 * 清理 RSS_CACHE 中旧格式的 key
 *
 * 旧格式 (无 sourceId): cache:article:v1:<hash>:<targetLang>  (5 段，suffix 2 段)
 * 新格式 (有 sourceId): cache:article:v1:<sourceId>:<hash>:<targetLang>  (6 段，suffix 3 段)
 *
 * 用法:
 *   node scripts/cleanup-old-kv-cache.mjs [--dry-run] [--batch-size=500]
 */

import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';

const BINDING = 'RSS_CACHE';
const PREFIX = 'cache:article:v1:';
const WRANGLER = 'npx wrangler';

const dryRun = process.argv.includes('--dry-run');
const batchSizeArg = process.argv.find(a => a.startsWith('--batch-size='));
const batchSize = batchSizeArg ? parseInt(batchSizeArg.split('=')[1], 10) : 100;

if (dryRun) {
  console.log('DRY-RUN 模式，不会实际删除\n');
}

let totalScanned = 0;

/** 调用 wrangler，返回 stdout 文本 */
function wrangler(args) {
  const cmd = `${WRANGLER} ${args} --remote`;
  try {
    return execSync(cmd, { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024, stdio: 'pipe' });
  } catch (e) {
    if (args.startsWith('kv key delete') || args.startsWith('kv bulk delete')) {
      console.error(`  命令失败: ${e.message?.slice(0, 300)}`);
      return null;
    }
    throw e;
  }
}

/** 列出所有旧格式 key，返回 key name 数组 */
function findOldFormatKeys() {
  const oldKeys = [];
  let cursor = '';
  let page = 0;

  console.log(`列出 ${BINDING} 中以 "${PREFIX}" 开头的 key...\n`);

  while (true) {
    page++;
    let listArgs = `kv key list --prefix="${PREFIX}" --binding=${BINDING}`;
    if (cursor) listArgs += ` --cursor="${cursor}"`;

    const raw = wrangler(listArgs);
    if (!raw) break;

    try {
      const data = JSON.parse(raw);

      // wrangler 可能返回 { keys: [...], list_complete, cursor } 或直接的数组
      let keys = [];
      let listComplete = true;
      let nextCursor = '';

      if (Array.isArray(data)) {
        keys = data;
        // 数组格式没有分页标识，如果满了 1000 就用最后一个 key 继续
        listComplete = keys.length < 1000;
        nextCursor = keys.length > 0 ? keys[keys.length - 1].name || keys[keys.length - 1] : '';
      } else if (data?.keys) {
        keys = data.keys;
        listComplete = data.list_complete !== false;
        nextCursor = data.cursor || '';
      }

      totalScanned += keys.length;

      for (const k of keys) {
        const name = typeof k === 'string' ? k : k.name;
        const suffix = name.slice(PREFIX.length);
        const parts = suffix.split(':');
        // 旧: <hash>:<targetLang> → 2 段 | 新: <sourceId>:<hash>:<targetLang> → 3 段
        if (parts.length === 2) {
          oldKeys.push(name);
        }
      }

      console.log(`  第 ${page} 页: ${keys.length} 个，累计扫描 ${totalScanned}，旧 key ${oldKeys.length}`);

      if (listComplete || keys.length === 0) break;
      cursor = nextCursor;
    } catch (e) {
      console.error(`  解析失败: ${e.message?.slice(0, 200)}`);
      break;
    }
  }

  return oldKeys;
}

/** 批量删除 key */
function batchDeleteKeys(keys) {
  let deleted = 0;

  for (let i = 0; i < keys.length; i += batchSize) {
    const batch = keys.slice(i, i + batchSize);

    if (dryRun) {
      console.log(`\n[DRY-RUN] 第 ${Math.floor(i / batchSize) + 1} 批 (${batch.length} 个):`);
      batch.forEach(k => console.log(`  ${k}`));
      deleted += batch.length;
    } else {
      const batchFile = `${tmpdir()}/kv-cleanup-${Date.now()}-${i}.json`;
      writeFileSync(batchFile, JSON.stringify(batch), 'utf-8');

      const result = wrangler(`kv bulk delete "${batchFile}" --binding=${BINDING} --force`);
      console.log(`  第 ${Math.floor(i / batchSize) + 1} 批 (${batch.length} 个): ${result?.trim() || 'OK'}`);

      try { unlinkSync(batchFile); } catch {}
      deleted += batch.length;
    }
  }

  return deleted;
}

// ====== 主流程 ======

console.log('=== 清理旧格式 KV 缓存 ===\n');

const oldKeys = findOldFormatKeys();

if (oldKeys.length === 0) {
  console.log('没有找到旧格式的 key，无需清理。');
  process.exit(0);
}

console.log(`\n共找到 ${oldKeys.length} 个旧格式 key\n`);

const deleted = batchDeleteKeys(oldKeys);

if (dryRun) {
  console.log(`\n[DRY-RUN] 将删除 ${deleted} 个 key。移除 --dry-run 参数以实际执行。`);
} else {
  console.log(`\n完成，共删除 ${deleted} 个旧格式 key。`);
}
