import Foundation
import SQLite3

/// One-time Electron -> native data migrator (Migrator).
///
/// Source (Electron userData): ~/Library/Application Support/@paste/macos
///   - pastyx-local-clips.sqlite (+ -wal/-shm)  schema byte-identical to native
///   - images/<id>.<ext>                         one file per image clip
///   - pastyx-macos-config.json                  the REAL Electron config
///   (IGNORE pastyx-local-clips.json.migrated*.bak — superseded legacy exports.)
///
/// Target (native HistoryStore dir): ~/Library/Application Support/paste
///   - local-history.sqlite, images/, config.json
///
/// Strategy: the native HistoryStore is already open by the time this runs
/// (AppDelegate constructs it before migrateIfNeeded), so a verbatim file copy
/// of the sqlite would race the live connection. Instead we open the old DB
/// READ-ONLY, iterate every row (including tombstones + favorites), copy each
/// clip's image file into the native images/ dir, and `store.create()` it. That
/// path is upsert-by-id so it preserves seq / favorites / tombstones / timestamps
/// / image_path links exactly, and is naturally idempotent on the clip id.
///
/// The whole migration is additionally guarded by a marker file written on
/// success so it never re-runs. Config JSON is mapped into AppConfig and saved.
/// The Electron dir is NEVER deleted (the user uninstalls it themselves), and
/// the .json.migrated*.bak legacy exports are NEVER imported (they are superseded
/// by the sqlite store — re-importing would resurrect deleted/duplicate data).
@MainActor
public final class ElectronMigrator: Migrator {
    private let store: ClipStore
    private let config: ConfigStore

    private let fm = FileManager.default

    private var appSupport: URL {
        fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
    }
    private var electronDir: URL {
        appSupport.appendingPathComponent("@paste/macos", isDirectory: true)
    }
    /// Mirrors HistoryStore.init's directory (~/Library/Application Support/paste).
    private var nativeDir: URL {
        appSupport.appendingPathComponent("paste", isDirectory: true)
    }
    private var markerURL: URL {
        nativeDir.appendingPathComponent(".electron-migrated")
    }

    // Source file names (oldDataFormat spec).
    private static let electronSqlite = "pastyx-local-clips.sqlite"
    private static let electronConfig = "pastyx-macos-config.json"

    private var electronSqliteURL: URL {
        electronDir.appendingPathComponent(Self.electronSqlite)
    }
    private var electronImagesDir: URL {
        electronDir.appendingPathComponent("images", isDirectory: true)
    }
    private var nativeImagesDir: URL {
        nativeDir.appendingPathComponent("images", isDirectory: true)
    }
    private var electronConfigURL: URL {
        electronDir.appendingPathComponent(Self.electronConfig)
    }

    /// SQLITE_TRANSIENT — tells sqlite to copy bound text.
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    public init(store: ClipStore, config: ConfigStore) {
        self.store = store
        self.config = config
    }

    // MARK: - Migrator

    public func needsMigration() -> Bool {
        guard !fm.fileExists(atPath: markerURL.path) else { return false }
        return fm.fileExists(atPath: electronSqliteURL.path)
    }

    @discardableResult
    public func migrateIfNeeded() async -> MigrationResult {
        guard needsMigration() else {
            if fm.fileExists(atPath: markerURL.path) {
                return MigrationResult(migrated: false, note: "already migrated")
            }
            return MigrationResult(migrated: false, note: "no electron data found")
        }

        // 1. Import clips (idempotent: upsert-by-id through the store).
        let clipResult: (clips: Int, images: Int)
        do {
            clipResult = try importClips()
        } catch {
            // Don't write the marker on a hard failure — let a future launch retry.
            return MigrationResult(
                migrated: false,
                note: "migration failed: \(error)"
            )
        }

        // 2. Map the Electron config JSON into AppConfig (best-effort).
        let configMigrated = migrateConfig()

        // 3. Write the marker so this never re-runs.
        writeMarker(clips: clipResult.clips, images: clipResult.images, config: configMigrated)

        return MigrationResult(
            migrated: true,
            clipCount: clipResult.clips,
            imageCount: clipResult.images,
            configMigrated: configMigrated,
            note: "migrated \(clipResult.clips) clips, \(clipResult.images) images"
                + (configMigrated ? ", config" : "")
        )
    }

