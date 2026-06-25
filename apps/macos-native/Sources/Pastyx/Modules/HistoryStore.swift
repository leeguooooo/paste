import Foundation
import SQLite3

/// Raw `import SQLite3` store mirroring the clips schema
/// (columns + indexes from local-history.cjs:26-51).
///
/// Storage layout (mirrors local-history.cjs:19-24):
///   <dir>/local-history.sqlite     clip metadata (WAL mode; never stores full image payloads)
///   <dir>/images/<id>.<ext>        full-resolution images, one file per clip
///
/// `<dir>` is ~/Library/Application Support/Pastyx/.
///
/// The list() projection is "lite" (strips html/full image, keeps the inline
/// preview data url). get(id:) hydrates the full image data url from disk.
public final class HistoryStore: ClipStore, @unchecked Sendable {
    /// SQLite handle.
    private var db: OpaquePointer?

    /// Serialises all access to the connection (the protocol is `Sendable` and
    /// callers may touch the store from any actor / thread).
    private let lock = NSLock()

    /// Directory holding the sqlite file + the images/ subdir.
    private let directory: URL
    private let dbURL: URL
    private let imagesDir: URL

    /// Monotonic insert order; mirrors engine.nextSeq.
    private var nextSeq: Int = 1

    // Retention / cap constants (local-history.cjs:10,13).
    private static let maxLocalClips = 5000
    private static let tombstoneTtlMs: Int64 = 30 * 24 * 60 * 60 * 1000

    /// Transient binder for sqlite3_bind_text (SQLITE_TRANSIENT makes sqlite copy).
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    /// Canonical schema. Run on open.
    public static let schemaSQL = """
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
    """

    public init() {
        let base = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first ?? URL(fileURLWithPath: NSTemporaryDirectory())
        self.directory = base.appendingPathComponent("paste", isDirectory: true)
        self.dbURL = directory.appendingPathComponent("local-history.sqlite")
        self.imagesDir = directory.appendingPathComponent("images", isDirectory: true)
        try? open()
    }

    /// Open the store rooted at an explicit directory. Used by tests (and any
    /// caller that needs an isolated store) so the on-disk layout is identical
    /// to the default init but does not touch the user's real history dir.
    public init(directory: URL) {
        self.directory = directory
        self.dbURL = directory.appendingPathComponent("local-history.sqlite")
        self.imagesDir = directory.appendingPathComponent("images", isDirectory: true)
        try? open()
    }

    deinit {
        if let db { sqlite3_close(db) }
    }

    // MARK: - Open

    private func open() throws {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(dbURL.path, &handle, flags, nil) == SQLITE_OK, let handle else {
            let msg = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "open failed"
            if let handle { sqlite3_close(handle) }
            throw PastyxError.store("sqlite open: \(msg)")
        }
        self.db = handle

        // Best-effort pragmas: WAL keeps reads non-blocking, busy_timeout avoids
        // immediate SQLITE_BUSY when another connection is writing.
        exec("PRAGMA journal_mode = WAL;")
        exec("PRAGMA synchronous = NORMAL;")
        exec("PRAGMA busy_timeout = 5000;")

        guard sqlite3_exec(handle, Self.schemaSQL, nil, nil, nil) == SQLITE_OK else {
            throw PastyxError.store("schema: \(String(cString: sqlite3_errmsg(handle)))")
        }

        nextSeq = max(1, currentMaxSeq() + 1)
    }

    @discardableResult
    private func exec(_ sql: String) -> Bool {
        guard let db else { return false }
        return sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK
    }

    private func currentMaxSeq() -> Int {
        guard let db else { return 0 }
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_prepare_v2(db, "SELECT COALESCE(MAX(seq), 0) FROM clips", -1, &stmt, nil) == SQLITE_OK else {
            return 0
        }
        if sqlite3_step(stmt) == SQLITE_ROW {
            return Int(sqlite3_column_int64(stmt, 0))
        }
        return 0
    }

    // MARK: - Bind helpers

    private func bindText(_ stmt: OpaquePointer?, _ idx: Int32, _ value: String?) {
        if let value {
            sqlite3_bind_text(stmt, idx, value, -1, Self.transient)
        } else {
            sqlite3_bind_null(stmt, idx)
        }
    }

    private func bindInt(_ stmt: OpaquePointer?, _ idx: Int32, _ value: Int64?) {
        if let value {
            sqlite3_bind_int64(stmt, idx, value)
        } else {
            sqlite3_bind_null(stmt, idx)
        }
    }

