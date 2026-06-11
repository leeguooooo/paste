const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  compactDbFileStreaming,
  countPendingClipsInDbFile,
  createListClipsFromDbFileCache,
  deleteClipFromDbFile,
  estimateClipPayloadBytesInDbFile,
  findClipByIdInDbFile,
  importJsonHistoryFile,
  listClipsFromDbFile,
  prependClipToDbFile,
  updateClipInDbFile,
  visitClipObjectsInFileAsync,
  visitClipObjectsInFileSync
} = require("./local-history.cjs");

const makeHistoryDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pastyx-history-"));
  return { dir, file: path.join(dir, "clips.json") };
};

const makeLegacyDb = (clips) => {
  const { dir, file } = makeHistoryDir();
  fs.writeFileSync(file, JSON.stringify({ clips }, null, 2));
  return { dir, file };
};

const makeClip = (overrides = {}) => ({
  id: overrides.id || "clip-1",
  userId: "user-1",
  deviceId: "mac-1",
  type: "text",
  summary: "Summary",
  content: "Hello world",
  contentHtml: null,
  sourceUrl: null,
  imageDataUrl: null,
  imagePreviewDataUrl: null,
  imageUrl: null,
  isFavorite: false,
  isDeleted: false,
  tags: [],
  clientUpdatedAt: 1,
  serverUpdatedAt: 1,
  createdAt: 1,
  ...overrides
});

const imageBytes = Buffer.from("pastyx-test-image-payload-7f3a9c".repeat(64));
const imageBase64 = imageBytes.toString("base64");
const imageDataUrl = `data:image/png;base64,${imageBase64}`;

const sqliteFileFor = (file) => `${file.replace(/\.json$/i, "")}.sqlite`;

