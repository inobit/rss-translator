# AGENTS.md — RSS Translator

## 项目概述

Cloudflare Worker（免费计划）+ instabox(Docker) box 的 RSS 翻译代理，支持 LLM 引擎翻译。

```
用户 RSS 阅读器
  │
  ├─ GET /rss?source=bbc-world&token=xxx → 翻译后的 RSS XML（KV 成品缓存）
  └─ GET /raw?url=...&source=...&token=xxx → 翻译后的 HTML 文章（KV 成品缓存）

CF Worker（免费计划，纯读 + 极轻转发，不跑 cheerio/LLM）
  │
  ├─ /rss → 纯读 KV 成品 XML → miss 转发 instabox 即时组装 + 后台补译
  ├─ /raw → 纯读 KV 成品 HTML → miss 转发 instabox 即时格式化 + 后台翻译
  └─ /scheduled 每 10min → POST INSTABOX_WAKE_URL?mode=full（纯触发器，不阻塞）
        │
        ▼
instabox box（Docker，Hono HTTP，唯一执行者：cheerio 解析 + LLM 翻译）
  └─ 通过 CF REST API 直写 KV（复用 src/storage/kv-rest.createVpsEnv）
```

> 角色分工：Worker 纯读 + 轻量转发；box 唯一执行解析/翻译；KV 只存「成品」。

## 技术栈

- **HTTP 代理**: Cloudflare Workers（Hono v3，免费计划 10ms CPU，纯读 + 轻量转发）
- **解析 / 翻译执行者**: instabox box（Docker，Node 24 + Hono，唯一跑 cheerio + LLM 的一方）
- **XML 解析**: fast-xml-parser v4（属性前缀 `@_`，CDATA 通过 `__cdata` 属性标记）
- **HTML 解析**: cheerio v1（CSS 选择器 + JSON-LD 结构化数据）
- **翻译**: DeepSeek API（OpenAI 兼容格式）
- **存储**: Cloudflare KV ×2（`RSS_CONFIG` + `RSS_CACHE`），Worker 只读，box 通过 REST API 写
- **语言**: TypeScript strict mode

## 常用命令

```bash
pnpm run dev          # wrangler dev 本地开发
pnpm run deploy       # wrangler deploy 部署
pnpm run type-check   # tsc --noEmit 类型检查
npx wrangler tail     # 查看生产日志
pnpm run box-server   # 本地跑 instabox box（需 .env）
pnpm run build:box    # 编译 box（产物 dist-box/box-server.js）
```

## 架构

```
src/
├── worker.ts          # Hono 入口，注册路由/中间件，导出 { fetch, scheduled }
├── cron.ts            # Cron 逻辑（在线路径残留；box 复用其中翻译拼接思路）
├── types.ts           # 全局类型定义（含 instabox 相关 defaults / env）
├── routes/
│   ├── rss.ts         # GET /rss — 纯读 KV 成品 XML，miss 转 box；相对 link 动态补 origin/token
│   ├── raw.ts         # GET /raw — 纯读 KV 成品 HTML，miss 转 box；域名白名单校验
│   └── refresh.ts     # GET /refresh — 保留但未注册（box 替代）
├── middleware/
│   └── auth.ts        # Token 鉴权（?token=xxx）
├── services/
│   ├── translate.ts   # 翻译引擎（LLM chat completion 主路径）
│   ├── rss.ts         # RSS XML 解析与生成
│   └── content.ts     # 文章提取（cheerio + JSON-LD，box 端使用）
├── storage/
│   ├── kv.ts          # Worker KV 读写（含成品缓存 cache:rssout 读写）
│   └── kv-rest.ts     # box REST API KV 适配器
├── instabox/
│   ├── server.ts      # box Hono HTTP 服务 + Node HTTP bootstrap
│   ├── box-http.ts    # Worker → box 转发工具（无 cheerio/LLM 依赖，供 worker 引用）
│   ├── box-core.ts    # box 核心逻辑：getOrBuildXxx / 翻译缓存 / round-robin / merge
│   └── helpers.ts     # box 工具（fetch、meta 翻译、env）
└── utils/
    └── logger.ts      # 日志
---
box-server.ts          # box server 入口（Node，Node 24 直接跑 TS / vite 打包）
Dockerfile             # box 镜像（构建 dist-box，运行 box-server.js）
docker-compose.yml     # box 编排（挂载 .env）
vite.config.box.ts      # box 打包配置
vite.config.cron.ts     # cron-vps 打包配置（保留，兼容 VPS 旧部署）
```

> 在线 `/rss` `/raw` 仍可用：Worker 纯读成品 + 转发 box。`refresh.ts` / `cron-vps.ts` / `systemd` 保留但为旧 VPS 方案的遗留，不建议再部署。

