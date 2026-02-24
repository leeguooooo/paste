// Electron main process can crash with "write EPIPE" if stdout/stderr (or an IPC
// channel used by console) is a closed pipe. This can happen depending on how
// the app is launched (dev tooling, background launch agents, etc).
//
// Patch early (before other imports might log) so transient logging doesn't
// bring down the app.
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

    // Common nesting patterns across Node/Electron/lib wrappers.
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
      // Preserve `this` for prototype methods.
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
          // Tell Node/Electron the exception was handled, so it won't print and exit.
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

const { randomUUID, createHash } = require("node:crypto");
const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  screen,
  shell,
  systemPreferences
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");
const { autoUpdater } = require("electron-updater");

const isDev = !app.isPackaged;
const parsePort = (raw, fallback) => {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0 || n >= 65536) return fallback;
  return n;
};
const devPort = parsePort(process.env.PASTE_DEV_PORT ?? process.env.VITE_PORT, 5174);
const devUrl = `http://127.0.0.1:${devPort}`;
const trayDebug = process.env.PASTE_TRAY_DEBUG === "1";

const configFile = path.join(app.getPath("userData"), "pastyx-macos-config.json");
const localClipsFile = path.join(app.getPath("userData"), "pastyx-local-clips.json");

// Keep a conservative limit even in local mode to avoid huge on-disk JSON.
const MAX_IMAGE_DATA_URL_LENGTH = 1_500_000;
// Aim for a small inline preview to keep list payloads cheap.
const MAX_IMAGE_PREVIEW_DATA_URL_LENGTH = 250_000;

let mainWindow = null;
let tray = null;
let clipboardTimer = null;
let lastClipboardFingerprint = "";
let lastClipboardProbeFingerprint = "";
let lastClipboardFailure = { fingerprint: "", at: 0 };
let captureClipboardInFlight = null;
let captureClipboardInFlightProbe = "";
let recentClipboardFingerprints = new Map(); // fingerprint -> lastSeenAt (ms)
let registeredHotkey = null;
let hotkeyStatus = { ok: true, hotkey: null, corrected: false, message: null };
let lastTargetApp = { name: "", bundleId: "", at: 0 };

const RELEASES_LATEST_URL = "https://github.com/leeguooooo/paste/releases/latest";

const runAppleScriptSync = (lines) => {
  const scriptArgs = [];
  for (const line of Array.isArray(lines) ? lines : [lines]) {
    scriptArgs.push("-e", String(line));
  }
  return execFileSync("osascript", scriptArgs, { encoding: "utf8" }).trim();
};

const runAppleScript = (lines) => {
  const scriptArgs = [];
  for (const line of Array.isArray(lines) ? lines : [lines]) {
    scriptArgs.push("-e", String(line));
  }
  return new Promise((resolve, reject) => {
    execFile("osascript", scriptArgs, { encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || "osascript failed").trim();
        reject(new Error(msg));
        return;
      }
      resolve(String(stdout || "").trim());
    });
  });
};

const openAccessibilityPrefs = async () => {
  try {
    // Works on recent macOS versions.
    await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
  } catch {
    // ignore
  }
};

const ensureAccessibilityTrusted = () => {
  try {
    if (process.platform !== "darwin") return { ok: true };
    if (systemPreferences.isTrustedAccessibilityClient(false)) return { ok: true };
    // Trigger the system prompt (may no-op depending on context, but harmless).
    systemPreferences.isTrustedAccessibilityClient(true);
    return { ok: false };
  } catch {
    return { ok: false };
  }
};

const getFrontmostApp = () => {
  try {
    const out = runAppleScriptSync([
      'tell application "System Events" to set frontAppName to name of first application process whose frontmost is true',
      'return frontAppName & "\t" & (id of application frontAppName)'
    ]);
    const [name = "", bundleId = ""] = String(out).split("\t");
    return { name, bundleId };
  } catch {
    return { name: "", bundleId: "" };
  }
};

const getFrontmostAppAsync = async () => {
  try {
    // Faster than resolving "id of application frontAppName" in many setups.
    const out = await runAppleScript([
      'tell application "System Events" to set p to first application process whose frontmost is true',
      'return (name of p) & "\t" & (bundle identifier of p)'
    ]);
    const [name = "", bundleId = ""] = String(out).split("\t");
    return { name, bundleId };
  } catch {
    return { name: "", bundleId: "" };
  }
};

const waitForFrontmostApp = async ({ name, bundleId, timeoutMs = 1500 }) => {
  const start = Date.now();
  for (;;) {
    const cur = getFrontmostApp();
    if ((bundleId && cur.bundleId === bundleId) || (name && cur.name === name)) {
      return true;
    }
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
};

const waitForFrontmostNonSelfAppAsync = async ({ timeoutMs = 1500 } = {}) => {
  const selfName = String(app.getName() || "").toLowerCase();
  const start = Date.now();
  let last = { name: "", bundleId: "" };

  for (;;) {
    const cur = await getFrontmostAppAsync();
    last = cur;
    const curName = String(cur?.name || "").toLowerCase();

    // If our overlay is hidden, the frontmost app should switch back to the target app.
    if (cur?.name && curName && curName !== selfName) {
      return cur;
    }

    if (Date.now() - start >= timeoutMs) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
};

const updateState = {
  checking: false,
  available: false,
  downloaded: false,
  progressPercent: null,
  version: null,
  error: null
};

const setUpdateState = (next) => {
  Object.assign(updateState, next || {});
  try {
    updateTrayMenu();
  } catch {
    // ignore
  }
};

const broadcastToWindows = (channel, payload) => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch {
      // ignore
    }
  }
};

const defaultConfig = {
  // Empty means local-only mode (no remote sync).
  apiBase: "",
  userId: "mac_user_demo",
  deviceId: "macos_desktop",
  authToken: "",
  authGithubLogin: "",
  autoCapture: true,
  launchAtLogin: false,
  // Default retention options: 30d / 180d / 365d / forever
  // Favorites are kept even when expiring.
  retention: "180d",
  hotkey: "CommandOrControl+Shift+V"
};

const buildDefaultDeviceId = () => `mac_${randomUUID().slice(0, 8)}`;

const normalizeConfig = (input) => {
  const merged = { ...defaultConfig, ...(input || {}) };
  const deviceId = String(merged.deviceId || "").trim();
  if (!deviceId || deviceId === "macos_desktop") {
    merged.deviceId = buildDefaultDeviceId();
  } else {
    merged.deviceId = deviceId;
  }
  merged.userId = String(merged.userId || defaultConfig.userId).trim() || defaultConfig.userId;
  merged.authGithubLogin = String(merged.authGithubLogin || "").trim();
  merged.authToken = String(merged.authToken || "").trim();
  return merged;
};

const readConfig = () => {
  try {
    if (!fs.existsSync(configFile)) {
      const normalized = normalizeConfig(defaultConfig);
      fs.writeFileSync(configFile, JSON.stringify(normalized, null, 2));
      return normalized;
    }
    const parsed = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    const normalized = normalizeConfig(parsed);
    fs.writeFileSync(configFile, JSON.stringify(normalized, null, 2));
    return normalized;
  } catch {
    return normalizeConfig(defaultConfig);
  }
};

