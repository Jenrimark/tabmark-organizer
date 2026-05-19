/** @typedef {{ id: string, title: string, url?: string, type: 'folder'|'bookmark'|'tab', children?: TreeNode[], chromeId?: string, tabId?: number, snippet?: string }} TreeNode */

/** 常见系统根 id（完整列表在 bookmarks.refreshRootFolderIds） */
function isRootChromeId(chromeId) {
  return ['0', '1', '2', '3', '4', '5'].includes(String(chromeId));
}

export function generateId() {
  return `n_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function createFolder(title = '新文件夹') {
  return { id: generateId(), title, type: 'folder', children: [] };
}

export function createBookmark(title, url, extra = {}) {
  return { id: generateId(), title, url, type: 'bookmark', ...extra };
}

/** Deep clone tree */
export function cloneTree(nodes) {
  return JSON.parse(JSON.stringify(nodes));
}

/** Find node and parent array by id */
export function findNode(nodes, id, parent = null, parentList = nodes) {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.id === id) return { node: n, parent, parentList, index: i };
    if (n.type === 'folder' && n.children?.length) {
      const found = findNode(n.children, id, n, n.children);
      if (found) return found;
    }
  }
  return null;
}

export function removeNode(nodes, id) {
  const found = findNode(nodes, id);
  if (!found) return null;
  const [removed] = found.parentList.splice(found.index, 1);
  return removed;
}

export function insertNode(nodes, targetId, node, position = 'inside') {
  if (!targetId) {
    nodes.push(node);
    return true;
  }
  const found = findNode(nodes, targetId);
  if (!found) return false;

  if (position === 'inside' && found.node.type === 'folder') {
    found.node.children = found.node.children || [];
    found.node.children.push(node);
    return true;
  }

  const list = found.parentList;
  const idx = position === 'before' ? found.index : found.index + 1;
  list.splice(idx, 0, node);
  return true;
}

/** Flatten for export / AI */
export function flattenTree(nodes, path = []) {
  const out = [];
  for (const n of nodes) {
    const p = [...path, n.title];
    if (n.type === 'bookmark' || n.type === 'tab') {
      out.push({
        id: n.id,
        chromeId: n.chromeId,
        title: n.title,
        url: n.url,
        type: n.type,
        path: p.slice(0, -1).join(' / '),
        snippet: n.snippet || '',
      });
    }
    if (n.type === 'folder' && n.children) {
      out.push(...flattenTree(n.children, p));
    }
  }
  return out;
}

/** Rebuild tree from AI JSON: { folders: [{ title, children: [...] }] } */
export function buildFromAiStructure(aiTree, urlMap) {
  function walk(items) {
    return items.map((item) => {
      if (item.children) {
        const folder = { ...createFolder(item.title), children: walk(item.children) };
        const srcFolder = urlMap.get(item.id);
        if (srcFolder?.chromeId && !isRootChromeId(srcFolder.chromeId)) {
          folder.chromeId = String(srcFolder.chromeId);
          folder.id = `chrome_${srcFolder.chromeId}`;
        }
        return folder;
      }
      const src = urlMap.get(item.url) || urlMap.get(item.id);
      const bm = createBookmark(
        item.title || src?.title || '未命名',
        item.url || src?.url || '',
        { snippet: src?.snippet }
      );
      if (src?.chromeId && !isRootChromeId(src.chromeId)) {
        bm.chromeId = String(src.chromeId);
        bm.id = `chrome_${src.chromeId}`;
      }
      return bm;
    });
  }
  return walk(aiTree.folders || aiTree.children || []);
}

export function treeToJson(nodes) {
  return nodes.map((n) => {
    if (n.type === 'folder') {
      return { title: n.title, children: treeToJson(n.children || []) };
    }
    return { title: n.title, url: n.url, id: n.id };
  });
}