## KV 结构

| 绑定 | 用途 |
|------|------|
| `RSS_CONFIG` | 环境变量（wrangler.toml vars，JSON 对象），存储 RSS 源列表和配置 |
| `RSS_CACHE` | **只存成品**：文章完整 HTML + 组装好的整份 RSS XML + 元信息缓存，TTL 通过 `defaults.rss_cache_ttl` / `defaults.article_cache_ttl`（天），默认 30 天 |

### 成品缓存 key

```
# 成品 RSS XML（新 key 前缀，box 组装好后整体存，targetLang 纳入 key）
cache:rssout:<targetLang>:<sourceId>

# 成品文章 HTML
cache:article:v1:<sourceId>:<urlHash>:<LANG>

# round-robin 游标
cache:rssout:cursor:global
```

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
    "max_articles_per_run": 20,
    "sources_per_run": 5,
    "articles_per_source": 8,
    "rss_cache_ttl": 30,
    "article_cache_ttl": 30
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
| `defaults.sources_per_run` | instabox 每轮处理的源数量，默认 5 |
| `defaults.articles_per_source` | instabox 每个源每轮处理的文章数量，默认 8 |
| `defaults.engines` | 全局默认 provider 链，source 未指定时使用 |
| `defaults.rss_cache_ttl` | RSS 标题/摘要缓存天数，默认 30 |
| `defaults.article_cache_ttl` | 文章正文缓存天数，默认 30 |

## Cron 定时任务（instabox）

**当前方案：CF Worker cron（免费计划）纯触发 → instabox box 执行。**

- `wrangler.toml [triggers] crons = ["*/10 * * * *"]`
- Worker `scheduled` handler 用 `ctx.waitUntil(fetch(INSTABOX_WAKE_URL?mode=full, { headers: { 'X-Instabox-Token': SECRET } }))` 纯触发，不阻塞、不求响应
- box 收到后后台执行 round-robin：每轮 `sources_per_run` 个源 × 每源 `articles_per_source` 篇，游标在 `RSS_CACHE`（`cache:rssout:cursor:global`），watchdog 60s 到点收尾

### 流程
1. Worker `/scheduled` 唤醒 box（`mode=full`）
2. box 从 KV 读配置，round-robin 选源
3. 拉取 RSS，解析文章，逐篇 `tryMarkArticlePending` 去重（转发与定时同时触达同一 url 时保底）
4. 未缓存 → 抓取原文 → cheerio 提取 → LLM 翻译 → 渲染 HTML → 写 KV 成品
5. 标题/摘要翻译后组装整份成品 RSS XML 写 `cache:rssout:<id>`

> 旧 VPS 方案（`cron-vps.ts` + `systemd/`）保留，但不建议继续部署；`refresh.ts` 同理。

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

- 非敏感配置在 `wrangler.toml` `[vars]` 中（含 `INSTABOX_WAKE_URL` / `INSTABOX_BOX_URL`）
- 密钥通过 `npx wrangler secret put` 设置（`ACCESS_TOKEN`、各 provider `{NAME}_API_KEY`、`INSTABOX_TOKEN`）
- box 运行用 `.env` 文件（含 CF KV + provider key + `INSTABOX_TOKEN`，box 用 docker compose `env_file: .env` 挂载），不要提交真实值
- 多 provider 共享 key：配置 `api_key_name` 指向同一个 secret 名

## 部署步骤（Worker + box）

### Worker
1. 创建 KV namespace：
   ```bash
   npx wrangler kv namespace create RSS_CACHE
   ```
2. 填入 `wrangler.toml` 的 `[[kv_namespaces]]`
3. 设置 secrets：`ACCESS_TOKEN`、每个 provider 的 `{NAME}_API_KEY`、`INSTABOX_TOKEN`
4. `wrangler.toml [vars]` 填 `INSTABOX_WAKE_URL` / `INSTABOX_BOX_URL`（指向 box）
5. 部署：`pnpm run deploy`

### instabox box（Docker）
1. Clone 仓库 + 安装依赖
2. 创建 `.env`（含 `CLOUDFLARE_ACCOUNT_ID` / `CF_KV_API_TOKEN` / `CF_KV_CONFIG_ID` / `CF_KV_CACHE_ID` / 各 provider key / `INSTABOX_TOKEN`）
3. 启动：`docker compose up -d --build`
4. 验证：`curl http://localhost:8788/health`
5. 日志：`docker logs -f rss-instabox`

> box 所需 env 变量清单及说明见 `docs/instabox.md`；实际值放 `.env`（不提交），`.env.example` 仅作模板参考。
