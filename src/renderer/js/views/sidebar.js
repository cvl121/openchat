// Conversation sidebar: search, pinned + recent characters, bottom navigation.
// Chat mode swaps the character list for the assistant's conversation list.

import { el, clear, relativeDate, toast, confirmDialog, promptDialog, stripMarkdown } from '../util.js';
import { state, avatarURL, scheduleSettingsSave, isChatMode, runFor, isUnread, filterCharacters, ASSISTANT_CHARACTER } from '../state.js';
import { avatar, streamingDots } from '../components.js';
import { t } from '../../../shared/i18n.js';
import { foldText, truncateChars } from '../../../shared/text.js';

const ASSISTANT_NAME = ASSISTANT_CHARACTER.card.data.name;

let callbacks = {}; // { selectCharacter, selectConversation, newChat, navigate, newCharacter, editCharacter, globalSearch }

export function initSidebar(cb) {
  callbacks = cb;
  renderCollapseControls();
  renderSearch();
  renderNav();
  renderSidebar();

  // Drag-and-drop character import (role-play mode)
  const sidebar = document.getElementById('sidebar');
  sidebar.addEventListener('dragover', (e) => e.preventDefault());
  sidebar.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (isChatMode()) return; // chat drops are handled by the chat view
    for (const file of e.dataTransfer.files) {
      const path = window.tavern.misc?.pathForFile?.(file) ?? file.path;
      if (!path) continue;
      try {
        await window.tavern.characters.import(path);
        toast(t('sidebar.imported', { name: file.name }), 'ok');
      } catch (err) {
        toast(t('common.importFailed', { msg: err.message }), 'error');
      }
    }
    await callbacks.reloadCharacters?.();
  });

  // Sidebar resize
  const resizer = document.getElementById('sidebar-resizer');
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    // The toggle button rides the sidebar's right edge; suspend its easing
    // so it tracks the drag 1:1
    document.body.classList.add('sidebar-resizing');
    const move = (ev) => {
      const width = Math.min(480, Math.max(200, ev.clientX));
      document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
      state.settings.sidebarWidth = width;
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('sidebar-resizing');
      scheduleSettingsSave();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

// Collapsible sidebar: a single toggle riding the panel's right edge; when
// the panel slides out it docks at the window's top-left (persisted in
// settings). CSS positions it per platform — macOS docks it beside the
// traffic lights, other OSes get the free corner.
const IS_MAC = navigator.platform.includes('Mac');
const SHORTCUT_HINT = IS_MAC ? '⌘\\' : 'Ctrl+\\';

function renderCollapseControls() {
  document.body.classList.toggle('platform-mac', IS_MAC);
  const btn = el('button', { id: 'sidebar-toggle', class: 'btn-icon', onclick: toggleSidebar });
  btn.innerHTML =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/></svg>';
  document.body.append(btn);
  applySidebarCollapsed();
}

export function toggleSidebar() {
  state.settings.sidebarCollapsed = !state.settings.sidebarCollapsed;
  scheduleSettingsSave();
  applySidebarCollapsed();
}

function applySidebarCollapsed() {
  const collapsed = !!state.settings?.sidebarCollapsed;
  document.getElementById('app').classList.toggle('sidebar-collapsed', collapsed);
  const btn = document.getElementById('sidebar-toggle');
  const label = t(collapsed ? 'sidebar.showSidebar' : 'sidebar.hideSidebar', { hint: SHORTCUT_HINT });
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.setAttribute('aria-expanded', String(!collapsed));
}

let searchQuery = '';

function renderSearch() {
  const host = document.getElementById('sidebar-search');
  clear(host);
  const input = el('input', {
    type: 'text',
    placeholder: isChatMode() ? t('sidebar.searchConversations') : t('sidebar.searchCharacters'),
    value: searchQuery,
  });
  input.addEventListener('input', () => {
    searchQuery = input.value;
    renderList();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && searchQuery.trim()) {
      callbacks.globalSearch?.(searchQuery.trim());
    }
  });
  host.append(input);
}

export function renderSidebar() {
  // Keep the search placeholder in sync when the app mode changes
  const search = document.querySelector('#sidebar-search input');
  if (search) {
    search.placeholder = isChatMode() ? t('sidebar.searchConversations') : t('sidebar.searchCharacters');
  }
  renderList();
  renderNav();
}

