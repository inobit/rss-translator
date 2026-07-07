/**
 * Provider 解析与翻译测试脚本
 *
 * 用法：
 *   pnpm run test:provider "The quick brown fox jumps over the lazy dog."
 *   pnpm run test:provider "第一段文本" "第二段文本"
 *   echo "text from pipe" | pnpm run test:provider
 *   pnpm run test:provider    # 交互式输入（Ctrl+D 结束）
 *
 * 从 config.yaml 读取配置、从 .env 读取 API key，
 * 逐 provider 测试 resolve → translate 流程，输出诊断信息。
 */

import { load } from "js-yaml";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { createInterface } from "readline";

/** 翻译 API 请求超时时间（毫秒） */
const TRANSLATE_TIMEOUT_MS = 180_000;

// ====== 类型定义（复制自 types.ts，避免 import 需要 .ts 后缀） ======
interface TranslateProvider {
  type?: "deeplx" | "cloudflare" | "llm";
  endpoint: string;
  model?: string;
  max_input_tokens?: number;
  api_key_name?: string;
}

interface LlmProviderConfig {
  endpoint: string;
  model: string;
  apiKey: string;
  maxInputTokens?: number;
}

interface CloudflareProviderConfig {
  endpoint: string;
  model: string;
  apiKey: string;
}

type ResolvedProvider =
  | { name: string; type: "llm"; config: LlmProviderConfig }
  | { name: string; type: "deeplx"; config: { endpoint: string; apiKey: string } }
  | { name: string; type: "cloudflare"; config: CloudflareProviderConfig };

// ====== 本地实现的 resolveProvider / getSourceEngines / translateTexts ======

function getSourceEngines(
  source: { engines?: string[]; engine?: string },
  defaults?: { engines?: string[]; engine?: string },
): string[] {
  if (source.engines && source.engines.length > 0) return source.engines;
  if (source.engine) return [source.engine];
  if (defaults?.engines && defaults.engines.length > 0) return defaults.engines;
  if (defaults?.engine) return [defaults.engine];
  return ["deeplx"];
}

function resolveProvider(
  engine: string,
  env: Record<string, string | undefined>,
  providers?: Record<string, TranslateProvider>,
): ResolvedProvider | null {
  const provider = providers?.[engine];
  if (provider) {
    const secretName = provider.api_key_name ?? `${engine.replace(/-/g, "_").toUpperCase()}_API_KEY`;
    const apiKey = env[secretName];
    if (!apiKey) return null;

    if (provider.type === "deeplx") {
      return { name: engine, type: "deeplx", config: { endpoint: provider.endpoint, apiKey } };
    }
    if (provider.type === "cloudflare") {
      return {
        name: engine,
        type: "cloudflare",
        config: { endpoint: provider.endpoint, model: provider.model ?? "@cf/meta/m2m100-1.2b", apiKey },
      };
    }
    return {
      name: engine,
      type: "llm",
      config: {
        endpoint: provider.endpoint,
        model: provider.model ?? "default",
        apiKey,
        maxInputTokens: provider.max_input_tokens,
      },
    };
  }

  if (engine === "deeplx" && env.DEEPLX_BASE_URL && env.DEEPLX_API_KEY) {
    return { name: "deeplx", type: "deeplx", config: { endpoint: env.DEEPLX_BASE_URL, apiKey: env.DEEPLX_API_KEY } };
  }
  if (env.LLM_ENDPOINT && env.LLM_API_KEY) {
    return {
      name: engine,
      type: "llm",
      config: {
        endpoint: env.LLM_ENDPOINT,
        model: env.LLM_MODEL ?? "deepseek-v4-flash",
        apiKey: env.LLM_API_KEY,
      },
    };
  }
  return null;
}

function resolveProviders(
  engines: string[],
  env: Record<string, string | undefined>,
  providers?: Record<string, TranslateProvider>,
): ResolvedProvider[] {
  const seen = new Set<string>();
  const result: ResolvedProvider[] = [];
  for (const engine of engines) {
    if (seen.has(engine)) continue;
    seen.add(engine);
    const resolved = resolveProvider(engine, env, providers);
    if (resolved) result.push(resolved);
  }
  return result;
}

