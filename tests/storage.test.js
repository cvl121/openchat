import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  initStorage,
  loadSettings,
  saveSettings,
  saveCharacter,
  listCharacters,
  deleteCharacter,
  createChat,
  loadChat,
  appendMessage,
  rewriteChat,
  listChats,
  searchChats,
  exportChatJSONL,
  importChatJSONL,
  exportWorldInfo,
  listPersonas,
  savePersonas,
  saveWorldInfo,
  listWorldInfo,
  listPresets,
  savePreset,
  mapSTPreset,
  importUpload,
  exportUpload,
  saveUploadData,
  readUploadData,
  deleteChat,
  deletePreset,
  deleteWorldInfo,
  sanitizeFilename,
  safeChild,
  DEFAULT_SETTINGS,
} from '../src/main/storage.js';
import { embedCharacterCard, minimalPNG } from '../src/main/png.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'etavern-test-'));
initStorage(tmp);
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('settings: defaults on missing file, round-trip on save', () => {
  const fresh = loadSettings();
  assert.equal(fresh.activeAPI, 'openrouter');
  assert.equal(fresh.uiMode, 'regular');
  fresh.apiKeys.openrouter = 'sk-test';
  fresh.uiMode = 'advanced';
  saveSettings(fresh);
  const reloaded = loadSettings();
  assert.equal(reloaded.apiKeys.openrouter, 'sk-test');
  assert.equal(reloaded.uiMode, 'advanced');
  // New default fields merge into older settings files
  assert.equal(typeof reloaded.generationParams.temperature, 'number');
});

test('settings: chat-mode feature defaults are present', () => {
  fs.rmSync(path.join(tmp, 'user', 'settings.json'), { force: true });
  const fresh = loadSettings();
  assert.deepEqual(fresh.pinnedConversations, []);
  assert.deepEqual(fresh.modelPricingCache, {});
  assert.equal(fresh.showCostEstimates, true);
});

test('chats: listChats cache stays fresh across append and rewrite', async () => {
  const { file } = createChat('CacheChar', 'User');
  const first = listChats('CacheChar').find((c) => c.file === file);
  assert.equal(first.messageCount, 0);
  await appendMessage('CacheChar', file, { name: 'User', is_user: true, mes: 'hello cache' });
  const afterAppend = listChats('CacheChar').find((c) => c.file === file);
  assert.equal(afterAppend.messageCount, 1);
  assert.equal(afterAppend.preview, 'hello cache');
  const meta = { ...afterAppend.metadata, title: 'Renamed' };
  await rewriteChat('CacheChar', file, meta, [{ name: 'User', is_user: true, mes: 'rewritten' }]);
  const afterRewrite = listChats('CacheChar').find((c) => c.file === file);
  assert.equal(afterRewrite.metadata.title, 'Renamed');
  assert.equal(afterRewrite.preview, 'rewritten');
  // Unchanged files return the same cached entry object
  const again = listChats('CacheChar').find((c) => c.file === file);
  assert.equal(again, afterRewrite);
});

test('settings: unread conversations default to empty and round-trip', () => {
  fs.rmSync(path.join(tmp, 'user', 'settings.json'), { force: true });
  const fresh = loadSettings();
  assert.deepEqual(fresh.unreadConversations, {});
  fresh.unreadConversations['Assistant/Assistant - 2026-08-11@10h30m00s.jsonl'] = true;
  saveSettings(fresh);
  const reloaded = loadSettings();
  assert.deepEqual(reloaded.unreadConversations, {
    'Assistant/Assistant - 2026-08-11@10h30m00s.jsonl': true,
  });
});

test('settings: loaded objects never alias the shared defaults', () => {
  fs.rmSync(path.join(tmp, 'user', 'settings.json'), { force: true });
  const first = loadSettings();
  first.apiKeys.openrouter = 'polluted';
  first.pinnedCharacters.push('x.png');
  const second = loadSettings();
  assert.equal(second.apiKeys.openrouter, undefined);
  assert.deepEqual(second.pinnedCharacters, []);
  assert.deepEqual(DEFAULT_SETTINGS.pinnedCharacters, []);
});