    private func columnText(_ stmt: OpaquePointer?, _ idx: Int32) -> String? {
        guard let c = sqlite3_column_text(stmt, idx) else { return nil }
        return String(cString: c)
    }

    private func columnInt(_ stmt: OpaquePointer?, _ idx: Int32) -> Int64? {
        if sqlite3_column_type(stmt, idx) == SQLITE_NULL { return nil }
        return sqlite3_column_int64(stmt, idx)
    }

    // MARK: - Row <-> ClipItem

    // Column order matches schemaSQL.
    private enum Col: Int32 {
        case id = 0, seq, userId, deviceId, type, summary, content, contentHTML,
             sourceURL, imagePath, imageMime, imagePreviewDataURL, imageURL,
             isFavorite, isDeleted, tags, clientUpdatedAt, serverUpdatedAt, createdAt, extra
    }

    private func rowToClip(_ stmt: OpaquePointer?) -> ClipItem {
        var extra: [String: String]? = nil
        if let raw = columnText(stmt, Col.extra.rawValue),
           let data = raw.data(using: .utf8),
           let parsed = try? JSONDecoder().decode([String: String].self, from: data) {
            extra = parsed
        }

        var tags: [String] = []
        if let raw = columnText(stmt, Col.tags.rawValue),
           let data = raw.data(using: .utf8),
           let parsed = try? JSONDecoder().decode([String].self, from: data) {
            tags = parsed
        }

        let typeRaw = columnText(stmt, Col.type.rawValue) ?? "text"
        let type = ClipType(rawValue: typeRaw) ?? .text

        return ClipItem(
            id: columnText(stmt, Col.id.rawValue) ?? UUID().uuidString,
            seq: Int(columnInt(stmt, Col.seq.rawValue) ?? 0),
            userId: columnText(stmt, Col.userId.rawValue) ?? "mac_user_demo",
            deviceId: columnText(stmt, Col.deviceId.rawValue) ?? "",
            type: type,
            summary: columnText(stmt, Col.summary.rawValue),
            content: columnText(stmt, Col.content.rawValue),
            contentHTML: columnText(stmt, Col.contentHTML.rawValue),
            sourceURL: columnText(stmt, Col.sourceURL.rawValue),
            imagePath: columnText(stmt, Col.imagePath.rawValue),
            imageMime: columnText(stmt, Col.imageMime.rawValue),
            imagePreviewDataURL: columnText(stmt, Col.imagePreviewDataURL.rawValue),
            imageURL: columnText(stmt, Col.imageURL.rawValue),
            isFavorite: (columnInt(stmt, Col.isFavorite.rawValue) ?? 0) == 1,
            isDeleted: (columnInt(stmt, Col.isDeleted.rawValue) ?? 0) == 1,
            tags: tags,
            clientUpdatedAt: columnInt(stmt, Col.clientUpdatedAt.rawValue),
            serverUpdatedAt: columnInt(stmt, Col.serverUpdatedAt.rawValue),
            createdAt: columnInt(stmt, Col.createdAt.rawValue) ?? 0,
            extra: extra
        )
    }

    // MARK: - Image file handling

    private static let extByMime: [String: String] = [
        "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg",
        "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp",
        "image/tiff": "tiff", "image/svg+xml": "svg", "image/heic": "heic",
        "image/avif": "avif"
    ]
    private static let mimeByExt: [String: String] = [
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "gif": "image/gif", "webp": "image/webp", "bmp": "image/bmp",
        "tiff": "image/tiff", "svg": "image/svg+xml", "heic": "image/heic",
        "avif": "image/avif"
    ]

