const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("macos", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (next) => ipcRenderer.invoke("config:set", next),

  listClips: (query) => ipcRenderer.invoke("clips:list", query),
  getClip: (id) => ipcRenderer.invoke("clips:get", id),
  createClip: (payload) => ipcRenderer.invoke("clips:create", payload),
  toggleFavorite: (id, isFavorite) => ipcRenderer.invoke("clips:favorite", id, isFavorite),
  deleteClip: (id) => ipcRenderer.invoke("clips:delete", id),

  readClipboard: () => ipcRenderer.invoke("clipboard:read"),
  writeClipboard: (value) => ipcRenderer.invoke("clipboard:write", value),
  pasteAndHide: (value) => ipcRenderer.invoke("clipboard:paste-and-hide", value),
  captureClipboardNow: () => ipcRenderer.invoke("clipboard:capture-now"),

  toggleWindow: () => ipcRenderer.invoke("window:toggle"),
  captureWindow: () => ipcRenderer.invoke("window:capture"),

  onOpenSettings: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on("ui:open-settings", listener);
    return () => ipcRenderer.removeListener("ui:open-settings", listener);
  },

  onClipsChanged: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on("clips:changed", listener);
    return () => ipcRenderer.removeListener("clips:changed", listener);
  },

  onWindowShown: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on("window:shown", listener);
    return () => ipcRenderer.removeListener("window:shown", listener);
  },

  onWindowHidden: (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on("window:hidden", listener);
    return () => ipcRenderer.removeListener("window:hidden", listener);
  }
});