test('characters: save, list, unique filenames, delete', async () => {
  const { filename } = await saveCharacter({ name: 'Hero', description: 'd1' });
  assert.equal(filename, 'Hero.png');
  const { filename: second } = await saveCharacter({ name: 'Hero', description: 'd2' });
  assert.equal(second, 'Hero 2.png');
  const list = listCharacters();
  assert.equal(list.length, 2);
  assert.equal(list[0].card.data.name, 'Hero');
  // Update in place keeps the filename
  const updated = await saveCharacter({ name: 'Hero Renamed' }, { filename });
  assert.equal(updated.filename, filename);
  await deleteCharacter(second);
  assert.equal(listCharacters().length, 1);
});

test('characters: deleting a character archives its chats away from a future namesake', async () => {
  const { filename } = await saveCharacter({ name: 'Ghost' });
  const chat = createChat('Ghost', 'User');
  await appendMessage('Ghost', chat.file, { name: 'User', is_user: true, mes: 'old history', send_date: '2026-01-01' });
  assert.equal(listChats('Ghost').length, 1);

  await deleteCharacter(filename);
  assert.ok(!fs.existsSync(path.join(tmp, 'chats', 'Ghost')));
  const archived = fs.readdirSync(path.join(tmp, 'chats', '_archived'));
  assert.equal(archived.filter((d) => d.startsWith('Ghost (deleted ')).length, 1);

  // A new character with the same name starts with no history
  await saveCharacter({ name: 'Ghost' });
  assert.equal(listChats('Ghost').length, 0);
  // The archive is invisible to search and cross-character scans
  assert.equal((await searchChats('old history')).length, 0);
});

test('characters: chats survive deletion while a same-name card remains', async () => {
  await saveCharacter({ name: 'Twin' });
  const { filename: dupe } = await saveCharacter({ name: 'Twin' });
  createChat('Twin', 'User');
  await deleteCharacter(dupe);
  assert.equal(listChats('Twin').length, 1);
});

test('chats: create, append, rewrite, list, search', async () => {
  const chat = createChat('Hero', 'User');
  assert.equal(chat.metadata.character_name, 'Hero');
  await appendMessage('Hero', chat.file, { name: 'User', is_user: true, mes: 'Hello world', send_date: '2026-01-01' });
  await appendMessage('Hero', chat.file, { name: 'Hero', is_user: false, mes: 'Greetings, traveler!', send_date: '2026-01-01' });
  let loaded = await loadChat('Hero', chat.file);
  assert.equal(loaded.messages.length, 2);

  loaded.messages[1].mes = 'Edited reply';
  loaded.messages[1].swipes = ['Edited reply', 'Alt reply'];
  await rewriteChat('Hero', chat.file, loaded.metadata, loaded.messages);
  loaded = await loadChat('Hero', chat.file);
  assert.equal(loaded.messages[1].mes, 'Edited reply');
  assert.deepEqual(loaded.messages[1].swipes, ['Edited reply', 'Alt reply']);

  const chats = listChats('Hero');
  assert.equal(chats.length, 1);
  assert.equal(chats[0].messageCount, 2);

  const hits = await searchChats('hello', 'Hero');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].index, 0);
  assert.ok((await searchChats('hello')).length >= 1); // global search
  assert.equal((await searchChats('zzz-no-match')).length, 0);
});

test('personas: default fallback and round-trip', () => {
  const defaults = listPersonas();
  assert.equal(defaults[0].name, 'User');
  savePersonas([{ id: 'p1', name: 'Bard', description: 'sings', avatarFilename: null }]);
  assert.equal(listPersonas()[0].name, 'Bard');
});

