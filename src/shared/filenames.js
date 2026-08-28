// Shared by storage.js (writing files) and the renderer (matching character
// names against chat directory names) — both sides must sanitize identically.

/** Make a name safe to use as a file or directory name. */
export function sanitizeFilename(name) {
  const cleaned = String(name ?? '').replace(/[/\\:*?"<>|]/g, '_').trim();
  // "." and ".." are directory references, never a usable name — they would
  // resolve to the parent folder itself (or above it) in a path.join.
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'Unnamed';
  return cleaned;
}