    /// File name for a clip's full-res image (mirrors imageFileNameForClip).
    private func imageFileName(id: String, mime: String) -> String {
        let ext = Self.extByMime[mime.lowercased()] ?? "bin"
        let allowed = CharacterSet(charactersIn:
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")
        let safe = String(id.unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" }).prefix(120)
        let needsHash = String(safe) != id
        var suffix = ""
        if needsHash {
            suffix = "-" + Self.sha1Hex(id).prefix(8)
        }
        return "\(safe)\(suffix).\(ext)"
    }

    private static func sha1Hex(_ s: String) -> String {
        // Minimal SHA-1 (used only for the rare non-ascii-id image filename suffix).
        var msg = Array(s.utf8)
        let ml = UInt64(msg.count) * 8
        msg.append(0x80)
        while msg.count % 64 != 56 { msg.append(0) }
        for i in stride(from: 56, through: 0, by: -8) {
            msg.append(UInt8((ml >> UInt64(i)) & 0xff))
        }
        var h0: UInt32 = 0x67452301, h1: UInt32 = 0xEFCDAB89, h2: UInt32 = 0x98BADCFE
        var h3: UInt32 = 0x10325476, h4: UInt32 = 0xC3D2E1F0
        func rol(_ v: UInt32, _ n: UInt32) -> UInt32 { (v << n) | (v >> (32 - n)) }
        for chunk in stride(from: 0, to: msg.count, by: 64) {
            var w = [UInt32](repeating: 0, count: 80)
            for i in 0..<16 {
                let o = chunk + i * 4
                w[i] = (UInt32(msg[o]) << 24) | (UInt32(msg[o + 1]) << 16)
                     | (UInt32(msg[o + 2]) << 8) | UInt32(msg[o + 3])
            }
            for i in 16..<80 { w[i] = rol(w[i-3] ^ w[i-8] ^ w[i-14] ^ w[i-16], 1) }
            var a = h0, b = h1, c = h2, d = h3, e = h4
            for i in 0..<80 {
                let f: UInt32, k: UInt32
                switch i {
                case 0..<20:  f = (b & c) | (~b & d);          k = 0x5A827999
                case 20..<40: f = b ^ c ^ d;                   k = 0x6ED9EBA1
                case 40..<60: f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC
                default:      f = b ^ c ^ d;                   k = 0xCA62C1D6
                }
                let t = rol(a, 5) &+ f &+ e &+ k &+ w[i]
                e = d; d = c; c = rol(b, 30); b = a; a = t
            }
            h0 = h0 &+ a; h1 = h1 &+ b; h2 = h2 &+ c; h3 = h3 &+ d; h4 = h4 &+ e
        }
        return [h0, h1, h2, h3, h4].map { String(format: "%08x", $0) }.joined()
    }

    /// Decode a `data:<mime>;base64,...` data url into (mime, bytes).
    private func parseDataURL(_ value: String?) -> (mime: String, data: Data)? {
        guard let value, value.hasPrefix("data:"),
              let comma = value.firstIndex(of: ",") else { return nil }
        let header = String(value[value.index(value.startIndex, offsetBy: 5)..<comma])
        guard header.lowercased().hasSuffix(";base64") else { return nil }
        let mime = header.replacingOccurrences(of: ";base64", with: "",
                                               options: [.caseInsensitive, .anchored])
            .split(separator: ";").first.map { String($0).trimmingCharacters(in: .whitespaces).lowercased() }
            ?? "application/octet-stream"
        let b64 = String(value[value.index(after: comma)...])
        guard let data = Data(base64Encoded: b64) else { return nil }
        return (mime.isEmpty ? "application/octet-stream" : mime, data)
    }

    /// Persist a clip's full image to disk (if it carries one inline via extra
    /// `__rawImageDataUrl`) and return the on-disk file name + mime, or any
    /// already-stored values. Mirrors storeClipRow's image handling.
    private func persistImage(for item: ClipItem, previousPath: String?, previousMime: String?) -> (path: String?, mime: String?) {
        // Inline full-res data url is carried in extra["__rawImageDataUrl"] (the
        // canonical column-set has no inline full image — only path/preview).
        let dataURL = item.extra?["__rawImageDataUrl"]
        guard let parsed = parseDataURL(dataURL) else {
            // No new image payload: preserve whatever was already attached.
            return (item.imagePath ?? previousPath, item.imageMime ?? previousMime)
        }

        let fileName = imageFileName(id: item.id, mime: parsed.mime)
        let target = imagesDir.appendingPathComponent(fileName)
        try? FileManager.default.createDirectory(at: imagesDir, withIntermediateDirectories: true)

        // Idempotent: skip rewrite if the file already holds the same byte count.
        let attrs = try? FileManager.default.attributesOfItem(atPath: target.path)
        let existingSize = (attrs?[.size] as? Int) ?? -1
        if existingSize != parsed.data.count {
            try? parsed.data.write(to: target)
        }
        if let prev = previousPath, prev != fileName {
            try? FileManager.default.removeItem(at: imagesDir.appendingPathComponent(prev))
        }
        return (fileName, parsed.mime)
    }

    private func removeImageFile(_ path: String?) {
        guard let path, !path.isEmpty else { return }
        try? FileManager.default.removeItem(at: imagesDir.appendingPathComponent(path))
    }

    /// Hydrate the full image data url from disk for a fetched clip.
    private func hydrateImageDataURL(_ clip: inout ClipItem) {
        guard let path = clip.imagePath, !path.isEmpty else { return }
        let url = imagesDir.appendingPathComponent(path)
        guard let data = try? Data(contentsOf: url) else { return }
        let mime = clip.imageMime
            ?? Self.mimeByExt[url.pathExtension.lowercased()]
            ?? "application/octet-stream"
        var extra = clip.extra ?? [:]
        extra["__rawImageDataUrl"] = "data:\(mime);base64,\(data.base64EncodedString())"
        clip.extra = extra
    }

    // MARK: - ClipStore

    public func list(_ query: ClipQuery) throws -> [ClipItem] {
        lock.lock(); defer { lock.unlock() }
        guard let db else { throw PastyxError.store("db not open") }

        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        // Scan enough rows to apply the substring/favorite filters in Swift, then
        // cap to limit (mirrors listClipsFromDbFile: scan up to 5000, keep limit).
        let scanCap = max(query.limit + 1, Self.maxLocalClips)
        let sql = "SELECT * FROM clips WHERE is_deleted = 0 ORDER BY created_at DESC, seq DESC LIMIT ?"
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw PastyxError.store("list prepare: \(String(cString: sqlite3_errmsg(db)))")
        }
        sqlite3_bind_int64(stmt, 1, Int64(scanCap))

        let needle = query.search.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var out: [ClipItem] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            var clip = rowToClip(stmt)
            if query.favoritesOnly && !clip.isFavorite { continue }
            if !matches(clip, needle) { continue }
            // Lite projection: strip html + inline full image, keep the preview
            // data url. imagePath is retained so get() can hydrate it later.
            clip.contentHTML = nil
            clip.extra?["__rawImageDataUrl"] = nil
            out.append(clip)
            if out.count >= query.limit { break }
        }
        return out
    }

