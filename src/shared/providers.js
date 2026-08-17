// Provider registry shared by the main process (request building in llm.js)
// and the renderer (labels, defaults, key links in state.js). One table so
// the two sides can't drift apart.
//
// Fields: label (UI name), baseURL (main-process default endpoint),
// requiresKey (what the UI must collect before sending), defaultModel,
// keyURL (where to get a key).

export const PROVIDERS = {
  openrouter: {
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    requiresKey: true,
    defaultModel: 'google/gemini-3.1-pro-preview',
    keyURL: 'https://openrouter.ai/keys',
  },
  nanogpt: {
    label: 'NanoGPT',
    baseURL: 'https://nano-gpt.com/api/v1',
    requiresKey: true,
    defaultModel: 'google/gemini-3.1-pro-preview',
    keyURL: 'https://nano-gpt.com/api',
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
};
