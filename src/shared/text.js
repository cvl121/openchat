// Locale-aware text helpers shared by the renderer and main process.

/**
 * Truncate to at most `n` Unicode code points. String.slice counts UTF-16
 * code units, so it can cut an astral character (plane-2 Han, emoji) in half
 * and leave a lone surrogate in previews and titles.
 */
export function truncateChars(s, n) {
  const chars = Array.from(s ?? '');
  return chars.length > n ? chars.slice(0, n).join('') : (s ?? '');
}

/**
 * Case- and diacritic-insensitive fold for search ("jose" matches "José").
 * Length-preserving per character so an index found in the folded string maps
 * straight back onto the original (snippets slice the original by it). Only
 * Latin combining marks are stripped — kana voicing marks (ば vs は) and other
 * scripts are left alone.
 */
const NON_ASCII_RE = /[^\x00-\x7f]/;
const FOLD_CACHE = new Map(); // per-code-point fold results (unique chars are few)

function foldChar(ch) {
  let folded = FOLD_CACHE.get(ch);
  if (folded === undefined) {
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    folded = base.length === ch.length ? base : ch;
    if (FOLD_CACHE.size < 20000) FOLD_CACHE.set(ch, folded);
  }
  return folded;
}

export function foldText(s) {
  const lower = String(s ?? '').toLowerCase();
  // ASCII text needs no folding at all — this is the common case for entire
  // English chat corpora, and search scans megabytes of it per keystroke
  if (!NON_ASCII_RE.test(lower)) return lower;
  return lower.replace(/[^\x00-\x7f]/gu, foldChar);
}
