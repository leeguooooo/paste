import XCTest
@testable import Pastyx

/// Port of the tombstone / prune / countPending cases from
/// electron/local-history.test.cjs against the REAL native engine
/// (`HistoryStore.prune` + soft-delete tombstones).
///
/// Electron equivalents:
///   - "compactDbFileStreaming keeps fresh tombstones and reaps expired ones
///      with their images" (test:489-542)
///   - "compactDbFileStreaming prunes by retention and removes orphaned image
///      files" (test:256-283)
///   - "compactDbFileStreaming enforces the hard clip cap" (test:285-301)
///   - "countPendingClipsInDbFile ignores soft-deleted clips" — via list()
///
/// prune() uses the store's own Date.now() for the TTL/cutoff bounds, so (like
/// the Electron test) we place clips at timestamps relative to `now`.
final class HistoryStoreTombstoneTests: XCTestCase {
    private var tmpDir: URL!
    private var store: HistoryStore!

    private var now: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
    private let dayMs: Int64 = 24 * 60 * 60 * 1000

    override func setUp() {
        super.setUp()
        tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("pastyx-tests-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
        store = HistoryStore(directory: tmpDir)
    }

    override func tearDown() {
        store = nil
        try? FileManager.default.removeItem(at: tmpDir)
        super.tearDown()
    }

    // 1x1 transparent PNG, base64 data url, for image-file tombstone tests.
    private let pngBytes = Data(base64Encoded:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")!
    private var imageDataURL: String { "data:image/png;base64,\(pngBytes.base64EncodedString())" }

    private func makeClip(
        _ id: String,
        content: String? = "Hello",
        favorite: Bool = false,
        deleted: Bool = false,
        type: ClipType = .text,
        client: Int64,
        server: Int64,
        created: Int64,
        imageDataURL: String? = nil
    ) -> ClipItem {
        var extra: [String: String]? = nil
        if let imageDataURL { extra = ["__rawImageDataUrl": imageDataURL] }
        return ClipItem(
            id: id, userId: "user-1", deviceId: "mac-1", type: type,
            summary: "Summary", content: content,
            isFavorite: favorite, isDeleted: deleted, tags: [],
            clientUpdatedAt: client, serverUpdatedAt: server, createdAt: created,
            extra: extra
        )
    }

    private func imageFile(_ id: String, _ ext: String = "png") -> URL {
        tmpDir.appendingPathComponent("images", isDirectory: true).appendingPathComponent("\(id).\(ext)")
    }

    private func listedIDs() throws -> [String] {
        try store.list(ClipQuery(limit: 10)).map(\.id)
    }

    // MARK: - create / soft-delete tombstone basics

    func testSoftDeleteCreatesTombstoneExcludedFromListButRowSurvives() throws {
        _ = try store.create(makeClip("a", client: 1, server: 1, created: 1))
        try store.softDelete(id: "a")

        // Excluded from list() and get() returns nil for it.
        XCTAssertEqual(try listedIDs(), [])
        XCTAssertNil(try store.get(id: "a"))
    }

    // MARK: - countPending (via list, which excludes tombstones) — test:376-388

    func testListIgnoresSoftDeletedClips() throws {
        _ = try store.create(makeClip("a", client: 3, server: 3, created: 3))
        _ = try store.create(makeClip("b", deleted: true, client: 2, server: 2, created: 2))
        _ = try store.create(makeClip("c", client: 1, server: 1, created: 1))
        XCTAssertEqual(Set(try listedIDs()), ["a", "c"])
    }

    // MARK: - retention prune keeps fresh tombstones — test:256-283

    func testRetentionPruneKeepsFreshTombstone() throws {
        // A fresh soft-delete tombstone (old createdAt but fresh delete timestamp)
        // survives a retention compaction. Native adds `AND is_deleted=0` to the
        // retention DELETE (risks #6) so a tombstone is never collateral of
        // retention; only the TTL reaps it.
        _ = try store.create(makeClip("keep-fresh", client: now, server: now, created: now))
        _ = try store.create(makeClip("keep-fav", favorite: true, client: now - 10_000, server: now - 10_000, created: now - 10_000))
        // tombstone with an OLD createdAt but a FRESH delete timestamp:
        _ = try store.create(makeClip(
            "fresh-tombstone", deleted: true,
            client: now, server: now, created: now - 200 * dayMs
        ))
        // a plain old non-favorite that retention should drop:
        _ = try store.create(makeClip("drop-old", client: now - 200 * dayMs, server: now - 200 * dayMs, created: now - 200 * dayMs))

        try store.prune(retention: .d180)

        // tombstone survives retention (still a row, still deleted)
        XCTAssertNil(try store.get(id: "fresh-tombstone"), "tombstone excluded from get()")
        XCTAssertTrue(rowExists("fresh-tombstone"), "fresh tombstone row survives retention prune")
        // live ids
        XCTAssertEqual(Set(try listedIDs()), ["keep-fresh", "keep-fav"])
        XCTAssertFalse(rowExists("drop-old"), "old non-favorite dropped by retention")
    }

    // MARK: - tombstone TTL: fresh kept, expired reaped, images swept — test:489-542

    func testPruneKeepsFreshTombstoneAndReapsExpiredOneWithImage() throws {
        let fresh = now - 1000
        let old = now - 60 * dayMs

        _ = try store.create(makeClip(
            "fresh-tombstone", deleted: true, type: .image,
            client: fresh, server: fresh, created: fresh, imageDataURL: imageDataURL
        ))
        _ = try store.create(makeClip(
            "old-tombstone", deleted: true, type: .image,
            client: old, server: old, created: old, imageDataURL: imageDataURL
        ))

        XCTAssertTrue(FileManager.default.fileExists(atPath: imageFile("fresh-tombstone").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: imageFile("old-tombstone").path))

        // default TTL (30d): the fresh tombstone survives, the old one is reaped.
        try store.prune(retention: .forever)

        XCTAssertTrue(rowExists("fresh-tombstone"), "fresh tombstone kept")
        XCTAssertFalse(rowExists("old-tombstone"), "expired tombstone reaped")

        // the orphan sweep keeps the live tombstone's image and removes the reaped one's
        XCTAssertTrue(FileManager.default.fileExists(atPath: imageFile("fresh-tombstone").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: imageFile("old-tombstone").path),
                       "reaped tombstone's image file removed by orphan sweep")
    }

    // MARK: - retention drops old non-favorite images + orphan sweep — test:256-283

    func testRetentionPruneRemovesOrphanedImageFiles() throws {
        _ = try store.create(makeClip("keep-1", client: now, server: now, created: now))
        _ = try store.create(makeClip(
            "drop-old-image", type: .image,
            client: now - 200 * dayMs, server: now - 200 * dayMs, created: now - 200 * dayMs,
            imageDataURL: imageDataURL
        ))
        _ = try store.create(makeClip("keep-favorite", favorite: true,
            client: now - 200 * dayMs, server: now - 200 * dayMs, created: now - 200 * dayMs))

        XCTAssertTrue(FileManager.default.fileExists(atPath: imageFile("drop-old-image").path))

        try store.prune(retention: .d180)

        XCTAssertEqual(Set(try listedIDs()), ["keep-1", "keep-favorite"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: imageFile("drop-old-image").path),
                       "orphaned image of the dropped clip is swept")
    }

    // MARK: - explicit ttl override reaps the remaining tombstone — test:535-538

    func testPruneWithZeroTtlReapsFreshTombstoneToo() throws {
        let fresh = now - 1000
        _ = try store.create(makeClip(
            "fresh-tombstone", deleted: true, type: .image,
            client: fresh, server: fresh, created: fresh, imageDataURL: imageDataURL
        ))
        XCTAssertTrue(rowExists("fresh-tombstone"))

        // default ttl keeps it...
        try store.prune(retention: .forever)
        XCTAssertTrue(rowExists("fresh-tombstone"))

        // ...an explicit ttl override of 0 reaps it (and its image).
        try store.prune(retention: .forever, maxClips: 5000, tombstoneTtlMs: 0)
        XCTAssertFalse(rowExists("fresh-tombstone"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: imageFile("fresh-tombstone").path))
    }

    // MARK: - hard cap — test:285-301 (favorites-first cap is the native behavior)

    func testPruneEnforcesFavoritesFirstHardCap() throws {
        // Native cap orders is_favorite DESC, created_at DESC, seq DESC (a
        // correctness improvement over Electron's created_at-only cap). With a cap
        // of 1 a favorite is kept over a newer non-favorite.
        _ = try store.create(makeClip("old-fav", favorite: true, client: 1, server: 1, created: 1))
        _ = try store.create(makeClip("new-plain", client: 3, server: 3, created: 3))
        _ = try store.create(makeClip("mid-plain", client: 2, server: 2, created: 2))

        try store.prune(retention: .forever, maxClips: 1, tombstoneTtlMs: 30 * dayMs)

        XCTAssertEqual(try listedIDs(), ["old-fav"], "favorite survives the cap over newer non-favorites")
    }

    func testPruneHardCapKeepsNewestWhenNoFavorites() throws {
        // Mirrors "compactDbFileStreaming enforces the hard clip cap" (test:285-301):
        // cap of 1, no favorites -> newest by created_at survives.
        _ = try store.create(makeClip("c", client: 1, server: 1, created: 1))
        _ = try store.create(makeClip("b", client: 2, server: 2, created: 2))
        _ = try store.create(makeClip("a", client: 3, server: 3, created: 3))

        try store.prune(retention: .forever, maxClips: 1, tombstoneTtlMs: 30 * dayMs)

        XCTAssertEqual(try listedIDs(), ["a"])
    }

    // MARK: - helpers

    /// True if a row (any is_deleted) exists for id — verifies tombstone survival
    /// independent of list()'s is_deleted filter, via the real engine.
    private func rowExists(_ id: String) -> Bool {
        store.rowIncludingDeleted(id: id) != nil
    }
}
