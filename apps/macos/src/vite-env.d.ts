/// <reference types="vite/client" />

declare global {
  interface Window {
    macos: {
      getConfig: () => Promise<{
        apiBase: string;
        userId: string;
        deviceId: string;
        authGithubLogin: string;
        icloudSync: boolean;
        icloudAvailable: boolean;
        autoCapture: boolean;
        launchAtLogin: boolean;
        retention: "30d" | "180d" | "365d" | "forever";
        hotkey: string;
      }>;
      setConfig: (next: {
        apiBase: string;
        userId: string;
        deviceId: string;
        authGithubLogin?: string;
        icloudSync: boolean;
        autoCapture: boolean;
        launchAtLogin: boolean;
        retention: "30d" | "180d" | "365d" | "forever";
        hotkey: string;
      }) => Promise<{ ok: boolean; message?: string }>;
      getAuthStatus: () => Promise<{
        ok: boolean;
        data?: {
          remoteEnabled: boolean;
          authenticated: boolean;
          authConfigured: boolean;
          user: { userId: string; githubLogin: string; githubId?: number } | null;
        };
        code?: string;
        message?: string;
      }>;
      startGithubDeviceAuth: () => Promise<any>;
      pollGithubDeviceAuth: (deviceCode: string) => Promise<any>;
      logoutAuth: () => Promise<any>;
      getLocalSyncStatus: () => Promise<{ ok: boolean; data?: { pendingCount: number }; message?: string }>;
      runLocalSync: () => Promise<{
        ok: boolean;
        data?: { total: number; uploaded: number; failed: number };
        message?: string;
      }>;
      dismissLocalSync: () => Promise<{ ok: boolean; data?: { skipped: boolean }; message?: string }>;
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
      openExternal: (url: string) => Promise<{ ok: boolean; data?: { ok: true }; message?: string }>;
      captureWindow: () => Promise<{ ok: boolean; dataUrl?: string; message?: string }>;
      onOpenSettings: (cb: (payload: { at?: number } | undefined) => void) => () => void;
      onClipsChanged: (cb: (payload: { source?: string; at?: number } | undefined) => void) => () => void;
      onWindowShown: (cb: (payload: { at?: number } | undefined) => void) => () => void;
      onWindowHidden: (cb: (payload: { at?: number } | undefined) => void) => () => void;
    };
  }
}

export {};
