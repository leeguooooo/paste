import { useEffect, useState, useRef, useCallback } from "react";
import type { ClipItem } from "@paste/shared";
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
  Check
} from "lucide-react";

type AppConfig = {
  apiBase: string;
  userId: string;
  deviceId: string;
  autoCapture: boolean;
  retention: "30d" | "180d" | "365d" | "forever";
};

const emptyConfig: AppConfig = {
  apiBase: "",
  userId: "mac_user_demo",
  deviceId: "macos_desktop",
  autoCapture: true,
  retention: "180d"
};

const htmlToText = (html?: string | null): string =>
  (html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export default function App() {
  const [config, setConfig] = useState<AppConfig>(emptyConfig);
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0); // For keyboard nav
  const [showSettings, setShowSettings] = useState(false);
  
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // --- Core Data Loading ---

  const loadConfig = async () => {
    try {
      const next = await window.macos.getConfig();
      setConfig(next);
    } catch (e) { console.error(e); }
  };

  const loadClips = useCallback(async (isInitial = false) => {
    if (isInitial) setLoading(true);
    try {
      // If query is empty, maybe we show favorites or just recent? 
      // For now, consistent with Paste, we show all recent.
      const res = await window.macos.listClips({ q: query || undefined });
      if (res?.ok) {
        setClips(res.data.items ?? []);
        // Reset selection on search change, but keep it if just refreshing
        if (isInitial) setSelectedIndex(0);
      }
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [query]);

  // Initial Load
  useEffect(() => {
    void loadConfig();
    void loadClips(true);
  }, []);

  // Debounced Search
  useEffect(() => {
    const timer = setTimeout(() => void loadClips(), 150);
    return () => clearTimeout(timer);
  }, [query, loadClips]);

  // Ensure selection is valid
  useEffect(() => {
    if (clips.length > 0 && selectedIndex >= clips.length) {
      setSelectedIndex(clips.length - 1);
    }
  }, [clips.length, selectedIndex]);

  // --- Scroll Synchronization ---
  useEffect(() => {
    if (!scrollContainerRef.current || clips.length === 0) return;
    
    const container = scrollContainerRef.current;
    const cardWidth = 260 + 24; // Width + Gap
    // Center the selected item
    const targetScroll = (selectedIndex * cardWidth); 
    
    container.scrollTo({
      left: targetScroll,
      behavior: "smooth"
    });
  }, [selectedIndex, clips]);


  // --- Actions ---

  const handleCopy = async (clip: ClipItem) => {
    const text = clip.content || clip.sourceUrl || "";
    await window.macos.writeClipboard({
      text,
      html: clip.contentHtml ?? null,
      imageDataUrl: clip.imageDataUrl ?? null
    });
    // Hide window after copy
    await window.macos.toggleWindow();
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

  // --- Keyboard Navigation ---

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (showSettings) return; // Let settings handle its own input

      switch (e.key) {
        case "ArrowRight":
          e.preventDefault();
          setSelectedIndex(prev => Math.min(prev + 1, clips.length - 1));
          break;
        case "ArrowLeft":
          e.preventDefault();
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
            setShowSettings(true);
          }
          break;
        // Search auto-focus: if typing normally and not a nav key, focus input
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
  }, [clips, selectedIndex, showSettings, query]);


  // --- Render Helpers ---

  const getIcon = (type: string) => {
    switch (type) {
      case 'link': return <LinkIcon size={12} />;
      case 'image': return <ImageIcon size={12} />;
      case 'code': return <Code size={12} />;
      default: return <FileText size={12} />;
    }
  };

  const renderPreview = (clip: ClipItem) => {
    const dataUrl = clip.imageDataUrl && String(clip.imageDataUrl).startsWith("data:image/") ? clip.imageDataUrl : null;
    if (dataUrl) {
      return <img src={dataUrl} className="clip-image-preview" alt="preview" draggable={false} loading="lazy" />;
    }

    if (clip.type === "image") {
      return (
        <div className="clip-image-missing">
          <ImageIcon size={28} />
          <div style={{ fontSize: 12 }}>Image (no preview)</div>
        </div>
      );
    }

    const text = clip.contentHtml ? htmlToText(clip.contentHtml) : clip.content;
    return <div className="preview-text">{(text || "").slice(0, 300)}</div>;
  };

  const saveConfig = async () => {
    const res = await window.macos.setConfig(config);
    if (res.ok) {
      setShowSettings(false);
      void loadClips();
    }
  };

  return (
    <main 
      className="app-shell" 
      onClick={async (e) => {
        if (e.target === e.currentTarget) {
          await window.macos.toggleWindow();
        }
      }}
    >
      <div className="history-shelf" onClick={e => e.stopPropagation()}>
        <div className="toolbar">
          <div style={{ position: 'relative' }}>
            <Search 
              size={18} 
              style={{ position: 'absolute', left: 14, top: 12, color: 'rgba(255,255,255,0.4)' }} 
            />
            <input
              ref={searchInputRef}
              className="search-input"
              placeholder="Type to search..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if(e.key === 'Escape' || e.key === 'Enter') e.currentTarget.blur(); }}
            />
          </div>
        </div>

        <div className="history-container" ref={scrollContainerRef}>
          {clips.map((clip, index) => {
            const isSelected = index === selectedIndex;
            return (
              <div 
                key={clip.id} 
                className={`clip-card ${isSelected ? 'selected' : ''}`}
                data-type={clip.type}
                onClick={() => { setSelectedIndex(index); void handleCopy(clip); }}
              >
                <div className={"clip-preview" + (clip.type === "image" ? " is-image" : "")}>
                  {renderPreview(clip)}
                </div>
                
                <div className="clip-footer">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {getIcon(clip.type)}
                    <span>{clip.type}</span>
                  </div>
                  <span>{new Date(clip.createdAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
        
        {/* Empty State spacer or message */}
        {clips.length === 0 && !loading && (
          <div style={{ 
            width: '100%', 
            textAlign: 'center', 
            color: '#888', 
            fontSize: 14,
            paddingTop: 80 
          }}>
            No items found. Copy something or type to search.
          </div>
        )}

      {/* Settings Modal */}
      {showSettings && (
        <div className="settings-overlay" onClick={() => setShowSettings(false)}>
          <div className="settings-panel" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>Preferences</h2>
              <button onClick={() => setShowSettings(false)} style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
                <X size={20} />
              </button>
            </div>
            
            <div style={{ display: 'grid', gap: 16 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, marginBottom: 4, color: '#666' }}>
                  Sync API Endpoint (optional)
                </label>
                <input
                  style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ddd' }}
                  placeholder="https://your-api.example.com/v1 (empty = local only)"
                  value={config.apiBase}
                  onChange={e => setConfig({ ...config, apiBase: e.target.value })}
                />
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 12,
                    color: config.apiBase.trim() ? '#2d6a4f' : '#888'
                  }}
                >
                  {config.apiBase.trim() ? 'Remote sync: ON' : 'Remote sync: OFF (local-only)'}
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 12, marginBottom: 4, color: '#666' }}>
                  User ID (sync only)
                </label>
                <input
                  style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ddd' }}
                  value={config.userId}
                  disabled={!config.apiBase.trim()}
                  onChange={e => setConfig({ ...config, userId: e.target.value })}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 12, marginBottom: 4, color: '#666' }}>
                  Device ID (sync only)
                </label>
                <input
                  style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ddd' }}
                  value={config.deviceId}
                  disabled={!config.apiBase.trim()}
                  onChange={e => setConfig({ ...config, deviceId: e.target.value })}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 12, marginBottom: 4, color: '#666' }}>
                  Local retention
                </label>
                <select
                  style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid #ddd' }}
                  value={config.retention}
                  onChange={e =>
                    setConfig({ ...config, retention: e.target.value as AppConfig['retention'] })
                  }
                >
                  <option value="30d">30 days</option>
                  <option value="180d">6 months</option>
                  <option value="365d">1 year</option>
                  <option value="forever">Forever</option>
                </select>
                <div style={{ marginTop: 6, fontSize: 12, color: '#888' }}>
                  Favorites are kept when expiring.
                </div>
              </div>

              <div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={config.autoCapture}
                    onChange={e => setConfig({ ...config, autoCapture: e.target.checked })}
                  />
                  Auto-capture clipboard history
                </label>
              </div>

              <button 
                onClick={saveConfig}
                style={{ 
                  marginTop: 10, 
                  background: '#007aff', 
                  color: 'white', 
                  border: 'none', 
                  padding: '10px', 
                  borderRadius: 8, 
                  fontWeight: 600,
                  cursor: 'pointer' 
                }}
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
