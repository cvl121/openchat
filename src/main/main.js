import { app, BrowserWindow, protocol, net, Menu, shell, safeStorage, clipboard, ipcMain } from 'electron';
import path from 'node:path';
import url from 'node:url';
import { initStorage, resolveDataPath, loadSettings, setTrashItem } from './storage.js';
import { registerIPC } from './ipc.js';
import { checkForUpdate } from './updates.js';
import { t, setLocale, resolveLocale } from '../shared/i18n.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// tavern:// serves files from the data directory (avatars, persona images)
protocol.registerSchemesAsPrivileged([
  { scheme: 'tavern', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 750,
    minWidth: 860,
    minHeight: 540,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#1a1a1f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });
  // The window only ever shows the local app page; block any navigation away from it
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  attachContextMenu(win);
  return win;
}

// Native OS context menu for text: editable fields get clipboard actions and
// spellcheck suggestions, selected prose gets Copy (and Look Up on macOS),
// links get Copy Link. Views with their own in-app menus (sidebar rows) call
// preventDefault() on the DOM contextmenu event, which suppresses this event
// entirely — so the two menu systems never fight over a right-click.
function attachContextMenu(win) {
  win.webContents.on('context-menu', (_event, params) => {
    const template = [];
    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        template.push({ label: suggestion, click: () => win.webContents.replaceMisspelling(suggestion) });
      }
      if (!params.dictionarySuggestions.length) {
        template.push({ label: t('menu.noGuesses'), enabled: false });
      }
      template.push(
        {
          label: t('menu.addToDictionary'),
          click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
        },
        { type: 'separator' }
      );
    }
    if (params.isEditable) {
      template.push(
        { role: 'cut', enabled: params.editFlags.canCut },
        { role: 'copy', enabled: params.editFlags.canCopy },
        { role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll' }
      );
    } else if (params.selectionText.trim()) {
      template.push({ role: 'copy' });
      if (process.platform === 'darwin') {
        const preview = params.selectionText.trim().replace(/\s+/g, ' ');
        template.push({
          label: t('menu.lookUp', { text: preview.length > 40 ? preview.slice(0, 40) + '…' : preview }),
          click: () => win.webContents.showDefinitionForSelection(),
        });
      }
    }
    if (params.linkURL) {
      if (template.length) template.push({ type: 'separator' });
      template.push({ label: t('menu.copyLink'), click: () => clipboard.writeText(params.linkURL) });
    }
    if (template.length) Menu.buildFromTemplate(template).popup({ window: win });
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const send = (channel) => () => BrowserWindow.getFocusedWindow()?.webContents.send(channel);
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { label: t('menu.settings'), accelerator: 'CmdOrCtrl+,', click: send('menu:settings') },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'quit' },
          ],
        }]
      : []),
    {
      label: t('menu.file'),
      submenu: [
        { label: t('menu.newChat'), accelerator: 'CmdOrCtrl+N', click: send('menu:newChat') },
        { label: t('menu.newCharacter'), accelerator: 'CmdOrCtrl+Shift+N', click: send('menu:newCharacter') },
        { type: 'separator' },
        ...(isMac ? [{ role: 'close' }] : [{ label: t('menu.settings'), accelerator: 'CmdOrCtrl+,', click: send('menu:settings') }, { role: 'quit' }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: t('menu.chat'),
      submenu: [
        { label: t('menu.search'), accelerator: 'CmdOrCtrl+F', click: send('menu:search') },
        { label: t('menu.history'), accelerator: 'CmdOrCtrl+Shift+H', click: send('menu:history') },
        { label: t('menu.regenerate'), accelerator: 'CmdOrCtrl+R', click: send('menu:regenerate') },
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        { role: 'togglefullscreen' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Daily update check against GitHub Releases; pushes `updates:available`
// to the window. Silent on failure (offline, rate-limited) — the user can
// always check manually from Settings → General.
function startUpdateChecks() {
  const run = async () => {
    try {
      const settings = loadSettings();
      if (settings.updateCheck === false) return;
      const update = await checkForUpdate({
        currentVersion: app.getVersion(),
        skippedVersion: settings.skippedUpdateVersion,
      });
      if (update) BrowserWindow.getAllWindows()[0]?.webContents.send('updates:available', update);
    } catch {
      /* retry at the next interval */
    }
  };
  setTimeout(run, 10_000);
  setInterval(run, 24 * 60 * 60 * 1000);
}

app.whenReady().then(() => {
  // Encrypt API keys at rest with the OS keychain where available
  // (falls back to plaintext on e.g. Linux without a secret service)
  const canEncrypt = safeStorage.isEncryptionAvailable();
  initStorage(app.getPath('userData'), {
    encryptString: canEncrypt
      ? (text) => safeStorage.encryptString(text).toString('base64')
      : null,
    decryptString: canEncrypt
      ? (b64) => safeStorage.decryptString(Buffer.from(b64, 'base64'))
      : null,
  });
  // Deletions go to the OS trash so misclicks are recoverable
  setTrashItem((p) => shell.trashItem(p));
  // Menu labels and main-process error messages follow the UI language
  const locale = resolveLocale(loadSettings().language, app.getLocale());
  setLocale(locale);
  registerIPC();
  buildMenu();
  // The renderer re-resolves the locale on startup and on setting changes
  ipcMain.on('i18n:setLocale', (_event, code) => {
    setLocale(code);
    buildMenu();
  });

  // URLs look like tavern://data/<path-within-data-dir>
  protocol.handle('tavern', (request) => {
    const { pathname } = new URL(request.url);
    try {
      const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
      const filePath = resolveDataPath(rel);
      return net.fetch(url.pathToFileURL(filePath).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  const win = createWindow();
  // macOS spellchecks with the native, language-auto-detecting checker; on
  // other platforms Chromium needs the dictionary named. Chinese/Japanese
  // have no Chromium dictionaries — keep the default rather than clearing it.
  if (process.platform !== 'darwin') {
    const dictionaries = { en: ['en-US'], es: ['es'] }[locale];
    if (dictionaries) {
      try {
        win.webContents.session.setSpellCheckerLanguages(dictionaries);
      } catch {}
    }
  }
  startUpdateChecks();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
