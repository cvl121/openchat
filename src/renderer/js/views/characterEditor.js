// Character create/edit modal. Covers all TavernCardV2 fields, with the
// less common ones (system prompt, post-history, example dialogue, book)
// shown only in Advanced mode.

import { el, clear, toast, modal } from '../util.js';
import { state, isAdvanced } from '../state.js';
import { textRow, textareaRow } from '../components.js';
import { loreEntryCard, newLoreEntry } from './worldinfo.js';

let cb = {}; // { reloadCharacters, selectCharacter }

export function initCharacterEditor(callbacks) {
  cb = callbacks;
}

/** Open editor; character = null creates a new one. */
export function openCharacterEditor(character) {
  const existing = character?.card?.data;
  const draft = {
    name: existing?.name ?? '',
    description: existing?.description ?? '',
    personality: existing?.personality ?? '',
    scenario: existing?.scenario ?? '',
    first_mes: existing?.first_mes ?? '',
    mes_example: existing?.mes_example ?? '',
    system_prompt: existing?.system_prompt ?? '',
    post_history_instructions: existing?.post_history_instructions ?? '',
    alternate_greetings: [...(existing?.alternate_greetings ?? [])],
    character_book: existing?.character_book ?? null,
    tags: [...(existing?.tags ?? [])],
    creator: existing?.creator ?? '',
    creator_notes: existing?.creator_notes ?? '',
    character_version: existing?.character_version ?? '',
  };
  let avatarPath = null;

  const content = el('div', {}, el('h2', {}, character ? `Edit ${draft.name}` : 'New Character'));

  const avatarBtn = el('button', { class: 'btn' }, 'Choose Avatar (PNG)…');
  const avatarLabel = el('span', { class: 'hint', style: { marginLeft: '8px' } }, character ? 'Keeping current avatar' : 'Optional');
  avatarBtn.addEventListener('click', async () => {
    const files = await window.tavern.dialog.openFile({
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    });
    if (files[0]) {
      avatarPath = files[0];
      avatarLabel.textContent = files[0].split('/').pop();
    }
  });

  content.append(
    textRow('Name *', { get: () => draft.name, set: (v) => (draft.name = v), placeholder: 'Character name' }),
    el('div', { class: 'form-row' }, el('label', {}, 'Avatar'), el('div', { class: 'form-inline' }, avatarBtn, avatarLabel)),
    textareaRow('Description', {
      get: () => draft.description,
      set: (v) => (draft.description = v),
      rows: 6,
      placeholder: 'Who is this character? Supports {{char}} and {{user}}.',
    }),
    textareaRow('Personality', { get: () => draft.personality, set: (v) => (draft.personality = v), rows: 2 }),
    textareaRow('Scenario', { get: () => draft.scenario, set: (v) => (draft.scenario = v), rows: 2 }),
    textareaRow('First Message', {
      get: () => draft.first_mes,
      set: (v) => (draft.first_mes = v),
      rows: 4,
      placeholder: 'The greeting that starts every new chat.',
    }),
    textareaRow('Alternate Greetings (one per line — become greeting swipes)', {
      get: () => draft.alternate_greetings.join('\n'),
      set: (v) => (draft.alternate_greetings = v.split('\n').filter((s) => s.trim())),
      rows: 3,
    }),
    textRow('Tags (comma-separated)', {
      get: () => draft.tags.join(', '),
      set: (v) => (draft.tags = v.split(',').map((t) => t.trim()).filter(Boolean)),
    })
  );

  if (isAdvanced()) {
    content.append(
      el('h3', { style: { margin: '18px 0 10px', fontSize: '12px', color: 'var(--text-dim)', textTransform: 'uppercase' } }, 'Advanced'),
      textareaRow('System Prompt (overrides the default "You are {{char}}.")', {
        get: () => draft.system_prompt,
        set: (v) => (draft.system_prompt = v),
        rows: 3,
      }),
      textareaRow('Post-History Instructions (appended after chat history)', {
        get: () => draft.post_history_instructions,
        set: (v) => (draft.post_history_instructions = v),
        rows: 2,
      }),
      textareaRow('Example Dialogue (SillyTavern format: <START>, {{user}}:, {{char}}:)', {
        get: () => draft.mes_example,
        set: (v) => (draft.mes_example = v),
        rows: 5,
      }),
      textRow('Creator', { get: () => draft.creator, set: (v) => (draft.creator = v) }),
      textareaRow('Creator Notes', { get: () => draft.creator_notes, set: (v) => (draft.creator_notes = v), rows: 2 }),
      textRow('Version', { get: () => draft.character_version, set: (v) => (draft.character_version = v), placeholder: 'e.g. 1.0' })
    );

    const bookSection = el('div', {});
    const renderBook = () => {
      clear(bookSection);
      const entries = draft.character_book?.entries ?? [];
      bookSection.append(
        el('h3', { style: { margin: '18px 0 10px', fontSize: '12px', color: 'var(--text-dim)', textTransform: 'uppercase' } },
          `Embedded Lore Book${entries.length ? ` (${entries.length})` : ''}`),
        el('p', { class: 'hint', style: { marginBottom: '10px' } },
          'Lore entries travel inside the card and are injected when their keywords appear in recent messages.')
      );
      entries.forEach((entry, index) => {
        bookSection.append(
          loreEntryCard(entry, () => {
            entries.splice(index, 1);
            renderBook();
          })
        );
      });
      bookSection.append(
        el('button', {
          class: 'btn',
          onclick: () => {
            draft.character_book ??= { entries: [] };
            draft.character_book.entries ??= [];
            draft.character_book.entries.push(newLoreEntry());
            renderBook();
          },
        }, '+ Add Lore Entry')
      );
    };
    renderBook();
    content.append(bookSection);
  }

  const doExport = async (format) => {
    try {
      const saved = await window.tavern.characters.export(character.filename, format);
      if (saved) toast('Character exported', 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  content.append(
    el(
      'div',
      { class: 'modal-actions' },
      character
        ? el('button', {
            class: 'btn',
            style: { marginRight: 'auto' },
            title: 'Export the last saved version as a PNG card',
            onclick: () => doExport('png'),
          }, 'Export PNG…')
        : null,
      character
        ? el('button', {
            class: 'btn',
            title: 'Export the last saved version as JSON',
            onclick: () => doExport('json'),
          }, 'Export JSON…')
        : null,
      el('button', { class: 'btn', onclick: () => overlay.close() }, 'Cancel'),
      el(
        'button',
        {
          class: 'btn btn-primary',
          onclick: async () => {
            if (!draft.name.trim()) {
              toast('Name is required', 'error');
              return;
            }
            try {
              if (draft.character_book && !draft.character_book.entries?.length) draft.character_book = null;
              const card = { spec: 'chara_card_v2', spec_version: '2.0', data: draft };
              const saved = await window.tavern.characters.save(card, {
                filename: character?.filename,
                avatarPath,
              });
              overlay.close();
              toast(character ? 'Character updated' : 'Character created', 'ok');
              await cb.reloadCharacters?.();
              const refreshed = state.characters.find((c) => c.filename === saved.filename);
              if (refreshed && !character) cb.selectCharacter?.(refreshed);
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
        character ? 'Save' : 'Create'
      )
    )
  );

  const overlay = modal(content, { width: 640 });
}