test('world info: save, list, ST field normalization', () => {
  saveWorldInfo({ name: 'My World', entries: [{ keys: ['castle'], content: 'Big castle.', constant: false, enabled: true }], global: true });
  const books = listWorldInfo();
  assert.equal(books.length, 1);
  assert.equal(books[0].entries[0].content, 'Big castle.');
  assert.equal(books[0].global, true);

  // SillyTavern style: entries as object map with key/disable variants
  fs.writeFileSync(
    path.join(tmp, 'worlds', 'st.json'),
    JSON.stringify({ name: 'ST World', entries: { 0: { key: ['inn'], content: 'Cozy inn.', disable: true, order: 5 } } })
  );
  const all = listWorldInfo();
  const st = all.find((b) => b.name === 'ST World');
  assert.deepEqual(st.entries[0].keys, ['inn']);
  assert.equal(st.entries[0].enabled, false);
  assert.equal(st.entries[0].insertion_order, 5);
});

test('characters: renaming migrates the chat folder and metadata', async () => {
  const { filename } = await saveCharacter({ name: 'Mover' });
  const chat = createChat('Mover', 'User');
  await appendMessage('Mover', chat.file, { name: 'User', is_user: true, mes: 'hi', send_date: '2026-01-01' });
  await saveCharacter({ name: 'Mover II' }, { filename });
  assert.ok(!fs.existsSync(path.join(tmp, 'chats', 'Mover')));
  const chats = listChats('Mover II');
  assert.equal(chats.length, 1);
  assert.equal(chats[0].metadata.character_name, 'Mover II');
  const loaded = await loadChat('Mover II', chat.file);
  assert.equal(loaded.messages.length, 1);
  assert.equal(loaded.messages[0].mes, 'hi');
});

test('settings: API keys encrypted at rest when secrets are provided', () => {
  const encrypt = (s) => Buffer.from(s, 'utf8').toString('base64');
  const decrypt = (s) => Buffer.from(s, 'base64').toString('utf8');
  initStorage(tmp, { encryptString: encrypt, decryptString: decrypt });
  const s = loadSettings();
  s.apiKeys.openai = 'sk-secret';
  saveSettings(s);
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'user', 'settings.json'), 'utf8'));
  assert.equal(onDisk.apiKeys, undefined);
  assert.ok(!JSON.stringify(onDisk).includes('sk-secret'));
  const reloaded = loadSettings();
  assert.equal(reloaded.apiKeys.openai, 'sk-secret');
  initStorage(tmp); // restore plaintext mode for later tests
});

test('presets: default always present, ST field mapping', () => {
  let presets = listPresets();
  assert.equal(presets[0].name, 'Default');
  savePreset({ name: 'Creative', generationParams: { ...DEFAULT_SETTINGS.generationParams, temperature: 1.2 } });
  presets = listPresets();
  assert.equal(presets.find((p) => p.name === 'Creative').generationParams.temperature, 1.2);
  assert.throws(() => savePreset({ name: 'Default', generationParams: {} }));

  const mapped = mapSTPreset({ temp: 0.9, rep_pen: 1.1, genamt: 512, top_k: 40 });
  assert.equal(mapped.temperature, 0.9);
  assert.equal(mapped.repetition_penalty, 1.1);
  assert.equal(mapped.max_tokens, 512);
  assert.equal(mapped.top_k, 40);
  // No explicit context in the preset → auto context stays on
  assert.equal(mapped.context_size_auto, true);

  // An explicit ST context size means that context, not auto
  const withContext = mapSTPreset({ max_context: 32768 });
  assert.equal(withContext.context_size, 32768);
  assert.equal(withContext.context_size_auto, false);
});

test('uploads: import copies a file and classifies its kind', () => {
  const src = path.join(tmp, 'notes.md');
  fs.writeFileSync(src, '# hello');
  const info = importUpload(src);
  assert.equal(info.kind, 'text');
  assert.equal(info.mime, 'text/markdown');
  assert.equal(info.name, 'notes.md');
  assert.ok(fs.existsSync(path.join(tmp, 'uploads', info.file)));
  // Reading a text upload returns its contents
  assert.deepEqual(readUploadData(info.file), { kind: 'text', text: '# hello' });
});

