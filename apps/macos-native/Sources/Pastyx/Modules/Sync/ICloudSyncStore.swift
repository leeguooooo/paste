import Foundation
import SQLite3

/// Direct-SQLite accessor used ONLY by the iCloud sync coordinator.
///
/// The native `ClipStore` protocol intentionally hides tombstones (`list()`
/// filters `is_deleted = 0`) and has no hard-delete. The iCloud merge needs
/// BOTH: tombstones travel in the cross-device JSON (so other devices learn of
/// deletions — see the tombstone contract), and the local-direction write-back
/// hard-deletes any id that fell out of the merged/retention set
/// (`deleteClipFromDbFile`, main.cjs step 5 — NOT a user-delete, so no
/// tombstone).
///
/// This opens its OWN connection to the SAME sqlite file the `HistoryStore`
/// owns. That is safe by design: the store uses WAL + `busy_timeout = 5000`
/// (HistoryStore.swift:96-98), exactly mirroring the Electron model where
/// `syncLocalDbWithICloud` and the IPC writers operate on the same `.sqlite`
/// through independent `better-sqlite3` handles. All writes here go through the
/// store's own `create()` (an upsert) — this accessor only ADDS read-all and
/// hard-delete, never a parallel write path for the row payload.
///
/// Wire format note: the cloud JSON uses the Electron camelCase clip shape
/// (`contentHtml`, `sourceUrl`, `imageDataUrl`, …); the row<->ClipItem mapping
/// here matches `HistoryStore`'s column order byte-for-byte so seq/tombstones/
/// favorites/timestamps round-trip exactly.
final class ICloudSyncStore {
    private let directory: URL
    private let dbURL: URL
    private let imagesDir: URL

    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    init() {
        let base = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first ?? URL(fileURLWithPath: NSTemporaryDirectory())
        // MUST match HistoryStore.swift:70 ("paste" subdir).
        self.directory = base.appendingPathComponent("paste", isDirectory: true)
        self.dbURL = directory.appendingPathComponent("local-history.sqlite")
        self.imagesDir = directory.appendingPathComponent("images", isDirectory: true)
    }

    // MARK: - Connection

    private func withDB<T>(_ body: (OpaquePointer) throws -> T) rethrows -> T? {
        var handle: OpaquePointer?
        // Read-write so hard-delete works; create disabled (the store owns
        // creation). If the file is missing there is nothing to sync from.
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(dbURL.path, &handle, flags, nil) == SQLITE_OK, let handle else {
            if let handle { sqlite3_close(handle) }
            return nil
        }
        defer { sqlite3_close(handle) }
        sqlite3_exec(handle, "PRAGMA busy_timeout = 5000;", nil, nil, nil)
        return try? body(handle)
    }

    // MARK: - Image hydration (mirrors HistoryStore.hydrateImageDataURL)

    private static let mimeByExt: [String: String] = [
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "gif": "image/gif", "webp": "image/webp", "bmp": "image/bmp",
        "tiff": "image/tiff", "svg": "image/svg+xml", "heic": "image/heic",
        "avif": "image/avif"
    ]

