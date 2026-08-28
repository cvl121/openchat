import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, parseExampleMessages, applicableWorldEntries } from '../src/renderer/js/promptBuilder.js';

const character = {
  name: 'Alice',
  description: 'A curious adventurer named {{char}}.',
  personality: 'brave',
  scenario: 'A dark forest.',
  first_mes: 'Hi {{user}}!',
  mes_example: '<START>\n{{user}}: How are you?\n{{char}}: *smiles* Great!',
  system_prompt: '',
  post_history_instructions: 'Stay in character.',
};

test('buildMessages assembles system prompt with card fields', () => {
  const messages = buildMessages({
    character,
    chatHistory: [{ name: 'Bob', is_user: true, mes: 'Hello {{char}}' }],
    userName: 'Bob',
  });
  const system = messages[0];
  assert.equal(system.role, 'system');
  assert.match(system.content, /You are Alice\./);
  assert.match(system.content, /Alice's description: A curious adventurer named Alice\./);
  assert.match(system.content, /Alice's personality: brave/);
  assert.match(system.content, /Scenario: A dark forest\./);
  // Few-shot examples come after system
  assert.deepEqual(messages[1], { role: 'user', content: 'How are you?' });
  assert.deepEqual(messages[2], { role: 'assistant', content: '*smiles* Great!' });
  // History with template replacement
  assert.deepEqual(messages[3], { role: 'user', content: 'Hello Alice' });
  // Post-history instructions land last
  assert.deepEqual(messages.at(-1), { role: 'system', content: 'Stay in character.' });
});

test('failed image turns (bare "<image>" placeholders) are dropped from the prompt', () => {
  const messages = buildMessages({
    character,
    chatHistory: [
      { is_user: true, mes: 'Generate an image of a city' },
      { is_user: false, mes: '<image>' }, // failed image turn persisted in an old chat
      { is_user: true, mes: 'Try again please' },
    ],
    userName: 'Bob',
  });
  assert.ok(!messages.some((m) => m.content === '<image>'));
  // The surrounding turns survive
  assert.ok(messages.some((m) => m.content === 'Generate an image of a city'));
  assert.ok(messages.some((m) => m.content === 'Try again please'));
  // A placeholder WITH a real image is a successful image turn and is kept
  const withImage = buildMessages({
    character,
    chatHistory: [
      { is_user: true, mes: 'Generate an image of a city' },
      { is_user: false, mes: '<image>', _attachments: [{ kind: 'image', dataURL: 'data:image/png;base64,AAAA' }] },
    ],
    userName: 'Bob',
  });
  const imageTurn = withImage.find((m) => m.images);
  assert.deepEqual(imageTurn.images, ['data:image/png;base64,AAAA']);
});

/** The keyword-triggered lore system message, or undefined. */
function loreMessage(messages) {
  return messages.find((m) => m.role === 'system' && m.content.startsWith('Relevant world information:'));
}

test('world info: constant in the leading prompt, keyword entries in a separate message when triggered', () => {
  const worldInfoEntries = [
    { keys: ['dragon'], content: 'Dragons are red.', constant: false, enabled: true },
    { keys: [], content: 'The kingdom is old.', constant: true, enabled: true },
    { keys: ['dragon'], content: 'Disabled lore.', constant: false, enabled: false },
  ];
  const without = buildMessages({
    character,
    chatHistory: [{ is_user: true, mes: 'Nice weather' }],
    userName: 'Bob',
    worldInfoEntries,
  });
  assert.match(without[0].content, /The kingdom is old\./);
  assert.equal(loreMessage(without), undefined);

  const withTrigger = buildMessages({
    character,
    chatHistory: [{ is_user: true, mes: 'Tell me about the DRAGON' }],
    userName: 'Bob',
    worldInfoEntries,
  });
  // Triggered lore stays out of the leading system message (stable prefix)
  assert.doesNotMatch(withTrigger[0].content, /Dragons are red\./);
  assert.match(loreMessage(withTrigger).content, /Dragons are red\./);
  assert.doesNotMatch(loreMessage(withTrigger).content, /Disabled lore\./);
});

test('character book entries trigger from recent messages', () => {
  const charWithBook = {
    ...character,
    character_book: {
      scan_depth: 5,
      entries: [
        { keys: ['sword'], content: 'The sword glows blue.', enabled: true, constant: false, insertion_order: 1 },
        { keys: [], content: 'Always present lore.', enabled: true, constant: true, insertion_order: 0 },
      ],
    },
  };
  const messages = buildMessages({
    character: charWithBook,
    chatHistory: [{ is_user: true, mes: 'Where is the sword?' }],
    userName: 'Bob',
  });
  assert.match(messages[0].content, /Always present lore\./);
  assert.match(loreMessage(messages).content, /The sword glows blue\./);
});

test('trigger flicker leaves the leading system message byte-identical (prompt caching)', () => {
  const worldInfoEntries = [
    { keys: ['dragon'], content: 'Dragons are red.', constant: false, enabled: true },
    { keys: [], content: 'The kingdom is old.', constant: true, enabled: true },
  ];
  const quiet = buildMessages({
    character,
    chatHistory: [{ is_user: true, mes: 'Nice weather' }],
    userName: 'Bob',
    worldInfoEntries,
  });
  const triggered = buildMessages({
    character,
    chatHistory: [{ is_user: true, mes: 'A dragon appears!' }],
    userName: 'Bob',
    worldInfoEntries,
  });
  assert.equal(quiet[0].content, triggered[0].content);
});

test('lore keywords in the compression summary keep triggering after history is compressed', () => {
  const worldInfoEntries = [
    { keys: ['dragon'], content: 'Dragons are red.', constant: false, enabled: true },
  ];
  const charWithBook = {
    ...character,
    character_book: {
      entries: [{ keys: ['Ravenholm'], content: 'Ravenholm is cursed.', enabled: true, constant: false }],
    },
  };
  const messages = buildMessages({
    character: charWithBook,
    chatHistory: [{ is_user: true, mes: 'Let us keep going.' }],
    userName: 'Bob',
    worldInfoEntries,
    summary: 'Bob fought the dragon and set out for Ravenholm.',
  });
  const lore = loreMessage(messages);
  assert.match(lore.content, /Dragons are red\./);
  assert.match(lore.content, /Ravenholm is cursed\./);
  // Placed after the summary and before the remaining history
  const summaryIdx = messages.findIndex((m) => m.content.includes('older messages were compressed'));
  const loreIdx = messages.indexOf(lore);
  const historyIdx = messages.findIndex((m) => m.content === 'Let us keep going.');
  assert.ok(summaryIdx < loreIdx && loreIdx < historyIdx);
});

test('reminder prompt injected before post-history instructions', () => {
  const messages = buildMessages({
    character,
    chatHistory: [{ is_user: true, mes: 'Hi' }],
    userName: 'Bob',
    reminderPrompt: 'Write in present tense, {{user}}.',
  });
  assert.deepEqual(messages.at(-2), { role: 'system', content: 'Write in present tense, Bob.' });
  assert.deepEqual(messages.at(-1), { role: 'system', content: 'Stay in character.' });
});

test('system messages in history are skipped', () => {
  const messages = buildMessages({
    character,
    chatHistory: [
      { is_user: true, mes: 'Hi' },
      { is_system: true, mes: 'meta note' },
      { is_user: false, mes: 'Hello!' },
    ],
    userName: 'Bob',
  });
  assert.ok(!messages.some((m) => m.content === 'meta note'));
});

test('persona description included', () => {
  const messages = buildMessages({
    character,
    chatHistory: [],
    userName: 'Bob',
    persona: { name: 'Bob', description: 'A wandering bard.' },
  });
  assert.match(messages[0].content, /Bob's description: A wandering bard\./);
});

test('persona description gets {{char}}/{{user}} substitution like the card fields', () => {
  const messages = buildMessages({
    character,
    chatHistory: [],
    userName: 'Bob',
    persona: { name: 'Bob', description: '{{user}} travels with {{char}}.' },
  });
  assert.match(messages[0].content, /Bob's description: Bob travels with Alice\./);
});

test('parseExampleMessages handles START markers and prefixes', () => {
  const parsed = parseExampleMessages('<START>\nBob: hi\nAlice: hello\n{{user}}: again\n{{char}}: yes', 'Alice', 'Bob');
  assert.equal(parsed.length, 4);
  assert.equal(parsed[0].role, 'user');
  assert.equal(parsed[1].role, 'assistant');
  assert.equal(parsed[3].content, 'yes');
});

test('context trimming drops oldest history, keeps fixed parts and newest message', () => {
  const filler = 'x'.repeat(400); // ~100 tokens per message
  const chatHistory = Array.from({ length: 10 }, (_, i) => ({
    is_user: i % 2 === 0,
    mes: `${i}-${filler}`,
  }));
  const stats = {};
  const messages = buildMessages({
    character,
    chatHistory,
    userName: 'Bob',
    contextSize: 400,
    maxResponseTokens: 50,
    stats,
  });
  assert.ok(stats.trimmedCount > 0);
  assert.ok(stats.promptTokens > 0);
  // Newest message always survives, oldest goes first
  assert.ok(messages.some((m) => m.content.startsWith('9-')));
  assert.ok(!messages.some((m) => m.content.startsWith('0-')));
  // Fixed parts are never trimmed
  assert.match(messages[0].content, /You are Alice/);
  assert.deepEqual(messages.at(-1), { role: 'system', content: 'Stay in character.' });

  // No contextSize → no trimming
  const untrimmed = {};
  const all = buildMessages({ character, chatHistory, userName: 'Bob', stats: untrimmed });
  assert.equal(untrimmed.trimmedCount, 0);
  assert.ok(all.some((m) => m.content.startsWith('0-')));
});

test('applicableWorldEntries picks global and assigned books', () => {
  const books = [
    { global: true, entries: [{ content: 'g' }], assignedCharacters: [] },
    { global: false, entries: [{ content: 'a' }], assignedCharacters: ['alice.png'] },
    { global: false, entries: [{ content: 'x' }], assignedCharacters: ['other.png'] },
  ];
  const entries = applicableWorldEntries(books, 'alice.png');
  assert.deepEqual(entries.map((e) => e.content), ['g', 'a']);
});

test('world books honor their own scan_depth (default 10)', () => {
  // "dragon" is 4th from the end: outside depth 1 + sticky 0, inside the default 10
  const history = ['a dragon appears', 'm1', 'm2', 'm3'].map((mes, i) => ({ is_user: i % 2 === 0, mes }));
  const entry = { keys: ['dragon'], content: 'Dragons are red.', constant: false, enabled: true, sticky: 0 };
  const shallow = applicableWorldEntries([{ global: true, scan_depth: 1, entries: [entry] }], 'x.png');
  assert.equal(shallow[0].scan_depth, 1);
  const none = buildMessages({ character, chatHistory: history, userName: 'Bob', worldInfoEntries: shallow });
  assert.equal(loreMessage(none), undefined);
  const deep = applicableWorldEntries([{ global: true, entries: [entry] }], 'x.png');
  const hit = buildMessages({ character, chatHistory: history, userName: 'Bob', worldInfoEntries: deep });
  assert.match(loreMessage(hit).content, /Dragons are red\./);
});

test('resolved attachments: images ride along, text files inline, others by name', () => {
  const messages = buildMessages({
    character,
    chatHistory: [
      {
        is_user: true,
        mes: 'What is in this picture?',
        _attachments: [
          { kind: 'image', name: 'photo.png', dataURL: 'data:image/png;base64,AAAA' },
          { kind: 'text', name: 'notes.txt', text: 'line one' },
          { kind: 'file', name: 'report.pdf' },
        ],
      },
    ],
    userName: 'Bob',
  });
  const userMsg = messages.find((m) => m.role === 'user' && m.content.includes('What is in this picture?'));
  assert.deepEqual(userMsg.images, ['data:image/png;base64,AAAA']);
  assert.match(userMsg.content, /\[Attached file: notes\.txt\]\nline one/);
  assert.match(userMsg.content, /\[Attached file: report\.pdf\]/);
});

test('attachment-only message (no text) still enters history', () => {
  const messages = buildMessages({
    character,
    chatHistory: [
      { is_user: true, mes: '', _attachments: [{ kind: 'image', name: 'p.png', dataURL: 'data:image/png;base64,BB' }] },
    ],
    userName: 'Bob',
  });
  const userMsg = messages.find((m) => m.role === 'user' && m.images);
  assert.ok(userMsg);
  assert.deepEqual(userMsg.images, ['data:image/png;base64,BB']);
});

test('chat mode shape: empty card + override yields a single plain system prompt', () => {
  const assistantCard = {
    name: 'Assistant', description: '', personality: '', scenario: '', first_mes: '',
    mes_example: '', system_prompt: '', post_history_instructions: '',
  };
  const messages = buildMessages({
    character: assistantCard,
    chatHistory: [{ is_user: true, mes: 'hello' }],
    userName: 'User',
    systemPromptOverride: 'You are a helpful assistant.',
  });
  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], { role: 'system', content: 'You are a helpful assistant.' });
  assert.deepEqual(messages[1], { role: 'user', content: 'hello' });
});

test('compression summary injected as system message before history', () => {
  const messages = buildMessages({
    character,
    chatHistory: [{ is_user: true, mes: 'What happened next?' }],
    userName: 'Bob',
    summary: 'Bob met Alice at the tavern and they agreed to hunt the dragon.',
  });
  const idx = messages.findIndex((m) => m.role === 'system' && m.content.includes('older messages were compressed'));
  assert.ok(idx > 0, 'summary system message present');
  assert.match(messages[idx].content, /agreed to hunt the dragon/);
  // Summary comes before the remaining history
  const historyIdx = messages.findIndex((m) => m.content === 'What happened next?');
  assert.ok(idx < historyIdx);
  // Master prompt still leads
  assert.match(messages[0].content, /You are Alice/);
});

test('master prompt override + summary coexist in chat-mode shape', () => {
  const assistantCard = {
    name: 'Assistant', description: '', personality: '', scenario: '', first_mes: '',
    mes_example: '', system_prompt: '', post_history_instructions: '',
  };
  const messages = buildMessages({
    character: assistantCard,
    chatHistory: [{ is_user: true, mes: 'go on' }],
    userName: 'User',
    systemPromptOverride: 'MASTER PROMPT',
    summary: 'Earlier: user asked about lighthouses.',
  });
  assert.equal(messages[0].content, 'MASTER PROMPT');
  assert.equal(messages.length, 3); // master, summary, history
  assert.match(messages[1].content, /lighthouses/);
  assert.deepEqual(messages[2], { role: 'user', content: 'go on' });
});

test("author's note is injected at the requested depth", () => {
  const history = ['one', 'two', 'three', 'four', 'five', 'six'].map((mes, i) => ({
    is_user: i % 2 === 0,
    mes,
  }));
  const messages = buildMessages({
    character,
    chatHistory: history,
    userName: 'Bob',
    authorsNote: 'Keep {{char}} mysterious.',
    authorsNoteDepth: 2,
  });
  const noteIdx = messages.findIndex((m) => m.content === 'Keep Alice mysterious.');
  assert.ok(noteIdx > 0, "author's note present");
  assert.equal(messages[noteIdx].role, 'system');
  // Exactly two history messages follow the note (before reminder/post-history)
  const after = messages.slice(noteIdx + 1).filter((m) => m.role !== 'system');
  assert.deepEqual(after.map((m) => m.content), ['five', 'six']);
});

test("author's note deeper than the history clamps to the top of history", () => {
  const messages = buildMessages({
    character: { ...character, post_history_instructions: '' },
    chatHistory: [{ is_user: true, mes: 'only' }],
    userName: 'Bob',
    authorsNote: 'NOTE',
    authorsNoteDepth: 10,
  });
  const noteIdx = messages.findIndex((m) => m.content === 'NOTE');
  assert.equal(messages[noteIdx + 1].content, 'only');
});

test('selective world entries require both a primary and a secondary key', () => {
  const entry = {
    keys: ['dragon'],
    secondary_keys: ['cave'],
    selective: true,
    content: 'The dragon sleeps in the cave.',
    enabled: true,
  };
  const primaryOnly = buildMessages({
    character,
    chatHistory: [{ is_user: true, mes: 'I saw a dragon today' }],
    userName: 'Bob',
    worldInfoEntries: [entry],
  });
  assert.equal(loreMessage(primaryOnly), undefined);

  const both = buildMessages({
    character,
    chatHistory: [{ is_user: true, mes: 'A dragon flew into the cave' }],
    userName: 'Bob',
    worldInfoEntries: [entry],
  });
  assert.match(loreMessage(both).content, /dragon sleeps/);

  // Non-selective entries ignore secondary keys entirely
  const nonSelective = buildMessages({
    character,
    chatHistory: [{ is_user: true, mes: 'I saw a dragon today' }],
    userName: 'Bob',
    worldInfoEntries: [{ ...entry, selective: false }],
  });
  assert.match(loreMessage(nonSelective).content, /dragon sleeps/);
});

test('sticky keeps a triggered entry active after its keyword leaves the scan window', () => {
  // 10 messages; "dragon" is 7th from the end — outside scan_depth 5, inside 5+sticky(2)
  const history = Array.from({ length: 10 }, (_, i) => ({
    is_user: i % 2 === 0,
    mes: i === 3 ? 'A dragon roars in the distance' : `message ${i}`,
  }));
  const bookOf = (sticky) => ({
    ...character,
    character_book: {
      scan_depth: 5,
      entries: [{ keys: ['dragon'], content: 'Dragons are red.', enabled: true, constant: false, ...(sticky != null ? { sticky } : {}) }],
    },
  });
  const withDefault = buildMessages({ character: bookOf(null), chatHistory: history, userName: 'Bob' });
  assert.match(loreMessage(withDefault).content, /Dragons are red\./);
  // sticky 0 disables the hysteresis: same keyword position no longer triggers
  const withZero = buildMessages({ character: bookOf(0), chatHistory: history, userName: 'Bob' });
  assert.equal(loreMessage(withZero), undefined);
  // beyond scan_depth + sticky the entry deactivates even with the default
  const farHistory = history.map((m, i) => (i === 3 ? { ...m, mes: 'message 3' } : m));
  farHistory[1].mes = 'A dragon roars in the distance'; // 9th from the end
  const tooFar = buildMessages({ character: bookOf(null), chatHistory: farHistory, userName: 'Bob' });
  assert.equal(loreMessage(tooFar), undefined);
});

test('triggered lore is capped at a share of the context; oversize entries are skipped, smaller ones still fit', () => {
  const worldInfoEntries = [
    { keys: ['dragon'], content: 'A'.repeat(240), constant: false, enabled: true, insertion_order: 1 }, // ~60 tokens
    { keys: ['dragon'], content: 'B'.repeat(240), constant: false, enabled: true, insertion_order: 2 }, // ~60 tokens — over budget
    { keys: ['dragon'], content: 'C'.repeat(80), constant: false, enabled: true, insertion_order: 3 }, // ~20 tokens — fits the remainder
  ];
  const stats = {};
  const messages = buildMessages({
    character,
    chatHistory: [{ is_user: true, mes: 'the dragon lands' }],
    userName: 'Bob',
    worldInfoEntries,
    contextSize: 400, // lore budget: 100 tokens
    stats,
  });
  const lore = loreMessage(messages);
  assert.match(lore.content, /AAAA/);
  assert.doesNotMatch(lore.content, /BBBB/);
  assert.match(lore.content, /CCCC/);
  assert.equal(stats.loreDropped, 1);
  // Without a context size there is no budget
  const unbounded = {};
  const all = buildMessages({
    character,
    chatHistory: [{ is_user: true, mes: 'the dragon lands' }],
    userName: 'Bob',
    worldInfoEntries,
    stats: unbounded,
  });
  assert.match(loreMessage(all).content, /BBBB/);
  assert.equal(unbounded.loreDropped, 0);
});

test('attached images count toward the trim budget', () => {
  const assistantCard = {
    name: 'Assistant', description: '', personality: '', scenario: '', first_mes: '',
    mes_example: '', system_prompt: '', post_history_instructions: '',
  };
  const chatHistory = [
    { is_user: true, mes: 'x'.repeat(400) }, // ~100 tokens
    { is_user: true, mes: 'look at this', _attachments: [{ kind: 'image', dataURL: 'data:image/png;base64,AA' }] },
  ];
  const stats = {};
  buildMessages({
    character: assistantCard,
    chatHistory,
    userName: 'Bob',
    systemPromptOverride: 'sys',
    contextSize: 1100, // image (~1000) + newest text leaves no room for the older message
    stats,
  });
  assert.equal(stats.trimmedCount, 1);
  // The same history fits easily when the image is not charged for
  const noImage = {};
  buildMessages({
    character: assistantCard,
    chatHistory: [chatHistory[0], { is_user: true, mes: 'look at this' }],
    userName: 'Bob',
    systemPromptOverride: 'sys',
    contextSize: 1100,
    stats: noImage,
  });
  assert.equal(noImage.trimmedCount, 0);
});

test('overflowTokens reports when fixed parts plus the newest message cannot fit', () => {
  const stats = {};
  buildMessages({
    character,
    chatHistory: [{ is_user: true, mes: 'hello' }],
    userName: 'Bob',
    contextSize: 30, // far below the card's own size
    stats,
  });
  assert.ok(stats.overflowTokens > 0);
  assert.equal(stats.trimmedCount, 0); // the newest message is still kept

  const fine = {};
  buildMessages({
    character,
    chatHistory: [{ is_user: true, mes: 'hello' }],
    userName: 'Bob',
    contextSize: 4096,
    stats: fine,
  });
  assert.equal(fine.overflowTokens, 0);
});

test('match_whole_words: no substring false-positives, substring stays the default', () => {
  const entry = { keys: ['art'], content: 'Art lore.', constant: false, enabled: true, match_whole_words: true };
  // "start" contains "art" but is not the word
  const noHit = buildMessages({
    character,
    chatHistory: [{ is_user: true, mes: 'Let us start the journey' }],
    userName: 'Bob',
    worldInfoEntries: [entry],
  });
  assert.equal(loreMessage(noHit), undefined);
  // The bare word (case-folded) triggers, punctuation-adjacent included
  const hit = buildMessages({
    character,
    chatHistory: [{ is_user: true, mes: 'I love modern ART.' }],
    userName: 'Bob',
    worldInfoEntries: [entry],
  });
  assert.match(loreMessage(hit).content, /Art lore\./);
  // Default (flag off) keeps substring semantics — plurals still match
  const plural = buildMessages({
    character,
    chatHistory: [{ is_user: true, mes: 'Three cats sleep here' }],
    userName: 'Bob',
    worldInfoEntries: [{ keys: ['cat'], content: 'Cat lore.', constant: false, enabled: true }],
  });
  assert.match(loreMessage(plural).content, /Cat lore\./);
});

test('match_whole_words falls back to substring for CJK keys and honors extensions on character books', () => {
  // \b is meaningless next to CJK — the key still matches inside a longer run
  const cjk = buildMessages({
    character,
    chatHistory: [{ is_user: true, mes: 'あの魔法使いは強い' }],
    userName: 'Bob',
    worldInfoEntries: [{ keys: ['魔法'], content: 'Magic lore.', constant: false, enabled: true, match_whole_words: true }],
  });
  assert.match(loreMessage(cjk).content, /Magic lore\./);
  // Embedded character books carry the flag under extensions (ST card format)
  const charWithBook = {
    ...character,
    character_book: {
      entries: [{ keys: ['art'], content: 'Book art lore.', enabled: true, constant: false, extensions: { match_whole_words: true } }],
    },
  };
  const noHit = buildMessages({
    character: charWithBook,
    chatHistory: [{ is_user: true, mes: 'the start of it all' }],
    userName: 'Bob',
  });
  assert.equal(loreMessage(noHit), undefined);
  const hit = buildMessages({
    character: charWithBook,
    chatHistory: [{ is_user: true, mes: 'what fine art!' }],
    userName: 'Bob',
  });
  assert.match(loreMessage(hit).content, /Book art lore\./);
});
