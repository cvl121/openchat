// Character library page: grid of all characters with import/create actions.

import { el, clear, toast } from '../util.js';
import { state, avatarURL, filterCharacters } from '../state.js';
import { avatar } from '../components.js';
import { t } from '../../../shared/i18n.js';

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
    placeholder: t('characters.filterPlaceholder'),
    style: { maxWidth: '260px' },
  });
  search.addEventListener('input', () => renderGrid(grid, search.value));

  page.append(
    el(
      'div',
      { class: 'page-header' },
      el('h1', {}, t('characters.title')),
      el(
        'div',
        { style: { display: 'flex', gap: '8px' } },
        search,
        el('button', { class: 'btn', onclick: importCharacter }, t('common.import')),
        el('button', { class: 'btn btn-primary', onclick: () => cb.editCharacter?.(null) }, t('characters.new'))
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
  const chars = filterCharacters(state.characters, query);
  if (!chars.length) {
    grid.append(el('p', { style: { color: 'var(--text-dim)' } }, t('characters.noneFound')));
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
        'div',
        { style: { display: 'flex', gap: '6px', justifyContent: 'center' } },
        el(
          'button',
          {
            class: 'btn btn-small',
            'aria-label': t('characters.editAria', { name: data.name }),
            onclick: (e) => {
              e.stopPropagation();
              cb.editCharacter?.(character);
            },
          },
          t('characters.edit')
        ),
        el(
          'button',
          {
            class: 'btn btn-small',
            title: t('characters.exportPNGTitle'),
            'aria-label': t('characters.exportAria', { name: data.name }),
            onclick: async (e) => {
              e.stopPropagation();
              try {
                const saved = await window.tavern.characters.export(character.filename, 'png');
                if (saved) toast(t('sidebar.characterExported'), 'ok');
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          },
          t('common.export')
        )
      )
    );
    grid.append(card);
  }
}

async function importCharacter() {
  const files = await window.tavern.dialog.openFile({
    multi: true,
    filters: [{ name: t('characters.filterCards'), extensions: ['png', 'json'] }],
  });
  let imported = 0;
  for (const file of files) {
    try {
      await window.tavern.characters.import(file);
      imported++;
    } catch (err) {
      toast(t('common.importFailed', { msg: err.message }), 'error');
    }
  }
  if (imported) {
    toast(t('characters.importedCount', { count: imported }), 'ok');
    await cb.reloadCharacters?.();
    renderCharacters();
  }
}
