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
  findClipByIdInDbFile,
  listClipsFromDbFile,
  prependClipToDbFile,
  updateClipInDbFile,
  visitClipObjectsInFileAsync
} = require("./local-history.cjs");

const makeTempDb = (clips) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pastyx-history-"));
  const file = path.join(dir, "clips.json");
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

test("listClipsFromDbFile returns a bounded lite list without full DB materialization", () => {
  const bigImage = "data:image/png;base64," + "x".repeat(500_000);
  const { dir, file } = makeTempDb([
    makeClip({
      id: "image-1",
      type: "image",
      content: "match image",
      imageDataUrl: bigImage,
      imagePreviewDataUrl: "data:image/jpeg;base64,preview",
      createdAt: 3
    }),
    makeClip({ id: "text-1", content: "match text", createdAt: 2 }),
    makeClip({ id: "text-2", content: "match more", createdAt: 1 })
  ]);

  try {
    const result = listClipsFromDbFile(file, { q: "match" }, { lite: true, limit: 2 });

    assert.equal(result.items.length, 2);
    assert.equal(result.hasMore, true);
    assert.equal(result.items[0].id, "image-1");
    assert.equal(result.items[0].imageDataUrl, null);
    assert.equal(result.items[0].imagePreviewDataUrl, "data:image/jpeg;base64,preview");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("findClipByIdInDbFile scans objects one at a time", () => {
  const { dir, file } = makeTempDb([
    makeClip({ id: "a", content: "first" }),
    makeClip({ id: "b", content: "second" })
  ]);

  try {
    assert.equal(findClipByIdInDbFile(file, "b")?.content, "second");
    assert.equal(findClipByIdInDbFile(file, "missing"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createListClipsFromDbFileCache reuses list results until the file changes", () => {
  const { dir, file } = makeTempDb([
    makeClip({ id: "a", content: "first" }),
    makeClip({ id: "b", content: "second" })
  ]);
  let calls = 0;

  try {
    const cache = createListClipsFromDbFileCache(file, {
      listFn: (...args) => {
        calls += 1;
        return listClipsFromDbFile(...args);
      }
    });

    assert.deepEqual(cache.list({}, { limit: 2 }).items.map((item) => item.id), ["a", "b"]);
    assert.deepEqual(cache.list({}, { limit: 2 }).items.map((item) => item.id), ["a", "b"]);
    assert.equal(calls, 1);

    prependClipToDbFile(file, makeClip({ id: "new", content: "newest" }));
    assert.deepEqual(cache.list({}, { limit: 2 }).items.map((item) => item.id), ["new", "a"]);
    assert.equal(calls, 2);

    cache.invalidate();
    assert.deepEqual(cache.list({}, { limit: 2 }).items.map((item) => item.id), ["new", "a"]);
    assert.equal(calls, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("prependClipToDbFile inserts newest clips without rebuilding the array", () => {
  const { dir, file } = makeTempDb([makeClip({ id: "old" })]);

  try {
    prependClipToDbFile(file, makeClip({ id: "new", content: "newest" }));
    const result = listClipsFromDbFile(file, {}, { limit: 5 });

    assert.deepEqual(result.items.map((item) => item.id), ["new", "old"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("compactDbFileStreaming applies retention and a hard local cap", () => {
  const now = Date.now();
  const { dir, file } = makeTempDb([
    makeClip({ id: "keep-1", createdAt: now }),
    makeClip({ id: "drop-old", createdAt: now - 10_000 }),
    makeClip({ id: "keep-favorite", isFavorite: true, createdAt: now - 10_000 }),
    makeClip({ id: "keep-2", createdAt: now - 1000 })
  ]);

  try {
    const result = compactDbFileStreaming(file, {
      cutoff: now - 5000,
      maxClips: 3
    });
    const list = listClipsFromDbFile(file, {}, { limit: 10 });

    assert.equal(result.kept, 3);
    assert.deepEqual(list.items.map((item) => item.id), ["keep-1", "keep-favorite", "keep-2"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("compactDbFileStreaming scans past the retained cap without growing output", () => {
  const { dir, file } = makeTempDb([
    makeClip({ id: "a", createdAt: 3 }),
    makeClip({ id: "b", createdAt: 2 }),
    makeClip({ id: "c", createdAt: 1 })
  ]);

  try {
    const result = compactDbFileStreaming(file, { maxClips: 1 });
    const list = listClipsFromDbFile(file, {}, { limit: 10 });

    assert.equal(result.scanned, 3);
    assert.equal(result.kept, 1);
    assert.deepEqual(list.items.map((item) => item.id), ["a"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("updateClipInDbFile rewrites one clip without dropping order", () => {
  const { dir, file } = makeTempDb([
    makeClip({ id: "a", isFavorite: false }),
    makeClip({ id: "b", isFavorite: false })
  ]);

  try {
    const result = updateClipInDbFile(file, "b", (clip) => ({
      ...clip,
      isFavorite: true,
      serverUpdatedAt: 99
    }));
    const list = listClipsFromDbFile(file, {}, { limit: 10, lite: false });

    assert.equal(result.found, true);
    assert.deepEqual(list.items.map((item) => item.id), ["a", "b"]);
    assert.equal(list.items[1].isFavorite, true);
    assert.equal(list.items[1].serverUpdatedAt, 99);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteClipFromDbFile removes one clip without loading the whole database", () => {
  const { dir, file } = makeTempDb([
    makeClip({ id: "a" }),
    makeClip({ id: "b" }),
    makeClip({ id: "c" })
  ]);

  try {
    const result = deleteClipFromDbFile(file, "b");
    const list = listClipsFromDbFile(file, {}, { limit: 10 });

    assert.equal(result.found, true);
    assert.deepEqual(list.items.map((item) => item.id), ["a", "c"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("countPendingClipsInDbFile scans all pending clips by default", () => {
  const { dir, file } = makeTempDb([
    makeClip({ id: "a" }),
    makeClip({ id: "b", isDeleted: true }),
    makeClip({ id: "c" })
  ]);

  try {
    assert.equal(countPendingClipsInDbFile(file), 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("visitClipObjectsInFileAsync awaits each clip in file order", async () => {
  const { dir, file } = makeTempDb([
    makeClip({ id: "a" }),
    makeClip({ id: "b" }),
    makeClip({ id: "c" })
  ]);
  const seen = [];

  try {
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
