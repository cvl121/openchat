// All on-disk persistence. Formats are compatible with SillyTavern:
//   characters/  PNG files with embedded TavernCardV2 (tEXt "chara" chunk)
//   chats/{CharName}/  JSONL files (line 1 = metadata, lines 2+ = messages)
//   worlds/      JSON world info books
//   presets/     JSON generation-parameter presets
//   user/        settings.json, personas.json
//   User Avatars/  persona avatar images
//
// This module is Electron-free so tests can exercise it under plain Node:
// call initStorage(dataDir) before use.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  isPNG,
  parseCharacterCard,
  embedCharacterCard,
  normalizeCard,
  minimalPNG,
} from './png.js';
import { sanitizeFilename } from '../shared/filenames.js';
import { PROVIDERS } from '../shared/providers.js';
import { foldText, truncateChars } from '../shared/text.js';
import { t } from '../shared/i18n.js';

export { sanitizeFilename };

let DATA_DIR = null;

// OS-keychain string encryption (Electron safeStorage), injected by main.js so
// this module stays Electron-free for tests. Null = store secrets in plaintext.
let SECRETS = { encryptString: null, decryptString: null };

// OS-trash mover (Electron shell.trashItem), injected by main.js for the same
// reason. Null = hard delete.
let TRASH_ITEM = null;

export function setTrashItem(fn) {
  TRASH_ITEM = fn;
}

async function removeFile(full) {
  if (!fs.existsSync(full)) return;
  if (TRASH_ITEM) {
    try {
      await TRASH_ITEM(full);
      return;
    } catch {
      // e.g. no trash on this filesystem — fall through to hard delete
    }
  }
  fs.unlinkSync(full);
}

const SUBDIRS = ['characters', 'chats', 'worlds', 'user', 'User Avatars', 'presets', 'uploads'];

export function initStorage(dataDir, secrets = {}) {
  DATA_DIR = dataDir;
  SECRETS = {
    encryptString: secrets.encryptString ?? null,
    decryptString: secrets.decryptString ?? null,
  };
  fs.mkdirSync(dataDir, { recursive: true });
  for (const sub of SUBDIRS) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  }
}

export function dataDir() {
  if (!DATA_DIR) throw new Error('Storage not initialized');
  return DATA_DIR;
}

export function resolveDataPath(relPath) {
  const resolved = path.resolve(dataDir(), relPath);
  if (!resolved.startsWith(path.resolve(dataDir()) + path.sep)) {
    throw new Error('Path escapes data directory');
  }
  return resolved;
}

/**
 * Write a file atomically: write to a temp sibling, then rename over the target.
 * rename(2) is atomic within a filesystem, so a reader (or a crash) never sees a
 * half-written file — the destination is either the old contents or the new ones.
 */
