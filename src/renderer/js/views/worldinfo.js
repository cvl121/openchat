// World Lore page: standalone world info books with keyword-triggered entries,
// assignable globally or to specific characters.

import { el, clear, toast, confirmDialog, modal } from '../util.js';
import { state } from '../state.js';
import { textRow, textareaRow, checkboxRow } from '../components.js';
import { t } from '../../../shared/i18n.js';

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
      el('h1', {}, t('worlds.title')),
      el(
        'div',
        { style: { display: 'flex', gap: '8px' } },
        el(
          'button',
          {
            class: 'btn',
            onclick: async () => {
              const files = await window.tavern.dialog.openFile({
                filters: [{ name: t('worlds.filterJSON'), extensions: ['json'] }],
              });
              if (!files[0]) return;
              try {
                await window.tavern.worlds.import(files[0]);
                toast(t('worlds.imported'), 'ok');
                await cb.reloadWorlds?.();
                renderWorldInfo();
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          },
          t('common.import')
        ),
        el(
          'button',
          {
            class: 'btn btn-primary',
            onclick: async () => {
              const book = await window.tavern.worlds.save({
                name: t('worlds.defaultName'),
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
          t('worlds.newBook')
        )
      )
    ),
    el('p', { class: 'hint', style: { marginBottom: '14px' } }, t('worlds.hint'))
  );

  if (!state.worlds.length) {
    inner.append(el('p', { style: { color: 'var(--text-dim)' } }, t('worlds.none')));
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
            `${t('worlds.nEntries', { count: book.entries.length })} · ${book.global ? t('worlds.global') : book.assignedCharacters?.length ? t('worlds.nCharacters', { count: book.assignedCharacters.length }) : t('worlds.unassigned')}`
          )
        ),
        el('button', {
          class: 'btn-icon',
          title: t('worlds.exportBook'),
          'aria-label': t('worlds.exportBookAria', { name: book.name }),
          onclick: async (e) => {
            e.stopPropagation();
            try {
              const saved = await window.tavern.worlds.export(book.file);
              if (saved) toast(t('worlds.exported'), 'ok');
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        }, '⬇'),
        el('button', {
          class: 'btn-icon',
          title: t('worlds.deleteBook'),
          'aria-label': t('worlds.deleteBookAria', { name: book.name }),
          onclick: async (e) => {
            e.stopPropagation();
            const ok = await confirmDialog(t('worlds.deleteConfirm', { name: book.name }));
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
    content.append(el('h2', {}, t('worlds.editBook')));
    content.append(
      textRow(t('worlds.bookName'), { get: () => draft.name, set: (v) => (draft.name = v) }),
      checkboxRow(t('worlds.globalLabel'), {
        get: () => !!draft.global,
        set: (v) => (draft.global = v),
      })
    );

    if (!draft.global && state.characters.length) {
      const assigned = new Set(draft.assignedCharacters ?? []);
      content.append(
        el('div', { class: 'form-row' },
          el('label', {}, t('worlds.assignedCharacters')),
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

    content.append(el('h3', { style: { margin: '14px 0 8px' } }, t('worlds.entries', { count: draft.entries.length })));
    draft.entries.forEach((entry, index) => {
      content.append(
        loreEntryCard(entry, () => {
          draft.entries.splice(index, 1);
          rerender();
        })
      );
    });

    content.append(
      el('button', {
        class: 'btn',
        onclick: () => {
          draft.entries.push(newLoreEntry());
          rerender();
        },
      }, t('worlds.addEntry')),
      el('div', { class: 'modal-actions' },
        el('button', { class: 'btn', onclick: () => overlay.close() }, t('common.cancel')),
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            await window.tavern.worlds.save(draft);
            overlay.close();
            toast(t('worlds.saved'), 'ok');
            await cb.reloadWorlds?.();
            renderWorldInfo();
          },
        }, t('common.save'))
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

export function newLoreEntry() {
  return {
    keys: [],
    secondary_keys: [],
    selective: false,
    content: '',
    constant: false,
    enabled: true,
    case_sensitive: false,
    match_whole_words: false,
    insertion_order: 100,
    sticky: 2,
  };
}

/** One editable lore entry card — shared by world books and embedded character books. */
export function loreEntryCard(entry, onDelete) {
  const selective = inlineCheck(t('worlds.requireSecondary'), () => !!entry.selective, (v) => (entry.selective = v));
  const syncSelective = () => (selective.style.display = entry.secondary_keys?.length ? '' : 'none');
  syncSelective();

  const orderInput = el('input', { type: 'number', value: String(entry.insertion_order ?? 100), style: { width: '70px' } });
  orderInput.addEventListener('change', () => (entry.insertion_order = parseInt(orderInput.value, 10) || 0));

  const stickyInput = el('input', { type: 'number', min: '0', value: String(entry.sticky ?? 2), style: { width: '55px' } });
  stickyInput.addEventListener('change', () => (entry.sticky = Math.max(0, parseInt(stickyInput.value, 10) || 0)));

  return el('div', { class: 'card' },
    textRow(t('worlds.keywords'), {
      get: () => (entry.keys ?? []).join(', '),
      set: (v) => (entry.keys = v.split(',').map((k) => k.trim()).filter(Boolean)),
    }),
    textRow(t('worlds.secondaryKeywords'), {
      get: () => (entry.secondary_keys ?? []).join(', '),
      set: (v) => {
        entry.secondary_keys = v.split(',').map((k) => k.trim()).filter(Boolean);
        syncSelective();
      },
    }),
    textareaRow(t('worlds.content'), { get: () => entry.content, set: (v) => (entry.content = v), rows: 3 }),
    el('div', { style: { display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' } },
      inlineCheck(t('worlds.constant'), () => !!entry.constant, (v) => (entry.constant = v)),
      inlineCheck(t('worlds.enabled'), () => entry.enabled !== false, (v) => (entry.enabled = v)),
      inlineCheck(t('worlds.caseSensitive'), () => !!entry.case_sensitive, (v) => (entry.case_sensitive = v)),
      inlineCheck(t('worlds.matchWholeWords'), () => !!entry.match_whole_words, (v) => (entry.match_whole_words = v)),
      selective,
      el('label', {
        class: 'form-inline',
        style: { fontSize: '12px' },
        title: t('worlds.orderTitle'),
      }, t('worlds.order'), orderInput),
      el('label', {
        class: 'form-inline',
        style: { fontSize: '12px' },
        title: t('worlds.stickyTitle'),
      }, t('worlds.sticky'), stickyInput),
      el('button', {
        class: 'btn-icon',
        style: { marginLeft: 'auto' },
        title: t('worlds.deleteEntry'),
        'aria-label': t('worlds.deleteEntry'),
        onclick: onDelete,
      }, '🗑')
    )
  );
}
