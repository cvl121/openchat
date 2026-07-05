// Character library page: grid of all characters with import/create actions.

import { el, clear, toast } from '../util.js';
import { state, avatarURL } from '../state.js';
import { avatar } from '../components.js';

let cb = {}; // { selectCharacter, editCharacter, reloadCharacters }

export function initCharacters(callbacks) {
  cb = callbacks;
}

export function renderCharacters() {
  const main = document.getElementById('main');
  clear(main);
  const page = el('div', { class: 'page' });

  const search = el('input', {
    type: 'text',
    placeholder: 'Filter by name or tag…',
    style: { maxWidth: '260px' },
  });
  search.addEventListener('input', () => renderGrid(grid, search.value));

  page.append(
    el(
      'div',
      { class: 'page-header' },
      el('h1', {}, 'Characters'),
      el(
        'div',
        { style: { display: 'flex', gap: '8px' } },
        search,
        el('button', { class: 'btn', onclick: importCharacter }, 'Import…'),
        el('button', { class: 'btn btn-primary', onclick: () => cb.editCharacter?.(null) }, '+ New')
      )
    )
  );

  const grid = el('div', { class: 'char-grid' });
  renderGrid(grid, '');
  page.append(grid);
  main.append(page);
}

function renderGrid(grid, query) {
  clear(grid);
  const q = query.trim().toLowerCase();
  let chars = state.characters;
  if (q) {
    chars = chars.filter(
      (c) =>
        c.card.data.name.toLowerCase().includes(q) ||
        (c.card.data.tags ?? []).some((t) => t.toLowerCase().includes(q))
    );
  }
  if (!chars.length) {
    grid.append(el('p', { style: { color: 'var(--text-dim)' } }, 'No characters found.'));
    return;
  }
  for (const character of chars) {
    const data = character.card.data;
    const card = el(
      'div',
      { class: 'char-card', onclick: () => cb.selectCharacter?.(character) },
      avatar(avatarURL(character), data.name, 72),
      el('div', { class: 'char-name' }, data.name),
      el('div', { class: 'char-tags' }, (data.tags ?? []).slice(0, 3).join(' · ')),
      el(
        'button',
        {
          class: 'btn btn-small',
          onclick: (e) => {
            e.stopPropagation();
            cb.editCharacter?.(character);
          },
        },
        'Edit'
      )
    );
    grid.append(card);
  }
}

async function importCharacter() {
  const files = await window.tavern.dialog.openFile({
    multi: true,
    filters: [{ name: 'Character Cards', extensions: ['png', 'json'] }],
  });
  let imported = 0;
  for (const file of files) {
    try {
      await window.tavern.characters.import(file);
      imported++;
    } catch (err) {
      toast(`Import failed: ${err.message}`, 'error');
    }
  }
  if (imported) {
    toast(`Imported ${imported} character${imported > 1 ? 's' : ''}`, 'ok');
    await cb.reloadCharacters?.();
    renderCharacters();
  }
}
