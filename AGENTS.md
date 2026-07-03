# AGENTS.md — RSS Translator

## 项目概述

Cloudflare Worker 上的 RSS 翻译代理，支持 LLM 引擎翻译，提供 RSS 元信息翻译 + 正文代理翻译。

```
用户 RSS 阅读器
  │
  ├─ GET /rss?source=bbc-world&token=xxx → 翻译后的 RSS XML
  └─ GET /raw?url=...&source=...&token=xxx → 翻译后的 HTML 文章
```

## 技术栈

- **运行时**: Cloudflare Workers（含 Cron Triggers 定时任务）
- **框架**: Hono v3（导出 `{ fetch, scheduled }` 格式支持 scheduled handler）
- **XML 解析**: fast-xml-parser v4（属性前缀 `@_`，CDATA 通过 `__cdata` 属性标记）
- **HTML 解析**: cheerio v1（CSS 选择器 + JSON-LD 结构化数据）
- **翻译**: DeepSeek API（OpenAI 兼容格式）
- **存储**: Cloudflare KV ×2（`RSS_CONFIG` + `RSS_CACHE`）
- **语言**: TypeScript strict mode

## 常用命令

```bash
pnpm run dev          # wrangler dev 本地开发
pnpm run deploy       # wrangler deploy 部署
pnpm run type-check   # tsc --noEmit 类型检查
npx wrangler tail     # 查看生产日志
```

## 架构

```
src/
├── worker.ts          # Hono 入口，注册路由/中间件，导出 { fetch, scheduled }
├── cron.ts            # Cron 定时任务：预缓存翻译后的文章 HTML
├── types.ts           # 全局类型定义（RssSource, RssConfig, WorkerEnv 等）
├── routes/
│   ├── rss.ts         # GET /rss — 生成翻译后的 RSS
│   └── raw.ts         # GET /raw — 代理并翻译单篇文章（优先 KV 缓存）
├── middleware/
│   └── auth.ts        # Token 鉴权（?token=xxx）
├── services/
│   ├── translate.ts   # 翻译引擎（LLM OpenAI 兼容格式）
│   ├── rss.ts         # RSS XML 解析与生成（fast-xml-parser，CDATA 包裹）
│   └── content.ts     # 文章提取（cheerio + SOURCE_RULES + JSON-LD 降级）
├── storage/
│   └── kv.ts          # KV 读写（文章 HTML 缓存 + 配置读取）
└── utils/
    └── logger.ts      # 日志
```

## KV 结构

| 绑定 | 用途 |
|------|------|
| `RSS_CONFIG` | 环境变量（wrangler.toml vars，JSON 对象），存储 RSS 源列表和配置 |
| `RSS_CACHE` | 文章完整 HTML 缓存 + 文本翻译缓存，key 格式 `cache:article:v1:<url_hash>:ZH`，TTL 7 天 |

### 文章缓存 key 计算

```
url = "https://www.bbc.co.uk/news/articles/xxx?at_medium=RSS&at_campaign=rss"
       ↓  djb2 hash（32-bit 字符串哈希）
hash = "a3f2b1c0"
       ↓
key  = "cache:article:v1:a3f2b1c0:ZH"
```

**注意**: key 使用完整的文章 URL（含查询参数），不是去除参数后的基础 URL。

## RSS 配置结构

```json
{
  "sources": [{
    "id": "bbc-world",
    "name": "BBC World",
    "url": "https://feeds.bbci.co.uk/news/world/rss.xml",
    "title": "BBC 国际新闻",
    "domains": ["bbc.co.uk", "bbc.com"],
    "translate": true,
    "translate_body": true,
    "engines": ["deepseek", "cfllm"]
  }],
  "providers": {
    "deepseek": {
      "endpoint": "https://api.deepseek.com/v1/chat/completions",
      "model": "deepseek-v4-flash"
    },
    "deeplx": {
      "type": "deeplx",
      "endpoint": "https://api.deeplx.org"
    },
    "cfllm": {
      "endpoint": "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1/chat/completions",
      "model": "@cf/zai-org/glm-4.7-flash",
      "api_key_name": "CLOUDFLARE_API_KEY"
    }
  },
  "defaults": {
    "target_lang": "ZH",
    "engines": ["deepseek"],
    "max_articles_per_run": 20
  }
}
```

