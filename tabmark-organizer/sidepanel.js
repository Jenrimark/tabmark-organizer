import {
  createFolder,
  cloneTree,
  findNode,
  removeNode,
  insertNode,
  flattenTree,
  buildFromAiStructure,
} from './lib/tree.js';
import {
  syncFromBrowser,
  applyTreeToBrowser,
  isRootFolderNode,
  refreshRootFolderIds,
} from './lib/bookmarks.js';
import { organizeWithAi, loadAiSettings, saveAiSettings, testAiConnection } from './lib/ai.js';
import {
  generateProviderId,
  getBuiltinProvider,
  getAllProviderOptions,
} from './lib/providers.js';
import {
  saveBookmarkBaseline,
  getBookmarkBaseline,
  validateBookmarkIntegrity,
  appendMissingBookmarks,
  extractBookmarks,
} from './lib/integrity.js';

const STORAGE_KEY = 'workspaceTree';

let tree = [];
let selectedId = null;
let dragId = null;

const $ = (sel) => document.querySelector(sel);
const treeRoot = $('#treeRoot');
const emptyHint = $('#emptyHint');
const statusEl = $('#status');

function setStatus(msg, type = 'ok') {
  statusEl.hidden = !msg;
  statusEl.textContent = msg || '';
  statusEl.className = `status ${type}`;
}

// ── Progress Bar ──
function showProgress(percent, text) {
  const bar = $('#progressBar');
  const fill = bar.querySelector('.progress-fill');
  const label = bar.querySelector('.progress-text');
  bar.hidden = false;
  fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  label.textContent = text || `${Math.round(percent)}%`;
}

function hideProgress() {
  $('#progressBar').hidden = true;
  $('#progressBar').querySelector('.progress-fill').style.width = '0%';
}

// ── Stats Bar ──
function updateStatsBar() {
  const bookmarks = extractBookmarks(tree);
  const domains = new Set();
  bookmarks.forEach((b) => {
    try { domains.add(new URL(b.url).hostname); } catch {}
  });
  const folderCount = (function countFolders(nodes) {
    let c = 0;
    for (const n of nodes) {
      if (n.type === 'folder') { c++; c += countFolders(n.children || []); }
    }
    return c;
  })(tree);

  const statsBar = $('#statsBar');
  statsBar.hidden = !tree.length;
  $('#statTotal').textContent = bookmarks.length;
  $('#statFolders').textContent = folderCount;
  $('#statDomains').textContent = domains.size;
  chrome.storage.local.get('lastSyncTime', (d) => {
    $('#statSyncTime').textContent = d.lastSyncTime || '-';
  });
}

async function saveWorkspace() {
  await chrome.storage.local.set({ [STORAGE_KEY]: tree });
}

function updateBookmarkCountUI() {
  const el = $('#bookmarkCount');
  const n = extractBookmarks(tree).length;
  if (!n) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = `当前 ${n} 条书签`;
  updateStatsBar();
}

async function loadWorkspace() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  if (data[STORAGE_KEY]?.length) {
    tree = data[STORAGE_KEY];
    render();
  }
}

function render() {
  treeRoot.innerHTML = '';
  emptyHint.hidden = tree.length > 0;
  tree.forEach((node) => treeRoot.appendChild(renderNode(node, 0)));
  updateBookmarkCountUI();
}

