/** 内置预设（用户可选用，也可完全自定义） */
export const BUILTIN_PROVIDERS = [
  {
    id: 'openai',
    name: 'OpenAI',
    apiUrl: 'https://api.openai.com/v1',
    chatPath: '/chat/completions',
    model: 'gpt-4o-mini',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    apiUrl: 'https://api.deepseek.com/v1',
    chatPath: '/chat/completions',
    model: 'deepseek-chat',
  },
  {
    id: 'moonshot',
    name: 'Moonshot (Kimi)',
    apiUrl: 'https://api.moonshot.cn/v1',
    chatPath: '/chat/completions',
    model: 'moonshot-v1-8k',
  },
  {
    id: 'qwen',
    name: '通义千问',
    apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    chatPath: '/chat/completions',
    model: 'qwen-plus',
  },
  {
    id: 'zhipu',
    name: '智谱 AI',
    apiUrl: 'https://open.bigmodel.cn/api/paas/v4',
    chatPath: '/chat/completions',
    model: 'glm-4-flash',
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    apiUrl: 'https://api.siliconflow.cn/v1',
    chatPath: '/chat/completions',
    model: 'deepseek-ai/DeepSeek-V3',
  },
  {
    id: 'xiaomi-mimo',
    name: '小米 MiMo（国内）',
    apiUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    chatPath: '/chat/completions',
    model: 'mimo-v2-flash',
    useJsonMode: false,
  },
  {
    id: 'xiaomi-mimo-intl',
    name: '小米 MiMo（国际）',
    apiUrl: 'https://api.xiaomimimo.com/v1',
    chatPath: '/chat/completions',
    model: 'mimo-v2-flash',
    useJsonMode: false,
  },
  {
    id: 'custom',
    name: '自定义服务商',
    apiUrl: '',
    chatPath: '/chat/completions',
    model: '',
  },
];

export function generateProviderId() {
  return `user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export function getBuiltinProvider(id) {
  return BUILTIN_PROVIDERS.find((p) => p.id === id);
}

export function resolveProvider(settings) {
  const { providerId, customProviders = [] } = settings;

  if (providerId && providerId.startsWith('user_')) {
    const custom = customProviders.find((p) => p.id === providerId);
    if (custom) return { ...custom, isCustom: true };
  }

  const builtin = getBuiltinProvider(providerId || 'custom');
  return {
    ...builtin,
    apiUrl: settings.apiUrl || builtin?.apiUrl || '',
    model: settings.model || builtin?.model || '',
    chatPath: settings.chatPath || builtin?.chatPath || '/chat/completions',
    apiKey: settings.apiKey || '',
    useJsonMode: settings.useJsonMode ?? builtin?.useJsonMode,
    isCustom: providerId === 'custom' || providerId?.startsWith('user_'),
  };
}

/** 规范化基础地址（用户可能误填完整路径） */
export function normalizeApiBase(url) {
  let base = (url || '').trim().replace(/\/$/, '');
  if (!base) return '';
  // 已包含 chat/completions 则视为完整 endpoint，去掉路径部分
  if (/\/chat\/completions\/?$/i.test(base)) {
    base = base.replace(/\/chat\/completions\/?$/i, '');
  }
  return base.replace(/\/$/, '');
}

export function buildChatEndpoint(settings) {
  const p = resolveProvider(settings);
  const raw = p.apiUrl || settings.apiUrl || '';
  if (/\/chat\/completions\/?$/i.test(raw.trim())) {
    return raw.trim().replace(/\/$/, '');
  }
  const base = normalizeApiBase(raw);
  const path = (p.chatPath || settings.chatPath || '/chat/completions').replace(/^\/?/, '/');
  if (!base) throw new Error('请填写 API 基础地址');
  return `${base}${path}`;
}

export async function loadAiSettings() {
  const { aiSettings = {} } = await chrome.storage.sync.get('aiSettings');
  return normalizeSettings(aiSettings);
}

export function normalizeSettings(raw = {}) {
  return {
    providerId: raw.providerId || 'openai',
    apiUrl: raw.apiUrl ?? 'https://api.openai.com/v1',
    apiKey: raw.apiKey ?? '',
    model: raw.model ?? 'gpt-4o-mini',
    chatPath: raw.chatPath ?? '/chat/completions',
    customProviders: Array.isArray(raw.customProviders) ? raw.customProviders : [],
    providerName: raw.providerName ?? '',
  };
}

export async function saveAiSettings(settings) {
  await chrome.storage.sync.set({ aiSettings: normalizeSettings(settings) });
}

export function getAllProviderOptions(settings) {
  const builtins = BUILTIN_PROVIDERS.filter((p) => p.id !== 'custom').map((p) => ({
    ...p,
    group: 'builtin',
  }));
  const customs = (settings.customProviders || []).map((p) => ({
    ...p,
    group: 'custom',
  }));
  return { builtins, customs };
}
