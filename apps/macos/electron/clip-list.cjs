const MAX_LOCAL_LIST_LIMIT = 60;

const htmlToText = (html) =>
  (html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const normalizeSearchValue = (value) => String(value || "").trim().toLowerCase();

const matchesClipQuery = (clip, query) => {
  const q = normalizeSearchValue(query);
  if (!q) return true;

  const summary = normalizeSearchValue(clip?.summary);
  const content = normalizeSearchValue(clip?.content);
  const sourceUrl = normalizeSearchValue(clip?.sourceUrl);

  if (summary.includes(q) || content.includes(q) || sourceUrl.includes(q)) {
    return true;
  }

  if (!content && clip?.contentHtml) {
    return normalizeSearchValue(htmlToText(clip.contentHtml)).includes(q);
  }

  return false;
};

const projectClipForList = (clip, options = {}) => {
  const lite = options.lite !== false;
  const tags = Array.isArray(clip?.tags) ? clip.tags : [];
  if (!lite) {
    return { ...clip, tags };
  }

  return {
    ...clip,
    contentHtml: null,
    imageDataUrl: null,
    imagePreviewDataUrl:
      typeof clip?.imagePreviewDataUrl === "string" && clip.imagePreviewDataUrl
        ? clip.imagePreviewDataUrl
        : null,
    tags
  };
};

const localFilterAndProjectClips = (clips, query = {}, options = {}) => {
  const favoriteOnly = Boolean(query.favorite);
  const lite = options.lite !== false;
  const limit = Math.max(
    1,
    Number.isFinite(options.limit) ? Math.floor(options.limit) : MAX_LOCAL_LIST_LIMIT
  );
  const items = [];
  let hasMore = false;

  for (const clip of Array.isArray(clips) ? clips : []) {
    if (!clip) continue;
    if (favoriteOnly && !clip.isFavorite) continue;
    if (!matchesClipQuery(clip, query.q)) continue;

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

module.exports = {
  MAX_LOCAL_LIST_LIMIT,
  htmlToText,
  matchesClipQuery,
  projectClipForList,
  localFilterAndProjectClips
};
