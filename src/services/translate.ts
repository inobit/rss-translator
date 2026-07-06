import type { TranslateEngine, WorkerEnv, DeeplxResponse, LlmResponse, CloudflareAIResponse, TranslateProvider, LlmProviderConfig, CloudflareProviderConfig, ResolvedProvider } from '../types';
import { createLogger } from '../utils/logger';

/** 翻译 API 请求超时时间（毫秒） */
const TRANSLATE_TIMEOUT_MS = 180_000; // 3 分钟

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export type { LlmProviderConfig, CloudflareProviderConfig, ResolvedProvider };

export interface TranslateOptions {
  /** 主 engine 名称（日志用） */
  engine: TranslateEngine;
  texts: string[];
  targetLang: string;
  sourceLang?: string;
  env: WorkerEnv;
  prompt?: string;
  /** 主 provider（已解析） */
  llm?: LlmProviderConfig;
  deeplx?: { endpoint: string; apiKey: string };
  cloudflare?: CloudflareProviderConfig;
  /** 备用 provider 列表，按顺序尝试，失败自动流转 */
  fallbackProviders?: ResolvedProvider[];
  /** 全局默认最大输入 token 数（provider 级 maxInputTokens 优先） */
  maxInputTokens?: number;
  /** 分批间延迟（毫秒），仅 cron 传入，在线请求不延迟 */
  batchDelayMs?: number;
}

/** 根据 engine 名称和配置解析 provider */
export function resolveProvider(
  engine: string,
  env: WorkerEnv,
  providers?: Record<string, TranslateProvider>,
): { type: 'llm'; config: LlmProviderConfig } | { type: 'deeplx'; config: { endpoint: string; apiKey: string } } | { type: 'cloudflare'; config: CloudflareProviderConfig } | null {
  const provider = providers?.[engine];
  if (provider) {
    const secretName = provider.api_key_name ?? `${engine.replace(/-/g, '_').toUpperCase()}_API_KEY`;
    const apiKey = env[secretName] as string | undefined;
    if (!apiKey) return null;

    if (provider.type === 'deeplx') {
      return { type: 'deeplx', config: { endpoint: provider.endpoint, apiKey } };
    }
    if (provider.type === 'cloudflare') {
      return {
        type: 'cloudflare',
        config: {
          endpoint: provider.endpoint,
          model: provider.model ?? '@cf/meta/m2m100-1.2b',
          apiKey,
        },
      };
    }
    // LLM 类型（默认）
    return {
      type: 'llm',
      config: {
        endpoint: provider.endpoint,
        model: provider.model ?? 'default',
        apiKey,
        maxInputTokens: provider.max_input_tokens,
      },
    };
  }

  // 降级：使用旧版全局环境变量
  if (engine === 'deeplx' && env.DEEPLX_BASE_URL && env.DEEPLX_API_KEY) {
    return { type: 'deeplx', config: { endpoint: env.DEEPLX_BASE_URL as string, apiKey: env.DEEPLX_API_KEY as string } };
  }
  if (env.LLM_ENDPOINT && env.LLM_API_KEY) {
    return {
      type: 'llm',
      config: {
        endpoint: env.LLM_ENDPOINT as string,
        model: (env.LLM_MODEL as string) ?? 'deepseek-v4-flash',
        apiKey: env.LLM_API_KEY as string,
      },
    };
  }
  return null;
}

/** 解析多个 engine 为 provider 列表（去重，跳过无法解析的） */
export function resolveProviders(
  engines: string[],
  env: WorkerEnv,
  providers?: Record<string, TranslateProvider>,
): ResolvedProvider[] {
  const seen = new Set<string>();
  const result: ResolvedProvider[] = [];
  for (const engine of engines) {
    if (seen.has(engine)) continue;
    seen.add(engine);
    const resolved = resolveProvider(engine, env, providers);
    if (resolved) {
      result.push({ name: engine, ...resolved });
    }
  }
  return result;
}

/** 获取 source 的 engines 列表（兼容旧 engine 字段） */
export function getSourceEngines(
  source: { engine?: string; engines?: string[] },
  defaults?: { engine?: string; engines?: string[] },
): string[] {
  if (source.engines && source.engines.length > 0) return source.engines;
  if (source.engine) return [source.engine];
  if (defaults?.engines && defaults.engines.length > 0) return defaults.engines;
  if (defaults?.engine) return [defaults.engine];
  return ['deeplx'];
}

const LLM_PROMPT_TEMPLATE = `将以下英文新闻内容翻译为中文。要求：
- 使用新闻体的专业中文
- 精确传达原意
- 只返回纯文本，不要添加任何 HTML 标签或 Markdown 格式

原文：`;

