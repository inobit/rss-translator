/// <reference types="@cloudflare/workers-types" />

/** 翻译引擎类型（deeplx 或任意 LLM provider 名称） */
export type TranslateEngine = string;

/** Provider 配置 */
export interface TranslateProvider {
  /** API 类型：deeplx、cloudflare 或 OpenAI 兼容 LLM */
  type?: 'deeplx' | 'cloudflare' | 'llm';
  endpoint: string;
  /** LLM / cloudflare 需要，deeplx 不需要；留空则不在请求体中发送 model（如模型已在 URL 中） */
  model?: string;
  /** LLM 单次请求最大输入 token 数，超过则分批（默认 8192） */
  max_input_tokens?: number;
  /**
   * 显式指定 Cloudflare secret 名称，优先级高于默认的 {ENGINE_NAME}_API_KEY
   * 用于多个 provider 共享同一个 API key
   */
  api_key_name?: string;
}

/** LLM provider 解析后的配置 */
export interface LlmProviderConfig {
  endpoint: string;
  model: string;
  apiKey: string;
  maxInputTokens?: number;
}

/** Cloudflare provider 解析后的配置 */
export interface CloudflareProviderConfig {
  endpoint: string;
  model: string;
  apiKey: string;
}

/** 解析后的 provider，已注入 API key */
export type ResolvedProvider =
  | { name: string; type: 'llm'; config: LlmProviderConfig }
  | { name: string; type: 'deeplx'; config: { endpoint: string; apiKey: string } }
  | { name: string; type: 'cloudflare'; config: CloudflareProviderConfig };

/** 翻译语言代码 */
export type LangCode = 'ZH' | 'EN' | 'JA' | 'KO' | 'FR' | 'DE' | 'ES' | 'PT' | 'IT' | 'NL' | 'PL' | 'RU';

/** 单个 RSS 源配置 */
export interface RssSource {
  id: string;
  name: string;
  url: string;
  /** 自定义 RSS 标题，设置后将替换原始 RSS 的 channel title */
  title?: string;
  /** 允许代理的文章域名白名单，为空则不限制（纯 token 验证） */
  domains?: string[];
  translate: boolean;
  translate_body: boolean;
  /** @deprecated 使用 engines 替代，支持多 provider 按顺序失败自动流转 */
  engine?: TranslateEngine;
  /** 翻译 provider 列表，按顺序尝试，失败自动流转到下一个 */
  engines?: TranslateEngine[];
}

/** KV 中存储的全局配置 */
export interface RssConfig {
  sources: RssSource[];
  /** 多 provider 配置，key 为 provider 名称 */
  providers?: Record<string, TranslateProvider>;
  defaults: {
    target_lang: string;
    /** @deprecated 使用 engines 替代 */
    engine?: TranslateEngine;
    /** 默认 provider 列表 */
    engines?: TranslateEngine[];
    /** 翻译缓存天数，默认 30 */
    cache_ttl_days?: number;
    /** 每次 cron 运行最多预缓存的文章数，默认 10 */
    max_articles_per_run?: number;
    /** 全局默认 LLM 单次请求最大输入 token 数（provider 级优先，默认 8192） */
    max_input_tokens?: number;
    /** cron 任务中 LLM API 调用间的最小间隔（毫秒），仅 cron 生效，在线请求不延迟 */
    request_interval_ms?: number;
  };
  llm_prompt?: string;
}

/** Worker 环境变量 */
export interface WorkerEnv {
  RSS_CONFIG: KVNamespace;
  RSS_ARTICLE_CACHE: KVNamespace;
  ACCESS_TOKEN: string;
  LOG_LEVEL?: string;
  [key: string]: unknown;
}

/** Bindings 类型（用于 Hono 类型推导） */
export interface Bindings extends WorkerEnv {}

/** 翻译结果 */
export interface TranslateResult {
  translations: { detected_source_language?: string; text: string }[];
}

/** DeepLX 自定义响应格式 */
export interface DeeplxResponse {
  code: number;
  message?: string;
  data?: string;
  alternatives?: string[];
}

/** Cloudflare AI 翻译响应格式 */
export interface CloudflareAIResponse {
  result: {
    translated_text: string;
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  };
  success: boolean;
  errors: unknown[];
  messages: unknown[];
}

/** LLM chat completion 消息 */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmChoice {
  message: { content: string };
  finish_reason?: string;
}

export interface LlmResponse {
  choices: LlmChoice[];
}

/** RSS item 解析结果 */
export interface ParsedRssItem {
  title: string;
  description: string;
  link: string;
  content?: string;
  pubDate?: string;
  guid?: string;
  [key: string]: unknown;
}

/** RSS channel 解析结果 */
export interface ParsedRssChannel {
  title: string;
  description: string;
  link: string;
  language?: string;
  items: ParsedRssItem[];
  [key: string]: unknown;
}

/** RSS 解析后的完整对象 */
export interface ParsedRss {
  channel: ParsedRssChannel;
  /** <rss> 或 <rdf:RDF> 元素上的属性（命名空间声明、version 等） */
  rssAttrs?: Record<string, unknown>;
}
