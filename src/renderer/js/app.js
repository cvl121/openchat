// App bootstrap: loads data, wires views together, applies appearance,
// handles routing, keyboard shortcuts, menu events, and first-run onboarding.

import { el, modal, toast } from './util.js';
import { state, loadAll, scheduleSettingsSave, saveSettingsSync, isChatMode } from './state.js';
import { initSidebar, renderSidebar } from './views/sidebar.js';
import {
  initChat,
  renderChat,
  selectCharacter,
  enterChatMode,
  selectConversation,
  deleteConversation,
  renameConversation,
  newChat,
  chatUndo,
  openHistory,
  openSearch,
  regenerateLast,
  stopGeneration,
} from './views/chat.js';
import { initCharacters, renderCharacters } from './views/characters.js';
import { initCharacterEditor, openCharacterEditor } from './views/characterEditor.js';
import { initPersonas, renderPersonas } from './views/personas.js';
import { initWorldInfo, renderWorldInfo } from './views/worldinfo.js';
import { initSettings, renderSettings, showSettingsSection } from './views/settings.js';

const VIEWS = {
  chat: renderChat,
  characters: renderCharacters,
  worlds: renderWorldInfo,
  personas: renderPersonas,
  settings: renderSettings,
};

const ROLEPLAY_VIEWS = ['characters', 'worlds', 'personas'];

function navigate(view) {
  if (isChatMode() && ROLEPLAY_VIEWS.includes(view)) return;
  state.view = view;
  VIEWS[view]();
  renderSidebar();
}

const APP_FONTS = {
  system: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  serif: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif",
  rounded: "ui-rounded, 'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Quicksand, sans-serif",
  mono: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
};

// Default chat colors (current + legacy) are dark-theme-tuned. When the user
// hasn't customized them, let each theme's stylesheet pick readable colors —
// otherwise the dark-tuned defaults render as faint gray on the light theme.
const DEFAULT_CHAT_COLORS = {
  '--quote-color': { key: 'quoteColor', defaults: ['#e8b75f'] },
  '--action-color': { key: 'actionColor', defaults: ['#9b8ec4', '#a89bd4'] },
  '--narrative-color': { key: 'narrativeColor', defaults: ['#c8c8d0', '#d8d8e0'] },
};

function applyAppearance() {
  const s = state.settings;
  const root = document.documentElement;
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = s.theme === 'dark' || (s.theme === 'system' && prefersDark);
  root.dataset.theme = dark ? 'dark' : 'light';
  for (const [cssVar, { key, defaults }] of Object.entries(DEFAULT_CHAT_COLORS)) {
    if (defaults.includes(s.chatStyle[key])) root.style.removeProperty(cssVar);
    else root.style.setProperty(cssVar, s.chatStyle[key]);
  }
  root.style.setProperty('--chat-font-size', `${s.chatStyle.fontSize}px`);
  root.style.setProperty('--sidebar-width', `${s.sidebarWidth ?? 280}px`);
  root.style.setProperty('--app-font-size', `${s.appFontSize ?? 13}px`);
  root.style.setProperty('--app-font', APP_FONTS[s.appFontFamily] ?? APP_FONTS.system);
  document.body.style.zoom = s.uiScale ?? 1.0;
}

async function reloadCharacters() {
  state.characters = await window.tavern.characters.list();
  // Keep the selected character object fresh (avatar/card edits)
  if (state.selectedCharacter) {
    const updated = state.characters.find((c) => c.filename === state.selectedCharacter.filename);
    if (updated) state.selectedCharacter = updated;
    else {
      state.selectedCharacter = null;
      state.currentChat = null;
      if (state.view === 'chat') renderChat();
    }
  }
  renderSidebar();
  if (state.view === 'chat') renderChat();
  else if (state.view === 'characters') renderCharacters();
}

async function reloadWorlds() {
  state.worlds = await window.tavern.worlds.list();
}

async function reloadPresets() {
  state.presets = await window.tavern.presets.list();
}

async function reloadAll() {
  await loadAll();
  renderSidebar();
}

function showOnboarding() {
  const content = el(
    'div',
    {},
    el('h2', {}, 'Welcome to OpenChat 🍻'),
    el('p', { style: { lineHeight: 1.6, marginBottom: '12px' } },
      'A fast, local-first AI chat app. Your conversations and settings live on your machine.'),
    el('p', { style: { lineHeight: 1.6, marginBottom: '12px' } },
      'OpenChat is bring-your-own-key: add an API key in Settings to start chatting (or use a local Ollama model, no key needed). ',
      el('strong', {}, 'OpenRouter'),
      ' is the recommended starting point — one key unlocks hundreds of models.'),
    el('ul', { style: { lineHeight: 1.8, paddingLeft: '20px', marginBottom: '14px', color: 'var(--text-dim)' } },
      el('li', {}, 'Chat mode (default): a clean assistant chat with file and image attachments'),
      el('li', {}, 'Story mode: role-play with character cards, personas, world lore, and swipes — switch in Settings → General'),
      el('li', {}, 'Streaming responses from OpenRouter, OpenAI, Claude, Gemini, or local Ollama'),
      el('li', {}, 'Regular mode keeps it simple; Advanced mode unlocks full sampler control')),
    el('div', { class: 'modal-actions' },
      el('button', {
        class: 'btn btn-primary',
        onclick: () => {
          overlay.close();
          navigate('settings');
        },
      }, 'Set Up API Key'))
  );
  const overlay = modal(content, {
    width: 520,
    onClose: () => {
      state.settings.onboardingComplete = true;
      scheduleSettingsSave();
    },
  });
}

