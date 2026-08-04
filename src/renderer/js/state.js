// Central app state plus settings persistence
// with a 500ms debounce.

import { debounce } from './util.js';

export const PROVIDERS = {
  openrouter: { label: 'OpenRouter', requiresKey: true, defaultModel: 'google/gemini-3.1-pro-preview', keyURL: 'https://openrouter.ai/keys' },
  openai: { label: 'OpenAI', requiresKey: true, defaultModel: 'gpt-4o-mini', keyURL: 'https://platform.openai.com/api-keys' },
  claude: { label: 'Anthropic Claude', requiresKey: true, defaultModel: 'claude-sonnet-4-6', keyURL: 'https://console.anthropic.com/' },
  gemini: { label: 'Google Gemini', requiresKey: true, defaultModel: 'gemini-3.1-pro-preview', keyURL: 'https://aistudio.google.com/apikey' },
  deepseek: { label: 'DeepSeek', requiresKey: true, defaultModel: 'deepseek-chat', keyURL: 'https://platform.deepseek.com/api_keys' },
  kimi: { label: 'Kimi (Moonshot AI)', requiresKey: true, defaultModel: 'kimi-latest', keyURL: 'https://platform.moonshot.ai/console/api-keys' },
  qwen: { label: 'Qwen (Alibaba)', requiresKey: true, defaultModel: 'qwen-plus', keyURL: 'https://modelstudio.console.alibabacloud.com/#/api-key' },
  ollama: { label: 'Ollama (local)', requiresKey: false, defaultModel: 'llama3.1', keyURL: 'https://ollama.ai' },
  custom: { label: 'Custom (OpenAI-compatible)', requiresKey: false, requiresBaseURL: true, defaultModel: '', keyURL: null },
};

// Chat mode talks to a built-in virtual assistant instead of a character
// card. Conversations are stored like any character's chats, keyed by name.
export const ASSISTANT_CHARACTER = {
  filename: null,
  virtual: true,
  mtime: 0,
  card: {
    data: {
      name: 'Assistant',
      description: '',
      personality: '',
      scenario: '',
      first_mes: '',
      alternate_greetings: [],
      mes_example: '',
      system_prompt: '',
      post_history_instructions: '',
      tags: [],
    },
  },
};

export const DEFAULT_CHAT_SYSTEM_PROMPT =
  'You are a helpful assistant. Answer clearly and concisely, using markdown when it helps.';

export const DEFAULT_COMPRESSION_PROMPT =
  'Summarize the conversation so far into a compact brief that preserves every fact, name, decision, ' +
  'emotional beat, and unresolved thread needed to continue seamlessly. Write a factual summary, not prose. ' +
  'Keep it under 300 words.';

export const state = {
  settings: null,
  characters: [], // [{filename, card}]
  worlds: [],
  personas: [],
  presets: [],
  conversations: [], // chat mode: [{file, metadata, messageCount, mtime, preview}]
  selectedCharacter: null, // {filename, card}
  currentChat: null, // {file, metadata, messages}
  view: 'chat', // chat | characters | worlds | personas | settings
  generating: false,
  activeRequestId: null,
  undoStack: [], // snapshots of currentChat.messages (max 10)
  devLog: [], // {time, type: 'REQ'|'RES'|'ERR'|'INFO', message}
};

const saveNow = () => window.tavern.settings.save(state.settings);
export const scheduleSettingsSave = debounce(saveNow, 500);
export const saveSettingsNow = saveNow;
// Blocking save for beforeunload, where async IPC may never arrive
export const saveSettingsSync = () => window.tavern.settings.saveSync(state.settings);

export async function loadAll() {
  const [settings, characters, worlds, personas, presets] = await Promise.all([
    window.tavern.settings.load(),
    window.tavern.characters.list(),
    window.tavern.worlds.list(),
    window.tavern.personas.list(),
    window.tavern.presets.list(),
  ]);
  state.settings = settings;
  state.characters = characters;
  state.worlds = worlds;
  state.personas = personas;
  state.presets = presets;
}

export function isAdvanced() {
  return state.settings?.uiMode === 'advanced';
}

/** Chat mode (general assistant) unless the user switched to role play. */
export function isChatMode() {
  return state.settings?.appMode !== 'roleplay';
}

export function chatSystemPrompt() {
  return state.settings?.chatSystemPrompt?.trim() || DEFAULT_CHAT_SYSTEM_PROMPT;
}

/** Resolve the active provider/model/key/params into one request config. */
export function apiConfig() {
  const s = state.settings;
  const provider = s.activeAPI;
  return {
    provider,
    apiKey: s.apiKeys[provider] ?? '',
    baseURL: s.baseURLs?.[provider] ?? '',
    model: s.models?.[provider] || PROVIDERS[provider].defaultModel,
    params: { ...s.generationParams },
    requestImages: !!s.requestImageOutput,
  };
}

/** Config for the 🎨 image-generation button: dedicated provider/model, or the chat one. */
export function imageApiConfig() {
  const s = state.settings;
  const provider = s.imageGen?.provider || s.activeAPI;
  return {
    provider,
    apiKey: s.apiKeys[provider] ?? '',
    baseURL: s.baseURLs?.[provider] ?? '',
    model: s.imageGen?.model || s.models?.[provider] || PROVIDERS[provider].defaultModel,
    params: { ...s.generationParams },
    requestImages: true,
  };
}

export function activePersona() {
  if (isChatMode()) return null; // personas are a role-play concept
  const s = state.settings;
  // Per-character persona override wins
  const charFile = state.selectedCharacter?.filename;
  const overrideId = charFile ? s.characterPersonas?.[charFile] : null;
  return (
    state.personas.find((p) => p.id === overrideId) ??
    state.personas.find((p) => p.id === s.activePersonaId) ??
    state.personas[0] ??
    null
  );
}

export function userName() {
  return activePersona()?.name || state.settings.userName || 'User';
}

export function devLog(type, message) {
  if (!state.settings?.developerMode) return;
  state.devLog.push({ time: new Date().toISOString(), type, message: String(message).slice(0, 4000) });
  if (state.devLog.length > 500) state.devLog.splice(0, state.devLog.length - 500);
  document.dispatchEvent(new CustomEvent('devlog-updated'));
}

export function pushUndo() {
  if (!state.currentChat) return;
  state.undoStack.push(JSON.stringify(state.currentChat.messages));
  if (state.undoStack.length > 10) state.undoStack.shift();
}

export function popUndo() {
  if (!state.undoStack.length || !state.currentChat) return false;
  state.currentChat.messages = JSON.parse(state.undoStack.pop());
  return true;
}

export function avatarURL(character) {
  if (!character || character.virtual) return null;
  // Cache-bust on mtime so edited avatars refresh
  const v = character.mtime ? `?v=${Math.round(character.mtime)}` : '';
  return `tavern://data/characters/${encodeURIComponent(character.filename)}${v}`;
}

export function personaAvatarURL(persona) {
  if (!persona?.avatarFilename) return null;
  return `tavern://data/User%20Avatars/${encodeURIComponent(persona.avatarFilename)}`;
}
