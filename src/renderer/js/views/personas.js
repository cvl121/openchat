// Personas page: user identities with avatars; one active globally, with
// optional per-character overrides set here or in the chat view.

import { el, clear, uuid, toast, confirmDialog } from '../util.js';
import { state, personaAvatarURL, scheduleSettingsSave } from '../state.js';
import { avatar, textRow, textareaRow } from '../components.js';

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
      el('h1', {}, 'Personas'),
      el(
        'button',
        {
          class: 'btn btn-primary',
          onclick: async () => {
            state.personas.push({ id: uuid(), name: 'New Persona', description: '', avatarFilename: null });
            await save();
            renderPersonas();
          },
        },
        '+ New Persona'
      )
    ),
    el('p', { class: 'hint', style: { marginBottom: '14px' } },
      'The active persona provides your name and description in chats. Its description is injected into the prompt so characters know who they are talking to.')
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
        ? el('span', { class: 'mode-badge' }, 'Active')
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
            'Set Active'
          )
    );

    card.append(
      header,
      textRow('Name', {
        get: () => persona.name,
        set: (v) => {
          persona.name = v;
          saveDebounced();
        },
      }),
      textareaRow('Description', {
        get: () => persona.description,
        set: (v) => {
          persona.description = v;
          saveDebounced();
        },
        rows: 3,
        placeholder: 'Who are you in the story? Injected into the prompt.',
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
                filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
              });
              if (!files[0]) return;
              persona.avatarFilename = await window.tavern.personas.saveAvatar(persona.id, files[0]);
              await save();
              renderPersonas();
            },
          },
          'Set Avatar…'
        ),
        state.personas.length > 1
          ? el(
              'button',
              {
                class: 'btn btn-small btn-danger',
                onclick: async () => {
                  const ok = await confirmDialog(`Delete persona "${persona.name}"?`);
                  if (!ok) return;
                  state.personas = state.personas.filter((p) => p.id !== persona.id);
                  if (state.settings.activePersonaId === persona.id) state.settings.activePersonaId = state.personas[0]?.id ?? null;
                  await save();
                  scheduleSettingsSave();
                  renderPersonas();
                },
              },
              'Delete'
            )
          : null
      )
    );
    inner.append(card);
  }

  // Per-character persona assignments
  if (state.characters.length) {
    inner.append(el('h3', { style: { margin: '20px 0 10px' } }, 'Per-Character Personas'));
    inner.append(el('p', { class: 'hint', style: { marginBottom: '10px' } }, 'Assign a specific persona to a character; it overrides the active persona in their chats.'));
    for (const character of state.characters) {
      const select = el(
        'select',
        { style: { width: '220px' } },
        el('option', { value: '' }, '(use active persona)'),
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
