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
  Code
} from "lucide-react";

const API_BASE = "/v1";

// Default identity from localStorage for cross-device sync
const DEFAULT_USER_ID = localStorage.getItem("paste_user_id") || "user_demo";
const DEFAULT_DEVICE_ID = localStorage.getItem("paste_device_id") || "web_browser";

export default function App() {
  const [userId, setUserId] = useState(DEFAULT_USER_ID);
  const [deviceId, setDeviceId] = useState(DEFAULT_DEVICE_ID);
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0); 
  const [showSettings, setShowSettings] = useState(false);
  
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

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
    await navigator.clipboard.writeText(clip.content);
    // Visual feedback on the card
    const originalClips = [...clips];
    setClips(clips.map((c, i) => i === selectedIndex ? { ...c, summary: "✓ Copied!" } : c));
    setTimeout(() => setClips(originalClips), 1000);
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
          {clips.map((clip, index) => {
            const isSelected = index === selectedIndex;
            return (
              <div 
                key={clip.id} 
                className={`clip-card ${isSelected ? 'selected' : ''}`}
                onClick={() => { setSelectedIndex(index); void handleCopy(clip); }}
              >
                <div className="clip-preview">
                  <div className="preview-text">{clip.content}</div>
                </div>
                <div className="clip-footer">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {getIcon(clip.type)}
                    <span>{clip.type}</span>
                  </div>
                  <div className="clip-actions" onClick={e => e.stopPropagation()}>
                    <Star 
                      size={14} 
                      fill={clip.isFavorite ? "#ffcc00" : "transparent"} 
                      style={{color: clip.isFavorite ? "#ffcc00" : "inherit", cursor: 'pointer'}}
                      onClick={(e) => void handleToggleFavorite(e, clip)}
                    />
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