    // MARK: - Clip import

    /// Open the old DB read-only, iterate every row, copy its image file, and
    /// upsert it through the native store. Returns (clipCount, imageCount).
    private func importClips() throws -> (clips: Int, images: Int) {
        // Ensure the native images dir exists for the file copies.
        try? fm.createDirectory(at: nativeImagesDir, withIntermediateDirectories: true)

        var handle: OpaquePointer?
        // READONLY so we never mutate the user's Electron data. (NOMUTEX is fine:
        // we touch this connection only from the current actor.)
        let flags = SQLITE_OPEN_READONLY
        guard sqlite3_open_v2(electronSqliteURL.path, &handle, flags, nil) == SQLITE_OK,
              let db = handle else {
            if let handle { sqlite3_close(handle) }
            throw SyncError.migrationSource("cannot open electron sqlite read-only")
        }
        defer { sqlite3_close(db) }

        // Select columns explicitly (by name, not *) so the import is robust to
        // any future column-order drift between the two schemas.
        let sql = """
        SELECT id, seq, user_id, device_id, type, summary, content, content_html,
               source_url, image_path, image_mime, image_preview_data_url, image_url,
               is_favorite, is_deleted, tags, client_updated_at, server_updated_at,
               created_at, extra
        FROM clips
        ORDER BY seq ASC
        """
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw SyncError.migrationSource(
                "prepare failed: \(String(cString: sqlite3_errmsg(db)))"
            )
        }

        var clipCount = 0
        var imageCount = 0

        while sqlite3_step(stmt) == SQLITE_ROW {
            let clip = rowToClip(stmt)

            // Copy the full-res image file alongside (by image_path, verbatim) so
            // the migrated row's image_path link stays valid. Done BEFORE the row
            // upsert (image present when the clip first appears).
            if let path = clip.imagePath, !path.isEmpty {
                if copyImageFile(named: path) { imageCount += 1 }
            }

            // store.create() is upsert-by-id; preserves seq/favorite/deleted/
            // timestamps/image_path. Because we pass imagePath/imageMime through
            // and DON'T attach extra["__rawImageDataUrl"], persistImage preserves
            // our copied file rather than re-deriving it (no base64 round-trip,
            // and full image bytes NEVER touch the sqlite row — risks #12).
            do {
                _ = try store.create(clip)
                clipCount += 1
            } catch {
                // Skip a single bad row rather than aborting the whole migration;
                // the rest of the history is still worth carrying over.
                NSLog("[pastyx] migrate: skip clip \(clip.id): \(error)")
            }
        }

