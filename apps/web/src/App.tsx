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

// Default identity from localStorage for cross-device sync
const DEFAULT_USER_ID = localStorage.getItem("paste_user_id") || "user_demo";
const DEFAULT_DEVICE_ID = localStorage.getItem("paste_device_id") || "web_browser";

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
      summary: "欢迎使用 Paste",
      content: "欢迎使用 Paste。点击任意卡片可复制示例内容。",
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
      content: "<strong>Paste</strong> is local-first.",
      contentHtml: "<strong>Paste</strong> is local-first.",
      createdAt: now - 120_000,
    },
    {
      ...base,
      __demo: true,
      id: "demo:image",
      type: "image",
      summary: "图片示例",
      content: "Paste icon",
      imageUrl: "/icon-512.svg",
      createdAt: now - 240_000,
    },
  ];
};

export default function App() {
  const [userId, setUserId] = useState(DEFAULT_USER_ID);
  const [deviceId, setDeviceId] = useState(DEFAULT_DEVICE_ID);
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0); 
  const [showSettings, setShowSettings] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const inflightImagePrefetchRef = useRef(new Set<string>());

  const fetchHeaders = {
    "x-user-id": userId,
    "x-device-id": deviceId,
    "content-type": "application/json"
  };

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
        setClips(data.data.items);
        if (isInitial) setSelectedIndex(0);
      }
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [query, userId, deviceId]);

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
  }, [userId, deviceId]);

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
    void loadClips(true);
  }, [userId, deviceId]); 

  useEffect(() => {
    const timer = setTimeout(() => void loadClips(), 150);
    return () => clearTimeout(timer);
  }, [query, loadClips]);

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
        await navigator.clipboard.writeText(effective.content);
      }
    } catch {
      await navigator.clipboard.writeText(clip.content);
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
    localStorage.setItem("paste_user_id", userId);
    localStorage.setItem("paste_device_id", deviceId);
    setShowSettings(false);
    window.location.reload();
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
  const visibleClips: ClipCardItem[] = showDemo ? makeDemoClips(userId, deviceId) : clips;

  return (
    <main className="app-shell">
      <div className="history-shelf">
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
                <label>User ID (Match with macOS App to sync)</label>
                <input type="text" value={userId} onChange={e => setUserId(e.target.value)} />
              </div>
              <div className="settings-row">
                <label>Device ID</label>
                <input type="text" value={deviceId} onChange={e => setDeviceId(e.target.value)} />
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
