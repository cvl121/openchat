// Personas page: user identities with avatars; one active globally, with
// optional per-character overrides set here or in the chat view.

import { el, clear, uuid, toast, confirmDialog } from '../util.js';
import { state, personaAvatarURL, scheduleSettingsSave } from '../state.js';
import { avatar, textRow, textareaRow } from '../components.js';
import { t } from '../../../shared/i18n.js';

let cb = {}; // { renderSidebar }

export function initPersonas(callbacks) {
  cb = callbacks;
}

async function save() {
  await window.tavern.personas.save(state.personas);
}

export function renderPersonas() {
  const main = document.getElementById('main');
  clear(main);
  const page = el('div', { class: 'page' }, el('div', { class: 'page-narrow' }));
  const inner = page.firstChild;

  inner.append(
    el(
      'div',
      { class: 'page-header' },
      el('h1', {}, t('personas.title')),
      el(
        'button',
        {
          class: 'btn btn-primary',
          onclick: async () => {
            state.personas.push({ id: uuid(), name: t('personas.defaultName'), description: '', avatarFilename: null });
            await save();
            renderPersonas();
          },
        },
        t('personas.new')
      )
    ),
    el('p', { class: 'hint', style: { marginBottom: '14px' } }, t('personas.hint'))
  );

  const activeId = state.settings.activePersonaId ?? state.personas[0]?.id;

  for (const persona of state.personas) {
    const isActive = persona.id === activeId;
    const card = el('div', { class: 'card' });

    const header = el(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px' } },
      avatar(personaAvatarURL(persona), persona.name, 44),
      el('strong', { style: { flex: 1 } }, persona.name),
      isActive
        ? el('span', { class: 'mode-badge' }, t('personas.active'))
        : el(
            'button',
            {
              class: 'btn btn-small',
              onclick: () => {
                state.settings.activePersonaId = persona.id;
                scheduleSettingsSave();
                renderPersonas();
                cb.renderSidebar?.();
              },
            },
            t('personas.setActive')
          )
    );

    card.append(
      header,
      textRow(t('personas.name'), {
        get: () => persona.name,
        set: (v) => {
          persona.name = v;
          saveDebounced();
        },
      }),
      textareaRow(t('personas.description'), {
        get: () => persona.description,
        set: (v) => {
          persona.description = v;
          saveDebounced();
        },
        rows: 3,
        placeholder: t('personas.descriptionPlaceholder'),
      }),
      el(
        'div',
        { style: { display: 'flex', gap: '8px' } },
        el(
          'button',
          {
            class: 'btn btn-small',
            onclick: async () => {
              const files = await window.tavern.dialog.openFile({
                filters: [{ name: t('personas.filterImages'), extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
              });
              if (!files[0]) return;
              persona.avatarFilename = await window.tavern.personas.saveAvatar(persona.id, files[0]);
              await save();
              renderPersonas();
            },
          },
          t('personas.setAvatar')
        ),
        state.personas.length > 1
          ? el(
              'button',
              {
                class: 'btn btn-small btn-danger',
                onclick: async () => {
                  const ok = await confirmDialog(t('personas.deleteConfirm', { name: persona.name }));
                  if (!ok) return;
                  state.personas = state.personas.filter((p) => p.id !== persona.id);
                  if (state.settings.activePersonaId === persona.id) state.settings.activePersonaId = state.personas[0]?.id ?? null;
                  await save();
                  scheduleSettingsSave();
                  renderPersonas();
                },
              },
              t('common.delete')
            )
          : null
      )
    );
    inner.append(card);
  }

  // Per-character persona assignments
  if (state.characters.length) {
    inner.append(el('h3', { style: { margin: '20px 0 10px' } }, t('personas.perCharacter')));
    inner.append(el('p', { class: 'hint', style: { marginBottom: '10px' } }, t('personas.perCharacterHint')));
    for (const character of state.characters) {
      const select = el(
        'select',
        { style: { width: '220px' } },
        el('option', { value: '' }, t('personas.useActive')),
        state.personas.map((p) =>
          el('option', { value: p.id, selected: state.settings.characterPersonas?.[character.filename] === p.id }, p.name)
        )
      );
      select.addEventListener('change', () => {
        state.settings.characterPersonas = state.settings.characterPersonas ?? {};
        if (select.value) state.settings.characterPersonas[character.filename] = select.value;
        else delete state.settings.characterPersonas[character.filename];
        scheduleSettingsSave();
      });
      inner.append(
        el(
          'div',
          { class: 'form-inline', style: { marginBottom: '8px', justifyContent: 'space-between' } },
          el('span', {}, character.card.data.name),
          select
        )
      );
    }
  }

  main.append(page);
}

let saveTimer = null;
function saveDebounced() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 500);
}

export { save as savePersonas };