        return (clipCount, imageCount)
    }

    /// Copy a single image file from the Electron images/ dir to the native one.
    /// Idempotent: skips when the destination already exists. Returns true on a
    /// successful copy or an already-present destination.
    @discardableResult
    private func copyImageFile(named path: String) -> Bool {
        let src = electronImagesDir.appendingPathComponent(path)
        let dst = nativeImagesDir.appendingPathComponent(path)
        if fm.fileExists(atPath: dst.path) { return true }
        guard fm.fileExists(atPath: src.path) else { return false }
        do {
            try fm.copyItem(at: src, to: dst)
            return true
        } catch {
            NSLog("[pastyx] migrate: image copy failed \(path): \(error)")
            return false
        }
    }

    // MARK: - Row -> ClipItem (mirrors HistoryStore.rowToClip column order)

    private func rowToClip(_ stmt: OpaquePointer?) -> ClipItem {
        let typeRaw = colText(stmt, 4) ?? "text"
        let type = ClipType(rawValue: typeRaw) ?? .text

        var tags: [String] = []
        if let raw = colText(stmt, 15), let data = raw.data(using: .utf8),
           let parsed = try? JSONDecoder().decode([String].self, from: data) {
            tags = parsed
        }

        var extra: [String: String]? = nil
        if let raw = colText(stmt, 19), let data = raw.data(using: .utf8),
           let parsed = try? JSONDecoder().decode([String: String].self, from: data),
           !parsed.isEmpty {
            // Drop any inline full-image data url defensively — full images live
            // as files; never let base64 reach the native row (risks #12).
            extra = parsed
            extra?["__rawImageDataUrl"] = nil
            if extra?.isEmpty == true { extra = nil }
        }

        return ClipItem(
            id: colText(stmt, 0) ?? UUID().uuidString,
            seq: Int(colInt(stmt, 1) ?? 0),
            userId: colText(stmt, 2) ?? "mac_user_demo",
            deviceId: colText(stmt, 3) ?? "",
            type: type,
            summary: colText(stmt, 5),
            content: colText(stmt, 6),
            contentHTML: colText(stmt, 7),
            sourceURL: colText(stmt, 8),
            imagePath: colText(stmt, 9),
            imageMime: colText(stmt, 10),
            imagePreviewDataURL: colText(stmt, 11),
            imageURL: colText(stmt, 12),
            isFavorite: (colInt(stmt, 13) ?? 0) == 1,
            isDeleted: (colInt(stmt, 14) ?? 0) == 1,
            tags: tags,
            clientUpdatedAt: colInt(stmt, 16),
            serverUpdatedAt: colInt(stmt, 17),
            createdAt: colInt(stmt, 18) ?? 0,
            extra: extra
        )
    }

    private func colText(_ stmt: OpaquePointer?, _ idx: Int32) -> String? {
        guard let c = sqlite3_column_text(stmt, idx) else { return nil }
        return String(cString: c)
    }

    private func colInt(_ stmt: OpaquePointer?, _ idx: Int32) -> Int64? {
        if sqlite3_column_type(stmt, idx) == SQLITE_NULL { return nil }
        return sqlite3_column_int64(stmt, idx)
    }

    // MARK: - Config migration

    /// The on-disk shape of the Electron pastyx-macos-config.json. Every field is
    /// optional so a partial / older config still decodes.
    private struct ElectronConfig: Decodable {
        var apiBase: String?
        var userId: String?
        var deviceId: String?
        var authToken: String?
        var authGithubLogin: String?
        var icloudSync: Bool?
        var localSyncDecisionByUser: [String: String]?
        var autoCapture: Bool?
        var launchAtLogin: Bool?
        var retention: String?
        var hotkey: String?
    }

    /// Map the Electron config JSON into AppConfig and persist it. Only overwrites
    /// fields the Electron config actually carries; everything else keeps the
    /// already-loaded native default. Returns whether the file was read + applied.
    private func migrateConfig() -> Bool {
        guard let data = try? Data(contentsOf: electronConfigURL),
              let old = try? JSONDecoder().decode(ElectronConfig.self, from: data) else {
            return false
        }

        var cfg = config.config

        if let v = old.apiBase { cfg.apiBase = v }
        if let v = old.userId, !v.isEmpty { cfg.userId = v }
        if let v = old.deviceId, !v.isEmpty { cfg.deviceId = v }
        if let v = old.authToken { cfg.authToken = v }
        if let v = old.authGithubLogin { cfg.authGithubLogin = v }
        if let v = old.icloudSync { cfg.icloudSync = v }
        if let v = old.localSyncDecisionByUser { cfg.localSyncDecisionByUser = v }
        if let v = old.autoCapture { cfg.autoCapture = v }
        if let v = old.launchAtLogin { cfg.launchAtLogin = v }
        if let v = old.retention, let r = Retention(rawValue: v) { cfg.retention = r }
        if let v = old.hotkey, !v.isEmpty { cfg.hotkey = v }

        config.save(cfg)
        return true
    }

    // MARK: - Marker

    private func writeMarker(clips: Int, images: Int, config: Bool) {
        try? fm.createDirectory(at: nativeDir, withIntermediateDirectories: true)
        let payload: [String: Any] = [
            "migratedAt": Int64(Date().timeIntervalSince1970 * 1000),
            "clipCount": clips,
            "imageCount": images,
            "configMigrated": config,
            "source": electronDir.path
        ]
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted]) {
            try? data.write(to: markerURL)
        } else {
            // Even if the JSON encode fails, drop an empty marker so we don't loop.
            try? Data().write(to: markerURL)
        }
    }
}
