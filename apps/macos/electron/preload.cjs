const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("macos", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (next) => ipcRenderer.invoke("config:set", next),

  listClips: (query) => ipcRenderer.invoke("clips:list", query),
  createClip: (payload) => ipcRenderer.invoke("clips:create", payload),
  toggleFavorite: (id, isFavorite) => ipcRenderer.invoke("clips:favorite", id, isFavorite),
  deleteClip: (id) => ipcRenderer.invoke("clips:delete", id),

  readClipboard: () => ipcRenderer.invoke("clipboard:read"),
  writeClipboard: (value) => ipcRenderer.invoke("clipboard:write", value),
  captureClipboardNow: () => ipcRenderer.invoke("clipboard:capture-now"),

  toggleWindow: () => ipcRenderer.invoke("window:toggle")
});
