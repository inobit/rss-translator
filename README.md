# RSS Translator

Cloudflare Worker 上的 RSS 翻译代理：Worker 纯读 KV 成品，instabox box（Docker）负责解析与 LLM 翻译。

兼容 Cloudflare 免费计划（10ms CPU）：Worker 不做 cheerio/LLM，重活全部交给 box。

## 使用

```
GET /rss?source=bbc-world&token=<ACCESS_TOKEN>          → 翻译后的 RSS XML
GET /raw?url=...&source=bbc-world&token=<ACCESS_TOKEN>  → 翻译后的文章 HTML
GET /merge?token=<ACCESS_TOKEN>                          → 所有源合并后的单一 RSS
```

把 `/rss` 链接导入任意 RSS 阅读器即可；想一个 feed 看全部源就用 `/merge`。
`token` 即 Worker 的 `ACCESS_TOKEN` secret。

### /merge 合并 feed

纯读各源成品组装（不现场拉取、不触发翻译），按 `pubDate` 倒序：

- channel 元信息由 `config.merge` 控制（`title` / `description` / `link` / `logo`）
- 每条 item 标题加来源前缀（默认 `[{name}] `），并附加 `<category>` 标注来源
- channel logo 由 `config.merge.logo` 指定（须为图片直链）；不配则不输出 `<image>`
- 各源的命名空间声明（`media:` / `dc:` / `content:` 等）自动汇总，保证 XML 合法

## 架构

```
用户 RSS 阅读器
  │
  ├─ GET /rss  → 读 KV 成品 XML（命中即返回，相对链接补 origin/token）
  │              miss → 转发 box 即时组装（未翻译）+ 后台补译
  ├─ GET /raw  → 读 KV 成品 HTML（命中即返回）
  │              miss → 转发 box 即时格式化 + 后台翻译
  │
CF Worker（免费计划，纯读 + 轻量转发）
  │
  └─ cron */10min → POST <INSTABOX_WAKE_URL>?mode=full（纯触发器，202 即返回）
        │
        ▼
instabox box（Docker，唯一执行者：cheerio 解析 + LLM 翻译）
  ├─ POST /run?mode=full|meta|articles   定时任务，round-robin
  ├─ GET  /forward/meta?source=          单源 RSS 即时组装
  ├─ GET  /forward/article?url=&source=  单篇正文即时格式化
  ├─ GET  /merge                         合并各源成品（只读组装）
  └─ 通过 CF REST API 直写 KV
```

KV 只存「成品」：

| key | 内容 |
|-----|------|
| `cache:rssout:<LANG>:<sourceId>` | 整份组装好的 RSS XML |
| `cache:article:v1:<sourceId>:<hash>:<LANG>` | 渲染好的文章 HTML |
| `cache:rss:<v3>:<sourceId>:<LANG>` | box 内部翻译记忆（worker 不读） |
| `cache:rssout:cursor:global` | round-robin 游标 |

## 定时任务

CF Worker cron 每 10 分钟纯触发 box（`POST /run?mode=full`），box 立即返回 202 并在后台执行：

- round-robin 选源：每轮 `sources_per_run`（默认 5）个源 × 每源 `articles_per_source`（默认 8）篇
- 增量：已缓存（`getArticleCache` 命中）或已在处理（`tryMark*Pending`）直接跳过
- watchdog 60s：到点停止拉取新内容，已完成的写入 KV
- 游标仅在整轮跑完时推进；被 watchdog 中断则保留，下轮重新覆盖

翻译失败（上游 5xx/超时）静默降级为原文，不阻塞后续。

源开关语义：

| 字段 | 含义 |
|------|------|
| `enabled: false` | 完全跳过 |
| `translate: false` | 不翻译标题/摘要，成品仍定时刷新 |
| `translate_body: false` | 不翻译正文，只格式化缓存原文 |

