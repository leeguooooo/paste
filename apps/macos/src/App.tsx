import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import type { ClipItem, ClipType } from "@paste/shared";
import { 
  Search, 
  Settings, 
  Star, 
  Trash2, 
  X,
  Link as LinkIcon,
  Image as ImageIcon,
  FileText,
  Code,
  ArrowRight,
  Copy,
  ExternalLink,
  Globe,
  Cpu,
  Monitor,
  Smartphone
} from "lucide-react";

type ClipCardItem = ClipItem & { __demo?: boolean };

type AppConfig = {
  apiBase: string;
  userId: string;
  deviceId: string;
  authGithubLogin: string;
  icloudSync: boolean;
  icloudAvailable: boolean;
  autoCapture: boolean;
  launchAtLogin: boolean;
  retention: "30d" | "180d" | "365d" | "forever";
  hotkey: string;
};

type AuthStatus = {
  remoteEnabled: boolean;
  authenticated: boolean;
  authConfigured: boolean;
  user: { userId: string; githubLogin: string; githubId?: number } | null;
};

type DeviceAuthSession = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string | null;
  retryAfterSec: number;
  startedAt: number;
};

const emptyConfig: AppConfig = {
  apiBase: "",
  userId: "mac_user_demo",
  deviceId: "macos_desktop",
  authGithubLogin: "",
  icloudSync: false,
  icloudAvailable: false,
  autoCapture: true,
  launchAtLogin: false,
  retention: "180d",
  hotkey: "CommandOrControl+Shift+V"
};