function writeFileAtomic(filePath, data) {
  const tmp = `${filePath}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Settings

export const DEFAULT_GENERATION_PARAMS = {
  max_tokens: 2048,
  context_size: 16384,
  // Match the selected model's advertised max context when the provider
  // reports one; context_size is the fallback for models that don't.
  context_size_auto: true,
  temperature: 0.7,
  top_p: 1.0,
  top_k: 0,
  frequency_penalty: 0.0,
  presence_penalty: 0.0,
  repetition_penalty: 1.0,
  stop_sequences: [],
  stream_response: true,
  min_p: 0.0,
  top_a: 0.0,
  typical_p: 1.0,
  tfs: 1.0,
  mirostat_mode: 0,
  mirostat_tau: 5.0,
  mirostat_eta: 0.1,
  seed: -1,
};

export const DEFAULT_SETTINGS = {
  appMode: 'chat', // chat (general assistant) | roleplay (Story mode: characters, personas, lore)
  language: 'system', // UI language: system | en | es | zh-CN | ja
  lastSeenVersion: '', // last app version launched; drives the What's New dialog
  chatSystemPrompt: '', // chat-mode system prompt ('' = built-in default)
  requestImageOutput: false, // ask the chat model itself for image responses (advanced)
  // Dedicated image generation (🎨 button): provider '' = same as chat
  imageGen: { enabled: false, provider: '', model: '' },
  // Summarize older messages so long chats stop resending the full history
  chatCompression: { enabled: true, afterMessages: 60, prompt: '' },
  appFontSize: 13, // base UI font size (px)
  appFontFamily: 'system', // system | serif | rounded | mono
  activeAPI: 'openrouter',
  userName: 'User',
  theme: 'system', // system | light | dark
  uiMode: 'regular', // regular | advanced
  uiScale: 1.0,
  apiKeys: {},
  models: {}, // per-provider selected model
  baseURLs: {}, // per-provider base URL overrides (advanced)
  generationParams: { ...DEFAULT_GENERATION_PARAMS },
  activePresetName: 'Default',
  activePersonaId: null,
  characterPersonas: {}, // character filename -> persona id
  pinnedCharacters: [],
  systemPromptOverride: '',
  reminderPrompt: '',
  lastCharacterFilename: null,
  chatStyle: {
    quoteColor: '#e8b75f',
    actionColor: '#a89bd4',
    narrativeColor: '#d8d8e0',
    fontSize: 14,
  },
  sendOnEnter: true,
  unreadConversations: {}, // "CharName/chatfile.jsonl" -> true (reply finished while backgrounded)
  modelContextCache: {}, // "provider|modelId" -> advertised max context (0 = provider doesn't report one)
  modelPricingCache: {}, // "provider|modelId" -> {inPerM, outPerM} USD per million tokens
  pinnedConversations: [], // chat-mode conversation files pinned to the top of the sidebar
  showCostEstimates: true, // estimate per-reply cost from token counts and known model pricing
  updateCheck: true, // daily version check against GitHub Releases
  skippedUpdateVersion: '', // release the user chose to ignore
  developerMode: false,
  onboardingComplete: false,
  sidebarWidth: 280,
  chatInputHeight: 76,
};

function settingsPath() {
  return path.join(dataDir(), 'user', 'settings.json');
}

export function loadSettings() {
  // Deep-clone defaults so callers can never mutate the shared DEFAULT_SETTINGS
  // objects through nested fields (apiKeys, models, pinnedCharacters, …)
  const base = structuredClone(DEFAULT_SETTINGS);
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    const settings = {
      ...base,
      ...raw,
      generationParams: { ...base.generationParams, ...(raw.generationParams ?? {}) },
      chatStyle: { ...base.chatStyle, ...(raw.chatStyle ?? {}) },
      chatCompression: { ...base.chatCompression, ...(raw.chatCompression ?? {}) },
      imageGen: { ...base.imageGen, ...(raw.imageGen ?? {}) },
    };
    // Settings saved by older versions may reference a provider that no
    // longer exists — fall back to the default rather than crash the UI.
    if (!PROVIDERS[settings.activeAPI]) settings.activeAPI = base.activeAPI;
    if (settings.imageGen.provider && !PROVIDERS[settings.imageGen.provider]) {
      settings.imageGen.provider = '';
    }
    // API keys encrypted at rest via the OS keychain. Keep the opaque blob if
    // decryption is unavailable so a later save doesn't wipe the keys.
    if (settings.apiKeysEncrypted && SECRETS.decryptString) {
      try {
        settings.apiKeys = {
          ...settings.apiKeys,
          ...JSON.parse(SECRETS.decryptString(settings.apiKeysEncrypted)),
        };
        delete settings.apiKeysEncrypted;
      } catch {}
    }
    return settings;
  } catch {
    return base;
  }
}

export function saveSettings(settings) {
  let out = settings;
  if (SECRETS.encryptString) {
    const { apiKeys, apiKeysEncrypted, ...rest } = settings;
    // A surviving apiKeysEncrypted blob means loadSettings could not decrypt it
    // (keychain locked/denied). With no decrypted keys in hand, re-encrypting
    // would replace the user's stored keys with an empty map — keep the blob.
    const blob =
      apiKeysEncrypted && !Object.keys(apiKeys ?? {}).length
        ? apiKeysEncrypted
        : SECRETS.encryptString(JSON.stringify(apiKeys ?? {}));
    out = { ...rest, apiKeysEncrypted: blob };
  }
  writeFileAtomic(settingsPath(), JSON.stringify(out, null, 2));
  return true;
}

// ---------------------------------------------------------------------------
// Characters

function charactersDir() {
  return path.join(dataDir(), 'characters');
}

// Parsed-card cache keyed by filename; avatars are multi-MB PNGs and the list
// is re-read after every save/import, so only re-parse files that changed.
const cardCache = new Map(); // filename -> { mtimeMs, size, card }

/** List all characters: [{ filename, card, mtime }] sorted by name. */
export function listCharacters() {
  const out = [];
  const seen = new Set();
  for (const file of fs.readdirSync(charactersDir())) {
    if (!file.toLowerCase().endsWith('.png')) continue;
    const full = path.join(charactersDir(), file);
    try {
      const stat = fs.statSync(full);
      seen.add(file);
      const cached = cardCache.get(file);
      let card;
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        card = cached.card;
      } else {
        card = parseCharacterCard(fs.readFileSync(full));
        cardCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, card });
      }
      out.push({ filename: file, card, mtime: stat.mtimeMs });
    } catch {
      // Skip unreadable/cardless PNGs
      cardCache.delete(file);
    }
  }
  for (const key of cardCache.keys()) {
    if (!seen.has(key)) cardCache.delete(key);
  }
  out.sort((a, b) => a.card.data.name.localeCompare(b.card.data.name));
  return out;
}

/** Import a character from a PNG (embedded card) or JSON file. Returns { filename, card }. */
export function importCharacter(filePath) {
  const buf = fs.readFileSync(filePath);
  let card;
  let avatar;
  if (isPNG(buf)) {
    card = parseCharacterCard(buf);
    avatar = buf;
  } else {
    card = normalizeCard(JSON.parse(buf.toString('utf8')));
    avatar = minimalPNG();
  }
  return saveCharacter(card, { avatarBuffer: avatar });
}

/**
 * Save (create or update) a character.
 * opts.filename — existing file to overwrite; opts.avatarBuffer / opts.avatarPath — new avatar image.
 */
export function saveCharacter(card, opts = {}) {
  card = normalizeCard(card);
  let avatar = null;
  if (opts.avatarBuffer) avatar = Buffer.from(opts.avatarBuffer);
  else if (opts.avatarPath) avatar = fs.readFileSync(opts.avatarPath);

  let filename = opts.filename ? sanitizeFilename(opts.filename) : null;
  if (!filename) {
    const base = sanitizeFilename(card.data.name);
    filename = `${base}.png`;
    let i = 2;
    while (fs.existsSync(path.join(charactersDir(), filename))) {
      filename = `${base} ${i++}.png`;
    }
  }
  const full = path.join(charactersDir(), filename);
  // Chats are keyed by character name; detect renames so history follows
  let previousName = null;
  if (opts.filename && fs.existsSync(full)) {
    try {
      previousName = parseCharacterCard(fs.readFileSync(full)).data.name;
    } catch {}
  }
  if (!avatar) {
    avatar = fs.existsSync(full) ? fs.readFileSync(full) : minimalPNG();
  }
  if (!isPNG(avatar)) throw new Error(t('errors.avatarMustBePNG'));
  writeFileAtomic(full, embedCharacterCard(avatar, card));
  if (previousName && previousName !== card.data.name) {
    migrateChats(previousName, card.data.name);
  }
  return { filename, card };
}

/** Move a renamed character's chat folder and update chat metadata to match. */
function migrateChats(oldName, newName) {
  const oldDir = chatsDirFor(oldName);
  if (!fs.existsSync(oldDir)) return;
  const newDir = chatsDirFor(newName);
  try {
    if (!fs.existsSync(newDir)) {
      fs.renameSync(oldDir, newDir);
    } else {
      for (const file of fs.readdirSync(oldDir)) {
        try {
          fs.renameSync(path.join(oldDir, file), path.join(newDir, file));
        } catch {}
      }
      try {
        fs.rmdirSync(oldDir);
      } catch {} // non-empty (collisions) — leave it
    }
    // Update the metadata line so history and search show the new name
    for (const file of fs.readdirSync(newDir)) {
      if (!file.endsWith('.jsonl')) continue;
      try {
        const filePath = path.join(newDir, file);
        const content = fs.readFileSync(filePath, 'utf8');
        const nl = content.indexOf('\n');
        const metadata = JSON.parse(nl === -1 ? content : content.slice(0, nl));
        if (metadata.character_name === oldName) {
          metadata.character_name = newName;
          const rest = nl === -1 ? '\n' : content.slice(nl);
          writeFileAtomic(filePath, JSON.stringify(metadata) + rest);
        }
      } catch {}
    }
  } catch {}
}

export async function deleteCharacter(filename) {
  await removeFile(path.join(charactersDir(), sanitizeFilename(filename)));
  // Keep chat history on disk: chats live in their own dirs, independent of the card
  return true;
}

export function exportCharacter(filename, destPath) {
  fs.copyFileSync(path.join(charactersDir(), sanitizeFilename(filename)), destPath);
  return true;
}

export function exportCharacterJSON(filename, destPath) {
  const buf = fs.readFileSync(path.join(charactersDir(), sanitizeFilename(filename)));
  const card = parseCharacterCard(buf);
  fs.writeFileSync(destPath, JSON.stringify(card, null, 2));
  return true;
}

// ---------------------------------------------------------------------------
// Chats (JSONL: first line metadata, then one message per line)

function chatsDirFor(characterName) {
  return path.join(dataDir(), 'chats', sanitizeFilename(characterName));
}

function chatTimestamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}@${pad(d.getHours())}h${pad(d.getMinutes())}m${pad(d.getSeconds())}s`;
}

