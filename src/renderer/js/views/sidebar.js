// Conversation sidebar: search, pinned + recent characters, bottom navigation.
// Chat mode swaps the character list for the assistant's conversation list.

import { el, clear, relativeDate, toast, confirmDialog, promptDialog } from '../util.js';
import { state, avatarURL, scheduleSettingsSave, isChatMode } from '../state.js';
import { avatar } from '../components.js';

let callbacks = {}; // { selectCharacter, selectConversation, newChat, navigate, newCharacter, editCharacter, globalSearch }

export function initSidebar(cb) {
  callbacks = cb;
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
        toast(`Imported ${file.name}`, 'ok');
      } catch (err) {
        toast(`Import failed: ${err.message}`, 'error');
      }
    }
    await callbacks.reloadCharacters?.();
  });

  // Sidebar resize
  const resizer = document.getElementById('sidebar-resizer');
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const move = (ev) => {
      const width = Math.min(480, Math.max(200, ev.clientX));
      document.documentElement.style.setProperty('--sidebar-width', `${width}px`);
      state.settings.sidebarWidth = width;
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      scheduleSettingsSave();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

let searchQuery = '';

function renderSearch() {
  const host = document.getElementById('sidebar-search');
  clear(host);
  const input = el('input', {
    type: 'text',
    placeholder: isChatMode() ? 'Search conversations…' : 'Search characters & chats…',
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
    search.placeholder = isChatMode() ? 'Search conversations…' : 'Search characters & chats…';
  }
  renderList();
  renderNav();
}

function renderList() {
  if (isChatMode()) return renderConversationList();
  const host = document.getElementById('sidebar-list');
  clear(host);

  const q = searchQuery.trim().toLowerCase();
  let chars = state.characters;
  if (q) {
    chars = chars.filter(
      (c) =>
        c.card.data.name.toLowerCase().includes(q) ||
        (c.card.data.tags ?? []).some((t) => t.toLowerCase().includes(q))
    );
  }

  const pinned = new Set(state.settings?.pinnedCharacters ?? []);
  const pinnedChars = chars.filter((c) => pinned.has(c.filename));
  const rest = chars.filter((c) => !pinned.has(c.filename));

  if (pinnedChars.length) {
    host.append(el('div', { class: 'sidebar-section-title' }, 'Pinned'));
    pinnedChars.forEach((c) => host.append(convRow(c, true)));
  }
  host.append(el('div', { class: 'sidebar-section-title' }, 'Conversations'));
  if (!rest.length && !pinnedChars.length) {
    host.append(
      el(
        'div',
        { style: { padding: '14px 10px', color: 'var(--text-dim)', fontSize: '12px' } },
        q ? 'No matches.' : 'No characters yet. Create or import one below.'
      ),
      el(
        'button',
        { class: 'btn btn-primary', style: { margin: '6px 8px' }, onclick: () => callbacks.newCharacter?.() },
        '+ New Character'
      )
    );
  }
  rest.forEach((c) => host.append(convRow(c, false)));
}

// --- Chat mode: assistant conversation list --------------------------------

function conversationTitle(convo) {
  return convo.metadata?.title || convo.preview?.slice(0, 40) || 'New conversation';
}

function renderConversationList() {
  const host = document.getElementById('sidebar-list');
  clear(host);

  host.append(
    el(
      'button',
      { class: 'btn btn-primary new-chat-btn', onclick: () => callbacks.newChat?.() },
      '+ New Chat'
    ),
    el('div', { class: 'sidebar-section-title' }, 'Conversations')
  );

  const q = searchQuery.trim().toLowerCase();
  let convos = state.conversations;
  if (q) {
    convos = convos.filter(
      (c) =>
        conversationTitle(c).toLowerCase().includes(q) ||
        (c.preview ?? '').toLowerCase().includes(q)
    );
  }
  if (!convos.length) {
    host.append(
      el(
        'div',
        { style: { padding: '14px 10px', color: 'var(--text-dim)', fontSize: '12px' } },
        q ? 'No matches.' : 'No conversations yet.'
      )
    );
  }
  for (const convo of convos) {
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
        el('div', { class: 'conv-name' }, conversationTitle(convo)),
        el(
          'div',
          { class: 'conv-sub' },
          `${relativeDate(convo.mtime)} · ${convo.messageCount} messages`
        )
      )
    );
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenu(e, [
        ['Rename', async () => {
          const title = await promptDialog('Rename conversation', { value: conversationTitle(convo), confirmLabel: 'Rename' });
          if (title?.trim()) await callbacks.renameConversation?.(convo.file, title.trim());
        }],
        ['Export as Markdown', () => exportConversation(convo.file, 'markdown')],
        ['Export as JSONL', () => exportConversation(convo.file, 'jsonl')],
        ['Delete', async () => {
          const ok = await confirmDialog('Delete this conversation?');
          if (ok) await callbacks.deleteConversation?.(convo.file);
        }, true],
      ]);
    });
    host.append(row);
  }
}

