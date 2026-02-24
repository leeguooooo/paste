const { contextBridge, ipcRenderer } = require("electron");

// Renderer/preload can also crash with "write EPIPE" when Electron routes console
// output over IPC and the pipe is closed by the parent process/dev tooling.
// Patch defensively so transient logging doesn't bring down the app.
const collectErrorChain = (err) => {
  const out = [];
  const seen = new Set();
  const queue = [err];
  while (queue.length) {
    const cur = queue.shift();
    if (!cur || (typeof cur !== "object" && typeof cur !== "function")) continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    try {
      queue.push(cur.cause, cur.originalError, cur.inner, cur.error, cur.reason);
    } catch {
      // ignore
    }
  }
  return out;
};

const isIgnorablePipeWriteError = (err) => {
  const candidates = collectErrorChain(err);
  for (const e of candidates) {
    try {
      const code = e.code;
      if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ERR_IPC_CHANNEL_CLOSED") {
        return true;
      }
      const errno = e.errno;
      const syscall = e.syscall;
      const msg = String(e.message || "");
      if (errno === -32 && String(syscall || "").toLowerCase() === "write") {
        return true;
      }
      if (/write/i.test(msg) && /\bEPIPE\b/i.test(msg)) {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
};

const safeWrapFn = (fn) => {
  if (typeof fn !== "function") return null;
  if (fn.__paste_console_patched) return fn;
  const wrapped = function (...args) {
    try {
      // eslint-disable-next-line no-invalid-this
      return fn.apply(this, args);
    } catch (err) {
      if (isIgnorablePipeWriteError(err)) {
        return;
      }
      throw err;
    }
  };
  wrapped.__paste_console_patched = true;
  return wrapped;
};

const patchConsole = () => {
  for (const name of ["error", "warn", "log", "info", "debug"]) {
    try {
      const wrapped = safeWrapFn(console[name]);
      if (wrapped) console[name] = wrapped;
    } catch {
      // ignore
    }
  }

  try {
    const { Console } = require("node:console");
    for (const name of ["error", "warn", "log", "info", "debug"]) {
      const desc = Object.getOwnPropertyDescriptor(Console.prototype, name);
      const original = desc?.value;
      const wrapped = safeWrapFn(original);
      if (!wrapped || wrapped === original) continue;
      Object.defineProperty(Console.prototype, name, { ...desc, value: wrapped });
    }
  } catch {
    // ignore
  }
};

const patchBrokenPipeWrites = (stream) => {
  if (!stream) return;

  try {
    if (typeof stream.on === "function") {
      stream.on("error", (err) => {
        if (isIgnorablePipeWriteError(err)) return;
      });
    }
  } catch {
    // ignore
  }

  try {
    if (typeof stream.write !== "function") return;
    if (stream.write.__paste_patched) return;
    const origWrite = stream.write.bind(stream);
    const wrapped = (...args) => {
      try {
        return origWrite(...args);
      } catch (err) {
        if (isIgnorablePipeWriteError(err)) return false;
        throw err;
      }
    };
    wrapped.__paste_patched = true;
    stream.write = wrapped;
  } catch {
    // ignore
  }
};

const patchProcessSend = () => {
  try {
    if (typeof process.send !== "function") return;
    if (process.send.__paste_patched) return;
    const orig = process.send.bind(process);
    const wrapped = (...args) => {
      try {
        return orig(...args);
      } catch (err) {
        if (isIgnorablePipeWriteError(err)) return false;
        throw err;
      }
    };
    wrapped.__paste_patched = true;
    process.send = wrapped;
  } catch {
    // ignore
  }
};

const patchFatalException = () => {
  try {
    if (typeof process._fatalException !== "function") return;
    if (process._fatalException.__paste_patched) return;
    const orig = process._fatalException.bind(process);
    const wrapped = (err) => {
      try {
        if (isIgnorablePipeWriteError(err)) {
          return true;
        }
      } catch {
        // ignore
      }
      return orig(err);
    };
    wrapped.__paste_patched = true;
    process._fatalException = wrapped;
  } catch {
    // ignore
  }
};

patchBrokenPipeWrites(process.stdout);
patchBrokenPipeWrites(process.stderr);
patchBrokenPipeWrites(process._stdout);
patchBrokenPipeWrites(process._stderr);
patchProcessSend();
patchFatalException();
patchConsole();

process.on("uncaughtException", (err) => {
  if (isIgnorablePipeWriteError(err)) {
    return;
  }
  throw err;
});

contextBridge.exposeInMainWorld("macos", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  setConfig: (next) => ipcRenderer.invoke("config:set", next),
  getAuthStatus: () => ipcRenderer.invoke("auth:status"),
  startGithubDeviceAuth: () => ipcRenderer.invoke("auth:github-device-start"),
  pollGithubDeviceAuth: (deviceCode) => ipcRenderer.invoke("auth:github-device-poll", deviceCode),
  logoutAuth: () => ipcRenderer.invoke("auth:logout"),
  getLocalSyncStatus: () => ipcRenderer.invoke("local-sync:status"),
  runLocalSync: () => ipcRenderer.invoke("local-sync:run"),
  dismissLocalSync: () => ipcRenderer.invoke("local-sync:dismiss"),

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
  openExternal: (url) => ipcRenderer.invoke("system:open-external", url),
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
