# RSS Translator

Cloudflare Worker 上的 RSS 翻译代理，支持 LLM 翻译标题/摘要，定时预缓存正文翻译。

## 使用

```
GET /rss?source=bbc-world&token=<TOKEN>
```

返回翻译后的 RSS XML，导入任意 RSS 阅读器即可。

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
