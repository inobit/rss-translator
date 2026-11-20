/**
 * instabox 共用工具
 *  - USER_AGENT / fetchBounded：带超时的 fetch
 *  - buildForwardUrl / makeBoxBytes：Worker → box 转发用的 URL / 字节串构造
 *  - translateMetaTexts：把一批（title, description）翻译合并回 per-source meta 缓存
 *  - requiredBoxEnv：从 process.env 读 box 必需变量
 */

import type { WorkerEnv, RssSource, RssConfig } from '../types';
import { setRssMeta, urlHash } from '../storage/kv';
import { getSourceEngines, resolveProviders, translateTexts } from '../services/translate';
import { createLogger } from '../utils/logger';
import {
  buildForwardUrl,
  makeBoxBytes,
} from './box-http';

export { buildForwardUrl, makeBoxBytes };

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.7827.199 Safari/537.36';

/** 带超时的 fetch */
export async function fetchBounded(
  url: string,
  init: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
  deadline?: number,
): Promise<Response> {
  const budget = deadline ? Math.max(1, Math.min(15_000, deadline - Date.now())) : 15_000;
  const signal = init.signal
    ? (init.signal as AbortSignal)
    : AbortSignal.timeout(budget);
  return fetch(url, { ...init, signal });
}

/** 天 → 秒 */
export function daysToSeconds(days: number): number {
  return days * 24 * 60 * 60;
}

export interface MetaTextData {
  index: number;
  title: string;
  description: string;
}

export interface TranslatedMeta {
  title: string;
  description: string;
}

/**
 * 为一组（title, description）做 LLM 翻译。失败时静默返回原文映射。
 */
export async function translateMetaTexts(
  env: WorkerEnv,
  source: RssSource,
  uncached: MetaTextData[],
  providers: RssConfig['providers'],
  config: {
    targetLang: string;
    llm_prompt?: string;
    max_input_tokens?: number;
    request_interval_ms?: number;
    defaults: { engines?: string[]; engine?: string };
  },
): Promise<TranslatedMeta[]> {
  const logger = createLogger(env);

  const engines = getSourceEngines(source, { engines: config.defaults.engines, engine: config.defaults.engine });
  const resolved = resolveProviders(engines, env, providers);
  const primary = resolved[0] ?? null;
  const fallbacks = resolved.slice(1);
  const llmConfig = primary?.type === 'llm' ? primary.config : undefined;
  const deeplxConfig = primary?.type === 'deeplx' ? primary.config : undefined;
  const cloudflareConfig = primary?.type === 'cloudflare' ? primary.config : undefined;

  if (!llmConfig && !deeplxConfig && !cloudflareConfig) {
    logger.warn(`No resolvable provider for source ${source.id}, keeping originals`);
    return uncached.map(() => ({ title: '', description: '' }));
  }

  const allTexts: string[] = [];
  for (const u of uncached) {
    allTexts.push(u.title);
    allTexts.push(u.description);
  }

  let results: string[];
  try {
    results = await translateTexts({
      engine: primary?.name ?? 'deepseek',
      texts: allTexts,
      targetLang: config.targetLang,
      sourceLang: 'EN',
      env,
      prompt: config.llm_prompt,
      llm: llmConfig,
      deeplx: deeplxConfig,
      cloudflare: cloudflareConfig,
      fallbackProviders: fallbacks.length > 0 ? fallbacks : undefined,
      maxInputTokens: config.max_input_tokens,
      batchDelayMs: config.request_interval_ms,
      // 元信息是短文本：一次塞几百条容易触发响应截断/超时，限制单批条数
      maxBatchItems: 60,
    });
  } catch (e) {
    const err = e as Error;
    // 失败时返回空结果：writeMetaBack 会跳过空条目，让下一轮重试，
    // 避免把原文当成译文写进 30 天缓存后永远不再翻译
    logger.warn(`Meta translation failed: ${err.message}, leaving entries uncached for retry`);
    return uncached.map(() => ({ title: '', description: '' }));
  }

  return uncached.map((u, i) => {
    const title = results[i * 2] || '';
    const description = results[i * 2 + 1] || '';
    // translateTexts 对缺失结果会回填原文；原文==译文说明这一段实际没翻出来，
    // 同样不写缓存，留给下一轮重试
    if (title === u.title && description === u.description) {
      return { title: '', description: '' };
    }
    return {
      title: title || u.title,
      description: description || u.description || '',
    };
  });
}

/** 把翻译结果写回 per-source meta 缓存，并返回更新后的映射（用于 merge 记忆） */
/**
 * 把翻译结果写回 per-source meta 缓存，并返回更新后的映射。
 *
 * entries 是「未缓存条目」的 (link, 翻译) 配对——必须用未缓存条目的原索引取 link，
 * 不能直接按数组位置对应全部 items，否则翻译会写到错误的 urlHash 上。
 * 只有实际新增翻译时才写 KV（避免无谓写消耗 KV 写入配额）。
 */
export async function writeMetaBack(
  env: WorkerEnv,
  sourceId: string,
  entries: { link: string; meta: TranslatedMeta }[],
  memory: Record<string, TranslatedMeta> | null,
  targetLang: string,
  ttl: number,
): Promise<Record<string, TranslatedMeta>> {
  const merged = memory ?? {};
  let changed = 0;
  for (const e of entries) {
    if (!e.link) continue;
    // 翻译失败/未完成的空结果不写入记忆表，下一轮还能重试
    if (!e.meta.title && !e.meta.description) continue;
    merged[urlHash(e.link)] = e.meta;
    changed++;
  }
  if (changed > 0) {
    await setRssMeta(env, sourceId, targetLang, merged, ttl);
  }
  return merged;
}

/** 从 process.env 读取 box 必需变量 */
export function requiredEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`[instabox] Missing required environment variable: ${name}`);
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return val;
}