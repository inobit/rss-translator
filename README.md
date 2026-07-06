# RSS Translator

Cloudflare Worker 上的 RSS 翻译代理，支持多 LLM provider 翻译。免费计划兼容：VPS 定时预缓存翻译，Worker 纯读缓存。

## 使用

```
GET /rss?source=bbc-world&token=<TOKEN>      → 翻译后的 RSS XML
GET /raw?url=...&source=...&token=<TOKEN>    → 翻译后的文章 HTML
```

将 `/rss` 链接导入任意 RSS 阅读器即可。

## 定时缓存

> **注意**：定时任务已从 Cloudflare Cron Triggers 迁移至 VPS（systemd timer），
> 免费计划 CPU 10ms 限制下 cron 无法完成翻译。升级到 Workers Paid 后可恢复使用 CF cron。

通过 VPS systemd timer 定时预翻译，写入 CF KV：

| Timer                     | 频率      | 任务                       |
|---------------------------|-----------|----------------------------|
| `rss-cron-articles.timer` | 每 10 分钟 | 预缓存文章正文（translate_body 为 true 的 source） |
| `rss-cron-meta.timer`     | 每小时    | 预缓存 RSS 标题和摘要（translate 为 true 的 source） |

每轮最多处理 `max_articles_per_run` 篇文章（默认 10），跨 source 共用限额。

Worker 端只读 KV 缓存，缓存命中直接返回翻译版，未命中返回原文（下次 cron 补齐）。CPU < 5ms。

## 支持的 Source

| source            | 说明                           | RSS Feed URL                                                  |
|-------------------|--------------------------------|---------------------------------------------------------------|
| `bbc-world`       | BBC 国际新闻                   | `https://feeds.bbci.co.uk/news/world/rss.xml`                 |
| `bbc-business`    | BBC 商业新闻                   | `https://feeds.bbci.co.uk/news/business/rss.xml`              |
| `bbc`             | BBC（通用）                    | `https://feeds.bbci.co.uk/news/rss.xml`                       |
| `sciam`           | Scientific American            | `http://rss.sciam.com/ScientificAmerican-Global`              |
| `guardian-ai`     | The Guardian（AI）             | `https://www.theguardian.com/technology/artificialintelligenceai/rss` |
| `guardian-china`  | The Guardian（中国）           | `https://www.theguardian.com/world/china/rss`                 |
| `mit-news`        | MIT News                       | `https://news.mit.edu/rss/feed`                               |
| `theregister-ai`  | The Register（AI/ML）          | `https://www.theregister.com/software/ai_ml/headlines.atom`   |
| `tds`             | Towards Data Science           | `https://towardsdatascience.com/feed/`                        |
| `simonw`          | Simon Willison's Blog          | `https://simonwillison.net/atom/everything/`                  |

未注册的 source 使用通用提取器降级处理。

## 配置

编辑 `config.yaml`，然后推送 KV：

```bash
pnpm run config:push
```

```yaml
# config.yaml
defaults:
  engines:               # 默认翻译引擎链，按顺序尝试，失败自动流转
    - deepseek
  max_articles_per_run: 20
  max_input_tokens: 8192
  target_lang: ZH

providers:
  deepseek:              # LLM provider（需设置 DEEPSEEK_API_KEY secret）
    endpoint: https://api.deepseek.com/v1/chat/completions
    model: deepseek-v4-flash
    max_input_tokens: 1000000

  # deeplx:              # DeepLX（需设置 DEEPLX_API_KEY secret）
  #   type: deeplx
  #   endpoint: https://api.deeplx.org
  #
  # cfllm:               # Cloudflare Workers AI LLM，OpenAI 兼容（需设置 CLOUDFLARE_API_KEY secret）
  #   endpoint: https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1/chat/completions
  #   model: "@cf/zai-org/glm-4.7-flash"
  #   api_key_name: CLOUDFLARE_API_KEY

sources:
  - id: bbc-world
    name: BBC World
    url: https://feeds.bbci.co.uk/news/world/rss.xml
    title: BBC 国际新闻
    domains:
      - bbc.co.uk
      - bbc.com
    translate: true
    translate_body: true
    # engines: [deepseek]  # 可选，覆盖 defaults.engines
```

| 字段 | 说明 |
|------|------|
| `sources[].translate` | 翻译 RSS 标题/摘要 |
| `sources[].translate_body` | 翻译正文并将 `<link>` 改写为代理 URL |
| `sources[].domains` | 文章域名白名单，为空不限制 |
| `sources[].engines` | 翻译 provider 名称数组，覆盖 defaults |
| `providers.{name}.type` | `"llm"`（默认）/ `"deeplx"` / `"cloudflare"` |
| `providers.{name}.api_key_name` | 显式指定 secret 名，默认 `{NAME}_API_KEY` |

## 部署

```bash
# 首次
npx wrangler kv namespace create RSS_CONFIG
npx wrangler kv namespace create RSS_CACHE
# 填写 wrangler.toml 中的 KV namespace id
npx wrangler secret put ACCESS_TOKEN
npx wrangler secret put DEEPSEEK_API_KEY
pnpm run config:push
pnpm run deploy

# 后续
pnpm run deploy
```

### VPS 定时任务

```bash
git clone <repo> /opt/rss-translator
cd /opt/rss-translator
pnpm install --prod

# 创建 .env（参考 .env.example），填写 CF_API_TOKEN + provider key
cp .env.example .env
vim .env

# 安装 systemd timer（软链接，repo 更新 daemon-reload 后自动生效）
sudo ln -sf /opt/rss-translator/systemd/rss-cron-articles.service /etc/systemd/system/
sudo ln -sf /opt/rss-translator/systemd/rss-cron-articles.timer /etc/systemd/system/
sudo ln -sf /opt/rss-translator/systemd/rss-cron-meta.service /etc/systemd/system/
sudo ln -sf /opt/rss-translator/systemd/rss-cron-meta.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rss-cron-articles.timer rss-cron-meta.timer

# 查看日志
sudo journalctl -u rss-cron-articles.service -f
```

## 恢复 CF Cron（付费计划）

升级到 Workers Paid 后，在 `wrangler.toml` 中取消注释 `[triggers]` 段，
在 `src/worker.ts` 中取消注释 `scheduled` handler，即可恢复使用 CF Cron Triggers。
