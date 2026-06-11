const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");
const { DatabaseSync } = require("node:sqlite");
const { matchesClipQuery, projectClipForList } = require("./clip-list.cjs");

const DEFAULT_STREAM_CHUNK_SIZE = 128 * 1024;
const DEFAULT_MAX_SCAN_CLIPS = 5000;
// Soft-delete tombstones must outlive icloud sync propagation, otherwise a
// reaped tombstone lets the deleted clip resurrect from another device.
const DEFAULT_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// base64 inflates payloads by 4/3 plus json quoting/field overhead
const IMAGE_BASE64_INFLATION = 1.37;
const IMAGE_ROW_OVERHEAD_BYTES = 64;
const ROW_OVERHEAD_BYTES = 256;

// Storage layout, derived from the legacy JSON path used as the engine key:
//   <dir>/<name>.json              legacy database (imported once, then renamed *.migrated.bak)
//   <dir>/<name>.sqlite            clip metadata (WAL mode; never stores full image payloads)
//   <dir>/images/<clipId>.<ext>    full-resolution images, one file per clip
const sqlitePathFor = (file) => `${file.replace(/\.json$/i, "")}.sqlite`;
const imagesDirFor = (file) => path.join(path.dirname(file), "images");

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS clips (
  id TEXT PRIMARY KEY NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  user_id TEXT,
  device_id TEXT,
  type TEXT,
  summary TEXT,
  content TEXT,
  content_html TEXT,
  source_url TEXT,
  image_path TEXT,
  image_mime TEXT,
  image_preview_data_url TEXT,
  image_url TEXT,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]',
  client_updated_at INTEGER,
  server_updated_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT 0,
  extra TEXT
);
CREATE INDEX IF NOT EXISTS idx_clips_list_order ON clips (created_at DESC, seq DESC);
CREATE INDEX IF NOT EXISTS idx_clips_favorite ON clips (is_favorite) WHERE is_favorite = 1;
`;

// Fields persisted in dedicated columns; everything else round-trips through `extra`.
const KNOWN_CLIP_FIELDS = new Set([
  "id",
  "userId",
  "deviceId",
  "type",
  "summary",
  "content",
  "contentHtml",
  "sourceUrl",
  "imageDataUrl",
  "imagePreviewDataUrl",
  "imageUrl",
  "isFavorite",
  "isDeleted",
  "tags",
  "clientUpdatedAt",
  "serverUpdatedAt",
  "createdAt"
]);

const EXT_BY_MIME = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/svg+xml": "svg",
  "image/heic": "heic",
  "image/avif": "avif"
};

const MIME_BY_EXT = Object.fromEntries(
  Object.entries(EXT_BY_MIME).map(([mime, ext]) => [ext, mime])
);
MIME_BY_EXT.jpeg = "image/jpeg";

const parseImageDataUrl = (value) => {
  if (typeof value !== "string" || !value.startsWith("data:")) return null;
  const comma = value.indexOf(",");
  if (comma < 0) return null;
  const header = value.slice(5, comma);
  if (!/;base64$/i.test(header)) return null;
  const mime = header.replace(/;base64$/i, "").split(";")[0].trim().toLowerCase() || "application/octet-stream";
  try {
    const buffer = Buffer.from(value.slice(comma + 1), "base64");
    return { mime, buffer };
  } catch {
    return null;
  }
};

const imageFileNameForClip = (id, mime) => {
  const ext = EXT_BY_MIME[mime] || "bin";
  const safe = String(id).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  const needsHash = safe !== String(id);
  const suffix = needsHash ? `-${createHash("sha1").update(String(id)).digest("hex").slice(0, 8)}` : "";
  return `${safe}${suffix}.${ext}`;
};

const mimeForImageFile = (name) => {
  const ext = String(name).split(".").pop()?.toLowerCase() || "";
  return MIME_BY_EXT[ext] || "application/octet-stream";
};

const toFiniteOrNull = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const clipSyncTs = (clip) =>
  Math.max(
    Number(clip?.serverUpdatedAt || 0),
    Number(clip?.clientUpdatedAt || 0),
    Number(clip?.createdAt || 0)
  );

// --- legacy json streaming parser ------------------------------------------
// Kept verbatim from the old engine: it tolerates truncated / partially
// corrupted JSON databases by yielding each parseable clip object and skipping
// records that fail JSON.parse. Used only to import the legacy file.

const visitLegacyClipObjectsSync = (file, visitor, options = {}) => {
  if (typeof visitor !== "function") {
    throw new TypeError("visitor must be a function");
  }
  if (!fs.existsSync(file)) {
    return { visited: 0, stopped: false };
  }

  const chunkSize = Math.max(1024, Number(options.chunkSize || DEFAULT_STREAM_CHUNK_SIZE));
  const maxObjects = Math.max(1, Number(options.maxObjects || DEFAULT_MAX_SCAN_CLIPS));
  const fd = fs.openSync(file, "r");
  const decoder = new StringDecoder("utf8");
  const buf = Buffer.allocUnsafe(chunkSize);

  let inClipsArray = false;
  let seekBuffer = "";
  let objectText = "";
  let inObject = false;
  let inString = false;
  let escaped = false;
  let depth = 0;
  let visited = 0;
  let stopped = false;

  const feed = (text) => {
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];

      if (!inClipsArray) {
        seekBuffer = (seekBuffer + ch).slice(-4096);
        const keyIndex = seekBuffer.indexOf('"clips"');
        if (keyIndex >= 0) {
          const bracketIndex = seekBuffer.indexOf("[", keyIndex);
          if (bracketIndex >= 0) {
            inClipsArray = true;
          }
        }
        continue;
      }

      if (!inObject) {
        if (ch === "{") {
          inObject = true;
          inString = false;
          escaped = false;
          depth = 1;
          objectText = "{";
        } else if (ch === "]") {
          stopped = true;
          return false;
        }
        continue;
      }

      objectText += ch;

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
      } else if (ch === "{" || ch === "[") {
        depth += 1;
      } else if (ch === "}" || ch === "]") {
        depth -= 1;
        if (depth === 0) {
          let clip = null;
          try {
            clip = JSON.parse(objectText);
          } catch {
            clip = null;
          }
          inObject = false;
          objectText = "";
          visited += 1;
          if (clip && visitor(clip, visited) === false) {
            stopped = true;
            return false;
          }
          if (visited >= maxObjects) {
            stopped = true;
            return false;
          }
        }
      }
    }
    return true;
  };

  try {
    for (;;) {
      const bytesRead = fs.readSync(fd, buf, 0, chunkSize, null);
      if (bytesRead <= 0) break;
      if (!feed(decoder.write(buf.subarray(0, bytesRead)))) break;
    }
    if (!stopped) {
      feed(decoder.end());
    }
  } finally {
    fs.closeSync(fd);
  }

  return { visited, stopped };
};

// --- engine -----------------------------------------------------------------

const engines = new Map();

const prepareStatements = (db) => ({
  getById: db.prepare("SELECT * FROM clips WHERE id = ?"),
  listOrdered: db.prepare("SELECT * FROM clips ORDER BY created_at DESC, seq DESC LIMIT ?"),
  insert: db.prepare(`
    INSERT INTO clips (
      id, seq, user_id, device_id, type, summary, content, content_html, source_url,
      image_path, image_mime, image_preview_data_url, image_url,
      is_favorite, is_deleted, tags, client_updated_at, server_updated_at, created_at, extra
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      seq = excluded.seq,
      user_id = excluded.user_id,
      device_id = excluded.device_id,
      type = excluded.type,
      summary = excluded.summary,
      content = excluded.content,
      content_html = excluded.content_html,
      source_url = excluded.source_url,
      image_path = excluded.image_path,
      image_mime = excluded.image_mime,
      image_preview_data_url = excluded.image_preview_data_url,
      image_url = excluded.image_url,
      is_favorite = excluded.is_favorite,
      is_deleted = excluded.is_deleted,
      tags = excluded.tags,
      client_updated_at = excluded.client_updated_at,
      server_updated_at = excluded.server_updated_at,
      created_at = excluded.created_at,
      extra = excluded.extra
  `),
  deleteById: db.prepare("DELETE FROM clips WHERE id = ?"),
  countAll: db.prepare("SELECT COUNT(*) AS n FROM clips"),
  countPending: db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT is_deleted FROM clips ORDER BY created_at DESC, seq DESC LIMIT ?
    ) WHERE is_deleted = 0
  `),
  minSeq: db.prepare("SELECT COALESCE(MIN(seq), 1) AS s FROM clips"),
  maxSeq: db.prepare("SELECT COALESCE(MAX(seq), 0) AS s FROM clips"),
  imagePaths: db.prepare("SELECT image_path FROM clips WHERE image_path IS NOT NULL"),
  payloadBytes: db.prepare(`
    SELECT COALESCE(SUM(
      COALESCE(LENGTH(content), 0) +
      COALESCE(LENGTH(content_html), 0) +
      COALESCE(LENGTH(image_preview_data_url), 0) +
      ${ROW_OVERHEAD_BYTES}
    ), 0) AS bytes FROM clips
  `),
  // tombstones are only reaped once older than the ttl so deletes have time to
  // propagate through icloud sync before the row disappears
  deleteExpiredTombstones: db.prepare(`
    DELETE FROM clips WHERE is_deleted = 1
      AND MAX(
        COALESCE(server_updated_at, 0),
        COALESCE(client_updated_at, 0),
        COALESCE(created_at, 0)
      ) < ?
  `),
  deleteExpired: db.prepare("DELETE FROM clips WHERE is_favorite = 0 AND created_at < ?"),
  deleteOverCap: db.prepare(`
    DELETE FROM clips WHERE id IN (
      SELECT id FROM clips ORDER BY created_at DESC, seq DESC LIMIT -1 OFFSET ?
    )
  `)
});

