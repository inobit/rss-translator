/**
 * /merge 的确定性混排规则：以各源 RSS 自带的文章顺序为基础，
 * 给每篇文章按「在本源中的位置 + 固定抖动」算出一个虚拟位置，再全局排序。
 *
 * - 每个源内部的先后顺序原样保留（不做时间倒序、不按标题重排）
 * - 每个源的条目均匀铺开到整条 feed，小源也不会全挤在开头
 * - 抖动只由源 id + 文章标识哈希得出，不用随机数/当前时间：
 *   同样的数据每次刷新顺序完全一致
 */

export interface OrderedEntry<T> {
  item: T;
  /** 文章稳定标识（guid / link / title），用于抖动与平局判定 */
  key: string;
  /** 来源 id */
  sourceId: string;
}

/** FNV-1a 32 位哈希：纯字符串输入，跨运行时结果固定 */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 按源原有顺序做分层抖动合并。
 * 条目在输入数组中的先后顺序即它在源里的位置（box-core 按源顺序逐篇读取）。
 */
export function mergeBySourceOrder<T>(entries: OrderedEntry<T>[]): T[] {
  const totals = new Map<string, number>();
  for (const entry of entries) {
    totals.set(entry.sourceId, (totals.get(entry.sourceId) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  const positioned = entries.map((entry) => {
    const index = seen.get(entry.sourceId) ?? 0;
    seen.set(entry.sourceId, index + 1);
    const total = totals.get(entry.sourceId) ?? 1;
    const jitter = fnv1a(`${entry.sourceId}\u0000${entry.key}`) / 0x100000000;
    // 相邻条目的 index 相差 1、jitter 落在 [0,1)，因此源内顺序必然保序
    return { ...entry, pos: (index + jitter) / total };
  });

  positioned.sort((a, b) => {
    return a.pos - b.pos
      || compareStrings(a.sourceId, b.sourceId)
      || compareStrings(a.key, b.key);
  });

  return positioned.map((entry) => entry.item);
}

/** 取文章的稳定标识：优先 guid，其次 link，最后 title */
export function itemIdentity(item: Record<string, unknown>): string {
  const pick = (key: string): string => {
    const value = item[key];
    return typeof value === 'string' && value ? value : '';
  };
  return pick('guid') || pick('link') || pick('title');
}