function bindShortcuts() {
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') {
      // A modal owns Escape while it's open; don't also stop generation
      if (state.generating && !document.querySelector('.modal-overlay')) stopGeneration();
      return;
    }
    if (!mod) return;
    const inChat = state.view === 'chat';
    const key = e.key.toLowerCase();
    if (key === 'n' && e.shiftKey) {
      e.preventDefault();
      if (!isChatMode()) openCharacterEditor(null);
    } else if (key === 'n') {
      e.preventDefault();
      if (inChat) newChat();
    } else if (key === 'f') {
      e.preventDefault();
      if (inChat && state.selectedCharacter) openSearch();
    } else if (key === 'h' && e.shiftKey) {
      e.preventDefault();
      if (inChat) openHistory();
    } else if (key === 'r') {
      e.preventDefault();
      if (inChat) regenerateLast();
    } else if (key === 'z' && !e.shiftKey && state.view === 'chat') {
      const target = e.target;
      const editingText = target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement;
      if (!editingText) {
        e.preventDefault();
        chatUndo();
      }
    } else if (key === ',') {
      e.preventDefault();
      navigate('settings');
    }
  });
}

function bindMenuEvents() {
  const inChat = () => state.view === 'chat';
  window.tavern.on('menu:newChat', () => inChat() && newChat());
  window.tavern.on('menu:newCharacter', () => !isChatMode() && openCharacterEditor(null));
  window.tavern.on('menu:settings', () => navigate('settings'));
  window.tavern.on('menu:search', () => inChat() && state.selectedCharacter && openSearch());
  window.tavern.on('menu:history', () => inChat() && openHistory());
  window.tavern.on('menu:regenerate', () => inChat() && regenerateLast());
}

async function main() {
  await loadAll();
  applyAppearance();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyAppearance);

  const common = {
    navigate,
    renderSidebar,
    selectCharacter,
    selectConversation,
    deleteConversation,
    renameConversation,
    newChat,
    newCharacter: () => openCharacterEditor(null),
    editCharacter: (c) => openCharacterEditor(c),
    reloadCharacters,
    reloadWorlds,
    reloadPresets,
    reloadAll,
    applyAppearance,
    globalSearch: (q) => openSearch(q),
    openSettings: (sectionId) => {
      showSettingsSection(sectionId);
      navigate('settings');
    },
    onModeChange: switchAppMode,
  };

  initSidebar(common);
  initChat(common);
  initCharacters(common);
  initCharacterEditor(common);
  initPersonas(common);
  initWorldInfo(common);
  initSettings(common);

  bindShortcuts();
  bindMenuEvents();

  // Don't lose debounced settings changes when the window closes.
  // Synchronous IPC: an async invoke isn't guaranteed to reach main
  // before the window is torn down.
  window.addEventListener('beforeunload', () => saveSettingsSync());

  await initModeSelection();
  renderSidebar();

  if (!state.settings.onboardingComplete) showOnboarding();
  console.log(`[OpenChat] ready — mode: ${state.settings.appMode}, ${state.characters.length} characters, view: ${state.view}`);
}

/** Select the right chat for the current app mode (startup + mode switches). */
async function initModeSelection() {
  state.view = 'chat';
  if (isChatMode()) {
    await enterChatMode();
    return;
  }
  // Restore session: last selected character (O(1)), falling back to a
  // stat-only scan for the most recently chatted one.
  const remembered = state.characters.find(
    (c) => c.filename === state.settings.lastCharacterFilename
  );
  if (remembered) {
    await selectCharacter(remembered);
    return;
  }
  if (state.characters.length) {
    // Chat dirs are named with the same sanitization as storage.sanitizeFilename
    const sanitize = (name) => name.replace(/[/\\:*?"<>|]/g, '_').trim() || 'Unnamed';
    const lastDir = await window.tavern.chats.lastActive();
    const best = lastDir
      ? state.characters.find((c) => sanitize(c.card.data.name) === lastDir)
      : null;
    if (best) {
      await selectCharacter(best);
      return;
    }
  }
  state.selectedCharacter = null;
  state.currentChat = null;
  renderChat();
}

/** Settings → General → App Mode toggle lands here. */
async function switchAppMode() {
  if (state.generating) stopGeneration();
  state.selectedCharacter = null;
  state.currentChat = null;
  state.undoStack = [];
  await initModeSelection();
  renderSidebar();
  toast(
    isChatMode()
      ? 'Chat mode: a clean assistant chat'
      : 'Story mode: role-play characters, personas & world lore unlocked',
    'ok'
  );
}

main().catch((err) => {
  document.body.append(el('pre', { style: { padding: '60px 20px', color: 'red' } }, `Failed to start: ${err.stack}`));
});