function renderList() {
  if (isChatMode()) return renderConversationList();
  const host = document.getElementById('sidebar-list');
  clear(host);

  const q = searchQuery.trim().toLowerCase();
  const chars = filterCharacters(state.characters, searchQuery);

  const pinned = new Set(state.settings?.pinnedCharacters ?? []);
  const pinnedChars = chars.filter((c) => pinned.has(c.filename));
  const rest = chars.filter((c) => !pinned.has(c.filename));

  if (pinnedChars.length) {
    host.append(el('div', { class: 'sidebar-section-title' }, t('sidebar.pinned')));
    pinnedChars.forEach((c) => host.append(convRow(c, true)));
  }
  host.append(el('div', { class: 'sidebar-section-title' }, t('sidebar.conversations')));
  if (!rest.length && !pinnedChars.length) {
    host.append(
      el(
        'div',
        { style: { padding: '14px 10px', color: 'var(--text-dim)', fontSize: '12px' } },
        q ? t('common.noMatches') : t('sidebar.noCharactersYet')
      ),
      el(
        'button',
        { class: 'btn btn-primary', style: { margin: '6px 8px' }, onclick: () => callbacks.newCharacter?.() },
        t('sidebar.newCharacter')
      )
    );
  }
  rest.forEach((c) => host.append(convRow(c, false)));
}

// --- Chat mode: assistant conversation list --------------------------------

function conversationTitle(convo) {
  return convo.metadata?.title || truncateChars(stripMarkdown(convo.preview ?? ''), 40) || t('sidebar.newConversation');
}

/** Sidebar bucket for a conversation's last-activity time. */
function dateGroupLabel(mtime) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (mtime >= startOfToday) return t('dates.today');
  if (mtime >= startOfToday - 86400e3) return t('dates.yesterday');
  if (mtime >= startOfToday - 7 * 86400e3) return t('dates.previous7Days');
  return t('dates.older');
}

function togglePinConversation(file) {
  const pins = state.settings.pinnedConversations ?? [];
  state.settings.pinnedConversations = pins.includes(file)
    ? pins.filter((f) => f !== file)
    : [...pins, file];
  scheduleSettingsSave();
  renderSidebar();
}

/**
 * Right-aligned row indicator: animated dots while a response streams,
 * an accent dot for a finished reply not yet opened. Rendered only at run
 * start/finish — the pulse itself is pure CSS, so streaming costs no
 * sidebar re-renders.
 */
function rowIndicator({ processing, unread }) {
  if (processing) return el('span', { class: 'conv-indicator' }, streamingDots());
  if (unread) return el('span', { class: 'conv-indicator unread-dot' });
  return null;
}

function renderConversationList() {
  const host = document.getElementById('sidebar-list');
  clear(host);

  host.append(
    el(
      'button',
      { class: 'btn btn-primary new-chat-btn', onclick: () => callbacks.newChat?.() },
      t('sidebar.newChat')
    )
  );

  const q = foldText(searchQuery.trim());
  let convos = state.conversations;
  if (q) {
    convos = convos.filter(
      (c) =>
        foldText(conversationTitle(c)).includes(q) ||
        foldText(c.preview ?? '').includes(q)
    );
  }
  if (!convos.length) {
    host.append(
      el('div', { class: 'sidebar-section-title' }, t('sidebar.conversations')),
      el(
        'div',
        { style: { padding: '14px 10px', color: 'var(--text-dim)', fontSize: '12px' } },
        q ? t('common.noMatches') : t('sidebar.noConversationsYet')
      )
    );
    return;
  }

  const pins = new Set(state.settings?.pinnedConversations ?? []);
  const pinnedConvos = convos.filter((c) => pins.has(c.file));
  const rest = convos.filter((c) => !pins.has(c.file));
  if (pinnedConvos.length) {
    host.append(el('div', { class: 'sidebar-section-title' }, t('sidebar.pinned')));
    for (const convo of pinnedConvos) host.append(conversationRow(convo, true));
  }
  // Already mtime-sorted, so group titles appear as the bucket changes
  let lastGroup = null;
  for (const convo of rest) {
    const group = dateGroupLabel(convo.mtime);
    if (group !== lastGroup) {
      host.append(el('div', { class: 'sidebar-section-title' }, group));
      lastGroup = group;
    }
    host.append(conversationRow(convo, false));
  }
}

function conversationRow(convo, isPinned) {
  const selected = state.currentChat?.file === convo.file && state.view === 'chat';
  const row = el(
    'div',
    {
      class: `conv-row${selected ? ' selected' : ''}`,
      onclick: () => callbacks.selectConversation?.(convo.file),
    },
    el(
      'div',
      { class: 'conv-info' },
      el(
        'div',
        { class: 'conv-name' },
        isPinned ? el('span', { class: 'pin-badge' }, '📌') : null,
        conversationTitle(convo)
      ),
      el(
        'div',
        { class: 'conv-sub' },
        `${relativeDate(convo.mtime)} · ${t('common.nMessages', { count: convo.messageCount })}`
      )
    ),
    rowIndicator({
      processing: !!runFor(ASSISTANT_NAME, convo.file),
      unread: isUnread(ASSISTANT_NAME, convo.file),
    })
  );
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showMenu(e, [
      [t(isPinned ? 'sidebar.unpin' : 'sidebar.pin'), () => togglePinConversation(convo.file)],
      [t('common.rename'), async () => {
        const title = await promptDialog(t('sidebar.renameConversation'), { value: conversationTitle(convo), confirmLabel: t('common.rename') });
        if (title?.trim()) await callbacks.renameConversation?.(convo.file, title.trim());
      }],
      [t('sidebar.exportMarkdown'), () => exportConversation(convo.file, 'markdown')],
      [t('sidebar.exportJSONL'), () => exportConversation(convo.file, 'jsonl')],
      [t('common.delete'), async () => {
        const ok = await confirmDialog(t('sidebar.deleteConversationConfirm'));
        if (ok) await callbacks.deleteConversation?.(convo.file);
      }, true],
    ]);
  });
  return row;
}