const writeConfig = (next) => {
  const merged = normalizeConfig(next);
  fs.writeFileSync(configFile, JSON.stringify(merged, null, 2));
  return merged;
};

const isRemoteEnabled = (cfg) => typeof cfg?.apiBase === "string" && /^https?:\/\//i.test(cfg.apiBase.trim());
const isTokenAuthEnabled = (cfg) => typeof cfg?.authToken === "string" && cfg.authToken.trim().length > 0;

const getConfigForRenderer = () => {
  const cfg = readConfig();
  return {
    apiBase: cfg.apiBase,
    userId: cfg.userId,
    deviceId: cfg.deviceId,
    authGithubLogin: cfg.authGithubLogin || "",
    autoCapture: Boolean(cfg.autoCapture),
    launchAtLogin: Boolean(cfg.launchAtLogin),
    retention: cfg.retention,
    hotkey: cfg.hotkey
  };
};

const localOk = (data) => ({ ok: true, data });
const localFail = (message) => ({ ok: false, code: "LOCAL_ERROR", message });

const readLocalDb = () => {
  try {
    if (!fs.existsSync(localClipsFile)) {
      const initial = { clips: [] };
      fs.writeFileSync(localClipsFile, JSON.stringify(initial, null, 2));
      return initial;
    }
    const parsed = JSON.parse(fs.readFileSync(localClipsFile, "utf-8"));
    if (!parsed || !Array.isArray(parsed.clips)) return { clips: [] };
    return parsed;
  } catch {
    return { clips: [] };
  }
};

const writeLocalDb = (db) => {
  fs.writeFileSync(localClipsFile, JSON.stringify(db, null, 2));
};

const retentionMsFromConfig = (cfg) => {
  const r = (cfg?.retention || "180d").toString().trim();
  if (r === "forever") return null;
  const match = r.match(/^(\d+)d$/i);
  if (!match) return 180 * 24 * 60 * 60 * 1000;
  const days = Number(match[1]);
  if (!Number.isFinite(days) || days <= 0) return 180 * 24 * 60 * 60 * 1000;
  return days * 24 * 60 * 60 * 1000;
};

const cleanupLocalDb = (cfg, db) => {
  const now = Date.now();
  const ms = retentionMsFromConfig(cfg);
  let clips = Array.isArray(db?.clips) ? db.clips : [];

  // Collapse consecutive duplicates (newest-first) to avoid self-capture loops and
  // noisy histories. We only de-dupe adjacent items so that "A, B, A" remains.
  const DUPLICATE_COLLAPSE_WINDOW_MS = 60_000;
  const dedupeKey = (c) => {
    if (!c) return "";
    const type = (c.type || "").toString();
    const content = (c.content || "").toString().trim().slice(0, 200);
    const sourceUrl = (c.sourceUrl || "").toString().trim();
    const html = (c.contentHtml || "").toString().trim().slice(0, 200);
    const img =
      typeof c.imageDataUrl === "string" && c.imageDataUrl
        ? `${c.imageDataUrl.slice(0, 64)}:${c.imageDataUrl.length}`
        : "";
    return [type, content, sourceUrl, html, img].join("|");
  };

  if (ms !== null) {
    const cutoff = now - ms;
    clips = clips.filter((c) => c && (c.isFavorite || (c.createdAt ?? 0) >= cutoff));
  }

  const MAX_LOCAL_CLIPS = 5000;
  if (clips.length > MAX_LOCAL_CLIPS) {
    const favorites = clips.filter((c) => c?.isFavorite);
    const rest = clips
      .filter((c) => !c?.isFavorite)
      .sort((a, b) => (b?.createdAt ?? 0) - (a?.createdAt ?? 0));
    clips = favorites.concat(rest).slice(0, MAX_LOCAL_CLIPS);
  }

  clips.sort((a, b) => (b?.createdAt ?? 0) - (a?.createdAt ?? 0));

  // De-dupe after sorting so consecutive equals can be collapsed.
  const collapsed = [];
  for (const clip of clips) {
    const prev = collapsed.length ? collapsed[collapsed.length - 1] : null;
    if (!prev) {
      collapsed.push(clip);
      continue;
    }
    const prevKey = dedupeKey(prev);
    const clipKey = dedupeKey(clip);
    const prevAt = prev?.createdAt ?? prev?.serverUpdatedAt ?? 0;
    const clipAt = clip?.createdAt ?? clip?.serverUpdatedAt ?? 0;
    const closeEnough =
      Number.isFinite(prevAt) &&
      Number.isFinite(clipAt) &&
      Math.abs(prevAt - clipAt) <= DUPLICATE_COLLAPSE_WINDOW_MS;
    if (prevKey && prevKey === clipKey && closeEnough) {
      // Preserve "favorite" and merge tags.
      const prevTags = Array.isArray(prev.tags) ? prev.tags : [];
      const nextTags = Array.isArray(clip.tags) ? clip.tags : [];
      const mergedTags = Array.from(new Set(prevTags.concat(nextTags)));
      prev.isFavorite = Boolean(prev.isFavorite || clip.isFavorite);
      prev.tags = mergedTags;
      continue;
    }
    collapsed.push(clip);
  }

  clips = collapsed;
  return { clips };
};

const localListClips = (cfg, query = {}) => {
  const q = (query.q || "").toString().trim().toLowerCase();
  const favoriteOnly = Boolean(query.favorite);

  // Cleanup happens at startup and on writes. Avoid sorting/filtering + fs writes on
  // every list call (this is hit frequently while the window is visible).
  const db = readLocalDb();
  let items = Array.isArray(db?.clips) ? db.clips : [];
  if (favoriteOnly) items = items.filter((c) => c?.isFavorite);

  if (q) {
    items = items.filter((c) => {
      const summary = (c?.summary || "").toString().toLowerCase();
      const content = (c?.content || "").toString().toLowerCase();
      const sourceUrl = (c?.sourceUrl || "").toString().toLowerCase();
      const html = (c?.contentHtml || "").toString().toLowerCase();
      return summary.includes(q) || content.includes(q) || sourceUrl.includes(q) || html.includes(q);
    });
  }

  const limit = 60;
  return localOk({ items: items.slice(0, limit), nextCursor: null, hasMore: items.length > limit });
};

const localCreateClip = (cfg, payload) => {
  const now = Date.now();
  const db = readLocalDb();
  const clips = Array.isArray(db.clips) ? db.clips : [];

  const clip = {
    id: payload?.id || randomUUID(),
    userId: cfg.userId || "local",
    deviceId: cfg.deviceId || "macos",
    type:
      payload?.type ||
      (payload?.imageDataUrl ? "image" : payload?.sourceUrl ? "link" : payload?.contentHtml ? "html" : "text"),
    summary:
      (payload?.summary || "").toString().trim() ||
      ((payload?.type === "image" || payload?.imageDataUrl) ? "Image" : (payload?.content || "").toString().trim().slice(0, 120) || "Untitled"),
    content: (payload?.content || "").toString(),
    contentHtml: payload?.contentHtml ?? null,
    sourceUrl: payload?.sourceUrl ?? null,
    imageDataUrl: payload?.imageDataUrl ?? null,
    isFavorite: Boolean(payload?.isFavorite),
    isDeleted: false,
    tags: Array.isArray(payload?.tags) ? payload.tags : [],
    clientUpdatedAt: payload?.clientUpdatedAt ?? now,
    serverUpdatedAt: now,
    createdAt: now
  };

  const cleaned = cleanupLocalDb(cfg, { clips: [clip, ...clips] });
  writeLocalDb(cleaned);
  return localOk(clip);
};

