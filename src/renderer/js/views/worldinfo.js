// World Lore page: standalone world info books with keyword-triggered entries,
// assignable globally or to specific characters.

import { el, clear, toast, confirmDialog, modal } from '../util.js';
import { state } from '../state.js';
import { textRow, textareaRow, checkboxRow } from '../components.js';

let cb = {}; // { reloadWorlds }

export function initWorldInfo(callbacks) {
  cb = callbacks;
}

export function renderWorldInfo() {
  const main = document.getElementById('main');
  clear(main);
  const page = el('div', { class: 'page' }, el('div', { class: 'page-narrow' }));
  const inner = page.firstChild;

  inner.append(
    el(
      'div',
      { class: 'page-header' },
      el('h1', {}, 'World Lore'),
      el(
        'div',
        { style: { display: 'flex', gap: '8px' } },
        el(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              const files = await window.tavern.dialog.openFile({
                filters: [{ name: 'World Info JSON', extensions: ['json'] }],
              });
              if (!files[0]) return;
              try {
                await window.tavern.worlds.import(files[0]);
                toast('World book imported', 'ok');
                await cb.reloadWorlds?.();
                renderWorldInfo();
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          },
          'Import…'
        ),
        el(
          'button',
          {
            class: 'btn btn-primary',
            onclick: async () => {
              const book = await window.tavern.worlds.save({
                name: 'New World Book',
                entries: [],
                global: false,
                assignedCharacters: [],
              });
              await cb.reloadWorlds?.();
              const fresh = state.worlds.find((w) => w.file === book.file);
              if (fresh) openBookEditor(fresh);
              renderWorldInfo();
            },
          },
          '+ New Book'
        )
      )
    ),
    el('p', { class: 'hint', style: { marginBottom: '14px' } },
      'Lore entries are injected into the prompt when their keywords appear in recent messages (constant entries are always included). Books apply globally or to assigned characters.')
  );

  if (!state.worlds.length) {
    inner.append(el('p', { style: { color: 'var(--text-dim)' } }, 'No world books yet.'));
  }

  for (const book of state.worlds) {
    inner.append(
      el(
        'div',
        { class: 'list-row', onclick: () => openBookEditor(book) },
        el(
          'div',
          { class: 'list-main' },
          el('div', { class: 'list-title' }, book.name),
          el(
            'div',
            { class: 'list-sub' },
            `${book.entries.length} entries · ${book.global ? 'global' : book.assignedCharacters?.length ? `${book.assignedCharacters.length} characters` : 'unassigned'}`
          )
        ),
        el('button', {
          class: 'btn-icon',
          title: 'Delete book',
          onclick: async (e) => {
            e.stopPropagation();
            const ok = await confirmDialog(`Delete world book "${book.name}"?`);
            if (!ok) return;
            await window.tavern.worlds.delete(book.file);
            await cb.reloadWorlds?.();
            renderWorldInfo();
          },
        }, '🗑')
      )
    );
  }

  main.append(page);
}

function openBookEditor(book) {
  const draft = structuredClone(book);
  const content = el('div', {});

  const rerender = () => {
    clear(content);
    content.append(el('h2', {}, 'Edit World Book'));
    content.append(
      textRow('Book Name', { get: () => draft.name, set: (v) => (draft.name = v) }),
      checkboxRow('Global (applies to every character)', {
        get: () => !!draft.global,
        set: (v) => (draft.global = v),
      })
    );

    if (!draft.global && state.characters.length) {
      const assigned = new Set(draft.assignedCharacters ?? []);
      content.append(
        el('div', { class: 'form-row' },
          el('label', {}, 'Assigned Characters'),
          el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px' } },
            state.characters.map((c) => {
              const box = el('input', { type: 'checkbox' });
              box.checked = assigned.has(c.filename);
              box.addEventListener('change', () => {
                if (box.checked) assigned.add(c.filename);
                else assigned.delete(c.filename);
                draft.assignedCharacters = [...assigned];
              });
              return el('label', { class: 'form-inline', style: { cursor: 'pointer', fontWeight: 'normal' } }, box, c.card.data.name);
            })
          )
        )
      );
    }

    content.append(el('h3', { style: { margin: '14px 0 8px' } }, `Entries (${draft.entries.length})`));
    draft.entries.forEach((entry, index) => {
      content.append(
        el('div', { class: 'card' },
          textRow('Keywords (comma-separated)', {
            get: () => (entry.keys ?? []).join(', '),
            set: (v) => (entry.keys = v.split(',').map((k) => k.trim()).filter(Boolean)),
          }),
          textareaRow('Content', { get: () => entry.content, set: (v) => (entry.content = v), rows: 3 }),
          el('div', { style: { display: 'flex', gap: '16px', alignItems: 'center' } },
            inlineCheck('Constant (always included)', () => !!entry.constant, (v) => (entry.constant = v)),
            inlineCheck('Enabled', () => entry.enabled !== false, (v) => (entry.enabled = v)),
            inlineCheck('Case sensitive', () => !!entry.case_sensitive, (v) => (entry.case_sensitive = v)),
            el('button', {
              class: 'btn-icon',
              style: { marginLeft: 'auto' },
              title: 'Delete entry',
              onclick: () => {
                draft.entries.splice(index, 1);
                rerender();
              },
            }, '🗑')
          )
        )
      );
    });

    content.append(
      el('button', {
        class: 'btn',
        onclick: () => {
          draft.entries.push({ keys: [], content: '', constant: false, enabled: true, case_sensitive: false, insertion_order: 100 });
          rerender();
        },
      }, '+ Add Entry'),
      el('div', { class: 'modal-actions' },
        el('button', { class: 'btn', onclick: () => overlay.close() }, 'Cancel'),
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            await window.tavern.worlds.save(draft);
            overlay.close();
            toast('World book saved', 'ok');
            await cb.reloadWorlds?.();
            renderWorldInfo();
          },
        }, 'Save')
      )
    );
  };

  rerender();
  const overlay = modal(content, { width: 680 });
}

function inlineCheck(label, get, set) {
  const box = el('input', { type: 'checkbox' });
  box.checked = get();
  box.addEventListener('change', () => set(box.checked));
  return el('label', { class: 'form-inline', style: { cursor: 'pointer', fontSize: '12px' } }, box, label);
}
