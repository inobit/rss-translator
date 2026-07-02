import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import type { ParsedRss, ParsedRssChannel, ParsedRssItem } from '../types';

// 用 @_ 前缀区分属性和子元素：属性会带 @_ 前缀，子元素不带
const ATTR_PREFIX = '@_';

const CDATA_KEY = '__cdata';
const CDATA_FIELDS = new Set(['title', 'description', 'language', 'copyright', 'content', 'link']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  parseTagValue: false,
});

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: ATTR_PREFIX,
  format: false,
  suppressEmptyNode: true,
  cdataPropName: CDATA_KEY,
});

/**
 * 解析 RSS XML 字符串，返回结构化对象
 */
export function parseRssXml(xml: string): ParsedRss | null {
  try {
    const parsed = parser.parse(xml);
    const rss = parsed.rss ?? parsed['rdf:RDF'];
    if (!rss) return null;

    const channel = rss.channel;
    if (!channel) return null;

    const items = normalizeItems(channel.item);

    // 提取 <rss> 或 <rdf:RDF> 的命名空间等属性
    const { channel: _ch, ...rssAttrs } = rss;

    return {
      rssAttrs: rssAttrs as Record<string, unknown>,
      channel: {
        ...channel,
        items: items.map(normalizeItem),
      },
    };
  } catch {
    return null;
  }
}

/**
 * 格式化 RSS channel 以去除 item 后再重建
 */
export function getChannelMetadata(channel: ParsedRssChannel) {
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
  return builder.build(xmlObj);
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
  const contentVal =
    (raw['content:encoded'] as string | undefined) ?? raw.content;
  return {
    ...raw,
    title: raw.title ?? '',
    description: raw.description ?? '',
    link: raw.link ?? '',
    ...(contentVal ? { content: contentVal } : {}),
  };
}