/** List chats for a character, newest first: [{ file, metadata, messageCount, mtime, preview }] */
// The chat list is rebuilt after every send/receive; without a cache that
// re-reads and re-parses every conversation file each time. Entries are keyed
// by mtime+size so any append or rewrite invalidates (mtime alone can collide
// within one millisecond under rapid writes).
const chatListCache = new Map(); // "CharName/file" -> {stamp, entry}

export function listChats(characterName) {
  const dir = chatsDirFor(characterName);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue;
    try {
      const st = fs.statSync(path.join(dir, file));
      const cacheKey = `${characterName}/${file}`;
      const stamp = `${st.mtimeMs}:${st.size}`;
      const cached = chatListCache.get(cacheKey);
      if (cached?.stamp === stamp) {
        out.push(cached.entry);
        continue;
      }
      const lines = fs
        .readFileSync(path.join(dir, file), 'utf8')
        .split('\n')
        .filter((l) => l.trim());
      const metadata = lines.length ? JSON.parse(lines[0]) : {};
      let preview = '';
      if (lines.length > 1) {
        try {
          // Code-point truncation: .slice could split an astral CJK char/emoji
          preview = truncateChars(JSON.parse(lines[lines.length - 1]).mes ?? '', 120);
        } catch {}
      }
      const entry = {
        file,
        metadata,
        messageCount: Math.max(0, lines.length - 1),
        mtime: st.mtimeMs,
        preview,
      };
      chatListCache.set(cacheKey, { stamp, entry });
      out.push(entry);
    } catch {}
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

export function createChat(characterName, userName) {
  const dir = chatsDirFor(characterName);
  fs.mkdirSync(dir, { recursive: true });
  const file = `${sanitizeFilename(characterName)} - ${chatTimestamp()}-${crypto.randomUUID().slice(0, 8)}.jsonl`;
  const metadata = {
    user_name: userName,
    character_name: characterName,
    create_date: new Date().toISOString(),
    chat_metadata: {},
  };
  writeFileAtomic(path.join(dir, file), JSON.stringify(metadata) + '\n');
  return { file, metadata, messages: [] };
}

export function loadChat(characterName, file) {
  const full = path.join(chatsDirFor(characterName), sanitizeFilename(file));
  const lines = fs
    .readFileSync(full, 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  const metadata = lines.length ? JSON.parse(lines[0]) : {};
  const messages = [];
  for (const line of lines.slice(1)) {
    try {
      messages.push(JSON.parse(line));
    } catch {}
  }
  return { file, metadata, messages };
}

export function appendMessage(characterName, file, message) {
  fs.appendFileSync(path.join(chatsDirFor(characterName), sanitizeFilename(file)), JSON.stringify(message) + '\n');
  return true;
}

/** Rewrite the whole chat file (used after edits, swipes, deletions). */
export function rewriteChat(characterName, file, metadata, messages) {
  const lines = [JSON.stringify(metadata), ...messages.map((m) => JSON.stringify(m))];
  writeFileAtomic(path.join(chatsDirFor(characterName), sanitizeFilename(file)), lines.join('\n') + '\n');
  return true;
}

export async function deleteChat(characterName, file) {
  await removeFile(path.join(chatsDirFor(characterName), sanitizeFilename(file)));
  return true;
}

const SEARCH_LIMIT = 200;

/** Search all chats for a character (or all characters if name is null).
 *  Case- and accent-insensitive ("jose" matches "José"). */
export function searchChats(query, characterName = null) {
  const q = foldText(query);
  const results = [];
  const chatsRoot = path.join(dataDir(), 'chats');
  if (!fs.existsSync(chatsRoot)) return results;
  const dirs = characterName
    ? [sanitizeFilename(characterName)]
    : fs.readdirSync(chatsRoot).filter((d) => fs.statSync(path.join(chatsRoot, d)).isDirectory());
  for (const dir of dirs) {
    const dirPath = path.join(chatsRoot, dir);
    if (!fs.existsSync(dirPath)) continue;
    for (const file of fs.readdirSync(dirPath)) {
      if (!file.endsWith('.jsonl')) continue;
      try {
        const { metadata, messages } = loadChat(dir, file);
        for (let index = 0; index < messages.length; index++) {
          const m = messages[index];
          if (foldText(m.mes ?? '').includes(q)) {
            results.push({
              characterName: metadata.character_name ?? dir,
              file,
              index,
              name: m.name,
              isUser: !!m.is_user,
              snippet: snippetAround(m.mes, q),
            });
            if (results.length >= SEARCH_LIMIT) return results;
          }
        }
      } catch {}
    }
  }
  return results;
}

/**
 * Directory name (sanitized character name) of the most recently modified
 * chat file, or null. Stat-only — used for cheap session restore at startup.
 */
export function lastActiveChatCharacter() {
  const chatsRoot = path.join(dataDir(), 'chats');
  if (!fs.existsSync(chatsRoot)) return null;
  let best = null;
  for (const entry of fs.readdirSync(chatsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(chatsRoot, entry.name);
    for (const file of fs.readdirSync(dirPath)) {
      if (!file.endsWith('.jsonl')) continue;
      try {
        const mtime = fs.statSync(path.join(dirPath, file)).mtimeMs;
        if (!best || mtime > best.mtime) best = { dir: entry.name, mtime };
      } catch {}
    }
  }
  return best?.dir ?? null;
}

function snippetAround(text, q) {
  // foldText is length-preserving, so the folded index maps onto the original
  const idx = foldText(text).indexOf(q);
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + q.length + 60);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

export function exportChatMarkdown(characterName, file, destPath) {
  const { metadata, messages } = loadChat(characterName, file);
  let md = `# ${metadata.character_name ?? characterName}\n\n`;
  for (const m of messages) {
    md += `**${m.name}** (${m.send_date ?? ''})\n\n${m.mes}\n\n---\n\n`;
  }
  fs.writeFileSync(destPath, md);
  return true;
}

export function exportChatJSONL(characterName, file, destPath) {
  fs.copyFileSync(path.join(chatsDirFor(characterName), sanitizeFilename(file)), destPath);
  return true;
}

/**
 * Import a SillyTavern-format JSONL chat. Line 1 is the metadata header
 * (headerless files — every line a message — are tolerated). Returns the new
 * chat file name.
 */
export function importChatJSONL(characterName, sourcePath) {
  const rawLines = fs
    .readFileSync(sourcePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim());
  if (!rawLines.length) throw new Error(t('errors.chatFileEmpty'));
  const parsed = rawLines.map((line, i) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(t('errors.notJSONLLine', { line: i + 1 }));
    }
  });
  let header = parsed[0];
  let messageLines = parsed.slice(1);
  if (typeof header !== 'object' || header === null || header.mes !== undefined) {
    messageLines = parsed;
    header = {};
  }
  const messages = messageLines.map((m, i) => {
    if (typeof m?.mes !== 'string') throw new Error(t('errors.notJSONLNoText', { line: i + 2 }));
    const out = {
      name: m.name ?? (m.is_user ? header.user_name ?? 'User' : characterName),
      is_user: !!m.is_user,
      mes: m.mes,
      send_date: m.send_date ?? '',
    };
    if (Array.isArray(m.swipes) && m.swipes.length) {
      out.swipes = m.swipes.map(String);
      out.swipe_id =
        Number.isInteger(m.swipe_id) && m.swipe_id >= 0 && m.swipe_id < m.swipes.length ? m.swipe_id : 0;
    }
    if (m.extra && typeof m.extra === 'object') out.extra = m.extra;
    return out;
  });
  const dir = chatsDirFor(characterName);
  fs.mkdirSync(dir, { recursive: true });
  const file = `${sanitizeFilename(characterName)} - imported ${chatTimestamp()}-${crypto.randomUUID().slice(0, 8)}.jsonl`;
  const metadata = {
    user_name: header.user_name ?? 'User',
    character_name: characterName,
    create_date: header.create_date ?? new Date().toISOString(),
    chat_metadata: header.chat_metadata ?? {},
  };
  const lines = [JSON.stringify(metadata), ...messages.map((m) => JSON.stringify(m))];
  writeFileAtomic(path.join(dir, file), lines.join('\n') + '\n');
  return file;
}

// ---------------------------------------------------------------------------
// World Info

function worldsDir() {
  return path.join(dataDir(), 'worlds');
}

/** Normalize SillyTavern world info field variants into our canonical shape. */
function normalizeWorldEntry(e) {
  return {
    keys: e.keys ?? e.key ?? [],
    secondary_keys: e.secondary_keys ?? e.keysecondary ?? [],
    content: e.content ?? '',
    comment: e.comment ?? '',
    constant: !!e.constant,
    selective: !!e.selective,
    enabled: e.enabled ?? (e.disable !== undefined ? !e.disable : true),
    case_sensitive: !!(e.case_sensitive ?? e.caseSensitive),
    insertion_order: e.insertion_order ?? e.order ?? 100,
    position: e.position ?? 'before_char',
  };
}

export function listWorldInfo() {
  const out = [];
  for (const file of fs.readdirSync(worldsDir())) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(worldsDir(), file), 'utf8'));
      let entries = raw.entries ?? [];
      if (!Array.isArray(entries)) entries = Object.values(entries); // ST uses an object map
      out.push({
        file,
        name: raw.name ?? file.replace(/\.json$/, ''),
        entries: entries.map(normalizeWorldEntry),
        global: !!raw.global,
        assignedCharacters: raw.assignedCharacters ?? [],
      });
    } catch {}
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function saveWorldInfo(book) {
  const file = book.file ? sanitizeFilename(book.file) : `${sanitizeFilename(book.name)}.json`;
  writeFileAtomic(path.join(worldsDir(), file), JSON.stringify({ ...book, file }, null, 2));
  return { ...book, file };
}

