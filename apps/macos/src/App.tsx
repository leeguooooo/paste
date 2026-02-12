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
  Check,
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
  autoCapture: boolean;
  launchAtLogin: boolean;
  retention: "30d" | "180d" | "365d" | "forever";
  hotkey: string;
};

const emptyConfig: AppConfig = {
  apiBase: "",
  userId: "mac_user_demo",
  deviceId: "macos_desktop",
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
      <text x="44" y="64" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto" font-size="16" fill="rgba(255,255,255,0.92)" font-weight="700">Paste Demo</text>
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
      content: "Paste demo image",
      imagePreviewDataUrl: DEMO_SVG_DATA_URL,
      imageDataUrl: DEMO_SVG_DATA_URL,
      createdAt: now - 240_000,
    },
  ];
};

export default function App() {
  const [config, setConfig] = useState<AppConfig>(emptyConfig);
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
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
      setConfig(next);
    } catch (e) { console.error(e); }
  };

  const loadClips = useCallback(async (isInitial = false) => {
    if (isInitial) setLoading(true);
    try {
      const res = await window.macos.listClips({ q: query || undefined });
      if (res?.ok) {
        setClips(res.data.items ?? []);
        if (isInitial) setSelectedIndex(0);
      }
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [query]);

  useEffect(() => {
    void loadConfig();
    void loadClips(true);
  }, []);

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
  }, [query, loadClips]);

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

    const text = effective.content || effective.sourceUrl || "";
    const res = await window.macos.pasteAndHide({
      text,
      html: effective.contentHtml ?? null,
      imageDataUrl: effective.imageDataUrl ?? null,
      imageUrl: effective.imageUrl ?? null
    });
    if (!res?.ok) {
      // Surface the root error (most commonly missing Accessibility permission).
      alert(res?.message || "Paste failed");
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
            void handleCopy(clips[selectedIndex]);
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

  const showDemo = !loading && clips.length === 0 && query.trim() === "";
  const visibleClips: ClipCardItem[] = showDemo ? makeDemoClips(config.userId, config.deviceId) : clips;

  const saveConfig = async () => {
    const res = await window.macos.setConfig(config);
    if (res.ok) {
      if (res.message) {
        alert(res.message);
      }
      setShowSettings(false);
      await loadConfig();
      void loadClips();
      return;
    }
    alert(res?.message || "Failed to save settings");
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
                    <span className="clip-age">{age}</span>
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
                <Globe size={12} style={{marginRight: 6}} /> Connection
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
                <label>User ID</label>
                <input
                  type="text"
                  value={config.userId}
                  onChange={e => setConfig({ ...config, userId: e.target.value })}
                />
              </div>
            </div>

            <div className="settings-section">
              <div className="settings-section-title">
                <Cpu size={12} style={{marginRight: 6}} /> System
              </div>
              <div className="settings-row">
                <label>Global Hotkey</label>
                <input
                  type="text"
                  value={config.hotkey}
                  onChange={e => setConfig({ ...config, hotkey: e.target.value })}
                />
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
                <Monitor size={12} style={{marginRight: 6}} /> Capture
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
