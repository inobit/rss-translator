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
  /** 是否使用 OpenAI 兼容流式响应，默认开启；设为 false 回退到普通 JSON */
  stream?: boolean;
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
  /** 是否启用此源，设为 false 后等同于不存在，不会进入翻译逻辑 */
  enabled?: boolean;
  translate: boolean;
  translate_body: boolean;
  /** @deprecated 使用 engines 替代，支持多 provider 按顺序失败自动流转 */
  engine?: TranslateEngine;
  /** 翻译 provider 列表，按顺序尝试，失败自动流转到下一个 */
  engines?: TranslateEngine[];
  /** RSS channel 的 logo 图片 URL，设置后将替换（或添加）channel 级别的 <image> 元素 */
  logo?: string;
  /**
   * 正文本身就在 RSS 的 content:encoded 里（如全文 RSS 镜像站）。
   * 开启后不再抓取原站文章页，直接从 feed 取正文，避免原站反爬。
   */
  fulltext_from_feed?: boolean;
}

/** KV 中存储的全局配置 */
/** 合并 feed（/merge）的元信息与条目标注配置 */
export interface MergeConfig {
  /** channel 标题，默认 "RSS Translator 综合" */
  title?: string;
  /** channel 描述，默认 "整合各源翻译后的 RSS" */
  description?: string;
  /** channel link，默认取首个源链接或空 */
  link?: string;
  /** channel logo 图片 URL（RSS <image>），不设则不输出 image */
  logo?: string;
  /**
   * item 标题前缀模板，`{name}` 替换为源的 title（无则 name）。
   * 默认 "[{name}] "；设为空字符串可关闭前缀。
   */
  title_prefix?: string;
  /** 是否给 item 添加 <category> 标注来源，默认 true */
  add_category?: boolean;
}

export interface RssConfig {
  sources: RssSource[];
  /** 多 provider 配置，key 为 provider 名称 */
  providers?: Record<string, TranslateProvider>;
  /** /merge 合并 feed 配置 */
  merge?: MergeConfig;
  defaults: {
    target_lang: string;
    /** @deprecated 使用 engines 替代 */
    engine?: TranslateEngine;
    /** 默认 provider 列表 */
    engines?: TranslateEngine[];
    /** RSS 缓存天数，默认 30 */
    rss_cache_ttl?: number;
    /** 文章缓存天数，默认 30 */
    article_cache_ttl?: number;
    /** instabox 定时任务每轮处理的源数量，默认 5 */
    sources_per_run?: number;
    /** instabox 定时任务每个源每轮处理的文章数量，默认 8 */
    articles_per_source?: number;
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
  RSS_CACHE: KVNamespace;
  ACCESS_TOKEN: string;
  LOG_LEVEL?: string;
  /** instabox 共享鉴权 token（secret，npx wrangler secret put INSTABOX_TOKEN 设置） */
  INSTABOX_TOKEN?: string;
  /** instabox box 唤醒 URL（secret，npx wrangler secret put INSTABOX_WAKE_URL，值如 https://<box>/run） */
  INSTABOX_WAKE_URL?: string;
  /** instabox box 基础 URL（secret，npx wrangler secret put INSTABOX_BOX_URL，转发用） */
  INSTABOX_BOX_URL?: string;
  /** box 后台任务 watchdog 时长（毫秒）；默认 30 分钟，box .env 可覆盖 */
  BOX_WATCHDOG_MS?: string;
  /** 文章翻译并发度；默认 5，box .env 可覆盖 */
  BOX_ARTICLE_CONCURRENCY?: string;
  [key: string]: unknown;
}

/** Bindings 类型（用于 Hono 类型推导） */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
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