export async function deleteWorldInfo(file) {
  await removeFile(path.join(worldsDir(), sanitizeFilename(file)));
  return true;
}

/** Write a world book to destPath in SillyTavern world-info JSON format. */
export function exportWorldInfo(file, destPath) {
  const book = listWorldInfo().find((b) => b.file === sanitizeFilename(file));
  if (!book) throw new Error(t('errors.worldBookNotFound', { file }));
  const entries = {};
  book.entries.forEach((e, i) => {
    entries[i] = {
      uid: i,
      key: e.keys,
      keysecondary: e.secondary_keys,
      content: e.content,
      comment: e.comment,
      constant: e.constant,
      disable: !e.enabled,
      selective: !!e.selective,
      caseSensitive: e.case_sensitive,
      order: e.insertion_order,
      position: e.position === 'after_char' || e.position === 1 ? 1 : 0,
    };
  });
  fs.writeFileSync(destPath, JSON.stringify({ name: book.name, entries }, null, 2));
  return true;
}

export function importWorldInfo(filePath, overrides = {}) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  let entries = raw.entries ?? [];
  if (!Array.isArray(entries)) entries = Object.values(entries);
  const name = overrides.name ?? raw.name ?? path.basename(filePath, '.json');
  const book = { name, entries: entries.map(normalizeWorldEntry), global: false, assignedCharacters: [] };
  if (overrides.file) book.file = overrides.file;
  return saveWorldInfo(book);
}