async function exportConversation(file, format) {
  try {
    const saved = await window.tavern.chats.export(ASSISTANT_NAME, file, format);
    if (saved) toast(t('sidebar.conversationExported'), 'ok');
  } catch (err) {
    toast(t('common.exportFailed', { msg: err.message }), 'error');
  }
}

// --- Role-play mode: character list -----------------------------------------

function convRow(character, isPinned) {
  const data = character.card.data;
  const selected = state.selectedCharacter?.filename === character.filename && state.view === 'chat';
  // Any of this character's chats: streaming run → dots, unopened reply → dot
  const processing = [...state.runs.values()].some((r) => r.charName === data.name);
  const unread = Object.keys(state.settings?.unreadConversations ?? {}).some((k) =>
    k.startsWith(`${data.name}/`)
  );
  const row = el(
    'div',
    {
      class: `conv-row${selected ? ' selected' : ''}`,
      onclick: () => callbacks.selectCharacter?.(character),
    },
    avatar(avatarURL(character), data.name, 38),
    el(
      'div',
      { class: 'conv-info' },
      el('div', { class: 'conv-name' }, isPinned ? el('span', { class: 'pin-badge' }, '📌') : null, data.name),
      el('div', { class: 'conv-sub' }, (data.tags ?? []).join(', ') || data.creator_notes?.slice(0, 60) || '')
    ),
    rowIndicator({ processing, unread })
  );

  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e, character, isPinned);
  });
  return row;
}

function showContextMenu(event, character, isPinned) {
  showMenu(event, [
    [t(isPinned ? 'sidebar.unpin' : 'sidebar.pin'), () => togglePin(character)],
    [t('sidebar.editCharacter'), () => callbacks.editCharacter?.(character)],
    [t('sidebar.exportPNG'), () => exportCharacter(character, 'png')],
    [t('sidebar.exportJSON'), () => exportCharacter(character, 'json')],
    [t('common.delete'), () => deleteCharacter(character), true],
  ]);
}

function showMenu(event, items) {
  document.querySelector('.ctx-menu')?.remove();
  const menu = el(
    'div',
    {
      class: 'ctx-menu',
      style: { left: `${event.clientX}px`, top: `${event.clientY}px` },
    },
    items.map(([label, action, danger]) => {
      const item = el('div', { class: `ctx-menu-item${danger ? ' danger' : ''}` }, label);
      item.addEventListener('click', () => {
        menu.remove();
        action();
      });
      return item;
    })
  );
  document.body.append(menu);
  const dismiss = () => {
    menu.remove();
    document.removeEventListener('mousedown', onDown, true);
  };
  const onDown = (e) => {
    if (!menu.contains(e.target)) dismiss();
  };
  document.addEventListener('mousedown', onDown, true);
}

async function exportCharacter(character, format) {
  try {
    const saved = await window.tavern.characters.export(character.filename, format);
    if (saved) toast(t('sidebar.characterExported'), 'ok');
  } catch (err) {
    toast(t('common.exportFailed', { msg: err.message }), 'error');
  }
}

function togglePin(character) {
  const pinned = state.settings.pinnedCharacters ?? [];
  const idx = pinned.indexOf(character.filename);
  if (idx >= 0) pinned.splice(idx, 1);
  else pinned.push(character.filename);
  state.settings.pinnedCharacters = pinned;
  scheduleSettingsSave();
  renderList();
}

async function deleteCharacter(character) {
  const ok = await confirmDialog(t('sidebar.deleteCharacterConfirm', { name: character.card.data.name }));
  if (!ok) return;
  await window.tavern.characters.delete(character.filename);
  toast(t('sidebar.characterDeleted'));
  await callbacks.reloadCharacters?.();
}

function renderNav() {
  const host = document.getElementById('sidebar-nav');
  clear(host);
  // Characters, world lore, and personas are role-play concepts
  const items = isChatMode()
    ? [['settings', '⚙️', t('nav.settings')]]
    : [
        ['characters', '👥', t('nav.characters')],
        ['worlds', '🌍', t('nav.worldLore')],
        ['personas', '🪪', t('nav.personas')],
        ['settings', '⚙️', t('nav.settings')],
      ];
  for (const [view, icon, label] of items) {
    host.append(
      el(
        'button',
        {
          class: `nav-btn${state.view === view ? ' active' : ''}`,
          onclick: () => callbacks.navigate?.(view),
        },
        el('span', {}, icon),
        label
      )
    );
  }
}
