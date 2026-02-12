import type { ApiResponse, ClipType } from "@paste/shared";

interface Env {
  APP_NAME: string;
  API_VERSION: string;
  DB?: D1Database;
  CACHE?: KVNamespace;
}

type ClipRecord = {
  id: string;
  userId: string;
  deviceId: string;
  type: ClipType;
  summary: string;
  content: string;
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
  isFavorite?: boolean;
  isDeleted?: boolean;
  tags?: string[];
  clientUpdatedAt?: number;
};

type Identity = {
  userId: string;
  deviceId: string;
};

const MAX_LIST_LIMIT = 200;
const MAX_SYNC_LIMIT = 300;
const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_SYNC_LIMIT = 100;
const RECENT_CLIPS_CACHE_TTL_SECONDS = 20;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, x-user-id, x-device-id"
};

const CLIP_TYPES = new Set<ClipType>(["text", "link", "code", "image"]);

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

const getIdentity = (request: Request): Identity | Response => {
  const userId = request.headers.get("x-user-id")?.trim() ?? "";
  const deviceId = request.headers.get("x-device-id")?.trim() ?? "";

  if (!userId || !deviceId) {
    return fail(
      "IDENTITY_REQUIRED",
      "Headers x-user-id and x-device-id are required before auth is enabled.",
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

const buildSummary = (content: string, summary?: string): string => {
  const normalized = summary?.trim() || content.trim().slice(0, 120);
  return normalized || "Untitled";
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

const recentClipsCacheKey = (userId: string): string => `clips:recent:${userId}`;

const readRecentClipsCache = async (
  cache: KVNamespace | undefined,
  userId: string
): Promise<{ items: ClipRecord[]; nextCursor: string | null; hasMore: boolean } | null> => {
  if (!cache) {
    return null;
  }
  try {
    const raw = await cache.get(recentClipsCacheKey(userId));
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
  payload: { items: ClipRecord[]; nextCursor: string | null; hasMore: boolean }
): Promise<void> => {
  if (!cache) {
    return;
  }
  try {
    await cache.put(recentClipsCacheKey(userId), JSON.stringify(payload), {
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
    await cache.delete(recentClipsCacheKey(userId));
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
        `SELECT id, user_id, device_id, type, summary, content, is_favorite, is_deleted,
                client_updated_at, server_updated_at, created_at
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

const rowToClip = (row: ClipRow, tags: string[]): ClipRecord => ({
  id: row.id,
  userId: row.user_id,
  deviceId: row.device_id,
  type: row.type,
  summary: row.summary,
  content: row.content,
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
  const ids: string[] = [];
  const normalizedNames = Array.from(
    new Set(
      names
        .map(normalizeTagName)
        .filter(Boolean)
        .slice(0, 20)
    )
  );

  for (const name of normalizedNames) {
    const key = normalizeTagKey(name);
    const existing = await db
      .prepare(
        `SELECT id
         FROM tags
         WHERE user_id = ?1 AND normalized_name = ?2
         LIMIT 1`
      )
      .bind(userId, key)
      .first<{ id: string }>();

    if (existing?.id) {
      await db
        .prepare(
          `UPDATE tags
           SET name = ?3, is_deleted = 0, updated_at = ?4
           WHERE user_id = ?1 AND normalized_name = ?2`
        )
        .bind(userId, key, name, now)
        .run();
      ids.push(existing.id);
      continue;
    }

    const id = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO tags (id, user_id, name, normalized_name, is_deleted, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)`
      )
      .bind(id, userId, name, key, now)
      .run();
    ids.push(id);
  }

  return ids;
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
  for (const tagId of tagIds) {
    await db
      .prepare(
        `INSERT INTO clip_tags (user_id, clip_id, tag_id, created_at)
         VALUES (?1, ?2, ?3, ?4)`
      )
      .bind(userId, clipId, tagId, now)
      .run();
  }
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
  identity: Identity,
  change: SyncIncomingChange,
  fallbackDeviceId: string
): Promise<{ status: "applied" | "conflict"; clip: ClipRecord }> => {
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

  const type: ClipType = change.type ?? existing?.type ?? "text";
  if (!CLIP_TYPES.has(type)) {
    throw new Error("Unsupported clip type.");
  }

  const content = change.content ?? existing?.content ?? "";
  const summary = buildSummary(content, change.summary ?? existing?.summary);
  const isFavorite = change.isFavorite ?? intToBool(existing?.is_favorite ?? 0);
  const isDeleted = change.isDeleted ?? intToBool(existing?.is_deleted ?? 0);
  const createdAt = existing?.created_at ?? now;

  if (!existing) {
    await db
      .prepare(
        `INSERT INTO clips (
          id, user_id, device_id, type, summary, content, is_favorite, is_deleted,
          client_updated_at, server_updated_at, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`
      )
      .bind(
        clipId,
        identity.userId,
        incomingDeviceId,
        type,
        summary,
        content,
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
         SET device_id = ?3, type = ?4, summary = ?5, content = ?6, is_favorite = ?7, is_deleted = ?8,
             client_updated_at = ?9, server_updated_at = ?10
         WHERE user_id = ?1 AND id = ?2`
      )
      .bind(
        identity.userId,
        clipId,
        incomingDeviceId,
        type,
        summary,
        content,
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
    const cached = await readRecentClipsCache(cache, identity.userId);
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
      `(LOWER(c.summary) LIKE ?${bindIndex} OR LOWER(c.content) LIKE ?${bindIndex + 1})`
    );
    binds.push(`%${q}%`, `%${q}%`);
    bindIndex += 2;
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

  const sql = `
    SELECT c.id, c.user_id, c.device_id, c.type, c.summary, c.content, c.is_favorite, c.is_deleted,
           c.client_updated_at, c.server_updated_at, c.created_at
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
    await writeRecentClipsCache(cache, identity.userId, payload);
  }

  return ok(payload);
};

const handleCreateClip = async (
  request: Request,
  db: D1Database,
  identity: Identity,
  cache?: KVNamespace
): Promise<Response> => {
  const parsed = await parseJson<{
    id?: string;
    type?: ClipType;
    summary?: string;
    content?: string;
    isFavorite?: boolean;
    isDeleted?: boolean;
    tags?: string[];
    clientUpdatedAt?: number;
  }>(request);

  if (parsed instanceof Response) {
    return parsed;
  }

  const type = parsed.type ?? "text";
  if (!CLIP_TYPES.has(type)) {
    return fail("INVALID_CLIP_TYPE", "type must be one of text/link/code/image", 400);
  }
  if (parsed.clientUpdatedAt !== undefined && !isValidTimestamp(parsed.clientUpdatedAt)) {
    return fail("INVALID_CLIENT_UPDATED_AT", "clientUpdatedAt must be a non-negative number", 400);
  }

  const change: SyncIncomingChange = {
    id: parsed.id ?? crypto.randomUUID(),
    type,
    summary: parsed.summary,
    content: parsed.content ?? "",
    isFavorite: parsed.isFavorite ?? false,
    isDeleted: parsed.isDeleted ?? false,
    tags: parsed.tags ?? [],
    clientUpdatedAt: parsed.clientUpdatedAt
  };

  const result = await applyClipChange(db, identity, change, identity.deviceId);
  await invalidateRecentClipsCache(cache, identity.userId);
  return ok(result.clip, 201);
};

const handlePatchClip = async (
  request: Request,
  db: D1Database,
  identity: Identity,
  clipId: string,
  cache?: KVNamespace
): Promise<Response> => {
  const parsed = await parseJson<{
    type?: ClipType;
    summary?: string;
    content?: string;
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
    return fail("INVALID_CLIP_TYPE", "type must be one of text/link/code/image", 400);
  }
  if (parsed.clientUpdatedAt !== undefined && !isValidTimestamp(parsed.clientUpdatedAt)) {
    return fail("INVALID_CLIENT_UPDATED_AT", "clientUpdatedAt must be a non-negative number", 400);
  }

  const existing = await fetchClipById(db, identity.userId, clipId);
  if (!existing) {
    return fail("NOT_FOUND", "clip not found", 404);
  }

  const result = await applyClipChange(
    db,
    identity,
    {
      id: clipId,
      deviceId: parsed.deviceId,
      type: parsed.type,
      summary: parsed.summary,
      content: parsed.content,
      isFavorite: parsed.isFavorite,
      isDeleted: parsed.isDeleted,
      tags: parsed.tags,
      clientUpdatedAt: parsed.clientUpdatedAt
    },
    identity.deviceId
  );

  if (result.status === "conflict") {
    return fail("CONFLICT", "incoming change is older than server record", 409);
  }

  await invalidateRecentClipsCache(cache, identity.userId);
  return ok(result.clip);
};

const handleDeleteClip = async (
  request: Request,
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
    identity,
    {
      id: clipId,
      isDeleted: true,
      clientUpdatedAt: parsed.clientUpdatedAt
    },
    identity.deviceId
  );

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
  const since = Number(url.searchParams.get("since") ?? 0);
  const limit = parseLimit(url.searchParams.get("limit"), DEFAULT_SYNC_LIMIT, MAX_SYNC_LIMIT);

  if (!Number.isFinite(since) || since < 0) {
    return fail("INVALID_SINCE", "since must be a non-negative number", 400);
  }

  const rows = await db
    .prepare(
      `SELECT id, user_id, device_id, type, summary, content, is_favorite, is_deleted,
              client_updated_at, server_updated_at, created_at
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
      return fail("INVALID_CLIP_TYPE", "type must be one of text/link/code/image", 400);
    }

    if (change.clientUpdatedAt !== undefined && !isValidTimestamp(change.clientUpdatedAt)) {
      return fail("INVALID_CLIENT_UPDATED_AT", "clientUpdatedAt must be a non-negative number", 400);
    }

    const result = await applyClipChange(db, identity, change, identity.deviceId);
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

const getClipIdFromPath = (path: string): string | null => {
  const match = path.match(/^\/v1\/clips\/([^/]+)$/);
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

      const identityOrError = getIdentity(request);
      if (identityOrError instanceof Response) {
        return identityOrError;
      }
      const identity = identityOrError;

      if (request.method === "GET" && path === "/v1/clips") {
        return handleListClips(request, db, identity, env.CACHE);
      }

      if (request.method === "POST" && path === "/v1/clips") {
        return handleCreateClip(request, db, identity, env.CACHE);
      }

      if (request.method === "PATCH") {
        const clipId = getClipIdFromPath(path);
        if (clipId) {
          return handlePatchClip(request, db, identity, clipId, env.CACHE);
        }
      }

      if (request.method === "DELETE") {
        const clipId = getClipIdFromPath(path);
        if (clipId) {
          return handleDeleteClip(request, db, identity, clipId, env.CACHE);
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
        return handleSyncPush(request, db, identity, env.CACHE);
      }

      return fail("NOT_FOUND", "Route not found", 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      return fail("INTERNAL_ERROR", message, 500);
    }
  }
} satisfies ExportedHandler<Env>;