async function exportConversation(file, format) {
  try {
    const saved = await window.tavern.chats.export('Assistant', file, format);
    if (saved) toast('Conversation exported', 'ok');
  } catch (err) {
    toast(`Export failed: ${err.message}`, 'error');
  }
}

// --- Role-play mode: character list -----------------------------------------

function convRow(character, isPinned) {
  const data = character.card.data;
  const selected = state.selectedCharacter?.filename === character.filename && state.view === 'chat';
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
    )
  );

  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e, character, isPinned);
  });
  return row;
}

function showContextMenu(event, character, isPinned) {
  showMenu(event, [
    [isPinned ? 'Unpin' : 'Pin', () => togglePin(character)],
    ['Edit Character', () => callbacks.editCharacter?.(character)],
    ['Export as PNG', () => exportCharacter(character, 'png')],
    ['Export as JSON', () => exportCharacter(character, 'json')],
    ['Delete', () => deleteCharacter(character), true],
  ]);
}

function showMenu(event, items) {
  document.querySelector('.ctx-menu')?.remove();
  const menu = el(
    'div',
    {
      class: 'ctx-menu',
      style: {
        position: 'fixed',
        left: `${event.clientX}px`,
        top: `${event.clientY}px`,
        background: 'var(--bg-raised)',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        padding: '4px',
        zIndex: 150,
        boxShadow: '0 8px 30px rgba(0,0,0,0.4)',
        minWidth: '160px',
      },
    },
    items.map(([label, action, danger]) => {
      const item = el(
        'div',
        {
          style: {
            padding: '7px 12px',
            borderRadius: '6px',
            cursor: 'pointer',
            color: danger ? 'var(--danger)' : 'var(--text)',
            fontSize: '12.5px',
          },
        },
        label
      );
      item.addEventListener('mouseenter', () => (item.style.background = 'var(--bg-hover)'));
      item.addEventListener('mouseleave', () => (item.style.background = 'none'));
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
    if (saved) toast('Character exported', 'ok');
  } catch (err) {
    toast(`Export failed: ${err.message}`, 'error');
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
  const ok = await confirmDialog(
    `Delete "${character.card.data.name}"? Chat history files are kept on disk.`
  );
  if (!ok) return;
  await window.tavern.characters.delete(character.filename);
  toast('Character deleted');
  await callbacks.reloadCharacters?.();
}

function renderNav() {
  const host = document.getElementById('sidebar-nav');
  clear(host);
  // Characters, world lore, and personas are role-play concepts
  const items = isChatMode()
    ? [['settings', '⚙️', 'Settings']]
    : [
        ['characters', '👥', 'Characters'],
        ['worlds', '🌍', 'World Lore'],
        ['personas', '🪪', 'Personas'],
        ['settings', '⚙️', 'Settings'],
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
