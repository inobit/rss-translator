import type { TranslateEngine, WorkerEnv, DeeplxResponse, LlmResponse, TranslateProvider } from '../types';
import { createLogger } from '../utils/logger';

export interface LlmProviderConfig {
  endpoint: string;
  model: string;
  apiKey: string;
}

export interface TranslateOptions {
  engine: TranslateEngine;
  texts: string[];
  targetLang: string;
  sourceLang?: string;
  env: WorkerEnv;
  prompt?: string;
  /** 已解析的 LLM provider 配置 */
  llm?: LlmProviderConfig;
  /** 已解析的 deeplx provider 配置 */
  deeplx?: { endpoint: string; apiKey: string };
}

/** 根据 engine 名称和配置解析 provider */
export function resolveProvider(
  engine: string,
  env: WorkerEnv,
  providers?: Record<string, TranslateProvider>,
): { type: 'llm'; config: LlmProviderConfig } | { type: 'deeplx'; endpoint: string; apiKey: string } | null {
  const provider = providers?.[engine];
  if (provider) {
    const secretName = `${engine.toUpperCase()}_API_KEY`;
    const apiKey = env[secretName] as string | undefined;
    if (!apiKey) return null;

    if (provider.type === 'deeplx') {
      return { type: 'deeplx', endpoint: provider.endpoint, apiKey };
    }
    // LLM 类型（默认）
    return {
      type: 'llm',
      config: {
        endpoint: provider.endpoint,
        model: provider.model ?? 'default',
        apiKey,
      },
    };
  }

  // 降级：使用旧版全局环境变量
  if (engine === 'deeplx' && env.DEEPLX_BASE_URL && env.DEEPLX_API_KEY) {
    return { type: 'deeplx', endpoint: env.DEEPLX_BASE_URL as string, apiKey: env.DEEPLX_API_KEY as string };
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

const LLM_PROMPT_TEMPLATE = `将以下英文新闻内容翻译为中文。要求：
- 使用新闻体的专业中文
- 精确传达原意
- 只返回纯文本，不要添加任何 HTML 标签或 Markdown 格式

原文：`;

/**
 * 批量翻译文本，返回与 texts 顺序一致的翻译结果
 * 文章级缓存由 RSS_ARTICLE_CACHE 负责，此处不独立缓存逐段文本
 */
export async function translateTexts(opts: TranslateOptions): Promise<string[]> {
  const { engine, texts, targetLang, sourceLang, env, prompt } = opts;
  const logger = createLogger(env);
  const pendingTexts = texts.filter(t => t);

  if (pendingTexts.length === 0) {
    return texts.map(() => '');
  }

  logger.info(`Translating ${pendingTexts.length} texts via ${engine}`);
  let translatedBatch: string[];

  try {
    if (opts.deeplx) {
      translatedBatch = await translateViaDeeplx(pendingTexts, targetLang, sourceLang, opts.deeplx);
    } else {
      translatedBatch = await translateViaLlm(pendingTexts, targetLang, prompt, opts.llm);
    }
  } catch (e) {
    logger.error('Translation failed, falling back to original text', e);
    translatedBatch = pendingTexts;
  }

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

  const resp = await fetch(provider.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.3,
      max_tokens: 32768,
    }),
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
  const regex = /\[(\d+)\]\s*([\s\S]*?)(?=\[\d+\]|$)/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const idx = parseInt(match[1], 10) - 1;
    const text = match[2].trim();
    results[idx] = text;
  }

  // 如果正则解析失败，降级为整体返回
  if (results.length === 0) {
    return [content.trim()];
  }

  // 补齐缺失的索引
  const output: string[] = [];
  for (let i = 0; i < expectedCount; i++) {
    output.push(results[i] ?? '');
  }

  return output;
}
