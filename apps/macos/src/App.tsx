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
  Check,
  Globe,
  Cpu,
  Monitor
} from "lucide-react";

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

export default function App() {
  const [config, setConfig] = useState<AppConfig>(emptyConfig);
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0); 
  const [showSettings, setShowSettings] = useState(false);
  
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

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
    const timer = setTimeout(() => void loadClips(), 150);
    return () => clearTimeout(timer);
  }, [query, loadClips]);

  useEffect(() => {
    if (clips.length > 0 && selectedIndex >= clips.length) {
      setSelectedIndex(clips.length - 1);
    }
  }, [clips.length, selectedIndex]);

  useEffect(() => {
    if (!scrollContainerRef.current || clips.length === 0) return;
    const container = scrollContainerRef.current;
    const cardWidth = 280 + 24; 
    const targetScroll = (selectedIndex * cardWidth); 
    container.scrollTo({ left: targetScroll, behavior: "smooth" });
  }, [selectedIndex, clips]);

  const handleCopy = async (clip: ClipItem) => {
    const text = clip.content || clip.sourceUrl || "";
    await window.macos.writeClipboard({
      text,
      html: clip.contentHtml ?? null,
      imageDataUrl: clip.imageDataUrl ?? null
    });
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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (showSettings) return;
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
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 12 }}>
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
            <button className="icon-btn" onClick={() => setShowSettings(true)}>
              <Settings size={22} />
            </button>
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
                <div className="clip-preview">
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

      {showSettings && (
        <div className="settings-overlay" onClick={() => setShowSettings(false)}>
          <div className="settings-panel" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
              <h2 style={{ margin: 0 }}>Preferences</h2>
              <button className="icon-btn" onClick={() => setShowSettings(false)}>
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
              <button className="btn-cancel" onClick={() => setShowSettings(false)}>Cancel</button>
              <button className="btn-save" onClick={saveConfig}>Save Changes</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}