const localToggleFavorite = (cfg, id, isFavorite) => {
  const db = readLocalDb();
  const clips = Array.isArray(db.clips) ? db.clips : [];
  const next = clips.map((c) =>
    c?.id === id
      ? { ...c, isFavorite: Boolean(isFavorite), serverUpdatedAt: Date.now() }
      : c
  );
  const cleaned = cleanupLocalDb(cfg, { clips: next });
  writeLocalDb(cleaned);
  return localOk({ ok: true });
};

const localDeleteClip = (cfg, id) => {
  const db = readLocalDb();
  const clips = Array.isArray(db.clips) ? db.clips : [];
  const next = clips.filter((c) => c?.id !== id);
  const cleaned = cleanupLocalDb(cfg, { clips: next });
  writeLocalDb(cleaned);
  return localOk({ ok: true });
};

const isProbablyUrl = (value) => /^https?:\/\/\S+$/i.test((value || "").trim());

const extractUrlFromHtml = (value) => {
  // Only treat actual anchor tags as link sources; other tags may contain href
  // attributes (e.g. <link ...>) which should not make the clip a URL.
  const match = (value || "").match(/<a\b[^>]*\bhref\s*=\s*['"]([^'"]+)['"]/i);
  if (!match?.[1]) {
    return null;
  }
  return isProbablyUrl(match[1]) ? match[1] : null;
};

const htmlToText = (html) =>
  (html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const hasMeaningfulHtml = (html, text) => {
  const normalized = (html || "").trim();
  if (!normalized) {
    return false;
  }
  if (normalized === "<meta charset='utf-8'>" || normalized === '<meta charset="utf-8">') {
    return false;
  }
  const plain = htmlToText(normalized);
  if (!plain) {
    return /<img\b|<table\b|<a\b/i.test(normalized);
  }
  return (
    plain !== (text || "").trim() ||
    /<img\b|<table\b|<a\b|<code\b|<pre\b/i.test(normalized)
  );
};


const buildBestImageDataUrl = (img) => {
  try {
    const pngUrl = img.toDataURL();
    if (pngUrl.length <= MAX_IMAGE_DATA_URL_LENGTH) {
      return { ok: true, dataUrl: pngUrl };
    }

    const baseSize = img.getSize();
    const maxSide = Math.max(baseSize.width || 0, baseSize.height || 0);
    const targetMaxSides = [1920, 1440, 1080, 720, 512];
    const jpegQualities = [80, 70, 60, 50, 40, 30];

    for (const target of targetMaxSides) {
      let candidate = img;
      if (maxSide > target) {
        const resizeOptions = {
          width: baseSize.width >= baseSize.height ? target : undefined,
          height: baseSize.height > baseSize.width ? target : undefined,
          quality: "good"
        };
        candidate = img.resize(resizeOptions);
      }

      for (const q of jpegQualities) {
        let buf;
        try {
          buf = candidate.toJPEG(q);
        } catch {
          buf = null;
        }
        if (!buf || buf.length === 0) {
          continue;
        }
        const jpegUrl = `data:image/jpeg;base64,${buf.toString("base64")}`;
        if (jpegUrl.length <= MAX_IMAGE_DATA_URL_LENGTH) {
          return { ok: true, dataUrl: jpegUrl };
        }
      }
    }

    return {
      ok: false,
      reason: `Image too large (${pngUrl.length} chars). Enable R2 to sync full-size images (planned).`
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "image encode failed"
    };
  }
};

const buildImagePreviewDataUrl = (img) => {
  try {
    const baseSize = img.getSize();
    const maxSide = Math.max(baseSize.width || 0, baseSize.height || 0);
    const targetMaxSides = [512, 360, 256, 192];
    const jpegQualities = [50, 40, 30, 25];

    for (const target of targetMaxSides) {
      let candidate = img;
      if (maxSide > target) {
        const resizeOptions = {
          width: baseSize.width >= baseSize.height ? target : undefined,
          height: baseSize.height > baseSize.width ? target : undefined,
          quality: "good"
        };
        candidate = img.resize(resizeOptions);
      }

      for (const q of jpegQualities) {
        let buf;
        try {
          buf = candidate.toJPEG(q);
        } catch {
          buf = null;
        }
        if (!buf || buf.length === 0) continue;
        const url = `data:image/jpeg;base64,${buf.toString("base64")}`;
        if (url.length <= MAX_IMAGE_PREVIEW_DATA_URL_LENGTH) {
          return url;
        }
      }
    }

    // Fallback: tiny PNG if jpeg failed.
    try {
      const tiny = img.resize({ width: 192, height: 192, quality: "good" });
      const png = tiny.toDataURL();
      if (png && png.length <= MAX_IMAGE_PREVIEW_DATA_URL_LENGTH) return png;
    } catch {
      // ignore
    }

    return null;
  } catch {
    return null;
  }
};

const buildClipboardPayload = () => {
  const text = clipboard.readText().trim();
  const html = clipboard.readHTML().trim();
  const image = clipboard.readImage();
  const hasImage = !image.isEmpty();
  const richHtml = hasMeaningfulHtml(html, text) ? html : null;

  if (hasImage) {
    const best = buildBestImageDataUrl(image);
    if (!best.ok) {
      return {
        ok: false,
        captured: false,
        reason: best.reason || "Image too large"
      };
    }

    const preview = buildImagePreviewDataUrl(image);
    const sourceUrl = isProbablyUrl(text) ? text : extractUrlFromHtml(richHtml);
    return {
      ok: true,
      captured: true,
      payload: {
        type: "image",
        content: text || "[Image]",
        summary: text ? text.slice(0, 120) : "Image",
        contentHtml: richHtml,
        sourceUrl,
        imageDataUrl: best.dataUrl,
        imagePreviewDataUrl: preview,
        clientUpdatedAt: Date.now()
      }
    };
  }

  if (richHtml) {
    const sourceUrl = isProbablyUrl(text) ? text : extractUrlFromHtml(richHtml);
    const plain = text || htmlToText(richHtml);
    return {
      ok: true,
      captured: true,
      payload: {
        type: sourceUrl ? "link" : "html",
        content: plain || "[HTML]",
        // For link clips where the visible text isn't the URL, show the URL in
        // the preview so the "LINK" type isn't confusing.
        summary: (sourceUrl || plain || "HTML").slice(0, 120),
        contentHtml: richHtml,
        sourceUrl,
        imageDataUrl: null,
        clientUpdatedAt: Date.now()
      }
    };
  }

  if (text) {
    return {
      ok: true,
      captured: true,
      payload: {
        type: isProbablyUrl(text) ? "link" : "text",
        content: text,
        summary: text.slice(0, 120),
        contentHtml: null,
        sourceUrl: isProbablyUrl(text) ? text : null,
        imageDataUrl: null,
        clientUpdatedAt: Date.now()
      }
    };
  }

  return {
    ok: false,
    captured: false,
    reason: "empty clipboard"
  };
};

const payloadFingerprint = (payload) =>
  [
    payload.type || "",
    (payload.content || "").slice(0, 160),
    payload.sourceUrl || "",
    payload.contentHtml ? payload.contentHtml.slice(0, 160) : "",
    payload.imageDataUrl ? `image:${payload.imageDataUrl.length}` : ""
  ].join("|");

const syncClipboardFingerprintsFromSystemClipboard = () => {
  // Keep both probe + payload fingerprints aligned with the real clipboard, so
  // the watcher doesn't re-capture content we just wrote ourselves.
  try {
    lastClipboardProbeFingerprint = probeClipboardFingerprint();
  } catch {
    // ignore
  }
  try {
    const built = buildClipboardPayload();
    if (built && built.ok && built.captured && built.payload) {
      lastClipboardFingerprint = payloadFingerprint(built.payload);
    }
  } catch {
    // ignore
  }
};

const seenClipboardFingerprintRecently = (fingerprint, now, windowMs) => {
  if (!fingerprint) return false;

  // Prune on read to keep the map small.
  for (const [k, at] of recentClipboardFingerprints.entries()) {
    if (!at || now - at > windowMs) {
      recentClipboardFingerprints.delete(k);
    }
  }

  const prev = recentClipboardFingerprints.get(fingerprint) || 0;
  if (prev && now - prev <= windowMs) {
    recentClipboardFingerprints.set(fingerprint, now);
    return true;
  }
  recentClipboardFingerprints.set(fingerprint, now);
  return false;
};

const hashPrefix = (buf) => {
  try {
    if (!buf || buf.length === 0) return "";
    const head = buf.subarray(0, Math.min(4096, buf.length));
    return createHash("sha1").update(head).digest("hex");
  } catch {
    return "";
  }
};

// Cheap fingerprint to skip expensive image encode when clipboard hasn't changed.
// Uses raw clipboard buffers when available (no base64/DataURL conversion).
const probeClipboardFingerprint = () => {
  const text = clipboard.readText().trim();
  const html = clipboard.readHTML().trim();
  const formats = clipboard.availableFormats() || [];

  let imageKey = "";
  const preferredImageFormat =
    (formats.includes("image/png") && "image/png") ||
    (formats.includes("public.png") && "public.png") ||
    (formats.includes("public.tiff") && "public.tiff") ||
    formats.find((f) => typeof f === "string" && f.startsWith("image/")) ||
    null;

  if (preferredImageFormat) {
    try {
      const buf = clipboard.readBuffer(preferredImageFormat);
      imageKey = buf && buf.length ? `${preferredImageFormat}:${buf.length}:${hashPrefix(buf)}` : `${preferredImageFormat}:0`;
    } catch {
      imageKey = `${preferredImageFormat}:err`;
    }
  }

  return [
    text.slice(0, 160),
    html.slice(0, 80),
    imageKey
  ].join("|");
};

const buildRemoteHeaders = (cfg, extra = {}) => {
  const authHeaders = isTokenAuthEnabled(cfg)
    ? {
        authorization: `Bearer ${cfg.authToken.trim()}`,
        "x-device-id": cfg.deviceId
      }
    : {
        "x-user-id": cfg.userId,
        "x-device-id": cfg.deviceId
      };
  return {
    ...authHeaders,
    ...(extra || {})
  };
};

const remoteRequest = async (cfg, pathname, init = {}) => {
  const base = cfg.apiBase.trim().replace(/\/$/g, "");
  const url = `${base}${pathname}`;
  const headers = buildRemoteHeaders(cfg, {
    "content-type": "application/json",
    ...(init.headers || {})
  });

  try {
    const response = await fetch(url, { ...init, headers });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok && data && data.ok === false) {
      return data;
    }
    if (!response.ok) {
      return { ok: false, code: "HTTP_ERROR", message: `HTTP ${response.status}` };
    }
    return data;
  } catch (error) {
    return {
      ok: false,
      code: "NETWORK_ERROR",
      message: error instanceof Error ? error.message : "network error"
    };
  }
};

