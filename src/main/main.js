import { app, BrowserWindow, protocol, net, Menu, shell, safeStorage, clipboard } from 'electron';
import path from 'node:path';
import url from 'node:url';
import { initStorage, resolveDataPath, loadSettings, setTrashItem } from './storage.js';
import { registerIPC } from './ipc.js';
import { checkForUpdate } from './updates.js';

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
        template.push({ label: 'No Guesses Found', enabled: false });
      }
      template.push(
        {
          label: 'Add to Dictionary',
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
          label: `Look Up “${preview.length > 40 ? preview.slice(0, 40) + '…' : preview}”`,
          click: () => win.webContents.showDefinitionForSelection(),
        });
      }
    }
    if (params.linkURL) {
      if (template.length) template.push({ type: 'separator' });
      template.push({ label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) });
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
            { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('menu:settings') },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'quit' },
          ],
        }]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: send('menu:newChat') },
        { label: 'New Character', accelerator: 'CmdOrCtrl+Shift+N', click: send('menu:newCharacter') },
        { type: 'separator' },
        ...(isMac ? [{ role: 'close' }] : [{ label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('menu:settings') }, { role: 'quit' }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Chat',
      submenu: [
        { label: 'Search', accelerator: 'CmdOrCtrl+F', click: send('menu:search') },
        { label: 'Chat History', accelerator: 'CmdOrCtrl+Shift+H', click: send('menu:history') },
        { label: 'Regenerate Last Response', accelerator: 'CmdOrCtrl+R', click: send('menu:regenerate') },
      ],
    },
    {
      label: 'View',
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
  registerIPC();
  buildMenu();

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

  createWindow();
  startUpdateChecks();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
