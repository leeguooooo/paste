const fs = require("node:fs");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const { matchesClipQuery, projectClipForList } = require("./clip-list.cjs");

const DEFAULT_STREAM_CHUNK_SIZE = 128 * 1024;
const DEFAULT_MAX_SCAN_CLIPS = 5000;

const ensureDbFile = (file) => {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ clips: [] }, null, 2));
};

const visitClipObjectsInFileSync = (file, visitor, options = {}) => {
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

const visitClipObjectsInFileAsync = async (file, visitor, options = {}) => {
  if (typeof visitor !== "function") {
    throw new TypeError("visitor must be a function");
  }
  if (!fs.existsSync(file)) {
    return { visited: 0, stopped: false };
  }

  const chunkSize = Math.max(1024, Number(options.chunkSize || DEFAULT_STREAM_CHUNK_SIZE));
  const maxObjects = Math.max(1, Number(options.maxObjects || DEFAULT_MAX_SCAN_CLIPS));
  const decoder = new StringDecoder("utf8");
  const stream = fs.createReadStream(file, { highWaterMark: chunkSize });

  let inClipsArray = false;
  let seekBuffer = "";
  let objectText = "";
  let inObject = false;
  let inString = false;
  let escaped = false;
  let depth = 0;
  let visited = 0;
  let stopped = false;

  const feed = async (text) => {
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
          if (clip && (await visitor(clip, visited)) === false) {
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

  for await (const chunk of stream) {
    if (!(await feed(decoder.write(chunk)))) {
      stream.destroy();
      break;
    }
  }
  if (!stopped) {
    await feed(decoder.end());
  }

  return { visited, stopped };
};

const listClipsFromDbFile = (file, query = {}, options = {}) => {
  const favoriteOnly = Boolean(query?.favorite);
  const lite = options.lite !== false;
  const limit = Math.max(1, Math.floor(Number(options.limit || 60)));
  const maxScan = Math.max(limit + 1, Math.floor(Number(options.maxScan || DEFAULT_MAX_SCAN_CLIPS)));
  const items = [];
  let hasMore = false;

  visitClipObjectsInFileSync(
    file,
    (clip) => {
      if (!clip || clip.isDeleted) return true;
      if (favoriteOnly && !clip.isFavorite) return true;
      if (!matchesClipQuery(clip, query?.q)) return true;
      if (items.length >= limit) {
        hasMore = true;
        return false;
      }
      items.push(projectClipForList(clip, { lite }));
      return true;
    },
    { maxObjects: maxScan }
  );

  return {
    items,
    nextCursor: null,
    hasMore
  };
};

const listCacheFileSignature = (file) => {
  try {
    const stat = fs.statSync(file);
    return `${stat.size}:${stat.mtimeMs}`;
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

const findClipByIdInDbFile = (file, id, options = {}) => {
  const wanted = String(id || "").trim();
  if (!wanted) return null;
  let found = null;
  visitClipObjectsInFileSync(
    file,
    (clip) => {
      if (clip?.id === wanted) {
        found = clip;
        return false;
      }
      return true;
    },
    { maxObjects: Math.max(1, Number(options.maxScan || DEFAULT_MAX_SCAN_CLIPS)) }
  );
  return found;
};

const countPendingClipsInDbFile = (file, options = {}) => {
  let count = 0;
  visitClipObjectsInFileSync(
    file,
    (clip) => {
      if (clip && !clip.isDeleted) {
        count += 1;
      }
      return true;
    },
    { maxObjects: Math.max(1, Number(options.maxScan || Number.MAX_SAFE_INTEGER)) }
  );
  return count;
};

const prependClipToDbFile = (file, clip) => {
  ensureDbFile(file);
  const raw = JSON.stringify(clip);
  const input = fs.openSync(file, "r");
  const stat = fs.fstatSync(input);
  const probeSize = Math.min(Math.max(stat.size, 0), 1024 * 1024);
  const probe = Buffer.allocUnsafe(probeSize);
  const bytesRead = probeSize > 0 ? fs.readSync(input, probe, 0, probeSize, 0) : 0;
  const head = probe.subarray(0, bytesRead).toString("utf8");
  const keyIndex = head.indexOf('"clips"');
  const bracketIndex = keyIndex >= 0 ? head.indexOf("[", keyIndex) : -1;

  if (bracketIndex < 0) {
    fs.closeSync(input);
    fs.writeFileSync(file, JSON.stringify({ clips: [clip] }, null, 2));
    return;
  }

  let inspectAt = bracketIndex + 1;
  while (inspectAt < head.length && /\s/.test(head[inspectAt])) {
    inspectAt += 1;
  }
  const needsComma = head[inspectAt] !== "]";
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const output = fs.openSync(tmp, "w");
  const copyBuffer = Buffer.allocUnsafe(DEFAULT_STREAM_CHUNK_SIZE);

  try {
    let remainingPrefix = bracketIndex + 1;
    let readAt = 0;
    while (remainingPrefix > 0) {
      const n = fs.readSync(input, copyBuffer, 0, Math.min(copyBuffer.length, remainingPrefix), readAt);
      if (n <= 0) break;
      fs.writeSync(output, copyBuffer, 0, n);
      readAt += n;
      remainingPrefix -= n;
    }
    fs.writeSync(output, `\n${raw}${needsComma ? "," : ""}`);

    readAt = bracketIndex + 1;
    for (;;) {
      const n = fs.readSync(input, copyBuffer, 0, copyBuffer.length, readAt);
      if (n <= 0) break;
      fs.writeSync(output, copyBuffer, 0, n);
      readAt += n;
    }
  } finally {
    fs.closeSync(input);
    fs.closeSync(output);
  }

  fs.renameSync(tmp, file);
};

const rewriteDbFileStreaming = (file, transform, options = {}) => {
  if (typeof transform !== "function") {
    throw new TypeError("transform must be a function");
  }
  if (!fs.existsSync(file)) {
    ensureDbFile(file);
    return { ok: true, changed: false, kept: 0, scanned: 0 };
  }

  const maxObjects = Math.max(1, Number(options.maxObjects || Number.MAX_SAFE_INTEGER));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const out = fs.openSync(tmp, "w");
  let kept = 0;
  let scanned = 0;
  let changed = false;

  try {
    fs.writeSync(out, '{"clips":[\n');
    visitClipObjectsInFileSync(
      file,
      (clip) => {
        scanned += 1;
        const next = transform(clip, scanned);
        if (next === null || next === undefined) {
          changed = true;
          return true;
        }
        if (next !== clip) {
          changed = true;
        }
        if (kept > 0) fs.writeSync(out, ",\n");
        fs.writeSync(out, JSON.stringify(next));
        kept += 1;
        return true;
      },
      { maxObjects }
    );
    fs.writeSync(out, "\n]}\n");
  } finally {
    fs.closeSync(out);
  }

  if (changed || scanned === 0) {
    fs.renameSync(tmp, file);
  } else {
    fs.rmSync(tmp, { force: true });
  }
  return { ok: true, changed, kept, scanned };
};

const updateClipInDbFile = (file, id, updater, options = {}) => {
  const wanted = String(id || "").trim();
  if (!wanted) return { ok: false, changed: false, reason: "missing-id" };
  let found = false;
  const result = rewriteDbFileStreaming(file, (clip) => {
    if (clip?.id !== wanted) return clip;
    found = true;
    return updater(clip);
  }, options);
  return { ...result, found };
};

const deleteClipFromDbFile = (file, id, options = {}) => {
  const wanted = String(id || "").trim();
  if (!wanted) return { ok: false, changed: false, reason: "missing-id" };
  let found = false;
  const result = rewriteDbFileStreaming(file, (clip) => {
    if (clip?.id !== wanted) return clip;
    found = true;
    return null;
  }, options);
  return { ...result, found };
};

const compactDbFileStreaming = (file, options = {}) => {
  if (!fs.existsSync(file)) {
    ensureDbFile(file);
    return { ok: true, kept: 0, scanned: 0 };
  }

  const maxClips = Math.max(1, Number(options.maxClips || DEFAULT_MAX_SCAN_CLIPS));
  const cutoff = Number.isFinite(options.cutoff) ? Number(options.cutoff) : null;
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  let kept = 0;
  let scanned = 0;
  const out = fs.openSync(tmp, "w");

  try {
    fs.writeSync(out, '{"clips":[\n');
    visitClipObjectsInFileSync(
      file,
      (clip) => {
        scanned += 1;
        if (!clip || clip.isDeleted) return true;
        const createdAt = Number(clip.createdAt || clip.serverUpdatedAt || clip.clientUpdatedAt || 0);
        if (cutoff !== null && !clip.isFavorite && createdAt < cutoff) return true;
        if (kept >= maxClips) return true;
        if (kept > 0) fs.writeSync(out, ",\n");
        fs.writeSync(out, JSON.stringify(clip));
        kept += 1;
        return true;
      },
      { maxObjects: Math.max(1, Number(options.maxObjects || Number.MAX_SAFE_INTEGER)) }
    );
    fs.writeSync(out, "\n]}\n");
  } finally {
    fs.closeSync(out);
  }

  fs.renameSync(tmp, file);
  return { ok: true, kept, scanned };
};

module.exports = {
  DEFAULT_MAX_SCAN_CLIPS,
  compactDbFileStreaming,
  countPendingClipsInDbFile,
  createListClipsFromDbFileCache,
  deleteClipFromDbFile,
  ensureDbFile,
  findClipByIdInDbFile,
  listClipsFromDbFile,
  prependClipToDbFile,
  rewriteDbFileStreaming,
  updateClipInDbFile,
  visitClipObjectsInFileAsync,
  visitClipObjectsInFileSync
};
