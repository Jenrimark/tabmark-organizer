chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((err) => {
    sendResponse({ error: err.message || String(err) });
  });
  return true;
});

async function handleMessage(message) {
  const { action, payload } = message;

  switch (action) {
    case 'ping':
      return { ok: true };
    case 'aiFetch':
      return aiFetch(payload);
    default:
      return { error: `Unknown action: ${action}` };
  }
}

async function aiFetch({ endpoint, headers, body }) {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON 响应 */
    }
    return {
      ok: res.ok,
      status: res.status,
      text,
      json,
    };
  } catch (err) {
    return { error: err.message || String(err) };
  }
}