test('uploads: data URL round-trips as an image', () => {
  const pixel =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const info = saveUploadData('generated', pixel);
  assert.equal(info.kind, 'image');
  assert.equal(info.mime, 'image/png');
  assert.ok(info.file.endsWith('.png'));
  const back = readUploadData(info.file);
  assert.equal(back.kind, 'image');
  assert.equal(back.dataURL, pixel);
});

test('uploads: rejects non-data-URL payloads', () => {
  assert.throws(() => saveUploadData('x.png', 'not-a-data-url'), /data URL/);
});

test('settings: failed decryption never wipes the stored key blob', () => {
  const encrypt = (s) => Buffer.from(s, 'utf8').toString('base64');
  const decrypt = (s) => Buffer.from(s, 'base64').toString('utf8');
  initStorage(tmp, { encryptString: encrypt, decryptString: decrypt });
  const s = loadSettings();
  s.apiKeys = { openai: 'sk-keepme' };
  saveSettings(s);
  // Keychain locked/denied: decryption throws
  initStorage(tmp, {
    encryptString: encrypt,
    decryptString: () => {
      throw new Error('denied');
    },
  });
  const locked = loadSettings();
  assert.deepEqual(locked.apiKeys, {});
  assert.ok(locked.apiKeysEncrypted); // blob survived the load
  saveSettings(locked); // must not re-encrypt the empty map over the blob
  initStorage(tmp, { encryptString: encrypt, decryptString: decrypt });
  assert.equal(loadSettings().apiKeys.openai, 'sk-keepme');
  initStorage(tmp); // restore plaintext mode for later tests
});

test('chats: exported filenames are sanitized against traversal', async () => {
  await assert.rejects(() => exportChatJSONL('Hero', '../../user/settings.json', path.join(tmp, 'stolen.json')));
  assert.ok(!fs.existsSync(path.join(tmp, 'stolen.json')));
});

test('chats: SillyTavern JSONL import round-trips messages and swipes', async () => {
  const src = path.join(tmp, 'st-chat.jsonl');
  const lines = [
    { user_name: 'Traveler', character_name: 'Old Name', create_date: '2025-05-01', chat_metadata: { note: 'x' } },
    { name: 'Traveler', is_user: true, mes: 'Hello there', send_date: '2025-05-01' },
    { name: 'Old Name', is_user: false, mes: 'Well met', send_date: '2025-05-01', swipes: ['Well met', 'Greetings'], swipe_id: 1 },
  ];
  fs.writeFileSync(src, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const { file, badLines } = importChatJSONL('Hero', src);
  assert.equal(badLines, 0);
  const { metadata, messages } = await loadChat('Hero', file);
  assert.equal(metadata.character_name, 'Hero'); // rebound to the importing character
  assert.equal(metadata.user_name, 'Traveler');
  assert.deepEqual(metadata.chat_metadata, { note: 'x' });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].mes, 'Hello there');
  assert.deepEqual(messages[1].swipes, ['Well met', 'Greetings']);
  assert.equal(messages[1].swipe_id, 1);

  // Headerless files (every line a message) are tolerated
  fs.writeFileSync(src, JSON.stringify({ name: 'X', is_user: true, mes: 'solo line' }) + '\n');
  const file2 = importChatJSONL('Hero', src).file;
  assert.equal((await loadChat('Hero', file2)).messages[0].mes, 'solo line');

  // A malformed line is skipped and reported; the rest of the chat survives
  fs.writeFileSync(
    src,
    JSON.stringify({ user_name: 'T', character_name: 'C', chat_metadata: {} }) + '\n' +
      JSON.stringify({ name: 'T', is_user: true, mes: 'kept 1' }) + '\n' +
      'truncated {"name": "T", "is_us\n' +
      JSON.stringify({ name: 'C', is_user: false, mes: 'kept 2' }) + '\n'
  );
  const tolerant = importChatJSONL('Hero', src);
  assert.equal(tolerant.badLines, 1);
  assert.deepEqual((await loadChat('Hero', tolerant.file)).messages.map((m) => m.mes), ['kept 1', 'kept 2']);

  // Entirely malformed files are still rejected
  fs.writeFileSync(src, 'not json at all\n');
  assert.throws(() => importChatJSONL('Hero', src), /JSONL/);
});