const waitFor = async (predicate, timeoutMs = 1500) => {
  const start = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("creates, lists, fetches and deletes clips through the sqlite engine", () => {
  const { dir, file } = makeHistoryDir();

  try {
    prependClipToDbFile(file, makeClip({ id: "a", content: "first", createdAt: 1 }));
    prependClipToDbFile(file, makeClip({ id: "b", content: "second", createdAt: 2 }));
    prependClipToDbFile(file, makeClip({ id: "c", content: "third", createdAt: 2 }));

    // newest first; equal createdAt falls back to insertion recency
    const list = listClipsFromDbFile(file, {}, { limit: 10 });
    assert.deepEqual(list.items.map((item) => item.id), ["c", "b", "a"]);
    assert.equal(list.hasMore, false);

    const found = findClipByIdInDbFile(file, "b");
    assert.equal(found?.content, "second");
    assert.deepEqual(found?.tags, []);
    assert.equal(findClipByIdInDbFile(file, "missing"), null);

    const search = listClipsFromDbFile(file, { q: "second" }, { limit: 10 });
    assert.deepEqual(search.items.map((item) => item.id), ["b"]);

    const bounded = listClipsFromDbFile(file, {}, { limit: 2 });
    assert.equal(bounded.items.length, 2);
    assert.equal(bounded.hasMore, true);

    const del = deleteClipFromDbFile(file, "b");
    assert.equal(del.found, true);
    assert.deepEqual(listClipsFromDbFile(file, {}, { limit: 10 }).items.map((i) => i.id), ["c", "a"]);
    assert.equal(deleteClipFromDbFile(file, "b").found, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extracts full images to files and keeps payloads out of the database", () => {
  const { dir, file } = makeHistoryDir();

  try {
    prependClipToDbFile(
      file,
      makeClip({
        id: "image-1",
        type: "image",
        content: "match image",
        imageDataUrl,
        imagePreviewDataUrl: "data:image/jpeg;base64,preview",
        createdAt: 3
      })
    );

    const imageFile = path.join(dir, "images", "image-1.png");
    assert.equal(fs.existsSync(imageFile), true);
    assert.deepEqual(fs.readFileSync(imageFile), imageBytes);

    // neither lite nor full list projections carry the image payload
    const lite = listClipsFromDbFile(file, { q: "match" }, { lite: true, limit: 5 });
    assert.equal(lite.items[0].imageDataUrl, null);
    assert.equal(lite.items[0].imagePreviewDataUrl, "data:image/jpeg;base64,preview");
    const full = listClipsFromDbFile(file, {}, { lite: false, limit: 5 });
    assert.equal(full.items[0].imageDataUrl, null);

    // the payload never reaches sqlite (main db or wal)
    const marker = imageBase64.slice(0, 80);
    const dbFile = sqliteFileFor(file);
    for (const candidate of [dbFile, `${dbFile}-wal`]) {
      if (!fs.existsSync(candidate)) continue;
      assert.equal(fs.readFileSync(candidate, "latin1").includes(marker), false);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("lazily loads the full image only when a single clip is fetched", async () => {
  const { dir, file } = makeHistoryDir();

  try {
    prependClipToDbFile(file, makeClip({ id: "image-1", type: "image", imageDataUrl, createdAt: 1 }));

    // detail fetch hydrates the data url from the image file
    assert.equal(findClipByIdInDbFile(file, "image-1")?.imageDataUrl, imageDataUrl);

    // sync scans stay image-free
    let syncImage = "untouched";
    visitClipObjectsInFileSync(file, (clip) => {
      syncImage = clip.imageDataUrl;
      return true;
    });
    assert.equal(syncImage, null);

    // the async visitor (cloud import) hydrates by default
    let asyncImage = null;
    await visitClipObjectsInFileAsync(file, async (clip) => {
      asyncImage = clip.imageDataUrl;
      return true;
    });
    assert.equal(asyncImage, imageDataUrl);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("migrates a legacy json database into sqlite on first open", () => {
  const clipA = makeClip({ id: "text-1", content: "newest text", createdAt: 3 });
  const clipB = makeClip({ id: "fav-1", content: "favorite", isFavorite: true, createdAt: 2 });
  const clipC = makeClip({
    id: "image-1",
    type: "image",
    summary: "Image",
    imageDataUrl,
    imagePreviewDataUrl: "data:image/jpeg;base64,preview",
    createdAt: 1
  });
  const { dir, file } = makeHistoryDir();
  // include an unparseable record in the middle: it must be skipped, not fatal
  fs.writeFileSync(
    file,
    `{"clips":[${JSON.stringify(clipA)},{"id":"broken",},${JSON.stringify(clipB)},${JSON.stringify(clipC)}]}`
  );

  try {
    const list = listClipsFromDbFile(file, {}, { lite: false, limit: 10 });
    assert.deepEqual(list.items.map((item) => item.id), ["text-1", "fav-1", "image-1"]);
    assert.equal(list.items[1].isFavorite, true);

    // embedded image extracted to a file and hydrated on detail fetch
    assert.equal(fs.existsSync(path.join(dir, "images", "image-1.png")), true);
    assert.equal(findClipByIdInDbFile(file, "image-1")?.imageDataUrl, imageDataUrl);

    // the original json is renamed, never deleted
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(`${file}.migrated.bak`), true);
    assert.equal(fs.readFileSync(`${file}.migrated.bak`, "utf8").includes('"broken"'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("imports the parseable prefix of a truncated legacy json file", () => {
  const clipA = makeClip({ id: "kept", content: "kept", createdAt: 2 });
  const clipB = makeClip({ id: "cut-off", content: "cut", createdAt: 1 });
  const { dir, file } = makeHistoryDir();
  const full = JSON.stringify({ clips: [clipA, clipB] }, null, 2);
  fs.writeFileSync(file, full.slice(0, full.indexOf('"cut-off"') + 4));

  try {
    const list = listClipsFromDbFile(file, {}, { limit: 10 });
    assert.deepEqual(list.items.map((item) => item.id), ["kept"]);
    assert.equal(fs.existsSync(`${file}.migrated.bak`), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("re-imports a rewritten legacy json without losing newer sqlite data", () => {
  const { dir, file } = makeLegacyDb([
    makeClip({ id: "t1", content: "original", clientUpdatedAt: 100, serverUpdatedAt: 100, createdAt: 100 })
  ]);

  try {
    assert.equal(listClipsFromDbFile(file, {}, { limit: 10 }).items.length, 1);
    assert.equal(fs.existsSync(`${file}.migrated.bak`), true);

    // e.g. icloud sync re-creates the json: stale copy of t1 (now favorited) plus a new clip
    fs.writeFileSync(
      file,
      JSON.stringify({
        clips: [
          makeClip({ id: "t1", content: "stale", isFavorite: true, clientUpdatedAt: 50, serverUpdatedAt: 50, createdAt: 50 }),
          makeClip({ id: "n1", content: "from cloud", createdAt: 200 })
        ]
      })
    );

    const list = listClipsFromDbFile(file, {}, { lite: false, limit: 10 });
    assert.deepEqual(list.items.map((item) => item.id), ["n1", "t1"]);
    const t1 = list.items.find((item) => item.id === "t1");
    assert.equal(t1.content, "original");
    assert.equal(t1.isFavorite, true);
    assert.equal(fs.existsSync(file), false);
    const backups = fs.readdirSync(dir).filter((name) => name.includes(".migrated"));
    assert.equal(backups.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("compactDbFileStreaming prunes by retention and removes orphaned image files", () => {
  const now = Date.now();
  const { dir, file } = makeHistoryDir();

  try {
    prependClipToDbFile(file, makeClip({ id: "keep-1", createdAt: now }));
    prependClipToDbFile(
      file,
      makeClip({ id: "drop-old-image", type: "image", imageDataUrl, createdAt: now - 10_000 })
    );
    prependClipToDbFile(file, makeClip({ id: "keep-favorite", isFavorite: true, createdAt: now - 10_000 }));
    prependClipToDbFile(file, makeClip({ id: "soft-deleted", isDeleted: true, createdAt: now }));
    const imageFile = path.join(dir, "images", "drop-old-image.png");
    assert.equal(fs.existsSync(imageFile), true);

    const result = compactDbFileStreaming(file, { cutoff: now - 5000, maxClips: 10 });

    assert.equal(result.scanned, 4);
    // the fresh soft-delete tombstone survives compaction (tombstone ttl)
    assert.equal(result.kept, 3);
    assert.equal(findClipByIdInDbFile(file, "soft-deleted")?.isDeleted, true);
    const ids = listClipsFromDbFile(file, {}, { limit: 10 }).items.map((item) => item.id).sort();
    assert.deepEqual(ids, ["keep-1", "keep-favorite"]);
    assert.equal(fs.existsSync(imageFile), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("compactDbFileStreaming enforces the hard clip cap", () => {
  const { dir, file } = makeHistoryDir();

  try {
    prependClipToDbFile(file, makeClip({ id: "c", createdAt: 1 }));
    prependClipToDbFile(file, makeClip({ id: "b", createdAt: 2 }));
    prependClipToDbFile(file, makeClip({ id: "a", createdAt: 3 }));

    const result = compactDbFileStreaming(file, { maxClips: 1 });

    assert.equal(result.scanned, 3);
    assert.equal(result.kept, 1);
    assert.deepEqual(listClipsFromDbFile(file, {}, { limit: 10 }).items.map((i) => i.id), ["a"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("updateClipInDbFile updates fields while preserving the stored image", () => {
  const { dir, file } = makeHistoryDir();

  try {
    prependClipToDbFile(file, makeClip({ id: "image-1", type: "image", imageDataUrl, createdAt: 1 }));
    prependClipToDbFile(file, makeClip({ id: "text-1", createdAt: 2 }));

    const result = updateClipInDbFile(file, "image-1", (clip) => ({
      ...clip,
      isFavorite: true,
      serverUpdatedAt: 99
    }));

    assert.equal(result.found, true);
    assert.equal(result.changed, true);
    const updated = findClipByIdInDbFile(file, "image-1");
    assert.equal(updated.isFavorite, true);
    assert.equal(updated.serverUpdatedAt, 99);
    assert.equal(updated.imageDataUrl, imageDataUrl);
    assert.equal(updateClipInDbFile(file, "missing", (clip) => clip).found, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteClipFromDbFile removes the clip's image file", async () => {
  const { dir, file } = makeHistoryDir();

  try {
    prependClipToDbFile(file, makeClip({ id: "image-1", type: "image", imageDataUrl, createdAt: 1 }));
    const imageFile = path.join(dir, "images", "image-1.png");
    assert.equal(fs.existsSync(imageFile), true);

    const result = deleteClipFromDbFile(file, "image-1");

    assert.equal(result.found, true);
    assert.equal(await waitFor(() => !fs.existsSync(imageFile)), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createListClipsFromDbFileCache reuses list results until the data changes", () => {
  const { dir, file } = makeHistoryDir();
  let calls = 0;

  try {
    prependClipToDbFile(file, makeClip({ id: "a", content: "first", createdAt: 2 }));
    prependClipToDbFile(file, makeClip({ id: "b", content: "second", createdAt: 1 }));

    const cache = createListClipsFromDbFileCache(file, {
      listFn: (...args) => {
        calls += 1;
        return listClipsFromDbFile(...args);
      }
    });

    assert.deepEqual(cache.list({}, { limit: 2 }).items.map((item) => item.id), ["a", "b"]);
    assert.deepEqual(cache.list({}, { limit: 2 }).items.map((item) => item.id), ["a", "b"]);
    assert.equal(calls, 1);

    prependClipToDbFile(file, makeClip({ id: "new", content: "newest", createdAt: 3 }));
    assert.deepEqual(cache.list({}, { limit: 2 }).items.map((item) => item.id), ["new", "a"]);
    assert.equal(calls, 2);

    cache.invalidate();
    assert.deepEqual(cache.list({}, { limit: 2 }).items.map((item) => item.id), ["new", "a"]);
    assert.equal(calls, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("countPendingClipsInDbFile ignores soft-deleted clips", () => {
  const { dir, file } = makeHistoryDir();

  try {
    prependClipToDbFile(file, makeClip({ id: "a", createdAt: 3 }));
    prependClipToDbFile(file, makeClip({ id: "b", isDeleted: true, createdAt: 2 }));
    prependClipToDbFile(file, makeClip({ id: "c", createdAt: 1 }));

    assert.equal(countPendingClipsInDbFile(file), 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("estimateClipPayloadBytesInDbFile sums payload columns and stats image files without reading them", () => {
  const { dir, file } = makeHistoryDir();

  try {
    prependClipToDbFile(file, makeClip({ id: "t1", content: "hello", contentHtml: "<p>hello</p>", createdAt: 1 }));
    prependClipToDbFile(file, makeClip({ id: "gone", content: "bye", isDeleted: true, createdAt: 2 }));
    prependClipToDbFile(
      file,
      makeClip({
        id: "img",
        type: "image",
        content: null,
        imageDataUrl,
        imagePreviewDataUrl: "data:image/jpeg;base64,preview",
        createdAt: 3
      })
    );

    // per-row: LENGTH(content) + LENGTH(content_html) + LENGTH(image_preview_data_url) + 256
    // soft-deleted rows are counted too
    const rowBytes =
      ("hello".length + "<p>hello</p>".length + 256) +
      ("bye".length + 256) +
      ("data:image/jpeg;base64,preview".length + 256);
    const imageFile = path.join(dir, "images", "img.png");
    const imageEstimate = () => Math.ceil(fs.statSync(imageFile).size * 1.37) + 64;
    assert.equal(estimateClipPayloadBytesInDbFile(file), rowBytes + imageEstimate());

    // stat-based: growing the file on disk moves the estimate, no read involved
    fs.appendFileSync(imageFile, Buffer.alloc(1000));
    assert.equal(estimateClipPayloadBytesInDbFile(file), rowBytes + imageEstimate());

    // a missing image file contributes nothing
    fs.rmSync(imageFile);
    assert.equal(estimateClipPayloadBytesInDbFile(file), rowBytes);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("importJsonHistoryFile imports an external json without touching the source", () => {
  const { dir, file } = makeHistoryDir();
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "pastyx-import-"));
  const sourcePath = path.join(sourceDir, "other-device.json");

  try {
    prependClipToDbFile(file, makeClip({ id: "local", content: "local", clientUpdatedAt: 100, serverUpdatedAt: 100, createdAt: 100 }));
    fs.writeFileSync(
      sourcePath,
      JSON.stringify({
        clips: [
          makeClip({ id: "remote-text", content: "from icloud", createdAt: 200 }),
          makeClip({
            id: "remote-image",
            type: "image",
            imageDataUrl,
            imagePreviewDataUrl: "data:image/jpeg;base64,preview",
            createdAt: 50
          }),
          makeClip({ id: "local", content: "stale", isFavorite: true, clientUpdatedAt: 1, serverUpdatedAt: 1, createdAt: 1 })
        ]
      })
    );
    const sourceBefore = fs.readFileSync(sourcePath);

    const result = importJsonHistoryFile(file, sourcePath);
    assert.equal(result.ok, true);
    assert.equal(result.imported, 3);

    // migration upsert semantics: newer record wins, favorite OR'd
    const list = listClipsFromDbFile(file, {}, { lite: false, limit: 10 });
    assert.deepEqual(list.items.map((item) => item.id), ["remote-text", "local", "remote-image"]);
    const local = list.items.find((item) => item.id === "local");
    assert.equal(local.content, "local");
    assert.equal(local.isFavorite, true);

    // embedded image extracted to a file and hydrated on detail fetch
    assert.equal(fs.existsSync(path.join(dir, "images", "remote-image.png")), true);
    assert.equal(findClipByIdInDbFile(file, "remote-image")?.imageDataUrl, imageDataUrl);

    // the source json is never renamed, deleted or modified
    assert.deepEqual(fs.readdirSync(sourceDir), ["other-device.json"]);
    assert.deepEqual(fs.readFileSync(sourcePath), sourceBefore);

    // a second import is idempotent for the stored data
    assert.equal(importJsonHistoryFile(file, sourcePath).ok, true);
    const after = listClipsFromDbFile(file, {}, { lite: false, limit: 10 });
    assert.deepEqual(after.items.map((item) => item.id), ["remote-text", "local", "remote-image"]);
    assert.equal(after.items.find((item) => item.id === "local").content, "local");
    assert.deepEqual(fs.readFileSync(sourcePath), sourceBefore);

    // a missing source reports failure instead of throwing
    assert.deepEqual(importJsonHistoryFile(file, path.join(sourceDir, "missing.json")), { ok: false, imported: 0 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
});

test("compactDbFileStreaming keeps fresh tombstones and reaps expired ones with their images", () => {
  const now = Date.now();
  const freshTs = now - 1000;
  const oldTs = now - 60 * 24 * 60 * 60 * 1000;
  const { dir, file } = makeHistoryDir();

  try {
    prependClipToDbFile(
      file,
      makeClip({
        id: "fresh-tombstone",
        type: "image",
        imageDataUrl,
        isDeleted: true,
        clientUpdatedAt: freshTs,
        serverUpdatedAt: freshTs,
        createdAt: freshTs
      })
    );
    prependClipToDbFile(
      file,
      makeClip({
        id: "old-tombstone",
        type: "image",
        imageDataUrl,
        isDeleted: true,
        clientUpdatedAt: oldTs,
        serverUpdatedAt: oldTs,
        createdAt: oldTs
      })
    );
    const freshImage = path.join(dir, "images", "fresh-tombstone.png");
    const oldImage = path.join(dir, "images", "old-tombstone.png");
    assert.equal(fs.existsSync(freshImage), true);
    assert.equal(fs.existsSync(oldImage), true);

    // default ttl (30 days): the fresh tombstone survives, the old one is reaped
    const result = compactDbFileStreaming(file, { maxClips: 10 });
    assert.equal(result.kept, 1);
    assert.equal(findClipByIdInDbFile(file, "fresh-tombstone")?.isDeleted, true);
    assert.equal(findClipByIdInDbFile(file, "old-tombstone"), null);

    // the orphan sweep keeps the live tombstone's image and removes the reaped one's
    assert.equal(fs.existsSync(freshImage), true);
    assert.equal(fs.existsSync(oldImage), false);

    // an explicit ttl override reaps the remaining tombstone too
    compactDbFileStreaming(file, { maxClips: 10, tombstoneTtlMs: 0 });
    assert.equal(findClipByIdInDbFile(file, "fresh-tombstone"), null);
    assert.equal(fs.existsSync(freshImage), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("storeClipRow skips rewriting an identical-length image file", () => {
  const { dir, file } = makeHistoryDir();

  try {
    prependClipToDbFile(file, makeClip({ id: "image-1", type: "image", imageDataUrl, createdAt: 1 }));
    const imageFile = path.join(dir, "images", "image-1.png");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(imageFile, past, past);
    const mtimeBefore = fs.statSync(imageFile).mtimeMs;

    // a sync upsert replaying the identical payload leaves the file untouched
    prependClipToDbFile(file, makeClip({ id: "image-1", type: "image", imageDataUrl, createdAt: 2 }));
    assert.equal(fs.statSync(imageFile).mtimeMs, mtimeBefore);

    // a payload of a different length is written
    const otherBytes = Buffer.from("different-image-bytes");
    prependClipToDbFile(
      file,
      makeClip({
        id: "image-1",
        type: "image",
        imageDataUrl: `data:image/png;base64,${otherBytes.toString("base64")}`,
        createdAt: 3
      })
    );
    assert.deepEqual(fs.readFileSync(imageFile), otherBytes);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("image removal is synchronous so a re-added clip's image cannot vanish later", async () => {
  const { dir, file } = makeHistoryDir();

  try {
    prependClipToDbFile(file, makeClip({ id: "image-1", type: "image", imageDataUrl, createdAt: 1 }));
    const imageFile = path.join(dir, "images", "image-1.png");

    // the delete removes the image file before returning
    deleteClipFromDbFile(file, "image-1");
    assert.equal(fs.existsSync(imageFile), false);

    // immediately re-adding the same id recreates the image...
    prependClipToDbFile(file, makeClip({ id: "image-1", type: "image", imageDataUrl, createdAt: 2 }));
    assert.deepEqual(fs.readFileSync(imageFile), imageBytes);

    // ...and no delayed unlink from the delete can remove it afterwards
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(fs.readFileSync(imageFile), imageBytes);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("visitClipObjectsInFileAsync awaits each clip in list order", async () => {
  const { dir, file } = makeHistoryDir();
  const seen = [];

  try {
    prependClipToDbFile(file, makeClip({ id: "c", createdAt: 1 }));
    prependClipToDbFile(file, makeClip({ id: "b", createdAt: 2 }));
    prependClipToDbFile(file, makeClip({ id: "a", createdAt: 3 }));

    const result = await visitClipObjectsInFileAsync(file, async (clip) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.push(clip.id);
      return clip.id !== "b";
    });

    assert.equal(result.stopped, true);
    assert.deepEqual(seen, ["a", "b"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
