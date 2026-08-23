// Central app state plus settings persistence
// with a 500ms debounce.

import { debounce } from './util.js';
import { PROVIDERS } from '../../shared/providers.js';
import { foldText } from '../../shared/text.js';

export { PROVIDERS };

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

// Structured sections survive repeated re-folding far better than free prose:
// each compression pass rewrites the summary, and prose drifts while labeled
// facts mostly carry over verbatim. Section names also give the lore keyword
// scan stable text to match against.
export const DEFAULT_COMPRESSION_PROMPT =
  'Compress the conversation into a structured brief for continuing it seamlessly. Use exactly these sections:\n' +
  'FACTS: established facts about the world and story, one per line.\n' +
  'CHARACTERS: each named character or person — current state, goals, and relationships.\n' +
  'THREADS: unresolved plot threads, promises, plans, and open questions.\n' +
  'SCENE: where the latest messages left off — location, time, who is present, what is happening.\n' +
  'Carry forward every name, decision, and emotional beat needed for continuity. ' +
  'When folding in an existing summary, keep its still-relevant lines and update the rest. ' +
  'No commentary outside the sections. Keep it under 350 words.';

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
  // In-flight generations, one per conversation. Each run owns its chat
  // object so background conversations keep receiving chunks after the user
  // switches away. run = {requestId, character, charName, file, chat, msg, configOverride}
  runs: new Map(), // requestId -> run
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

// --- Generation runs --------------------------------------------------------

export function convKey(charName, file) {
  return `${charName}/${file}`;
}

export function runFor(charName, file) {
  for (const run of state.runs.values()) {
    if (run.charName === charName && run.file === file) return run;
  }
  return null;
}

export function runForChat(chat) {
  if (!chat) return null;
  for (const run of state.runs.values()) {
    if (run.chat === chat) return run;
  }
  return null;
}

export function currentChatRun() {
  return runForChat(state.currentChat);
}

/** Whether the conversation on screen is generating. Background runs never block the UI. */
export function isCurrentChatGenerating() {
  return !!currentChatRun();
}

// --- Model context cache -------------------------------------------------------
// settings.modelContextCache: {"provider|modelId": tokens} — the advertised max
// context of models that have actually been used or picked. 0 records "the
// provider doesn't report one" so auto mode doesn't refetch on every send.

export function rememberModelContext(provider, model, contextSize) {
  if (!model) return;
  const cache = (state.settings.modelContextCache ??= {});
  const key = `${provider}|${model}`;
  const value = contextSize > 0 ? contextSize : 0;
  if (cache[key] !== value) {
    cache[key] = value;
    scheduleSettingsSave();
  }
}

/** Advertised max context for a model, 0 if known-unreported, undefined if never looked up. */
export function knownModelContext(provider, model) {
  return state.settings?.modelContextCache?.[`${provider}|${model}`];
}

// settings.modelPricingCache: {"provider|modelId": {inPerM, outPerM}} — USD per
// million tokens for models that have been listed or used. OpenRouter reports
// pricing in its model list; other providers stay unknown (no cost shown).

export function rememberModelPricing(provider, model, pricing) {
  if (!model || !pricing) return;
  const cache = (state.settings.modelPricingCache ??= {});
  const key = `${provider}|${model}`;
  const cur = cache[key];
  if (cur?.inPerM !== pricing.inPerM || cur?.outPerM !== pricing.outPerM) {
    cache[key] = { inPerM: pricing.inPerM, outPerM: pricing.outPerM };
    scheduleSettingsSave();
  }
}

export function knownModelPricing(provider, model) {
  return state.settings?.modelPricingCache?.[`${provider}|${model}`] ?? null;
}

// --- Unread conversations ----------------------------------------------------
// settings.unreadConversations: {"CharName/file.jsonl": true} — a reply landed
// while the conversation was backgrounded and hasn't been opened since.

export function markUnread(charName, file) {
  (state.settings.unreadConversations ??= {})[convKey(charName, file)] = true;
  scheduleSettingsSave();
}

export function clearUnread(charName, file) {
  const key = convKey(charName, file);
  if (state.settings?.unreadConversations?.[key]) {
    delete state.settings.unreadConversations[key];
    scheduleSettingsSave();
  }
}

export function isUnread(charName, file) {
  return !!state.settings?.unreadConversations?.[convKey(charName, file)];
}

/** Name/tag filter shared by the sidebar and the character library grid.
 *  Case- and accent-insensitive ("jose" matches "José"). */
export function filterCharacters(chars, query) {
  const q = foldText(query.trim());
  if (!q) return chars;
  return chars.filter(
    (c) =>
      foldText(c.card.data.name).includes(q) ||
      (c.card.data.tags ?? []).some((tag) => foldText(tag).includes(q))
  );
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

/**
 * Resolve the active provider/model/key/params into one request config.
 * `override` ({provider, model}, e.g. a conversation's remembered model) wins
 * over the globals when its provider is still usable (known + keyed).
 */
export function apiConfig(override = null) {
  const s = state.settings;
  let provider = s.activeAPI;
  let model = null;
  if (override?.provider && PROVIDERS[override.provider]) {
    const usable = !PROVIDERS[override.provider].requiresKey || !!s.apiKeys[override.provider];
    if (usable) {
      provider = override.provider;
      model = override.model || null;
    }
  }
  return {
    provider,
    apiKey: s.apiKeys[provider] ?? '',
    baseURL: s.baseURLs?.[provider] ?? '',
    model: model || s.models?.[provider] || PROVIDERS[provider].defaultModel,
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

// Depth-capped AND byte-capped: each snapshot is a full copy of the chat, so
// ten snapshots of a 20 MB conversation would quietly retain 200 MB.
const UNDO_MAX_DEPTH = 10;
const UNDO_MAX_BYTES = 50 * 1024 * 1024;

export function pushUndo() {
  if (!state.currentChat) return;
  state.undoStack.push(JSON.stringify(state.currentChat.messages));
  if (state.undoStack.length > UNDO_MAX_DEPTH) state.undoStack.shift();
  let bytes = state.undoStack.reduce((sum, s) => sum + s.length, 0);
  while (state.undoStack.length > 1 && bytes > UNDO_MAX_BYTES) {
    bytes -= state.undoStack.shift().length;
  }
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
