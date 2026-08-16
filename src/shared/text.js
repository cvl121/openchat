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
export function foldText(s) {
  let out = '';
  for (const ch of String(s ?? '').toLowerCase()) {
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    out += base.length === ch.length ? base : ch;
  }
  return out;
}
