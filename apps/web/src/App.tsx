import { useEffect, useState, useRef, useCallback } from "react";
import type { ClipItem, ClipType, ApiResponse, ClipListResponse } from "@paste/shared";
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

const API_BASE = "/v1";

type ClipCardItem = ClipItem & { __demo?: boolean };
type AuthUser = {
  userId: string;
  githubLogin: string;
  githubId: number;
};
type AuthMeData = {
  authenticated: boolean;
  user: AuthUser | null;
  headerIdentityEnabled: boolean;
  authConfigured: boolean;
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
      content: "Pastyx icon",
      imageUrl: "/icon-512.svg",
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
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0); 
  const [showSettings, setShowSettings] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const inflightImagePrefetchRef = useRef(new Set<string>());
  const effectiveUserId = authUser?.userId || userId;
  const effectiveDeviceId = deviceId.trim() || "web_browser";

  const fetchHeaders = {
    "x-user-id": effectiveUserId,
    "x-device-id": effectiveDeviceId,
    "content-type": "application/json"
  };

  const loadAuth = useCallback(async () => {
    setAuthLoading(true);
    try {
      const res = await fetch(`${API_BASE}/auth/me`, {
        headers: {
          "x-device-id": effectiveDeviceId
        }
      });
      const data: ApiResponse<AuthMeData> = await res.json();
      if (data.ok) {
        setAuthConfigured(Boolean(data.data.authConfigured));
      }
      if (data.ok && data.data.authenticated && data.data.user) {
        setAuthUser(data.data.user);
        setUserId(data.data.user.userId);
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
  }, [effectiveDeviceId]);

  const loadClips = useCallback(async (isInitial = false) => {
    if (isInitial) setLoading(true);
    try {
      const params = new URLSearchParams();
      if (query) params.append("q", query);
      params.append("limit", "50");
      // Prefer lightweight list responses; images can render from preview/url.
      params.append("lite", "1");

      const res = await fetch(`${API_BASE}/clips?${params.toString()}`, {
        headers: fetchHeaders
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
  }, [query, effectiveUserId, effectiveDeviceId]);

  const fetchClipById = useCallback(async (id: string): Promise<ClipItem | null> => {
    try {
      const res = await fetch(`${API_BASE}/clips/${encodeURIComponent(id)}`, {
        headers: fetchHeaders
      });
      const data: ApiResponse<ClipItem> = await res.json();
      return data.ok ? data.data : null;
    } catch (e) {
      console.error(e);
      return null;
    }
  }, [effectiveUserId, effectiveDeviceId]);

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
    void loadAuth();
  }, [loadAuth]);

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
        const url = clip.imageUrl || "/icon-512.svg";
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
      await fetch(`${API_BASE}/clips/${clip.id}`, {
        method: "PATCH",
        headers: fetchHeaders,
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

  const signInWithGithub = () => {
    const next = encodeURIComponent(`${window.location.pathname}${window.location.search}`);
    window.location.href = `${API_BASE}/auth/github/start?next=${next}`;
  };

  const logoutGithub = async () => {
    try {
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

  const showDemo = !loading && clips.length === 0 && query.trim() === "";
  const visibleClips: ClipCardItem[] = showDemo ? makeDemoClips(effectiveUserId, effectiveDeviceId) : clips;

  return (
    <main className="app-shell">
      <header className="marketing-nav">
        <a className="brand" href="/" aria-label="Pastyx home">
          <span className="brand-mark" aria-hidden="true">P</span>
          <span className="brand-name">Pastyx</span>
        </a>
        <nav className="marketing-links" aria-label="Primary">
          {authUser ? (
            <span style={{ fontSize: 12, opacity: 0.75 }}>@{authUser.githubLogin}</span>
          ) : null}
          <a href="https://github.com/leeguooooo/paste" target="_blank" rel="noopener noreferrer">Source Code</a>
          <a className="nav-cta" href="https://github.com/leeguooooo/paste/releases/latest" target="_blank" rel="noopener noreferrer">
            Download for macOS
          </a>
        </nav>
      </header>

      <section className="marketing-hero">
        <div className="hero-inner">
          <div className="hero-copy">
            <div className="hero-eyebrow">
              Open-source. Local-first. Independent product for clipboard history, screenshots, and screen recording.
            </div>
            <h1 className="hero-title">
              The Clipboard,
              <br />
              Reimagined.
            </h1>
            <p className="hero-subtitle">
              A high-performance clipboard manager for macOS and Web. Beautiful, private, and free forever.
            </p>
            <p className="hero-subtitle mt-2 text-white/60">
              This is an independent product and is not affiliated with any official clipboard software vendor.
            </p>

            <div className="hero-ctas">
              <a className="btn btn-primary" href="https://github.com/leeguooooo/paste/releases/latest" target="_blank" rel="noopener noreferrer">
                Download for macOS
              </a>
              <a className="btn btn-ghost" href="#demo">
                Try the web demo
              </a>
            </div>
          </div>

          <div className="hero-visual" aria-hidden="true">
            <div className="device-stack">
              <div className="device-browser">
                <div className="device-browser-top">
                  <span className="dot dot-red" />
                  <span className="dot dot-yellow" />
                  <span className="dot dot-green" />
                  <span className="device-browser-title">pastyx-web.misonote.com</span>
                </div>
                <img
                  src="/product/shots/web-live-1920x1080.png"
                  alt=""
                  className="device-browser-img"
                  loading="lazy"
                  draggable={false}
                />
              </div>

              <div className="device-phone">
                <img
                  src="/product/shots/web-live-iphone14.png"
                  alt=""
                  className="device-phone-img"
                  loading="lazy"
                  draggable={false}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="history-shelf" id="demo">
        <div className="toolbar">
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ position: 'relative' }}>
              <Search size={18} style={{ position: 'absolute', left: 14, top: 12, color: 'rgba(255,255,255,0.4)' }} />
              <input
                ref={searchInputRef}
                className="search-input"
                placeholder="Type to search..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <button className="icon-btn" onClick={() => setShowSettings(true)}>
              <Settings size={22} />
            </button>
          </div>
        </div>

        <div className="history-container" ref={scrollContainerRef}>
          {visibleClips.map((clip, index) => {
            const isSelected = index === selectedIndex;
            const isCopied = copiedId === clip.id;
            const device = getDeviceMeta(clip.deviceId);
            const accent = getTypeAccent(clip.type);
            const age = formatAgeShort(clip.createdAt);
            const cardStyle = { ["--accent" as any]: accent } as React.CSSProperties;
            return (
              <div 
                key={clip.id} 
                className={`clip-card ${isSelected ? 'selected' : ''}`}
                style={cardStyle}
                onClick={() => {
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
                  <div className="clip-hint">
                    {isCopied ? "Copied!" : (clip.__demo ? "Click to try" : "Click to copy")}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {showSettings && (
        <div className="settings-overlay" onClick={() => setShowSettings(false)}>
          <div className="settings-panel" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 24 }}>
              <h2>Cloud Sync Settings</h2>
              <button className="icon-btn" onClick={() => setShowSettings(false)}><X size={24} /></button>
            </div>
            <div className="settings-section">
              <div className="settings-row">
                <label>GitHub Account</label>
                {authUser ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 13, opacity: 0.8 }}>Signed in as @{authUser.githubLogin}</span>
                    <button
                      className="btn-save"
                      type="button"
                      style={{ width: "auto", background: "#2f3542", border: "none", padding: "8px 12px", borderRadius: 8, color: "white", fontWeight: 600 }}
                      onClick={() => void logoutGithub()}
                    >
                      Sign out
                    </button>
                  </div>
                ) : (
                  <button
                    className="btn-save"
                    type="button"
                    style={{ width: "auto", background: "#111827", border: "1px solid rgba(255,255,255,0.2)", padding: "8px 12px", borderRadius: 8, color: "white", fontWeight: 600 }}
                    onClick={signInWithGithub}
                    disabled={authLoading || !authConfigured}
                  >
                    {!authConfigured ? "GitHub auth not configured" : (authLoading ? "Checking..." : "Sign in with GitHub")}
                  </button>
                )}
              </div>
              <div className="settings-row">
                <label>Account User ID</label>
                <input
                  type="text"
                  value={authUser ? effectiveUserId : "Sign in required"}
                  disabled
                />
              </div>
              <div className="settings-row">
                <label>Device ID</label>
                <input type="text" value={deviceId} onChange={e => setDeviceId(e.target.value)} />
              </div>
              <div className="settings-row">
                <label>Regenerate Device</label>
                <button
                  className="btn-save"
                  type="button"
                  style={{ width: "auto", background: "#2f3542", border: "none", padding: "8px 12px", borderRadius: 8, color: "white", fontWeight: 600 }}
                  onClick={resetDeviceId}
                >
                  New Device ID
                </button>
              </div>
            </div>
            <button className="btn-save" style={{width:'100%', background:'#007aff', border:'none', padding:12, borderRadius:8, color:'white', fontWeight:600}} onClick={saveSettings}>
              Save and Sync
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
