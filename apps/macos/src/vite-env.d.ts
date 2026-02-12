/// <reference types="vite/client" />

declare global {
  interface Window {
    macos: {
      getConfig: () => Promise<{
        apiBase: string;
        userId: string;
        deviceId: string;
        autoCapture: boolean;
        launchAtLogin: boolean;
        retention: "30d" | "180d" | "365d" | "forever";
        hotkey: string;
      }>;
      setConfig: (next: {
        apiBase: string;
        userId: string;
        deviceId: string;
        autoCapture: boolean;
        launchAtLogin: boolean;
        retention: "30d" | "180d" | "365d" | "forever";
        hotkey: string;
      }) => Promise<{ ok: boolean; message?: string }>;
      listClips: (query?: { q?: string; favorite?: boolean }) => Promise<any>;
      getClip: (id: string) => Promise<any>;
      createClip: (payload: {
        content: string;
        summary?: string;
        type?: "text" | "link" | "code" | "html" | "image";
        contentHtml?: string | null;
        sourceUrl?: string | null;
        imageDataUrl?: string | null;
        imagePreviewDataUrl?: string | null;
        tags?: string[];
      }) => Promise<any>;
      toggleFavorite: (id: string, isFavorite: boolean) => Promise<any>;
      deleteClip: (id: string) => Promise<any>;
      readClipboard: () => Promise<string>;
      writeClipboard: (
        value: string | { text?: string; html?: string | null; imageDataUrl?: string | null; imageUrl?: string | null }
      ) => Promise<{ ok: boolean; message?: string }>;
      pasteAndHide: (
        value: string | { text?: string; html?: string | null; imageDataUrl?: string | null; imageUrl?: string | null }
      ) => Promise<{ ok: boolean; message?: string }>;
      captureClipboardNow: () => Promise<{ ok: boolean; captured: boolean; reason?: string }>;
      toggleWindow: () => Promise<{ visible: boolean }>;
      captureWindow: () => Promise<{ ok: boolean; dataUrl?: string; message?: string }>;
      onOpenSettings: (cb: (payload: { at?: number } | undefined) => void) => () => void;
      onClipsChanged: (cb: (payload: { source?: string; at?: number } | undefined) => void) => () => void;
      onWindowShown: (cb: (payload: { at?: number } | undefined) => void) => () => void;
      onWindowHidden: (cb: (payload: { at?: number } | undefined) => void) => () => void;
    };
  }
}

export {};
