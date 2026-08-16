// Context bridge: the only surface the renderer can reach.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function invoke(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (result && result.ok === false) throw new Error(result.error);
  return result?.data ?? result;
}

const PUSH_CHANNELS = ['llm:chunk', 'llm:done', 'llm:error', 'llm:image', 'menu:newChat', 'menu:newCharacter', 'menu:settings', 'menu:search', 'menu:history', 'menu:regenerate', 'updates:available'];

contextBridge.exposeInMainWorld('tavern', {
  settings: {
    load: () => invoke('settings:load'),
    save: (s) => invoke('settings:save', s),
    // Synchronous: used on beforeunload where async IPC may not complete
    saveSync: (s) => ipcRenderer.sendSync('settings:saveSync', s),
  },
  characters: {
    list: () => invoke('characters:list'),
    import: (filePath) => invoke('characters:import', filePath),
    save: (card, opts) => invoke('characters:save', card, opts),
    delete: (filename) => invoke('characters:delete', filename),
    export: (filename, format) => invoke('characters:export', filename, format),
  },
  chats: {
    list: (charName) => invoke('chats:list', charName),
    create: (charName, userName) => invoke('chats:create', charName, userName),
    load: (charName, file) => invoke('chats:load', charName, file),
    append: (charName, file, msg) => invoke('chats:append', charName, file, msg),
    rewrite: (charName, file, meta, msgs) => invoke('chats:rewrite', charName, file, meta, msgs),
    delete: (charName, file) => invoke('chats:delete', charName, file),
    search: (query, charName) => invoke('chats:search', query, charName),
    export: (charName, file, format) => invoke('chats:export', charName, file, format),
    import: (charName, sourcePath) => invoke('chats:import', charName, sourcePath),
    lastActive: () => invoke('chats:lastActive'),
  },
  worlds: {
    list: () => invoke('worlds:list'),
    save: (book) => invoke('worlds:save', book),
    delete: (file) => invoke('worlds:delete', file),
    import: (filePath) => invoke('worlds:import', filePath),
    export: (file) => invoke('worlds:export', file),
  },
  personas: {
    list: () => invoke('personas:list'),
    save: (personas) => invoke('personas:save', personas),
    saveAvatar: (id, src) => invoke('personas:saveAvatar', id, src),
  },
  presets: {
    list: () => invoke('presets:list'),
    save: (preset) => invoke('presets:save', preset),
    delete: (name) => invoke('presets:delete', name),
    import: (filePath) => invoke('presets:import', filePath),
    export: (name) => invoke('presets:export', name),
  },
  llm: {
    send: (requestId, messages, config) => invoke('llm:send', requestId, messages, config),
    stop: (requestId) => invoke('llm:stop', requestId),
    models: (config) => invoke('llm:models', config),
    test: (config) => invoke('llm:test', config),
    credits: (config) => invoke('llm:credits', config),
    complete: (messages, config) => invoke('llm:complete', messages, config),
  },
  dialog: {
    openFile: (options) => invoke('dialog:openFile', options),
    openDirectory: () => invoke('dialog:openDirectory'),
  },
  files: {
    importUpload: (sourcePath) => invoke('files:importUpload', sourcePath),
    saveUpload: (name, dataURL) => invoke('files:saveUpload', name, dataURL),
    readUpload: (file) => invoke('files:readUpload', file),
    exportUpload: (file, destPath) => invoke('files:exportUpload', file, destPath),
  },
  misc: {
    // Mint the resolved path so main-process import handlers will accept it.
    // webUtils only yields paths for genuine dropped/picked File objects, so
    // the renderer can't mint arbitrary paths through here.
    pathForFile: (file) => {
      const p = webUtils.getPathForFile(file);
      if (p) ipcRenderer.send('paths:mint', p);
      return p;
    },
    openExternal: (u) => invoke('misc:openExternal', u),
    dataDir: () => invoke('misc:dataDir'),
    importDataFolder: (dir) => invoke('misc:importDataFolder', dir),
    appVersion: () => invoke('misc:appVersion'),
  },
  updates: {
    check: () => invoke('updates:check'),
  },
  i18n: {
    // Keep the main process (menu, error messages) on the renderer's locale
    setLocale: (code) => ipcRenderer.send('i18n:setLocale', code),
  },
  sillytavern: {
    scan: (dir) => invoke('st:scan', dir),
    import: (dir, categories) => invoke('st:import', dir, categories),
  },
  on: (channel, callback) => {
    if (!PUSH_CHANNELS.includes(channel)) throw new Error(`Unknown channel: ${channel}`);
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
