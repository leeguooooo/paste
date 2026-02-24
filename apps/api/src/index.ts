import type { ApiResponse, ClipType } from "@paste/shared";

interface Env {
  APP_NAME: string;
  API_VERSION: string;
  DB?: D1Database;
  CACHE?: KVNamespace;
  IMAGES?: R2Bucket;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  AUTH_SECRET?: string;
  ALLOW_HEADER_IDENTITY?: string;
  AUTH_GITHUB_REDIRECT_URI?: string;
}

type ClipRecord = {
  id: string;
  userId: string;
  deviceId: string;
  type: ClipType;
  summary: string;
  content: string;
  contentHtml: string | null;
  sourceUrl: string | null;
  imageDataUrl: string | null;
  imagePreviewDataUrl: string | null;
  imageUrl: string | null;
  isFavorite: boolean;
  isDeleted: boolean;
  tags: string[];
  clientUpdatedAt: number;
  serverUpdatedAt: number;
  createdAt: number;
};

type ClipRow = {
  id: string;
  user_id: string;
  device_id: string;
  type: ClipType;
  summary: string;
  content: string;
  content_html: string | null;
  source_url: string | null;
  image_data_url: string | null;
  image_object_key: string | null;
  image_mime: string | null;
  image_bytes: number | null;
  image_sha256: string | null;
  image_preview_data_url: string | null;
  is_favorite: number;
  is_deleted: number;
  client_updated_at: number;
  server_updated_at: number;
  created_at: number;
};

type CursorParts = {
  t: number;
  id: string;
};

type SyncIncomingChange = {
  id: string;
  deviceId?: string;
  type?: ClipType;
  summary?: string;
  content?: string;
  contentHtml?: string | null;
  sourceUrl?: string | null;
  imageDataUrl?: string | null;
  imagePreviewDataUrl?: string | null;
  isFavorite?: boolean;
  isDeleted?: boolean;
  tags?: string[];
  clientUpdatedAt?: number;
};

type Identity = {
  userId: string;
  deviceId: string;
};

type AuthSession = {
  v: 1;
  sub: string;
  gh: string;
  gid: number;
  iat: number;
  exp: number;
};

type GithubUser = {
  id: number;
  login: string;
};

const MAX_LIST_LIMIT = 200;
const MAX_SYNC_LIMIT = 300;
const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_SYNC_LIMIT = 100;
const RECENT_CLIPS_CACHE_TTL_SECONDS = 20;
const MAX_IMAGE_DATA_URL_LENGTH_D1 = 1_500_000;
// Upper bound for accepting image uploads when R2 is enabled. Still keep this
// conservative to avoid oversized JSON payloads in Workers.
const MAX_IMAGE_DATA_URL_LENGTH_UPLOAD = 12_000_000;
const AUTH_SESSION_COOKIE = "paste_session";
const AUTH_GITHUB_STATE_COOKIE = "paste_oauth_state";
const AUTH_GITHUB_NEXT_COOKIE = "paste_oauth_next";
const AUTH_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const AUTH_OAUTH_STATE_TTL_SECONDS = 10 * 60;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, x-user-id, x-device-id"
};

const CLIP_TYPES = new Set<ClipType>(["text", "link", "code", "html", "image"]);

const json = <T>(data: ApiResponse<T>, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...CORS_HEADERS
    }
  });

const ok = <T>(data: T, status = 200): Response => json({ ok: true, data }, status);

const fail = (code: string, message: string, status: number): Response =>
  json({ ok: false, code, message }, status);

const toBase64Url = (raw: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < raw.length; i++) {
    s += String.fromCharCode(raw[i]);
  }
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

const fromBase64Url = (raw: string): Uint8Array => {
  const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const decoded = atob(padded);
  const out = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) {
    out[i] = decoded.charCodeAt(i);
  }
  return out;
};

const parseCookies = (request: Request): Map<string, string> => {
  const map = new Map<string, string>();
  const raw = request.headers.get("cookie") ?? "";
  const chunks = raw.split(";");
  for (const part of chunks) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    map.set(key, value);
  }
  return map;
};

const isSecureRequest = (request: Request): boolean => {
  const proto = request.headers.get("x-forwarded-proto")?.trim().toLowerCase();
  if (proto === "https") return true;
  if (proto === "http") return false;
  return new URL(request.url).protocol === "https:";
};

const serializeCookie = (
  name: string,
  value: string,
  options: {
    maxAge?: number;
    path?: string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Lax" | "Strict" | "None";
  } = {}
): string => {
  const parts = [`${name}=${value}`];
  parts.push(`Path=${options.path ?? "/"}`);
  if (typeof options.maxAge === "number") {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (options.httpOnly !== false) {
    parts.push("HttpOnly");
  }
  if (options.secure !== false) {
    parts.push("Secure");
  }
  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
  return parts.join("; ");
};

const redirectWithCookies = (location: string, cookies: string[] = []): Response => {
  const headers = new Headers();
  headers.set("location", location);
  headers.set("cache-control", "no-store");
  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }
  return new Response(null, { status: 302, headers });
};

const allowHeaderIdentity = (env: Env): boolean => env.ALLOW_HEADER_IDENTITY !== "0";

const hmacSign = async (secret: string, message: string): Promise<string> => {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return toBase64Url(new Uint8Array(sig));
};

const parseSessionPayload = (token: string): AuthSession | null => {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  try {
    const jsonRaw = new TextDecoder().decode(fromBase64Url(parts[0]));
    const parsed = JSON.parse(jsonRaw) as Partial<AuthSession>;
    if (!parsed || parsed.v !== 1) return null;
    if (typeof parsed.sub !== "string" || !parsed.sub.trim()) return null;
    if (typeof parsed.gh !== "string" || !parsed.gh.trim()) return null;
    if (typeof parsed.gid !== "number" || !Number.isFinite(parsed.gid) || parsed.gid <= 0) return null;
    if (typeof parsed.iat !== "number" || !Number.isFinite(parsed.iat)) return null;
    if (typeof parsed.exp !== "number" || !Number.isFinite(parsed.exp)) return null;
    return {
      v: 1,
      sub: parsed.sub.trim(),
      gh: parsed.gh.trim(),
      gid: parsed.gid,
      iat: parsed.iat,
      exp: parsed.exp
    };
  } catch {
    return null;
  }
};

const buildSessionToken = async (env: Env, user: GithubUser): Promise<string | null> => {
  const authSecret = env.AUTH_SECRET?.trim() ?? "";
  if (!authSecret) return null;
  const now = Date.now();
  const payload: AuthSession = {
    v: 1,
    sub: user.login.toLowerCase(),
    gh: user.login,
    gid: user.id,
    iat: now,
    exp: now + AUTH_SESSION_TTL_SECONDS * 1000
  };
  const payloadRaw = new TextEncoder().encode(JSON.stringify(payload));
  const payloadB64 = toBase64Url(payloadRaw);
  const sig = await hmacSign(authSecret, payloadB64);
  return `${payloadB64}.${sig}`;
};

const readSession = async (request: Request, env: Env): Promise<AuthSession | null> => {
  const authSecret = env.AUTH_SECRET?.trim() ?? "";
  if (!authSecret) return null;
  const token = parseCookies(request).get(AUTH_SESSION_COOKIE);
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const payload = parseSessionPayload(token);
  if (!payload) return null;
  if (payload.exp <= Date.now()) return null;
  const expectedSig = await hmacSign(authSecret, parts[0]);
  if (expectedSig !== parts[1]) return null;
  return payload;
};

const readBearerSession = async (request: Request, env: Env): Promise<AuthSession | null> => {
  const raw = request.headers.get("authorization")?.trim() ?? "";
  if (!/^bearer\s+/i.test(raw)) return null;
  const token = raw.replace(/^bearer\s+/i, "").trim();
  if (!token) return null;
  const authSecret = env.AUTH_SECRET?.trim() ?? "";
  if (!authSecret) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const payload = parseSessionPayload(token);
  if (!payload) return null;
  if (payload.exp <= Date.now()) return null;
  const expectedSig = await hmacSign(authSecret, parts[0]);
  if (expectedSig !== parts[1]) return null;
  return payload;
};

