const endpoint = process.env.LLM_ENDPOINT;
const apiKey = process.env.LLM_API_KEY;
const model = process.env.LLM_MODEL || 'deepseek-v4-flash';

const PROMPT = `将以下英文新闻内容翻译为中文。要求：
- 使用新闻体的专业中文
- 精确传达原意
- 保持格式和结构

原文：`;

async function main() {
  // 1. 抓取原文
  const url = 'https://www.bbc.co.uk/news/articles/cvgmv98ez3zo';
  console.log('=== 1. 抓取原文 ===');
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSS-Translator/1.0)' },
  });
  const html = await resp.text();
  console.log(`HTML 长度: ${html.length}`);

  // 2. 提取标题和正文
  console.log('\n=== 2. 提取内容 ===');
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let title = (titleMatch ? titleMatch[1].trim() : 'Untitled')
    .replace(/\s*[-|]\s*(BBC News|BBC)$/i, '').trim();
  const body = extractContent(html);

  console.log(`title: "${title}"`);
  console.log(`body 长度: ${body.length}`);
  console.log(`body 前 300 字:\n${body.slice(0, 300)}\n`);
  console.log(`body 后 300 字:\n${body.slice(-300)}\n`);

  // 3. 翻译
  console.log('=== 3. 翻译标题 ===');
  const tTitle = await translateLlm(title);
  console.log(`title 输入: ${title.length} 字 → 输出: ${tTitle.length} 字`);
  console.log(`"${tTitle}"\n`);

  console.log('=== 4. 翻译正文 ===');
  const tBody = await translateLlm(body);
  console.log(`body 输入: ${body.length} 字 → 输出: ${tBody.length} 字`);
  console.log(`输出前 300 字:\n${tBody.slice(0, 300)}\n`);
  console.log(`输出后 300 字:\n${tBody.slice(-300)}\n`);
}

function extractContent(html) {
  let c = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
    .replace(/<figure[^>]*>[\s\S]*?<\/figure>/gi, '')
    .replace(/<figcaption[^>]*>[\s\S]*?<\/figcaption>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const m = c.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
    || c.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
    || c.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (m) c = m[1];

  c = c.replace(/<[^>]*>/g, ' ');
  c = c.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
  c = c.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  return c;
}

async function translateLlm(text) {
  const userContent = `请将以下内容翻译为ZH，直接返回翻译结果，不要添加任何前缀或说明：\n\n${text}`;

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: userContent },
      ],
      temperature: 0.3,
      max_tokens: 32768,
    }),
  });

  const data = await resp.json();
  if (!resp.ok) {
    console.error('LLM 请求失败:', resp.status, JSON.stringify(data).slice(0, 500));
    return text;
  }

  const content = data.choices?.[0]?.message?.content;
  console.log(`LLM 响应: finish_reason=${data.choices?.[0]?.finish_reason}, raw_length=${content?.length ?? 0}`);
  return content ? content.trim() : text;
}

main().catch(e => { console.error(e); process.exit(1); });