const DEFAULT_MAX_INPUT_TOKENS = 8192;

/** 粗略估算 token 数（1 字符 ≈ 1 token，对中文准确，对英文安全高估） */
function estimateTokens(text: string): number {
  return text.length;
}

/**
 * 批量翻译文本，返回与 texts 顺序一致的翻译结果
 * 支持多 provider 失败自动流转
 */
export async function translateTexts(opts: TranslateOptions): Promise<string[]> {
  try {
    return await translateTextsInternal(opts);
  } catch (primaryError) {
    if (!opts.fallbackProviders || opts.fallbackProviders.length === 0) {
      throw primaryError;
    }
    const logger = createLogger(opts.env);
    logger.warn(`Primary provider failed: ${(primaryError as Error).message}, trying ${opts.fallbackProviders.length} fallback(s)...`);

    let lastError = primaryError;
    for (const fb of opts.fallbackProviders) {
      logger.info(`Trying fallback provider "${fb.name}" (${fb.type})`);
      try {
        const fbOpts: TranslateOptions = {
          ...opts,
          engine: fb.name,
          llm: fb.type === 'llm' ? fb.config : undefined,
          deeplx: fb.type === 'deeplx' ? fb.config : undefined,
          cloudflare: fb.type === 'cloudflare' ? fb.config : undefined,
          fallbackProviders: undefined, // 防止无限递归
        };
        const result = await translateTextsInternal(fbOpts);
        logger.info(`Fallback provider "${fb.name}" (${fb.type}) succeeded`);
        return result;
      } catch (e) {
        const err = e as Error;
        lastError = err;
        logger.warn(`Fallback provider "${fb.name}" (${fb.type}) failed: ${err.message}`);
      }
    }
    throw lastError;
  }
}

async function translateTextsInternal(opts: TranslateOptions): Promise<string[]> {
  const { engine, texts, targetLang, sourceLang, env, prompt } = opts;
  const logger = createLogger(env);
  const pendingTexts = texts.filter(t => t);

  if (pendingTexts.length === 0) {
    return texts.map(() => '');
  }

  logger.info(`Translating ${pendingTexts.length} texts via ${engine}`);

  if (opts.deeplx) {
    const translatedBatch = await translateViaDeeplx(pendingTexts, targetLang, sourceLang, opts.deeplx);
    const result = mapResults(texts, translatedBatch);
    logger.info(`Translated ${pendingTexts.length} texts via ${engine}: done`);
    return result;
  }

  if (opts.cloudflare) {
    const translatedBatch = await translateViaCloudflare(pendingTexts, targetLang, sourceLang, opts.cloudflare);
    const result = mapResults(texts, translatedBatch);
    logger.info(`Translated ${pendingTexts.length} texts via ${engine}: done`);
    return result;
  }

  const maxTokens = opts.llm?.maxInputTokens ?? opts.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
  const batches: string[][] = [];
  let currentBatch: string[] = [];
  let currentTokens = 0;

  for (const text of pendingTexts) {
    const tokens = estimateTokens(text);
    if (currentBatch.length > 0 && currentTokens + tokens > maxTokens) {
      batches.push(currentBatch);
      currentBatch = [];
      currentTokens = 0;
    }
    currentBatch.push(text);
    currentTokens += tokens;
  }
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  if (batches.length > 1) {
    logger.info(`Split into ${batches.length} batches (max ${maxTokens} input tokens)`);
  }

  const allResults: string[] = [];
  for (let i = 0; i < batches.length; i++) {
    if (i > 0 && opts.batchDelayMs && opts.batchDelayMs > 0) {
      await sleep(opts.batchDelayMs);
    }
    const results = await translateViaLlm(batches[i], targetLang, prompt, opts.llm);
    allResults.push(...results);
  }

  const result = mapResults(texts, allResults);
  logger.info(`Translated ${pendingTexts.length} texts via ${engine}: done`);
  return result;
}

function mapResults(texts: string[], translatedBatch: string[]): string[] {
  const results: string[] = [];
  let pendingIdx = 0;
  for (const text of texts) {
    if (text) {
      results.push(translatedBatch[pendingIdx] ?? text);
      pendingIdx++;
    } else {
      results.push('');
    }
  }
  return results;
}