// ====== 翻译逻辑 ======

function timestamp(): string {
  return `[${new Date().toISOString()}]`;
}

async function translateViaDeeplx(
  texts: string[],
  targetLang: string,
  sourceLang: string | undefined,
  config: { endpoint: string; apiKey: string },
): Promise<string[]> {
  const results: string[] = [];
  for (const text of texts) {
    const url = `${config.endpoint}/${config.apiKey}/translate`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, target_lang: targetLang, ...(sourceLang ? { source_lang: sourceLang } : {}) }),
      signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`DeepLX translation failed: ${resp.status} ${body.slice(0, 200)}`);
    }

    const data = (await resp.json()) as any;
    if (data.translations && Array.isArray(data.translations)) {
      results.push(data.translations[0]?.text ?? text);
    } else if (typeof data.data === "string") {
      results.push(data.data);
    } else {
      throw new Error(`Unexpected DeepLX response: ${JSON.stringify(data).slice(0, 200)}`);
    }
  }
  return results;
}

const CLOUDFLARE_LANG_MAP: Record<string, string> = {
  ZH: "chinese", EN: "english", JA: "japanese", KO: "korean", FR: "french",
  DE: "german", ES: "spanish", PT: "portuguese", IT: "italian", NL: "dutch", PL: "polish", RU: "russian",
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
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        text,
        source_lang: sourceLang ? (CLOUDFLARE_LANG_MAP[sourceLang] ?? sourceLang.toLowerCase()) : "english",
        target_lang: CLOUDFLARE_LANG_MAP[targetLang] ?? targetLang.toLowerCase(),
      }),
      signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Cloudflare AI translation failed: ${resp.status} ${body.slice(0, 200)}`);
    }
    const data = (await resp.json()) as any;
    if (data.success && data.result?.translated_text) {
      results.push(data.result.translated_text);
    } else {
      throw new Error(`Unexpected Cloudflare AI response: ${JSON.stringify(data).slice(0, 200)}`);
    }
  }
  return results;
}

const LLM_PROMPT = `将以下英文新闻内容翻译为中文。要求：
- 使用新闻体的专业中文
- 精确传达原意
- 只返回纯文本，不要添加任何 HTML 标签或 Markdown 格式

