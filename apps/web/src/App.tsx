import { useEffect, useState, useRef, useCallback } from "react";
import type { ClipItem, ApiResponse, ClipListResponse } from "@paste/shared";
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
  Globe,
  Monitor,
  Smartphone,
  Cpu
} from "lucide-react";

const normalizePath = (value: string, fallback: string): string => {
  const raw = String(value || "").trim() || fallback;
  const prefixed = raw.startsWith("/") ? raw : `/${raw}`;
  const compact = prefixed.replace(/\/{2,}/g, "/");
  return compact === "" ? fallback : compact;
};

const normalizeDirPath = (value: string, fallback: string): string => {
  const normalized = normalizePath(value, fallback);
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
};

const normalizePathname = (value: string): string => {
  const normalized = String(value || "").replace(/\/+$/, "");
  return normalized === "" ? "/" : normalized;
};

const BASE_URL = normalizeDirPath(import.meta.env.BASE_URL || "/", "/");
const resolveAssetPath = (relativePath: string): string => `${BASE_URL}${relativePath.replace(/^\/+/, "")}`;
const API_BASE = normalizePath(import.meta.env.VITE_API_BASE || "/v1", "/v1").replace(/\/+$/, "");
const PORTAL_HOME_URL = (() => {
  const configured = String(import.meta.env.VITE_PORTAL_HOME_URL || "").trim();
  if (configured) return configured;
  if (typeof window !== "undefined" && window.location.hostname === "app.leeguoo.com") return "/";
  return "https://app.leeguoo.com/";
})();

type ClipCardItem = ClipItem & { __demo?: boolean };
type AuthUser = {
  userId: string;
  githubLogin: string;
  githubId: number;
  email?: string;
  name?: string;
};
type AuthMeData = {
  authenticated: boolean;
  user: AuthUser | null;
  headerIdentityEnabled: boolean;
  authConfigured: boolean;
  authMode?: "legacy" | "hybrid" | "sso";
  authSource?: "legacy" | "sso" | null;
};

type SsoTokenData = {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  tokenType: string;
};

const SSO_ACCESS_TOKEN_KEY = "paste_sso_access_token";
const SSO_REFRESH_TOKEN_KEY = "paste_sso_refresh_token";
const SSO_STATE_KEY = "paste_sso_state";
const SSO_CODE_VERIFIER_KEY = "paste_sso_code_verifier";
const SSO_REDIRECT_PATH = normalizePath(import.meta.env.VITE_SSO_REDIRECT_PATH || "/auth/callback", "/auth/callback");
const SSO_POST_AUTH_PATH = normalizeDirPath(import.meta.env.VITE_SSO_POST_AUTH_PATH || "/", "/");
const DEFAULT_SSO_ISSUER = (import.meta.env.VITE_SSO_ISSUER || "https://cloudflare-sso.pages.dev").trim();
const DEFAULT_SSO_CLIENT_ID = (import.meta.env.VITE_SSO_CLIENT_ID || "misonote-paste-web").trim();

const toBase64Url = (bytes: Uint8Array): string => {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const randomString = (length = 48): string => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes).slice(0, length);
};

const buildPkceChallenge = async (verifier: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
};

const buildSsoRedirectUri = (): string => {
  if (typeof window === "undefined") return SSO_REDIRECT_PATH;
  return new URL(SSO_REDIRECT_PATH, window.location.origin).toString();
};

// Default identity from localStorage for cross-device sync
const DEFAULT_USER_ID = localStorage.getItem("paste_user_id") || "user_demo";
const getOrCreateDeviceId = (): string => {
  const existing = localStorage.getItem("paste_device_id");
  if (existing && existing.trim()) return existing.trim();
  const next =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? `web_${crypto.randomUUID().slice(0, 8)}`
      : `web_${Math.random().toString(36).slice(2, 10)}`;
  localStorage.setItem("paste_device_id", next);
  return next;
};
const DEFAULT_DEVICE_ID = getOrCreateDeviceId();

const isValidImageDataUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  // Only render safe image data URLs. Other data: types or plain base64 strings
  // should not be treated as <img src>.
  return value.startsWith("data:image/");
};