const openEngine = (key) => {
  fs.mkdirSync(path.dirname(key), { recursive: true });
  const dbFile = sqlitePathFor(key);
  const db = new DatabaseSync(dbFile);
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    // Without a busy timeout a second connection (another app instance, an
    // external inspector) makes writes throw SQLITE_BUSY immediately, which
    // kicks callers into their legacy-json fallback paths.
    db.exec("PRAGMA busy_timeout = 5000;");
  } catch {
    // pragmas are best-effort; defaults remain correct, just slower
  }
  db.exec(SCHEMA_SQL);
  const st = prepareStatements(db);
  return {
    key,
    db,
    st,
    dbFile,
    imagesDir: imagesDirFor(key),
    version: 1,
    nextSeq: Math.max(1, Number(st.maxSeq.get()?.s || 0) + 1)
  };
};

const acquireEngine = (file) => {
  const key = path.resolve(String(file || ""));
  let engine = engines.get(key);
  if (!engine) {
    engine = openEngine(key);
    engines.set(key, engine);
  }
  importLegacyJsonIfPresent(engine);
  return engine;
};

const ensureImagesDir = (engine) => {
  fs.mkdirSync(engine.imagesDir, { recursive: true });
};

// Synchronous on purpose: a fire-and-forget unlink of <id>.png can land AFTER
// a newer write recreated the same path (sync upsert re-adding the clip),
// silently deleting the fresh image. Unlinking at transition time closes that
// race; the unlink of a single file is cheap next to the sqlite write.
const removeImageFileSync = (engine, imagePath) => {
  if (!imagePath) return;
  try {
    fs.rmSync(path.join(engine.imagesDir, imagePath), { force: true });
  } catch {
    // best-effort
  }
};

