import { useEffect, useState } from "react";

const API_BASE = (import.meta.env.VITE_API_BASE || "/v1").replace(/\/+$/, "");
const RELEASES_URL = "https://github.com/leeguooooo/paste/releases/latest";

type ShareData = {
  code: string;
  type: string;
  content: string | null;
  contentHtml: string | null;
  sourceUrl: string | null;
  imageDataUrl: string | null;
  createdAt: number;
  expiresAt: number;
  views: number;
};

const hostOf = (url: string): string => {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const expiryLabel = (expiresAt: number): string => {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return "已过期";
  const h = Math.floor(ms / 3_600_000);
  if (h >= 1) return `${h} 小时后过期`;
  const m = Math.max(1, Math.floor(ms / 60_000));
  return `${m} 分钟后过期`;
};

export default function ShareView({ code }: { code: string }) {
  const [state, setState] = useState<"loading" | "ok" | "missing">("loading");
  const [data, setData] = useState<ShareData | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/share/${encodeURIComponent(code)}`);
        const json = await res.json();
        if (cancelled) return;
        if (res.ok && json.ok) {
          setData(json.data as ShareData);
          setState("ok");
        } else {
          setState("missing");
        }
      } catch {
        if (!cancelled) setState("missing");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  const onCopy = async () => {
    if (!data) return;
    try {
      if (data.type === "image" && data.imageDataUrl) {
        const blob = await (await fetch(data.imageDataUrl)).blob();
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      } else {
        await navigator.clipboard.writeText(data.content || data.sourceUrl || "");
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard may be blocked without a gesture; the button click is the gesture so this is rare
    }
  };

  return (
    <main className="share-page">
      <a className="share-brand" href="/">
        <span className="brand-mark" aria-hidden="true">p</span>
        <span className="brand-name">paste</span>
      </a>

      {state === "loading" && <div className="share-loading">正在打开分享…</div>}

      {state === "missing" && (
        <div className="share-box doodle-box share-missing">
          <div className="share-missing-emoji">🕳️</div>
          <h1>这个分享不存在或已过期</h1>
          <p>快传链接默认 24 小时后失效。</p>
          <a className="share-cta-btn" href="/">用 paste 管理你的剪贴板 →</a>
        </div>
      )}

      {state === "ok" && data && (
        <>
          <div className="share-box doodle-box">
            <div className="share-box-head">
              <span className="share-type">{String(data.type).toUpperCase()}</span>
              <span className="share-expiry">{expiryLabel(data.expiresAt)}</span>
            </div>

            <div className="share-content">
              {data.type === "image" && data.imageDataUrl ? (
                <img className="share-image" src={data.imageDataUrl} alt="shared" />
              ) : data.type === "link" && (data.sourceUrl || data.content) ? (
                <a className="share-link" href={data.sourceUrl || data.content || "#"} target="_blank" rel="noopener noreferrer">
                  <span className="share-link-host">{hostOf(data.sourceUrl || data.content || "")}</span>
                  <span className="share-link-url">{data.sourceUrl || data.content}</span>
                </a>
              ) : (
                <pre className="share-text">{data.content}</pre>
              )}
            </div>

            <button className={`share-copy ${copied ? "copied" : ""}`} type="button" onClick={onCopy}>
              {copied ? "已复制 ✓" : "复制 / Copy"}
            </button>
          </div>

          <div className="share-foot doodle-box">
            <p className="share-foot-title">用 paste 管理你的剪贴板</p>
            <p className="share-foot-sub">在线剪贴板 · 免安装 · 多设备实时同步</p>
            <div className="share-foot-actions">
              <a className="share-cta-btn" href="/">打开 paste →</a>
              <a className="share-cta-ghost" href={RELEASES_URL} target="_blank" rel="noopener noreferrer">下载 macOS 版</a>
            </div>
          </div>
        </>
      )}
    </main>
  );
}
