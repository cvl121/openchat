// App bootstrap: loads data, wires views together, applies appearance,
// handles routing, keyboard shortcuts, menu events, and first-run onboarding.

import { el, clear, modal, toast } from './util.js';
import { sanitizeFilename } from '../../shared/filenames.js';
import { t, setLocale, resolveLocale } from '../../shared/i18n.js';
import { state, loadAll, scheduleSettingsSave, saveSettingsNow, saveSettingsSync, isChatMode, isCurrentChatGenerating, PROVIDERS } from './state.js';
import { initSidebar, renderSidebar, toggleSidebar } from './views/sidebar.js';
import {
  initChat,
  renderChat,
  clearRenderCache,
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
  cycleConversation,
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

// CJK faces are listed after the Latin ones so Chinese/Japanese text gets a
// matching style (mincho for serif, maru gothic for rounded) instead of the
// browser's default gothic fallback.
const APP_FONTS = {
  system: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  serif: "'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Hiragino Mincho ProN', 'Songti SC', 'Noto Serif CJK SC', serif",
  rounded: "ui-rounded, 'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Quicksand, sans-serif",
  mono: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
};

/** Resolve and apply the UI language; the main process mirrors it for the menu. */
function applyLocale() {
  const locale = resolveLocale(state.settings.language, navigator.language);
  setLocale(locale);
  document.documentElement.lang = locale;
  window.tavern.i18n?.setLocale?.(locale);
  clearRenderCache(); // cached message HTML embeds localized copy-buttons
}

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

/**
 * First-run wizard: pick a provider, paste a key (or point at a server),
 * test, done — without a detour through the full Settings page.
 */
function showOnboarding() {
  const s = state.settings;
  const body = el('div', {});
  const overlay = modal(el('div', {}, el('h2', {}, t('onboarding.title')), body), {
    width: 540,
    onClose: () => {
      s.onboardingComplete = true;
      scheduleSettingsSave();
    },
  });

  function stepProvider() {
    clear(body);
    body.append(
      el('p', { style: { lineHeight: 1.6, marginBottom: '12px' } }, t('onboarding.intro')),
      ...Object.entries(PROVIDERS).map(([id, p]) =>
        el(
          'button',
          { class: 'onboarding-provider list-row', onclick: () => stepConnect(id) },
          el('div', { class: 'list-main' },
            el('div', { class: 'list-title' }, p.label, id === 'openrouter' ? ' ⭐' : ''),
            el('div', { class: 'list-sub' }, t(`onboarding.blurb.${id}`)))
        )
      ),
      el('div', { class: 'modal-actions' },
        el('button', { class: 'btn', onclick: () => overlay.close() }, t('onboarding.skip')))
    );
  }

  function stepConnect(providerId) {
    clear(body);
    const provider = PROVIDERS[providerId];
    const keyInput = el('input', {
      type: 'password',
      placeholder: provider.requiresKey
        ? t('settings.keyPlaceholder', { label: provider.label })
        : t('settings.keyPlaceholderOptional'),
    });
    const urlInput = el('input', { type: 'text', placeholder: 'http://localhost:1234/v1' });
    const status = el('p', { class: 'hint', style: { minHeight: '18px', marginTop: '10px' } });

    body.append(el('p', { style: { lineHeight: 1.6, marginBottom: '12px' } }, el('strong', {}, provider.label)));
    if (provider.requiresBaseURL) {
      body.append(el('div', { class: 'form-row' }, el('label', {}, t('settings.serverURL')), urlInput));
    }
    if (providerId === 'ollama') {
      body.append(el('p', { class: 'hint', style: { marginBottom: '10px' } }, t('onboarding.ollamaHint')));
    } else {
      body.append(
        el('div', { class: 'form-row' },
          el('label', {}, provider.requiresKey ? t('settings.apiKey') : t('settings.apiKeyOptional')),
          keyInput,
          provider.keyURL
            ? el('div', { class: 'hint' },
                t('onboarding.getKeyAt'),
                el('a', {
                  href: '#',
                  style: { color: 'var(--accent)' },
                  onclick: (e) => {
                    e.preventDefault();
                    window.tavern.misc.openExternal(provider.keyURL);
                  },
                }, provider.keyURL))
            : null)
      );
    }
    body.append(status);

    const apply = () => {
      s.activeAPI = providerId;
      if (keyInput.value.trim()) s.apiKeys[providerId] = keyInput.value.trim();
      if (provider.requiresBaseURL && urlInput.value.trim()) {
        s.baseURLs = s.baseURLs ?? {};
        s.baseURLs[providerId] = urlInput.value.trim();
      }
    };
    const finish = () => {
      overlay.close();
      toast(t('onboarding.done'), 'ok');
    };
    body.append(
      el('div', { class: 'modal-actions' },
        el('button', { class: 'btn', onclick: () => stepProvider() }, t('common.back')),
        el('button', {
          class: 'btn btn-primary',
          onclick: async (e) => {
            const btn = e.currentTarget;
            apply();
            await saveSettingsNow();
            btn.disabled = true;
            status.textContent = t('onboarding.testing');
            try {
              const config = {
                provider: providerId,
                apiKey: s.apiKeys[providerId] ?? '',
                baseURL: s.baseURLs?.[providerId] ?? '',
                model: s.models?.[providerId] || provider.defaultModel,
                params: { ...s.generationParams },
              };
              // A custom server has no default model — grab its first one
              if (!config.model) {
                const models = await window.tavern.llm.models(config).catch(() => []);
                if (models[0]) {
                  config.model = models[0].id;
                  s.models = s.models ?? {};
                  s.models[providerId] = models[0].id;
                  scheduleSettingsSave();
                }
              }
              const result = await window.tavern.llm.test(config);
              status.textContent = t('onboarding.connected', { ms: result.latencyMs });
              setTimeout(finish, 600);
            } catch (err) {
              status.textContent = `✗ ${err.message}`;
              btn.disabled = false;
            }
          },
        }, t('onboarding.testFinish')),
        el('button', { class: 'btn', onclick: () => { apply(); saveSettingsNow(); finish(); } }, t('common.finish')))
    );
    (provider.requiresBaseURL ? urlInput : keyInput).focus();
  }

  stepProvider();
}

function bindShortcuts() {
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') {
      // A modal owns Escape while it's open; don't also stop generation
      if (isCurrentChatGenerating() && !document.querySelector('.modal-overlay')) stopGeneration();
      return;
    }
    // Ctrl+Tab / Ctrl+Shift+Tab: next / previous conversation
    if (e.key === 'Tab' && e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      cycleConversation(e.shiftKey ? -1 : 1);
      return;
    }
    if (!mod) return;
    const inChat = state.view === 'chat';
    const key = e.key.toLowerCase();
    if (key === '\\') {
      e.preventDefault();
      toggleSidebar();
    } else if (key === 'n' && e.shiftKey) {
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

/** Dismissible banner shown when a newer release is found on GitHub. */
function showUpdateBanner({ version, url }) {
  document.getElementById('update-banner')?.remove();
  const banner = el(
    'div',
    { id: 'update-banner', class: 'update-banner' },
    el('span', {}, t('updates.available', { version })),
    el('button', { class: 'btn btn-primary', onclick: () => window.tavern.misc.openExternal(url) }, t('updates.viewRelease')),
    el('button', {
      class: 'btn',
      onclick: () => {
        state.settings.skippedUpdateVersion = version;
        scheduleSettingsSave();
        banner.remove();
      },
    }, t('updates.skipVersion')),
    el('button', { class: 'update-banner-close', title: t('common.dismiss'), onclick: () => banner.remove() }, '×')
  );
  document.body.append(banner);
}

function bindMenuEvents() {
  const inChat = () => state.view === 'chat';
  window.tavern.on('menu:newChat', () => inChat() && newChat());
  window.tavern.on('menu:newCharacter', () => !isChatMode() && openCharacterEditor(null));
  window.tavern.on('menu:settings', () => navigate('settings'));
  window.tavern.on('menu:search', () => inChat() && state.selectedCharacter && openSearch());
  window.tavern.on('menu:history', () => inChat() && openHistory());
  window.tavern.on('menu:regenerate', () => inChat() && regenerateLast());
  window.tavern.on('updates:available', showUpdateBanner);
}

async function main() {
  await loadAll();
  applyLocale();
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
    applyLocale,
    globalSearch: (q) => openSearch(q, 'all'), // sidebar search spans every conversation
    openSettings: (sectionId) => {
      showSettingsSection(sectionId);
      navigate('settings');
    },
    onModeChange: switchAppMode,
    showUpdateBanner,
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
    // Chat dirs are named by sanitized character name (see storage.chatsDirFor).
    // NFC-normalize both sides: macOS returns NFD names from readdir, so an
    // accented or CJK character name would never match its own directory.
    const lastDir = await window.tavern.chats.lastActive();
    const best = lastDir
      ? state.characters.find(
          (c) => sanitizeFilename(c.card.data.name).normalize('NFC') === lastDir.normalize('NFC')
        )
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
  // In-flight runs keep streaming across the mode switch; they persist and
  // mark their conversations unread on their own when they finish.
  state.selectedCharacter = null;
  state.currentChat = null;
  state.undoStack = [];
  await initModeSelection();
  renderSidebar();
  toast(isChatMode() ? t('mode.chatToast') : t('mode.storyToast'), 'ok');
}

main().catch((err) => {
  document.body.append(el('pre', { style: { padding: '60px 20px', color: 'red' } }, `Failed to start: ${err.stack}`));
});