const getDbOrError = (env: Env): D1Database | Response => {
  if (!env.DB) {
    return fail(
      "CONFIG_ERROR",
      "D1 binding not configured. Please bind DB in wrangler.toml with name DB.",
      500
    );
  }
  return env.DB;
};

const getIdentity = async (request: Request, env: Env): Promise<Identity | Response> => {
  const session = (await readSession(request, env)) ?? (await readBearerSession(request, env));
  const headerDeviceId = request.headers.get("x-device-id")?.trim() ?? "";
  if (session) {
    return { userId: session.sub, deviceId: headerDeviceId || "web_browser" };
  }

  if (!allowHeaderIdentity(env)) {
    return fail("AUTH_REQUIRED", "Sign in is required.", 401);
  }

  const userId = request.headers.get("x-user-id")?.trim() ?? "";
  const deviceId = headerDeviceId;
  if (!userId || !deviceId) {
    return fail(
      "IDENTITY_REQUIRED",
      "Sign in with GitHub or provide headers x-user-id and x-device-id.",
      400
    );
  }
  return { userId, deviceId };
};

const parseJson = async <T>(request: Request): Promise<T | Response> => {
  try {
    return (await request.json()) as T;
  } catch {
    return fail("INVALID_JSON", "Request body must be valid JSON.", 400);
  }
};

const normalizeTagName = (name: string): string => name.trim().replace(/\s+/g, " ");

const normalizeTagKey = (name: string): string => normalizeTagName(name).toLowerCase();

const isProbablyUrl = (value: string): boolean => /^https?:\/\/\S+$/i.test(value.trim());

const isImageDataUrl = (value: string): boolean => /^data:image\/[^;]+;base64,/i.test(value.trim());

const parseBase64DataUrl = (value: string): { mime: string; bytes: Uint8Array } | null => {
  const trimmed = value.trim();
  if (!isImageDataUrl(trimmed)) return null;
  const comma = trimmed.indexOf(",");
  if (comma < 0) return null;
  const header = trimmed.slice(0, comma);
  const body = trimmed.slice(comma + 1);
  const match = header.match(/^data:([^;]+);base64$/i);
  const mime = match?.[1]?.trim() || "application/octet-stream";
  try {
    const raw = atob(body);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      bytes[i] = raw.charCodeAt(i);
    }
    return { mime, bytes };
  } catch {
    return null;
  }
};

const bytesToHex = (bytes: ArrayBuffer): string => {
  const arr = new Uint8Array(bytes);
  let out = "";
  for (const b of arr) out += b.toString(16).padStart(2, "0");
  return out;
};

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", ab);
  return bytesToHex(digest);
};

const extractUrlFromHtml = (value: string): string | null => {
  // Only treat actual anchor tags as link sources; other tags may contain href
  // attributes (e.g. <link ...>) which should not make the clip a URL.
  const match = value.match(/<a\b[^>]*\bhref\s*=\s*['"]([^'"]+)['"]/i);
  if (!match?.[1]) {
    return null;
  }
  return isProbablyUrl(match[1]) ? match[1] : null;
};

const inferClipType = (
  incoming: SyncIncomingChange,
  existing?: ClipRow | null
): ClipType => {
  if (incoming.type && CLIP_TYPES.has(incoming.type)) {
    return incoming.type;
  }
  if (
    incoming.imageDataUrl ||
    incoming.imagePreviewDataUrl ||
    existing?.image_data_url ||
    existing?.image_object_key ||
    existing?.image_preview_data_url
  ) {
    return "image";
  }
  if (incoming.contentHtml || existing?.content_html) {
    const content = incoming.content ?? existing?.content ?? "";
    const sourceUrl = incoming.sourceUrl ?? existing?.source_url;
    if (sourceUrl || isProbablyUrl(content) || extractUrlFromHtml(incoming.contentHtml ?? "")) {
      return "link";
    }
    return "html";
  }
  const content = incoming.content ?? existing?.content ?? "";
  const sourceUrl = incoming.sourceUrl ?? existing?.source_url;
  if (sourceUrl || isProbablyUrl(content)) {
    return "link";
  }
  return (existing?.type as ClipType | undefined) ?? "text";
};

const buildSummary = (
  content: string,
  summary: string | undefined,
  type: ClipType,
  sourceUrl?: string | null,
  html?: string | null
): string => {
  const explicit = summary?.trim();
  if (explicit) {
    return explicit;
  }

  if (type === "link") {
    if (sourceUrl?.trim()) {
      return sourceUrl.trim().slice(0, 120);
    }
    if (isProbablyUrl(content)) {
      return content.trim().slice(0, 120);
    }
  }

  if (type === "image") {
    return "Image";
  }

  const fromText = content.trim();
  if (fromText) {
    return fromText.slice(0, 120);
  }

  const fromHtml = (html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (fromHtml) {
    return fromHtml.slice(0, 120);
  }

  return "Untitled";
};

const parseLimit = (raw: string | null, fallback: number, max: number): number => {
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(num), max);
};

const encodeCursor = (parts: CursorParts): string =>
  btoa(JSON.stringify(parts)).replace(/=+$/g, "");

