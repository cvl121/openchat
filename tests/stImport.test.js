import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initStorage,
  listCharacters,
  listChats,
  loadChat,
  listWorldInfo,
  listPersonas,
  listPresets,
  saveWorldInfo,
} from '../src/main/storage.js';
import { detectSTDataDir, scanSTFolder, importSTFolder, uniqueName } from '../src/main/stImport.js';
import { embedCharacterCard, minimalPNG } from '../src/main/png.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openchat-stimport-'));
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'st-fixture-'));
initStorage(tmp);
test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(fixtures, { recursive: true, force: true });
});

const ALL = { characters: true, chats: true, lorebooks: true, personas: true, presets: true };

function write(root, rel, content) {
  const full = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function cardPNG(name) {
  return embedCharacterCard(minimalPNG(), {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: { name, description: `${name} desc`, first_mes: 'Hi', tags: [] },
  });
}

/** Build a SillyTavern user-data dir under root/<prefix>. */
function makeSTFixture(userDir) {
  write(userDir, 'characters/Alice.png', cardPNG('Alice'));
  write(userDir, 'characters/broken.png', Buffer.from('not a png'));
  write(
    userDir,
    'chats/Alice/chat1.jsonl',
    [
      JSON.stringify({ user_name: 'Bob', character_name: 'Alice', create_date: '2025-01-01', chat_metadata: {} }),
      JSON.stringify({ name: 'Bob', is_user: true, mes: 'hello', send_date: '2025-01-01' }),
      JSON.stringify({ name: 'Alice', is_user: false, mes: 'hi', send_date: '2025-01-01', swipes: ['hi', 'hey'], swipe_id: 1 }),
    ].join('\n') + '\n'
  );
  // Character that is not imported as a card — chats must still land
  write(
    userDir,
    'chats/Ghost/old.jsonl',
    [
      JSON.stringify({ user_name: 'Bob', character_name: 'Ghost', create_date: '2024-01-01', chat_metadata: {} }),
      JSON.stringify({ name: 'Ghost', is_user: false, mes: 'boo' }),
    ].join('\n') + '\n'
  );
  // ST keeps entries as an object map with its own field names
  write(
    userDir,
    'worlds/MyLore.json',
    JSON.stringify({
      name: 'MyLore',
      entries: {
        0: { uid: 0, key: ['dragon'], keysecondary: ['fire'], content: 'Dragons breathe fire.', disable: false, order: 5 },
      },
    })
  );
  write(
    userDir,
    'settings.json',
    JSON.stringify({
      power_user: {
        personas: { 'ava.png': 'Alice', 'missing.png': 'Bob' },
        persona_descriptions: { 'ava.png': { description: 'desc A', position: 0 } },
        default_persona: 'ava.png',
      },
    })
  );
  write(userDir, 'User Avatars/ava.png', minimalPNG());
  write(
    userDir,
    'OpenAI Settings/Creative.json',
    JSON.stringify({ temp: 1.2, openai_max_tokens: 512, prompts: [{ identifier: 'main', content: 'junk' }] })
  );
  // Same preset name in a second API folder — must dedupe within the run
  write(userDir, 'TextGen Settings/Creative.json', JSON.stringify({ temp: 0.5 }));
}

const stRoot = path.join(fixtures, 'SillyTavern');
const userDir = path.join(stRoot, 'data', 'default-user');
makeSTFixture(userDir);

test('uniqueName suffixes against taken names', () => {
  assert.equal(uniqueName('A', new Set()), 'A');
  assert.equal(uniqueName('A', new Set(['A'])), 'A 2');
  assert.equal(uniqueName('A', new Set(['A', 'A 2'])), 'A 3');
});

test('detectSTDataDir resolves all supported layouts', () => {
  assert.equal(detectSTDataDir(stRoot), userDir); // install root
  assert.equal(detectSTDataDir(path.join(stRoot, 'data')), userDir); // data folder
  assert.equal(detectSTDataDir(userDir), userDir); // user dir directly
  // custom user handle (no default-user)
  const custom = path.join(fixtures, 'custom');
  write(custom, 'data/alice-handle/characters/x.png', cardPNG('X'));
  assert.equal(detectSTDataDir(custom), path.join(custom, 'data', 'alice-handle'));
  // legacy < 1.12 layout
  const legacy = path.join(fixtures, 'legacy');
  write(legacy, 'public/characters/x.png', cardPNG('X'));
  assert.equal(detectSTDataDir(legacy), path.join(legacy, 'public'));
  // not SillyTavern at all
  const unrelated = path.join(fixtures, 'unrelated');
  write(unrelated, 'readme.txt', 'hi');
  assert.equal(detectSTDataDir(unrelated), null);
  assert.throws(() => scanSTFolder(unrelated), /No SillyTavern data found/);
});

test('scanSTFolder counts every category', () => {
  const scan = scanSTFolder(stRoot);
  assert.equal(scan.dir, userDir);
  assert.deepEqual(scan.counts, { characters: 2, chats: 2, lorebooks: 1, personas: 2, presets: 2 });
});

test('importSTFolder imports all categories, reports failures, keeps going', async () => {
  const ticks = [];
  const res = await importSTFolder(userDir, { categories: ALL, onProgress: (p) => ticks.push(p) });
  // Progress fires once per file-backed item with a stable total
  assert.ok(ticks.length > 0);
  assert.ok(ticks.every((p) => p.total === ticks[0].total && p.done >= 1 && p.done <= p.total));
  assert.equal(ticks.at(-1).done, ticks[0].total);

  assert.equal(res.imported.characters, 1);
  assert.equal(res.skipped.characters, 1); // broken.png
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], /characters\/broken\.png/);

  const chars = listCharacters();
  assert.ok(chars.some((c) => c.card.data.name === 'Alice'));

  // Chats: header-driven name, swipes preserved, orphan character still lands
  assert.equal(res.imported.chats, 2);
  const aliceChats = listChats('Alice');
  assert.equal(aliceChats.length, 1);
  const chat = loadChat('Alice', aliceChats[0].file);
  assert.equal(chat.messages.length, 2);
  assert.deepEqual(chat.messages[1].swipes, ['hi', 'hey']);
  assert.equal(chat.messages[1].swipe_id, 1);
  assert.equal(chat.metadata.user_name, 'Bob');
  assert.equal(listChats('Ghost').length, 1);

  // Lorebook: ST object-map entries normalized
  const books = listWorldInfo();
  const lore = books.find((b) => b.name === 'MyLore');
  assert.ok(lore);
  assert.deepEqual(lore.entries[0].keys, ['dragon']);
  assert.deepEqual(lore.entries[0].secondary_keys, ['fire']);
  assert.equal(lore.entries[0].enabled, true);
  assert.equal(lore.entries[0].insertion_order, 5);

  // Personas: avatar copied when present, null when missing
  const personas = listPersonas();
  const alice = personas.find((p) => p.name === 'Alice');
  const bob = personas.find((p) => p.name === 'Bob');
  assert.equal(alice.description, 'desc A');
  assert.ok(alice.avatarFilename);
  assert.ok(fs.existsSync(path.join(tmp, 'User Avatars', alice.avatarFilename)));
  assert.equal(bob.avatarFilename, null);

  // Presets: params mapped, junk prompt fields dropped, same-name deduped in-run
  const presets = listPresets();
  const creative = presets.find((p) => p.name === 'Creative');
  const creative2 = presets.find((p) => p.name === 'Creative 2');
  assert.equal(creative.generationParams.temperature, 1.2);
  assert.equal(creative.generationParams.max_tokens, 512);
  assert.equal(creative.generationParams.prompts, undefined);
  assert.equal(creative2.generationParams.temperature, 0.5);
});

