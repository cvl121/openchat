// Shared by storage.js (writing files) and the renderer (matching character
// names against chat directory names) — both sides must sanitize identically.

/** Make a name safe to use as a file or directory name. */
export function sanitizeFilename(name) {
  return name.replace(/[/\\:*?"<>|]/g, '_').trim() || 'Unnamed';
}
