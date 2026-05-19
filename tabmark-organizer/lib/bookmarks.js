export const SNAPSHOT_KEY = 'bookmarkIdSnapshot';

/** 运行时缓存：Chrome 根节点(0)及其下所有系统文件夹 */
let cachedRootFolderIds = null;

/** 从 Chrome 读取当前所有不可修改的系统根文件夹 id */
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

/** 从 Chrome 读取完整书签树（保留 chromeId 以便写回） */
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

/** 收集树中全部 chromeId */
export function collectChromeIds(nodes, set = new Set()) {
  for (const n of nodes) {
    if (n.chromeId) set.add(String(n.chromeId));
    if (n.children?.length) collectChromeIds(n.children, set);
  }
  return set;
}

/**
 * 将插件内编辑后的树写回 Chrome 书签（原位更新/移动/新建）
 */
export async function applyTreeToBrowser(nodes, options = {}) {
  const { deleteRemoved = false } = options;
  const rootIds = await refreshRootFolderIds();

  for (let i = 0; i < nodes.length; i++) {
    await applyNode(nodes[i], null, i, rootIds);
  }

  if (deleteRemoved) {
    const { [SNAPSHOT_KEY]: snapshot = [] } = await chrome.storage.local.get(SNAPSHOT_KEY);
    const afterIds = collectChromeIds(nodes);
    for (const id of snapshot) {
      if (rootIds.has(String(id))) continue;
      if (!afterIds.has(String(id))) {
        try {
          await chrome.bookmarks.removeTree(id);
        } catch {
          /* 可能已被删除 */
        }
      }
    }
  }

  const ids = [...collectChromeIds(nodes)];
  await chrome.storage.local.set({ [SNAPSHOT_KEY]: ids });

  return { success: true };
}

async function applyNode(node, parentId, index, rootIds) {
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
        index,
      });
      folderId = String(created.id);
      node.chromeId = folderId;
      node.id = `chrome_${folderId}`;
    } else if (rootIds.has(folderId)) {
      // 系统根文件夹：不 update / 不 move，只同步其子项
    } else {
      await chrome.bookmarks.update(folderId, { title: node.title });
      if (parentId != null) {
        await chrome.bookmarks.move(folderId, {
          parentId: String(parentId),
          index,
        });
      }
    }

    const children = node.children || [];
    const childParent = folderId;
    for (let i = 0; i < children.length; i++) {
      await applyNode(children[i], childParent, i, rootIds);
    }
    return;
  }

  // bookmark
  if (!node.url) return;

  let bmId = node.chromeId ? String(node.chromeId) : null;

  if (bmId && rootIds.has(bmId)) {
    throw new Error(
      `「${node.title}」被识别为系统目录，不能当作书签写回。请重新「从浏览器同步」后再整理。`
    );
  }

  if (!bmId) {
    if (parentId == null) {
      throw new Error(`无法在无父文件夹下创建书签「${node.title}」`);
    }
    const created = await chrome.bookmarks.create({
      parentId: String(parentId),
      title: node.title,
      url: node.url,
      index,
    });
    bmId = String(created.id);
    node.chromeId = bmId;
    node.id = `chrome_${bmId}`;
  } else {
    assertNotRoot(bmId, '不能修改', node.title);
    await chrome.bookmarks.update(bmId, { title: node.title, url: node.url });
    if (parentId != null) {
      await chrome.bookmarks.move(bmId, {
        parentId: String(parentId),
        index,
      });
    }
  }
}

export function isRootFolderNode(node) {
  return node?.type === 'folder' && isChromeRootFolder(node.chromeId);
}

export async function updateChromeBookmark(node) {
  if (!node.chromeId) return;
  if (isChromeRootFolder(node.chromeId)) return;
  if (node.type === 'folder') {
    await chrome.bookmarks.update(String(node.chromeId), { title: node.title });
  } else if (node.url) {
    await chrome.bookmarks.update(String(node.chromeId), {
      title: node.title,
      url: node.url,
    });
  }
}
