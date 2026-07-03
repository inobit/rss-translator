# RSS Translator

Cloudflare Worker 上的 RSS 翻译代理，支持 LLM 翻译标题/摘要，定时预缓存正文翻译。

## 使用

```
GET /rss?source=bbc-world&token=<TOKEN>
```

返回翻译后的 RSS XML，导入任意 RSS 阅读器即可。

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

编辑 `config.json`，然后推送 KV：

```bash
pnpm run config:push
```

```json
{
  "sources": [{
    "id": "bbc-world",
    "url": "https://feeds.bbci.co.uk/news/world/rss.xml",
    "title": "BBC 国际新闻",
    "translate": true,
    "translate_body": true,
    "engine": "llm"
  }],
  "defaults": {
    "target_lang": "ZH",
    "engine": "llm",
    "max_articles_per_run": 20
  }
}
```

## 部署

```bash
# 首次
npx wrangler kv namespace create RSS_CONFIG
npx wrangler kv namespace create RSS_CACHE
# 填写 wrangler.toml 中的 KV namespace id
npx wrangler secret put ACCESS_TOKEN
npx wrangler secret put LLM_API_KEY
pnpm run config:push
pnpm run deploy

# 后续
pnpm run deploy
```