    /// Case-insensitive substring on summary/content/sourceURL; falls back to
    /// html-derived text when content is empty (mirrors matchesClipQuery).
    private func matches(_ clip: ClipItem, _ needle: String) -> Bool {
        if needle.isEmpty { return true }
        if (clip.summary?.lowercased().contains(needle) ?? false) { return true }
        if (clip.content?.lowercased().contains(needle) ?? false) { return true }
        if (clip.sourceURL?.lowercased().contains(needle) ?? false) { return true }
        if (clip.content?.isEmpty ?? true), let html = clip.contentHTML {
            return Self.htmlToText(html).lowercased().contains(needle)
        }
        return false
    }

    private static func htmlToText(_ html: String) -> String {
        var s = html
        s = s.replacingOccurrences(of: "<style[\\s\\S]*?</style>", with: " ", options: .regularExpression)
        s = s.replacingOccurrences(of: "<script[\\s\\S]*?</script>", with: " ", options: .regularExpression)
        s = s.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
        s = s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public func get(id: String) throws -> ClipItem? {
        lock.lock(); defer { lock.unlock() }
        guard let db else { throw PastyxError.store("db not open") }
        let wanted = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !wanted.isEmpty else { return nil }

        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_prepare_v2(db, "SELECT * FROM clips WHERE id = ?", -1, &stmt, nil) == SQLITE_OK else {
            throw PastyxError.store("get prepare: \(String(cString: sqlite3_errmsg(db)))")
        }
        bindText(stmt, 1, wanted)
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        var clip = rowToClip(stmt)
        if clip.isDeleted { return nil }
        hydrateImageDataURL(&clip)
        return clip
    }

    @discardableResult
    public func create(_ item: ClipItem) throws -> ClipItem {
        lock.lock(); defer { lock.unlock() }
        guard let db else { throw PastyxError.store("db not open") }

        var stored = item
        let id = stored.id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty else { throw PastyxError.store("create: empty id") }
        stored.id = id

        // Resolve seq + prior image state for an upsert.
        let previous = try? fetchRow(id: id)
        let seq = previous?.seq ?? nextSeq
        let image = persistImage(for: stored, previousPath: previous?.imagePath, previousMime: previous?.imageMime)
        stored.imagePath = image.path
        stored.imageMime = image.mime
        stored.seq = seq

        // Strip the inline full-image data url out of `extra` before persisting:
        // it lives on disk now, not in the row.
        var extra = stored.extra
        extra?["__rawImageDataUrl"] = nil
        if extra?.isEmpty == true { extra = nil }

        let sql = """
        INSERT INTO clips (
          id, seq, user_id, device_id, type, summary, content, content_html, source_url,
          image_path, image_mime, image_preview_data_url, image_url,
          is_favorite, is_deleted, tags, client_updated_at, server_updated_at, created_at, extra
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          seq = excluded.seq, user_id = excluded.user_id, device_id = excluded.device_id,
          type = excluded.type, summary = excluded.summary, content = excluded.content,
          content_html = excluded.content_html, source_url = excluded.source_url,
          image_path = excluded.image_path, image_mime = excluded.image_mime,
          image_preview_data_url = excluded.image_preview_data_url, image_url = excluded.image_url,
          is_favorite = excluded.is_favorite, is_deleted = excluded.is_deleted, tags = excluded.tags,
          client_updated_at = excluded.client_updated_at, server_updated_at = excluded.server_updated_at,
          created_at = excluded.created_at, extra = excluded.extra
        """

        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw PastyxError.store("insert prepare: \(String(cString: sqlite3_errmsg(db)))")
        }

        let tagsJSON = (try? String(data: JSONEncoder().encode(stored.tags), encoding: .utf8) ?? nil) ?? "[]"
        let extraJSON: String? = {
            guard let extra, !extra.isEmpty,
                  let data = try? JSONEncoder().encode(extra) else { return nil }
            return String(data: data, encoding: .utf8)
        }()

        bindText(stmt, 1, stored.id)
        sqlite3_bind_int64(stmt, 2, Int64(seq))
        bindText(stmt, 3, stored.userId)
        bindText(stmt, 4, stored.deviceId)
        bindText(stmt, 5, stored.type.rawValue)
        bindText(stmt, 6, stored.summary)
        bindText(stmt, 7, stored.content)
        bindText(stmt, 8, stored.contentHTML)
        bindText(stmt, 9, stored.sourceURL)
        bindText(stmt, 10, stored.imagePath)
        bindText(stmt, 11, stored.imageMime)
        bindText(stmt, 12, stored.imagePreviewDataURL)
        bindText(stmt, 13, stored.imageURL)
        sqlite3_bind_int64(stmt, 14, stored.isFavorite ? 1 : 0)
        sqlite3_bind_int64(stmt, 15, stored.isDeleted ? 1 : 0)
        bindText(stmt, 16, tagsJSON)
        bindInt(stmt, 17, stored.clientUpdatedAt)
        bindInt(stmt, 18, stored.serverUpdatedAt)
        sqlite3_bind_int64(stmt, 19, stored.createdAt)
        bindText(stmt, 20, extraJSON)

        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw PastyxError.store("insert: \(String(cString: sqlite3_errmsg(db)))")
        }

