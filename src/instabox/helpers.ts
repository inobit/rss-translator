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
    });
  } catch (e) {
    const err = e as Error;
    logger.warn(`Meta translation failed: ${err.message}, keeping originals`);
    return uncached.map((u) => ({ title: u.title, description: u.description }));
  }

  return uncached.map((u, i) => {
    const title = results[i * 2] || u.title;
    const description = results[i * 2 + 1] || u.description || '';
    return { title, description };
  });
}

/** 把翻译结果写回 per-source meta 缓存，并返回更新后的映射（用于 merge 记忆） */
export async function writeMetaBack(
  env: WorkerEnv,
  sourceId: string,
  links: string[],
  translated: TranslatedMeta[],
  memory: Record<string, TranslatedMeta> | null,
  targetLang: string,
  ttl: number,
): Promise<Record<string, TranslatedMeta>> {
  const merged = memory ?? {};
  for (let i = 0; i < translated.length; i++) {
    const link = links[i];
    if (!link) continue;
    merged[urlHash(link)] = translated[i];
  }
  await setRssMeta(env, sourceId, targetLang, merged, ttl);
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