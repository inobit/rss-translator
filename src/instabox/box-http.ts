/**
 * Worker → instabox box 转发轻量工具。
 * 本模块刻意不依赖任何 cheerio / 翻译 / 解析服务，保证 Worker 包保持「纯读 + 轻量转发」。
 */

/** 通过相对路径 + query（不含 token / origin）构造 box 转发 URL */
export function buildForwardUrl(boxUrl: string, path: string, query: string): string {
  return `${boxUrl}${path}?${query}`;
}

/**
 * 把请求透传给 box，返回解析结果。
 * boxOk=false 表示 box 未返回内容（盒对象不可用或鉴权失败）。
 */
export async function makeBoxBytes(
  boxUrl: string,
  options: { method?: string; path: string; query: string; bytes?: string; token?: string },
): Promise<{ status: number; contentType: string; body: string; boxOk: boolean }> {
  const url = buildForwardUrl(boxUrl, options.path, options.query);
  const headers: Record<string, string> = {};
  if (options.token) headers['X-Instabox-Token'] = options.token;
  if (options.bytes) headers['Content-Type'] = 'application/octet-stream';

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.bytes,
    });
  } catch (e) {
    const err = e as Error;
    console.error(`[instabox] box forward failed: ${err.message}`);
    return { status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'box unreachable' }), boxOk: false };
  }

  const body = await resp.text();
  return {
    status: resp.status,
    contentType: resp.headers.get('content-type') ?? 'text/plain',
    body,
    boxOk: resp.ok,
  };
}