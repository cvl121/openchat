// Character create/edit modal. Covers all TavernCardV2 fields, with the
// less common ones (system prompt, post-history, example dialogue, book)
// shown only in Advanced mode.

import { el, clear, toast, modal } from '../util.js';
import { state, isAdvanced } from '../state.js';
import { textRow, textareaRow } from '../components.js';
import { loreEntryCard, newLoreEntry } from './worldinfo.js';
import { t } from '../../../shared/i18n.js';

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
    // Deep clone so Cancel discards lore edits (entries are mutated in place)
    character_book: existing?.character_book ? structuredClone(existing.character_book) : null,
    tags: [...(existing?.tags ?? [])],
    creator: existing?.creator ?? '',
    creator_notes: existing?.creator_notes ?? '',
    character_version: existing?.character_version ?? '',
  };
  let avatarPath = null;

  const content = el('div', {}, el('h2', {}, character ? t('editor.editTitle', { name: draft.name }) : t('editor.newCharacter')));

  const avatarBtn = el('button', { class: 'btn' }, t('editor.chooseAvatar'));
  const avatarLabel = el('span', { class: 'hint', style: { marginLeft: '8px' } }, character ? t('editor.keepingAvatar') : t('editor.optional'));
  avatarBtn.addEventListener('click', async () => {
    const files = await window.tavern.dialog.openFile({
      filters: [{ name: t('editor.filterPNG'), extensions: ['png'] }],
    });
    if (files[0]) {
      avatarPath = files[0];
      avatarLabel.textContent = files[0].split('/').pop();
    }
  });

  content.append(
    textRow(t('editor.name'), { get: () => draft.name, set: (v) => (draft.name = v), placeholder: t('editor.namePlaceholder') }),
    el('div', { class: 'form-row' }, el('label', {}, t('editor.avatar')), el('div', { class: 'form-inline' }, avatarBtn, avatarLabel)),
    textareaRow(t('editor.description'), {
      get: () => draft.description,
      set: (v) => (draft.description = v),
      rows: 6,
      placeholder: t('editor.descriptionPlaceholder'),
    }),
    textareaRow(t('editor.personality'), { get: () => draft.personality, set: (v) => (draft.personality = v), rows: 2 }),
    textareaRow(t('editor.scenario'), { get: () => draft.scenario, set: (v) => (draft.scenario = v), rows: 2 }),
    textareaRow(t('editor.firstMessage'), {
      get: () => draft.first_mes,
      set: (v) => (draft.first_mes = v),
      rows: 4,
      placeholder: t('editor.firstMessagePlaceholder'),
    }),
    textareaRow(t('editor.altGreetings'), {
      get: () => draft.alternate_greetings.join('\n'),
      set: (v) => (draft.alternate_greetings = v.split('\n').filter((s) => s.trim())),
      rows: 3,
    }),
    textRow(t('editor.tags'), {
      get: () => draft.tags.join(', '),
      set: (v) => (draft.tags = v.split(',').map((x) => x.trim()).filter(Boolean)),
    })
  );

  if (isAdvanced()) {
    content.append(
      el('h3', { style: { margin: '18px 0 10px', fontSize: '12px', color: 'var(--text-dim)', textTransform: 'uppercase' } }, t('editor.advanced')),
      textareaRow(t('editor.systemPrompt'), {
        get: () => draft.system_prompt,
        set: (v) => (draft.system_prompt = v),
        rows: 3,
      }),
      textareaRow(t('editor.postHistory'), {
        get: () => draft.post_history_instructions,
        set: (v) => (draft.post_history_instructions = v),
        rows: 2,
      }),
      textareaRow(t('editor.exampleDialogue'), {
        get: () => draft.mes_example,
        set: (v) => (draft.mes_example = v),
        rows: 5,
      }),
      textRow(t('editor.creator'), { get: () => draft.creator, set: (v) => (draft.creator = v) }),
      textareaRow(t('editor.creatorNotes'), { get: () => draft.creator_notes, set: (v) => (draft.creator_notes = v), rows: 2 }),
      textRow(t('editor.version'), { get: () => draft.character_version, set: (v) => (draft.character_version = v), placeholder: t('editor.versionPlaceholder') })
    );

    const bookSection = el('div', {});
    const renderBook = () => {
      clear(bookSection);
      const entries = draft.character_book?.entries ?? [];
      bookSection.append(
        el('h3', { style: { margin: '18px 0 10px', fontSize: '12px', color: 'var(--text-dim)', textTransform: 'uppercase' } },
          `${t('editor.loreBook')}${entries.length ? ` (${entries.length})` : ''}`),
        el('p', { class: 'hint', style: { marginBottom: '10px' } }, t('editor.loreBookHint'))
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
        }, t('editor.addLoreEntry'))
      );
    };
    renderBook();
    content.append(bookSection);
  }

  const doExport = async (format) => {
    try {
      const saved = await window.tavern.characters.export(character.filename, format);
      if (saved) toast(t('sidebar.characterExported'), 'ok');
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
            title: t('editor.exportPNGTitle'),
            onclick: () => doExport('png'),
          }, t('editor.exportPNG'))
        : null,
      character
        ? el('button', {
            class: 'btn',
            title: t('editor.exportJSONTitle'),
            onclick: () => doExport('json'),
          }, t('editor.exportJSON'))
        : null,
      el('button', { class: 'btn', onclick: () => overlay.close() }, t('common.cancel')),
      el(
        'button',
        {
          class: 'btn btn-primary',
          onclick: async () => {
            if (!draft.name.trim()) {
              toast(t('editor.nameRequired'), 'error');
              return;
            }
            try {
              if (draft.character_book && !draft.character_book.entries?.length) draft.character_book = null;
              // Spread the existing data under the draft so fields the editor
              // doesn't cover (extensions, V3 assets/nickname, …) survive a save.
              const card = { spec: 'chara_card_v2', spec_version: '2.0', data: { ...existing, ...draft } };
              const saved = await window.tavern.characters.save(card, {
                filename: character?.filename,
                avatarPath,
              });
              overlay.close();
              toast(character ? t('editor.updated') : t('editor.created'), 'ok');
              await cb.reloadCharacters?.();
              const refreshed = state.characters.find((c) => c.filename === saved.filename);
              if (refreshed && !character) cb.selectCharacter?.(refreshed);
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        },
        character ? t('common.save') : t('editor.create')
      )
    )
  );

  const overlay = modal(content, { width: 640 });
}