const htmlToText = (html?: string | null): string =>
  (html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const isValidImageDataUrl = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("data:image/");

const getPreviewDataUrl = (clip: ClipItem): string | null => {
  if (isValidImageDataUrl(clip.imagePreviewDataUrl)) return clip.imagePreviewDataUrl;
  if (isValidImageDataUrl(clip.imageDataUrl)) return clip.imageDataUrl;
  return null;
};

const getTypeAccent = (type: ClipType): string => {
  switch (type) {
    case "link": return "var(--accent-blue)";
    case "text": return "var(--accent-orange)";
    case "code": return "var(--accent-purple)";
    case "html": return "var(--accent-green)";
    case "image": return "var(--accent-pink)";
    default: return "var(--accent-gray)";
  }
};

const formatAgeShort = (createdAtMs: number): string => {
  const now = Date.now();
  const delta = Math.max(0, now - createdAtMs);
  if (delta < 60_000) return `${Math.max(1, Math.floor(delta / 1000))}s`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
};

const normalizeHttpUrl = (raw: string): string => {
  const s = String(raw || "").trim();
  if (!/^https?:\/\//i.test(s)) return s;
  try {
    const u = new URL(s);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    u.protocol = u.protocol.toLowerCase();
    if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) {
      u.port = "";
    }
    return u.toString();
  } catch {
    return s;
  }
};

const imageKeyFromClip = (c: ClipItem): string => {
  const url = typeof c.imageUrl === "string" ? c.imageUrl.trim() : "";
  if (url) {
    try {
      const u = new URL(url, window.location.origin);
      const h = u.searchParams.get("h");
      if (h) return `sha256:${h}`;
    } catch {
      // ignore
    }
  }

  const raw =
    (typeof c.imagePreviewDataUrl === "string" && c.imagePreviewDataUrl) ||
    (typeof c.imageDataUrl === "string" && c.imageDataUrl) ||
    "";
  if (!raw) return "";
  return `data:${raw.slice(0, 64)}:${raw.length}`;
};

const dedupeRecentItems = (items: ClipItem[]): ClipItem[] => {
  // Keep the newest occurrence; always keep favorites.
  // Use a time window to avoid deleting legitimate repeats far apart.
  const DEDUPE_WINDOW_MS = 10 * 60_000;
  const firstSeenAtByKey = new Map<string, number>();
  const out: ClipItem[] = [];

  const keyOf = (c: ClipItem): string => {
    const content = String(c.content || "").trim();
    const sourceUrl = String(c.sourceUrl || "").trim();

    if (
      c.type === "link" ||
      /^https?:\/\//i.test(content) ||
      /^https?:\/\//i.test(sourceUrl)
    ) {
      const url = normalizeHttpUrl(sourceUrl || content);
      return url ? `link:${url}` : "";
    }

    if (c.type === "image") {
      const imgKey = imageKeyFromClip(c);
      return imgKey ? `image:${imgKey}` : "";
    }

    // text/code/html: de-dupe by trimmed content (and html when present).
    const html = String(c.contentHtml || "").trim();
    const normText = content.replace(/\s+/g, " ").slice(0, 500);
    const normHtml = html ? html.replace(/\s+/g, " ").slice(0, 500) : "";
    if (!normText && !normHtml) return "";
    return `${c.type}:${normText}:${normHtml}`;
  };

  for (const c of items) {
    if (c.isFavorite) {
      out.push(c);
      continue;
    }

    const key = keyOf(c);
    if (!key) {
      out.push(c);
      continue;
    }

    const at = Number.isFinite(c.createdAt) ? c.createdAt : 0;
    const seenAt = firstSeenAtByKey.get(key);
    if (seenAt !== undefined && Math.abs(seenAt - at) <= DEDUPE_WINDOW_MS) {
      continue;
    }
    firstSeenAtByKey.set(key, at);
    out.push(c);
  }

  return out;
};

const collapseConsecutiveDuplicates = (items: ClipItem[]): ClipItem[] => {
  // List results are newest-first. Collapse accidental duplicate runs created by
  // watcher/self-capture loops.
  const WINDOW_MS = 60_000;
  const keyOf = (c: ClipItem): string => {
    const content = (c.content || "").trim().slice(0, 200);
    const html = (c.contentHtml || "").trim().slice(0, 200);
    const src = (c.sourceUrl || "").trim();
    const imgRaw =
      (typeof c.imageUrl === "string" && c.imageUrl.trim()) ||
      (typeof c.imagePreviewDataUrl === "string" && c.imagePreviewDataUrl) ||
      (typeof c.imageDataUrl === "string" && c.imageDataUrl) ||
      "";
    const img = imgRaw ? `${imgRaw.slice(0, 64)}:${imgRaw.length}` : "";
    return [c.type, content, src, html, img].join("|");
  };

  const out: ClipItem[] = [];
  let run: ClipItem[] = [];
  let runKey = "";

  const flush = () => {
    if (run.length === 0) return;
    const pick = run.find((c) => c.isFavorite) || run[0];
    out.push(pick);
    run = [];
    runKey = "";
  };

  for (const item of items) {
    const k = keyOf(item);
    if (run.length === 0) {
      run = [item];
      runKey = k;
      continue;
    }
    const prev = run[0];
    const closeEnough = Math.abs((prev.createdAt ?? 0) - (item.createdAt ?? 0)) <= WINDOW_MS;
    if (k && k === runKey && closeEnough) {
      run.push(item);
      continue;
    }
    flush();
    run = [item];
    runKey = k;
  }
  flush();
  return out;
};

const DEMO_SVG_DATA_URL =
  "data:image/svg+xml;base64," +
  btoa(
    `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="240" viewBox="0 0 360 240">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#007aff"/>
          <stop offset="1" stop-color="#af52de"/>
        </linearGradient>
      </defs>
      <rect width="360" height="240" rx="28" fill="#0b0b0b"/>
      <rect x="18" y="18" width="324" height="204" rx="22" fill="url(#g)" opacity="0.35"/>
      <rect x="34" y="38" width="292" height="40" rx="14" fill="rgba(255,255,255,0.14)"/>
      <rect x="34" y="92" width="220" height="16" rx="8" fill="rgba(255,255,255,0.20)"/>
      <rect x="34" y="118" width="260" height="16" rx="8" fill="rgba(255,255,255,0.16)"/>
      <rect x="34" y="144" width="190" height="16" rx="8" fill="rgba(255,255,255,0.12)"/>
      <text x="44" y="64" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto" font-size="16" fill="rgba(255,255,255,0.92)" font-weight="700">Pastyx Demo</text>
    </svg>`
  );

const makeDemoClips = (userId: string, deviceId: string): ClipCardItem[] => {
  const now = Date.now();
  const base = {
    userId,
    deviceId,
    isFavorite: false,
    isDeleted: false,
    tags: [],
    clientUpdatedAt: now,
    serverUpdatedAt: now,
  };

  return [
    {
      ...base,
      __demo: true,
      id: "demo:text",
      type: "text",
      summary: "欢迎使用 Pastyx",
      content: "欢迎使用 Pastyx。点击任意卡片可复制示例内容。",
      createdAt: now - 9_000,
    },
    {
      ...base,
      __demo: true,
      id: "demo:link",
      type: "link",
      summary: "链接示例",
      content: "https://github.com/leeguooooo/paste",
      sourceUrl: "https://github.com/leeguooooo/paste",
      createdAt: now - 32_000,
    },
    {
      ...base,
      __demo: true,
      id: "demo:code",
      type: "code",
      summary: "代码片段",
      content: "curl -sS https://pasteapi.misonote.com/v1/health",
      createdAt: now - 56_000,
    },
    {
      ...base,
      __demo: true,
      id: "demo:html",
      type: "html",
      summary: "HTML 示例",
      content: "<strong>Pastyx</strong> is local-first.",
      contentHtml: "<strong>Pastyx</strong> is local-first.",
      createdAt: now - 120_000,
    },
    {
      ...base,
      __demo: true,
      id: "demo:image",
      type: "image",
      summary: "图片示例",
      content: "Pastyx demo image",
      imagePreviewDataUrl: DEMO_SVG_DATA_URL,
      imageDataUrl: DEMO_SVG_DATA_URL,
      createdAt: now - 240_000,
    },
  ];
};

export default function App() {
  const [config, setConfig] = useState<AppConfig>(emptyConfig);
  const [authStatus, setAuthStatus] = useState<AuthStatus>({
    remoteEnabled: false,
    authenticated: false,
    authConfigured: false,
    user: null
  });
  const [authLoading, setAuthLoading] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const [localSyncPendingCount, setLocalSyncPendingCount] = useState(0);
  const [localSyncLoading, setLocalSyncLoading] = useState(false);
  const [deviceAuthSession, setDeviceAuthSession] = useState<DeviceAuthSession | null>(null);
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0); 
  const [showSettings, setShowSettings] = useState(false);
  const [settingsBackdropDataUrl, setSettingsBackdropDataUrl] = useState<string | null>(null);
  
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const windowVisibleRef = useRef(false);
  const refreshTimerRef = useRef<number | null>(null);
  const selectionReasonRef = useRef<"keyboard" | "hover" | "click" | "other">("other");
  const hoverRafRef = useRef<number | null>(null);
  const hoverPendingIndexRef = useRef<number | null>(null);
  const authPollTimerRef = useRef<number | null>(null);

  const previewTextById = useMemo(() => {
    const map = new Map<string, string>();
    for (const clip of clips) {
      if (!clip?.id) continue;
      const text = clip.contentHtml ? htmlToText(clip.contentHtml) : clip.content;
      map.set(clip.id, (text || "").slice(0, 300));
    }
    return map;
  }, [clips]);

  const loadConfig = async () => {
    try {
      const next = await window.macos.getConfig();
      setConfig({
        ...emptyConfig,
        ...next,
        icloudSync: Boolean(next?.icloudSync),
        icloudAvailable: Boolean(next?.icloudAvailable)
      });
    } catch (e) { console.error(e); }
  };

  const toConfigPayload = useCallback((cfg: AppConfig) => ({
    apiBase: cfg.apiBase,
    userId: cfg.userId,
    deviceId: cfg.deviceId,
    authGithubLogin: cfg.authGithubLogin,
    icloudSync: cfg.icloudSync,
    autoCapture: cfg.autoCapture,
    launchAtLogin: cfg.launchAtLogin,
    retention: cfg.retention,
    hotkey: cfg.hotkey
  }), []);

  const loadClips = useCallback(async (isInitial = false) => {
    if (isInitial) setLoading(true);
    try {
      const res = await window.macos.listClips({ q: query || undefined, favorite: favoriteOnly || undefined });
      if (res?.ok) {
        const nextItems = dedupeRecentItems(collapseConsecutiveDuplicates(res.data.items ?? []));
        setClips(nextItems);
        setSelectedIndex((prev) =>
          isInitial ? 0 : Math.min(prev, Math.max(0, nextItems.length - 1))
        );
      }
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [query, favoriteOnly]);

  const clearAuthPollTimer = useCallback(() => {
    if (authPollTimerRef.current) {
      window.clearTimeout(authPollTimerRef.current);
      authPollTimerRef.current = null;
    }
  }, []);

  const loadAuthStatus = useCallback(async () => {
    try {
      const res = await window.macos.getAuthStatus();
      if (res?.ok && res.data) {
        setAuthStatus({
          remoteEnabled: Boolean(res.data.remoteEnabled),
          authenticated: Boolean(res.data.authenticated),
          authConfigured: Boolean(res.data.authConfigured),
          user: res.data.user
            ? {
                userId: String(res.data.user.userId || ""),
                githubLogin: String(res.data.user.githubLogin || ""),
                githubId: Number(res.data.user.githubId || 0)
              }
            : null
        });
        return;
      }
      setAuthStatus((prev) => ({
        ...prev,
        authenticated: false,
        user: null
      }));
    } catch (e) {
      console.error(e);
      setAuthStatus((prev) => ({
        ...prev,
        authenticated: false,
        user: null
      }));
    }
  }, []);

  const loadLocalSyncStatus = useCallback(async () => {
    try {
      const res = await window.macos.getLocalSyncStatus();
      if (res?.ok && res.data) {
        setLocalSyncPendingCount(Math.max(0, Number(res.data.pendingCount || 0)));
        return;
      }
      setLocalSyncPendingCount(0);
    } catch {
      setLocalSyncPendingCount(0);
    }
  }, []);

  const pollDeviceAuth = useCallback(async (deviceCode: string) => {
    const code = String(deviceCode || "").trim();
    if (!code) return;
    try {
      const res = await window.macos.pollGithubDeviceAuth(code);
      if (res?.ok && res?.data?.status === "pending") {
        const nextSec = Number(res?.data?.retryAfterSec || 5);
        setAuthMessage("Waiting for GitHub authorization...");
        authPollTimerRef.current = window.setTimeout(() => {
          void pollDeviceAuth(code);
        }, Math.max(2, nextSec) * 1000);
        return;
      }
      if (res?.ok && res?.data?.status === "approved") {
        clearAuthPollTimer();
        setDeviceAuthSession(null);
        setAuthMessage("Signed in with GitHub.");
        await loadConfig();
        await loadAuthStatus();
        await loadLocalSyncStatus();
        void loadClips(true);
        return;
      }
      if (res?.ok && res?.data?.status === "denied") {
        clearAuthPollTimer();
        setDeviceAuthSession(null);
        setAuthMessage(String(res?.data?.message || "Authorization denied."));
        await loadAuthStatus();
        return;
      }
      clearAuthPollTimer();
      setDeviceAuthSession(null);
      setAuthMessage(String(res?.message || "GitHub auth failed."));
    } catch (e) {
      clearAuthPollTimer();
      setDeviceAuthSession(null);
      setAuthMessage(e instanceof Error ? e.message : "GitHub auth failed.");
    }
  }, [clearAuthPollTimer, loadAuthStatus, loadClips, loadLocalSyncStatus]);

  const startGithubAuth = useCallback(async () => {
    setAuthLoading(true);
    setAuthMessage("");
    clearAuthPollTimer();
    try {
      const draftApiBase = String(config.apiBase || "").trim();
      if (!/^https?:\/\//i.test(draftApiBase)) {
        setAuthMessage("Please set a valid API Endpoint first.");
        return;
      }

      const effectiveUserIdForSave = authStatus.user?.userId || config.userId;
      const persistPayload = authStatus.authenticated
        ? {
            ...toConfigPayload(config),
            userId: effectiveUserIdForSave,
            authGithubLogin: authStatus.user?.githubLogin || config.authGithubLogin
          }
        : toConfigPayload(config);
      const saveRes = await window.macos.setConfig(persistPayload);
      if (!saveRes?.ok) {
        setAuthMessage(String(saveRes?.message || "Failed to save API settings."));
        return;
      }

      await loadConfig();
      await loadAuthStatus();

      const res = await window.macos.startGithubDeviceAuth();
      if (!res?.ok) {
        setAuthMessage(String(res?.message || "Failed to start GitHub auth."));
        return;
      }
      const data = res?.data || {};
      const deviceCode = String(data.deviceCode || "").trim();
      const userCode = String(data.userCode || "").trim();
      const verificationUri = String(data.verificationUri || "").trim();
      const verificationUriComplete = data.verificationUriComplete ? String(data.verificationUriComplete) : null;
      if (!deviceCode || !userCode || !verificationUri) {
        setAuthMessage("GitHub auth payload is invalid.");
        return;
      }

      const retryAfterSec = Math.max(2, Number(data.interval || 5));
      setDeviceAuthSession({
        deviceCode,
        userCode,
        verificationUri,
        verificationUriComplete,
        retryAfterSec,
        startedAt: Date.now()
      });
      setAuthMessage("Browser opened. If not, click Open GitHub below.");
      authPollTimerRef.current = window.setTimeout(() => {
        void pollDeviceAuth(deviceCode);
      }, retryAfterSec * 1000);
    } catch (e) {
      setAuthMessage(e instanceof Error ? e.message : "Failed to start GitHub auth.");
    } finally {
      setAuthLoading(false);
    }
  }, [authStatus.authenticated, authStatus.user, clearAuthPollTimer, config, loadAuthStatus, pollDeviceAuth, toConfigPayload]);

  const logoutGithubAuth = useCallback(async () => {
    setAuthLoading(true);
    setAuthMessage("");
    clearAuthPollTimer();
    try {
      const res = await window.macos.logoutAuth();
      if (!res?.ok) {
        setAuthMessage(String(res?.message || "Sign out failed."));
        return;
      }
      setDeviceAuthSession(null);
      setAuthMessage("Signed out.");
      setLocalSyncPendingCount(0);
      await loadConfig();
      await loadAuthStatus();
      void loadClips(true);
    } catch (e) {
      setAuthMessage(e instanceof Error ? e.message : "Sign out failed.");
    } finally {
      setAuthLoading(false);
    }
  }, [clearAuthPollTimer, loadAuthStatus, loadClips]);

  const syncLocalHistoryNow = useCallback(async () => {
    setLocalSyncLoading(true);
    try {
      const res = await window.macos.runLocalSync();
      if (!res?.ok || !res?.data) {
        setAuthMessage(String(res?.message || "Failed to sync local history."));
        return;
      }
      const { total, uploaded, failed } = res.data;
      if (failed > 0) {
        setAuthMessage(`Synced ${uploaded}/${total}. ${failed} items failed. You can retry.`);
      } else {
        setAuthMessage(`Synced ${uploaded} local clips to cloud.`);
      }
      await loadLocalSyncStatus();
      void loadClips(true);
    } catch (e) {
      setAuthMessage(e instanceof Error ? e.message : "Failed to sync local history.");
    } finally {
      setLocalSyncLoading(false);
    }
  }, [loadClips, loadLocalSyncStatus]);

  const dismissLocalSyncPrompt = useCallback(async () => {
    setLocalSyncLoading(true);
    try {
      const res = await window.macos.dismissLocalSync();
      if (!res?.ok) {
        setAuthMessage(String(res?.message || "Failed to update sync preference."));
        return;
      }
      setLocalSyncPendingCount(0);
      setAuthMessage("Skipped local history sync.");
    } catch (e) {
      setAuthMessage(e instanceof Error ? e.message : "Failed to update sync preference.");
    } finally {
      setLocalSyncLoading(false);
    }
  }, []);

  const copyText = useCallback(async (raw: string, label: string) => {
    const text = String(raw || "").trim();
    if (!text) return;
    try {
      const res = await window.macos.writeClipboard(text);
      if (res?.ok) {
        setAuthMessage(`${label} copied.`);
        return;
      }
    } catch {
      // ignore and fallback
    }

    try {
      await navigator.clipboard.writeText(text);
      setAuthMessage(`${label} copied.`);
    } catch (e) {
      setAuthMessage(e instanceof Error ? e.message : `Failed to copy ${label.toLowerCase()}.`);
    }
  }, []);

  const openGithubVerificationPage = useCallback(async () => {
    const url = String(
      deviceAuthSession?.verificationUriComplete || deviceAuthSession?.verificationUri || ""
    ).trim();
    if (!url) return;
    try {
      const res = await window.macos.openExternal(url);
      if (!res?.ok) {
        setAuthMessage(String(res?.message || "Failed to open GitHub page."));
      }
    } catch (e) {
      setAuthMessage(e instanceof Error ? e.message : "Failed to open GitHub page.");
    }
  }, [deviceAuthSession]);

  useEffect(() => {
    void loadConfig();
    void loadAuthStatus();
    void loadClips(true);
  }, [loadAuthStatus, loadClips]);

  useEffect(() => {
    if (!authStatus.authenticated) {
      setLocalSyncPendingCount(0);
      return;
    }
    void loadLocalSyncStatus();
  }, [authStatus.authenticated, loadLocalSyncStatus]);

  useEffect(() => () => {
    clearAuthPollTimer();
  }, [clearAuthPollTimer]);

  useEffect(() => {
    const off = window.macos.onOpenSettings?.(() => {
      void openSettings();
    });
    return () => {
      try {
        off?.();
      } catch {
        // ignore
      }
    };
  }, []);

  useEffect(() => {
    const scheduleRefresh = () => {
      if (!windowVisibleRef.current) {
        return;
      }
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
      }
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        void loadClips();
      }, 120);
    };

    // Main process captures clipboard even when the window is hidden. Avoid hitting
    // IPC/network while hidden; refresh when shown (or while visible).
    const offChanged = window.macos.onClipsChanged?.(() => {
      scheduleRefresh();
    });

    const offShown = window.macos.onWindowShown?.(() => {
      windowVisibleRef.current = true;
      scheduleRefresh();
      if (!query && !showSettings) {
        setSelectedIndex(0);
      }
    });

    const offHidden = window.macos.onWindowHidden?.(() => {
      windowVisibleRef.current = false;
    });

    const onFocus = () => scheduleRefresh();
    window.addEventListener("focus", onFocus);

    return () => {
      try { offChanged?.(); } catch {}
      try { offShown?.(); } catch {}
      try { offHidden?.(); } catch {}
      window.removeEventListener("focus", onFocus);
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      if (hoverRafRef.current) {
        window.cancelAnimationFrame(hoverRafRef.current);
        hoverRafRef.current = null;
      }
    };
  }, [loadClips, query, showSettings]);

  const openSettings = useCallback(async () => {
    if (showSettings) return;
    setSettingsBackdropDataUrl(null);

    try {
      const res = await window.macos.captureWindow();
      if (res?.ok && typeof res.dataUrl === "string" && res.dataUrl.startsWith("data:image/")) {
        setSettingsBackdropDataUrl(res.dataUrl);
      }
    } catch {
      // ignore; settings will still open (without frozen backdrop)
    } finally {
      setShowSettings(true);
    }
  }, [showSettings]);

  const closeSettings = useCallback(() => {
    setShowSettings(false);
    setSettingsBackdropDataUrl(null);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void loadClips(), 150);
    return () => clearTimeout(timer);
  }, [query, favoriteOnly, loadClips]);

  const formatDateTime = (createdAtMs: number): string => {
    const n = Number(createdAtMs);
    if (!Number.isFinite(n) || n <= 0) return "";
    try {
      return new Date(n).toLocaleString();
    } catch {
      return "";
    }
  };

  useEffect(() => {
    if (clips.length > 0 && selectedIndex >= clips.length) {
      setSelectedIndex(clips.length - 1);
    }
  }, [clips.length, selectedIndex]);

  // Remote list uses lite mode; fetch full clip on-demand for images (preview/copy).
  useEffect(() => {
    const clip = clips[selectedIndex];
    if (!clip) return;
    if (clip.type !== "image") return;
    if (getPreviewDataUrl(clip)) return;

    let cancelled = false;
    void (async () => {
      try {
        const res = await window.macos.getClip(clip.id);
        if (cancelled) return;
        if (res?.ok && res.data) {
          setClips((prev) => prev.map((c) => (c.id === clip.id ? { ...c, ...res.data } : c)));
        }
      } catch {
        // ignore
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [clips, selectedIndex]);

  // --- Smart Scroll Synchronization ---
  useEffect(() => {
    if (!scrollContainerRef.current || clips.length === 0) return;
    const container = scrollContainerRef.current;
    const cardWidth = 280; // --card-width
    const gap = 28; // --gap
    const padding = 80; // container padding-left/right
    
    const containerWidth = container.clientWidth;
    const scrollLeft = container.scrollLeft;
    
    // 当前卡片相对于容器左侧的绝对位置
    const cardLeftPos = padding + selectedIndex * (cardWidth + gap);
    const cardRightPos = cardLeftPos + cardWidth;

    // 可见区域的边界
    const viewLeft = scrollLeft;
    const viewRight = scrollLeft + containerWidth;

    // 如果卡片超出了右边界（或者离右边太近了，预留一点边距）
    if (cardRightPos > viewRight - padding) {
      container.scrollTo({
        left: cardRightPos - containerWidth + padding,
        behavior: selectionReasonRef.current === "hover" ? "auto" : "smooth"
      });
    } 
    // 如果卡片超出了左边界
    else if (cardLeftPos < viewLeft + padding) {
      container.scrollTo({
        left: cardLeftPos - padding,
        behavior: selectionReasonRef.current === "hover" ? "auto" : "smooth"
      });
    }
  }, [selectedIndex, clips.length]);

		  const handleCopy = async (clip: ClipItem) => {
		    let effective = clip;
    if (
      clip.type === "image" &&
      !isValidImageDataUrl(clip.imageDataUrl) &&
      !(typeof clip.imageUrl === "string" && clip.imageUrl.trim())
    ) {
      try {
        const res = await window.macos.getClip(clip.id);
        if (res?.ok && res.data) {
          effective = res.data;
          setClips((prev) => prev.map((c) => (c.id === clip.id ? { ...c, ...res.data } : c)));
        }
      } catch {
        // ignore
      }
    }

	    // For link clips, use the URL as the plain-text fallback so pasting into
	    // non-rich-text fields still produces a usable link.
	    const text =
	      effective.type === "link" && typeof effective.sourceUrl === "string" && effective.sourceUrl.trim()
	        ? effective.sourceUrl.trim()
	        : (effective.content || effective.sourceUrl || "");
	    const res = await window.macos.pasteAndHide({
	      text,
	      html: effective.contentHtml ?? null,
	      imageDataUrl: effective.imageDataUrl ?? null,
	      imageUrl: effective.imageUrl ?? null
    });
	    if (!res?.ok) {
	      // Surface the root error (most commonly missing Accessibility permission).
	      alert(res?.message || "Pastyx failed");
	    }
	  };

    const handleCopyPlainText = async (clip: ClipItem) => {
      const text =
        clip.type === "link" && typeof clip.sourceUrl === "string" && clip.sourceUrl.trim()
          ? clip.sourceUrl.trim()
          : (clip.content || clip.sourceUrl || "");

      const res = await window.macos.pasteAndHide({
        text,
        html: null,
        imageDataUrl: null,
        imageUrl: null
      });
      if (!res?.ok) {
        alert(res?.message || "Pastyx failed");
      }
    };

  const handleCopyDemo = async (clip: ClipCardItem) => {
    // For the empty state demo cards, don't hide the window or paste into another app.
    // Just copy into the system clipboard so the user can try Cmd+V anywhere.
    const value =
      clip.type === "image"
        ? { text: clip.content, imageDataUrl: clip.imageDataUrl ?? clip.imagePreviewDataUrl ?? null }
        : { text: clip.content, html: clip.contentHtml ?? null };

    const res = await window.macos.writeClipboard(value);
    if (!res?.ok) {
      alert(res?.message || "Copy failed");
    }
  };

  const handleDelete = async (id: string) => {
    const res = await window.macos.deleteClip(id);
    if (res?.ok) {
      setClips(prev => prev.filter(c => c.id !== id));
      if (selectedIndex >= clips.length - 1) {
        setSelectedIndex(Math.max(0, clips.length - 2));
      }
    }
  };

  const handleToggleFavorite = async (clip: ClipItem) => {
    const res = await window.macos.toggleFavorite(clip.id, !clip.isFavorite);
    if (res?.ok) {
      setClips(prev => prev.map(c => c.id === clip.id ? { ...c, isFavorite: !c.isFavorite } : c));
    }
  };

			  useEffect(() => {
			    const handleKeyDown = (e: KeyboardEvent) => {
			      if (showSettings) return;
            // In-window quick paste: Cmd+1~Cmd+9
            if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
              const idx = Number(e.key) - 1;
              const target = clips[idx] as ClipCardItem | undefined;
              if (target) {
                e.preventDefault();
                if ((target as any).__demo) {
                  void handleCopyDemo(target as any);
                } else {
                  void handleCopy(target);
                }
              }
              return;
            }
			      switch (e.key) {
			        case "ArrowRight":
			          e.preventDefault();
			          selectionReasonRef.current = "keyboard";
			          setSelectedIndex(prev => Math.min(prev + 1, clips.length - 1));
			          break;
			        case "ArrowLeft":
			          e.preventDefault();
			          selectionReasonRef.current = "keyboard";
			          setSelectedIndex(prev => Math.max(prev - 1, 0));
			          break;
			        case "Enter":
			          e.preventDefault();
			          if (clips[selectedIndex]) {
                  if (e.shiftKey) {
                    void handleCopyPlainText(clips[selectedIndex]);
                  } else {
                    void handleCopy(clips[selectedIndex]);
                  }
			          }
			          break;
        case "Escape":
          e.preventDefault();
          if (query) {
            setQuery("");
          } else {
            void window.macos.toggleWindow();
          }
          break;
        case "Backspace":
        case "Delete":
          if (document.activeElement !== searchInputRef.current && clips[selectedIndex]) {
            e.preventDefault();
            void handleDelete(clips[selectedIndex].id);
          }
          break;
        case ",":
          if (e.metaKey) {
            e.preventDefault();
            void openSettings();
          }
          break;
        default:
          if (
            e.key.length === 1 && 
            !e.metaKey && 
            !e.ctrlKey && 
            !e.altKey && 
            document.activeElement !== searchInputRef.current
          ) {
            searchInputRef.current?.focus();
          }
          break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [clips, selectedIndex, showSettings, query, openSettings]);

  const setSelectedIndexFromHover = useCallback((index: number) => {
    selectionReasonRef.current = "hover";
    hoverPendingIndexRef.current = index;
    if (hoverRafRef.current != null) return;
    hoverRafRef.current = window.requestAnimationFrame(() => {
      hoverRafRef.current = null;
      const nextIndex = hoverPendingIndexRef.current;
      if (nextIndex == null) return;
      setSelectedIndex((prev) => (prev === nextIndex ? prev : nextIndex));
    });
  }, []);

  const getIcon = (type: string) => {
    switch (type) {
      case 'link': return <LinkIcon size={12} />;
      case 'image': return <ImageIcon size={12} />;
      case 'code': return <Code size={12} />;
      default: return <FileText size={12} />;
    }
  };

  const getDeviceMeta = (deviceId: string): { icon: React.ReactNode; label: string } => {
    const raw = String(deviceId || "").trim();
    const lower = raw.toLowerCase();

    if (lower.includes("web") || lower.includes("browser")) {
      return { icon: <Globe size={12} />, label: "WEB" };
    }
    if (lower.includes("mac")) {
      return { icon: <Monitor size={12} />, label: "MAC" };
    }
    if (lower.includes("ios") || lower.includes("iphone") || lower.includes("ipad")) {
      return { icon: <Smartphone size={12} />, label: "IOS" };
    }
    if (lower.includes("android")) {
      return { icon: <Smartphone size={12} />, label: "ANDROID" };
    }
    if (raw) {
      const cleaned = raw.replace(/[_-]+/g, " ").trim();
      const short = cleaned.length > 14 ? `${cleaned.slice(0, 14)}...` : cleaned;
      return { icon: <Cpu size={12} />, label: short.toUpperCase() };
    }
    return { icon: <Cpu size={12} />, label: "DEVICE" };
  };

  const renderPreview = (clip: ClipItem) => {
    const preview = getPreviewDataUrl(clip);
    if (preview) {
      return <img src={preview} className="clip-image-preview" alt="preview" draggable={false} loading="lazy" />;
    }
    return <div className="preview-text">{previewTextById.get(clip.id) ?? ""}</div>;
  };

  const effectiveUserId = authStatus.user?.userId || config.userId;
  const showDemo = !favoriteOnly && !loading && clips.length === 0 && query.trim() === "";
  const visibleClips: ClipCardItem[] = showDemo ? makeDemoClips(effectiveUserId, config.deviceId) : clips;

  const saveConfig = async () => {
    const payload = authStatus.authenticated
      ? {
          ...toConfigPayload(config),
          userId: effectiveUserId,
          authGithubLogin: authStatus.user?.githubLogin || config.authGithubLogin
        }
      : toConfigPayload(config);
    const res = await window.macos.setConfig(payload);
    if (res.ok) {
      if (res.message) {
        alert(res.message);
      }
      setShowSettings(false);
      await loadConfig();
      await loadAuthStatus();
      void loadClips();
      return;
    }
    alert(res?.message || "Failed to save settings");
  };

  const resetDeviceId = () => {
    const next =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? `mac_${crypto.randomUUID().slice(0, 8)}`
        : `mac_${Math.random().toString(36).slice(2, 10)}`;
    setConfig((prev) => ({ ...prev, deviceId: next }));
  };

  return (
    <main 
      className={`app-shell ${clips.length > 0 ? 'active' : ''} ${showSettings ? 'settings-open' : ''}`} 
      onClick={async (e) => {
        if (e.target === e.currentTarget) {
          await window.macos.toggleWindow();
        }
      }}
    >
	      <div className="history-shelf" onClick={e => e.stopPropagation()}>
	        <div className="toolbar">
	          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 12 }}>
	            <div style={{ position: 'relative' }}>
	              <Search 
	                size={20} 
	                style={{ position: 'absolute', left: 16, top: 14, color: 'rgba(255,255,255,0.3)' }} 
	              />
	              <input
	                ref={searchInputRef}
	                className="search-input"
	                placeholder="Type to search history..."
	                value={query}
	                onChange={(e) => setQuery(e.target.value)}
	                onKeyDown={(e) => { if(e.key === 'Escape' || e.key === 'Enter') e.currentTarget.blur(); }}
	                autoFocus
	              />
	            </div>
              <button
                className="icon-btn"
                onClick={() => setFavoriteOnly((v) => !v)}
                style={{ padding: '10px', background: favoriteOnly ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.05)', borderRadius: '12px' }}
                title={favoriteOnly ? "Showing favorites (click to show all)" : "Show favorites only"}
                type="button"
              >
                <Star size={22} fill={favoriteOnly ? "currentColor" : "transparent"} />
              </button>
	            <button 
	              className="icon-btn" 
	              onClick={() => void openSettings()}
	              style={{ padding: '10px', background: 'rgba(255,255,255,0.05)', borderRadius: '12px' }}
	              title="Settings (Cmd+,)"
	            >
	              <Settings size={22} />
	            </button>
	          </div>
	        </div>

        <div className="history-container" ref={scrollContainerRef}>
	          {visibleClips.map((clip, index) => {
	            const isSelected = index === selectedIndex;
	            const device = getDeviceMeta(clip.deviceId);
	            const accent = getTypeAccent(clip.type);
	            const age = formatAgeShort(clip.createdAt);
              const fullTime = formatDateTime(clip.createdAt);
	            const cardStyle = { ["--accent" as any]: accent } as React.CSSProperties;
	            return (
              <div 
                key={clip.id} 
                className={`clip-card ${isSelected ? 'selected' : ''}`}
                data-type={clip.type}
                style={cardStyle}
                onMouseEnter={() => {
                  setSelectedIndexFromHover(index);
                }}
                onClick={() => {
                  selectionReasonRef.current = "click";
                  setSelectedIndex(index);
                  if (clip.__demo) {
                    void handleCopyDemo(clip);
                    return;
                  }
                  void handleCopy(clip);
                }}
              >
	                <div className="clip-head">
	                  <div className="clip-head-left">
	                    <span className="clip-type-pill">{clip.type}</span>
	                    <span className="clip-age" title={fullTime}>{age}</span>
	                  </div>
                  {!clip.__demo && (
                    <div className="clip-head-right" onClick={(e) => e.stopPropagation()}>
                      <button
                        className={`clip-fav ${clip.isFavorite ? "on" : ""}`}
                        aria-label={clip.isFavorite ? "Unfavorite" : "Favorite"}
                        onClick={(e) => { e.stopPropagation(); void handleToggleFavorite(clip); }}
                        type="button"
                        title="Favorite"
                      >
                        <Star size={14} fill={clip.isFavorite ? "currentColor" : "transparent"} />
                      </button>
                    </div>
                  )}
                </div>
                <div className="clip-preview">
                  {renderPreview(clip)}
                </div>
                
                <div className="clip-footer">
                  <div className="clip-device" title={clip.deviceId}>
                    {device.icon}
                    <span>{device.label}</span>
                  </div>
                  <div className="clip-hint">
                    {clip.__demo ? "Click to copy" : (isSelected ? "ENTER" : "Click to paste")}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {showSettings && (
        <div className="settings-overlay" onClick={closeSettings}>
          {settingsBackdropDataUrl && (
            <img
              className="settings-backdrop"
              src={settingsBackdropDataUrl}
              alt=""
              aria-hidden="true"
              draggable={false}
            />
          )}
          <div className="settings-scrim" aria-hidden="true" />
          <div className="settings-panel" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
              <h2 style={{ margin: 0 }}>Preferences</h2>
              <button className="icon-btn" onClick={closeSettings}>
                <X size={24} />
              </button>
            </div>
            
	            <div className="settings-section">
	              <div className="settings-section-title">
	                <Globe size={12} /> Connection
	              </div>
		              <div className="settings-row">
			                <label>API Endpoint</label>
			                <input
                  type="text"
                  placeholder="https://api.example.com/v1"
                  value={config.apiBase}
                  onChange={e => setConfig({ ...config, apiBase: e.target.value })}
                />
              </div>
              <div className="settings-row">
                <label>iCloud Drive Sync (No API)</label>
                <div className="checkbox-row" style={{ marginTop: 0 }}>
                  <input
                    type="checkbox"
                    checked={config.icloudSync}
                    disabled={!config.icloudAvailable}
                    onChange={e => setConfig({ ...config, icloudSync: e.target.checked })}
                  />
                  Enable iCloud sync in local mode
                </div>
                {!config.icloudAvailable ? (
                  <div className="auth-message">
                    iCloud Drive is unavailable. Turn on iCloud Drive in macOS Settings first.
                  </div>
                ) : null}
                {config.icloudSync ? (
                  <div className="auth-device-hint">
                    Keep API Endpoint empty to use local + iCloud Drive sync only.
                  </div>
                ) : null}
              </div>
              <div className="settings-row">
                <label>GitHub Auth</label>
                {authStatus.authenticated && authStatus.user ? (
                  <div className="inline-field-actions">
                    <span className="status-badge">@{authStatus.user.githubLogin}</span>
                    <button
                      className="btn-cancel"
                      type="button"
                      onClick={() => void logoutGithubAuth()}
                      disabled={authLoading}
                    >
                      {authLoading ? "..." : "Sign out"}
                    </button>
                  </div>
                ) : (
                  <button
                    className="btn-save"
                    type="button"
                    onClick={() => void startGithubAuth()}
                    disabled={authLoading || !/^https?:\/\//i.test(String(config.apiBase || "").trim())}
                  >
                    {!/^https?:\/\//i.test(String(config.apiBase || "").trim())
                      ? "Set API first"
                      : (authLoading ? "Starting..." : "Sign in with GitHub")}
                  </button>
                )}
              </div>
              {deviceAuthSession && (
                <div className="auth-device-box">
                  <div className="auth-device-title">Authorize this device</div>
                  <div className="auth-device-code" title={deviceAuthSession.userCode}>
                    {deviceAuthSession.userCode}
                  </div>
                  <div className="auth-device-actions">
                    <button className="btn-save" type="button" onClick={() => void openGithubVerificationPage()}>
                      <ExternalLink size={14} />
                      Open GitHub
                    </button>
                    <button
                      className="btn-cancel"
                      type="button"
                      onClick={() => void copyText(deviceAuthSession.userCode, "Code")}
                    >
                      <Copy size={14} />
                      Copy code
                    </button>
                  </div>
                  <div className="auth-device-hint">
                    If GitHub page does not auto-open, use Open GitHub above.
                  </div>
                </div>
              )}
              {authMessage ? (
                <div className="auth-message">{authMessage}</div>
              ) : null}
              {authStatus.authenticated && localSyncPendingCount > 0 ? (
                <div className="auth-device-box">
                  <div className="auth-device-title">Sync local history to cloud?</div>
                  <div className="auth-device-hint">
                    Found {localSyncPendingCount} local clips captured before sign-in.
                  </div>
                  <div className="auth-device-actions">
                    <button
                      className="btn-save"
                      type="button"
                      onClick={() => void syncLocalHistoryNow()}
                      disabled={localSyncLoading}
                    >
                      {localSyncLoading ? "Syncing..." : "Sync now"}
                    </button>
                    <button
                      className="btn-cancel"
                      type="button"
                      onClick={() => void dismissLocalSyncPrompt()}
                      disabled={localSyncLoading}
                    >
                      Not now
                    </button>
                  </div>
                </div>
              ) : null}
              {authStatus.authenticated && (
                <div className="settings-row">
                  <label>Account User ID</label>
                  <div className="inline-field-actions">
                    <input type="text" value={effectiveUserId} readOnly />
                    <button
                      className="btn-cancel"
                      type="button"
                      onClick={() => void copyText(effectiveUserId, "User ID")}
                    >
                      <Copy size={14} />
                      Copy
                    </button>
                  </div>
                </div>
              )}
              <div className="settings-row">
                <label>Regenerate Device</label>
                <button className="btn-cancel" type="button" onClick={resetDeviceId}>
                  New Device ID
                </button>
              </div>
            </div>

	            <div className="settings-section">
	              <div className="settings-section-title">
	                <Cpu size={12} /> System
	              </div>
              <div className="settings-row">
                <label>Global Hotkey</label>
                <input
                  type="text"
                  value={config.hotkey}
                  onChange={e => setConfig({ ...config, hotkey: e.target.value })}
                />
              </div>
              <div className="settings-row">
                <label>Device ID</label>
                <div className="inline-field-actions">
                  <input type="text" value={config.deviceId} readOnly />
                  <button
                    className="btn-cancel"
                    type="button"
                    onClick={() => void copyText(config.deviceId, "Device ID")}
                  >
                    <Copy size={14} />
                    Copy
                  </button>
                </div>
              </div>
              <div className="checkbox-row">
                <input
                  type="checkbox"
                  checked={config.launchAtLogin}
                  onChange={e => setConfig({ ...config, launchAtLogin: e.target.checked })}
                />
                Launch at login
              </div>
            </div>

		            <div className="settings-section">
		              <div className="settings-section-title">
		                <Monitor size={12} /> Capture
		              </div>
		              <div className="checkbox-row">
		                <input
		                  type="checkbox"
		                  checked={config.autoCapture}
		                  onChange={e => setConfig({ ...config, autoCapture: e.target.checked })}
		                />
		                Auto-capture clipboard history
		              </div>
		            </div>

                <div className="settings-section">
                  <div className="settings-section-title">
                    <ArrowRight size={12} /> Retention
                  </div>
                  <div className="settings-row">
                    <label>History retention</label>
                    <select
                      value={config.retention}
                      onChange={e => setConfig({ ...config, retention: e.target.value as AppConfig["retention"] })}
                    >
                      <option value="30d">30 days</option>
                      <option value="180d">180 days</option>
                      <option value="365d">365 days</option>
                      <option value="forever">Forever</option>
                    </select>
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8, lineHeight: 1.35 }}>
                    Applies to local mode. Favorites are always kept.
                  </div>
                </div>

	            <div className="settings-actions">
	              <button className="btn-cancel" onClick={closeSettings}>Cancel</button>
	              <button className="btn-save" onClick={saveConfig}>Save Changes</button>
	            </div>
          </div>
        </div>
      )}
    </main>
  );
}