test('world info: selective flag normalizes and export writes ST format', () => {
  const saved = saveWorldInfo({
    name: 'Exportia',
    entries: [
      {
        keys: ['dragon'],
        secondary_keys: ['red'],
        selective: true,
        content: 'The red dragon.',
        constant: false,
        enabled: false,
        insertion_order: 7,
      },
      // ST-style field name aliases normalize on read
      { keys: ['knight'], content: 'A knight.', matchWholeWords: true },
    ],
    global: false,
  });
  const book = listWorldInfo().find((b) => b.name === 'Exportia');
  assert.equal(book.entries[0].selective, true);
  assert.deepEqual(book.entries[0].secondary_keys, ['red']);
  assert.equal(book.entries[0].sticky, 2); // default when absent
  assert.equal(book.entries[0].match_whole_words, false); // default when absent
  assert.equal(book.entries[1].match_whole_words, true);

  const dest = path.join(tmp, 'exportia-st.json');
  exportWorldInfo(saved.file, dest);
  const st = JSON.parse(fs.readFileSync(dest, 'utf8'));
  assert.deepEqual(st.entries['0'].key, ['dragon']);
  assert.deepEqual(st.entries['0'].keysecondary, ['red']);
  assert.equal(st.entries['0'].selective, true);
  assert.equal(st.entries['0'].disable, true);
  assert.equal(st.entries['0'].order, 7);
  assert.equal(st.entries['0'].sticky, 2);
  assert.equal(st.entries['0'].matchWholeWords, false);
  assert.equal(st.entries['1'].matchWholeWords, true);
});

test('settings: chat mode is the default app mode', () => {
  assert.equal(DEFAULT_SETTINGS.appMode, 'chat');
  assert.equal(DEFAULT_SETTINGS.requestImageOutput, false);
});