async function translateViaDeeplx(
  texts: string[],
  targetLang: string,
  sourceLang: string | undefined,
  config: { endpoint: string; apiKey: string },
): Promise<string[]> {
  const results: string[] = [];
  for (const text of texts) {
    const resp = await fetch(`${config.endpoint}/${config.apiKey}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        target_lang: targetLang,
        ...(sourceLang ? { source_lang: sourceLang } : {}),
      }),
      signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const body = await resp.text();
      console.error(`DeepLX request failed: ${resp.status}`, body);
      throw new Error(`DeepLX translation failed: ${resp.status}`);
    }

    const data = (await resp.json()) as DeeplxResponse | { translations: { text: string }[] };

    if ('translations' in data && Array.isArray(data.translations)) {
      results.push(data.translations[0]?.text ?? text);
    } else if ('data' in data && typeof data.data === 'string') {
      results.push(data.data);
    } else {
      console.error('Unexpected DeepLX response', data);
      throw new Error('Unexpected DeepLX response format');
    }
  }

  return results;
}

/** 将内部 LangCode 映射为 Cloudflare AI 翻译 API 要求的语言名称 */
const CLOUDFLARE_LANG_MAP: Record<string, string> = {
  'ZH': 'chinese',
  'EN': 'english',
  'JA': 'japanese',
  'KO': 'korean',
  'FR': 'french',
  'DE': 'german',
  'ES': 'spanish',
  'PT': 'portuguese',
  'IT': 'italian',
  'NL': 'dutch',
  'PL': 'polish',
  'RU': 'russian',
};

async function translateViaCloudflare(
  texts: string[],
  targetLang: string,
  sourceLang: string | undefined,
  config: CloudflareProviderConfig,
): Promise<string[]> {
  const results: string[] = [];
  const url = `${config.endpoint}/${config.model}`;
  for (const text of texts) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        text,
        source_lang: sourceLang ? (CLOUDFLARE_LANG_MAP[sourceLang] ?? sourceLang.toLowerCase()) : 'english',
        target_lang: CLOUDFLARE_LANG_MAP[targetLang] ?? targetLang.toLowerCase(),
      }),
      signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const body = await resp.text();
      console.error(`Cloudflare AI request failed: ${resp.status}`, body);
      throw new Error(`Cloudflare AI translation failed: ${resp.status}`);
    }

    const data = (await resp.json()) as CloudflareAIResponse;

    if (data.success && data.result?.translated_text) {
      results.push(data.result.translated_text);
    } else {
      console.error('Unexpected Cloudflare AI response', data);
      throw new Error('Unexpected Cloudflare AI response format');
    }
  }

  return results;
}

async function translateViaLlm(
  texts: string[],
  targetLang: string,
  prompt: string | undefined,
  provider?: LlmProviderConfig,
): Promise<string[]> {
  if (!provider?.endpoint || !provider?.apiKey) {
    throw new Error('LLM provider is not configured');
  }

  const systemPrompt = prompt ?? LLM_PROMPT_TEMPLATE;
  const isSingle = texts.length === 1;

  const userContent = isSingle
    ? `请将以下内容翻译为${targetLang}，直接返回翻译结果，不要添加任何前缀或说明：\n\n${texts[0]}`
    : `${texts.map((t, i) => `[${i + 1}] ${t}`).join('\n\n')}\n\n请将以上各段分别翻译为${targetLang}，保持编号格式 [1] [2] ... 返回。`;

  const requestBody: Record<string, unknown> = {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0.3,
    max_tokens: 32768,
  };
  if (provider.model) {
    requestBody.model = provider.model;
  }

  const resp = await fetch(provider.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`LLM translation failed: ${resp.status} ${body}`);
  }

  const data = (await resp.json()) as LlmResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Unexpected LLM response format');
  }

  if (data.choices?.[0]?.finish_reason === 'length') {
    console.warn('LLM response truncated (length limit)');
  }

  if (isSingle) {
    return [content.trim()];
  }

  return parseLlmResult(content, texts.length);
}

function parseLlmResult(content: string, expectedCount: number): string[] {
  const results: string[] = [];
  // 按行解析，仅匹配行首的 [N] 标记，避免正文内联引用（如 [2]、[11]）干扰分割
  const lines = content.split('\n');
  let currentIdx = -1;
  let currentText: string[] = [];

  for (const line of lines) {
    const match = /^\s*\[(\d+)\]\s*(.*)$/.exec(line);
    if (match) {
      if (currentIdx >= 0) {
        results[currentIdx] = currentText.join('\n').trim();
      }
      currentIdx = parseInt(match[1], 10) - 1;
      currentText = [match[2]];
    } else if (currentIdx >= 0) {
      currentText.push(line);
    }
  }
  if (currentIdx >= 0) {
    results[currentIdx] = currentText.join('\n').trim();
  }

  // 如果正则解析失败（LLM 未使用 [N] 格式），降级为整体返回
  if (results.length === 0 || results.every(r => r === undefined)) {
    return [content.trim()];
  }

  // 补齐缺失的索引
  const output: string[] = [];
  for (let i = 0; i < expectedCount; i++) {
    output.push(results[i] ?? '');
  }

  return output;
}