const decodeCursor = (raw: string | null): CursorParts | null => {
  if (!raw) {
    return null;
  }

  try {
    const normalized = raw + "=".repeat((4 - (raw.length % 4 || 4)) % 4);
    const value = JSON.parse(atob(normalized)) as CursorParts;
    if (!value || typeof value.id !== "string" || !Number.isFinite(value.t)) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
};

const boolToInt = (value: boolean): number => (value ? 1 : 0);

const intToBool = (value: number): boolean => value === 1;

const isValidTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const coalesceNullable = (incoming: string | null | undefined, current: string | null): string | null => {
  if (incoming === undefined) {
    return current;
  }
  if (incoming === null) {
    return null;
  }
  const trimmed = incoming.trim();
  return trimmed ? trimmed : null;
};

const validateRichFields = (incoming: {
  imageDataUrl?: string | null;
  imagePreviewDataUrl?: string | null;
  contentHtml?: string | null;
  sourceUrl?: string | null;
}): Response | null => {
  if (incoming.imageDataUrl && !isImageDataUrl(incoming.imageDataUrl)) {
    return fail("INVALID_IMAGE_DATA_URL", "imageDataUrl must be a base64 data:image/* URL", 400);
  }
  if (incoming.imagePreviewDataUrl && !isImageDataUrl(incoming.imagePreviewDataUrl)) {
    return fail(
      "INVALID_IMAGE_PREVIEW_DATA_URL",
      "imagePreviewDataUrl must be a base64 data:image/* URL",
      400
    );
  }
  if (incoming.imagePreviewDataUrl && incoming.imagePreviewDataUrl.length > MAX_IMAGE_DATA_URL_LENGTH_D1) {
    return fail(
      "IMAGE_PREVIEW_TOO_LARGE",
      `imagePreviewDataUrl is too large (max ${MAX_IMAGE_DATA_URL_LENGTH_D1} chars)`,
      400
    );
  }

  if (incoming.sourceUrl && !isProbablyUrl(incoming.sourceUrl)) {
    return fail("INVALID_SOURCE_URL", "sourceUrl must be a valid http/https URL", 400);
  }

  return null;
};

const recentClipsCacheKey = (userId: string, lite: boolean): string =>
  lite ? `clips:recent:lite:${userId}` : `clips:recent:${userId}`;

const readRecentClipsCache = async (
  cache: KVNamespace | undefined,
  userId: string,
  lite: boolean
): Promise<{ items: ClipRecord[]; nextCursor: string | null; hasMore: boolean } | null> => {
  if (!cache) {
    return null;
  }
  try {
    const raw = await cache.get(recentClipsCacheKey(userId, lite));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as {
      items: ClipRecord[];
      nextCursor: string | null;
      hasMore: boolean;
    };
    if (!parsed || !Array.isArray(parsed.items)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const writeRecentClipsCache = async (
  cache: KVNamespace | undefined,
  userId: string,
  lite: boolean,
  payload: { items: ClipRecord[]; nextCursor: string | null; hasMore: boolean }
): Promise<void> => {
  if (!cache) {
    return;
  }
  try {
    await cache.put(recentClipsCacheKey(userId, lite), JSON.stringify(payload), {
      expirationTtl: RECENT_CLIPS_CACHE_TTL_SECONDS
    });
  } catch {
    // Ignore cache write failures; source of truth remains D1.
  }
};

const invalidateRecentClipsCache = async (
  cache: KVNamespace | undefined,
  userId: string
): Promise<void> => {
  if (!cache) {
    return;
  }
  try {
    await cache.delete(recentClipsCacheKey(userId, false));
    await cache.delete(recentClipsCacheKey(userId, true));
  } catch {
    // Ignore cache invalidation failures; cache uses short TTL.
  }
};

const fetchClipById = async (
  db: D1Database,
  userId: string,
  clipId: string
): Promise<ClipRow | null> =>
  (
    await db
      .prepare(
        `SELECT id, user_id, device_id, type, summary, content, content_html, source_url, image_data_url,
                image_object_key, image_mime, image_bytes, image_sha256, image_preview_data_url,
                is_favorite, is_deleted, client_updated_at, server_updated_at, created_at
         FROM clips
         WHERE user_id = ?1 AND id = ?2`
      )
      .bind(userId, clipId)
      .first<ClipRow>()
  ) ?? null;

const fetchTagsByClipIds = async (
  db: D1Database,
  userId: string,
  clipIds: string[]
): Promise<Map<string, string[]>> => {
  const map = new Map<string, string[]>();

  if (clipIds.length === 0) {
    return map;
  }

  const placeholders = clipIds.map((_, i) => `?${i + 2}`).join(", ");
  const sql = `
    SELECT ct.clip_id AS clip_id, t.name AS name
    FROM clip_tags ct
    JOIN tags t ON t.id = ct.tag_id AND t.user_id = ct.user_id
    WHERE ct.user_id = ?1
      AND ct.clip_id IN (${placeholders})
      AND t.is_deleted = 0
    ORDER BY t.name ASC
  `;

  const result = await db
    .prepare(sql)
    .bind(userId, ...clipIds)
    .all<{ clip_id: string; name: string }>();

  for (const row of result.results ?? []) {
    const list = map.get(row.clip_id) ?? [];
    list.push(row.name);
    map.set(row.clip_id, list);
  }

  return map;
};

const buildClipImageUrl = (row: ClipRow): string | null => {
  if (!row.image_object_key) return null;
  const params = new URLSearchParams();
  params.set("u", row.user_id);
  if (row.image_sha256) {
    // Used for cache-busting when a clip's image is replaced.
    params.set("h", row.image_sha256);
  }
  return `/v1/images/${encodeURIComponent(row.id)}?${params.toString()}`;
};

const rowToClip = (row: ClipRow, tags: string[]): ClipRecord => ({
  id: row.id,
  userId: row.user_id,
  deviceId: row.device_id,
  type: row.type,
  summary: row.summary,
  content: row.content,
  contentHtml: row.content_html,
  sourceUrl: row.source_url,
  imageDataUrl: row.image_data_url,
  imagePreviewDataUrl: row.image_preview_data_url,
  imageUrl: buildClipImageUrl(row),
  isFavorite: intToBool(row.is_favorite),
  isDeleted: intToBool(row.is_deleted),
  tags,
  clientUpdatedAt: row.client_updated_at,
  serverUpdatedAt: row.server_updated_at,
  createdAt: row.created_at
});

const ensureTagIds = async (
  db: D1Database,
  userId: string,
  names: string[],
  now: number
): Promise<string[]> => {
  const pairs: { name: string; key: string; id: string }[] = [];

  // Normalize and de-dupe while keeping display name.
  const seen = new Set<string>();
  for (const raw of names) {
    const name = normalizeTagName(raw);
    if (!name) continue;
    const key = normalizeTagKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    pairs.push({ name, key, id: crypto.randomUUID() });
    if (pairs.length >= 20) break;
  }

  if (pairs.length === 0) {
    return [];
  }

  // Upsert all tags in one statement, then fetch ids in one query.
  const valuesPlaceholders = pairs.map((_, i) => {
    const base = i * 7;
    return `(?${base + 1}, ?${base + 2}, ?${base + 3}, ?${base + 4}, ?${base + 5}, ?${base + 6}, ?${base + 7})`;
  });
  const insertSql = `
    INSERT INTO tags (id, user_id, name, normalized_name, is_deleted, created_at, updated_at)
    VALUES ${valuesPlaceholders.join(", ")}
    ON CONFLICT(user_id, normalized_name) DO UPDATE SET
      name = excluded.name,
      is_deleted = 0,
      updated_at = excluded.updated_at
  `;

  const insertBinds: (string | number)[] = [];
  for (const pair of pairs) {
    insertBinds.push(pair.id, userId, pair.name, pair.key, 0, now, now);
  }

  await db.prepare(insertSql).bind(...insertBinds).run();

  const inPlaceholders = pairs.map((_, i) => `?${i + 2}`).join(", ");
  const rows = await db
    .prepare(
      `SELECT id, normalized_name
       FROM tags
       WHERE user_id = ?1 AND normalized_name IN (${inPlaceholders})`
    )
    .bind(userId, ...pairs.map((p) => p.key))
    .all<{ id: string; normalized_name: string }>();

  const idByKey = new Map<string, string>();
  for (const row of rows.results ?? []) {
    idByKey.set(row.normalized_name, row.id);
  }

  for (const pair of pairs) {
    if (!idByKey.has(pair.key)) {
      throw new Error(`Tag upsert failed for normalized_name=${pair.key}`);
    }
  }

  return pairs.map((p) => idByKey.get(p.key) ?? p.id);
};

const replaceClipTags = async (
  db: D1Database,
  userId: string,
  clipId: string,
  tagNames: string[] | undefined,
  now: number
): Promise<void> => {
  if (!tagNames) {
    return;
  }

  await db
    .prepare("DELETE FROM clip_tags WHERE user_id = ?1 AND clip_id = ?2")
    .bind(userId, clipId)
    .run();

  const tagIds = await ensureTagIds(db, userId, tagNames, now);
  if (tagIds.length === 0) {
    return;
  }

  const placeholders = tagIds.map((_, i) => {
    const base = i * 4;
    return `(?${base + 1}, ?${base + 2}, ?${base + 3}, ?${base + 4})`;
  });
  const binds: (string | number)[] = [];
  for (const tagId of tagIds) {
    binds.push(userId, clipId, tagId, now);
  }

  await db
    .prepare(
      `INSERT INTO clip_tags (user_id, clip_id, tag_id, created_at)
       VALUES ${placeholders.join(", ")}`
    )
    .bind(...binds)
    .run();
};

const fetchClipWithTags = async (
  db: D1Database,
  userId: string,
  clipId: string
): Promise<ClipRecord | null> => {
  const row = await fetchClipById(db, userId, clipId);
  if (!row) {
    return null;
  }
  const map = await fetchTagsByClipIds(db, userId, [clipId]);
  return rowToClip(row, map.get(clipId) ?? []);
};

const applyClipChange = async (
  db: D1Database,
  env: Env,
  identity: Identity,
  change: SyncIncomingChange,
  fallbackDeviceId: string
): Promise<{ status: "applied" | "conflict"; clip: ClipRecord } | Response> => {
  const now = Date.now();
  const clipId = change.id || crypto.randomUUID();
  const incomingClientUpdatedAt = change.clientUpdatedAt ?? now;
  const incomingDeviceId = change.deviceId?.trim() || fallbackDeviceId;
  const existing = await fetchClipById(db, identity.userId, clipId);

  if (existing && incomingClientUpdatedAt < existing.client_updated_at) {
    const current = await fetchClipWithTags(db, identity.userId, clipId);
    if (!current) {
      throw new Error("Current clip missing after conflict check.");
    }
    return { status: "conflict", clip: current };
  }

  const type = inferClipType(change, existing);
  if (!CLIP_TYPES.has(type)) {
    throw new Error("Unsupported clip type.");
  }

  let content = (change.content ?? existing?.content ?? "").trim();
  let contentHtml = coalesceNullable(change.contentHtml, existing?.content_html ?? null);
  let sourceUrl = coalesceNullable(change.sourceUrl, existing?.source_url ?? null);
  let imageDataUrl: string | null = existing?.image_data_url ?? null;
  let imagePreviewDataUrl: string | null = existing?.image_preview_data_url ?? null;
  let imageObjectKey: string | null = existing?.image_object_key ?? null;
  let imageMime: string | null = existing?.image_mime ?? null;
  let imageBytes: number | null = existing?.image_bytes ?? null;
  let imageSha256: string | null = existing?.image_sha256 ?? null;

  // Image updates are special: when IMAGES (R2) is configured we prefer storing
  // larger blobs in R2 and keep only small previews/metadata in D1.
  if (change.imageDataUrl !== undefined) {
    const nextImageDataUrl = coalesceNullable(change.imageDataUrl, imageDataUrl);
    if (!nextImageDataUrl) {
      imageDataUrl = null;
      imagePreviewDataUrl = change.imagePreviewDataUrl !== undefined ? coalesceNullable(change.imagePreviewDataUrl, null) : null;
      imageObjectKey = null;
      imageMime = null;
      imageBytes = null;
      imageSha256 = null;
    } else {
      // New image blob provided.
      const trimmed = nextImageDataUrl.trim();
      const maxLen = env.IMAGES ? MAX_IMAGE_DATA_URL_LENGTH_UPLOAD : MAX_IMAGE_DATA_URL_LENGTH_D1;
      if (trimmed.length > maxLen) {
        return fail("IMAGE_TOO_LARGE", `imageDataUrl is too large (max ${maxLen} chars)`, 400);
      }
      const INLINE_IMAGE_DATA_URL_LENGTH_MAX = 250_000;

      if (env.IMAGES && trimmed.length > INLINE_IMAGE_DATA_URL_LENGTH_MAX) {
        const parsed = parseBase64DataUrl(trimmed);
        if (!parsed) {
          return fail("INVALID_IMAGE_DATA_URL", "imageDataUrl must be a base64 data:image/* URL", 400);
        }

        const sha = await sha256Hex(parsed.bytes);
        const key = `images/${identity.userId}/${sha}`;
        const exists = await env.IMAGES.head(key);
        if (!exists) {
          await env.IMAGES.put(key, parsed.bytes, {
            httpMetadata: {
              contentType: parsed.mime,
              cacheControl: "public, max-age=31536000, immutable"
            }
          });
        }

        imageDataUrl = null;
        imageObjectKey = key;
        imageMime = parsed.mime;
        imageBytes = parsed.bytes.length;
        imageSha256 = sha;
        imagePreviewDataUrl =
          change.imagePreviewDataUrl !== undefined
            ? coalesceNullable(change.imagePreviewDataUrl, null)
            : null;
      } else {
        // Inline in D1 (small images) to avoid extra R2 reads/ops on free tiers.
        imageDataUrl = trimmed;
        imageObjectKey = null;
        imageMime = null;
        imageBytes = null;
        imageSha256 = null;
        imagePreviewDataUrl =
          change.imagePreviewDataUrl !== undefined
            ? coalesceNullable(change.imagePreviewDataUrl, trimmed)
            : trimmed;
      }
    }
  } else if (change.imagePreviewDataUrl !== undefined) {
    // Allow updating preview independently (e.g. backfill after migration).
    imagePreviewDataUrl = coalesceNullable(change.imagePreviewDataUrl, imagePreviewDataUrl);
  }

  if (!sourceUrl && isProbablyUrl(content)) {
    sourceUrl = content;
  }
  if (!sourceUrl && contentHtml) {
    sourceUrl = extractUrlFromHtml(contentHtml);
  }

  if (type === "image" && !content) {
    content = "[Image]";
  }
  if (type === "link" && !content && sourceUrl) {
    content = sourceUrl;
  }

  const validationError = validateRichFields({ imageDataUrl, imagePreviewDataUrl, contentHtml, sourceUrl });
  if (validationError) {
    return validationError;
  }

  const summary = buildSummary(content, change.summary ?? existing?.summary, type, sourceUrl, contentHtml);
  const isFavorite = change.isFavorite ?? intToBool(existing?.is_favorite ?? 0);
  const isDeleted = change.isDeleted ?? intToBool(existing?.is_deleted ?? 0);
  const createdAt = existing?.created_at ?? now;

  if (!existing) {
    await db
      .prepare(
        `INSERT INTO clips (
          id, user_id, device_id, type, summary, content, content_html, source_url, image_data_url,
          image_object_key, image_mime, image_bytes, image_sha256, image_preview_data_url,
          is_favorite, is_deleted, client_updated_at, server_updated_at, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)`
      )
      .bind(
        clipId,
        identity.userId,
        incomingDeviceId,
        type,
        summary,
        content,
        contentHtml,
        sourceUrl,
        imageDataUrl,
        imageObjectKey,
        imageMime,
        imageBytes,
        imageSha256,
        imagePreviewDataUrl,
        boolToInt(isFavorite),
        boolToInt(isDeleted),
        incomingClientUpdatedAt,
        now,
        createdAt
      )
      .run();
  } else {
    await db
      .prepare(
        `UPDATE clips
         SET device_id = ?3, type = ?4, summary = ?5, content = ?6, content_html = ?7, source_url = ?8,
             image_data_url = ?9,
             image_object_key = ?10, image_mime = ?11, image_bytes = ?12, image_sha256 = ?13, image_preview_data_url = ?14,
             is_favorite = ?15, is_deleted = ?16,
             client_updated_at = ?17, server_updated_at = ?18
         WHERE user_id = ?1 AND id = ?2`
      )
      .bind(
        identity.userId,
        clipId,
        incomingDeviceId,
        type,
        summary,
        content,
        contentHtml,
        sourceUrl,
        imageDataUrl,
        imageObjectKey,
        imageMime,
        imageBytes,
        imageSha256,
        imagePreviewDataUrl,
        boolToInt(isFavorite),
        boolToInt(isDeleted),
        incomingClientUpdatedAt,
        now
      )
      .run();
  }

  await replaceClipTags(db, identity.userId, clipId, change.tags, now);
  const latest = await fetchClipWithTags(db, identity.userId, clipId);
  if (!latest) {
    throw new Error("Clip not found after write.");
  }

  return { status: "applied", clip: latest };
};

const handleListClips = async (
  request: Request,
  db: D1Database,
  identity: Identity,
  cache?: KVNamespace
): Promise<Response> => {
  const url = new URL(request.url);
  const lite = url.searchParams.get("lite") === "1";
  const q = url.searchParams.get("q")?.trim().toLowerCase() || "";
  const tag = normalizeTagKey(url.searchParams.get("tag") || "");
  const favoriteOnly = url.searchParams.get("favorite") === "1";
  const includeDeleted = url.searchParams.get("includeDeleted") === "1";
  const limit = parseLimit(url.searchParams.get("limit"), DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  const cursor = decodeCursor(url.searchParams.get("cursor"));
  const isDefaultRecentQuery =
    !q && !tag && !favoriteOnly && !includeDeleted && !cursor && limit === DEFAULT_LIST_LIMIT;

  if (url.searchParams.get("cursor") && !cursor) {
    return fail("INVALID_CURSOR", "cursor is invalid", 400);
  }

  if (isDefaultRecentQuery) {
    const cached = await readRecentClipsCache(cache, identity.userId, lite);
    if (cached) {
      return ok(cached);
    }
  }

  const where: string[] = ["c.user_id = ?1"];
  const binds: (string | number)[] = [identity.userId];
  let bindIndex = 2;

  if (!includeDeleted) {
    where.push("c.is_deleted = 0");
  }

  if (favoriteOnly) {
    where.push("c.is_favorite = 1");
  }

  if (q) {
    where.push(
      `(LOWER(COALESCE(c.summary, '')) LIKE ?${bindIndex} OR
        LOWER(COALESCE(c.content, '')) LIKE ?${bindIndex + 1} OR
        LOWER(COALESCE(c.content_html, '')) LIKE ?${bindIndex + 2} OR
        LOWER(COALESCE(c.source_url, '')) LIKE ?${bindIndex + 3})`
    );
    binds.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    bindIndex += 4;
  }

  if (tag) {
    where.push(
      `EXISTS (
         SELECT 1
         FROM clip_tags ct
         JOIN tags t ON t.id = ct.tag_id AND t.user_id = ct.user_id
         WHERE ct.user_id = c.user_id
           AND ct.clip_id = c.id
           AND t.normalized_name = ?${bindIndex}
           AND t.is_deleted = 0
       )`
    );
    binds.push(tag);
    bindIndex += 1;
  }

  if (cursor) {
    where.push(
      `(c.server_updated_at < ?${bindIndex} OR (c.server_updated_at = ?${bindIndex} AND c.id < ?${bindIndex + 1}))`
    );
    binds.push(cursor.t, cursor.id);
    bindIndex += 2;
  }

  const selectFields = lite
    ? `
      c.id, c.user_id, c.device_id, c.type, c.summary, c.content,
      NULL AS content_html, c.source_url, NULL AS image_data_url,
      c.image_object_key, c.image_mime, c.image_bytes, c.image_sha256,
      COALESCE(c.image_preview_data_url, c.image_data_url) AS image_preview_data_url,
      c.is_favorite, c.is_deleted,
      c.client_updated_at, c.server_updated_at, c.created_at
    `
    : `
      c.id, c.user_id, c.device_id, c.type, c.summary, c.content,
      c.content_html, c.source_url, c.image_data_url,
      c.image_object_key, c.image_mime, c.image_bytes, c.image_sha256, c.image_preview_data_url,
      c.is_favorite, c.is_deleted,
      c.client_updated_at, c.server_updated_at, c.created_at
    `;

  const sql = `
    SELECT ${selectFields}
    FROM clips c
    WHERE ${where.join(" AND ")}
    ORDER BY c.server_updated_at DESC, c.id DESC
    LIMIT ${limit + 1}
  `;

  const rows = await db.prepare(sql).bind(...binds).all<ClipRow>();
  const list = rows.results ?? [];
  const hasMore = list.length > limit;
  const trimmed = hasMore ? list.slice(0, limit) : list;
  const tagsByClip = await fetchTagsByClipIds(
    db,
    identity.userId,
    trimmed.map((item) => item.id)
  );

  const items = trimmed.map((row) => rowToClip(row, tagsByClip.get(row.id) ?? []));
  const nextCursor = hasMore
    ? encodeCursor({
        t: trimmed[trimmed.length - 1]?.server_updated_at ?? 0,
        id: trimmed[trimmed.length - 1]?.id ?? ""
      })
    : null;

  const payload = {
    items,
    nextCursor,
    hasMore
  };

  if (isDefaultRecentQuery) {
    await writeRecentClipsCache(cache, identity.userId, lite, payload);
  }

  return ok(payload);
};

const handleGetClip = async (
  db: D1Database,
  identity: Identity,
  clipId: string
): Promise<Response> => {
  const clip = await fetchClipWithTags(db, identity.userId, clipId);
  if (!clip) {
    return fail("NOT_FOUND", "clip not found", 404);
  }
  return ok(clip);
};

const handleGetImage = async (
  request: Request,
  env: Env,
  db: D1Database,
  clipId: string
): Promise<Response> => {
  const url = new URL(request.url);
  const u = url.searchParams.get("u")?.trim() ?? "";
  const h = url.searchParams.get("h")?.trim() ?? "";
  if (!u) {
    return fail("INVALID_USER", "u (userId) is required", 400);
  }
  const headerUserId = request.headers.get("x-user-id")?.trim() ?? "";
  if (headerUserId && headerUserId !== u) {
    return fail("INVALID_USER", "u must match x-user-id when provided", 400);
  }

  const clip = await fetchClipById(db, u, clipId);
  if (!clip) {
    return fail("NOT_FOUND", "clip not found", 404);
  }

  let response: Response | null = null;
  const imageSha = clip.image_sha256 || "";
  const immutable = Boolean(imageSha && h && h === imageSha);

  const cache = (caches as unknown as { default: Cache }).default;
  // Cache key includes `u` (userId) and optional `h` (sha256) to avoid collisions
  // and allow immutable caching when the image is replaced.
  const cacheKey = new Request(url.toString(), { method: "GET" });
  if (immutable) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      return cached;
    }
  }

  if (clip.image_object_key && env.IMAGES) {
    const obj = await env.IMAGES.get(clip.image_object_key);
    if (!obj) {
      return fail("NOT_FOUND", "image blob not found", 404);
    }
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    if (!headers.get("content-type")) {
      headers.set("content-type", clip.image_mime || "application/octet-stream");
    }
    headers.set("cache-control", immutable ? "public, max-age=31536000, immutable" : "public, max-age=300");
    headers.set("x-content-type-options", "nosniff");
    if (imageSha) {
      headers.set("etag", `"${imageSha}"`);
    }
    response = new Response(obj.body, { status: 200, headers });
  } else if (clip.image_data_url) {
    const parsed = parseBase64DataUrl(clip.image_data_url);
    if (!parsed) {
      return fail("INVALID_IMAGE_DATA_URL", "stored imageDataUrl is invalid", 500);
    }
    const headers = new Headers();
    headers.set("content-type", parsed.mime);
    headers.set("cache-control", "public, max-age=300");
    headers.set("x-content-type-options", "nosniff");
    const body = parsed.bytes.buffer.slice(
      parsed.bytes.byteOffset,
      parsed.bytes.byteOffset + parsed.bytes.byteLength
    ) as ArrayBuffer;
    response = new Response(body, { status: 200, headers });
  }

  if (!response) {
    return fail("NOT_FOUND", "image not available", 404);
  }

  // Only cache when the URL is immutable (h matches sha256).
  if (immutable) {
    await cache.put(cacheKey, response.clone());
  }
  return response;
};

const handleCreateClip = async (
  request: Request,
  env: Env,
  db: D1Database,
  identity: Identity,
  cache?: KVNamespace
): Promise<Response> => {
  const parsed = await parseJson<{
    id?: string;
    type?: ClipType;
    summary?: string;
    content?: string;
    contentHtml?: string | null;
    sourceUrl?: string | null;
    imageDataUrl?: string | null;
    imagePreviewDataUrl?: string | null;
    isFavorite?: boolean;
    isDeleted?: boolean;
    tags?: string[];
    clientUpdatedAt?: number;
  }>(request);

  if (parsed instanceof Response) {
    return parsed;
  }

  if (parsed.type && !CLIP_TYPES.has(parsed.type)) {
    return fail("INVALID_CLIP_TYPE", "type must be one of text/link/code/html/image", 400);
  }
  if (parsed.clientUpdatedAt !== undefined && !isValidTimestamp(parsed.clientUpdatedAt)) {
    return fail("INVALID_CLIENT_UPDATED_AT", "clientUpdatedAt must be a non-negative number", 400);
  }

  const richValidation = validateRichFields({
    contentHtml: parsed.contentHtml,
    sourceUrl: parsed.sourceUrl,
    imageDataUrl: parsed.imageDataUrl,
    imagePreviewDataUrl: parsed.imagePreviewDataUrl
  });
  if (richValidation) {
    return richValidation;
  }

  const change: SyncIncomingChange = {
    id: parsed.id ?? crypto.randomUUID(),
    type: parsed.type,
    summary: parsed.summary,
    content: parsed.content ?? "",
    contentHtml: parsed.contentHtml,
    sourceUrl: parsed.sourceUrl,
    imageDataUrl: parsed.imageDataUrl,
    imagePreviewDataUrl: parsed.imagePreviewDataUrl,
    isFavorite: parsed.isFavorite ?? false,
    isDeleted: parsed.isDeleted ?? false,
    tags: parsed.tags ?? [],
    clientUpdatedAt: parsed.clientUpdatedAt
  };

  const result = await applyClipChange(db, env, identity, change, identity.deviceId);
  if (result instanceof Response) {
    return result;
  }
  await invalidateRecentClipsCache(cache, identity.userId);
  return ok(result.clip, 201);
};

const handlePatchClip = async (
  request: Request,
  env: Env,
  db: D1Database,
  identity: Identity,
  clipId: string,
  cache?: KVNamespace
): Promise<Response> => {
  const parsed = await parseJson<{
    type?: ClipType;
    summary?: string;
    content?: string;
    contentHtml?: string | null;
    sourceUrl?: string | null;
    imageDataUrl?: string | null;
    imagePreviewDataUrl?: string | null;
    isFavorite?: boolean;
    isDeleted?: boolean;
    tags?: string[];
    clientUpdatedAt?: number;
    deviceId?: string;
  }>(request);

  if (parsed instanceof Response) {
    return parsed;
  }

  if (parsed.type && !CLIP_TYPES.has(parsed.type)) {
    return fail("INVALID_CLIP_TYPE", "type must be one of text/link/code/html/image", 400);
  }
  if (parsed.clientUpdatedAt !== undefined && !isValidTimestamp(parsed.clientUpdatedAt)) {
    return fail("INVALID_CLIENT_UPDATED_AT", "clientUpdatedAt must be a non-negative number", 400);
  }

  const richValidation = validateRichFields({
    contentHtml: parsed.contentHtml,
    sourceUrl: parsed.sourceUrl,
    imageDataUrl: parsed.imageDataUrl,
    imagePreviewDataUrl: parsed.imagePreviewDataUrl
  });
  if (richValidation) {
    return richValidation;
  }

  const existing = await fetchClipById(db, identity.userId, clipId);
  if (!existing) {
    return fail("NOT_FOUND", "clip not found", 404);
  }

  const result = await applyClipChange(
    db,
    env,
    identity,
    {
      id: clipId,
      deviceId: parsed.deviceId,
      type: parsed.type,
      summary: parsed.summary,
      content: parsed.content,
      contentHtml: parsed.contentHtml,
      sourceUrl: parsed.sourceUrl,
      imageDataUrl: parsed.imageDataUrl,
      imagePreviewDataUrl: parsed.imagePreviewDataUrl,
      isFavorite: parsed.isFavorite,
      isDeleted: parsed.isDeleted,
      tags: parsed.tags,
      clientUpdatedAt: parsed.clientUpdatedAt
    },
    identity.deviceId
  );

  if (result instanceof Response) {
    return result;
  }

  if (result.status === "conflict") {
    return fail("CONFLICT", "incoming change is older than server record", 409);
  }

  await invalidateRecentClipsCache(cache, identity.userId);
  return ok(result.clip);
};

const handleDeleteClip = async (
  request: Request,
  env: Env,
  db: D1Database,
  identity: Identity,
  clipId: string,
  cache?: KVNamespace
): Promise<Response> => {
  const existing = await fetchClipById(db, identity.userId, clipId);
  if (!existing) {
    return fail("NOT_FOUND", "clip not found", 404);
  }

  const parsed = request.headers.get("content-type")?.includes("application/json")
    ? await parseJson<{ clientUpdatedAt?: number }>(request)
    : { clientUpdatedAt: undefined };
  if (parsed instanceof Response) {
    return parsed;
  }
  if (parsed.clientUpdatedAt !== undefined && !isValidTimestamp(parsed.clientUpdatedAt)) {
    return fail("INVALID_CLIENT_UPDATED_AT", "clientUpdatedAt must be a non-negative number", 400);
  }

  const result = await applyClipChange(
    db,
    env,
    identity,
    {
      id: clipId,
      isDeleted: true,
      clientUpdatedAt: parsed.clientUpdatedAt
    },
    identity.deviceId
  );

  if (result instanceof Response) {
    return result;
  }

  if (result.status === "conflict") {
    return fail("CONFLICT", "incoming delete is older than server record", 409);
  }

  await invalidateRecentClipsCache(cache, identity.userId);
  return ok(result.clip);
};

const handleListTags = async (db: D1Database, identity: Identity): Promise<Response> => {
  const rows = await db
    .prepare(
      `SELECT t.id, t.name, t.updated_at,
              COUNT(c.id) AS clip_count
       FROM tags t
       LEFT JOIN clip_tags ct
         ON ct.tag_id = t.id AND ct.user_id = t.user_id
       LEFT JOIN clips c
         ON c.id = ct.clip_id AND c.user_id = ct.user_id AND c.is_deleted = 0
       WHERE t.user_id = ?1 AND t.is_deleted = 0
       GROUP BY t.id, t.name, t.updated_at
       ORDER BY clip_count DESC, t.name ASC`
    )
    .bind(identity.userId)
    .all<{ id: string; name: string; updated_at: number; clip_count: number }>();

  return ok(
    (rows.results ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      updatedAt: item.updated_at,
      clipCount: Number(item.clip_count || 0)
    }))
  );
};

const handleCreateTag = async (
  request: Request,
  db: D1Database,
  identity: Identity
): Promise<Response> => {
  const parsed = await parseJson<{ name?: string }>(request);
  if (parsed instanceof Response) {
    return parsed;
  }

  const name = normalizeTagName(parsed.name ?? "");
  if (!name) {
    return fail("INVALID_TAG", "name is required", 400);
  }

  const now = Date.now();
  const key = normalizeTagKey(name);
  const existing = await db
    .prepare(
      `SELECT id
       FROM tags
       WHERE user_id = ?1 AND normalized_name = ?2
       LIMIT 1`
    )
    .bind(identity.userId, key)
    .first<{ id: string }>();

  const tagId = existing?.id ?? crypto.randomUUID();
  if (existing?.id) {
    await db
      .prepare(
        `UPDATE tags
         SET name = ?3, is_deleted = 0, updated_at = ?4
         WHERE user_id = ?1 AND normalized_name = ?2`
      )
      .bind(identity.userId, key, name, now)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO tags (id, user_id, name, normalized_name, is_deleted, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)`
      )
      .bind(tagId, identity.userId, name, key, now)
      .run();
  }

  return ok({
    id: tagId,
    name,
    updatedAt: now
  });
};

const handleDeleteTag = async (
  db: D1Database,
  identity: Identity,
  tagId: string
): Promise<Response> => {
  const now = Date.now();
  const existing = await db
    .prepare("SELECT id FROM tags WHERE user_id = ?1 AND id = ?2 LIMIT 1")
    .bind(identity.userId, tagId)
    .first<{ id: string }>();

  if (!existing) {
    return fail("NOT_FOUND", "tag not found", 404);
  }

  await db
    .prepare("DELETE FROM clip_tags WHERE user_id = ?1 AND tag_id = ?2")
    .bind(identity.userId, tagId)
    .run();

  await db
    .prepare(
      `UPDATE tags
       SET is_deleted = 1, updated_at = ?3
       WHERE user_id = ?1 AND id = ?2`
    )
    .bind(identity.userId, tagId, now)
    .run();

  return ok({ id: tagId, deleted: true });
};

const handleSyncPull = async (
  request: Request,
  db: D1Database,
  identity: Identity
): Promise<Response> => {
  const url = new URL(request.url);
  const lite = url.searchParams.get("lite") === "1";
  const since = Number(url.searchParams.get("since") ?? 0);
  const limit = parseLimit(url.searchParams.get("limit"), DEFAULT_SYNC_LIMIT, MAX_SYNC_LIMIT);

  if (!Number.isFinite(since) || since < 0) {
    return fail("INVALID_SINCE", "since must be a non-negative number", 400);
  }

  const selectFields = lite
    ? `
      id, user_id, device_id, type, summary, content,
      NULL AS content_html, source_url, NULL AS image_data_url,
      image_object_key, image_mime, image_bytes, image_sha256,
      COALESCE(image_preview_data_url, image_data_url) AS image_preview_data_url,
      is_favorite, is_deleted, client_updated_at, server_updated_at, created_at
    `
    : `
      id, user_id, device_id, type, summary, content,
      content_html, source_url, image_data_url,
      image_object_key, image_mime, image_bytes, image_sha256, image_preview_data_url,
      is_favorite, is_deleted, client_updated_at, server_updated_at, created_at
    `;

  const rows = await db
    .prepare(
      `SELECT ${selectFields}
       FROM clips
       WHERE user_id = ?1 AND server_updated_at > ?2
       ORDER BY server_updated_at ASC, id ASC
       LIMIT ${limit + 1}`
    )
    .bind(identity.userId, since)
    .all<ClipRow>();

  const resultRows = rows.results ?? [];
  const hasMore = resultRows.length > limit;
  const trimmed = hasMore ? resultRows.slice(0, limit) : resultRows;
  const tagsByClip = await fetchTagsByClipIds(
    db,
    identity.userId,
    trimmed.map((item) => item.id)
  );

  const changes = trimmed.map((row) => rowToClip(row, tagsByClip.get(row.id) ?? []));
  const nextSince = trimmed.length > 0 ? trimmed[trimmed.length - 1].server_updated_at : since;

  return ok({
    changes,
    nextSince,
    hasMore
  });
};

const handleSyncPush = async (
  request: Request,
  env: Env,
  db: D1Database,
  identity: Identity,
  cache?: KVNamespace
): Promise<Response> => {
  const parsed = await parseJson<{ changes?: SyncIncomingChange[] }>(request);
  if (parsed instanceof Response) {
    return parsed;
  }

  const changes = parsed.changes ?? [];
  if (!Array.isArray(changes) || changes.length === 0) {
    return fail("INVALID_CHANGES", "changes must be a non-empty array", 400);
  }

  if (changes.length > MAX_SYNC_LIMIT) {
    return fail("SYNC_BATCH_TOO_LARGE", `changes cannot exceed ${MAX_SYNC_LIMIT}`, 400);
  }

  const applied: ClipRecord[] = [];
  const conflicts: ClipRecord[] = [];

  for (const change of changes) {
    if (!change?.id) {
      return fail("INVALID_CHANGE", "each change must include id", 400);
    }

    if (change.type && !CLIP_TYPES.has(change.type)) {
      return fail("INVALID_CLIP_TYPE", "type must be one of text/link/code/html/image", 400);
    }

    if (change.clientUpdatedAt !== undefined && !isValidTimestamp(change.clientUpdatedAt)) {
      return fail("INVALID_CLIENT_UPDATED_AT", "clientUpdatedAt must be a non-negative number", 400);
    }

    const richValidation = validateRichFields({
      contentHtml: change.contentHtml,
      sourceUrl: change.sourceUrl,
      imageDataUrl: change.imageDataUrl,
      imagePreviewDataUrl: change.imagePreviewDataUrl
    });
    if (richValidation) {
      return richValidation;
    }

    const result = await applyClipChange(db, env, identity, change, identity.deviceId);
    if (result instanceof Response) {
      return result;
    }
    if (result.status === "applied") {
      applied.push(result.clip);
    } else {
      conflicts.push(result.clip);
    }
  }

  if (applied.length > 0) {
    await invalidateRecentClipsCache(cache, identity.userId);
  }

  return ok({
    applied,
    conflicts,
    serverTime: Date.now()
  });
};

const getSafeNextPath = (raw: string | null | undefined): string => {
  const s = (raw ?? "").trim();
  if (!s || !s.startsWith("/") || s.startsWith("//")) {
    return "/";
  }
  return s;
};

const getGithubRedirectUri = (request: Request, env: Env): string => {
  const configured = env.AUTH_GITHUB_REDIRECT_URI?.trim();
  if (configured) return configured;
  const url = new URL(request.url);
  return `${url.origin}/v1/auth/github/callback`;
};

const hasGithubAuthConfig = (env: Env): boolean =>
  Boolean(env.GITHUB_CLIENT_ID?.trim() && env.GITHUB_CLIENT_SECRET?.trim() && env.AUTH_SECRET?.trim());

const handleAuthGithubStart = async (request: Request, env: Env): Promise<Response> => {
  if (!hasGithubAuthConfig(env)) {
    return fail("AUTH_CONFIG_MISSING", "GitHub auth is not configured.", 500);
  }

  const url = new URL(request.url);
  const state = crypto.randomUUID().replace(/-/g, "");
  const nextPath = getSafeNextPath(url.searchParams.get("next"));
  const authUrl = new URL("https://github.com/login/oauth/authorize");
  authUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID!.trim());
  authUrl.searchParams.set("redirect_uri", getGithubRedirectUri(request, env));
  authUrl.searchParams.set("scope", "read:user");
  authUrl.searchParams.set("state", state);

  const secure = isSecureRequest(request);
  const cookies = [
    serializeCookie(AUTH_GITHUB_STATE_COOKIE, state, {
      maxAge: AUTH_OAUTH_STATE_TTL_SECONDS,
      secure
    }),
    serializeCookie(AUTH_GITHUB_NEXT_COOKIE, encodeURIComponent(nextPath), {
      maxAge: AUTH_OAUTH_STATE_TTL_SECONDS,
      secure
    })
  ];
  return redirectWithCookies(authUrl.toString(), cookies);
};

const handleAuthGithubCallback = async (request: Request, env: Env): Promise<Response> => {
  if (!hasGithubAuthConfig(env)) {
    return fail("AUTH_CONFIG_MISSING", "GitHub auth is not configured.", 500);
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code")?.trim() ?? "";
  const returnedState = url.searchParams.get("state")?.trim() ?? "";
  if (!code || !returnedState) {
    return fail("INVALID_AUTH_CALLBACK", "code and state are required", 400);
  }

  const cookies = parseCookies(request);
  const storedState = cookies.get(AUTH_GITHUB_STATE_COOKIE) ?? "";
  const nextPath = getSafeNextPath(
    (() => {
      try {
        return decodeURIComponent(cookies.get(AUTH_GITHUB_NEXT_COOKIE) ?? "");
      } catch {
        return "/";
      }
    })()
  );
  if (!storedState || storedState !== returnedState) {
    return fail("INVALID_AUTH_STATE", "oauth state mismatch", 400);
  }

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "pastyx-auth"
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID!.trim(),
      client_secret: env.GITHUB_CLIENT_SECRET!.trim(),
      code,
      redirect_uri: getGithubRedirectUri(request, env)
    })
  });
  if (!tokenRes.ok) {
    return fail("GITHUB_TOKEN_EXCHANGE_FAILED", `github token exchange failed (${tokenRes.status})`, 502);
  }

  const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string; error_description?: string };
  const accessToken = tokenJson.access_token?.trim() ?? "";
  if (!accessToken) {
    const message = tokenJson.error_description?.trim() || tokenJson.error?.trim() || "github access token missing";
    return fail("GITHUB_TOKEN_MISSING", message, 502);
  }

  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "pastyx-auth"
    }
  });
  if (!userRes.ok) {
    return fail("GITHUB_USER_FETCH_FAILED", `github user fetch failed (${userRes.status})`, 502);
  }
  const user = (await userRes.json()) as Partial<GithubUser>;
  const githubUser: GithubUser = {
    id: Number(user.id),
    login: String(user.login ?? "").trim().toLowerCase()
  };
  if (!githubUser.login || !Number.isFinite(githubUser.id) || githubUser.id <= 0) {
    return fail("GITHUB_USER_INVALID", "github user payload is invalid", 502);
  }

  const sessionToken = await buildSessionToken(env, githubUser);
  if (!sessionToken) {
    return fail("AUTH_CONFIG_MISSING", "AUTH_SECRET is not configured.", 500);
  }

  const secure = isSecureRequest(request);
  return redirectWithCookies(nextPath, [
    serializeCookie(AUTH_SESSION_COOKIE, sessionToken, {
      maxAge: AUTH_SESSION_TTL_SECONDS,
      secure
    }),
    serializeCookie(AUTH_GITHUB_STATE_COOKIE, "", {
      maxAge: 0,
      secure
    }),
    serializeCookie(AUTH_GITHUB_NEXT_COOKIE, "", {
      maxAge: 0,
      secure
    })
  ]);
};

const handleAuthGithubDeviceStart = async (env: Env): Promise<Response> => {
  if (!hasGithubAuthConfig(env)) {
    return fail("AUTH_CONFIG_MISSING", "GitHub auth is not configured.", 500);
  }

  const form = new URLSearchParams();
  form.set("client_id", env.GITHUB_CLIENT_ID!.trim());
  form.set("scope", "read:user");

  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "pastyx-auth"
    },
    body: form.toString()
  });
  if (!res.ok) {
    return fail("GITHUB_DEVICE_START_FAILED", `github device start failed (${res.status})`, 502);
  }
  const data = (await res.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
  };
  const deviceCode = (data.device_code ?? "").trim();
  const userCode = (data.user_code ?? "").trim();
  const verificationUri = (data.verification_uri ?? "").trim();
  if (!deviceCode || !userCode || !verificationUri) {
    return fail("GITHUB_DEVICE_START_INVALID", "github device code response is invalid", 502);
  }

  return ok({
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: (data.verification_uri_complete ?? "").trim() || null,
    expiresIn: Number.isFinite(Number(data.expires_in)) ? Number(data.expires_in) : 900,
    interval: Number.isFinite(Number(data.interval)) ? Number(data.interval) : 5
  });
};

const handleAuthGithubDevicePoll = async (request: Request, env: Env): Promise<Response> => {
  if (!hasGithubAuthConfig(env)) {
    return fail("AUTH_CONFIG_MISSING", "GitHub auth is not configured.", 500);
  }
  const parsed = await parseJson<{ deviceCode?: string }>(request);
  if (parsed instanceof Response) {
    return parsed;
  }
  const deviceCode = String(parsed.deviceCode ?? "").trim();
  if (!deviceCode) {
    return fail("INVALID_DEVICE_CODE", "deviceCode is required", 400);
  }

  const form = new URLSearchParams();
  form.set("client_id", env.GITHUB_CLIENT_ID!.trim());
  form.set("device_code", deviceCode);
  form.set("grant_type", "urn:ietf:params:oauth:grant-type:device_code");

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "pastyx-auth"
    },
    body: form.toString()
  });
  if (!tokenRes.ok) {
    return fail("GITHUB_TOKEN_EXCHANGE_FAILED", `github token exchange failed (${tokenRes.status})`, 502);
  }

  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
    interval?: number;
  };

  const pendingCode = (tokenJson.error ?? "").trim();
  if (pendingCode === "authorization_pending" || pendingCode === "slow_down") {
    return ok({
      status: "pending",
      retryAfterSec: pendingCode === "slow_down" ? 10 : Number(tokenJson.interval ?? 5)
    });
  }
  if (pendingCode === "expired_token" || pendingCode === "access_denied" || pendingCode === "incorrect_device_code") {
    return ok({
      status: "denied",
      code: pendingCode,
      message: tokenJson.error_description || pendingCode
    });
  }

  const accessToken = (tokenJson.access_token ?? "").trim();
  if (!accessToken) {
    return fail(
      "GITHUB_TOKEN_MISSING",
      tokenJson.error_description?.trim() || tokenJson.error?.trim() || "github access token missing",
      502
    );
  }

  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": "pastyx-auth"
    }
  });
  if (!userRes.ok) {
    return fail("GITHUB_USER_FETCH_FAILED", `github user fetch failed (${userRes.status})`, 502);
  }
  const user = (await userRes.json()) as Partial<GithubUser>;
  const githubUser: GithubUser = {
    id: Number(user.id),
    login: String(user.login ?? "").trim().toLowerCase()
  };
  if (!githubUser.login || !Number.isFinite(githubUser.id) || githubUser.id <= 0) {
    return fail("GITHUB_USER_INVALID", "github user payload is invalid", 502);
  }

  const sessionToken = await buildSessionToken(env, githubUser);
  if (!sessionToken) {
    return fail("AUTH_CONFIG_MISSING", "AUTH_SECRET is not configured.", 500);
  }

  return ok({
    status: "approved",
    accessToken: sessionToken,
    user: {
      userId: githubUser.login,
      githubLogin: githubUser.login,
      githubId: githubUser.id
    }
  });
};

const handleAuthMe = async (request: Request, env: Env): Promise<Response> => {
  const session = (await readSession(request, env)) ?? (await readBearerSession(request, env));
  return ok({
    authenticated: Boolean(session),
    user: session
      ? {
          userId: session.sub,
          githubLogin: session.gh,
          githubId: session.gid
        }
      : null,
    headerIdentityEnabled: allowHeaderIdentity(env),
    authConfigured: hasGithubAuthConfig(env)
  });
};

const handleAuthLogout = async (request: Request): Promise<Response> => {
  const secure = isSecureRequest(request);
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    ...CORS_HEADERS
  });
  headers.append(
    "set-cookie",
    serializeCookie(AUTH_SESSION_COOKIE, "", {
      maxAge: 0,
      secure
    })
  );
  return new Response(JSON.stringify({ ok: true, data: { loggedOut: true } }), {
    status: 200,
    headers
  });
};

const getClipIdFromPath = (path: string): string | null => {
  const match = path.match(/^\/v1\/clips\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
};

const getImageIdFromPath = (path: string): string | null => {
  const match = path.match(/^\/v1\/images\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
};

const getTagIdFromPath = (path: string): string | null => {
  const match = path.match(/^\/v1\/tags\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const dbOrError = getDbOrError(env);
    if (dbOrError instanceof Response) {
      return dbOrError;
    }
    const db = dbOrError;

    try {
      if (request.method === "GET" && path === "/v1/health") {
        return ok({
          service: env.APP_NAME,
          version: env.API_VERSION,
          now: new Date().toISOString()
        });
      }

      if (request.method === "GET" && path === "/v1/auth/github/start") {
        return handleAuthGithubStart(request, env);
      }

      if (request.method === "GET" && path === "/v1/auth/github/callback") {
        return handleAuthGithubCallback(request, env);
      }

      if (request.method === "GET" && path === "/v1/auth/me") {
        return handleAuthMe(request, env);
      }

      if (request.method === "POST" && path === "/v1/auth/github/device/start") {
        return handleAuthGithubDeviceStart(env);
      }

      if (request.method === "POST" && path === "/v1/auth/github/device/poll") {
        return handleAuthGithubDevicePoll(request, env);
      }

      if (request.method === "POST" && path === "/v1/auth/logout") {
        return handleAuthLogout(request);
      }

      // Public image streaming endpoint (no-auth phase).
      // Needs to be accessible via <img src="..."> so it cannot rely on custom headers.
      if (request.method === "GET") {
        const imageId = getImageIdFromPath(path);
        if (imageId) {
          return handleGetImage(request, env, db, imageId);
        }
      }

      const identityOrError = await getIdentity(request, env);
      if (identityOrError instanceof Response) {
        return identityOrError;
      }
      const identity = identityOrError;

      if (request.method === "GET" && path === "/v1/clips") {
        return handleListClips(request, db, identity, env.CACHE);
      }

      if (request.method === "POST" && path === "/v1/clips") {
        return handleCreateClip(request, env, db, identity, env.CACHE);
      }

      if (request.method === "GET") {
        const clipId = getClipIdFromPath(path);
        if (clipId) {
          return handleGetClip(db, identity, clipId);
        }
      }

      if (request.method === "PATCH") {
        const clipId = getClipIdFromPath(path);
        if (clipId) {
          return handlePatchClip(request, env, db, identity, clipId, env.CACHE);
        }
      }

      if (request.method === "DELETE") {
        const clipId = getClipIdFromPath(path);
        if (clipId) {
          return handleDeleteClip(request, env, db, identity, clipId, env.CACHE);
        }
      }

      if (request.method === "GET" && path === "/v1/tags") {
        return handleListTags(db, identity);
      }

      if (request.method === "POST" && path === "/v1/tags") {
        return handleCreateTag(request, db, identity);
      }

      if (request.method === "DELETE") {
        const tagId = getTagIdFromPath(path);
        if (tagId) {
          return handleDeleteTag(db, identity, tagId);
        }
      }

      if (request.method === "GET" && path === "/v1/sync/pull") {
        return handleSyncPull(request, db, identity);
      }

      if (request.method === "POST" && path === "/v1/sync/push") {
        return handleSyncPush(request, env, db, identity, env.CACHE);
      }

      return fail("NOT_FOUND", "Route not found", 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      return fail("INTERNAL_ERROR", message, 500);
    }
  }
} satisfies ExportedHandler<Env>;