// ---------------------------------------------------------------------------
// Personas

function personasPath() {
  return path.join(dataDir(), 'user', 'personas.json');
}

export function listPersonas() {
  try {
    const list = JSON.parse(fs.readFileSync(personasPath(), 'utf8'));
    if (Array.isArray(list) && list.length) return list;
  } catch {}
  return [{ id: 'default', name: 'User', description: '', avatarFilename: null }];
}

export function savePersonas(personas) {
  writeFileAtomic(personasPath(), JSON.stringify(personas, null, 2));
  return true;
}

export function savePersonaAvatar(personaId, sourcePath) {
  const ext = path.extname(sourcePath) || '.png';
  const filename = `${sanitizeFilename(personaId)}${ext}`;
  fs.copyFileSync(sourcePath, path.join(dataDir(), 'User Avatars', filename));
  return filename;
}

// ---------------------------------------------------------------------------
// Uploads (chat attachments + model-generated images)

const UPLOAD_MIMES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', log: 'text/plain',
  json: 'application/json', xml: 'application/xml', yaml: 'text/yaml', yml: 'text/yaml',
  html: 'text/html', css: 'text/css', js: 'text/javascript', ts: 'text/typescript', py: 'text/x-python',
  pdf: 'application/pdf',
};
const TEXT_KINDS = new Set(['txt', 'md', 'csv', 'log', 'json', 'xml', 'yaml', 'yml', 'html', 'css', 'js', 'ts', 'py']);
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function uploadsDir() {
  return path.join(dataDir(), 'uploads');
}

