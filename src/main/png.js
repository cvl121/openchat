// PNG tEXt chunk I/O for TavernCardV2 character cards.
import { t } from '../shared/i18n.js';
// Cards are stored as base64-encoded JSON in a tEXt chunk keyed "chara" (or "ccv3").

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function isPNG(buf) {
  return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE);
}

/** Iterate PNG chunks as { type, data, offset, length } (length = full chunk size on disk). */
export function readChunks(buf) {
  if (!isPNG(buf)) throw new Error(t('errors.notPNG'));
  const chunks = [];
  let pos = 8;
  while (pos + 12 <= buf.length) {
    const dataLen = buf.readUInt32BE(pos);
    // A corrupt length would silently yield a truncated subarray and a
    // desynced walk over the rest of the file — fail loudly instead
    if (pos + 12 + dataLen > buf.length) throw new Error(t('errors.notPNG'));
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + dataLen);
    chunks.push({ type, data, offset: pos, length: dataLen + 12 });
    pos += dataLen + 12;
    if (type === 'IEND') break;
  }
  return chunks;
}

/** Read the text value of a tEXt chunk by keyword, or null. */
export function readTextChunk(buf, keyword) {
  for (const chunk of readChunks(buf)) {
    if (chunk.type !== 'tEXt') continue;
    const sep = chunk.data.indexOf(0);
    if (sep === -1) continue;
    const key = chunk.data.toString('latin1', 0, sep);
    if (key === keyword) {
      return chunk.data.toString('latin1', sep + 1);
    }
  }
  return null;
}

function buildTextChunk(keyword, text) {
  const data = Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Buffer.from([0]),
    Buffer.from(text, 'latin1'),
  ]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from('tEXt', 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

/** Return a new PNG buffer with the keyword's tEXt chunk replaced (inserted before IEND). */
export function writeTextChunk(buf, keyword, text) {
  const chunks = readChunks(buf);
  const parts = [PNG_SIGNATURE];
  for (const chunk of chunks) {
    if (chunk.type === 'tEXt') {
      const sep = chunk.data.indexOf(0);
      const key = sep === -1 ? '' : chunk.data.toString('latin1', 0, sep);
      if (key === keyword) continue; // drop old chunk
    }
    if (chunk.type === 'IEND') {
      parts.push(buildTextChunk(keyword, text));
    }
    parts.push(buf.subarray(chunk.offset, chunk.offset + chunk.length));
  }
  return Buffer.concat(parts);
}

/** Normalize a parsed card (bare CharacterData, V2 card, or ST export wrapper) to TavernCardV2. */
export function normalizeCard(json) {
  let data;
  if (json && json.spec === 'chara_card_v2' && json.data) {
    data = json.data;
  } else if (json && json.data && json.data.name) {
    data = json.data;
  } else if (json && json.name) {
    data = json;
  } else {
    throw new Error(t('errors.unrecognizedCard'));
  }
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    // Spread first so unknown fields survive the round-trip: ST stores
    // talkativeness/depth_prompt/favs in data.extensions, and V3 cards carry
    // assets/nickname/group_only_greetings — dropping any of it would
    // silently strip imported cards on every save.
    data: {
      ...data,
      // Always a string: a numeric/null/object name would break sorting and
      // filename derivation for every other card in the list.
      name: typeof data.name === 'string' && data.name.trim() ? data.name : data.name != null && typeof data.name !== 'object' ? String(data.name) : 'Unnamed',
      description: data.description ?? '',
      personality: data.personality ?? '',
      scenario: data.scenario ?? '',
      first_mes: data.first_mes ?? '',
      mes_example: data.mes_example ?? '',
      creator_notes: data.creator_notes ?? '',
      system_prompt: data.system_prompt ?? '',
      post_history_instructions: data.post_history_instructions ?? '',
      alternate_greetings: data.alternate_greetings ?? [],
      character_book: data.character_book ?? null,
      tags: data.tags ?? [],
      creator: data.creator ?? '',
      character_version: data.character_version ?? '',
    },
  };
}

/** Parse a TavernCardV2 from a character PNG. Tries "chara" then "ccv3" keywords. */
export function parseCharacterCard(buf) {
  // One chunk walk for both keywords — the walk reads the whole (multi-MB) file
  let chara = null;
  let ccv3 = null;
  for (const chunk of readChunks(buf)) {
    if (chunk.type !== 'tEXt') continue;
    const sep = chunk.data.indexOf(0);
    if (sep === -1) continue;
    const key = chunk.data.toString('latin1', 0, sep);
    if (key === 'chara' && chara === null) chara = chunk.data.toString('latin1', sep + 1);
    else if (key === 'ccv3' && ccv3 === null) ccv3 = chunk.data.toString('latin1', sep + 1);
  }
  const text = chara ?? ccv3;
  if (!text) throw new Error(t('errors.noCardInPNG'));
  const json = JSON.parse(Buffer.from(text, 'base64').toString('utf8'));
  return normalizeCard(json);
}

/** Embed a TavernCardV2 into a PNG buffer, returning the new buffer. */
export function embedCharacterCard(buf, card) {
  const b64 = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');
  return writeTextChunk(buf, 'chara', b64);
}

/** A minimal valid 1x1 transparent PNG, for characters created without an avatar. */
export function minimalPNG() {
  // Pre-built 1x1 RGBA transparent PNG
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  );
}
