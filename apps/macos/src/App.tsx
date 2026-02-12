import { useEffect, useMemo, useState } from "react";
import type { ClipItem } from "@paste/shared";

type AppConfig = {
  apiBase: string;
  userId: string;
  deviceId: string;
  autoCapture: boolean;
};

const emptyConfig: AppConfig = {
  apiBase: "https://pasteapi.misonote.com/v1",
  userId: "mac_user_demo",
  deviceId: "macos_desktop",
  autoCapture: true
};

const htmlToText = (html?: string | null): string =>
  (html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const inferTypeLabel = (clip: ClipItem): string => {
  if (clip.imageDataUrl || clip.type === "image") return "image";
  if (clip.sourceUrl || clip.type === "link") return "link";
  if (clip.contentHtml || clip.type === "html") return "html";
  return clip.type || "text";
};

export default function App() {
  const [config, setConfig] = useState<AppConfig>(emptyConfig);
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [newContent, setNewContent] = useState("");
  const [status, setStatus] = useState("Ready");

  const filteredLabel = useMemo(() => {
    if (favoriteOnly && query) return "Favorites + Search";
    if (favoriteOnly) return "Favorites";
    if (query) return "Search";
    return "All";
  }, [favoriteOnly, query]);

  const loadConfig = async (): Promise<void> => {
    try {
      const next = await window.macos.getConfig();
      setConfig(next);
    } catch (error) {
      console.error(error);
      setStatus("Load config failed");
    }
  };

  const loadClips = async (): Promise<void> => {
    setLoading(true);
    try {
      const res = await window.macos.listClips({ q: query || undefined, favorite: favoriteOnly });
      if (res?.ok) {
        setClips(res.data.items ?? []);
        setStatus(`Loaded ${res.data.items?.length ?? 0} clips`);
      } else {
        setStatus(res?.message ?? "Load clips failed");
      }
    } catch (error) {
      console.error(error);
      setStatus("Load clips failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadConfig();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void loadClips();
    }, 180);
    return () => clearTimeout(timer);
  }, [query, favoriteOnly]);

  const saveConfig = async (): Promise<void> => {
    const res = await window.macos.setConfig(config);
    if (res.ok) {
      setStatus("Config saved");
      await loadClips();
    }
  };

  const createClip = async (): Promise<void> => {
    const content = newContent.trim();
    if (!content) return;

    const res = await window.macos.createClip({ content, type: "text" });
    if (res?.ok) {
      setNewContent("");
      setStatus("Clip created");
      await loadClips();
    } else {
      setStatus(res?.message ?? "Create clip failed");
    }
  };

  const captureNow = async (): Promise<void> => {
    const res = await window.macos.captureClipboardNow();
    if (res.ok && res.captured) {
      setStatus("Captured from clipboard");
      await loadClips();
      return;
    }
    setStatus(res.reason ?? "Nothing captured");
  };

  const toggleFavorite = async (clip: ClipItem): Promise<void> => {
    const res = await window.macos.toggleFavorite(clip.id, !clip.isFavorite);
    if (res?.ok) {
      await loadClips();
    }
  };

  const deleteClip = async (id: string): Promise<void> => {
    const res = await window.macos.deleteClip(id);
    if (res?.ok) {
      await loadClips();
    }
  };

  const copyClip = async (clip: ClipItem): Promise<void> => {
    const text = clip.content || clip.sourceUrl || "";
    const res = await window.macos.writeClipboard({
      text,
      html: clip.contentHtml ?? null,
      imageDataUrl: clip.imageDataUrl ?? null
    });
    if (res?.ok) {
      setStatus(`Copied ${inferTypeLabel(clip)}`);
    } else {
      setStatus(res?.message ?? "Copy failed");
    }
  };

  const renderClipBody = (clip: ClipItem) => {
    if (clip.imageDataUrl) {
      return (
        <div className="clip-preview">
          <img className="clip-image" src={clip.imageDataUrl} alt={clip.summary || "clip image"} />
          {clip.content && clip.content !== "[Image]" ? <p className="clip-caption">{clip.content}</p> : null}
        </div>
      );
    }

    if (clip.sourceUrl || clip.type === "link") {
      return (
        <div className="clip-preview">
          <a className="clip-link" href={clip.sourceUrl || clip.content} target="_blank" rel="noreferrer">
            {clip.sourceUrl || clip.content}
          </a>
          {clip.contentHtml ? <p className="clip-rich-text">{htmlToText(clip.contentHtml).slice(0, 240)}</p> : null}
        </div>
      );
    }

    if (clip.contentHtml) {
      const plain = htmlToText(clip.contentHtml);
      return (
        <div className="clip-preview">
          <p className="clip-rich-text">{plain || "[HTML]"}</p>
          <details>
            <summary>Raw HTML</summary>
            <pre>{clip.contentHtml}</pre>
          </details>
        </div>
      );
    }

    return <pre>{clip.content}</pre>;
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>paste macOS</h1>
          <p>Paste style workflow: quick capture, search, favorite, quick paste.</p>
        </div>
        <button className="ghost" onClick={() => void window.macos.toggleWindow()}>
          Toggle Window
        </button>
      </header>

      <section className="panel settings">
        <h2>Connection</h2>
        <label>
          API Base
          <input
            value={config.apiBase}
            onChange={(event) => setConfig({ ...config, apiBase: event.target.value })}
          />
        </label>
        <label>
          User ID
          <input
            value={config.userId}
            onChange={(event) => setConfig({ ...config, userId: event.target.value })}
          />
        </label>
        <label>
          Device ID
          <input
            value={config.deviceId}
            onChange={(event) => setConfig({ ...config, deviceId: event.target.value })}
          />
        </label>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={config.autoCapture}
            onChange={(event) => setConfig({ ...config, autoCapture: event.target.checked })}
          />
          Auto capture clipboard changes
        </label>
        <button onClick={() => void saveConfig()}>Save Config</button>
      </section>

      <section className="panel quick-add">
        <h2>Quick Capture</h2>
        <div className="row">
          <textarea
            placeholder="Paste content here and save as clip..."
            value={newContent}
            onChange={(event) => setNewContent(event.target.value)}
          />
          <div className="actions">
            <button onClick={() => void createClip()}>Create Clip</button>
            <button className="ghost" onClick={() => void captureNow()}>
              Capture Clipboard Now
            </button>
            <button
              className="ghost"
              onClick={async () => {
                const content = await window.macos.readClipboard();
                setNewContent(content);
              }}
            >
              Read Clipboard
            </button>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="toolbar">
          <input
            placeholder="Search clips..."
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={favoriteOnly}
              onChange={(event) => setFavoriteOnly(event.target.checked)}
            />
            Favorites only
          </label>
          <button className="ghost" onClick={() => void loadClips()}>
            Refresh
          </button>
        </div>

        <p className="meta">View: {filteredLabel} · {loading ? "Loading..." : `${clips.length} items`}</p>

        <ul className="clip-list">
          {clips.map((clip) => (
            <li key={clip.id}>
              <div className="clip-head">
                <strong>{clip.summary || "Untitled"}</strong>
                <span>{inferTypeLabel(clip)}</span>
              </div>
              <div className="clip-subhead">
                <span>{new Date(clip.createdAt).toLocaleString()}</span>
              </div>
              {renderClipBody(clip)}
              <div className="clip-actions">
                <button className="ghost" onClick={() => void copyClip(clip)}>
                  Copy
                </button>
                <button className="ghost" onClick={() => void toggleFavorite(clip)}>
                  {clip.isFavorite ? "Unfavorite" : "Favorite"}
                </button>
                <button className="danger" onClick={() => void deleteClip(clip.id)}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <footer className="status">{status} · Global shortcut: Cmd/Ctrl + Shift + V</footer>
    </main>
  );
}