const createClipFromPayload = async (payload, source = "watcher") => {
  const cfg = readConfig();
  const body = {
    ...payload,
    tags: source === "watcher" ? ["auto"] : payload.tags || []
  };

  if (!isRemoteEnabled(cfg)) {
    const res = localCreateClip(cfg, body);
    if (res.ok) {
      return { ok: true, captured: true };
    }
    return { ok: false, captured: false, reason: res.message || "capture failed" };
  }

  const res = await remoteRequest(cfg, "/clips", {
    method: "POST",
    body: JSON.stringify(body)
  });

  if (res && res.ok) {
    return { ok: true, captured: true };
  }

  return {
    ok: false,
    captured: false,
    reason: res?.message || "capture failed"
  };
};

const captureClipboardNow = async (source = "manual") => {
  const probe = source === "manual" ? "" : probeClipboardFingerprint();
  if (probe && probe === lastClipboardProbeFingerprint) {
    return { ok: true, captured: false, reason: "duplicated" };
  }
  // If a capture is already running, skip watcher ticks to prevent overlapping
  // requests inserting the same clip multiple times (common when network is slow).
  if (probe && probe === captureClipboardInFlightProbe && source !== "manual") {
    return { ok: true, captured: false, reason: "duplicated" };
  }
  if (captureClipboardInFlight) {
    if (source === "manual") {
      try {
        await captureClipboardInFlight;
      } catch {
        // ignore; manual capture will retry below
      }
    } else {
      return { ok: true, captured: false, reason: "busy" };
    }
  }
  const now = Date.now();
  if (
    probe &&
    lastClipboardFailure.fingerprint === probe &&
    now - (lastClipboardFailure.at || 0) < 30_000 &&
    source !== "manual"
  ) {
    return { ok: true, captured: false, reason: "retry-backoff" };
  }

  captureClipboardInFlightProbe = probe || "";
  captureClipboardInFlight = (async () => {
    const built = buildClipboardPayload();
    if (!built.ok || !built.captured) {
      return built;
    }

    const fingerprint = payloadFingerprint(built.payload);
    // Prevent A,B,A loops from generating duplicates when the clipboard alternates
    // between values (common when copying/pasting quickly).
    if (source === "watcher") {
      const DUP_WINDOW_MS = 60_000;
      if (seenClipboardFingerprintRecently(fingerprint, Date.now(), DUP_WINDOW_MS)) {
        if (probe) lastClipboardProbeFingerprint = probe;
        return { ok: true, captured: false, reason: "duplicated" };
      }
    }
    if (fingerprint === lastClipboardFingerprint && source !== "manual") {
      if (probe) lastClipboardProbeFingerprint = probe;
      return { ok: true, captured: false, reason: "duplicated" };
    }

    const result = await createClipFromPayload(built.payload, source);
    if (result.ok && result.captured) {
      lastClipboardFingerprint = fingerprint;
      if (probe) lastClipboardProbeFingerprint = probe;
      lastClipboardFailure = { fingerprint: "", at: 0 };
      broadcastToWindows("clips:changed", { source, at: Date.now() });
    } else if (probe && source !== "manual") {
      // Avoid re-encoding the same clipboard payload every tick when network is down.
      lastClipboardFailure = { fingerprint: probe, at: Date.now() };
    }
    return result;
  })();

  try {
    return await captureClipboardInFlight;
  } finally {
    captureClipboardInFlight = null;
    captureClipboardInFlightProbe = "";
  }
};