const getImageSrc = (clip: ClipItem): string | null => {
  if (isValidImageDataUrl(clip.imagePreviewDataUrl)) return clip.imagePreviewDataUrl;
  if (isValidImageDataUrl(clip.imageDataUrl)) return clip.imageDataUrl;
  if (typeof clip.imageUrl === "string" && clip.imageUrl.trim()) return clip.imageUrl;
  return null;
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
    // Canonicalize host/protocol casing.
    u.hostname = u.hostname.toLowerCase();
    u.protocol = u.protocol.toLowerCase();
    // Drop default ports.
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
      summary: "欢迎使用 paste",
      content: "欢迎使用 paste。点击任意卡片可复制示例内容。",
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
      content: "curl -sS https://pasteapi.leeguoo.com/v1/health",
      createdAt: now - 56_000,
    },
    {
      ...base,
      __demo: true,
      id: "demo:html",
      type: "html",
      summary: "HTML 示例",
      content: "<strong>paste</strong> is local-first.",
      contentHtml: "<strong>paste</strong> is local-first.",
      createdAt: now - 120_000,
    },
    {
      ...base,
      __demo: true,
      id: "demo:image",
      type: "image",
      summary: "图片示例",
      content: "paste icon",
      imageUrl: resolveAssetPath("icon-512.svg"),
      createdAt: now - 240_000,
    },
  ];
};