test('uploads: exportUpload copies the file to a chosen destination', () => {
  const info = saveUploadData('to-export.png',
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
  const dest = path.join(tmp, 'exported-copy.png');
  exportUpload(info.file, dest);
  assert.ok(fs.existsSync(dest));
  assert.deepEqual(fs.readFileSync(dest).subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

test('filenames: dot names and traversal never escape their folder', async () => {
  assert.equal(sanitizeFilename('.'), 'Unnamed');
  assert.equal(sanitizeFilename('..'), 'Unnamed');
  assert.equal(sanitizeFilename(''), 'Unnamed');
  assert.equal(sanitizeFilename('  '), 'Unnamed');
  assert.equal(sanitizeFilename(null), 'Unnamed');
  // Slashes are neutralized, so "../x" becomes a plain sibling-free name
  assert.equal(sanitizeFilename('../x'), '.._x');

  // The path guard is the second layer: anything that still resolves outside
  // its parent (or onto the parent itself) throws.
  const parent = path.join(tmp, 'chats');
  assert.throws(() => safeChild(parent, '..'));
  assert.throws(() => safeChild(parent, '.'));
  assert.throws(() => safeChild(parent, ''));
  assert.throws(() => safeChild(parent, '../user/settings.json'));
  assert.throws(() => safeChild(parent, 'Hero/../../user/settings.json'));
  assert.throws(() => safeChild(parent, path.join(tmp, 'user', 'settings.json'))); // absolute
  assert.equal(safeChild(parent, 'Hero'), path.join(parent, 'Hero'));
  assert.equal(safeChild(parent, '.._x'), path.join(parent, '.._x'));

  // End to end: hostile names reach the delete/export paths without touching
  // anything outside their folder.
  const settings = path.join(tmp, 'user', 'settings.json');
  saveSettings(loadSettings());
  const before = fs.readFileSync(settings, 'utf8');
  await deleteChat('..', '../user/settings.json');
  await deleteChat('Hero', '../../user/settings.json');
  await deleteWorldInfo('../user/settings.json');
  deletePreset('../user/settings');
  assert.throws(() => exportUpload('../user/settings.json', path.join(tmp, 'stolen.json')), /ENOENT/);
  await deleteCharacter('../user/settings.json');
  assert.equal(fs.readFileSync(settings, 'utf8'), before);
  assert.ok(!fs.existsSync(path.join(tmp, 'stolen.json')));
});

test('characters: a card with a non-string name does not break the list', async () => {
  // Write raw cards that bypass normalizeCard, as a foreign tool might
  const raw = (name) => embedCharacterCard(minimalPNG(), { spec: 'chara_card_v2', spec_version: '2.0', data: { name, description: '' } });
  fs.writeFileSync(path.join(tmp, 'characters', 'numeric-name.png'), raw(42));
  fs.writeFileSync(path.join(tmp, 'characters', 'null-name.png'), raw(null));
  const list = listCharacters();
  const numeric = list.find((c) => c.filename === 'numeric-name.png');
  const nulled = list.find((c) => c.filename === 'null-name.png');
  assert.equal(numeric.card.data.name, '42');
  assert.equal(nulled.card.data.name, 'Unnamed');
  assert.ok(list.every((c) => typeof c.card.data.name === 'string'));
  await deleteCharacter('numeric-name.png');
  await deleteCharacter('null-name.png');
});

test('settings: a corrupt settings.json is quarantined and its key blob survives', () => {
  const encrypt = (s) => Buffer.from(s, 'utf8').toString('base64');
  const decrypt = (s) => Buffer.from(s, 'base64').toString('utf8');
  const file = path.join(tmp, 'user', 'settings.json');
  initStorage(tmp, { encryptString: encrypt, decryptString: decrypt });
  const s = loadSettings();
  s.apiKeys = { openai: 'sk-survivor' };
  s.uiMode = 'advanced';
  saveSettings(s);
  const blob = JSON.parse(fs.readFileSync(file, 'utf8')).apiKeysEncrypted;
  // Truncate the file mid-way: valid blob, invalid JSON
  const good = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, good.slice(0, good.lastIndexOf('}')) + ',\n  "trailing": ');
  const loaded = loadSettings();
  assert.equal(loaded.uiMode, 'regular'); // defaults for everything else
  assert.equal(loaded.apiKeysEncrypted, blob);
  assert.deepEqual(loaded.apiKeys, {});
  const backups = fs.readdirSync(path.join(tmp, 'user')).filter((f) => f.startsWith('settings.json.corrupt-'));
  assert.equal(backups.length, 1);
  // Saving (even with a new key typed in) keeps the undecrypted blob intact
  loaded.apiKeys = { gemini: 'new-key' };
  saveSettings(loaded);
  assert.equal(loadSettings().apiKeys.openai, 'sk-survivor');
  for (const b of backups) fs.rmSync(path.join(tmp, 'user', b));
  initStorage(tmp);
});

test('settings: a new key entered while the keychain is locked never replaces the blob', () => {
  const encrypt = (s) => Buffer.from(s, 'utf8').toString('base64');
  const decrypt = (s) => Buffer.from(s, 'base64').toString('utf8');
  initStorage(tmp, { encryptString: encrypt, decryptString: decrypt });
  const s = loadSettings();
  s.apiKeys = { openai: 'sk-keepme', claude: 'sk-me-too' };
  saveSettings(s);
  initStorage(tmp, { encryptString: encrypt, decryptString: () => { throw new Error('denied'); } });
  const locked = loadSettings();
  assert.equal(locked.apiKeysDecryptFailed, true);
  locked.apiKeys = { gemini: 'typed-while-locked' };
  saveSettings(locked); // must not encrypt {gemini} over {openai, claude}
  initStorage(tmp, { encryptString: encrypt, decryptString: decrypt });
  const back = loadSettings();
  assert.equal(back.apiKeys.openai, 'sk-keepme');
  assert.equal(back.apiKeys.claude, 'sk-me-too');
  assert.equal(back.apiKeysDecryptFailed, undefined);
  initStorage(tmp);
});