    /// Total bytes of on-disk image files (cheap budget estimate without
    /// reading them). Mirrors estimateClipPayloadBytesInDbFile's intent.
    func estimateImageBytes() -> Int64 {
        var total: Int64 = 0
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: imagesDir.path) else {
            return 0
        }
        for name in names {
            let p = imagesDir.appendingPathComponent(name).path
            if let attrs = try? FileManager.default.attributesOfItem(atPath: p),
               let size = attrs[.size] as? Int {
                total += Int64(size)
            }
        }
        return total
    }

    private func imageDataURL(path: String?, mime: String?) -> String? {
        guard let path, !path.isEmpty else { return nil }
        let url = imagesDir.appendingPathComponent(path)
        guard let data = try? Data(contentsOf: url) else { return nil }
        let resolvedMime = mime
            ?? Self.mimeByExt[url.pathExtension.lowercased()]
            ?? "application/octet-stream"
        return "data:\(resolvedMime);base64,\(data.base64EncodedString())"
    }

    private func imageByteLength(path: String?) -> Int {
        guard let path, !path.isEmpty else { return 0 }
        let p = imagesDir.appendingPathComponent(path).path
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: p),
              let size = attrs[.size] as? Int else { return 0 }
        // base64 inflates ~4/3 + data-url header; the export budget is an
        // estimate anyway, so approximate the encoded size.
        return (size * 4) / 3 + 64
    }

    // MARK: - Read all clips (INCLUDING tombstones)

    private func column(_ stmt: OpaquePointer?, _ idx: Int32) -> String? {
        guard let c = sqlite3_column_text(stmt, idx) else { return nil }
        return String(cString: c)
    }
    private func columnInt(_ stmt: OpaquePointer?, _ idx: Int32) -> Int64? {
        if sqlite3_column_type(stmt, idx) == SQLITE_NULL { return nil }
        return sqlite3_column_int64(stmt, idx)
    }

    // Column order matches HistoryStore.schemaSQL.
    private func rowToClip(_ stmt: OpaquePointer?, hydrate: Bool) -> ClipItem {
        var extra: [String: String]? = nil
        if let raw = column(stmt, 19),
           let data = raw.data(using: .utf8),
           let parsed = try? JSONDecoder().decode([String: String].self, from: data) {
            extra = parsed
        }
        var tags: [String] = []
        if let raw = column(stmt, 15),
           let data = raw.data(using: .utf8),
           let parsed = try? JSONDecoder().decode([String].self, from: data) {
            tags = parsed
        }
        let type = ClipType(rawValue: column(stmt, 4) ?? "text") ?? .text
        let imagePath = column(stmt, 9)
        let imageMime = column(stmt, 10)

        var clip = ClipItem(
            id: column(stmt, 0) ?? UUID().uuidString,
            seq: Int(columnInt(stmt, 1) ?? 0),
            userId: column(stmt, 2) ?? "mac_user_demo",
            deviceId: column(stmt, 3) ?? "",
            type: type,
            summary: column(stmt, 5),
            content: column(stmt, 6),
            contentHTML: column(stmt, 7),
            sourceURL: column(stmt, 8),
            imagePath: imagePath,
            imageMime: imageMime,
            imagePreviewDataURL: column(stmt, 11),
            imageURL: column(stmt, 12),
            isFavorite: (columnInt(stmt, 13) ?? 0) == 1,
            isDeleted: (columnInt(stmt, 14) ?? 0) == 1,
            tags: tags,
            clientUpdatedAt: columnInt(stmt, 16),
            serverUpdatedAt: columnInt(stmt, 17),
            createdAt: columnInt(stmt, 18) ?? 0,
            extra: extra
        )
        if hydrate, let dataURL = imageDataURL(path: imagePath, mime: imageMime) {
            var e = clip.extra ?? [:]
            e["__rawImageDataUrl"] = dataURL
            clip.extra = e
        }
        return clip
    }

    /// All clips (tombstones INCLUDED), newest-first, images hydrated within a
    /// byte budget. Mirrors readLocalClipsForICloudSync (main.cjs:691-732):
    /// under budget => hydrate ALL; over budget => hydrate newest-first until
    /// the budget is spent, the rest travel preview-only. Returns nil on a hard
    /// read failure (so the caller surfaces "local-read-failed" and never
    /// silently drops history).
    func readAllForSync(byteBudget: Int64) -> [ClipItem]? {
        let estimated = estimateImageBytes()
        let hydrateAll = estimated <= byteBudget

        return withDB { db -> [ClipItem]? in
            var stmt: OpaquePointer?
            defer { sqlite3_finalize(stmt) }
            // Order newest-first so the budget hydrates the freshest images.
            let sql = "SELECT * FROM clips ORDER BY created_at DESC, seq DESC"
            guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else { return nil }

            var out: [ClipItem] = []
            var spent: Int64 = 0
            while sqlite3_step(stmt) == SQLITE_ROW {
                if hydrateAll {
                    out.append(rowToClip(stmt, hydrate: true))
                    continue
                }
                // Budgeted hydration: read metadata first, hydrate only if it
                // still fits.
                let meta = rowToClip(stmt, hydrate: false)
                let imgLen = Int64(imageByteLength(path: meta.imagePath))
                if meta.imagePath != nil, spent + imgLen <= byteBudget,
                   let dataURL = imageDataURL(path: meta.imagePath, mime: meta.imageMime) {
                    var hydrated = meta
                    var e = hydrated.extra ?? [:]
                    e["__rawImageDataUrl"] = dataURL
                    hydrated.extra = e
                    spent += imgLen
                    out.append(hydrated)
                } else {
                    out.append(meta)
                }
            }
            return out
        } ?? nil
    }

    /// Count of non-deleted clips (countPendingClipsInDbFile, used by local-sync).
    func countPending() -> Int {
        withDB { db -> Int in
            var stmt: OpaquePointer?
            defer { sqlite3_finalize(stmt) }
            guard sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM clips WHERE is_deleted = 0", -1, &stmt, nil) == SQLITE_OK else {
                return 0
            }
            if sqlite3_step(stmt) == SQLITE_ROW { return Int(sqlite3_column_int64(stmt, 0)) }
            return 0
        } ?? 0
    }

    /// All non-deleted clips with images hydrated (for the one-time bulk upload).
    func readNonDeletedHydrated() -> [ClipItem] {
        withDB { db -> [ClipItem] in
            var stmt: OpaquePointer?
            defer { sqlite3_finalize(stmt) }
            guard sqlite3_prepare_v2(db, "SELECT * FROM clips WHERE is_deleted = 0 ORDER BY created_at DESC, seq DESC", -1, &stmt, nil) == SQLITE_OK else {
                return []
            }
            var out: [ClipItem] = []
            while sqlite3_step(stmt) == SQLITE_ROW {
                out.append(rowToClip(stmt, hydrate: true))
            }
            return out
        } ?? []
    }

    // MARK: - Hard delete (retention eviction in the sync local-direction)

    /// Hard-delete a row AND its image file, synchronously (mirrors
    /// deleteClipFromDbFile + removeImageFileSync). This is NOT a user-delete:
    /// it removes ids that fell out of the merged/retention set, so it does NOT
    /// leave a tombstone (the row vanishes entirely).
    func hardDelete(id: String) {
        withDB { db in
            // Find the image file first so we can unlink it after the row goes.
            var imagePath: String?
            var sel: OpaquePointer?
            if sqlite3_prepare_v2(db, "SELECT image_path FROM clips WHERE id = ?", -1, &sel, nil) == SQLITE_OK {
                sqlite3_bind_text(sel, 1, id, -1, Self.transient)
                if sqlite3_step(sel) == SQLITE_ROW { imagePath = column(sel, 0) }
            }
            sqlite3_finalize(sel)

            var del: OpaquePointer?
            if sqlite3_prepare_v2(db, "DELETE FROM clips WHERE id = ?", -1, &del, nil) == SQLITE_OK {
                sqlite3_bind_text(del, 1, id, -1, Self.transient)
                sqlite3_step(del)
            }
            sqlite3_finalize(del)

            // Synchronous unlink, ordered after the row delete (risks #10): a
            // deferred unlink could land after a newer write recreated the path.
            if let imagePath, !imagePath.isEmpty {
                try? FileManager.default.removeItem(at: self.imagesDir.appendingPathComponent(imagePath))
            }
        }
    }
}
