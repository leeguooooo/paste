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

const MAX_IMAGE_DATA_URL_LENGTH = 1_500_000;

let mainWindow = null;
let tray = null;
let clipboardTimer = null;
let lastClipboardFingerprint = "";

const defaultConfig = {
  apiBase: "https://pasteapi.misonote.com/v1",
  userId: "mac_user_demo",
  deviceId: "macos_desktop",
  autoCapture: true
};

const readConfig = () => {
  try {
    if (!fs.existsSync(configFile)) {
      fs.writeFileSync(configFile, JSON.stringify(defaultConfig, null, 2));
      return { ...defaultConfig };
    }
    const parsed = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    return { ...defaultConfig, ...parsed };
  } catch {
    return { ...defaultConfig };
  }
};

const writeConfig = (next) => {
  const merged = { ...defaultConfig, ...next };
  fs.writeFileSync(configFile, JSON.stringify(merged, null, 2));
  return merged;
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
  return plain !== (text || "").trim() || /<img\b|<table\b|<a\b|<code\b|<pre\b/i.test(normalized);
};

const buildClipboardPayload = () => {
  const text = clipboard.readText().trim();
  const html = clipboard.readHTML().trim();
  const image = clipboard.readImage();
  const hasImage = !image.isEmpty();
  const richHtml = hasMeaningfulHtml(html, text) ? html : null;

  if (hasImage) {
    const dataUrl = image.toDataURL();
    if (dataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) {
      return {
        ok: false,
        captured: false,
        reason: `Image too large for current storage mode (${dataUrl.length} chars)`
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
        imageDataUrl: dataUrl,
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

const apiRequest = async (pathname, init = {}) => {
  const cfg = readConfig();
  const url = `${cfg.apiBase}${pathname}`;
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
  const body = {
    ...payload,
    tags: source === "watcher" ? ["auto"] : payload.tags || []
  };

  const res = await apiRequest("/clips", {
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
  }
  return result;
};

const positionPanelWindow = () => {
  if (!mainWindow) return;
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const bounds = mainWindow.getBounds();
  const width = Math.min(bounds.width, Math.floor(workArea.width * 0.94));
  const height = Math.min(bounds.height, Math.floor(workArea.height * 0.86));
  const x = Math.floor(workArea.x + (workArea.width - width) / 2);
  const y = Math.floor(workArea.y + workArea.height - height - 28);
  mainWindow.setBounds({ x, y, width, height });
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

  positionPanelWindow();
  mainWindow.show();
  mainWindow.focus();
  return { visible: true };
};

const createMainWindow = async () => {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 420, // Height reduced to look like a bar
    minWidth: 820,
    minHeight: 320,
    title: "paste",
    show: false,
    frame: false,
    transparent: true, // Keep transparent
    backgroundColor: "#00000000", // Fully transparent base
    hasShadow: false,
    resizable: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    visualEffectState: "active",
    vibrancy: "hud", // Premium macOS blur effect
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  positionPanelWindow();

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

const registerGlobalShortcut = () => {
  globalShortcut.register("CommandOrControl+Shift+V", () => {
    toggleMainWindow();
  });
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
    writeConfig(next || {});
    return { ok: true };
  });

  ipcMain.handle("clips:list", async (_, query = {}) => {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q);
    if (query.favorite) params.set("favorite", "1");
    params.set("limit", "60");
    return apiRequest(`/clips?${params.toString()}`);
  });

  ipcMain.handle("clips:create", async (_, payload) => {
    return apiRequest("/clips", {
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
    return apiRequest(`/clips/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        isFavorite,
        clientUpdatedAt: Date.now()
      })
    });
  });

  ipcMain.handle("clips:delete", async (_, id) => {
    return apiRequest(`/clips/${encodeURIComponent(id)}`, {
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
  setupIpc();
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