const loadImageDataUrlSync = (engine, row) => {
  if (!row?.image_path) return null;
  try {
    const buffer = fs.readFileSync(path.join(engine.imagesDir, row.image_path));
    const mime = row.image_mime || mimeForImageFile(row.image_path);
    return `data:${mime};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
};

const loadImageDataUrlAsync = async (engine, row) => {
  if (!row?.image_path) return null;
  try {
    const buffer = await fsp.readFile(path.join(engine.imagesDir, row.image_path));
    const mime = row.image_mime || mimeForImageFile(row.image_path);
    return `data:${mime};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
};

const parseTags = (raw) => {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const rowToClip = (engine, row, options = {}) => {
  if (!row) return null;
  let extra = null;
  if (row.extra) {
    try {
      extra = JSON.parse(row.extra);
    } catch {
      extra = null;
    }
  }
  const rawImageDataUrl =
    extra && typeof extra.__rawImageDataUrl === "string" ? extra.__rawImageDataUrl : null;
  if (extra) {
    delete extra.__rawImageDataUrl;
  }

  let imageDataUrl = null;
  if (options.hydrateImage) {
    imageDataUrl = loadImageDataUrlSync(engine, row);
  }
  if (!imageDataUrl && rawImageDataUrl) {
    imageDataUrl = rawImageDataUrl;
  }

  return {
    ...(extra && typeof extra === "object" ? extra : {}),
    id: row.id,
    userId: row.user_id ?? null,
    deviceId: row.device_id ?? null,
    type: row.type ?? null,
    summary: row.summary ?? null,
    content: row.content ?? null,
    contentHtml: row.content_html ?? null,
    sourceUrl: row.source_url ?? null,
    imageDataUrl,
    imagePreviewDataUrl: row.image_preview_data_url ?? null,
    imageUrl: row.image_url ?? null,
    isFavorite: row.is_favorite === 1,
    isDeleted: row.is_deleted === 1,
    tags: parseTags(row.tags),
    clientUpdatedAt: row.client_updated_at ?? null,
    serverUpdatedAt: row.server_updated_at ?? null,
    createdAt: row.created_at ?? 0
  };
};

// Persists one clip. Full-resolution images are written to individual files in
// <dir>/images/ (sync write: callers expect the clip readable immediately) and
// only the file path lands in sqlite. When no new image payload is provided,
// any image file already attached to the id is preserved.
const storeClipRow = (engine, clip, options = {}) => {
  const id = String(clip?.id || "").trim();
  if (!id) return false;

  const previous = engine.st.getById.get(id);
  let imagePath = options.preserveImage === false ? null : previous?.image_path ?? null;
  let imageMime = options.preserveImage === false ? null : previous?.image_mime ?? null;
  let rawImageDataUrl = null;

  const parsedImage = parseImageDataUrl(clip?.imageDataUrl);
  if (parsedImage) {
    const fileName = imageFileNameForClip(id, parsedImage.mime);
    const target = path.join(engine.imagesDir, fileName);
    ensureImagesDir(engine);
    // sync upserts replay identical images; skip the rewrite when the target
    // already holds the same number of bytes (cheap idempotence)
    let alreadyStored = false;
    try {
      alreadyStored = fs.statSync(target).size === parsedImage.buffer.length;
    } catch {
      alreadyStored = false;
    }
    if (!alreadyStored) {
      fs.writeFileSync(target, parsedImage.buffer);
    }
    if (previous?.image_path && previous.image_path !== fileName) {
      removeImageFileSync(engine, previous.image_path);
    }
    imagePath = fileName;
    imageMime = parsedImage.mime;
  } else if (typeof clip?.imageDataUrl === "string" && clip.imageDataUrl && !imagePath) {
    // unexpected non-data-url form: keep it verbatim so nothing is lost
    rawImageDataUrl = clip.imageDataUrl;
  }

  const extra = {};
  for (const [field, value] of Object.entries(clip || {})) {
    if (!KNOWN_CLIP_FIELDS.has(field) && value !== undefined) {
      extra[field] = value;
    }
  }
  if (rawImageDataUrl) {
    extra.__rawImageDataUrl = rawImageDataUrl;
  }
  const extraJson = Object.keys(extra).length > 0 ? JSON.stringify(extra) : null;

  const seq = Number.isFinite(options.seq) ? Number(options.seq) : Number(previous?.seq ?? engine.nextSeq);
  const createdAt =
    toFiniteOrNull(clip?.createdAt) ??
    toFiniteOrNull(clip?.serverUpdatedAt) ??
    toFiniteOrNull(clip?.clientUpdatedAt) ??
    0;

  engine.st.insert.run(
    id,
    seq,
    clip?.userId != null ? String(clip.userId) : null,
    clip?.deviceId != null ? String(clip.deviceId) : null,
    clip?.type != null ? String(clip.type) : null,
    clip?.summary != null ? String(clip.summary) : null,
    clip?.content != null ? String(clip.content) : null,
    clip?.contentHtml != null ? String(clip.contentHtml) : null,
    clip?.sourceUrl != null ? String(clip.sourceUrl) : null,
    imagePath,
    imageMime,
    clip?.imagePreviewDataUrl != null ? String(clip.imagePreviewDataUrl) : null,
    clip?.imageUrl != null ? String(clip.imageUrl) : null,
    clip?.isFavorite ? 1 : 0,
    clip?.isDeleted ? 1 : 0,
    JSON.stringify(Array.isArray(clip?.tags) ? clip.tags : []),
    toFiniteOrNull(clip?.clientUpdatedAt),
    toFiniteOrNull(clip?.serverUpdatedAt),
    createdAt,
    extraJson
  );
  return true;
};

// Shared tolerant json import: streams `jsonPath` with the legacy parser,
// extracts embedded images to files and upserts by id keeping the newer record
// (favorite flag and tags are unioned). Runs in one transaction; throws on
// transaction failure (after rollback). Never touches the source file.
const runJsonImportTransaction = (engine, jsonPath) => {
  let imported = 0;
  let importSeq = Math.min(0, Number(engine.st.minSeq.get()?.s ?? 1) - 1);

  engine.db.exec("BEGIN IMMEDIATE");
  try {
    visitLegacyClipObjectsSync(
      jsonPath,
      (clip) => {
        try {
          const id = String(clip?.id || "").trim();
          if (!id) return true;
          const existingRow = engine.st.getById.get(id);
          if (!existingRow) {
            if (storeClipRow(engine, clip, { seq: importSeq })) {
              importSeq -= 1;
              imported += 1;
            }
            return true;
          }
          const existing = rowToClip(engine, existingRow, { hydrateImage: false });
          const incomingNewer = clipSyncTs(clip) >= clipSyncTs(existing);
          const merged = {
            ...(incomingNewer ? clip : existing),
            isFavorite: Boolean(clip?.isFavorite || existing?.isFavorite),
            tags: Array.from(
              new Set(
                (Array.isArray(existing?.tags) ? existing.tags : []).concat(
                  Array.isArray(clip?.tags) ? clip.tags : []
                )
              )
            )
          };
          if (storeClipRow(engine, merged, { seq: Number(existingRow.seq) })) {
            imported += 1;
          }
        } catch {
          // skip unparseable / unstorable records, keep importing the rest
        }
        return true;
      },
      { maxObjects: Number.MAX_SAFE_INTEGER }
    );
    engine.db.exec("COMMIT");
  } catch (error) {
    try {
      engine.db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw error;
  }

  return imported;
};

// One-time (and self-healing) import of the legacy JSON database. Streams the
// file with the tolerant parser, extracts embedded images to files, upserts by
// id keeping the newer record (favorite flag and tags are unioned), then
// renames the JSON to *.migrated.bak. The original file is never deleted; on
// any import failure it is left untouched for the next attempt.
const importLegacyJsonIfPresent = (engine) => {
  if (!fs.existsSync(engine.key)) return;

  let imported = 0;
  try {
    imported = runJsonImportTransaction(engine, engine.key);
  } catch (error) {
    console.warn(
      "local history: legacy import failed, keeping json:",
      error instanceof Error ? error.message : String(error)
    );
    return;
  }

  engine.version += 1;
  engine.nextSeq = Math.max(engine.nextSeq, Number(engine.st.maxSeq.get()?.s || 0) + 1);

  try {
    let backup = `${engine.key}.migrated.bak`;
    if (fs.existsSync(backup)) {
      backup = `${engine.key}.migrated-${Date.now()}.bak`;
    }
    fs.renameSync(engine.key, backup);
    console.log(`local history: imported ${imported} legacy clips, json kept at ${path.basename(backup)}`);
  } catch (error) {
    console.warn(
      "local history: could not rename legacy json:",
      error instanceof Error ? error.message : String(error)
    );
  }
};

const iterateOrderedRows = (engine, limit) => {
  const capped = Math.max(0, Math.floor(Number(limit) || 0));
  const stmt = engine.st.listOrdered;
  if (typeof stmt.iterate === "function") {
    return stmt.iterate(capped);
  }
  return stmt.all(capped);
};

const deleteRowAndImage = (engine, row) => {
  engine.st.deleteById.run(row.id);
  removeImageFileSync(engine, row.image_path);
};

const cleanupOrphanImagesSync = (engine) => {
  let names;
  try {
    names = fs.readdirSync(engine.imagesDir);
  } catch {
    return;
  }
  const referenced = new Set(engine.st.imagePaths.all().map((row) => row.image_path));
  for (const name of names) {
    if (referenced.has(name)) continue;
    try {
      fs.rmSync(path.join(engine.imagesDir, name), { force: true });
    } catch {
      // best-effort
    }
  }
};

// --- exported api (signature-compatible with the legacy json engine) --------

const ensureDbFile = (file) => {
  acquireEngine(file);
};

const visitClipObjectsInFileSync = (file, visitor, options = {}) => {
  if (typeof visitor !== "function") {
    throw new TypeError("visitor must be a function");
  }
  const engine = acquireEngine(file);
  const maxObjects = Math.max(1, Number(options.maxObjects || DEFAULT_MAX_SCAN_CLIPS));
  const hydrateImages = options.hydrateImages === true;
  let visited = 0;
  let stopped = false;

  for (const row of iterateOrderedRows(engine, maxObjects)) {
    const clip = rowToClip(engine, row, { hydrateImage: hydrateImages });
    visited += 1;
    if (clip && visitor(clip, visited) === false) {
      stopped = true;
      break;
    }
    if (visited >= maxObjects) {
      stopped = true;
      break;
    }
  }

  return { visited, stopped };
};

const visitClipObjectsInFileAsync = async (file, visitor, options = {}) => {
  if (typeof visitor !== "function") {
    throw new TypeError("visitor must be a function");
  }
  const engine = acquireEngine(file);
  const maxObjects = Math.max(1, Number(options.maxObjects || DEFAULT_MAX_SCAN_CLIPS));
  // full images are hydrated by default here: the only caller uploads complete
  // clips (one-time cloud import), everything else uses the sync/list paths
  const hydrateImages = options.hydrateImages !== false;
  const rows = engine.st.listOrdered.all(maxObjects);
  let visited = 0;
  let stopped = false;

  for (const row of rows) {
    const clip = rowToClip(engine, row, { hydrateImage: false });
    if (clip && hydrateImages && !clip.imageDataUrl) {
      clip.imageDataUrl = await loadImageDataUrlAsync(engine, row);
    }
    visited += 1;
    if (clip && (await visitor(clip, visited)) === false) {
      stopped = true;
      break;
    }
    if (visited >= maxObjects) {
      stopped = true;
      break;
    }
  }

  return { visited, stopped };
};

// List queries never read full image files; lite projection keeps only the
// small inline preview (see projectClipForList).
const listClipsFromDbFile = (file, query = {}, options = {}) => {
  const engine = acquireEngine(file);
  const favoriteOnly = Boolean(query?.favorite);
  const lite = options.lite !== false;
  const limit = Math.max(1, Math.floor(Number(options.limit || 60)));
  const maxScan = Math.max(limit + 1, Math.floor(Number(options.maxScan || DEFAULT_MAX_SCAN_CLIPS)));
  const items = [];
  let hasMore = false;

  for (const row of iterateOrderedRows(engine, maxScan)) {
    const clip = rowToClip(engine, row, { hydrateImage: false });
    if (!clip || clip.isDeleted) continue;
    if (favoriteOnly && !clip.isFavorite) continue;
    if (!matchesClipQuery(clip, query?.q)) continue;
    if (items.length >= limit) {
      hasMore = true;
      break;
    }
    items.push(projectClipForList(clip, { lite }));
  }

  return {
    items,
    nextCursor: null,
    hasMore
  };
};

// The cache signature is the engine's in-memory mutation counter: with WAL the
// sqlite file mtime no longer tracks writes, and all writers live in this
// process. A still-pending legacy json (e.g. rewritten by icloud sync) also
// flips the signature so the next list re-imports it.
const listCacheFileSignature = (file) => {
  try {
    return `v${acquireEngine(file).version}`;
  } catch {
    return "missing";
  }
};

const listCacheKey = (query = {}, options = {}) => {
  const lite = options.lite !== false;
  const limit = Math.max(1, Math.floor(Number(options.limit || 60)));
  const maxScan = Math.max(limit + 1, Math.floor(Number(options.maxScan || DEFAULT_MAX_SCAN_CLIPS)));
  return JSON.stringify({
    q: String(query?.q || "").trim(),
    favorite: Boolean(query?.favorite),
    lite,
    limit,
    maxScan
  });
};

const createListClipsFromDbFileCache = (file, options = {}) => {
  const maxEntries = Math.max(1, Math.floor(Number(options.maxEntries || 24)));
  const listFn = typeof options.listFn === "function" ? options.listFn : listClipsFromDbFile;
  let signature = "";
  const entries = new Map();

  const invalidate = () => {
    signature = "";
    entries.clear();
  };

  const list = (query = {}, listOptions = {}) => {
    const nextSignature = listCacheFileSignature(file);
    if (nextSignature !== signature) {
      signature = nextSignature;
      entries.clear();
    }

    const key = listCacheKey(query, listOptions);
    if (entries.has(key)) {
      const cached = entries.get(key);
      entries.delete(key);
      entries.set(key, cached);
      return cached;
    }

    const result = listFn(file, query, listOptions);
    entries.set(key, result);
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      entries.delete(oldest);
    }
    return result;
  };

  return {
    invalidate,
    list
  };
};

// Single-clip fetch for paste/detail: the one read path that loads the full
// image file back into a data url.
const findClipByIdInDbFile = (file, id, options = {}) => {
  const wanted = String(id || "").trim();
  if (!wanted) return null;
  const engine = acquireEngine(file);
  const row = engine.st.getById.get(wanted);
  if (!row) return null;
  return rowToClip(engine, row, { hydrateImage: options.hydrateImage !== false });
};

const countPendingClipsInDbFile = (file, options = {}) => {
  const engine = acquireEngine(file);
  const maxScan = Math.max(1, Math.floor(Number(options.maxScan || Number.MAX_SAFE_INTEGER)));
  return Number(engine.st.countPending.get(Math.min(maxScan, Number.MAX_SAFE_INTEGER))?.n || 0);
};

const prependClipToDbFile = (file, clip) => {
  const engine = acquireEngine(file);
  if (storeClipRow(engine, clip, { seq: engine.nextSeq })) {
    engine.nextSeq += 1;
    engine.version += 1;
  }
};

const rewriteDbFileStreaming = (file, transform, options = {}) => {
  if (typeof transform !== "function") {
    throw new TypeError("transform must be a function");
  }
  const engine = acquireEngine(file);
  const maxObjects = Math.max(1, Number(options.maxObjects || Number.MAX_SAFE_INTEGER));
  const rows = engine.st.listOrdered.all(Math.min(maxObjects, Number.MAX_SAFE_INTEGER));
  let kept = 0;
  let scanned = 0;
  let changed = false;

  engine.db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      scanned += 1;
      const clip = rowToClip(engine, row, { hydrateImage: false });
      const next = transform(clip, scanned);
      if (next === null || next === undefined) {
        deleteRowAndImage(engine, row);
        changed = true;
        continue;
      }
      if (next !== clip) {
        storeClipRow(engine, next, { seq: Number(row.seq) });
        changed = true;
      }
      kept += 1;
    }
    engine.db.exec("COMMIT");
  } catch (error) {
    try {
      engine.db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw error;
  }

  if (changed) engine.version += 1;
  return { ok: true, changed, kept, scanned };
};

const updateClipInDbFile = (file, id, updater, options = {}) => {
  const wanted = String(id || "").trim();
  if (!wanted) return { ok: false, changed: false, reason: "missing-id" };
  const engine = acquireEngine(file);
  const row = engine.st.getById.get(wanted);
  if (!row) {
    return { ok: true, changed: false, found: false };
  }

  const clip = rowToClip(engine, row, { hydrateImage: false });
  const next = updater(clip);
  let changed = false;
  if (next === null || next === undefined) {
    deleteRowAndImage(engine, row);
    changed = true;
  } else if (next !== clip) {
    storeClipRow(engine, next, { seq: Number(row.seq) });
    changed = true;
  }
  if (changed) engine.version += 1;
  return { ok: true, changed, found: true };
};

const deleteClipFromDbFile = (file, id, options = {}) => {
  const wanted = String(id || "").trim();
  if (!wanted) return { ok: false, changed: false, reason: "missing-id" };
  const engine = acquireEngine(file);
  const row = engine.st.getById.get(wanted);
  if (!row) {
    return { ok: true, changed: false, found: false };
  }
  deleteRowAndImage(engine, row);
  engine.version += 1;
  return { ok: true, changed: true, found: true };
};

// Cheap size estimate of a fully-hydrated json export of ALL rows (including
// soft-deleted): one sql sum over the inline payload columns plus a stat-based
// base64 estimate per referenced image file. Never reads image contents.
const estimateClipPayloadBytesInDbFile = (file) => {
  const engine = acquireEngine(file);
  let total = Number(engine.st.payloadBytes.get()?.bytes || 0);
  for (const row of engine.st.imagePaths.all()) {
    try {
      const size = fs.statSync(path.join(engine.imagesDir, row.image_path)).size;
      total += Math.ceil(size * IMAGE_BASE64_INFLATION) + IMAGE_ROW_OVERHEAD_BYTES;
    } catch {
      // missing image file contributes nothing
    }
  }
  return Math.round(total);
};

// Imports an arbitrary legacy-format json file (e.g. one written by another
// device into icloud drive) with the same tolerant streaming parser and upsert
// semantics as the one-time migration. Unlike the migration the source file is
// never renamed, deleted or modified — it may belong to other devices.
const importJsonHistoryFile = (file, jsonPath) => {
  try {
    const source = path.resolve(String(jsonPath || ""));
    if (!fs.existsSync(source)) {
      return { ok: false, imported: 0 };
    }
    const engine = acquireEngine(file);
    if (source === engine.key) {
      // the engine's own legacy path: acquireEngine already imported (and
      // renamed) it via the migration; nothing left to do here
      return { ok: true, imported: 0 };
    }
    const imported = runJsonImportTransaction(engine, source);
    if (imported > 0) {
      engine.version += 1;
      engine.nextSeq = Math.max(engine.nextSeq, Number(engine.st.maxSeq.get()?.s || 0) + 1);
    }
    return { ok: true, imported };
  } catch (error) {
    console.warn(
      "local history: json import failed:",
      error instanceof Error ? error.message : String(error)
    );
    return { ok: false, imported: 0 };
  }
};

// Retention / maintenance: cheap sql deletes plus orphaned image-file cleanup.
// Non-favorite clips older than `cutoff` are dropped, then the newest
// `maxClips` rows are kept. Soft-deleted tombstones survive until they are
// older than `tombstoneTtlMs` so deletes can propagate through icloud sync.
const compactDbFileStreaming = (file, options = {}) => {
  const engine = acquireEngine(file);
  const maxClips = Math.max(1, Number(options.maxClips || DEFAULT_MAX_SCAN_CLIPS));
  const cutoff = Number.isFinite(options.cutoff) ? Number(options.cutoff) : null;
  const tombstoneTtlMs = Number.isFinite(options.tombstoneTtlMs)
    ? Math.max(0, Number(options.tombstoneTtlMs))
    : DEFAULT_TOMBSTONE_TTL_MS;
  const scanned = Number(engine.st.countAll.get()?.n || 0);

  engine.db.exec("BEGIN IMMEDIATE");
  try {
    engine.st.deleteExpiredTombstones.run(Date.now() - tombstoneTtlMs);
    if (cutoff !== null) {
      engine.st.deleteExpired.run(cutoff);
    }
    engine.st.deleteOverCap.run(maxClips);
    engine.db.exec("COMMIT");
  } catch (error) {
    try {
      engine.db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw error;
  }

  const kept = Number(engine.st.countAll.get()?.n || 0);
  if (kept !== scanned) engine.version += 1;
  cleanupOrphanImagesSync(engine);
  try {
    engine.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch {
    // best-effort
  }
  return { ok: true, kept, scanned };
};

module.exports = {
  DEFAULT_MAX_SCAN_CLIPS,
  DEFAULT_TOMBSTONE_TTL_MS,
  compactDbFileStreaming,
  countPendingClipsInDbFile,
  createListClipsFromDbFileCache,
  deleteClipFromDbFile,
  ensureDbFile,
  estimateClipPayloadBytesInDbFile,
  findClipByIdInDbFile,
  importJsonHistoryFile,
  listClipsFromDbFile,
  prependClipToDbFile,
  rewriteDbFileStreaming,
  updateClipInDbFile,
  visitClipObjectsInFileAsync,
  visitClipObjectsInFileSync
};
