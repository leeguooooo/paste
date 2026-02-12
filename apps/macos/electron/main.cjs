const { randomUUID } = require("node:crypto");
const {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  screen
} = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const isDev = !app.isPackaged;
const devUrl = "http://127.0.0.1:5174";

const configFile = path.join(app.getPath("userData"), "paste-macos-config.json");
const localClipsFile = path.join(app.getPath("userData"), "paste-local-clips.json");

// Keep a conservative limit even in local mode to avoid huge on-disk JSON.
const MAX_IMAGE_DATA_URL_LENGTH = 1_500_000;

let mainWindow = null;
let tray = null;
let clipboardTimer = null;
let lastClipboardFingerprint = "";
let registeredHotkey = null;

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
  autoCapture: true,
  launchAtLogin: false,
  // Paste-like options: 30d / 180d / 365d / forever
  // Favorites are kept even when expiring.
  retention: "180d",
  hotkey: "CommandOrControl+Shift+V"
};

const readConfig = () => {
  try {
    if (!fs.existsSync(configFile)) {
      fs.writeFileSync(configFile, JSON.stringify(defaultConfig, null, 2));
      return { ...defaultConfig };
    }
    const parsed = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    return { ...defaultConfig, ...(parsed || {}) };
  } catch {
    return { ...defaultConfig };
  }
};

const writeConfig = (next) => {
  const merged = { ...defaultConfig, ...(next || {}) };
  fs.writeFileSync(configFile, JSON.stringify(merged, null, 2));
  return merged;
};

const isRemoteEnabled = (cfg) => typeof cfg?.apiBase === "string" && /^https?:\/\//i.test(cfg.apiBase.trim());

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
  return { clips };
};

const localListClips = (cfg, query = {}) => {
  const q = (query.q || "").toString().trim().toLowerCase();
  const favoriteOnly = Boolean(query.favorite);

  const cleaned = cleanupLocalDb(cfg, readLocalDb());
  writeLocalDb(cleaned);

  let items = cleaned.clips;
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
  const match = (value || "").match(/href\s*=\s*['"]([^'"]+)['"]/i);
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
        summary: (plain || sourceUrl || "HTML").slice(0, 120),
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

const remoteRequest = async (cfg, pathname, init = {}) => {
  const base = cfg.apiBase.trim().replace(/\/$/g, "");
  const url = `${base}${pathname}`;
  const headers = {
    "content-type": "application/json",
    "x-user-id": cfg.userId,
    "x-device-id": cfg.deviceId,
    ...(init.headers || {})
  };

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
  const built = buildClipboardPayload();
  if (!built.ok || !built.captured) {
    return built;
  }

  const fingerprint = payloadFingerprint(built.payload);
  if (fingerprint === lastClipboardFingerprint && source !== "manual") {
    return { ok: true, captured: false, reason: "duplicated" };
  }

const result = await createClipFromPayload(built.payload, source);
  if (result.ok && result.captured) {
    lastClipboardFingerprint = fingerprint;
    broadcastToWindows("clips:changed", { source, at: Date.now() });
  }
  return result;
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

const toggleMainWindow = () => {
  if (!mainWindow) {
    return { visible: false };
  }

  if (mainWindow.isVisible()) {
    mainWindow.hide();
    return { visible: false };
  }

  mainWindow.show();
  mainWindow.focus();
  return { visible: true };
};

const createMainWindow = async () => {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.bounds;

  mainWindow = new BrowserWindow({
    width,
    height,
    x: 0,
    y: 0,
    show: false,
    frame: false,
    icon: path.join(__dirname, "../assets/icon.svg"),
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
  const icon = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAQAAAC1QeVaAAAAKklEQVR42mP8z8DAwMgABYwMjAxwMDAwGGAAQzQwMDAA4hSYDKQdA4QAAJw3B8eEzWLWAAAAAElFTkSuQmCC"
  );

  tray = new Tray(icon);
  tray.setToolTip("paste");

  const contextMenu = Menu.buildFromTemplate([
    { label: "Show / Hide", click: () => toggleMainWindow() },
    { type: "separator" },
    {
      label: "Capture Clipboard Now",
      click: async () => {
        await captureClipboardNow("menu");
      }
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.isQuiting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.on("click", () => toggleMainWindow());
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

  try {
    const ok = globalShortcut.register(desired, () => {
      toggleMainWindow();
    });
    if (ok) {
      registeredHotkey = desired;
      return { ok: true, hotkey: desired, corrected: false };
    }
  } catch {
    // fall through to fallback
  }

  // Fallback to a known-good default if the configured accelerator is invalid.
  try {
    const ok = globalShortcut.register(defaultConfig.hotkey, () => {
      toggleMainWindow();
    });
    if (ok) {
      registeredHotkey = defaultConfig.hotkey;
      if (desired !== defaultConfig.hotkey) {
        return { ok: true, hotkey: defaultConfig.hotkey, corrected: true, message: `Invalid hotkey: ${desired}` };
      }
      return { ok: true, hotkey: defaultConfig.hotkey, corrected: false };
    }
  } catch {
    // ignore
  }

  return { ok: false, hotkey: null, corrected: false, message: "Failed to register global hotkey" };
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
  ipcMain.handle("config:get", async () => readConfig());

  ipcMain.handle("config:set", async (_, next) => {
    const merged = writeConfig(next || {});
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

  ipcMain.handle("clips:list", async (_, query = {}) => {
    const cfg = readConfig();
    if (!isRemoteEnabled(cfg)) {
      return localListClips(cfg, query);
    }

    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.favorite) params.set("favorite", "1");
    params.set("limit", "60");
    return remoteRequest(cfg, `/clips?${params.toString()}`);
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

      lastClipboardFingerprint = [
        text.slice(0, 160),
        html ? html.slice(0, 80) : "",
        imageDataUrl ? `img:${imageDataUrl.length}` : ""
      ].join("|");

      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "clipboard write failed"
      };
    }
  });

  ipcMain.handle("window:toggle", async () => toggleMainWindow());

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

  app.setName("paste");
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(readConfig().launchAtLogin) });
  } catch {
    // ignore
  }
  setupIpc();

  // Run a retention cleanup at startup in local mode.
  const cfg = readConfig();
  if (!isRemoteEnabled(cfg)) {
    writeLocalDb(cleanupLocalDb(cfg, readLocalDb()));
  }

  await createMainWindow();
  createTray();
  registerGlobalShortcut();
  startClipboardWatcher();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createMainWindow();
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
