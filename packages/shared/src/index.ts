export type ClipType = "text" | "link" | "code" | "html" | "image";

export interface ClipItem {
  id: string;
  userId: string;
  deviceId: string;
  type: ClipType;
  summary: string;
  content: string;
  contentHtml?: string | null;
  sourceUrl?: string | null;
  imageDataUrl?: string | null;
  isFavorite: boolean;
  isDeleted: boolean;
  tags: string[];
  clientUpdatedAt: number;
  serverUpdatedAt: number;
  createdAt: number;
}

export interface ClipListResponse {
  items: ClipItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface SyncPullResponse {
  changes: ClipItem[];
  nextSince: number;
  hasMore: boolean;
}

export interface SyncPushResponse {
  applied: ClipItem[];
  conflicts: ClipItem[];
  serverTime: number;
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  code: string;
  message: string;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export const API_VERSION = "v1";
