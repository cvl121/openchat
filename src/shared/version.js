// Version comparison shared by the main process (update check) and the
// renderer (What's New dialog). Electron-free.

/** Compare dotted version strings numerically ('1.10.0' > '1.2.0'). Returns -1 | 0 | 1. */
export function compareVersions(a, b) {
  const parse = (v) => String(v ?? '').trim().replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
