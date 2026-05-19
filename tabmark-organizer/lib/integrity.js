import { createFolder } from './tree.js';

export const BASELINE_KEY = 'bookmarkBaseline';

/** 提取所有书签（不含文件夹） */
export function extractBookmarks(nodes) {
  const list = [];
  function walk(ns) {
    for (const n of ns) {
      if (n.type === 'bookmark' && n.url) {
        list.push({
          chromeId: n.chromeId ? String(n.chromeId) : null,
          url: n.url,
          title: n.title || '',
          id: n.id,
        });
      }
      if (n.children?.length) walk(n.children);
    }
  }
  walk(nodes);
  return list;
}

/** 同步时保存书签数量基准 */
export async function saveBookmarkBaseline(nodes) {
  const bookmarks = extractBookmarks(nodes);
  await chrome.storage.local.set({ [BASELINE_KEY]: bookmarks });
  return bookmarks.length;
}

export async function getBookmarkBaseline() {
  const data = await chrome.storage.local.get(BASELINE_KEY);
  return data[BASELINE_KEY] || [];
}

/**
 * 校验当前树与基准书签的差异
 * @returns {{ ok: boolean, message?: string, count?: { baseline: number, current: number }, added: Array, removed: Array, unchanged: number }}
 */
export function validateBookmarkIntegrity(tree, baseline) {
  if (!baseline?.length) {
    return { ok: false, message: '尚未建立书签基准，请先点击「从浏览器同步」', added: [], removed: [], unchanged: 0, count: { baseline: 0, current: 0 } };
  }

  const current = extractBookmarks(tree);

  const baseByChrome = new Map(
    baseline.filter((b) => b.chromeId).map((b) => [String(b.chromeId), b])
  );
  const curByChrome = new Map(
    current.filter((b) => b.chromeId).map((b) => [String(b.chromeId), b])
  );

  const removed = [];
  for (const [id, b] of baseByChrome) {
    if (!curByChrome.has(id)) {
      removed.push({ chromeId: id, title: b.title || '', url: b.url || '' });
    }
  }

  const added = [];
  for (const [id, b] of curByChrome) {
    if (!baseByChrome.has(id)) {
      added.push({ chromeId: id, title: b.title || '', url: b.url || '' });
    }
  }

  const unchanged = baseline.length - removed.length;

  const hasChanges = added.length > 0 || removed.length > 0;

  return {
    ok: !hasChanges,
    count: { baseline: baseline.length, current: current.length },
    added,
    removed,
    unchanged,
    message: hasChanges
      ? `检测到变更：新增 ${added.length} 条，删除 ${removed.length} 条`
      : null,
  };
}

/** AI 遗漏时，将缺失书签补入「未归类」文件夹 */
export function appendMissingBookmarks(tree, baseline) {
  const current = extractBookmarks(tree);
  const curIds = new Set(current.map((b) => b.chromeId).filter(Boolean));
  const missing = baseline.filter((b) => b.chromeId && !curIds.has(String(b.chromeId)));

  if (!missing.length) return { tree, added: 0 };

  const folder = createFolder('未归类（自动保留）');
  folder.children = missing.map((b) => ({
    id: `chrome_${b.chromeId}`,
    chromeId: String(b.chromeId),
    title: b.title || b.url,
    url: b.url,
    type: 'bookmark',
  }));

  const bar = tree.find(
    (n) => n.type === 'folder' && (n.title === '书签栏' || n.title === 'Bookmarks bar')
  );
  if (bar) {
    bar.children = bar.children || [];
    bar.children.push(folder);
  } else {
    tree.push(folder);
  }

  return { tree, added: missing.length };
}