function renderNode(node, depth) {
  const li = document.createElement('li');
  li.className = 'tree-item';
  li.dataset.id = node.id;
  li.setAttribute('role', 'treeitem');
  li.setAttribute('aria-expanded', node.type === 'folder' ? 'true' : undefined);

  const isRoot = isRootFolderNode(node);

  const row = document.createElement('div');
  row.className = 'tree-row' + (selectedId === node.id ? ' selected' : '') + (isRoot ? ' is-root' : '');
  row.draggable = !isRoot;

  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.textContent = isRoot ? '🔒' : node.type === 'folder' ? '📁' : '🔖';

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = node.title;
  title.title = isRoot ? `${node.title}（系统文件夹，不可改名）` : node.title;

  const url = document.createElement('span');
  if (node.url) {
    url.className = 'url';
    url.textContent = node.url;
    url.title = node.url;
  }

  const actions = document.createElement('div');
  actions.className = 'tree-actions';
  actions.innerHTML = `
    <button type="button" data-act="rename" title="重命名">✎</button>
    ${node.type === 'folder' && !isRoot ? '<button type="button" data-act="add-folder" title="新建子文件夹">+</button>' : ''}
  `;

  row.append(icon, title, url, actions);
  li.appendChild(row);

  if (node.type === 'folder') {
    const ul = document.createElement('ul');
    ul.className = 'tree-children';
    (node.children || []).forEach((child) => ul.appendChild(renderNode(child, depth + 1)));
    li.appendChild(ul);
  }

  bindRowEvents(row, li, node, title);
  return li;
}

function bindRowEvents(row, li, node, titleEl) {
  row.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    selectedId = node.id;
    render();
  });

  row.querySelector('[data-act="rename"]')?.addEventListener('click', () => {
    if (isRootFolderNode(node)) {
      setStatus('「书签栏」「其他书签」等系统文件夹不能改名', 'error');
      return;
    }
    startRename(titleEl, node);
  });
  row.querySelector('[data-act="add-folder"]')?.addEventListener('click', () => {
    node.children = node.children || [];
    node.children.push(createFolder('新子文件夹'));
    saveWorkspace();
    render();
    updateBookmarkCountUI();
  });

  row.addEventListener('dragstart', (e) => {
    dragId = node.id;
    e.dataTransfer.effectAllowed = 'move';
    row.style.opacity = '0.5';
  });
  row.addEventListener('dragend', () => {
    dragId = null;
    row.style.opacity = '1';
    document.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
  });
  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (dragId && dragId !== node.id) row.classList.add('drag-over');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    row.classList.remove('drag-over');
    if (!dragId || dragId === node.id) return;

    const moving = removeNode(tree, dragId);
    if (!moving) return;

    if (node.type === 'folder') {
      insertNode(tree, node.id, moving, 'inside');
    } else {
      insertNode(tree, node.id, moving, 'after');
    }
    saveWorkspace();
    render();
  });
}

function startRename(titleEl, node) {
  titleEl.contentEditable = 'true';
  titleEl.focus();
  const range = document.createRange();
  range.selectNodeContents(titleEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  const finish = () => {
    titleEl.contentEditable = 'false';
    node.title = titleEl.textContent.trim() || node.title;
    titleEl.textContent = node.title;
    titleEl.removeEventListener('blur', finish);
    titleEl.removeEventListener('keydown', onKey);
    saveWorkspace();
  };
  const onKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      titleEl.blur();
    }
    if (e.key === 'Escape') {
      titleEl.textContent = node.title;
      titleEl.blur();
    }
  };
  titleEl.addEventListener('blur', finish);
  titleEl.addEventListener('keydown', onKey);
}

async function pullFromBrowser(confirmOverwrite = true) {
  if (confirmOverwrite && tree.length) {
    const ok = confirm('将从浏览器重新拉取书签，未应用回浏览器的编辑会被覆盖。继续？');
    if (!ok) return;
  }
  setStatus('正在从浏览器同步书签…', 'loading');
  showProgress(0);
  $('#btnPull').disabled = true;
  try {
    tree = await syncFromBrowser();
    showProgress(50);
    const count = await saveBookmarkBaseline(tree);
    showProgress(80);
    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
    await chrome.storage.local.set({ lastSyncTime: timeStr });
    await saveWorkspace();
    showProgress(100);
    render();
    setStatus(`已同步 ${count} 条书签`, 'ok');
    setTimeout(hideProgress, 1500);
  } catch (err) {
    setStatus(err.message, 'error');
    hideProgress();
  } finally {
    $('#btnPull').disabled = false;
  }
}

$('#btnPull').addEventListener('click', () => pullFromBrowser(true));

