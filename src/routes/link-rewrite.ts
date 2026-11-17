/**
 * 成品 RSS XML 的相对链接补全。
 *
 * box 组装成品时把文章 <link> 写成相对路径 `/raw?url=<enc>&source=<id>`（不含 token/origin），
 * 这样同一份 KV 成品可服务任意 Worker 域名与任意客户端 token。
 * Worker 返回前用当前请求的 origin/token 做一次轻量字符串替换。
 */

/** 匹配成品里的相对 /raw 链接（URL-safe 字符集，止于 CDATA/XML 分隔符） */
const RELATIVE_RAW_LINK = /(\/raw\?url=[\w%&=.-]+)/g;

/** 把相对 /raw 链接补成绝对地址并附加客户端 token */
export function rewriteRelativeLinks(xml: string, origin: string, token: string): string {
  const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
  return xml.replace(RELATIVE_RAW_LINK, (_m, rel: string) => `${origin}${rel}${tokenParam}`);
}
