import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import type { ParsedRss, ParsedRssChannel, ParsedRssItem } from '../types';

// 用 @_ 前缀区分属性和子元素：属性会带 @_ 前缀，子元素不带
const ATTR_PREFIX = '@_';

const CDATA_KEY = '__cdata';
const CDATA_FIELDS = new Set(['title', 'description', 'language', 'copyright', 'content', 'content:encoded', 'link']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  parseTagValue: false,
  // 不解析属性值类型，保持 "true"/"false"/数字 为字符串，
  // 避免 builder 将 "true" 输出为无值布尔属性（非法 XML）
  parseAttributeValue: false,
  processEntities: { enabled: true, maxTotalExpansions: 100000 },
});

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  format: false,
  suppressEmptyNode: true,
  cdataPropName: CDATA_KEY,
});

/**
 * 解析 RSS/Atom XML 字符串，返回结构化对象
 */
export function parseRssXml(xml: string): ParsedRss | null {
  try {
    const parsed = parser.parse(xml);
    const rss = parsed.rss ?? parsed['rdf:RDF'];
    if (rss) {
      const channel = rss.channel;
      if (!channel) return null;

      const items = normalizeItems(channel.item);

      // 提取 <rss> 或 <rdf:RDF> 的命名空间等属性
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { channel: _ch, ...rssAttrs } = rss;

      return {
        rssAttrs: rssAttrs as Record<string, unknown>,
        channel: {
          ...channel,
          items: items.map(normalizeItem),
        },
      };
    }

    // Atom feed
    if (parsed.feed) {
      return parseAtomFeed(parsed.feed as Record<string, unknown>);
    }

    return null;
  } catch {
    return null;
  }
}

/** 从 Atom entry 中提取 link URL，优先取 rel=alternate */
function extractAtomLink(links: unknown): string {
  const linkList = normalizeItems(links);
  for (const link of linkList) {
    if (typeof link === 'string') return link;
    const href = (link as Record<string, unknown>)?.['@_href'] as string | undefined;
    const rel = (link as Record<string, unknown>)?.['@_rel'] as string | undefined;
    if (href && (!rel || rel === 'alternate')) return href;
  }
  // 最后兜底：取第一个有 href 的 link
  for (const link of linkList) {
    if (typeof link !== 'string') {
      const href = (link as Record<string, unknown>)?.['@_href'] as string | undefined;
      if (href) return href;
    }
  }
  return '';
}

/** 解析 Atom feed 为 ParsedRss 统一格式 */
function parseAtomFeed(feed: Record<string, unknown>): ParsedRss | null {
  const entries = normalizeItems(feed.entry);
  if (!entries.length) return null;

  const feedLink = extractAtomLink(feed.link);
  const items = entries.map((entry: Record<string, unknown>) => {
    const entryLink = extractAtomLink(entry.link);

    // Atom 的 summary 可能含 HTML（type="html"），直接作为 description
    let description = '';
    const summary = entry.summary;
    if (typeof summary === 'string') {
      description = summary;
    } else if (summary && typeof summary === 'object') {
      description = (summary as Record<string, unknown>)['#text'] as string
        || (summary as Record<string, unknown>)[CDATA_KEY] as string
        || '';
    }

    // content 字段也可能存在
    let content = '';
    const rawContent = entry.content ?? entry['content:encoded'];
    if (typeof rawContent === 'string') {
      content = rawContent;
    } else if (rawContent && typeof rawContent === 'object') {
      content = (rawContent as Record<string, unknown>)['#text'] as string
        || (rawContent as Record<string, unknown>)[CDATA_KEY] as string
        || '';
    }

    return {
      title: (entry.title as string) ?? '',
      description: description || content,
      link: entryLink,
      pubDate: (entry.published ?? entry.updated) as string ?? '',
      guid: (entry.id as string) ?? entryLink,
    } as ParsedRssItem;
  });

  return {
    rssAttrs: { '@_version': '2.0' },
    channel: {
      title: (feed.title as string) ?? '',
      description: (feed.subtitle as string) ?? '',
      link: feedLink,
      language: (feed['@_xml:lang'] as string) ?? '',
      items: items.map(normalizeItem),
    } as ParsedRssChannel,
  };
}

/**
 * 格式化 RSS channel 以去除 item 后再重建
 */
export function getChannelMetadata(channel: ParsedRssChannel) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { items: _items, ...meta } = channel;
  return meta;
}

/**
 * 将翻译后的 RSS 数据重新生成为 XML 字符串
 */
export function buildRssXml(
  channelMeta: Record<string, unknown>,
  items: Record<string, unknown>[],
  rssAttrs?: Record<string, unknown>,
): string {
  const xmlObj = {
    '?xml': { [`${ATTR_PREFIX}version`]: '1.0', [`${ATTR_PREFIX}encoding`]: 'UTF-8' },
    rss: {
      ...rssAttrs,
      [`${ATTR_PREFIX}version`]: rssAttrs?.[`${ATTR_PREFIX}version`] ?? '2.0',
      channel: {
        ...wrapCdataForBuild(channelMeta),
        item: items.map(wrapCdataForBuild),
      },
    },
  };
  const xml = builder.build(xmlObj);
  // fast-xml-parser builder 会将值为 "true" 的属性输出为无值布尔属性
  // （如 <guid isPermaLink>），这在 XML 中是非法的——属性必须有值。
  // 此处修复：为无值属性补上 ="true"
  return fixValuelessAttributes(xml);
}

/**
 * 修复无值布尔属性：将 `attr`（无等号无值）补全为 `attr="true"`
 * 仅在标签定义内（<tag ...>）处理，不影响 CDATA / 文本内容
 */
function fixValuelessAttributes(xml: string): string {
  // <[a-zA-Z_] 排除 CDATA(<!)、注释(<!--)、处理指令(<?)
  // [^>]* 确保不跨标签边界
  return xml.replace(/<[a-zA-Z_][^>]*>/g, (tag) => {
    return tag.replace(/\s([a-zA-Z_:][\w:.-]*)(?=\s|>|\/)/g, ' $1="true"');
  });
}

/** 将需要 CDATA 包裹的字符串字段包装为 { __cdata: val } */
function wrapCdataForBuild(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && value !== '' && CDATA_FIELDS.has(key)) {
      result[key] = { [CDATA_KEY]: value };
    } else {
      result[key] = value;
    }
  }
  return result;
}

function normalizeItems(item: unknown): ParsedRssItem[] {
  if (!item) return [];
  if (Array.isArray(item)) return item as ParsedRssItem[];
  return [item as ParsedRssItem];
}

function normalizeItem(raw: ParsedRssItem): ParsedRssItem {
  const item: ParsedRssItem = {
    ...raw,
    title: raw.title ?? '',
    description: raw.description ?? '',
    link: raw.link ?? '',
  };
  // 统一移除 content:encoded，所有正文通过 /raw 代理获取译文
  delete item['content:encoded'];
  delete item.content;
  return item;
}
