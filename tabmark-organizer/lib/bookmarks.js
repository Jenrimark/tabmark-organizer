import { validateBookmarkIntegrity, getBookmarkBaseline } from './integrity.js';

export const SNAPSHOT_KEY = 'bookmarkIdSnapshot';

/** 运行时缓存：Chrome 根节点(0)及其下所有系统文件夹 */
let cachedRootFolderIds = null;

export async function refreshRootFolderIds() {
  const [root] = await chrome.bookmarks.getTree();
  const ids = new Set([String(root.id)]);
  for (const child of root.children || []) {
    ids.add(String(child.id));
  }
  cachedRootFolderIds = ids;
  return ids;
}

export function getRootFolderIds() {
  return cachedRootFolderIds || new Set(['0', '1', '2', '3']);
}

export function isChromeRootFolder(chromeId) {
  if (chromeId == null || chromeId === '') return false;
  return getRootFolderIds().has(String(chromeId));
}

function assertNotRoot(id, action, title = '') {
  if (isChromeRootFolder(id)) {
    const name = title ? `「${title}」` : '该系统文件夹';
    throw new Error(
      `${name}是浏览器自带目录（书签栏/其他书签等），${action}。请只整理其内部的子书签。`
    );
  }
}

function assertValidParentId(parentId) {
  if (parentId != null && String(parentId) === '0') {
    throw new Error('书签不能直接放在根节点下，请拖入「书签栏」等文件夹内');
  }
}

export async function syncFromBrowser() {
  await refreshRootFolderIds();
  const chromeTree = await chrome.bookmarks.getTree();
  const root = chromeTree[0];
  const tree = convertChromeNodes(root.children || []);
  const ids = [...collectChromeIds(tree)];
  await chrome.storage.local.set({ [SNAPSHOT_KEY]: ids });
  return tree;
}

function convertChromeNodes(nodes) {
  return nodes.map((n) => {
    if (n.url) {
      return {
        id: `chrome_${n.id}`,
        chromeId: String(n.id),
        title: n.title,
        url: n.url,
        type: 'bookmark',
      };
    }
    return {
      id: `chrome_${n.id}`,
      chromeId: String(n.id),
      title: n.title,
      type: 'folder',
      children: convertChromeNodes(n.children || []),
    };
  });
}

export function collectChromeIds(nodes, set = new Set()) {
  for (const n of nodes) {
    if (n.chromeId) set.add(String(n.chromeId));
    if (n.children?.length) collectChromeIds(n.children, set);
  }
  return set;
}

/**
 * 统计树中所有需要处理的节点数量
 */
function countNodes(nodes) {
  let count = 0;
  for (const n of nodes) {
    count++;
    if (n.children?.length) count += countNodes(n.children);
  }
  return count;
}

/**
 * 写回 Chrome：更新标题、URL、位置；可新建文件夹；支持增删书签
 * @param {Array} nodes - 树节点
 * @param {Object} options - 选项
 * @param {Function} options.onProgress - 进度回调 (current, total)
 * @param {Array} options.removeChromeIds - 需要从浏览器删除的书签 chromeId 列表
 */
export async function applyTreeToBrowser(nodes, options = {}) {
  const { onProgress, removeChromeIds } = options;

  const rootIds = await refreshRootFolderIds();
  const total = countNodes(nodes) + (removeChromeIds?.length || 0);
  let current = 0;

  // 先处理删除
  if (removeChromeIds?.length) {
    for (const chromeId of removeChromeIds) {
      try {
        await chrome.bookmarks.remove(chromeId);
      } catch (e) {
        // 书签可能已经被删除，忽略
      }
      current++;
      if (onProgress) onProgress(current, total);
    }
  }

  for (let i = 0; i < nodes.length; i++) {
    await applyNode(nodes[i], null, i, rootIds, () => {
      current++;
      if (onProgress) onProgress(current, total);
    });
  }

  const ids = [...collectChromeIds(nodes)];
  await chrome.storage.local.set({ [SNAPSHOT_KEY]: ids });

  return { success: true, bookmarkCount: nodes.length };
}

async function applyNode(node, parentId, index, rootIds, onNodeDone) {
  assertValidParentId(parentId);

  if (node.type === 'folder') {
    let folderId = node.chromeId ? String(node.chromeId) : null;

    if (!folderId) {
      if (parentId == null) {
        throw new Error(`无法新建顶级文件夹「${node.title}」，请放在「书签栏」等目录内`);
      }
      const created = await chrome.bookmarks.create({
        parentId: String(parentId),
        title: node.title,
      });
      folderId = String(created.id);
      node.chromeId = folderId;
      node.id = `chrome_${folderId}`;
    } else if (rootIds.has(folderId)) {
      // 系统根文件夹：只同步子项
    } else {
      await chrome.bookmarks.update(folderId, { title: node.title });
      if (parentId != null) {
        try {
          await chrome.bookmarks.move(folderId, { parentId: String(parentId) });
        } catch (e) {
          // 移动失败时忽略（可能位置未变）
        }
      }
    }

    const children = node.children || [];
    for (let i = 0; i < children.length; i++) {
      await applyNode(children[i], folderId, i, rootIds, onNodeDone);
    }
    if (onNodeDone) onNodeDone();
    return;
  }

  if (!node.url) {
    if (onNodeDone) onNodeDone();
    return;
  }

  const bmId = node.chromeId ? String(node.chromeId) : null;

  if (!bmId) {
    // 新增书签：创建
    if (parentId == null) {
      throw new Error(`无法在顶级新增书签「${node.title}」，请放在「书签栏」等目录内`);
    }
    const created = await chrome.bookmarks.create({
      parentId: String(parentId),
      title: node.title,
      url: node.url,
    });
    node.chromeId = String(created.id);
    node.id = `chrome_${node.chromeId}`;
    if (onNodeDone) onNodeDone();
    return;
  }

  if (rootIds.has(bmId)) {
    throw new Error(
      `「${node.title}」被识别为系统目录。请重新「从浏览器同步」后再整理。`
    );
  }

  assertNotRoot(bmId, '不能修改', node.title);
  await chrome.bookmarks.update(bmId, { title: node.title, url: node.url });
  if (parentId != null) {
    try {
      await chrome.bookmarks.move(bmId, { parentId: String(parentId) });
    } catch (e) {
      // 移动失败时忽略（可能位置未变）
    }
  }
  if (onNodeDone) onNodeDone();
}

export function isRootFolderNode(node) {
  return node?.type === 'folder' && isChromeRootFolder(node.chromeId);
}