export default function App() {
  const [userId, setUserId] = useState(DEFAULT_USER_ID);
  const [deviceId, setDeviceId] = useState(DEFAULT_DEVICE_ID);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [authConfigured, setAuthConfigured] = useState(false);
  const [ssoError, setSsoError] = useState("");
  const [ssoAccessToken, setSsoAccessToken] = useState<string>(() => localStorage.getItem(SSO_ACCESS_TOKEN_KEY) || "");
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0); 
  const [showSettings, setShowSettings] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const inflightImagePrefetchRef = useRef(new Set<string>());
  const effectiveUserId = authUser?.userId || userId;
  const authDisplayName = (authUser?.name || authUser?.email || authUser?.githubLogin || authUser?.userId || "").trim();
  const effectiveDeviceId = deviceId.trim() || "web_browser";
  const ssoEnabled = Boolean(DEFAULT_SSO_ISSUER && DEFAULT_SSO_CLIENT_ID);

  const buildHeaders = (withContentType = true): Record<string, string> => {
    const headers: Record<string, string> = {
      "x-user-id": effectiveUserId,
      "x-device-id": effectiveDeviceId
    };
    if (withContentType) {
      headers["content-type"] = "application/json";
    }
    if (ssoAccessToken) {
      headers.authorization = `Bearer ${ssoAccessToken}`;
    }
    return headers;
  };

  const persistSsoTokens = (next: { accessToken: string; refreshToken?: string | null }) => {
    setSsoAccessToken(next.accessToken);
    localStorage.setItem(SSO_ACCESS_TOKEN_KEY, next.accessToken);
    if (next.refreshToken) {
      localStorage.setItem(SSO_REFRESH_TOKEN_KEY, next.refreshToken);
    }
  };

  const clearSsoTokens = () => {
    setSsoAccessToken("");
    localStorage.removeItem(SSO_ACCESS_TOKEN_KEY);
    localStorage.removeItem(SSO_REFRESH_TOKEN_KEY);
  };

  const exchangeSsoToken = async (
    body:
      | { grantType: "authorization_code"; code: string; codeVerifier: string; redirectUri: string }
      | { grantType: "refresh_token"; refreshToken: string }
  ): Promise<SsoTokenData | null> => {
    const res = await fetch(`${API_BASE}/auth/sso/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const data: ApiResponse<SsoTokenData> = await res.json();
    if (!data.ok) {
      console.error("SSO token exchange failed", data);
      return null;
    }
    persistSsoTokens({
      accessToken: data.data.accessToken,
      refreshToken: data.data.refreshToken
    });
    return data.data;
  };

  // Authenticated write that survives an expired access token: on 401 it silently
  // refreshes via the stored refresh token and retries once. Read paths refresh
  // through loadAuth/loadClips, but writes (create/delete/favorite) need this or
  // they fail ~10 min after sign-in when the access token TTL lapses.
  const authedWrite = async (path: string, init: RequestInit): Promise<Response> => {
    let res = await fetch(`${API_BASE}${path}`, { ...init, headers: buildHeaders() });
    if (res.status === 401) {
      const refreshToken = localStorage.getItem(SSO_REFRESH_TOKEN_KEY) || "";
      if (refreshToken) {
        const refreshed = await exchangeSsoToken({ grantType: "refresh_token", refreshToken });
        if (refreshed?.accessToken) {
          res = await fetch(`${API_BASE}${path}`, {
            ...init,
            headers: { ...buildHeaders(), authorization: `Bearer ${refreshed.accessToken}` }
          });
        }
      }
    }
    return res;
  };

  const maybeHandleSsoCallback = useCallback(async (): Promise<void> => {
    if (!ssoEnabled) return;
    const params = new URLSearchParams(window.location.search);
    const code = String(params.get("code") || "").trim();
    const state = String(params.get("state") || "").trim();
    const currentPath = normalizePathname(window.location.pathname);
    const isPrimaryCallbackPath = currentPath === normalizePathname(SSO_REDIRECT_PATH);
    // Some edge setups rewrite /auth/callback -> / while preserving query params.
    const isRootFallbackCallbackPath =
      currentPath === normalizePathname(SSO_POST_AUTH_PATH) && (code.length > 0 || state.length > 0);
    if (!isPrimaryCallbackPath && !isRootFallbackCallbackPath) return;
    if (!code || !state) return;

    const expectedState = String(localStorage.getItem(SSO_STATE_KEY) || "").trim();
    const codeVerifier = String(localStorage.getItem(SSO_CODE_VERIFIER_KEY) || "").trim();
    localStorage.removeItem(SSO_STATE_KEY);
    localStorage.removeItem(SSO_CODE_VERIFIER_KEY);

    // Popup mode: we were opened by startSsoSignIn. Report back to the opener
    // (which shares our origin + localStorage) and close, without navigating it.
    const isPopup = typeof window !== "undefined" && !!window.opener && window.opener !== window;
    const finishPopup = (ok: boolean) => {
      try {
        window.opener?.postMessage({ type: "paste-sso", ok }, window.location.origin);
      } catch {
        /* ignore */
      }
      window.close();
    };

    if (!expectedState || !codeVerifier || expectedState !== state) {
      console.error("SSO callback state mismatch");
      if (isPopup) {
        finishPopup(false);
        return;
      }
      setSsoError("SSO state mismatch. Please try signing in again.");
      const clean = `${SSO_POST_AUTH_PATH}${window.location.hash || ""}` || "/";
      window.history.replaceState({}, document.title, clean);
      return;
    }

    const redirectUri = buildSsoRedirectUri();
    const exchanged = await exchangeSsoToken({
      grantType: "authorization_code",
      code,
      codeVerifier,
      redirectUri
    });

    if (isPopup) {
      finishPopup(!!exchanged);
      return;
    }

    if (!exchanged) {
      setSsoError("SSO token exchange failed. Please try again.");
    } else {
      setSsoError("");
    }

    const clean = `${SSO_POST_AUTH_PATH}${window.location.hash || ""}` || "/";
    window.history.replaceState({}, document.title, clean);
  }, [ssoEnabled]);

  const startSsoSignIn = useCallback(async () => {
    if (!ssoEnabled) return;
    setSsoError("");
    const state = randomString(32);
    const codeVerifier = randomString(64);
    const codeChallenge = await buildPkceChallenge(codeVerifier);
    localStorage.setItem(SSO_STATE_KEY, state);
    localStorage.setItem(SSO_CODE_VERIFIER_KEY, codeVerifier);

    const redirectUri = buildSsoRedirectUri();
    const authUrl = new URL("/authorize", DEFAULT_SSO_ISSUER);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", DEFAULT_SSO_CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", "openid profile email");
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    const url = authUrl.toString();
    // Prefer a popup so the main page never navigates away; the callback posts
    // the result back (see the message listener + maybeHandleSsoCallback). Fall
    // back to a full-page redirect when the popup is blocked.
    const popup = window.open(
      url,
      "paste-sso-login",
      "width=480,height=720,menubar=no,toolbar=no,location=no,status=no"
    );
    if (!popup) {
      window.location.assign(url);
    }
  }, [ssoEnabled]);

  const loadAuth = useCallback(async () => {
    setAuthLoading(true);
    try {
      const res = await fetch(`${API_BASE}/auth/me`, {
        headers: buildHeaders(false)
      });
      const data: ApiResponse<AuthMeData> = await res.json();
      if (data.ok) {
        setAuthConfigured(Boolean(data.data.authConfigured));
      }
      if (data.ok && data.data.authenticated && data.data.user) {
        setAuthUser(data.data.user);
        setUserId(data.data.user.userId);
        setSsoError("");
      } else if (data.ok && data.data.authMode && data.data.authMode !== "legacy") {
        // The SSO access token is short-lived (~10 min). Before signing the user
        // out, try to silently refresh with the stored refresh token.
        const refreshToken = localStorage.getItem(SSO_REFRESH_TOKEN_KEY) || "";
        let recovered = false;
        if (refreshToken) {
          const refreshed = await exchangeSsoToken({ grantType: "refresh_token", refreshToken });
          if (refreshed?.accessToken) {
            const retry = await fetch(`${API_BASE}/auth/me`, {
              headers: { authorization: `Bearer ${refreshed.accessToken}` }
            });
            const retryData: ApiResponse<AuthMeData> = await retry.json();
            if (retryData.ok && retryData.data.authenticated && retryData.data.user) {
              setAuthUser(retryData.data.user);
              setUserId(retryData.data.user.userId);
              setSsoError("");
              recovered = true;
            }
          }
        }
        if (!recovered) {
          if (ssoAccessToken || refreshToken) clearSsoTokens();
          setAuthUser(null);
        }
      } else {
        setAuthUser(null);
      }
    } catch (e) {
      console.error(e);
      setAuthUser(null);
      setAuthConfigured(false);
    } finally {
      setAuthLoading(false);
      setAuthReady(true);
    }
  }, [effectiveDeviceId, effectiveUserId, ssoAccessToken]);

  const loadClips = useCallback(async (isInitial = false) => {
    if (isInitial) setLoading(true);
    try {
      const params = new URLSearchParams();
      if (query) params.append("q", query);
      params.append("limit", "50");
      // Prefer lightweight list responses; images can render from preview/url.
      params.append("lite", "1");

      const res = await fetch(`${API_BASE}/clips?${params.toString()}`, {
        headers: buildHeaders(false)
      });
      const data: ApiResponse<ClipListResponse> = await res.json();
      if (data.ok) {
        const nextItems = dedupeRecentItems(collapseConsecutiveDuplicates(data.data.items));
        setClips(nextItems);
        setSelectedIndex((prev) =>
          isInitial ? 0 : Math.min(prev, Math.max(0, nextItems.length - 1))
        );
      }
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [query, effectiveUserId, effectiveDeviceId, ssoAccessToken]);

  // Create a new clip from the composer / a global paste. Text URLs become
  // link clips; everything else is text; images go through imageDataUrl.
  const createClip = useCallback(async (opts: { text?: string; imageDataUrl?: string }): Promise<boolean> => {
    const text = (opts.text ?? "").trim();
    const imageDataUrl = opts.imageDataUrl;
    if (!text && !imageDataUrl) return false;
    setCreating(true);
    try {
      const isUrl = !imageDataUrl && /^https?:\/\/\S+$/i.test(text);
      const body = imageDataUrl
        ? { type: "image", content: "[Image]", imageDataUrl, imagePreviewDataUrl: imageDataUrl, clientUpdatedAt: Date.now() }
        : { type: isUrl ? "link" : "text", content: text, sourceUrl: isUrl ? text : undefined, clientUpdatedAt: Date.now() };
      const res = await authedWrite(`/clips`, {
        method: "POST",
        body: JSON.stringify(body)
      });
      if (!res.ok) return false;
      await loadClips(true);
      return true;
    } catch (e) {
      console.error(e);
      return false;
    } finally {
      setCreating(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadClips, effectiveUserId, effectiveDeviceId, ssoAccessToken]);

  const handleDelete = async (e: React.MouseEvent, clip: ClipItem) => {
    e.stopPropagation();
    try {
      await authedWrite(`/clips/${clip.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isDeleted: true, clientUpdatedAt: Date.now() })
      });
      void loadClips();
    } catch (err) { console.error(err); }
  };

  const fetchClipById = useCallback(async (id: string): Promise<ClipItem | null> => {
    try {
      const res = await fetch(`${API_BASE}/clips/${encodeURIComponent(id)}`, {
        headers: buildHeaders(false)
      });
      const data: ApiResponse<ClipItem> = await res.json();
      return data.ok ? data.data : null;
    } catch (e) {
      console.error(e);
      return null;
    }
  }, [effectiveUserId, effectiveDeviceId, ssoAccessToken]);

  // Best-effort: if list results are "lite" (no imageDataUrl), gradually hydrate
  // image clips so previews can render without requiring a copy action.
  useEffect(() => {
    let cancelled = false;

    const missing = clips.filter(
      (clip) =>
        clip.type === "image" &&
        !isValidImageDataUrl(clip.imagePreviewDataUrl) &&
        !isValidImageDataUrl(clip.imageDataUrl) &&
        !(typeof clip.imageUrl === "string" && clip.imageUrl.trim())
    );
    if (missing.length === 0) return;

    void (async () => {
      // Avoid blasting the API; fetch a few per render cycle.
      for (const clip of missing.slice(0, 12)) {
        if (cancelled) return;
        if (inflightImagePrefetchRef.current.has(clip.id)) continue;
        inflightImagePrefetchRef.current.add(clip.id);
        try {
          const fetched = await fetchClipById(clip.id);
          if (cancelled) return;
          if (fetched) {
            setClips((prev) => prev.map((c) => (c.id === fetched.id ? { ...c, ...fetched } : c)));
          }
        } finally {
          inflightImagePrefetchRef.current.delete(clip.id);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [clips, fetchClipById]);

  useEffect(() => {
    void (async () => {
      await maybeHandleSsoCallback();
      await loadAuth();
    })();
  }, [maybeHandleSsoCallback, loadAuth]);

  // Receive the popup login result (same-origin postMessage from the SSO
  // callback). On success the token is already persisted; just refresh auth.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; ok?: boolean } | null;
      if (!data || data.type !== "paste-sso") return;
      if (data.ok) {
        setSsoError("");
        void loadAuth();
        void loadClips(true);
      } else {
        setSsoError("SSO sign-in failed. Please try again.");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [loadAuth, loadClips]);

  useEffect(() => {
    if (!authReady) return;
    void loadClips(true);
  }, [effectiveUserId, effectiveDeviceId, authReady, loadClips]); 

  useEffect(() => {
    if (!authReady) return;
    const timer = setTimeout(() => void loadClips(), 150);
    return () => clearTimeout(timer);
  }, [query, loadClips, authReady]);

  // Keyboard Navigation (mirrors macOS App)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (showSettings) return;
      switch (e.key) {
        case "ArrowRight":
          setSelectedIndex(prev => Math.min(prev + 1, clips.length - 1));
          break;
        case "ArrowLeft":
          setSelectedIndex(prev => Math.max(prev - 1, 0));
          break;
        case "Enter":
          if (clips[selectedIndex]) void handleCopy(clips[selectedIndex]);
          break;
        case "Escape":
          setQuery("");
          break;
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [clips, selectedIndex, showSettings]);

  // Scroll Synchronization
  useEffect(() => {
    if (!scrollContainerRef.current || clips.length === 0) return;
    const targetScroll = selectedIndex * (280 + 24);
    scrollContainerRef.current.scrollTo({ left: targetScroll, behavior: "smooth" });
  }, [selectedIndex, clips]);

  // Live cross-browser sync: poll while signed in and the tab is visible, so a
  // clip copied in another browser/device appears here within a few seconds.
  useEffect(() => {
    if (!authReady || !authUser) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadClips();
    }, 4000);
    return () => window.clearInterval(id);
  }, [authReady, authUser, loadClips]);

  // Global paste: Cmd/Ctrl+V anywhere (outside inputs) saves a new clip to the
  // cloud — the fastest way to push something from this browser to the others.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (!authUser) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t?.isContentEditable) return;
      const items = e.clipboardData?.items;
      if (items) {
        for (const it of Array.from(items)) {
          if (it.type.startsWith("image/")) {
            const file = it.getAsFile();
            if (file) {
              const reader = new FileReader();
              reader.onload = () => void createClip({ imageDataUrl: String(reader.result) });
              reader.readAsDataURL(file);
              e.preventDefault();
              return;
            }
          }
        }
      }
      const text = e.clipboardData?.getData("text/plain") || "";
      if (text.trim()) {
        void createClip({ text });
        e.preventDefault();
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [authUser, createClip]);

	  const handleCopy = async (clip: ClipItem) => {
	    try {
	      let effective = clip;
      if (
        clip.type === "image" &&
        !isValidImageDataUrl(clip.imageDataUrl) &&
        !(typeof clip.imageUrl === "string" && clip.imageUrl.trim())
      ) {
        const fetched = await fetchClipById(clip.id);
        if (fetched) {
          effective = fetched;
          setClips((prev) => prev.map((c) => (c.id === fetched.id ? { ...c, ...fetched } : c)));
        }
      }

      if (effective.type === "image" && isValidImageDataUrl(effective.imageDataUrl)) {
        // Best-effort image copy (may fail due to browser permission model).
        const blob = await (await fetch(String(effective.imageDataUrl))).blob();
        const ClipboardItemCtor = (window as any).ClipboardItem as any;
        if (!ClipboardItemCtor) throw new Error("ClipboardItem not supported");
        await navigator.clipboard.write([new ClipboardItemCtor({ [blob.type]: blob })]);
	      } else if (effective.type === "image" && typeof effective.imageUrl === "string" && effective.imageUrl.trim()) {
	        const blob = await (await fetch(effective.imageUrl)).blob();
	        const ClipboardItemCtor = (window as any).ClipboardItem as any;
	        if (!ClipboardItemCtor) throw new Error("ClipboardItem not supported");
	        await navigator.clipboard.write([new ClipboardItemCtor({ [blob.type]: blob })]);
	      } else {
	        const text =
	          effective.type === "link" && typeof effective.sourceUrl === "string" && effective.sourceUrl.trim()
	            ? effective.sourceUrl.trim()
	            : effective.content;
	        await navigator.clipboard.writeText(text);
	      }
	    } catch {
	      const fallback =
	        clip.type === "link" && typeof clip.sourceUrl === "string" && clip.sourceUrl.trim()
	          ? clip.sourceUrl.trim()
	          : clip.content;
	      await navigator.clipboard.writeText(fallback);
	    }

	    setCopiedId(clip.id);
	    window.setTimeout(() => setCopiedId((prev) => (prev === clip.id ? null : prev)), 900);
	  };

  const handleCopyDemo = async (clip: ClipCardItem) => {
    try {
      if (clip.type === "image") {
        const url = clip.imageUrl || resolveAssetPath("icon-512.svg");
        await navigator.clipboard.writeText(String(url));
      } else {
        await navigator.clipboard.writeText(clip.content);
      }
    } catch {
      // ignore
    }

    setCopiedId(clip.id);
    window.setTimeout(() => setCopiedId((prev) => (prev === clip.id ? null : prev)), 900);
  };

  const handleToggleFavorite = async (e: React.MouseEvent, clip: ClipItem) => {
    e.stopPropagation();
    try {
      await authedWrite(`/clips/${clip.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isFavorite: !clip.isFavorite, clientUpdatedAt: Date.now() })
      });
      void loadClips();
    } catch (e) { console.error(e); }
  };

  const saveSettings = () => {
    localStorage.setItem("paste_device_id", effectiveDeviceId);
    setShowSettings(false);
    void loadAuth();
  };

  const resetDeviceId = () => {
    const next =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? `web_${crypto.randomUUID().slice(0, 8)}`
        : `web_${Math.random().toString(36).slice(2, 10)}`;
    setDeviceId(next);
  };

  const signIn = () => {
    if (!ssoEnabled) return;
    void startSsoSignIn();
  };

  const logoutAuth = async () => {
    try {
      clearSsoTokens();
      await fetch(`${API_BASE}/auth/logout`, {
        method: "POST",
        headers: { "content-type": "application/json" }
      });
      setAuthUser(null);
      void loadAuth();
      void loadClips(true);
    } catch (e) {
      console.error(e);
    }
  };

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

  const showDemo = !loading && !authUser && clips.length === 0 && query.trim() === "" && !favoritesOnly;
  const baseClips: ClipCardItem[] = showDemo ? makeDemoClips(effectiveUserId, effectiveDeviceId) : clips;
  const gridClips: ClipCardItem[] = favoritesOnly ? baseClips.filter((c) => c.isFavorite) : baseClips;

  return (
    <main className="app-shell">
      <svg aria-hidden="true" className="doodle-filters" width="0" height="0">
        <filter id="rough0"><feTurbulence type="fractalNoise" baseFrequency="0.013" numOctaves="2" seed="2" result="n" /><feDisplacementMap in="SourceGraphic" in2="n" scale="5" xChannelSelector="R" yChannelSelector="G" /></filter>
        <filter id="rough1"><feTurbulence type="fractalNoise" baseFrequency="0.013" numOctaves="2" seed="7" result="n" /><feDisplacementMap in="SourceGraphic" in2="n" scale="5" xChannelSelector="R" yChannelSelector="G" /></filter>
        <filter id="rough2"><feTurbulence type="fractalNoise" baseFrequency="0.013" numOctaves="2" seed="12" result="n" /><feDisplacementMap in="SourceGraphic" in2="n" scale="5" xChannelSelector="R" yChannelSelector="G" /></filter>
        <filter id="roughHi"><feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="2" seed="3" result="n" /><feDisplacementMap in="SourceGraphic" in2="n" scale="3" xChannelSelector="R" yChannelSelector="G" /></filter>
      </svg>
      <header className="marketing-nav">
        <a className="brand" href={BASE_URL} aria-label="paste home">
          <span className="brand-mark" aria-hidden="true">p</span>
          <span className="brand-name">paste</span>
        </a>
        <nav className="marketing-links" aria-label="Primary">
          <a className="nav-back" href={PORTAL_HOME_URL}>Back to App Center</a>
          <a href="https://github.com/leeguooooo/paste" target="_blank" rel="noopener noreferrer">Source Code</a>
          <a className="nav-cta" href="https://github.com/leeguooooo/paste/releases/latest" target="_blank" rel="noopener noreferrer">
            Download for macOS
          </a>
          {authUser ? (
            <div className="nav-account">
              <span className="nav-account-name" title={authDisplayName}>{authDisplayName}</span>
              <button className="nav-signout" type="button" onClick={() => void logoutAuth()}>Sign out</button>
            </div>
          ) : authConfigured ? (
            <button
              className="nav-signin"
              type="button"
              onClick={signIn}
              disabled={authLoading}
            >
              {authLoading ? "Checking…" : "Sign in"}
            </button>
          ) : null}
        </nav>
      </header>

      <p className="value-strip">✦ 在线剪贴板 · 免安装 · 多设备实时同步 ✦</p>

      <section className="work-row">
        <div className="composer doodle-box">
          <div className="composer-head">
            <span className="composer-title">新建剪贴 ✎</span>
            <span className="composer-hint">在任意位置 Cmd/Ctrl+V 也能直接存入</span>
          </div>
          <textarea
            className="composer-input"
            placeholder="粘贴或输入要同步的内容…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                if (authUser) void createClip({ text: draft }).then((ok) => { if (ok) setDraft(""); });
              }
            }}
          />
          <div className="composer-actions">
            {authUser ? (
              <button
                className="composer-save"
                type="button"
                disabled={creating || !draft.trim()}
                onClick={() => void createClip({ text: draft }).then((ok) => { if (ok) setDraft(""); })}
              >
                {creating ? "存入中…" : "存入云端 ↑"}
              </button>
            ) : (
              <button className="composer-save" type="button" onClick={signIn} disabled={!authConfigured}>
                登录后即可同步 →
              </button>
            )}
          </div>
        </div>

        <div className="qr-card doodle-box">
          <img className="qr-img" src={resolveAssetPath("qr-open.png")} alt="扫码在手机上打开 paste.leeguoo.com" width={132} height={132} draggable={false} />
          <div className="qr-cap">扫码在手机上打开<br /><span>Open on your phone</span></div>
        </div>
      </section>

      <div className="history-shelf" id="clips">
        <div className="toolbar">
          <div className="toolbar-search-input-wrap doodle-box">
            <Search size={17} className="search-icon" />
            <input
              ref={searchInputRef}
              className="search-input"
              placeholder="搜索剪贴历史…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button
            className={`tool-btn ${favoritesOnly ? "on" : ""}`}
            onClick={() => setFavoritesOnly((v) => !v)}
            aria-label="Favorites only"
            type="button"
          >
            <Star size={18} fill={favoritesOnly ? "currentColor" : "transparent"} />
          </button>
          <button className="tool-btn" onClick={() => setShowSettings(true)} aria-label="Settings" type="button">
            <Settings size={18} />
          </button>
        </div>

        {gridClips.length === 0 ? (
          <div className="clips-empty">
            {favoritesOnly ? "还没有收藏的剪贴。" : (authUser ? "还没有剪贴，粘贴点什么试试 ✎" : "登录后，你的剪贴会在所有设备间同步。")}
          </div>
        ) : (
          <div className="history-container" ref={scrollContainerRef}>
            {gridClips.map((clip, index) => {
              const isSelected = index === selectedIndex;
              const isCopied = copiedId === clip.id;
              const device = getDeviceMeta(clip.deviceId);
              const age = formatAgeShort(clip.createdAt);
              return (
                <div
                  key={clip.id}
                  className={`clip-card doodle-box type-${clip.type} ${isSelected ? 'selected' : ''}`}
                  onClick={() => {
                    setSelectedIndex(index);
                    if (clip.__demo) { void handleCopyDemo(clip); return; }
                    void handleCopy(clip);
                  }}
                >
                  <div className="clip-strip" />
                  <div className="clip-head">
                    <div className="clip-head-left">
                      {getIcon(clip.type)}
                      <span className="clip-type-pill">{clip.type}</span>
                      <span className="clip-age">{age}</span>
                    </div>
                    {!clip.__demo && (
                      <div className="clip-head-right" onClick={(e) => e.stopPropagation()}>
                        <button
                          className={`clip-fav ${clip.isFavorite ? "on" : ""}`}
                          aria-label={clip.isFavorite ? "Unfavorite" : "Favorite"}
                          onClick={(e) => void handleToggleFavorite(e, clip)}
                          type="button"
                        >
                          <Star size={14} fill={clip.isFavorite ? "currentColor" : "transparent"} />
                        </button>
                        <button
                          className="clip-del"
                          aria-label="Delete"
                          onClick={(e) => void handleDelete(e, clip)}
                          type="button"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="clip-preview">
                    {clip.type === "image" && getImageSrc(clip) ? (
                      <img src={getImageSrc(clip) as string} className="clip-image-preview" alt="preview" draggable={false} loading="lazy" />
                    ) : (
                      <div className="preview-text">{clip.summary || clip.content}</div>
                    )}
                  </div>
                  <div className="clip-footer">
                    <div className="clip-device" title={clip.deviceId}>
                      {device.icon}
                      <span>{device.label}</span>
                    </div>
                    <button
                      className={`clip-copy ${isCopied ? "copied" : ""}`}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedIndex(index);
                        if (clip.__demo) { void handleCopyDemo(clip); return; }
                        void handleCopy(clip);
                      }}
                    >
                      {isCopied ? "已复制 ✓" : "复制"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showSettings && (
        <div className="settings-overlay" onClick={() => setShowSettings(false)}>
          <div className="settings-panel" onClick={e => e.stopPropagation()}>
            <div className="settings-header">
              <h2>Cloud Sync Settings</h2>
              <button className="icon-btn" onClick={() => setShowSettings(false)}><X size={24} /></button>
            </div>
            <div className="settings-section">
              {authUser ? (
                <div className="settings-account">
                  <div className="settings-account-meta">
                    <span className="settings-account-label">Signed in</span>
                    <span className="settings-account-user">{authDisplayName}</span>
                  </div>
                  <button
                    className="btn-save btn-save-dark btn-save-inline"
                    type="button"
                    onClick={() => void logoutAuth()}
                  >
                    Sign out
                  </button>
                </div>
              ) : (
                <button
                  className="btn-save btn-save-primary btn-save-block"
                  type="button"
                  onClick={signIn}
                  disabled={authLoading || !authConfigured}
                >
                  {!authConfigured
                    ? "Sync unavailable"
                    : authLoading
                      ? "Checking…"
                      : "Sign in to sync"}
                </button>
              )}
              {ssoError ? (
                <div className="settings-auth-error" role="alert">{ssoError}</div>
              ) : null}
            </div>
            {authUser ? (
              <button className="btn-save btn-save-primary" onClick={saveSettings}>
                Sync now
              </button>
            ) : null}
          </div>
        </div>
      )}

      <footer className="brand-footer">
        <span className="bf-made">由 <strong>郭立</strong>（leeguoo）打造</span>
        <nav className="bf-links">
          <a className="bf-blog" href="https://blog.leeguoo.com" target="_blank" rel="noopener noreferrer">读郭立的博客 →</a>
          <a href="https://github.com/leeguooooo/paste" target="_blank" rel="noopener noreferrer">GitHub</a>
          <a href={PORTAL_HOME_URL}>应用中心</a>
        </nav>
      </footer>
    </main>
  );
}