$('#btnAddFolder').addEventListener('click', () => {
  tree.unshift(createFolder('新文件夹'));
  saveWorkspace();
  render();
});

$('#btnAi').addEventListener('click', async () => {
  if (!tree.length) {
    setStatus('请先点击「从浏览器同步」加载书签', 'error');
    return;
  }
  setStatus('AI 正在分析并整理…', 'loading');
  $('#btnAi').disabled = true;
  try {
    const settings = await loadAiSettings();
    const flat = flattenTree(tree);
    const urlMap = new Map(flat.map((x) => [x.url, x]));
    flat.forEach((x) => urlMap.set(x.id, x));

    const baseline = await getBookmarkBaseline();
    const aiResult = await organizeWithAi(flat, settings);
    const reorganized = buildFromAiStructure(aiResult, urlMap);
    const topFolders = tree.filter((n) => n.type === 'folder' && n.chromeId);
    const bar = topFolders.find(
      (n) => n.title === '书签栏' || n.title === 'Bookmarks bar'
    );
    if (bar) {
      bar.children = reorganized;
      tree = topFolders.length ? topFolders : tree;
    } else if (topFolders.length === 1) {
      topFolders[0].children = reorganized;
      tree = topFolders;
    } else {
      tree = reorganized;
    }

    const { added } = appendMissingBookmarks(tree, baseline);
    const check = validateBookmarkIntegrity(tree, baseline);
    if (!check.ok) {
      throw new Error(check.message);
    }

    await saveWorkspace();
    render();
    let msg = aiResult.summary || 'AI 整理完成，请检查后应用回浏览器';
    if (added > 0) msg += `（已自动补回 ${added} 条 AI 遗漏的书签）`;
    setStatus(`${msg} · 共 ${check.count} 条`, 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    $('#btnAi').disabled = false;
  }
});

let pendingChanges = null;

$('#btnApply').addEventListener('click', async () => {
  if (!tree.length) {
    setStatus('没有可应用的内容', 'error');
    return;
  }
  const baseline = await getBookmarkBaseline();
  const check = validateBookmarkIntegrity(tree, baseline);
  pendingChanges = check;

  const summary = $('#applySummary');
  const changePanel = $('#changePanel');
  const addedSection = $('#addedSection');
  const removedSection = $('#removedSection');
  const addedList = $('#addedList');
  const removedList = $('#removedList');
  const btnKeepAll = $('#btnKeepAll');

  // 摘要
  if (check.ok) {
    summary.innerHTML = `<span class="count-ok">✓ 书签数量一致</span>，将写回 ${check.count.current} 条书签`;
    changePanel.hidden = true;
    btnKeepAll.hidden = true;
  } else {
    summary.innerHTML = `<span class="count-warn">⚠ 检测到变更</span>：基准 ${check.count.baseline} 条 → 当前 ${check.count.current} 条`;
    changePanel.hidden = false;

    // 新增列表
    if (check.added.length) {
      addedSection.hidden = false;
      addedList.innerHTML = check.added.map((b) =>
        `<li class="added-item"><span class="change-title">${escapeHtml(b.title)}</span><span class="change-url">${escapeHtml(b.url)}</span></li>`
      ).join('');
    } else {
      addedSection.hidden = true;
    }

    // 删除列表
    if (check.removed.length) {
      removedSection.hidden = false;
      removedList.innerHTML = check.removed.map((b) =>
        `<li class="removed-item"><span class="change-title">${escapeHtml(b.title)}</span><span class="change-url">${escapeHtml(b.url)}</span></li>`
      ).join('');
    } else {
      removedSection.hidden = true;
    }

    btnKeepAll.hidden = !check.removed.length;
  }

  $('#applyDialog').showModal();
});

$('#btnKeepAll').addEventListener('click', async () => {
  if (!pendingChanges?.removed?.length) return;
  const baseline = await getBookmarkBaseline();
  const baselineMap = new Map(baseline.map((b) => [String(b.chromeId), b]));
  const bar = tree.find((n) => n.type === 'folder' && (n.title === '书签栏' || n.title === 'Bookmarks bar'));
  const target = bar || tree[0];
  if (!target) return;
  target.children = target.children || [];

  for (const r of pendingChanges.removed) {
    const b = baselineMap.get(r.chromeId);
    if (b) {
      target.children.push({
        id: `chrome_${b.chromeId}`,
        chromeId: String(b.chromeId),
        title: b.title || b.url,
        url: b.url,
        type: 'bookmark',
      });
    }
  }

  pendingChanges = validateBookmarkIntegrity(tree, await getBookmarkBaseline());
  $('#applyDialog').close();
  await saveWorkspace();
  render();
  setStatus(`已恢复 ${pendingChanges.removed?.length || 0} 条被删除的书签`, 'ok');
});

$('#btnCancelApply').addEventListener('click', () => {
  pendingChanges = null;
  $('#applyDialog').close();
});

$('#applyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#applyDialog').close();
  setStatus('正在写回浏览器书签…', 'loading');
  showProgress(0);
  try {
    const removeIds = pendingChanges?.removed?.map((r) => r.chromeId) || [];
    const result = await applyTreeToBrowser(cloneTree(tree), {
      removeChromeIds: removeIds,
      onProgress: (current, total) => {
        const pct = total > 0 ? (current / total) * 100 : 100;
        showProgress(pct, `${current}/${total}`);
      },
    });
    showProgress(100);
    await saveWorkspace();
    const removed = removeIds.length;
    let msg = `已应用回浏览器，共 ${result.bookmarkCount} 条书签`;
    if (removed > 0) msg += `（已移除 ${removed} 条）`;
    setStatus(msg, 'ok');
    setTimeout(hideProgress, 1500);
  } catch (err) {
    setStatus(err.message, 'error');
    hideProgress();
  }
  pendingChanges = null;
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

$('#chkAutoSync').addEventListener('change', async (e) => {
  await chrome.storage.local.set({ autoSyncOnOpen: e.target.checked });
});

let draftSettings = null;

function readFormSettings() {
  const form = $('#settingsForm');
  return {
    providerId: form.providerId.value,
    providerName: form.providerName.value.trim(),
    apiUrl: form.apiUrl.value.trim(),
    chatPath: form.chatPath.value.trim() || '/chat/completions',
    apiKey: form.apiKey.value,
    model: form.model.value.trim(),
    customProviders: draftSettings?.customProviders || [],
  };
}

function fillProviderSelect(settings) {
  const sel = $('#providerSelect');
  sel.innerHTML = '';

  const ogBuiltin = document.createElement('optgroup');
  ogBuiltin.label = '内置预设';
  getAllProviderOptions(settings).builtins.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    ogBuiltin.appendChild(opt);
  });
  sel.appendChild(ogBuiltin);

  const customs = settings.customProviders || [];
  if (customs.length) {
    const ogCustom = document.createElement('optgroup');
    ogCustom.label = '我的服务商';
    customs.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      ogCustom.appendChild(opt);
    });
    sel.appendChild(ogCustom);
  }

  const ogNew = document.createElement('optgroup');
  ogNew.label = '其他';
  const optCustom = document.createElement('option');
  optCustom.value = 'custom';
  optCustom.textContent = '+ 新建自定义…';
  ogNew.appendChild(optCustom);
  sel.appendChild(ogNew);

  sel.value = settings.providerId || 'openai';
}