const safeLoadURL = async (win, url) => {
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      await win.loadURL(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  try {
    await win.loadURL(url);
  } catch (error) {
    console.error("Failed to load renderer URL:", url, error);
  }
};

const humanizeAccelerator = (acc) => {
  const raw = (acc || "").toString().trim();
  if (!raw) return "";
  const isMac = process.platform === "darwin";
  const map = {
    CommandOrControl: isMac ? "Cmd" : "Ctrl",
    Command: isMac ? "Cmd" : "Cmd",
    Control: "Ctrl",
    Ctrl: "Ctrl",
    Shift: "Shift",
    Alt: isMac ? "Option" : "Alt",
    Option: "Option",
    Super: isMac ? "Cmd" : "Win"
  };
  return raw
    .split("+")
    .map((p) => map[p] || p)
    .join("+");
};

const ensureMainWindow = async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return mainWindow;
  }
  try {
    await createMainWindow();
  } catch (error) {
    console.error("Failed to create main window:", error);
  }
  return mainWindow;
};

const fitMainWindowToDisplay = () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const currentBounds = mainWindow.getBounds();
  const display = screen.getDisplayMatching(currentBounds);
  const workArea = display?.workArea || display?.bounds;
  if (!workArea) {
    return;
  }

  const nextBounds = {
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height
  };
  const unchanged =
    currentBounds.x === nextBounds.x &&
    currentBounds.y === nextBounds.y &&
    currentBounds.width === nextBounds.width &&
    currentBounds.height === nextBounds.height;

  if (!unchanged) {
    mainWindow.setBounds(nextBounds, false);
  }
};

const toggleMainWindow = async () => {
  const win = await ensureMainWindow();
  if (!win) {
    return { visible: false };
  }

  if (win.isVisible()) {
    win.hide();
    return { visible: false };
  }

  fitMainWindowToDisplay();
  win.show();
  win.focus();
  return { visible: true };
};

const showSettings = async () => {
  const win = await ensureMainWindow();
  if (!win) return;
  win.show();
  win.focus();
  broadcastToWindows("ui:open-settings", { at: Date.now() });
};

const buildTrayTemplate = () => {
  const versionLabel = `Version ${app.getVersion()}`;
  const hkLabel = hotkeyStatus?.ok
    ? `Hotkey: ${humanizeAccelerator(hotkeyStatus.hotkey || readConfig().hotkey || defaultConfig.hotkey)}`
    : "Hotkey: (not registered)";

  const updateLabel = updateState.checking
    ? "Checking for Updates..."
    : updateState.downloaded
      ? "Restart and Install Update"
      : "Check for Updates...";

  const updateEnabled = !isDev && (!updateState.checking);

  const updateClick = async () => {
    if (isDev) {
      return;
    }
    if (updateState.downloaded) {
      try {
        autoUpdater.quitAndInstall();
      } catch {
        // ignore
      }
      return;
    }

    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      setUpdateState({
        checking: false,
        error: error instanceof Error ? error.message : "update check failed"
      });
      try {
        await dialog.showMessageBox(mainWindow || undefined, {
          type: "error",
          message: "Update check failed",
          detail: updateState.error || "",
          buttons: ["OK", "Open Releases Page"],
          defaultId: 0,
          cancelId: 0
        }).then(async (res) => {
          if (res.response === 1) {
            await shell.openExternal(RELEASES_LATEST_URL);
          }
        });
      } catch {
        // ignore
      }
    }
  };

  const items = [
    { label: "Show / Hide", click: () => void toggleMainWindow() },
    { label: "Open Settings", click: () => void showSettings() },
    { label: hkLabel, enabled: false },
    ...(hotkeyStatus?.ok
      ? []
      : [
          {
            label: `Hotkey Error: ${hotkeyStatus?.message || "Failed to register global hotkey"}`,
            enabled: false
          }
        ]),
    { type: "separator" },
    {
      label: "Capture Clipboard Now",
      click: async () => {
        await captureClipboardNow("menu");
      }
    },
    { type: "separator" },
    {
      label: updateLabel,
      enabled: updateEnabled,
      click: () => {
        void updateClick();
      }
    },
    {
      label: "Open Releases Page",
      enabled: true,
      click: () => {
        void shell.openExternal(RELEASES_LATEST_URL);
      }
    },
    { label: versionLabel, enabled: false },
    ...(updateState.available && !updateState.downloaded
      ? [
          {
            label:
              updateState.progressPercent == null
                ? `Update Available${updateState.version ? ` (${updateState.version})` : ""}`
                : `Downloading Update... ${Math.max(0, Math.min(100, Math.round(updateState.progressPercent)))}%`,
            enabled: false
          }
        ]
      : []),
    ...(updateState.downloaded
      ? [{ label: `Update Ready${updateState.version ? ` (${updateState.version})` : ""}`, enabled: false }]
      : []),
    ...(updateState.error
      ? [{ label: `Update Error: ${updateState.error}`, enabled: false }]
      : []),
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.isQuiting = true;
        app.quit();
      }
    }
  ];

  return items;
};

const updateTrayMenu = () => {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate(buildTrayTemplate());
  tray.setContextMenu(contextMenu);
};