原文：`;

function parseLlmResult(content: string, expectedCount: number): string[] {
  const results: string[] = [];
  const lines = content.split("\n");
  let currentIdx = -1;
  let currentText: string[] = [];

  for (const line of lines) {
    const match = /^\s*\[(\d+)\]\s*(.*)$/.exec(line);
    if (match) {
      if (currentIdx >= 0) results[currentIdx] = currentText.join("\n").trim();
      currentIdx = parseInt(match[1], 10) - 1;
      currentText = [match[2]];
    } else if (currentIdx >= 0) {
      currentText.push(line);
    }
  }
  if (currentIdx >= 0) results[currentIdx] = currentText.join("\n").trim();

  if (results.length === 0 || results.every((r) => r === undefined)) {
    return [content.trim()];
  }
  const output: string[] = [];
  for (let i = 0; i < expectedCount; i++) {
    output.push(results[i] ?? "");
  }
  return output;
}

async function translateViaLlm(
  texts: string[],
  targetLang: string,
  provider?: LlmProviderConfig,
): Promise<string[]> {
  if (!provider?.endpoint || !provider?.apiKey) {
    throw new Error("LLM provider is not configured");
  }

  const isSingle = texts.length === 1;
  const userContent = isSingle
    ? `请将以下内容翻译为${targetLang}，直接返回翻译结果，不要添加任何前缀或说明：\n\n${texts[0]}`
    : `${texts.map((t, i) => `[${i + 1}] ${t}`).join("\n\n")}\n\n请将以上各段分别翻译为${targetLang}，保持编号格式 [1] [2] ... 返回。`;

  const requestBody: Record<string, unknown> = {
    messages: [
      { role: "system", content: LLM_PROMPT },
      { role: "user", content: userContent },
    ],
    temperature: 0.3,
    max_tokens: 32768,
  };
  if (provider.model) requestBody.model = provider.model;

  const resp = await fetch(provider.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`LLM translation failed: ${resp.status} ${body.slice(0, 200)}`);
  }

  const data = (await resp.json()) as any;
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`Unexpected LLM response format: ${JSON.stringify(data).slice(0, 200)}`);
  }
  if (data.choices?.[0]?.finish_reason === "length") {
    console.warn(`${timestamp()} [WARN] LLM response truncated (length limit)`);
  }

  if (isSingle) return [content.trim()];
  return parseLlmResult(content, texts.length);
}

function mapResults(texts: string[], translatedBatch: string[]): string[] {
  const results: string[] = [];
  let pendingIdx = 0;
  for (const text of texts) {
    if (text) {
      results.push(translatedBatch[pendingIdx] ?? text);
      pendingIdx++;
    } else {
      results.push("");
    }
  }
  return results;
}

async function translateTexts(
  engine: string,
  texts: string[],
  targetLang: string,
  opts: {
    sourceLang?: string;
    llm?: LlmProviderConfig;
    deeplx?: { endpoint: string; apiKey: string };
    cloudflare?: CloudflareProviderConfig;
    fallbackProviders?: ResolvedProvider[];
  },
): Promise<string[]> {
  const pendingTexts = texts.filter((t) => t);
  if (pendingTexts.length === 0) return texts.map(() => "");

  if (opts.fallbackProviders && opts.fallbackProviders.length > 0) {
    const chain = [engine, ...opts.fallbackProviders.map((fb) => fb.name)].join(" → ");
    console.log(`${timestamp()} [INFO] Provider chain: ${chain}`);
  }

  console.log(`${timestamp()} [INFO] Translating ${pendingTexts.length} texts via ${engine}`);

  const tryTranslate = async (): Promise<string[]> => {
    if (opts.deeplx) {
      const translated = await translateViaDeeplx(pendingTexts, targetLang, opts.sourceLang, opts.deeplx);
      return mapResults(texts, translated);
    }
    if (opts.cloudflare) {
      const translated = await translateViaCloudflare(pendingTexts, targetLang, opts.sourceLang, opts.cloudflare);
      return mapResults(texts, translated);
    }
    const translated = await translateViaLlm(pendingTexts, targetLang, opts.llm);
    return mapResults(texts, translated);
  };

  try {
    const result = await tryTranslate();
    console.log(`${timestamp()} [INFO] Translated ${pendingTexts.length} texts via ${engine}: done`);
    return result;
  } catch (primaryError) {
    const err = primaryError as Error;
    if (!opts.fallbackProviders || opts.fallbackProviders.length === 0) {
      throw primaryError;
    }
    console.warn(`${timestamp()} [WARN] Primary provider failed: ${err.message}, trying ${opts.fallbackProviders.length} fallback(s)...`);

    let lastError = primaryError;
    for (const fb of opts.fallbackProviders) {
      console.log(`${timestamp()} [INFO] Trying fallback provider "${fb.name}" (${fb.type})`);
      try {
        const fbOpts = {
          ...opts,
          llm: fb.type === "llm" ? fb.config : undefined,
          deeplx: fb.type === "deeplx" ? fb.config : undefined,
          cloudflare: fb.type === "cloudflare" ? fb.config : undefined,
        };
        const result = await translateTexts(fb.name, texts, targetLang, fbOpts);
        console.log(`${timestamp()} [INFO] Fallback provider "${fb.name}" (${fb.type}) succeeded`);
        return result;
      } catch (e) {
        const fbErr = e as Error;
        lastError = fbErr;
        console.warn(`${timestamp()} [WARN] Fallback provider "${fb.name}" (${fb.type}) failed: ${fbErr.message}`);
      }
    }
    throw lastError;
  }
}

// ====== 主流程 ======

async function readInput(): Promise<string[]> {
  const args = process.argv.slice(2);
  if (args.length > 0) return args;

  if (!process.stdin.isTTY) {
    // 管道输入
    const lines: string[] = [];
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) {
      lines.push(line);
    }
    rl.close();
    return lines.length > 0 ? [lines.join("\n")] : [];
  }

  // 交互式 TTY：提示用户输入
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lines: string[] = [];
  console.log("请输入待翻译的英文文本（输入空行结束）:");
  for await (const line of rl) {
    if (line === "") break;
    lines.push(line);
  }
  rl.close();
  return lines.length > 0 ? [lines.join("\n")] : [];
}

async function main() {
  const configPath = resolve(import.meta.dirname!, "..", "config.test.yaml");
  if (!existsSync(configPath)) {
    console.error(`❌ config.yaml not found at ${configPath}`);
    process.exit(1);
  }
  const yaml = load(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const sources = yaml.sources as Array<Record<string, unknown>> | undefined;
  const providers = yaml.providers as Record<string, Record<string, unknown>> | undefined;
  const defaults = yaml.defaults as Record<string, unknown> | undefined;

  const source = sources?.find((s) => s.translate_body);
  if (!source) {
    console.error("❌ No source with translate_body found in config.yaml");
    process.exit(1);
  }

  const env: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(process.env)) {
    env[k] = v;
  }

  const testTexts = await readInput();
  if (testTexts.length === 0 || testTexts.every((t) => !t.trim())) {
    console.error("❌ 未输入待翻译文本");
    console.error("用法: pnpm run test:provider \"your text here\"");
    console.error("      echo \"text\" | pnpm run test:provider");
    process.exit(1);
  }

  console.log("=== Provider 解析测试 ===\n");

  const engines = getSourceEngines(source as any, defaults as any);
  console.log(`Engines: [${engines.join(", ")}]`);

  const resolved = resolveProviders(engines, env, providers as any);
  console.log(`Resolved ${resolved.length} / ${engines.length} providers:`);
  for (const p of resolved) {
    console.log(
      `  ✅ ${p.name.padEnd(12)} type=${p.type.padEnd(10)} endpoint=${(p.config as any).endpoint ?? "N/A"} model=${(p.config as any).model ?? "N/A"}`,
    );
  }

  const missing = engines.filter((e) => !resolved.find((r) => r.name === e));
  if (missing.length > 0) {
    console.log("\n  ❌ 未解析的 engine（API key 缺失或 provider 未配置）:");
    for (const m of missing) {
      const secretName =
        (providers?.[m]?.api_key_name as string) ??
        `${m.replace(/-/g, "_").toUpperCase()}_API_KEY`;
      console.log(`     ${m}: secretName=${secretName} env_has_key=${!!env[secretName]}`);
    }
  }

  if (resolved.length === 0) {
    console.error("\n❌ 没有任何可用的 provider，无法进行翻译测试");
    process.exit(1);
  }

  const primary = resolved[0];
  const fallbacks = resolved.slice(1);

  console.log(`\n=== 翻译测试 (primary: ${primary.name}, type: ${primary.type}) ===`);
  console.log(`\n待翻译文本 (${testTexts.length} 段):`);
  testTexts.forEach((t, i) => {
    const preview = t.length > 200 ? t.slice(0, 200) + "..." : t;
    console.log(`  [${i + 1}] ${preview}`);
  });

  if (primary.type === "deeplx") {
    console.log(`\nDeepLX URL: ${primary.config.endpoint}/${primary.config.apiKey}/translate`);
  }

  try {
    const results = await translateTexts(primary.name, testTexts, "ZH", {
      sourceLang: "EN",
      llm: primary.type === "llm" ? primary.config : undefined,
      deeplx: primary.type === "deeplx" ? primary.config : undefined,
      cloudflare: primary.type === "cloudflare" ? primary.config : undefined,
      fallbackProviders: fallbacks.length > 0 ? fallbacks : undefined,
    });

    console.log("\n✅ 翻译结果:");
    results.forEach((r, i) => console.log(`  [${i + 1}] ${r}`));
  } catch (e) {
    const err = e as Error;
    console.error(`\n❌ 翻译失败: ${err.message}`);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