function updateCustomBlockVisibility(providerId) {
  const block = $('#customProviderBlock');
  const btnDel = $('#btnDeleteCustomProvider');
  const isCustom = providerId === 'custom' || providerId.startsWith('user_');
  block.hidden = !isCustom;
  btnDel.hidden = !providerId.startsWith('user_');
}

function applyProviderToForm(providerId, settings) {
  const form = $('#settingsForm');
  updateCustomBlockVisibility(providerId);

  let preset = null;
  if (providerId.startsWith('user_')) {
    preset = settings.customProviders.find((p) => p.id === providerId);
    form.providerName.value = preset?.name || '';
  } else if (providerId === 'custom') {
    preset = getBuiltinProvider('custom');
    form.providerName.value = '';
  } else {
    preset = getBuiltinProvider(providerId);
  }

  if (preset) {
    if (preset.apiUrl !== undefined) form.apiUrl.value = preset.apiUrl;
    if (preset.chatPath) form.chatPath.value = preset.chatPath;
    if (preset.model) form.model.value = preset.model;
  }
}

$('#providerSelect').addEventListener('change', () => {
  const s = readFormSettings();
  s.customProviders = draftSettings?.customProviders || [];
  draftSettings = s;
  applyProviderToForm($('#providerSelect').value, draftSettings);
});