test('re-import keeps both: originals untouched, imports suffixed', async () => {
  const res = await importSTFolder(userDir, { categories: ALL });
  assert.equal(res.imported.characters, 1);

  // Character file suffixed, original card intact
  const files = fs.readdirSync(path.join(tmp, 'characters')).sort();
  assert.deepEqual(files, ['Alice 2.png', 'Alice.png']);

  const books = listWorldInfo();
  assert.ok(books.some((b) => b.name === 'MyLore'));
  assert.ok(books.some((b) => b.name === 'MyLore 2'));
  assert.equal(books.find((b) => b.name === 'MyLore').entries[0].content, 'Dragons breathe fire.');

  const names = listPersonas().map((p) => p.name);
  for (const n of ['Alice', 'Bob', 'Alice 2', 'Bob 2']) assert.ok(names.includes(n), n);

  const presetNames = listPresets().map((p) => p.name);
  for (const n of ['Creative', 'Creative 2', 'Creative 3', 'Creative 4']) assert.ok(presetNames.includes(n), n);

  // Chats always import as fresh files
  assert.equal(listChats('Alice').length, 2);
});

test('lorebook name collision with an existing file basename is avoided', async () => {
  // A local book whose FILE is Solo.json but whose NAME is different
  saveWorldInfo({ name: 'Something Else', file: 'Solo.json', entries: [] });
  const soloDir = path.join(fixtures, 'solo-st');
  write(soloDir, 'worlds/Solo.json', JSON.stringify({ name: 'Solo', entries: {} }));
  write(soloDir, 'characters/.keep', ''); // make it look like a user dir
  await importSTFolder(soloDir, { categories: { lorebooks: true } });
  const before = listWorldInfo().find((b) => b.file === 'Solo.json');
  assert.equal(before.name, 'Something Else'); // not overwritten
  assert.ok(listWorldInfo().some((b) => b.name === 'Solo 2'));
});

test('category filtering imports only what is checked', async () => {
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'openchat-stimport2-'));
  initStorage(tmp2);
  try {
    const res = await importSTFolder(userDir, { categories: { characters: true } });
    assert.equal(res.imported.characters, 1);
    assert.equal(res.imported.chats + res.imported.lorebooks + res.imported.personas + res.imported.presets, 0);
    assert.equal(listWorldInfo().length, 0);
    assert.equal(listChats('Alice').length, 0);
    assert.equal(listPresets().length, 1); // just Default
  } finally {
    initStorage(tmp); // restore for any later tests
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
});
