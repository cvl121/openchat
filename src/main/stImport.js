// Import from a SillyTavern installation: characters, chats, lorebooks
// (world info), personas, and generation presets.
//
// Deliberately out of scope — nothing in OpenChat maps onto them:
// groups/group chats, themes, QuickReplies, backgrounds, instruct/context
// templates, and SillyTavern's API/prompt settings.
//
// Collision policy is keep-both: existing local data is never overwritten;
// imported items that collide by name get a numeric suffix ("Alice 2").
//
// Electron-free (like storage.js) so it can be tested under plain Node.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  importCharacter,
  importChatJSONL,
  importWorldInfo,
  listWorldInfo,
  listPersonas,
  savePersonas,
  savePersonaAvatar,
  listPresets,
  savePreset,
  mapSTPreset,
} from './storage.js';
import { t } from '../shared/i18n.js';

const PRESET_DIRS = ['OpenAI Settings', 'TextGen Settings', 'KoboldAI Settings', 'NovelAI Settings'];

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Non-recursive file listing; skips dotfiles, filters by extension, sorted. */
function listFiles(dir, ext) {
  if (!isDir(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.') && e.name.toLowerCase().endsWith(ext))
    .map((e) => e.name)
    .sort();
}

/** Subdirectory names; dirent.isDirectory() is false for symlinks, keeping the scan inside the picked folder. */
function subdirNames(dir) {
  if (!isDir(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

function looksLikeUserDir(dir) {
  return (
    isDir(path.join(dir, 'characters')) ||
    isDir(path.join(dir, 'chats')) ||
    fs.existsSync(path.join(dir, 'settings.json'))
  );
}

/**
 * Locate the SillyTavern user-data dir from whatever folder the user picked:
 * the user dir itself, the ST install root (data/<user>/), the data folder,
 * or a legacy < 1.12 install (public/). Returns an absolute path or null.
 */
export function detectSTDataDir(pickedDir) {
  if (!isDir(pickedDir)) return null;
  if (looksLikeUserDir(pickedDir)) return pickedDir;
  const bases = [path.join(pickedDir, 'data'), pickedDir];
  for (const base of bases) {
    const def = path.join(base, 'default-user');
    if (looksLikeUserDir(def)) return def;
  }
  for (const base of bases) {
    for (const name of subdirNames(base)) {
      const candidate = path.join(base, name);
      if (isDir(path.join(candidate, 'characters'))) return candidate;
    }
  }
  return null;
}

/** "Name" -> "Name 2", "Name 3", … against a Set of taken names. */
export function uniqueName(base, taken) {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

/** Personas live inside ST's settings.json, not as files. */
function readSTPersonas(dir) {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    const pu = settings.power_user ?? {};
    return {
      personas: pu.personas && typeof pu.personas === 'object' ? pu.personas : {},
      descriptions: pu.persona_descriptions && typeof pu.persona_descriptions === 'object' ? pu.persona_descriptions : {},
    };
  } catch {
    return { personas: {}, descriptions: {} };
  }
}

/**
 * Read-only scan of a picked folder. Returns { dir, counts } where dir is the
 * resolved ST user-data dir (pass it back to importSTFolder unchanged).
 */
export function scanSTFolder(pickedDir) {
  const dir = detectSTDataDir(pickedDir);
  if (!dir) {
    throw new Error(t('errors.noSTData'));
  }
  const chatsRoot = path.join(dir, 'chats');
  return {
    dir,
    counts: {
      characters: listFiles(path.join(dir, 'characters'), '.png').length,
      chats: subdirNames(chatsRoot).reduce((n, sub) => n + listFiles(path.join(chatsRoot, sub), '.jsonl').length, 0),
      lorebooks: listFiles(path.join(dir, 'worlds'), '.json').length,
      personas: Object.keys(readSTPersonas(dir).personas).length,
      presets: PRESET_DIRS.reduce((n, sub) => n + listFiles(path.join(dir, sub), '.json').length, 0),
    },
  };
}

/**
 * Import the selected categories from a resolved ST user-data dir.
 * categories = { characters, chats, lorebooks, personas, presets } booleans.
 * Per-item failures land in errors[] and the import keeps going.
 * Returns { imported: {…}, skipped: {…}, errors: ["characters/Foo.png: …"] }.
 */
export function importSTFolder(dir, { categories = {} } = {}) {
  const res = {
    imported: { characters: 0, chats: 0, lorebooks: 0, personas: 0, presets: 0 },
    skipped: { characters: 0, chats: 0, lorebooks: 0, personas: 0, presets: 0 },
    errors: [],
  };
  if (categories.characters) importCharacters(dir, res);
  if (categories.chats) importChats(dir, res);
  if (categories.lorebooks) importLorebooks(dir, res);
  if (categories.personas) importPersonas(dir, res);
  if (categories.presets) importPresets(dir, res);
  return res;
}

function importCharacters(dir, res) {
  const src = path.join(dir, 'characters');
  for (const file of listFiles(src, '.png')) {
    try {
      importCharacter(path.join(src, file)); // saveCharacter suffixes colliding filenames
      res.imported.characters++;
    } catch (err) {
      res.skipped.characters++;
      res.errors.push(`characters/${file}: ${err.message}`);
    }
  }
}

// Chats are keyed by character name; the header's character_name is more
// canonical than a filesystem-munged directory name, so prefer it. Chats for
// characters that don't exist locally import anyway — orphan chat dirs are an
// accepted state (deleteCharacter keeps them), and history appears as soon as
// the card exists.
function chatCharacterName(filePath, fallback) {
  try {
    const firstLine = fs.readFileSync(filePath, 'utf8').split('\n', 1)[0];
    const header = JSON.parse(firstLine);
    if (header && typeof header.character_name === 'string' && header.character_name.trim() && header.mes === undefined) {
      return header.character_name;
    }
  } catch {}
  return fallback;
}

function importChats(dir, res) {
  const chatsRoot = path.join(dir, 'chats');
  for (const sub of subdirNames(chatsRoot)) {
    for (const file of listFiles(path.join(chatsRoot, sub), '.jsonl')) {
      const full = path.join(chatsRoot, sub, file);
      try {
        importChatJSONL(chatCharacterName(full, sub), full); // always writes a fresh unique file
        res.imported.chats++;
      } catch (err) {
        res.skipped.chats++;
        res.errors.push(`chats/${sub}/${file}: ${err.message}`);
      }
    }
  }
}

function importLorebooks(dir, res) {
  const src = path.join(dir, 'worlds');
  // saveWorldInfo overwrites on same name and derives its file from the name,
  // so unique against both existing book names and existing file basenames.
  const taken = new Set();
  for (const book of listWorldInfo()) {
    taken.add(book.name);
    taken.add(book.file.replace(/\.json$/, ''));
  }
  for (const file of listFiles(src, '.json')) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(src, file), 'utf8'));
      const name = uniqueName(String(raw.name ?? path.basename(file, '.json')), taken);
      taken.add(name);
      importWorldInfo(path.join(src, file), { name });
      res.imported.lorebooks++;
    } catch (err) {
      res.skipped.lorebooks++;
      res.errors.push(`worlds/${file}: ${err.message}`);
    }
  }
}

function importPersonas(dir, res) {
  const { personas, descriptions } = readSTPersonas(dir);
  const entries = Object.entries(personas);
  if (!entries.length) return;
  const existing = listPersonas();
  const taken = new Set(existing.map((p) => p.name));
  const added = [];
  for (const [avatarRef, rawName] of entries) {
    try {
      const name = uniqueName(String(rawName || 'Persona'), taken);
      taken.add(name);
      const id = crypto.randomUUID();
      // basename() so a crafted settings.json can't reference files outside the folder
      const avatarSrc = path.join(dir, 'User Avatars', path.basename(avatarRef));
      const avatarFilename = fs.existsSync(avatarSrc) ? savePersonaAvatar(id, avatarSrc) : null;
      added.push({ id, name, description: descriptions[avatarRef]?.description ?? '', avatarFilename });
      res.imported.personas++;
    } catch (err) {
      res.skipped.personas++;
      res.errors.push(`personas/${avatarRef}: ${err.message}`);
    }
  }
  if (added.length) savePersonas(existing.concat(added));
}

function importPresets(dir, res) {
  // Includes 'Default' (reserved) and all saved preset names
  const taken = new Set(listPresets().map((p) => p.name));
  for (const sub of PRESET_DIRS) {
    const src = path.join(dir, sub);
    for (const file of listFiles(src, '.json')) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(src, file), 'utf8'));
        // ST preset files are named by preset; raw.name is usually absent
        const name = uniqueName(path.basename(file, '.json'), taken);
        taken.add(name);
        savePreset({ name, generationParams: mapSTPreset(raw) });
        res.imported.presets++;
      } catch (err) {
        res.skipped.presets++;
        res.errors.push(`${sub}/${file}: ${err.message}`);
      }
    }
  }
}