const createMainWindow = async () => {
  const display = screen.getPrimaryDisplay();
  const { x: workAreaX, y: workAreaY, width, height } = display.workArea || display.bounds;

  mainWindow = new BrowserWindow({
    width,
    height,
    x: workAreaX,
    y: workAreaY,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    fullscreenable: true,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    visualEffectState: "active",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (isDev) {
    await safeLoadURL(mainWindow, devUrl);
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  mainWindow.on("blur", () => {
    if (mainWindow && mainWindow.isVisible()) {
      mainWindow.hide();
    }
  });

  mainWindow.on("show", () => {
    broadcastToWindows("window:shown", { at: Date.now() });
  });
  mainWindow.on("hide", () => {
    broadcastToWindows("window:hidden", { at: Date.now() });
  });

  mainWindow.on("close", (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
};

const createTray = () => {
  const trayAssetPath = path.join(__dirname, "assets", "trayTemplate.png");
  let loadedFromAsset = false;
  let icon = null;
  try {
    if (fs.existsSync(trayAssetPath)) {
      icon = nativeImage.createFromPath(trayAssetPath);
      loadedFromAsset = true;
    }
  } catch {
    // ignore
  }
  if (!icon || icon.isEmpty()) {
    icon = nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAQAAAC1QeVaAAAAKklEQVR42mP8z8DAwMgABYwMjAxwMDAwGGAAQzQwMDAA4hSYDKQdA4QAAJw3B8eEzWLWAAAAAElFTkSuQmCC"
    );
    loadedFromAsset = false;
  }

  try {
    if (process.platform === "darwin" && icon && !icon.isEmpty()) {
      icon.setTemplateImage(true);
    }
  } catch {
    // ignore
  }

  let trayIcon = icon;
  try {
    // Slightly larger improves visibility in the macOS menu bar.
    if (trayIcon && !trayIcon.isEmpty()) {
      trayIcon = trayIcon.resize({ width: 22, height: 22, quality: "best" });
    }
  } catch {
    // ignore
  }

  tray = new Tray(trayIcon);
  const trayLabel = trayDebug ? `PASTE_TRAY_DEBUG_${process.pid}` : "pastyx";
  tray.setToolTip(trayLabel);
  if (process.platform === "darwin") {
    // If the icon is too subtle or hidden by tinting, a short title guarantees something visible.
    // (Users can still hide it via menu bar manager apps; this just removes "icon is invisible" as a class of bugs.)
    tray.setTitle(trayLabel);
  }

  updateTrayMenu();
  tray.on("click", async () => {
    console.log("[tray] click");
    try {
      const res = await toggleMainWindow();
      console.log("[tray] toggle", res);
    } catch (e) {
      console.log("[tray] toggle error", e instanceof Error ? e.message : String(e));
    }
  });
  tray.on("right-click", () => {
    console.log("[tray] right-click");
    try {
      tray.popUpContextMenu();
    } catch {
      // ignore
    }
  });

  const logTray = (tag) => {
    try {
      console.log(tag, {
        bounds: tray?.getBounds?.(),
        title: tray?.getTitle?.(),
        tooltip: tray?.getToolTip?.()
      });
    } catch (e) {
      console.log(tag, { error: e instanceof Error ? e.message : String(e) });
    }
  };

  console.log("[tray] created", {
    platform: process.platform,
    isDev,
    devUrl,
    loadedFromAsset,
    trayAssetPath
  });
  logTray("[tray] initial");
  setTimeout(() => logTray("[tray] +1s"), 1000);
};

const setupAutoUpdate = () => {
  if (isDev) return;

  // Keep behavior conservative: download automatically, but only install on explicit restart
  // (or when quitting the app).
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    setUpdateState({
      checking: true,
      available: false,
      downloaded: false,
      progressPercent: null,
      version: null,
      error: null
    });
  });

  autoUpdater.on("update-available", (info) => {
    setUpdateState({
      checking: false,
      available: true,
      downloaded: false,
      progressPercent: null,
      version: info?.version || null,
      error: null
    });
  });

  autoUpdater.on("update-not-available", () => {
    setUpdateState({
      checking: false,
      available: false,
      downloaded: false,
      progressPercent: null,
      version: null,
      error: null
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    const pct = typeof progress?.percent === "number" ? progress.percent : null;
    setUpdateState({
      checking: false,
      available: true,
      downloaded: false,
      progressPercent: pct,
      error: null
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    setUpdateState({
      checking: false,
      available: true,
      downloaded: true,
      progressPercent: 100,
      version: info?.version || updateState.version || null,
      error: null
    });

    // Prompt once when the update is ready.
    void (async () => {
      try {
        const res = await dialog.showMessageBox(mainWindow || undefined, {
          type: "info",
          message: "Update downloaded",
          detail: "Restart Pastyx to install the update.",
          buttons: ["Later", "Restart Now"],
          defaultId: 1,
          cancelId: 0
        });
        if (res.response === 1) {
          autoUpdater.quitAndInstall();
        }
      } catch {
        // ignore
      }
    })();
  });

  autoUpdater.on("error", (error) => {
    setUpdateState({
      checking: false,
      error: error instanceof Error ? error.message : "auto update error"
    });
  });

  // Check shortly after startup; GitHub API can be slow on first request.
  setTimeout(() => {
    try {
      void autoUpdater.checkForUpdates();
    } catch {
      // ignore
    }
  }, 4000);
};

const registerGlobalShortcut = (hotkey) => {
  const desired = (hotkey ?? readConfig()?.hotkey ?? defaultConfig.hotkey).toString().trim() || defaultConfig.hotkey;

  if (registeredHotkey) {
    try {
      globalShortcut.unregister(registeredHotkey);
    } catch {
      // ignore
    }
    registeredHotkey = null;
  }

  const uniq = (arr) => {
    const out = [];
    const seen = new Set();
    for (const v of arr) {
      const s = (v || "").toString().trim();
      if (!s) continue;
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
    return out;
  };

  const candidates = uniq([
    desired,
    defaultConfig.hotkey,
    "CommandOrControl+Shift+Space",
    "CommandOrControl+Shift+P",
    "CommandOrControl+Alt+V"
  ]);

  for (const candidate of candidates) {
    try {
      const ok = globalShortcut.register(candidate, () => {
        void toggleMainWindow();
      });
      if (!ok) continue;

      registeredHotkey = candidate;
      const corrected = candidate !== desired;
      const message = corrected
        ? `Hotkey unavailable: ${humanizeAccelerator(desired)}. Using: ${humanizeAccelerator(candidate)}`
        : null;
      hotkeyStatus = { ok: true, hotkey: candidate, corrected, message };
      try {
        updateTrayMenu();
      } catch {
        // ignore
      }
      return { ...hotkeyStatus };
    } catch {
      // try next candidate
    }
  }

  hotkeyStatus = { ok: false, hotkey: null, corrected: false, message: "Failed to register global hotkey" };
  try {
    updateTrayMenu();
  } catch {
    // ignore
  }
  return { ...hotkeyStatus };
};

const startClipboardWatcher = () => {
  clipboardTimer = setInterval(async () => {
    const cfg = readConfig();
    if (!cfg.autoCapture) {
      return;
    }

    await captureClipboardNow("watcher");
  }, 1200);
};

const setupIpc = () => {
  ipcMain.handle("config:get", async () => getConfigForRenderer());

  ipcMain.handle("config:set", async (_, next) => {
    const merged = writeConfig({ ...readConfig(), ...(next || {}) });
    // Apply retention cleanup in local mode.
    if (!isRemoteEnabled(merged)) {
      writeLocalDb(cleanupLocalDb(merged, readLocalDb()));
    }
    try {
      app.setLoginItemSettings({ openAtLogin: Boolean(merged.launchAtLogin) });
    } catch {
      // ignore
    }

    // Apply configured hotkey immediately.
    const hk = registerGlobalShortcut(merged.hotkey);
    if (hk.ok && hk.hotkey && hk.corrected && hk.hotkey !== merged.hotkey) {
      writeConfig({ ...merged, hotkey: hk.hotkey });
    }
    return { ok: hk.ok, message: hk.message };
  });

  ipcMain.handle("auth:status", async () => {
    const cfg = readConfig();
    if (!isRemoteEnabled(cfg)) {
      return localOk({
        remoteEnabled: false,
        authenticated: false,
        authConfigured: false,
        user: null
      });
    }

    const res = await remoteRequest(cfg, "/auth/me");
    if (!res?.ok) {
      return res;
    }

    const authUser = res?.data?.user || null;
    const authenticated = Boolean(res?.data?.authenticated && authUser);
    if (!authenticated && isTokenAuthEnabled(cfg)) {
      writeConfig({ ...cfg, authToken: "", authGithubLogin: "" });
    } else if (authenticated) {
      const nextUserId = String(authUser?.userId || cfg.userId || "").trim() || cfg.userId;
      const nextLogin = String(authUser?.githubLogin || cfg.authGithubLogin || "").trim();
      if (nextUserId !== cfg.userId || nextLogin !== cfg.authGithubLogin) {
        writeConfig({ ...cfg, userId: nextUserId, authGithubLogin: nextLogin });
      }
    }

    return localOk({
      remoteEnabled: true,
      authenticated,
      authConfigured: Boolean(res?.data?.authConfigured),
      user: authenticated
        ? {
            userId: String(authUser.userId || ""),
            githubLogin: String(authUser.githubLogin || ""),
            githubId: Number(authUser.githubId || 0)
          }
        : null
    });
  });

  ipcMain.handle("auth:github-device-start", async () => {
    const cfg = readConfig();
    if (!isRemoteEnabled(cfg)) {
      return localFail("Please configure API Endpoint first");
    }

    const res = await remoteRequest(cfg, "/auth/github/device/start", {
      method: "POST",
      body: JSON.stringify({})
    });
    if (res?.ok && res?.data?.verificationUriComplete) {
      try {
        await shell.openExternal(String(res.data.verificationUriComplete));
      } catch {
        // ignore
      }
    } else if (res?.ok && res?.data?.verificationUri) {
      try {
        await shell.openExternal(String(res.data.verificationUri));
      } catch {
        // ignore
      }
    }
    return res;
  });

  ipcMain.handle("auth:github-device-poll", async (_, deviceCode) => {
    const cfg = readConfig();
    if (!isRemoteEnabled(cfg)) {
      return localFail("Please configure API Endpoint first");
    }

    const code = String(deviceCode || "").trim();
    if (!code) {
      return { ok: false, code: "INVALID_DEVICE_CODE", message: "deviceCode is required" };
    }

    const res = await remoteRequest(cfg, "/auth/github/device/poll", {
      method: "POST",
      body: JSON.stringify({ deviceCode: code })
    });

    if (
      res?.ok &&
      res?.data?.status === "approved" &&
      typeof res?.data?.accessToken === "string" &&
      res.data.accessToken.trim()
    ) {
      const user = res?.data?.user || {};
      const nextCfg = writeConfig({
        ...cfg,
        authToken: res.data.accessToken.trim(),
        authGithubLogin: String(user.githubLogin || "").trim(),
        userId: String(user.userId || cfg.userId || "").trim() || cfg.userId
      });
      return localOk({
        status: "approved",
        user: {
          userId: nextCfg.userId,
          githubLogin: nextCfg.authGithubLogin
        }
      });
    }

    return res;
  });

  ipcMain.handle("auth:logout", async () => {
    const cfg = readConfig();
    if (isRemoteEnabled(cfg)) {
      try {
        await remoteRequest(cfg, "/auth/logout", {
          method: "POST",
          body: JSON.stringify({})
        });
      } catch {
        // ignore
      }
    }
    const next = writeConfig({ ...cfg, authToken: "", authGithubLogin: "" });
    return localOk({
      loggedOut: true,
      userId: next.userId
    });
  });

  ipcMain.handle("clips:list", async (_, query = {}) => {
    const cfg = readConfig();
    if (!isRemoteEnabled(cfg)) {
      return localListClips(cfg, query);
    }

    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.favorite) params.set("favorite", "1");
    params.set("limit", "60");
    params.set("lite", "1");
    return remoteRequest(cfg, `/clips?${params.toString()}`);
  });

  ipcMain.handle("clips:get", async (_, id) => {
    const cfg = readConfig();
    const clipId = (id ?? "").toString().trim();
    if (!clipId) {
      return { ok: false, code: "INVALID_ID", message: "id is required" };
    }

    if (!isRemoteEnabled(cfg)) {
      const db = readLocalDb();
      const items = Array.isArray(db?.clips) ? db.clips : [];
      const found = items.find((c) => c?.id === clipId) || null;
      if (!found) {
        return { ok: false, code: "NOT_FOUND", message: "clip not found" };
      }
      return localOk(found);
    }

    return remoteRequest(cfg, `/clips/${encodeURIComponent(clipId)}`);
  });

  ipcMain.handle("clips:create", async (_, payload) => {
    const cfg = readConfig();
    if (!isRemoteEnabled(cfg)) {
      return localCreateClip(cfg, {
        content: payload?.content || "",
        summary: payload?.summary,
        type: payload?.type,
        contentHtml: payload?.contentHtml ?? null,
        sourceUrl: payload?.sourceUrl ?? null,
        imageDataUrl: payload?.imageDataUrl ?? null,
        tags: payload?.tags || [],
        clientUpdatedAt: Date.now()
      });
    }

    return remoteRequest(cfg, "/clips", {
      method: "POST",
      body: JSON.stringify({
        content: payload?.content || "",
        summary: payload?.summary,
        type: payload?.type,
        contentHtml: payload?.contentHtml ?? null,
        sourceUrl: payload?.sourceUrl ?? null,
        imageDataUrl: payload?.imageDataUrl ?? null,
        tags: payload?.tags || [],
        clientUpdatedAt: Date.now()
      })
    });
  });

  ipcMain.handle("clips:favorite", async (_, id, isFavorite) => {
    const cfg = readConfig();
    if (!isRemoteEnabled(cfg)) {
      return localToggleFavorite(cfg, id, isFavorite);
    }

    return remoteRequest(cfg, `/clips/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        isFavorite,
        clientUpdatedAt: Date.now()
      })
    });
  });

  ipcMain.handle("clips:delete", async (_, id) => {
    const cfg = readConfig();
    if (!isRemoteEnabled(cfg)) {
      return localDeleteClip(cfg, id);
    }

    return remoteRequest(cfg, `/clips/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: JSON.stringify({
        clientUpdatedAt: Date.now()
      })
    });
  });

  ipcMain.handle("clipboard:read", async () => clipboard.readText());

  ipcMain.handle("clipboard:write", async (_, value) => {
    try {
      const text = typeof value === "string" ? value : value?.text || "";
      const html = typeof value === "string" ? null : value?.html || null;
      const imageDataUrl = typeof value === "string" ? null : value?.imageDataUrl || null;
      const image = imageDataUrl ? nativeImage.createFromDataURL(imageDataUrl) : null;

      if (image && !image.isEmpty()) {
        clipboard.write({
          text,
          html: html || undefined,
          image
        });
      } else if (html) {
        clipboard.write({
          text: text || htmlToText(html),
          html
        });
      } else {
        clipboard.writeText(text || "");
      }

      syncClipboardFingerprintsFromSystemClipboard();

      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "clipboard write failed"
      };
    }
  });

  ipcMain.handle("clipboard:paste-and-hide", async (_, value) => {
    try {
      const ax = ensureAccessibilityTrusted();
      if (!ax.ok) {
        void openAccessibilityPrefs();
        return {
          ok: false,
          message:
            `macOS blocked synthetic keystrokes.\n\n` +
            `Please enable Accessibility for the running app:\n` +
            `- If you run via npm (dev): enable Accessibility for "Electron"\n` +
            `- If you run the built app: enable Accessibility for "Pastyx"\n\n` +
            `System Settings -> Privacy & Security -> Accessibility`
        };
      }

      // 1. 先执行写入剪贴板逻辑 (调用内部已有的逻辑或重用部分代码)
      const text = typeof value === "string" ? value : value?.text || "";
      const html = typeof value === "string" ? null : value?.html || null;
      const imageDataUrl = typeof value === "string" ? null : value?.imageDataUrl || null;
      const imageUrl = typeof value === "string" ? null : value?.imageUrl || null;

      let image = imageDataUrl ? nativeImage.createFromDataURL(imageDataUrl) : null;
      if ((!image || image.isEmpty()) && imageUrl) {
        try {
          const cfg = readConfig();
          if (isRemoteEnabled(cfg)) {
            const abs = new URL(imageUrl, cfg.apiBase.trim()).toString();
            const res = await fetch(abs, {
              headers: buildRemoteHeaders(cfg)
            });
            if (res.ok) {
              const buf = Buffer.from(await res.arrayBuffer());
              const candidate = nativeImage.createFromBuffer(buf);
              if (candidate && !candidate.isEmpty()) {
                image = candidate;
              }
            }
          }
        } catch {
          // ignore; fall back to text/html
        }
      }

      if (image && !image.isEmpty()) {
        clipboard.write({ text, html: html || undefined, image });
      } else if (html) {
        clipboard.write({ text: text || htmlToText(html), html });
      } else {
        clipboard.writeText(text || "");
      }

      // Update fingerprints to avoid the watcher re-capturing what we just wrote.
      syncClipboardFingerprintsFromSystemClipboard();

      // 2. 隐藏窗口
      if (mainWindow) {
        mainWindow.hide();
      }

      // 3. 切回前台应用，再模拟 Cmd+V
      if (process.platform === "darwin") {
        // After hiding our always-on-top overlay, macOS should restore focus to the original app.
        // Resolve that app here instead of doing synchronous osascript work on the hotkey path.
        await new Promise((resolve) => setTimeout(resolve, 40));

        const resolved = await waitForFrontmostNonSelfAppAsync({ timeoutMs: 1500 });
        if (resolved?.name || resolved?.bundleId) {
          lastTargetApp = { name: resolved?.name || "", bundleId: resolved?.bundleId || "", at: Date.now() };
        }
        const fallback = lastTargetApp || { name: "", bundleId: "", at: 0 };
        const targetName = resolved?.name || fallback.name || "";
        const targetBundleId = resolved?.bundleId || fallback.bundleId || "";
        const targetCapturedAt = fallback?.at || 0;

        const hasTarget = Boolean(targetName || targetBundleId);

        if (targetBundleId) {
          try {
            await runAppleScript([`tell application id "${targetBundleId}" to activate`]);
          } catch {
            // ignore (still attempt paste)
          }
        }

        // Wait until the target app is truly frontmost; fixed sleeps are flaky.
        const frontOk = hasTarget
          ? await waitForFrontmostApp({ name: targetName, bundleId: targetBundleId, timeoutMs: 1500 })
          : true;
        try {
          if (targetName) {
            const safeName = String(targetName).replace(/\"/g, "\\\"");
            await runAppleScript([
              'tell application "System Events"',
              `tell process "${safeName}" to keystroke "v" using {command down}`,
              "end tell"
            ]);
          } else {
            await runAppleScript(['tell application "System Events" to keystroke "v" using {command down}']);
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : "Pastyx failed";
          const front = getFrontmostApp();
          return {
            ok: false,
            message:
              `Pastyx failed: ${msg}\n\n` +
              `Target app: ${targetName || "(unknown)"} (${targetBundleId || "no bundle id"})\n` +
              `Captured at: ${targetCapturedAt ? new Date(targetCapturedAt).toISOString() : "(unknown)"}\n` +
              `Frontmost before paste: ${front.name || "(unknown)"} (${front.bundleId || "no bundle id"})\n` +
              `Frontmost matched target: ${frontOk ? "yes" : "no"}\n\n` +
              `If this keeps happening, enable Accessibility for "${app.getName()}" in System Settings -> Privacy & Security -> Accessibility.`
          };
        }
      }

      return { ok: true };
    } catch (error) {
      return { ok: false, message: "Pastyx failed" };
    }
  });

  ipcMain.handle("window:toggle", async () => toggleMainWindow());

  ipcMain.handle("window:capture", async () => {
    try {
      if (!mainWindow) {
        return { ok: false, message: "window not ready" };
      }

      const img = await mainWindow.capturePage();
      if (!img || img.isEmpty()) {
        return { ok: false, message: "capture returned empty image" };
      }

      // Settings backdrop doesn't need full-resolution; downscale reduces decode cost.
      const size = img.getSize();
      const maxWidth = 1600;
      const targetWidth = Math.max(1, Math.min(size.width, maxWidth));
      const targetHeight = Math.max(1, Math.round((size.height * targetWidth) / Math.max(1, size.width)));
      const resized = targetWidth === size.width ? img : img.resize({ width: targetWidth, height: targetHeight });

      return { ok: true, dataUrl: resized.toDataURL() };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "capture failed" };
    }
  });

  ipcMain.handle("clipboard:capture-now", async () => captureClipboardNow("manual"));
};

app.on("ready", async () => {
  if (process.platform === "darwin") {
    try {
      app.dock.hide();
    } catch {
      // no-op
    }
  }

  app.setName("Pastyx");
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(readConfig().launchAtLogin) });
  } catch {
    // ignore
  }
  setupIpc();
  // Create tray first so the app is still reachable even if the renderer fails to load.
  createTray();

  // Run a retention cleanup at startup in local mode.
  const cfg = readConfig();
  if (!isRemoteEnabled(cfg)) {
    writeLocalDb(cleanupLocalDb(cfg, readLocalDb()));
  }

  await ensureMainWindow();
  fitMainWindowToDisplay();
  try {
    screen.on("display-metrics-changed", () => {
      try {
        fitMainWindowToDisplay();
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
  }
  setupAutoUpdate();
  const hk = registerGlobalShortcut();
  if (hk?.ok && hk?.corrected && hk?.hotkey && hk.hotkey !== readConfig().hotkey) {
    try {
      writeConfig({ ...readConfig(), hotkey: hk.hotkey });
    } catch {
      // ignore
    }
  }
  if (!hk?.ok) {
    try {
      await dialog.showMessageBox(mainWindow || undefined, {
        type: "error",
        message: "Global hotkey not registered",
        detail:
          "Another app may be using the same hotkey.\n\n" +
          "Click the tray icon to open Pastyx, then Settings -> Hotkey to choose a different one.",
        buttons: ["OK"],
        defaultId: 0
      });
    } catch {
      // ignore
    }
  } else if (hk?.corrected && hk?.message) {
    try {
      await dialog.showMessageBox(mainWindow || undefined, {
        type: "info",
        message: "Hotkey changed",
        detail: hk.message,
        buttons: ["OK"],
        defaultId: 0
      });
    } catch {
      // ignore
    }
  }
  startClipboardWatcher();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void ensureMainWindow();
    return;
  }
  if (mainWindow && !mainWindow.isVisible()) {
    mainWindow.show();
  }
});

app.on("will-quit", () => {
  if (clipboardTimer) {
    clearInterval(clipboardTimer);
  }
  globalShortcut.unregisterAll();
});
