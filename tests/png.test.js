import test from 'node:test';
import assert from 'node:assert/strict';
import {
  crc32,
  isPNG,
  readChunks,
  readTextChunk,
  writeTextChunk,
  parseCharacterCard,
  embedCharacterCard,
  normalizeCard,
  minimalPNG,
} from '../src/main/png.js';

test('crc32 matches known value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('minimalPNG is a valid PNG with IHDR/IEND', () => {
  const png = minimalPNG();
  assert.ok(isPNG(png));
  const types = readChunks(png).map((c) => c.type);
  assert.equal(types[0], 'IHDR');
  assert.equal(types.at(-1), 'IEND');
});

test('write and read tEXt chunk round-trip', () => {
  const png = writeTextChunk(minimalPNG(), 'chara', 'aGVsbG8=');
  assert.ok(isPNG(png));
  assert.equal(readTextChunk(png, 'chara'), 'aGVsbG8=');
  // Replacing overwrites rather than duplicating
  const png2 = writeTextChunk(png, 'chara', 'd29ybGQ=');
  assert.equal(readTextChunk(png2, 'chara'), 'd29ybGQ=');
  const textChunks = readChunks(png2).filter((c) => c.type === 'tEXt');
  assert.equal(textChunks.length, 1);
});

test('character card embed/parse round-trip', () => {
  const card = normalizeCard({
    name: 'Test Character',
    description: 'A test — with unicode ✨',
    first_mes: 'Hello!',
  });
  const png = embedCharacterCard(minimalPNG(), card);
  const parsed = parseCharacterCard(png);
  assert.equal(parsed.spec, 'chara_card_v2');
  assert.equal(parsed.data.name, 'Test Character');
  assert.equal(parsed.data.description, 'A test — with unicode ✨');
  assert.deepEqual(parsed.data.alternate_greetings, []);
});

test('normalizeCard preserves extensions and V3 fields through round-trips', () => {
  const card = normalizeCard({
    spec: 'chara_card_v2',
    data: {
      name: 'Keeper',
      extensions: { talkativeness: '0.8', depth_prompt: { prompt: 'deep', depth: 4 }, fav: true },
      assets: [{ type: 'icon', uri: 'embedded://x.png' }],
      nickname: 'Kee',
      group_only_greetings: ['hi all'],
    },
  });
  assert.deepEqual(card.data.extensions, {
    talkativeness: '0.8',
    depth_prompt: { prompt: 'deep', depth: 4 },
    fav: true,
  });
  assert.equal(card.data.nickname, 'Kee');
  assert.deepEqual(card.data.group_only_greetings, ['hi all']);
  // And through a PNG embed/parse cycle (i.e. every save)
  const parsed = parseCharacterCard(embedCharacterCard(minimalPNG(), card));
  assert.deepEqual(parsed.data.extensions.depth_prompt, { prompt: 'deep', depth: 4 });
  assert.deepEqual(parsed.data.assets, [{ type: 'icon', uri: 'embedded://x.png' }]);
  assert.equal(parsed.data.name, 'Keeper');
});

test('normalizeCard handles V2 wrapper and bare data', () => {
  const v2 = normalizeCard({ spec: 'chara_card_v2', data: { name: 'A', tags: ['x'] } });
  assert.equal(v2.data.name, 'A');
  assert.deepEqual(v2.data.tags, ['x']);
  const bare = normalizeCard({ name: 'B' });
  assert.equal(bare.data.name, 'B');
  assert.throws(() => normalizeCard({ not: 'a card' }));
});

test('readChunks rejects a chunk length that overruns the buffer', () => {
  const png = minimalPNG();
  // Corrupt the first chunk's length field to point past the end of the file
  const evil = Buffer.from(png);
  evil.writeUInt32BE(0x00ffffff, 8);
  assert.throws(() => readChunks(evil), /PNG/);
});