成品写入前会比较内容，未变则跳过 —— KV 免费计划只有 1000 写入/天，全量重写会打满配额。

## 配置

编辑 `config.yaml` 后推送 KV：

```bash
make push-config      # 或 pnpm run push-config
```

```yaml
defaults:
  engines: [ino2api]        # provider 链，按顺序尝试，失败流转
  target_lang: ZH
  sources_per_run: 5        # 每轮处理的源数
  articles_per_source: 8    # 每源每轮文章数
  max_input_tokens: 8192    # LLM 单次请求最大输入 token，超过自动分批
  request_interval_ms: 300  # 批次间延迟
  rss_cache_ttl: 30         # 天
  article_cache_ttl: 30     # 天

llm_prompt: |               # 可选，覆盖内置翻译 prompt
  ...

merge:                      # 可选，/merge 合并 feed 配置
  title: RSS 综合阅读
  description: 各源翻译后的合并信息流
  # link: https://example.com       # 默认取首个源的 channel link
  logo: https://example.com/x.png   # 须为图片直链；不配则不输出 <image>
  title_prefix: "[{name}] "         # item 标题前缀，{name}=源 title；设 "" 关闭
  add_category: true                 # item 加 <category> 标注来源

providers:
  ino2api:
    endpoint: https://ai.ztjt.ltd/v1/chat/completions
    model: rss
    max_input_tokens: 32768

sources:
  - id: bbc-world
    name: BBC World
    url: https://feeds.bbci.co.uk/news/world/rss.xml
    title: BBC 国际新闻
    domains: [bbc.co.uk, bbc.com]   # 文章域名白名单
    translate: true                 # 翻译标题/摘要
    translate_body: true            # 翻译正文并改写 link 为代理 URL
```

| 字段 | 说明 |
|------|------|
| `sources[].translate` | 翻译 RSS 标题/摘要 |
| `sources[].translate_body` | 翻译正文并将 `<link>` 改写为 `/raw` 代理 URL |
| `sources[].domains` | 文章域名白名单，为空不限制 |
| `sources[].engines` | 覆盖 `defaults.engines` |
| `providers.{name}.type` | `"llm"`（默认）/ `"deeplx"` / `"cloudflare"` |
| `providers.{name}.api_key_name` | 指定 secret 名，默认 `{NAME}_API_KEY` |

## 部署

### Worker

已配置 Cloudflare Git 集成（分支 `feature/instabox`），push 即自动构建部署（`npx wrangler deploy`）。
也可本地手动部署：

```bash
make deploy-worker     # pnpm run deploy
```

**Secrets**（Dashboard 或 `npx wrangler secret put`）：

| 名称 | 用途 |
|------|------|
| `ACCESS_TOKEN` | 客户端访问 `/rss` `/raw` `/merge` 的 token |
| `INSTABOX_TOKEN` | Worker → box 的共享鉴权 token（与 box `.env` 同值） |
| `INSTABOX_WAKE_URL` | box 唤醒地址 `https://<box-url>/run` |
| `INSTABOX_BOX_URL` | box 基础地址 `https://<box-url>`（转发用）|

全部用 secret 存放（不放 `wrangler.toml`，避免进仓库，也不会被 `wrangler deploy` 的 `[vars]` 同步覆盖）：

```bash
npx wrangler secret put ACCESS_TOKEN
npx wrangler secret put INSTABOX_TOKEN
npx wrangler secret put INSTABOX_WAKE_URL   # https://<box-url>/run
npx wrangler secret put INSTABOX_BOX_URL    # https://<box-url>
```

> 换成 var 的话，`wrangler deploy` 会用 `[vars]` 完整替换 Worker 变量，Dashboard 手动加的普通变量会被清掉；secret 不受影响。

### instabox box

box 只运行预构建产物，不需要源码。

