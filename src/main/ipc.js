// IPC wiring between renderer and main-process services.
// Streaming LLM responses are pushed to the renderer as `llm:chunk` /
// `llm:done` / `llm:error` events keyed by requestId.

import { app, ipcMain, dialog, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import * as storage from './storage.js';
import * as stImport from './stImport.js';
import * as llm from './llm.js';
import { checkForUpdate } from './updates.js';

const activeRequests = new Map(); // requestId -> AbortController

// Paths the user actually picked (file dialogs, drag-and-drop via webUtils).
// Handlers that read renderer-supplied paths only accept minted ones, so a
// compromised renderer can't turn an import channel into arbitrary file reads.
const mintedPaths = new Set();

function mintPath(p) {
  if (typeof p === 'string' && p) mintedPaths.add(path.resolve(p));
}

function assertMinted(p) {
  const resolved = path.resolve(String(p));
  for (const minted of mintedPaths) {
    if (resolved === minted || resolved.startsWith(minted + path.sep)) return resolved;
  }
  throw new Error('Path was not selected via a file dialog or drag-and-drop');
}

function wrap(handler) {
  return async (_event, ...args) => {
    try {
      return { ok: true, data: await handler(...args) };
    } catch (err) {
      return { ok: false, error: err.message ?? String(err) };
    }
  };
}

export function registerIPC() {
  // Settings
  ipcMain.handle('settings:load', wrap(() => storage.loadSettings()));
  ipcMain.handle('settings:save', wrap((settings) => storage.saveSettings(settings)));
  // Synchronous save used on beforeunload so pending changes survive quit
  ipcMain.on('settings:saveSync', (event, settings) => {
    try {
      storage.saveSettings(settings);
      event.returnValue = { ok: true };
    } catch (err) {
      event.returnValue = { ok: false, error: err.message ?? String(err) };
    }
  });

  // Preload mints drag-and-drop paths as it resolves them via webUtils;
  // synthetic File objects have no backing path, so this can't be forged.
  ipcMain.on('paths:mint', (_event, p) => mintPath(p));

  // Characters
  ipcMain.handle('characters:list', wrap(() => storage.listCharacters()));
  ipcMain.handle('characters:import', wrap((filePath) => storage.importCharacter(assertMinted(filePath))));
  ipcMain.handle(
    'characters:save',
    wrap((card, opts) => {
      if (opts?.avatarPath) assertMinted(opts.avatarPath);
      return storage.saveCharacter(card, opts ?? {});
    })
  );
  ipcMain.handle('characters:delete', wrap((filename) => storage.deleteCharacter(filename)));
  ipcMain.handle(
    'characters:export',
    wrap(async (filename, format) => {
      const win = BrowserWindow.getFocusedWindow();
      const ext = format === 'json' ? 'json' : 'png';
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: filename.replace(/\.png$/i, `.${ext}`),
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (canceled || !filePath) return false;
      if (format === 'json') return storage.exportCharacterJSON(filename, filePath);
      return storage.exportCharacter(filename, filePath);
    })
  );

  // Chats
  ipcMain.handle('chats:list', wrap((charName) => storage.listChats(charName)));
  ipcMain.handle('chats:create', wrap((charName, userName) => storage.createChat(charName, userName)));
  ipcMain.handle('chats:load', wrap((charName, file) => storage.loadChat(charName, file)));
  ipcMain.handle('chats:append', wrap((charName, file, msg) => storage.appendMessage(charName, file, msg)));
  ipcMain.handle('chats:rewrite', wrap((charName, file, meta, msgs) => storage.rewriteChat(charName, file, meta, msgs)));
  ipcMain.handle('chats:delete', wrap((charName, file) => storage.deleteChat(charName, file)));
  ipcMain.handle('chats:search', wrap((query, charName) => storage.searchChats(query, charName)));
  ipcMain.handle('chats:lastActive', wrap(() => storage.lastActiveChatCharacter()));
  ipcMain.handle('chats:import', wrap((charName, sourcePath) => storage.importChatJSONL(charName, assertMinted(sourcePath))));
  ipcMain.handle(
    'chats:export',
    wrap(async (charName, file, format) => {
      const win = BrowserWindow.getFocusedWindow();
      const ext = format === 'markdown' ? 'md' : 'jsonl';
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: file.replace(/\.jsonl$/i, `.${ext}`),
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (canceled || !filePath) return false;
      if (format === 'markdown') return storage.exportChatMarkdown(charName, file, filePath);
      return storage.exportChatJSONL(charName, file, filePath);
    })
  );

  // World Info
  ipcMain.handle('worlds:list', wrap(() => storage.listWorldInfo()));
  ipcMain.handle('worlds:save', wrap((book) => storage.saveWorldInfo(book)));
  ipcMain.handle('worlds:delete', wrap((file) => storage.deleteWorldInfo(file)));
  ipcMain.handle('worlds:import', wrap((filePath) => storage.importWorldInfo(assertMinted(filePath))));
  ipcMain.handle(
    'worlds:export',
    wrap(async (file) => {
      const win = BrowserWindow.getFocusedWindow();
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: String(file).replace(/\.json$/i, '') + '.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (canceled || !filePath) return false;
      return storage.exportWorldInfo(file, filePath);
    })
  );

  // Personas
  ipcMain.handle('personas:list', wrap(() => storage.listPersonas()));
  ipcMain.handle('personas:save', wrap((personas) => storage.savePersonas(personas)));
  ipcMain.handle('personas:saveAvatar', wrap((id, src) => storage.savePersonaAvatar(id, assertMinted(src))));

  // Presets
  ipcMain.handle('presets:list', wrap(() => storage.listPresets()));
  ipcMain.handle('presets:save', wrap((preset) => storage.savePreset(preset)));
  ipcMain.handle('presets:delete', wrap((name) => storage.deletePreset(name)));
  ipcMain.handle('presets:import', wrap((filePath) => storage.importPreset(assertMinted(filePath))));
  ipcMain.handle(
    'presets:export',
    wrap(async (name) => {
      const win = BrowserWindow.getFocusedWindow();
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: `${name}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (canceled || !filePath) return false;
      return storage.exportPreset(name, filePath);
    })
  );

  // Uploads (chat attachments + generated images)
  ipcMain.handle('files:importUpload', wrap((sourcePath) => storage.importUpload(assertMinted(sourcePath))));
  ipcMain.handle('files:saveUpload', wrap((name, dataURL) => storage.saveUploadData(name, dataURL)));
  ipcMain.handle('files:readUpload', wrap((file) => storage.readUploadData(file)));
  // Save an upload (generated image, attachment) somewhere the user picks.
  // The save dialog defaults to Downloads; destPath skips the dialog (tests).
  ipcMain.handle(
    'files:exportUpload',
    wrap(async (file, destPath) => {
      let dest = destPath;
      if (!dest) {
        const win = BrowserWindow.getFocusedWindow();
        const ext = path.extname(file);
        const { canceled, filePath } = await dialog.showSaveDialog(win, {
          defaultPath: path.join(app.getPath('downloads'), file),
          filters: ext ? [{ name: ext.slice(1).toUpperCase(), extensions: [ext.slice(1)] }] : [],
        });
        if (canceled || !filePath) return null;
        dest = filePath;
      }
      storage.exportUpload(file, dest);
      return dest;
    })
  );

  // LLM — streaming via push events
  ipcMain.handle('llm:send', async (event, requestId, messages, config) => {
    const controller = new AbortController();
    activeRequests.set(requestId, controller);
    const sender = event.sender;
    const send = (channel, payload) => {
      if (!sender.isDestroyed()) sender.send(channel, payload);
    };
    // SSE tokens can arrive far faster than the renderer paints; batch them
    // into one IPC message per ~16ms instead of one per token.
    let pendingText = '';
    let flushTimer = null;
    const flushChunks = () => {
      flushTimer = null;
      if (pendingText) {
        send('llm:chunk', { requestId, text: pendingText });
        pendingText = '';
      }
    };
    const onChunk = (text) => {
      pendingText += text;
      if (!flushTimer) flushTimer = setTimeout(flushChunks, 16);
    };
    const onImage = (dataURL) => send('llm:image', { requestId, dataURL });
    let finishReason = null;
    try {
      const full = await llm.sendMessage(messages, config, onChunk, {
        signal: controller.signal,
        onImage,
        onFinishReason: (reason) => (finishReason = reason),
      });
      clearTimeout(flushTimer);
      flushChunks();
      send('llm:done', { requestId, text: full, finishReason });
      return { ok: true };
    } catch (err) {
      clearTimeout(flushTimer);
      flushChunks();
      const aborted = err.name === 'AbortError' || controller.signal.aborted;
      send('llm:error', { requestId, error: err.message ?? String(err), aborted });
      return { ok: !aborted ? false : true, error: err.message };
    } finally {
      activeRequests.delete(requestId);
    }
  });
  ipcMain.handle('llm:stop', wrap((requestId) => {
    activeRequests.get(requestId)?.abort();
    return true;
  }));
  ipcMain.handle('llm:models', wrap((config) => llm.listModels(config)));
  ipcMain.handle('llm:test', wrap((config) => llm.testConnection(config)));
  ipcMain.handle('llm:credits', wrap((config) => llm.getCredits(config)));
  // One-shot non-streaming completion (chat compression, background tasks)
  ipcMain.handle('llm:complete', wrap((messages, config) =>
    llm.sendMessage(
      messages,
      { ...config, params: { ...config.params, stream_response: false } },
      null,
      { signal: AbortSignal.timeout(120_000) }
    )
  ));

  // Dialogs & misc
  ipcMain.handle(
    'dialog:openFile',
    wrap(async (options) => {
      const win = BrowserWindow.getFocusedWindow();
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        properties: ['openFile', ...(options?.multi ? ['multiSelections'] : [])],
        filters: options?.filters ?? [],
      });
      if (canceled) return [];
      filePaths.forEach(mintPath);
      return filePaths;
    })
  );
  ipcMain.handle(
    'dialog:openDirectory',
    wrap(async () => {
      const win = BrowserWindow.getFocusedWindow();
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
      });
      if (canceled) return null;
      mintPath(filePaths[0]);
      return filePaths[0];
    })
  );
  ipcMain.handle('misc:openExternal', wrap((url) => {
    if (!/^https?:\/\//.test(url)) throw new Error('Only http(s) URLs may be opened');
    return shell.openExternal(url);
  }));
  ipcMain.handle('misc:dataDir', wrap(() => storage.dataDir()));
  ipcMain.handle('misc:importDataFolder', wrap((dir) => storage.importDataFolder(assertMinted(dir))));
  ipcMain.handle('misc:appVersion', wrap(() => app.getVersion()));

  // SillyTavern import (Settings → Data). scan resolves the user-data dir
  // inside the picked folder; that subdir stays minted via the prefix rule,
  // so the renderer can pass it straight back to st:import.
  ipcMain.handle('st:scan', wrap((dir) => stImport.scanSTFolder(assertMinted(dir))));
  ipcMain.handle('st:import', wrap((dir, categories) => stImport.importSTFolder(assertMinted(dir), { categories })));

  // Manual update check (Settings → General). Deliberately ignores the
  // skipped version — an explicit check should always report what's newest.
  ipcMain.handle('updates:check', wrap(() => checkForUpdate({ currentVersion: app.getVersion() })));
}