function uploadKind(ext) {
  const mime = UPLOAD_MIMES[ext] ?? 'application/octet-stream';
  if (mime.startsWith('image/')) return 'image';
  if (TEXT_KINDS.has(ext)) return 'text';
  return 'file';
}

function storeUpload(name, buffer) {
  if (buffer.length > MAX_UPLOAD_BYTES) throw new Error(t('errors.fileTooLarge'));
  const ext = (path.extname(name).slice(1) || 'bin').toLowerCase();
  const base = sanitizeFilename(path.basename(name, path.extname(name))).slice(0, 60) || 'file';
  const file = `${base}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
  writeFileAtomic(path.join(uploadsDir(), file), buffer);
  return {
    file,
    name: path.basename(name),
    mime: UPLOAD_MIMES[ext] ?? 'application/octet-stream',
    kind: uploadKind(ext),
    size: buffer.length,
  };
}

/** Copy a user-picked file into uploads/. Returns { file, name, mime, kind, size }. */
export function importUpload(sourcePath) {
  return storeUpload(path.basename(sourcePath), fs.readFileSync(sourcePath));
}

/** Save in-memory data (a data: URL — pasted or model-generated) into uploads/. */
export function saveUploadData(name, dataURL) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataURL ?? '');
  if (!match) throw new Error(t('errors.expectedDataURL'));
  const [, mime, b64] = match;
  const extFromMime = Object.entries(UPLOAD_MIMES).find(([, m]) => m === mime)?.[0];
  const named = path.extname(name) ? name : `${name}.${extFromMime ?? 'bin'}`;
  return storeUpload(named, Buffer.from(b64, 'base64'));
}

/** Copy an upload (e.g. a generated image) out of the data dir. */
export function exportUpload(file, destPath) {
  fs.copyFileSync(path.join(uploadsDir(), sanitizeFilename(file)), destPath);
  return true;
}

/** Read an upload back for prompt building: images → dataURL, text → text. */
export function readUploadData(file) {
  const full = path.join(uploadsDir(), sanitizeFilename(file));
  const ext = (path.extname(file).slice(1) || 'bin').toLowerCase();
  const kind = uploadKind(ext);
  const buffer = fs.readFileSync(full);
  if (kind === 'image') {
    return { kind, dataURL: `data:${UPLOAD_MIMES[ext]};base64,${buffer.toString('base64')}` };
  }
  if (kind === 'text') return { kind, text: buffer.toString('utf8') };
  return { kind };
}

// ---------------------------------------------------------------------------
// Presets

function presetsDir() {
  return path.join(dataDir(), 'presets');
}

export function listPresets() {
  const out = [{ name: 'Default', generationParams: { ...DEFAULT_GENERATION_PARAMS } }];
  for (const file of fs.readdirSync(presetsDir())) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(presetsDir(), file), 'utf8'));
      const name = raw.name ?? file.replace(/\.json$/, '');
      if (name === 'Default') continue;
      out.push({
        name,
        generationParams: { ...DEFAULT_GENERATION_PARAMS, ...(raw.generationParams ?? mapSTPreset(raw)) },
      });
    } catch {}
  }
  return out;
}

export function savePreset(preset) {
  if (preset.name === 'Default') throw new Error(t('errors.defaultPresetReadonly'));
  writeFileAtomic(
    path.join(presetsDir(), `${sanitizeFilename(preset.name)}.json`),
    JSON.stringify(preset, null, 2)
  );
  return true;
}

export function deletePreset(name) {
  const full = path.join(presetsDir(), `${sanitizeFilename(name)}.json`);
  if (fs.existsSync(full)) fs.unlinkSync(full);
  return true;
}

/** Map SillyTavern preset field names to our GenerationParameters. */
export function mapSTPreset(raw) {
  const p = { ...DEFAULT_GENERATION_PARAMS };
  const map = {
    temp: 'temperature',
    temperature: 'temperature',
    top_p: 'top_p',
    top_k: 'top_k',
    top_a: 'top_a',
    min_p: 'min_p',
    typical_p: 'typical_p',
    tfs: 'tfs',
    rep_pen: 'repetition_penalty',
    repetition_penalty: 'repetition_penalty',
    freq_pen: 'frequency_penalty',
    frequency_penalty: 'frequency_penalty',
    presence_pen: 'presence_penalty',
    presence_penalty: 'presence_penalty',
    max_length: 'max_tokens',
    genamt: 'max_tokens',
    openai_max_tokens: 'max_tokens',
    max_context: 'context_size',
    openai_max_context: 'context_size',
    mirostat_mode: 'mirostat_mode',
    mirostat_tau: 'mirostat_tau',
    mirostat_eta: 'mirostat_eta',
    seed: 'seed',
  };
  for (const [stKey, ourKey] of Object.entries(map)) {
    if (raw[stKey] !== undefined && raw[stKey] !== null) p[ourKey] = raw[stKey];
  }
  // A preset that sets an explicit context wants that context, not auto
  if (raw.max_context != null || raw.openai_max_context != null) p.context_size_auto = false;
  if (Array.isArray(raw.stop_sequence)) p.stop_sequences = raw.stop_sequence;
  if (raw.stream !== undefined) p.stream_response = !!raw.stream;
  return p;
}

export function importPreset(filePath) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const name = raw.name ?? path.basename(filePath, '.json');
  const preset = {
    name: name === 'Default' ? `${name} (imported)` : name,
    generationParams: raw.generationParams
      ? { ...DEFAULT_GENERATION_PARAMS, ...raw.generationParams }
      : mapSTPreset(raw),
  };
  savePreset(preset);
  return preset;
}

export function exportPreset(name, destPath) {
  const preset = listPresets().find((p) => p.name === name);
  if (!preset) throw new Error(t('errors.presetNotFound', { name }));
  fs.writeFileSync(destPath, JSON.stringify(preset, null, 2));
  return true;
}

// ---------------------------------------------------------------------------
// Data folder import

/** Copy compatible data from another data directory with the same layout. */
export function importDataFolder(sourceDir) {
  const copied = { characters: 0, chats: 0, worlds: 0, presets: 0, personas: 0 };
  const copyDir = (src, dest, filterExt, counterKey, recurse = false) => {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue; // skip .DS_Store and friends
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      if (entry.isDirectory() && recurse) {
        copyDir(s, d, filterExt, counterKey, true);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(filterExt)) {
        fs.copyFileSync(s, d);
        copied[counterKey]++;
      }
    }
  };
  copyDir(path.join(sourceDir, 'characters'), path.join(dataDir(), 'characters'), '.png', 'characters');
  copyDir(path.join(sourceDir, 'chats'), path.join(dataDir(), 'chats'), '.jsonl', 'chats', true);
  copyDir(path.join(sourceDir, 'worlds'), path.join(dataDir(), 'worlds'), '.json', 'worlds');
  copyDir(path.join(sourceDir, 'presets'), path.join(dataDir(), 'presets'), '.json', 'presets');
  // Personas: merge rather than overwrite
  const stPersonas = path.join(sourceDir, 'user', 'personas.json');
  if (fs.existsSync(stPersonas)) {
    try {
      const incoming = JSON.parse(fs.readFileSync(stPersonas, 'utf8'));
      if (Array.isArray(incoming)) {
        const existing = listPersonas();
        const names = new Set(existing.map((p) => p.name));
        for (const p of incoming) {
          if (!names.has(p.name)) {
            existing.push({
              id: p.id ?? crypto.randomUUID(),
              name: p.name,
              description: p.description ?? '',
              avatarFilename: p.avatarFilename ?? null,
            });
            copied.personas++;
          }
        }
        savePersonas(existing);
      }
    } catch {}
    copyDir(path.join(sourceDir, 'User Avatars'), path.join(dataDir(), 'User Avatars'), '', 'personas');
  }
  return copied;
}
