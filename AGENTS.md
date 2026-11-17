# AGENTS.md — RSS Translator

## 项目概述

Cloudflare Worker（免费计划）+ instabox(Docker) box 的 RSS 翻译代理，支持 LLM 引擎翻译。

```
用户 RSS 阅读器
  │
  ├─ GET /rss?source=bbc-world&token=xxx → 翻译后的 RSS XML（KV 成品缓存）
  ├─ GET /raw?url=...&source=...&token=xxx → 翻译后的 HTML 文章（KV 成品缓存）
  └─ GET /merge?token=xxx                     → 所有源合并后的单一 RSS（KV 组装）

CF Worker（免费计划，纯读 + 极轻转发，不跑 cheerio/LLM）
  │
  ├─ /rss → 纯读 KV 成品 XML → miss 转发 instabox 即时组装 + 后台补译
  ├─ /raw → 纯读 KV 成品 HTML → miss 转发 instabox 即时格式化 + 后台翻译
  ├─ /merge → 转发 box 组装各源成品（不拉取、不翻译），补全相对链接
  └─ /scheduled 每 3h → POST INSTABOX_WAKE_URL?mode=full（纯触发器，不阻塞）
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
- **翻译**: 任意 OpenAI 兼容 chat completions API（当前 `ino2api` → `https://ai.ztjt.ltd/v1`）
- **存储**: Cloudflare KV ×2（`RSS_CONFIG` + `RSS_CACHE`），Worker 只读，box 通过 REST API 写
- **语言**: TypeScript strict mode

## 常用命令

```bash
pnpm run dev          # wrangler dev 本地开发
pnpm run deploy       # wrangler deploy 部署 Worker（Git 集成亦可自动部署）
pnpm run type-check   # tsc --noEmit 类型检查
pnpm run lint         # eslint src
pnpm run build:box    # 编译 box（产物 dist-box/box-server.js，自包含单文件）
pnpm run box-server   # 本地跑 box（需 .env）
pnpm run push-config  # 推送 config.yaml 到 RSS_CONFIG KV

# 部署 box（构建 + 推送 dist-box/Dockerfile/docker-compose.yml + 重启）
make deploy-box
make logs / make health / make restart
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
│   ├── merge.ts       # GET /merge — 转发 box 组装合并 feed，补全相对链接
│   ├── link-rewrite.ts # 成品 XML 相对 /raw 链接 → 绝对地址 + token（rss/merge 共用）
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
Dockerfile             # box 镜像（只 COPY 预构建的 dist-box，镜像内不编译）
docker-compose.yml     # box 编排（挂载 .env）
vite.config.box.ts      # box 打包配置
vite.config.cron.ts     # 旧 VPS cron 打包配置（遗留，可删）
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
    "ino2api": {
      "endpoint": "https://ai.ztjt.ltd/v1/chat/completions",
      "model": "rss",
      "max_input_tokens": 32768
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
    "engines": ["ino2api"],
    "sources_per_run": 10,
    "articles_per_source": 100,
    "rss_cache_ttl": 30,
    "article_cache_ttl": 30
  },
  "merge": {
    "title": "RSS 综合阅读",
    "description": "各源翻译后的合并信息流",
    "title_prefix": "[{name}] ",
    "add_category": true
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
| `merge.title` / `merge.description` / `merge.link` | /merge 合并 feed 的 channel 元信息（link 默认取首个源）|
| `merge.logo` | /merge 的 channel 图片，须为图片直链；不配则不输出 `<image>` |
| `merge.title_prefix` | item 标题前缀模板，`{name}` = 源 title，默认 `"[{name}] "`，设 `""` 关闭 |
| `merge.add_category` | 是否给 item 加 `<category>` 标注来源，默认 `true` |
| `defaults.sources_per_run` | instabox 每轮处理的源数量，默认 10 |
| `defaults.articles_per_source` | instabox 每个源每轮处理的文章数量，默认 100 |
| `defaults.engines` | 全局默认 provider 链，source 未指定时使用 |
| `defaults.rss_cache_ttl` | RSS 标题/摘要缓存天数，默认 30 |
| `defaults.article_cache_ttl` | 文章正文缓存天数，默认 30 |

## Cron 定时任务（instabox）

**当前方案：CF Worker cron（免费计划）纯触发 → instabox box 执行。**

- `wrangler.toml [triggers] crons = ["0 */3 * * *"]`（每 3 小时）
- Worker `scheduled` handler 用 `ctx.waitUntil(fetch(INSTABOX_WAKE_URL?mode=full, { headers: { 'X-Instabox-Token': SECRET } }))` 纯触发，不阻塞、不求响应
- box 收到后后台执行 round-robin：每轮 `sources_per_run` 个源 × 每源 `articles_per_source` 篇，游标在 `RSS_CACHE`（`cache:rssout:cursor:global`），watchdog 默认 30 分钟（`BOX_WATCHDOG_MS` 可覆盖）到点收尾

### 流程
1. Worker `/scheduled` 唤醒 box（`mode=full`）
2. box 从 KV 读配置
3. **元信息**：遍历所有 `enabled !== false` 的源（`translate=false` 只刷新成品、不调 LLM）；标题/摘要增量翻译后组装整份 RSS XML，**内容未变则不写 KV**
4. **文章**：round-robin 选 `sources_per_run` 个源 × 每源 `articles_per_source` 篇；`translate_body !== false` 走翻译，`false` 只格式化原文；逐篇 `tryMarkArticlePending` 去重（转发与定时同时触达同一 url 时保底）
5. 未缓存 → 抓取原文 → cheerio 提取 →（按需 LLM 翻译）→ 渲染 HTML → 写 KV 成品

### 开关语义

| 字段 | 含义 |
|------|------|
| `enabled: false` | 完全跳过（不刷新、不抓取）|
| `translate: false` | 不翻译元信息，**但成品仍定时刷新** |
| `translate_body: false` | 不翻译正文，**只格式化并缓存原文 HTML** |

### KV 写入纪律

KV 免费计划仅 1000 写入/天。成品写入前先比较内容，未变则跳过（`writeIfChanged`）；
元信息记忆表也只在有新翻译条目时写。全量无脑重写会直接打满配额。

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

- 走 OpenAI 兼容 chat completions（当前 provider `ino2api`，endpoint `https://ai.ztjt.ltd/v1/chat/completions`，model `rss`）
- 单文本翻译时不编号，直接返回
- 批量翻译时用 `[1] [2] ...` 格式拼接成一次 API 调用；超过 `max_input_tokens` 自动分批
- 元信息翻译结果写入 box 内部记忆表 `cache:rss:<v3>:<sourceId>:<LANG>`（worker 不读）
- 翻译失败（5xx/超时）静默降级为原文，不阻塞后续
- 非流式（`stream` 未启用），等完整 JSON 返回

