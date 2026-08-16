// Update check against GitHub Releases. This only discovers a newer version
// and hands the release URL to the UI — no downloads, no auto-install.
// Electron-free (like storage.js) so it can be tested under plain Node.
import { t } from '../shared/i18n.js';
import { compareVersions } from '../shared/version.js';

export const RELEASES_API = 'https://api.github.com/repos/cvl121/openchat/releases/latest';
export const RELEASES_PAGE = 'https://github.com/cvl121/openchat/releases/latest';

export { compareVersions };

/**
 * Decide whether a GitHub release object is a reportable update.
 * Returns { version, url } or null (up to date, skipped, draft/prerelease).
 */
export function evaluateRelease(release, { currentVersion, skippedVersion = '' } = {}) {
  const version = String(release?.tag_name ?? '').replace(/^v/i, '');
  if (!version || release.draft || release.prerelease) return null;
  if (compareVersions(version, currentVersion) <= 0) return null;
  if (skippedVersion && compareVersions(version, skippedVersion) === 0) return null;
  return { version, url: release.html_url || RELEASES_PAGE };
}

/** Fetch the latest release and evaluate it. Returns null when up to date. */
export async function checkForUpdate({ currentVersion, skippedVersion = '', fetchImpl = fetch } = {}) {
  const res = await fetchImpl(RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(t('errors.updateCheckFailed', { status: res.status }));
  return evaluateRelease(await res.json(), { currentVersion, skippedVersion });
}