```bash
# 1. 创建 box（首次）
instabox create --name general --user inobit

# 2. 准备 .env（放到 box 的 BOX_DIR，参考 .env.example）
#    含 CF KV 凭据 + provider key + INSTABOX_TOKEN

# 3. 构建并部署（本地构建 → 推送 dist-box/Dockerfile/docker-compose.yml → 重启）
make deploy-box

# 4. 暴露端口拿公网 URL
instabox port publish general 8788
```

`make deploy-box` 做的事：
1. `pnpm run build:box` → `dist-box/box-server.js`（vite SSR 自包含单文件）
2. 打包 `dist-box Dockerfile docker-compose.yml` 用 tar 流推送到 box 的 `BOX_DIR`
3. `docker compose up -d --build`（镜像只 COPY 产物，秒级重建）

日常运维：

```bash
make logs       # docker logs -f
make health     # curl /health
make restart    # 仅重启容器
```

### box 环境变量

见 `.env.example`（模板）与 `docs/instabox.md`。实际值放 box 的 `.env`，**不要提交**。

关键项：
```
CLOUDFLARE_ACCOUNT_ID / CF_KV_API_TOKEN / CF_KV_CONFIG_ID / CF_KV_CACHE_ID
INSTABOX_TOKEN / INSTABOX_PORT=8788
INO2API_API_KEY
```

`CF_KV_API_TOKEN` 需在 Cloudflare Dashboard 创建自定义 API Token：
**Developer Platform → Workers KV Storage → Edit**，Account Resources 选账户（不要限定到某个 Worker，否则无 KV 权限）。

## 本地开发

```bash
pnpm install
pnpm run dev            # wrangler dev（Worker）
pnpm run box-server     # 本地跑 box（需 .env）
pnpm run type-check
pnpm run lint
```

## 支持的 Source

| source | 说明 | RSS |
|---|---|---|
| `bbc-world` | BBC 国际新闻 | `https://feeds.bbci.co.uk/news/world/rss.xml` |
| `guardian-ai` | 卫报 AI | `https://www.theguardian.com/technology/artificialintelligenceai/rss` |
| `guardian-china` | 卫报 中国 | `https://www.theguardian.com/world/china/rss` |
| `theregister-ai` | The Register AI/ML | `https://www.theregister.com/software/ai_ml/headlines.atom` |
| `tds` | Towards Data Science | `https://towardsdatascience.com/feed/` |
| `simonw` | Simon Willison's Blog | `https://simonwillison.net/atom/everything/` |
| `news-cn` | 新华社（中文，不翻译） | `https://plink.anyfeeder.com/newscn/whxw` |

未注册的 source 使用通用提取器降级处理。

## 发版

打 tag 触发 GitHub Actions，构建 box server 产物并发布 Release：

```bash
# tag 版本必须与 package.json version 一致
git tag v0.2.0
git push origin v0.2.0
```

workflow 流程：版本一致性校验 → `pnpm build:box` → 打包 → 创建 GitHub Release。

**Release 内容 = box server 部署包**（Worker 由 `wrangler deploy` 从源码构建，不进 Release）：

```
rss-box-server-v0.2.0.tar.gz
├── dist-box/box-server.js   # 自包含产物，vite SSR 打包，仅外置 node 内置模块
├── Dockerfile               # 只 COPY dist-box，镜像内不编译
├── docker-compose.yml       # 编排（env_file: .env）
├── .env.example             # 环境变量模板
└── README.txt               # box 部署步骤
```

box 从 Release 部署（无需源码，也无需在 box 内编译）：

```bash
# 本机下载并推到 box
curl -LO https://github.com/inobit/rss-translator/releases/download/v0.2.0/rss-box-server-v0.2.0.tar.gz
tar -czf - -C /tmp rss-box-server | instabox exec general --stdin -- \
  'mkdir -p /data/home/rss-translator && tar -xzf - -C /data/home/rss-translator --strip-components=1'

# 或者日常用 make（从当前仓库构建 + 推送）
make deploy-box
```
