import {
  loadAiSettings,
  saveAiSettings,
  buildChatEndpoint,
  resolveProvider,
  normalizeSettings,
} from './providers.js';

export { loadAiSettings, saveAiSettings, normalizeSettings };

const SYSTEM_PROMPT = `你是浏览器书签整理助手。用户会给你当前书签/标签页的扁平或树形列表。
请根据标题、URL、路径和摘要，输出更清晰的文件夹结构与书签命名。

必须只返回合法 JSON，不要 markdown，不要代码块，格式如下：
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

规则：
- 保留所有 URL，不要丢失链接
- 标题简洁中文优先（原页面是英文可保留或翻译）
- 文件夹层级 2-4 层为宜
- 合并明显重复或同站条目`;

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