## 配置

- Worker 只有 `LOG_LEVEL` 写在 `wrangler.toml` `[vars]`；`INSTABOX_WAKE_URL` / `INSTABOX_BOX_URL` / `INSTABOX_TOKEN` / `ACCESS_TOKEN` **全部用 secret**（`npx wrangler secret put`）。原因：`wrangler deploy` 会用 `[vars]` 完整替换 Worker 普通变量（Dashboard 手动加的 var 会被清），而 secret 不受影响、且不落仓库
- 密钥通过 `npx wrangler secret put` 或 Dashboard 设置（`ACCESS_TOKEN`、`INSTABOX_TOKEN`、各 provider `{NAME}_API_KEY`）
- box 运行用 `.env` 文件（CF KV + provider key + `INSTABOX_TOKEN`，docker compose `env_file: .env` 挂载），不要提交真实值
- `/merge` 的 channel logo 由 `config.merge.logo` 指定（图片直链）；未配则不输出 `<image>`
- 多 provider 共享 key：配置 `api_key_name` 指向同一个 secret 名

## 部署步骤（Worker + box）

### Worker
1. 创建 KV namespace（首次）：
   ```bash
   npx wrangler kv namespace create RSS_CACHE
   ```
2. 填入 `wrangler.toml` 的 `[[kv_namespaces]]`
3. 设置 secrets：`ACCESS_TOKEN`、`INSTABOX_TOKEN`、provider 的 `{NAME}_API_KEY`
4. Dashboard 设置 vars：`INSTABOX_WAKE_URL`（`https://<box-url>/run`）、`INSTABOX_BOX_URL`（`https://<box-url>`）
5. 部署：push 到 `feature/instabox` 由 Git 集成自动部署，或 `pnpm run deploy`

### instabox box（Docker，只跑预构建产物）
1. 创建 box：`instabox create --name general --user inobit`
2. 在 box 的 `BOX_DIR`（默认 `/data/home/rss-translator`）放 `.env`
3. 本地 `make deploy-box`：构建 `dist-box/` → tar 流推送 `dist-box Dockerfile docker-compose.yml` → `docker compose up -d --build`
4. 暴露端口：`instabox port publish general 8788`
5. 验证：`make health`；日志：`make logs`

> box 镜像只 `COPY dist-box`，不在镜像内编译，重建秒级。
> box 所需 env 变量清单见 `docs/instabox.md`；实际值放 `.env`（不提交）。