$('#btnSaveCustomProvider').addEventListener('click', () => {
  const form = $('#settingsForm');
  const name = form.providerName.value.trim() || '未命名服务商';
  const entry = {
    id: $('#providerSelect').value.startsWith('user_')
      ? $('#providerSelect').value
      : generateProviderId(),
    name,
    apiUrl: form.apiUrl.value.trim(),
    chatPath: form.chatPath.value.trim() || '/chat/completions',
    model: form.model.value.trim(),
  };

  const list = [...(draftSettings?.customProviders || [])];
  const idx = list.findIndex((p) => p.id === entry.id);
  if (idx >= 0) list[idx] = entry;
  else list.push(entry);

  draftSettings = { ...readFormSettings(), customProviders: list, providerId: entry.id };
  fillProviderSelect(draftSettings);
  $('#providerSelect').value = entry.id;
  setStatus(`已保存服务商「${name}」`, 'ok');
});

$('#btnDeleteCustomProvider').addEventListener('click', () => {
  const id = $('#providerSelect').value;
  if (!id.startsWith('user_')) return;
  const list = (draftSettings?.customProviders || []).filter((p) => p.id !== id);
  draftSettings = { ...readFormSettings(), customProviders: list, providerId: 'openai' };
  fillProviderSelect(draftSettings);
  applyProviderToForm('openai', draftSettings);
  setStatus('已删除自定义服务商', 'ok');
});

$('#btnSettings').addEventListener('click', async () => {
  draftSettings = await loadAiSettings();
  const form = $('#settingsForm');
  fillProviderSelect(draftSettings);
  form.providerId.value = draftSettings.providerId;
  form.apiUrl.value = draftSettings.apiUrl;
  form.chatPath.value = draftSettings.chatPath || '/chat/completions';
  form.apiKey.value = draftSettings.apiKey;
  form.model.value = draftSettings.model;
  updateCustomBlockVisibility(draftSettings.providerId);
  if (draftSettings.providerId.startsWith('user_')) {
    const p = draftSettings.customProviders.find((x) => x.id === draftSettings.providerId);
    form.providerName.value = p?.name || draftSettings.providerName || '';
  }
  $('#settingsDialog').showModal();
});

$('#btnCancelSettings').addEventListener('click', () => $('#settingsDialog').close());

$('#btnTestAi').addEventListener('click', async () => {
  setStatus('正在测试 AI 连接…', 'loading');
  try {
    const s = { ...readFormSettings(), customProviders: draftSettings?.customProviders || [] };
    await testAiConnection(s);
    setStatus('连接成功，API 可用', 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  }
});

$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const settings = {
    ...readFormSettings(),
    customProviders: draftSettings?.customProviders || [],
  };
  await saveAiSettings(settings);
  draftSettings = settings;
  $('#settingsDialog').close();
  setStatus('AI 服务商设置已保存', 'ok');
});

async function init() {
  await refreshRootFolderIds();
  const { autoSyncOnOpen = true } = await chrome.storage.local.get('autoSyncOnOpen');
  $('#chkAutoSync').checked = autoSyncOnOpen;

  if (autoSyncOnOpen) {
    await pullFromBrowser(false);
  } else {
    await loadWorkspace();
    if (!tree.length) {
      emptyHint.textContent = '点击「从浏览器同步」加载你的书签';
    }
  }
}

init();
