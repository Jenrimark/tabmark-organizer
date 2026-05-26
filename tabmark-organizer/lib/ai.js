import {
  loadAiSettings,
  saveAiSettings,
  buildChatEndpoint,
  resolveProvider,
  normalizeSettings,
} from './providers.js';

export { loadAiSettings, saveAiSettings, normalizeSettings, renameWithAi };

const RENAME_SYSTEM_PROMPT = `你是浏览器书签重命名助手。用户会给你书签列表以及命名偏好要求。
你的唯一任务是为每个书签生成更好的标题（title），严禁做任何其他改动。

## 底线规则（违反即失败）：
- 严禁删除、新增、合并或遗漏任何书签：输出条数必须与输入完全一致
- 严禁更改 URL、文件夹结构、书签顺序或分类
- 只允许更改每个书签的 title 字段
- 每个输入的 url 必须原样出现在输出中，不可修改

## 输出格式：
必须只返回合法 JSON，不要 markdown，不要代码块。
{
  "renames": [
    { "url": "https://example.com", "title": "新标题" }
  ]
}

## 命名参考（除非用户在自定义要求中另有指示）：
- 采用格式：分类 | 描述，如「开发工具 | GitHub 代码托管」
- 标题简洁中文优先（原页面是英文可保留或翻译）
- 突出网站核心用途，便于日后搜索定位
- 标题末尾可附带关键词标签以便检索，用空格分隔`;

const SYSTEM_PROMPT = `你是浏览器书签整理助手。用户会给你当前书签/标签页的扁平或树形列表。
请根据标题、URL、路径和摘要，输出更清晰的文件夹结构与书签命名。

## 整理理念
书签是网站的快捷入口，核心价值在于「快」——一眼望见，即可触达。
收藏不等于有用，好的书签管理应让用户在需要时能瞬间找到所需资料，
而不是在层层嵌套的目录中搜寻。

## 必须只返回合法 JSON，不要 markdown，不要代码块，格式如下：
{
  "folders": [
    {
      "title": "文件夹名",
      "children": [
        { "title": "书签标题", "url": "https://..." },
        {
          "title": "子文件夹",
          "children": [ ... ]
        }
      ]
    }
  ],
  "summary": "一句话说明整理思路"
}

## 规则（必须严格遵守）：
### 数据完整性
- 严禁删除、合并或省略任何书签：输出中的书签条数必须与输入完全一致
- 每个输入 URL 必须且只能出现一次，url 字段保持原样
- 仅允许：重命名 title、调整文件夹层级与分类、调整排序
- 禁止：合并重复链接、删除看似无用的书签、用新 URL 替换原 URL

### 结构原则
- 使用单层文件夹结构，不嵌套子文件夹

### 命名规范
- 采用格式：分类 | 描述，如「开发工具 | GitHub 代码托管」「技术文章 | Vue3 组合式 API 教程」
- 分类词 2-4 个字，用于快速辨识用途，如：开发工具、技术文档、参考资源、学习资料、效率工具、设计素材、生活服务、娱乐休闲
- 描述部分精准简要概括网站核心用途
- 标题末尾可附带关键词标签以便检索，用空格分隔，如「技术文章 | Vue3 组合式 API 教程 vue frontend」
- 标题简洁中文优先（原页面是英文可保留或翻译）
- 同类书签保持命名格式一致，便于批量识别

### 文件夹原则
- 目录名按用途或领域划分，方便记忆，例如：工作、学习、开发、生活、阅读清单
- 将高频访问的工具类书签放在靠前位置
- 时效性强的内容（新闻、临时参考）归入「稍后阅读」类目录，而非长期收藏
- 阅读清单：暂时没空阅读但不想丢失的内容，归入「稍后阅读」目录

### 检索友好
- 命名应包含关键词，方便日后通过搜索快速定位`;

function formatFetchError(err, endpoint) {
  const msg = err?.message || String(err);
  if (msg === 'Failed to fetch' || msg.includes('NetworkError')) {
    return (
      `无法连接 API（${endpoint}）。` +
      '请检查：① 已在 chrome://extensions 重新加载扩展；② API 地址与网络；③ Key 是否有效。' +
      '小米 MiMo 模型请填 mimo-v2-flash 或 mimo-v2-pro。'
    );
  }
  return msg;
}