| 字段 | 说明 |
|------|------|
| `sources[].title` | 可选，自定义 RSS channel title（覆盖原始标题） |
| `sources[].domains` | 文章域名白名单，为空则不限制 |
| `sources[].translate_body` | 是否翻译正文并重写 `<link>` 为代理 URL |
| `sources[].engines` | 翻译 provider 名称数组，按顺序尝试，失败自动流转到下一个 |
| `sources[].engine` | **已废弃**，请使用 `engines` 数组 |
| `providers.{name}.type` | `"deeplx"` / `"cloudflare"` / `"llm"`（默认），决定调用哪种 API |
| `providers.{name}.model` | 模型名，LLM 类型必填；`type: cloudflare` 时模型已在 URL 中可留空 |
| `providers.{name}.api_key_name` | 显式指定 Cloudflare secret 名称，优先级高于默认的 `{NAME}_API_KEY`；多个 provider 可共享同一个 key |
| `providers.{name}.max_input_tokens` | LLM 单次请求最大输入 token 数，超过自动分批 |
| `defaults.max_articles_per_run` | 每次 cron 最多缓存的文章数，默认 10，跨所有 source 合计 |
| `defaults.engines` | 全局默认 provider 链，source 未指定时使用 |

## Cron 定时任务

`wrangler.toml` 配置：`triggers.crons = ["*/10 * * * *"]`

流程：
1. 从 KV 读配置，找到 `translate_body: true` 的 source
2. 拉取 RSS，解析文章列表
3. 逐篇检查 `RSS_CACHE` 是否已有缓存
4. 未缓存 → 抓取原文 → cheerio 提取内容 → LLM 翻译 → 渲染 HTML → 写入 KV
5. 每轮最多处理 `max_articles_per_run` 篇（默认 10），跨 source 共用限额

## 添加新 source

1. 在 `src/services/content.ts` 的 `SOURCE_EXTRACTORS` 中注册提取函数
2. 在 `wrangler.toml` 的 `RSS_CONFIG` 中添加 source 配置

解析器注册示例：
```ts
const SOURCE_EXTRACTORS: Record<string, SourceExtractor> = {
  'bbc-world': { extract: bbcExtract },
  'sciam': { extract: sciamExtract },
  // 未注册的 source 使用 genericExtract 降级
};
```

## RSS XML 生成

- fast-xml-parser 用 `@_` 前缀区分属性和子元素
- `title`、`description`、`link`、`language`、`copyright`、`content` 用 CDATA 包裹（避免 `&`/`'` 等实体转义导致兼容问题）
- `<rss>` 的命名空间声明（`xmlns:media` 等）从原始 RSS 保留
- `format: false` 输出紧凑格式

## 文章提取降级策略

1. **标准文章页**：`[data-block="text"]` + `[data-block="image"]` / `[data-block="video"]` 按顺序提取
2. **视频页**（无 data-block）：从 JSON-LD `VideoObject` 取 thumbnail + description
3. **通用降级**：用 `og:image` + `meta description`，不再乱抓页面全文

## 翻译引擎

- 使用 DeepSeek `deepseek-v4-flash`，OpenAI 兼容 API
- 单文本翻译时不编号，直接返回
- 批量翻译时用 `[1] [2] ...` 格式拼接成一次 API 调用
- 每段文本独立进 KV 缓存（`RSS_CACHE`），跨文章复用
- 翻译失败静默返回原文

## 配置

- 非敏感配置在 `wrangler.toml` `[vars]` 中
- 密钥通过 `npx wrangler secret put` 设置
- 本地开发用 `.env` 文件，`node --env-file=.env` 加载
- 多 provider 共享 key：配置 `api_key_name` 指向同一个 secret 名

## 部署步骤

1. 创建 KV namespace：
   ```bash
   npx wrangler kv namespace create RSS_CACHE
   ```
2. 填入 `wrangler.toml` 的 `[[kv_namespaces]]`
3. 设置 secrets：`ACCESS_TOKEN`、每个 provider 的 `{NAME}_API_KEY`（或通过 `api_key_name` 指向共享 secret）
4. 部署：`pnpm run deploy`
