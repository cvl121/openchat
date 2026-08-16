// Provider registry shared by the main process (request building in llm.js)
// and the renderer (labels, defaults, key links in state.js). One table so
// the two sides can't drift apart.
//
// Fields: label (UI name), baseURL (main-process default endpoint),
// requiresKey / requiresBaseURL (what the UI must collect before sending),
// defaultModel, keyURL (where to get a key; null when there isn't one).

export const PROVIDERS = {
  openrouter: {
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    requiresKey: true,
    defaultModel: 'google/gemini-3.1-pro-preview',
    keyURL: 'https://openrouter.ai/keys',
  },
  openai: {
    label: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    requiresKey: true,
    defaultModel: 'gpt-4o-mini',
    keyURL: 'https://platform.openai.com/api-keys',
  },
  claude: {
    label: 'Anthropic Claude',
    baseURL: 'https://api.anthropic.com/v1',
    requiresKey: true,
    defaultModel: 'claude-sonnet-4-6',
    keyURL: 'https://console.anthropic.com/',
  },
  gemini: {
    label: 'Google Gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    requiresKey: true,
    defaultModel: 'gemini-3.1-pro-preview',
    keyURL: 'https://aistudio.google.com/apikey',
  },
  deepseek: {
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    requiresKey: true,
    defaultModel: 'deepseek-chat',
    keyURL: 'https://platform.deepseek.com/api_keys',
  },
  kimi: {
    label: 'Kimi (Moonshot AI)',
    baseURL: 'https://api.moonshot.ai/v1',
    requiresKey: true,
    defaultModel: 'kimi-latest',
    keyURL: 'https://platform.moonshot.ai/console/api-keys',
  },
  qwen: {
    label: 'Qwen (Alibaba)',
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    requiresKey: true,
    defaultModel: 'qwen-plus',
    keyURL: 'https://modelstudio.console.alibabacloud.com/#/api-key',
  },
  ollama: {
    label: 'Ollama (local)',
    baseURL: 'http://localhost:11434/v1',
    requiresKey: false,
    defaultModel: 'llama3.1',
    keyURL: 'https://ollama.ai',
  },
  custom: {
    label: 'Custom (OpenAI-compatible)',
    baseURL: '',
    requiresKey: false,
    requiresBaseURL: true,
    defaultModel: '',
    keyURL: null,
  },
};
