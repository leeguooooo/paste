const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_LOCAL_LIST_LIMIT,
  localFilterAndProjectClips,
  matchesClipQuery
} = require("./clip-list.cjs");

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

test("matchesClipQuery falls back to parsed html only when plain content is absent", () => {
  const clip = makeClip({
    type: "html",
    content: "",
    contentHtml: "<div>Alpha <strong>Beta</strong></div>"
  });

  assert.equal(matchesClipQuery(clip, "beta"), true);
  assert.equal(matchesClipQuery(clip, "gamma"), false);
});

test("localFilterAndProjectClips strips heavy fields in lite mode", () => {
  const input = makeClip({
    type: "image",
    imageDataUrl: "data:image/png;base64," + "x".repeat(2048),
    imagePreviewDataUrl: "data:image/jpeg;base64,preview",
    contentHtml: "<p>Large html</p>",
    tags: ["a"]
  });

  const result = localFilterAndProjectClips([input], {}, { lite: true });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].imageDataUrl, null);
  assert.equal(result.items[0].contentHtml, null);
  assert.equal(result.items[0].imagePreviewDataUrl, "data:image/jpeg;base64,preview");
  assert.deepEqual(result.items[0].tags, ["a"]);
});

test("localFilterAndProjectClips stops at the list limit and reports hasMore", () => {
  const clips = Array.from({ length: MAX_LOCAL_LIST_LIMIT + 5 }, (_, index) =>
    makeClip({
      id: `clip-${index}`,
      summary: `match-${index}`,
      content: `match ${index}`
    })
  );

  const result = localFilterAndProjectClips(clips, { q: "match" }, { lite: true });

  assert.equal(result.items.length, MAX_LOCAL_LIST_LIMIT);
  assert.equal(result.hasMore, true);
  assert.equal(result.items.at(-1)?.id, `clip-${MAX_LOCAL_LIST_LIMIT - 1}`);
});