        if previous == nil { nextSeq = max(nextSeq, seq) + 1 }
        return stored
    }

    /// Test support: fetch a row by id REGARDLESS of its is_deleted flag (so a
    /// tombstone can be observed). Returns nil when no row exists at all.
    /// Distinct from get(id:), which excludes tombstones.
    func rowIncludingDeleted(id: String) -> ClipItem? {
        lock.lock(); defer { lock.unlock() }
        return try? fetchRow(id: id)
    }

    /// Lightweight row fetch (no image hydration) used internally for upserts.
    private func fetchRow(id: String) throws -> ClipItem? {
        guard let db else { return nil }
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_prepare_v2(db, "SELECT * FROM clips WHERE id = ?", -1, &stmt, nil) == SQLITE_OK else {
            return nil
        }
        bindText(stmt, 1, id)
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        return rowToClip(stmt)
    }

    public func setFavorite(id: String, _ isFavorite: Bool) throws {
        lock.lock(); defer { lock.unlock() }
        guard let db else { throw PastyxError.store("db not open") }
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        let sql = "UPDATE clips SET is_favorite = ?, client_updated_at = ? WHERE id = ?"
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw PastyxError.store("favorite prepare: \(String(cString: sqlite3_errmsg(db)))")
        }
        sqlite3_bind_int64(stmt, 1, isFavorite ? 1 : 0)
        sqlite3_bind_int64(stmt, 2, Int64(Date().timeIntervalSince1970 * 1000))
        bindText(stmt, 3, id)
        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw PastyxError.store("favorite: \(String(cString: sqlite3_errmsg(db)))")
        }
    }

    public func softDelete(id: String) throws {
        lock.lock(); defer { lock.unlock() }
        guard let db else { throw PastyxError.store("db not open") }
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        // Soft delete / tombstone: bump client_updated_at so the TTL clock starts now.
        let sql = "UPDATE clips SET is_deleted = 1, client_updated_at = ? WHERE id = ?"
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw PastyxError.store("delete prepare: \(String(cString: sqlite3_errmsg(db)))")
        }
        sqlite3_bind_int64(stmt, 1, Int64(Date().timeIntervalSince1970 * 1000))
        bindText(stmt, 2, id)
        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw PastyxError.store("delete: \(String(cString: sqlite3_errmsg(db)))")
        }
    }

    public func prune(retention: Retention) throws {
        try prune(retention: retention, maxClips: Self.maxLocalClips, tombstoneTtlMs: Self.tombstoneTtlMs)
    }

    /// Core prune with explicit cap + TTL (the public `prune` delegates with the
    /// canonical 5000 cap and 30-day TTL). The extra parameters exist so tests can
    /// drive the SAME SQL with a small cap / zero TTL — exactly as Electron's
    /// compactDbFileStreaming accepts `{maxClips, tombstoneTtlMs}` overrides.
    func prune(retention: Retention, maxClips: Int, tombstoneTtlMs: Int64) throws {
        lock.lock(); defer { lock.unlock() }
        guard let db else { throw PastyxError.store("db not open") }

        let now = Int64(Date().timeIntervalSince1970 * 1000)

        // Collect image files that are about to be orphaned so we can rm them.
        // (Done before the deletes; orphan sweep below catches the rest.)
        exec("BEGIN IMMEDIATE")

        // 1. Reap tombstones older than the TTL (so deletes have time to propagate).
        do {
            var stmt: OpaquePointer?
            let sql = """
            DELETE FROM clips WHERE is_deleted = 1 AND MAX(
              COALESCE(server_updated_at, 0), COALESCE(client_updated_at, 0), COALESCE(created_at, 0)
            ) < ?
            """
            if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_int64(stmt, 1, now - tombstoneTtlMs)
                sqlite3_step(stmt)
            }
            sqlite3_finalize(stmt)
        }

        // 2. Retention cutoff: drop non-favorite clips older than the window.
        //    forever => no cutoff (noop). Favorites are always exempt.
        if let windowMs = retention.milliseconds {
            let cutoff = now - windowMs
            var stmt: OpaquePointer?
            let sql = "DELETE FROM clips WHERE is_favorite = 0 AND is_deleted = 0 AND created_at < ?"
            if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_int64(stmt, 1, cutoff)
                sqlite3_step(stmt)
            }
            sqlite3_finalize(stmt)
        }

        // 3. Hard cap MAX_LOCAL_CLIPS (favorites kept first then newest). Mirrors
        //    deleteOverCap: keep newest `maxClips` by (created_at DESC, seq DESC).
        do {
            var stmt: OpaquePointer?
            let sql = """
            DELETE FROM clips WHERE id IN (
              SELECT id FROM clips
              ORDER BY is_favorite DESC, created_at DESC, seq DESC
              LIMIT -1 OFFSET ?
            )
            """
            if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK {
                sqlite3_bind_int64(stmt, 1, Int64(maxClips))
                sqlite3_step(stmt)
            }
            sqlite3_finalize(stmt)
        }

        if !exec("COMMIT") {
            exec("ROLLBACK")
            throw PastyxError.store("prune commit: \(String(cString: sqlite3_errmsg(db)))")
        }

        // 4. Orphaned image-file sweep: rm any file in images/ no row references.
        cleanupOrphanImages()
        exec("PRAGMA wal_checkpoint(TRUNCATE);")
    }

    private func cleanupOrphanImages() {
        guard let db else { return }
        let fm = FileManager.default
        guard let names = try? fm.contentsOfDirectory(atPath: imagesDir.path) else { return }

        var referenced = Set<String>()
        var stmt: OpaquePointer?
        if sqlite3_prepare_v2(db, "SELECT image_path FROM clips WHERE image_path IS NOT NULL", -1, &stmt, nil) == SQLITE_OK {
            while sqlite3_step(stmt) == SQLITE_ROW {
                if let p = columnText(stmt, 0) { referenced.insert(p) }
            }
        }
        sqlite3_finalize(stmt)

        for name in names where !referenced.contains(name) {
            try? fm.removeItem(at: imagesDir.appendingPathComponent(name))
        }
    }
}
