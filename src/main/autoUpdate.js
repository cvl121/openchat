// In-app updater built on electron-updater, fed by the same GitHub Releases
// the discovery check in updates.js reads. Discovery stays on the lightweight
// API probe (testable, respects the skipped version); this module only takes
// over once the user opts in from the banner: download with progress, then
// quit-and-install.
//
// Not supported when running unpackaged (npm start) or from a package format
// the updater can't replace (the Linux .deb) — the UI falls back to linking
// the release page.
import { app } from 'electron';
import electronUpdater from 'electron-updater';
import { t } from '../shared/i18n.js';

const { autoUpdater } = electronUpdater;
autoUpdater.autoDownload = false;
// If the user downloads but dismisses the restart prompt, still apply the
// update on their next normal quit instead of silently dropping it.
autoUpdater.autoInstallOnAppQuit = true;

export function isSupported() {
  if (!app.isPackaged) return false;
  // AppImage relaunches itself via this env var; a .deb install has no
  // updater-writable artifact.
  if (process.platform === 'linux') return !!process.env.APPIMAGE;
  return true;
}

/**
 * Download the latest release's installer. Resolves when the update is fully
 * downloaded and verified; installUpdate() then applies it. onProgress
 * receives whole percentages as bytes arrive.
 */
export async function downloadUpdate(onProgress) {
  const listener = (p) => onProgress?.(Math.round(p.percent));
  autoUpdater.on('download-progress', listener);
  try {
    // electron-updater needs its own feed check before it can download
    const result = await autoUpdater.checkForUpdates();
    if (!result || result.isUpdateAvailable === false) {
      throw new Error(t('errors.noUpdatePending'));
    }
    await autoUpdater.downloadUpdate(result.cancellationToken);
  } finally {
    autoUpdater.removeListener('download-progress', listener);
  }
}

export function installUpdate() {
  autoUpdater.quitAndInstall();
}
