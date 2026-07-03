#!/usr/bin/env node

/**
 * 将 RSS_CACHE 中旧格式 key 迁移为新格式（加入 sourceId）
 *
 * 旧: cache:article:v1:<hash>:<targetLang>
 * 新: cache:article:v1:<sourceId>:<hash>:<targetLang>
 *
 * 策略：遍历所有 source 的 RSS，对每篇文章算 hash，
 * 如果旧 key 存在则读出值写到新 key 并删旧 key。
 */

import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { XMLParser } from 'fast-xml-parser';

const BINDING_CONFIG = 'RSS_CONFIG';
const BINDING_CACHE = 'RSS_CACHE';
const PREFIX = 'cache:article:v1:';
const WRANGLER = 'npx wrangler';

/** 调用 wrangler CLI，非 get 命令异常时抛出，get 的 404 静默返回 null */
function wrangler(args, opts) {
  const cmd = `${WRANGLER} ${args} --remote`;
  try {
    return execSync(cmd, { encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024, stdio: 'pipe', ...opts });
  } catch (e) {
    // kv key get 找不到 key 时会 exit 1，静默处理
    if (args.startsWith('kv key get')) return null;
    throw e;
  }
}

/** djb2 hash */
function hashString(s) {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

// ---------- RSS/Atom 解析（与 src/services/rss.ts 一致） ----------

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: { enabled: true, maxTotalExpansions: 100000 },
});

function normalizeItems(item) {
  if (!item) return [];
  if (Array.isArray(item)) return item;
  return [item];
}

function extractAtomLink(links) {
  const linkList = normalizeItems(links);
  for (const link of linkList) {
    if (typeof link === 'string') return link;
    const href = link?.['@_href'];
    const rel = link?.['@_rel'];
    if (href && (!rel || rel === 'alternate')) return href;
  }
  for (const link of linkList) {
    if (typeof link !== 'string') {
      const href = link?.['@_href'];
      if (href) return href;
    }
  }
  return '';
}

/** 从 RSS/Atom XML 中提取所有文章链接 */
function extractLinks(xml) {
  const links = [];
  try {
    const parsed = parser.parse(xml);

    // RSS 2.0 / RDF
    const rss = parsed.rss ?? parsed['rdf:RDF'];
    if (rss?.channel) {
      const items = normalizeItems(rss.channel.item);
      for (const item of items) {
        if (item.link) links.push(item.link);
      }
    }

    // Atom feed
    if (parsed.feed) {
      const entries = normalizeItems(parsed.feed.entry);
      for (const entry of entries) {
        const link = extractAtomLink(entry.link);
        if (link) links.push(link);
      }
    }
  } catch {
    // 解析失败，忽略
  }
  return links;
}

// ---------- 主流程 ----------

// 1. 读取配置
console.log('读取配置...');
const configRaw = wrangler(`kv key get config --binding=${BINDING_CONFIG} --text`);
const config = JSON.parse(configRaw);
const targetLang = config.defaults?.target_lang ?? 'ZH';
const sources = config.sources.filter(s => s.translate_body);

console.log(`找到 ${sources.length} 个 translate_body 的 source\n`);

let totalFound = 0;
let totalChecked = 0;

// 2. 遍历每个 source，解析 RSS 获取文章链接，检查旧 key 并迁移
for (const source of sources) {
  console.log(`处理 ${source.id}: ${source.url}`);
  try {
    const resp = await fetch(source.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSS-Translator/1.0)' },
    });
    if (!resp.ok) {
      console.log(`  获取 RSS 失败: ${resp.status}\n`);
      continue;
    }

    const xml = await resp.text();
    const links = extractLinks(xml);

    console.log(`  解析到 ${links.length} 篇文章`);
    totalChecked += links.length;

    let found = 0;
    for (const url of links) {
      const hash = hashString(url);
      const oldKey = `${PREFIX}${hash}:${targetLang}`;
      const newKey = `${PREFIX}${source.id}:${hash}:${targetLang}`;

      // 检查旧 key 是否存在（404 时 wrangler 返回 null）
      const value = wrangler(`kv key get "${oldKey}" --binding=${BINDING_CACHE} --text`);
      if (!value || value.startsWith('Could not find')) continue;

      // 写新 key（通过临时文件传值，避免命令行长度限制）
      const tmpFile = `${tmpdir()}/kv-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
      writeFileSync(tmpFile, value, 'utf-8');
      execSync(
        `${WRANGLER} kv key put "${newKey}" --binding=${BINDING_CACHE} --path="${tmpFile}" --remote`,
        { encoding: 'utf-8', maxBuffer: 20 * 1024 * 1024, stdio: 'pipe' },
      );
      unlinkSync(tmpFile);

      // 验证新 key 有值，然后删旧 key
      const verify = wrangler(`kv key get "${newKey}" --binding=${BINDING_CACHE} --text`);
      if (verify && !verify.startsWith('Could not find')) {
        wrangler(`kv key delete "${oldKey}" --binding=${BINDING_CACHE}`);
        found++;
        totalFound++;
      }
    }
    console.log(`  迁移 ${found} 条\n`);
  } catch (e) {
    console.log(`  出错: ${e.message?.slice(0, 120)}\n`);
  }
}

console.log(`完成，共检查 ${totalChecked} 篇文章，迁移 ${totalFound} 条`);
