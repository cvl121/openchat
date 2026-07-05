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

test('world info: constant always included, keyword entries only when triggered', () => {
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
  assert.doesNotMatch(without[0].content, /Dragons are red\./);

  const withTrigger = buildMessages({
    character,
    chatHistory: [{ is_user: true, mes: 'Tell me about the DRAGON' }],
    userName: 'Bob',
    worldInfoEntries,
  });
  assert.match(withTrigger[0].content, /Dragons are red\./);
  assert.doesNotMatch(withTrigger[0].content, /Disabled lore\./);
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
  assert.match(messages[0].content, /The sword glows blue\./);
  assert.match(messages[0].content, /Always present lore\./);
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
