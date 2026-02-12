/// <reference types="vite/client" />

declare global {
  interface Window {
    macos: {
      getConfig: () => Promise<{
        apiBase: string;
        userId: string;
        deviceId: string;
        autoCapture: boolean;
        retention: "30d" | "180d" | "365d" | "forever";
      }>;
      setConfig: (next: {
        apiBase: string;
        userId: string;
        deviceId: string;
        autoCapture: boolean;
        retention: "30d" | "180d" | "365d" | "forever";
      }) => Promise<{ ok: boolean }>;
      listClips: (query?: { q?: string; favorite?: boolean }) => Promise<any>;
      createClip: (payload: {
        content: string;
        summary?: string;
        type?: "text" | "link" | "code" | "html" | "image";
        contentHtml?: string | null;
        sourceUrl?: string | null;
        imageDataUrl?: string | null;
        tags?: string[];
      }) => Promise<any>;
      toggleFavorite: (id: string, isFavorite: boolean) => Promise<any>;
      deleteClip: (id: string) => Promise<any>;
      readClipboard: () => Promise<string>;
      writeClipboard: (
        value: string | { text?: string; html?: string | null; imageDataUrl?: string | null }
      ) => Promise<{ ok: boolean; message?: string }>;
      captureClipboardNow: () => Promise<{ ok: boolean; captured: boolean; reason?: string }>;
      toggleWindow: () => Promise<{ visible: boolean }>;
    };
  }
}

export {};
