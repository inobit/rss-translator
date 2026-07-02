import type { TranslateEngine, WorkerEnv, DeeplxResponse, LlmResponse } from '../types';
import { createLogger } from '../utils/logger';

export interface TranslateOptions {
  engine: TranslateEngine;
  texts: string[];
  targetLang: string;
  sourceLang?: string;
  env: WorkerEnv;
  prompt?: string;
}

const LLM_PROMPT_TEMPLATE = `将以下英文新闻内容翻译为中文。要求：
- 使用新闻体的专业中文
- 精确传达原意
- 保持格式和结构

原文：`;

/**
 * 批量翻译文本，返回与 texts 顺序一致的翻译结果
 * 优先查缓存，未命中的统一请求翻译引擎
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
    if (engine === 'deeplx') {
      translatedBatch = await translateViaDeeplx(pendingTexts, targetLang, sourceLang, env);
    } else {
      translatedBatch = await translateViaLlm(pendingTexts, targetLang, prompt, env);
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
  env: WorkerEnv,
): Promise<string[]> {
  const logger = createLogger(env);
  const url = `${env.DEEPLX_BASE_URL}/${env.DEEPLX_API_KEY}/translate`;

  // DeepLX 只接受单个 text 字符串，逐条翻译
  const results: string[] = [];
  for (const text of texts) {
    const resp = await fetch(url, {
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
      logger.error(`DeepLX request failed: ${resp.status}`, body);
      throw new Error(`DeepLX translation failed: ${resp.status}`);
    }

    const data = (await resp.json()) as DeeplxResponse | { translations: { text: string }[] };

    if ('translations' in data && Array.isArray(data.translations)) {
      results.push(data.translations[0]?.text ?? text);
    } else if ('data' in data && typeof data.data === 'string') {
      results.push(data.data);
    } else {
      logger.error('Unexpected DeepLX response', data);
      throw new Error('Unexpected DeepLX response format');
    }
  }

  return results;
}

async function translateViaLlm(
  texts: string[],
  targetLang: string,
  prompt: string | undefined,
  env: WorkerEnv,
): Promise<string[]> {
  const logger = createLogger(env);

  if (!env.LLM_ENDPOINT || !env.LLM_API_KEY) {
    throw new Error('LLM is not configured (missing LLM_ENDPOINT or LLM_API_KEY)');
  }

  const systemPrompt = prompt ?? LLM_PROMPT_TEMPLATE;
  const isSingle = texts.length === 1;

  const userContent = isSingle
    ? `请将以下内容翻译为${targetLang}，直接返回翻译结果，不要添加任何前缀或说明：\n\n${texts[0]}`
    : `${texts.map((t, i) => `[${i + 1}] ${t}`).join('\n\n')}\n\n请将以上各段分别翻译为${targetLang}，保持编号格式 [1] [2] ... 返回。`;

  const resp = await fetch(env.LLM_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.LLM_MODEL ?? 'deepseek-v4-flash',
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
    logger.error(`LLM request failed: ${resp.status}`, body);
    throw new Error(`LLM translation failed: ${resp.status}`);
  }

  const data = (await resp.json()) as LlmResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    logger.error('Unexpected LLM response', data);
    throw new Error('Unexpected LLM response format');
  }

  if (data.choices?.[0]?.finish_reason === 'length') {
    logger.warn('LLM response truncated (length limit)');
  }

  logger.debug(`LLM raw response: input=${texts.length} texts, output length=${content.length}`);

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