function parseApiError(status, errText) {
  try {
    const j = JSON.parse(errText);
    const e = j.error;
    if (typeof e === 'string') return e;
    if (e?.message) {
      const extra = e.param ? ` (${e.param})` : '';
      return `${e.message}${extra}`;
    }
  } catch {
    /* ignore */
  }
  return errText.slice(0, 300) || `HTTP ${status}`;
}

/** 经 background 发起请求，避免侧栏权限/CORS 问题 */
async function aiFetch(endpoint, headers, body) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: 'aiFetch', payload: { endpoint, headers, body } },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response?.error) {
          reject(new Error(response.error));
          return;
        }
        resolve(response);
      }
    );
  });
}

function buildRequestBody(settings, messages, extra = {}) {
  const resolved = resolveProvider(settings);
  const body = {
    model: resolved.model || settings.model || 'gpt-4o-mini',
    temperature: 0.3,
    messages,
    ...extra,
  };
  const useJson =
    resolved.useJsonMode !== false && settings.useJsonMode !== false;
  if (useJson) {
    body.response_format = { type: 'json_object' };
  }
  return body;
}

export async function organizeWithAi(flatItems, settings) {
  const resolved = resolveProvider(settings);
  const { apiKey } = resolved;

  if (!apiKey?.trim()) {
    throw new Error('请先在设置中填写 API Key');
  }

  const userContent = JSON.stringify(
    {
      items: flatItems.map(({ title, url, path, snippet, type }) => ({
        title,
        url,
        path,
        snippet: (snippet || '').slice(0, 200),
        type,
      })),
    },
    null,
    2
  );

  const endpoint = buildChatEndpoint(settings);
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey.trim()}`,
  };

  const body = buildRequestBody(settings, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ]);

  let data;
  try {
    data = await aiFetch(endpoint, headers, body);
  } catch (err) {
    throw new Error(formatFetchError(err, endpoint));
  }

  if (!data.ok) {
    throw new Error(`AI 请求失败: ${parseApiError(data.status, data.text)}`);
  }

  const content = data.json?.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI 返回内容为空');

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('无法解析 AI 返回的 JSON');
    parsed = JSON.parse(match[0]);
  }

  return parsed;
}

export async function testAiConnection(settings) {
  const resolved = resolveProvider(settings);
  if (!resolved.apiKey?.trim()) throw new Error('请先填写 API Key');

  const endpoint = buildChatEndpoint(settings);
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${resolved.apiKey.trim()}`,
  };

  const body = buildRequestBody(
    { ...settings, useJsonMode: false },
    [{ role: 'user', content: 'ping' }],
    { max_tokens: 8 }
  );

  let data;
  try {
    data = await aiFetch(endpoint, headers, body);
  } catch (err) {
    throw new Error(formatFetchError(err, endpoint));
  }

  if (!data.ok) {
    throw new Error(parseApiError(data.status, data.text));
  }

  return true;
}

export async function renameWithAi(flatItems, settings, customPrompt) {
  const resolved = resolveProvider(settings);
  const { apiKey } = resolved;

  if (!apiKey?.trim()) {
    throw new Error('请先在设置中填写 API Key');
  }

  const userContent = JSON.stringify(
    {
      custom_requirement: customPrompt || '（无自定义要求，使用默认命名规则）',
      items: flatItems.map(({ title, url, path, snippet }) => ({
        title,
        url,
        path,
        snippet: (snippet || '').slice(0, 200),
      })),
    },
    null,
    2
  );

  const endpoint = buildChatEndpoint(settings);
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey.trim()}`,
  };

  const body = buildRequestBody(settings, [
    { role: 'system', content: RENAME_SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ]);

  let data;
  try {
    data = await aiFetch(endpoint, headers, body);
  } catch (err) {
    throw new Error(formatFetchError(err, endpoint));
  }

  if (!data.ok) {
    throw new Error(`AI 请求失败: ${parseApiError(data.status, data.text)}`);
  }

  const content = data.json?.choices?.[0]?.message?.content;
  if (!content) throw new Error('AI 返回内容为空');

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('无法解析 AI 返回的 JSON');
    parsed = JSON.parse(match[0]);
  }

  return parsed;
}
