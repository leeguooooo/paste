import XCTest
@testable import Pastyx

/// Port of the merge/tombstone correctness cases from
/// electron/local-history.test.cjs (and the two merge layers in main.cjs /
/// local-history.cjs) against the native pure `ClipMergeEngine`.
///
/// The Electron test file exercises the STORE functions (prependClipToDbFile,
/// importJsonHistoryFile, compactDbFileStreaming, …). In the native port the
/// merge MATH is factored out of the store into the pure `ClipMergeEngine`
/// (Layer 1 = iCloud merge, Layer 2 = JSON-import upsert) plus `cleanupLocalDb`,
/// and the tombstone reaping lives in `HistoryStore.prune`. These tests cover
/// the merge math here; HistoryStoreTombstoneTests covers the store side
/// (tombstone propagation / prune / countPending) against the real engine.
final class MergeEngineTests: XCTestCase {
    private let engine = ClipMergeEngine()

    private func clip(
        _ id: String,
        content: String? = "Hello world",
        favorite: Bool = false,
        deleted: Bool = false,
        tags: [String] = [],
        type: ClipType = .text,
        sourceURL: String? = nil,
        contentHTML: String? = nil,
        imagePreview: String? = nil,
        client: Int64? = 1,
        server: Int64? = 1,
        created: Int64 = 1
    ) -> ClipItem {
        ClipItem(
            id: id, userId: "user-1", deviceId: "mac-1", type: type,
            summary: "Summary", content: content, contentHTML: contentHTML,
            sourceURL: sourceURL, imagePreviewDataURL: imagePreview,
            isFavorite: favorite, isDeleted: deleted, tags: tags,
            clientUpdatedAt: client, serverUpdatedAt: server, createdAt: created
        )
    }

    // MARK: - clipSyncTs (max of three)

    func testClipSyncTsIsMaxOfThreeFields() {
        // risks #3: MAX(serverUpdatedAt, clientUpdatedAt, createdAt), missing => 0.
        XCTAssertEqual(engine.clipSyncTs(clip("a", client: 5, server: 9, created: 3)), 9)
        XCTAssertEqual(engine.clipSyncTs(clip("a", client: 50, server: 9, created: 3)), 50)
        XCTAssertEqual(engine.clipSyncTs(clip("a", client: 1, server: 1, created: 100)), 100)
        XCTAssertEqual(engine.clipSyncTs(clip("a", client: nil, server: nil, created: 0)), 0)
        XCTAssertEqual(engine.clipSyncTs(clip("a", client: nil, server: 7, created: 0)), 7)
    }

    // MARK: - Layer 1: mergeClipsForLocalSync (iCloud merge)

    func testLayer1UnionOfDistinctIdsPreservesLocalThenCloudOrder() {
        // Insertion order = local order, then cloud-only ids appended.
        let local = [clip("l1"), clip("l2")]
        let cloud = [clip("c1"), clip("c2")]
        let merged = engine.mergeClipsForLocalSync(local: local, cloud: cloud)
        XCTAssertEqual(merged.map(\.id), ["l1", "l2", "c1", "c2"])
    }

    func testLayer1NewerWinsAllFields() {
        // Cloud copy is strictly newer -> its full payload wins.
        let local = [clip("t1", content: "old", client: 50, server: 50, created: 50)]
        let cloud = [clip("t1", content: "new", client: 100, server: 100, created: 100)]
        let merged = engine.mergeClipsForLocalSync(local: local, cloud: cloud)
        XCTAssertEqual(merged.count, 1)
        XCTAssertEqual(merged[0].content, "new")
    }

    func testLayer1OlderIncomingLosesPayload() {
        // Cloud copy is older -> existing (local) payload wins.
        let local = [clip("t1", content: "local-new", client: 100, server: 100, created: 100)]
        let cloud = [clip("t1", content: "cloud-old", client: 50, server: 50, created: 50)]
        let merged = engine.mergeClipsForLocalSync(local: local, cloud: cloud)
        XCTAssertEqual(merged[0].content, "local-new")
    }

    func testLayer1TieBreakFavorsCloud() {
        // risks #2: equal timestamps -> the second-ingested (cloud) wins.
        let local = [clip("t1", content: "local", client: 100, server: 100, created: 100)]
        let cloud = [clip("t1", content: "cloud", client: 100, server: 100, created: 100)]
        let merged = engine.mergeClipsForLocalSync(local: local, cloud: cloud)
        XCTAssertEqual(merged[0].content, "cloud")
    }

    func testLayer1NewerFavoriteWinsNotUnion_UnfavoriteCanPropagate() {
        // risks #1: Layer 1 does NOT OR favorites. A newer un-favorite must win
        // so un-favoriting propagates across devices.
        // Local: favorited & older. Cloud: not favorited & newer.
        let local = [clip("t1", favorite: true, client: 50, server: 50, created: 50)]
        let cloud = [clip("t1", favorite: false, client: 100, server: 100, created: 100)]
        let merged = engine.mergeClipsForLocalSync(local: local, cloud: cloud)
        XCTAssertFalse(merged[0].isFavorite, "newer un-favorite must win (no boolean union)")
    }

    func testLayer1NewerFavoriteWinsWhenNewerIsFavorited() {
        let local = [clip("t1", favorite: false, client: 50, server: 50, created: 50)]
        let cloud = [clip("t1", favorite: true, client: 100, server: 100, created: 100)]
        let merged = engine.mergeClipsForLocalSync(local: local, cloud: cloud)
        XCTAssertTrue(merged[0].isFavorite)
    }

    func testLayer1TagsAreUnionedNewerFirst() {
        // tags = union(newer.tags, older.tags); dedup; newer's first then older's new.
        let local = [clip("t1", tags: ["a", "b"], client: 50, server: 50, created: 50)]      // older
        let cloud = [clip("t1", tags: ["c", "a"], client: 100, server: 100, created: 100)]   // newer
        let merged = engine.mergeClipsForLocalSync(local: local, cloud: cloud)
        XCTAssertEqual(merged[0].tags, ["c", "a", "b"])
    }

    func testLayer1TombstonePropagatesAsLwwWinner() {
        // A delete = a fresh isDeleted write. Against another device's older live
        // copy it wins the LWW merge and carries the deletion.
        let liveOlder = [clip("t1", deleted: false, client: 50, server: 50, created: 50)]
        let tombstoneNewer = [clip("t1", deleted: true, client: 100, server: 100, created: 100)]
        let merged = engine.mergeClipsForLocalSync(local: liveOlder, cloud: tombstoneNewer)
        XCTAssertEqual(merged.count, 1)
        XCTAssertTrue(merged[0].isDeleted, "fresh tombstone wins LWW and propagates the delete")
    }

    func testLayer1StaleTombstoneLosesToNewerLiveCopy() {
        // If the live copy is newer, the deletion does NOT win (resurrection guard
        // direction: only a FRESH tombstone propagates).
        let tombstoneOlder = [clip("t1", deleted: true, client: 50, server: 50, created: 50)]
        let liveNewer = [clip("t1", deleted: false, client: 100, server: 100, created: 100)]
        let merged = engine.mergeClipsForLocalSync(local: tombstoneOlder, cloud: liveNewer)
        XCTAssertFalse(merged[0].isDeleted)
    }

    // MARK: - Layer 2: mergeImportedClip (JSON-import upsert)

    func testLayer2NoExistingReturnsIncoming() {
        let incoming = clip("new", content: "from cloud", created: 200)
        let merged = engine.mergeImportedClip(incoming: incoming, existing: nil)
        XCTAssertEqual(merged.id, "new")
        XCTAssertEqual(merged.content, "from cloud")
    }

    func testLayer2NewerLocalKeepsContentButFavoriteIsOrd() {
        // Locks the Electron "re-imports a rewritten legacy json" + "importJsonHistoryFile"
        // cases (test:223-254, test:430-487): a stale-but-favorited cloud copy of t1
        // -> content stays "original" (newer local wins payload) but isFavorite
        // becomes true (OR'd, differs from Layer 1).
        let existing = clip("t1", content: "original", favorite: false, client: 100, server: 100, created: 100)
        let incoming = clip("t1", content: "stale", favorite: true, client: 50, server: 50, created: 50)
        let merged = engine.mergeImportedClip(incoming: incoming, existing: existing)
        XCTAssertEqual(merged.content, "original", "newer existing payload wins")
        XCTAssertTrue(merged.isFavorite, "favorite is OR'd on import")
    }

    func testLayer2IncomingNewerWinsPayloadAndFavoriteStillOrd() {
        let existing = clip("t1", content: "old", favorite: true, client: 50, server: 50, created: 50)
        let incoming = clip("t1", content: "new", favorite: false, client: 100, server: 100, created: 100)
        let merged = engine.mergeImportedClip(incoming: incoming, existing: existing)
        XCTAssertEqual(merged.content, "new")
        // favorite OR'd: existing.true || incoming.false => true (favorite never lost on import)
        XCTAssertTrue(merged.isFavorite)
    }

    func testLayer2TieFavorsIncoming() {
        let existing = clip("t1", content: "existing", client: 100, server: 100, created: 100)
        let incoming = clip("t1", content: "incoming", client: 100, server: 100, created: 100)
        let merged = engine.mergeImportedClip(incoming: incoming, existing: existing)
        XCTAssertEqual(merged.content, "incoming")
    }

    func testLayer2TagsUnionedExistingFirst() {
        // tags = union(existing.tags, incoming.tags).
        let existing = clip("t1", tags: ["a", "b"], client: 100, server: 100, created: 100)
        let incoming = clip("t1", tags: ["b", "c"], client: 50, server: 50, created: 50)
        let merged = engine.mergeImportedClip(incoming: incoming, existing: existing)
        XCTAssertEqual(merged.tags, ["a", "b", "c"])
    }

    // MARK: - cleanupLocalDb: retention

    func testCleanupRetentionDropsOldNonFavoritesKeepsFavorites() {
        let now: Int64 = 1_000_000
        let cutoffMs: Int64 = 5000
        // Distinct content so the adjacent-dedupe collapse doesn't fold them.
        let clips = [
            clip("keep-fresh", content: "fresh", created: now),
            clip("drop-old", content: "old", created: now - 10_000),
            clip("keep-fav", content: "fav", favorite: true, created: now - 10_000)
        ]
        let out = engine.cleanupLocalDb(clips, retentionMs: cutoffMs, now: now)
        XCTAssertEqual(Set(out.map(\.id)), ["keep-fresh", "keep-fav"])
    }

    func testCleanupForeverKeepsEverything() {
        let now: Int64 = 1_000_000
        let clips = [clip("a", content: "alpha", created: 1), clip("b", content: "beta", created: 2)]
        let out = engine.cleanupLocalDb(clips, retentionMs: nil, now: now)
        XCTAssertEqual(out.count, 2)
    }

    // MARK: - cleanupLocalDb: sort

    func testCleanupSortsByCreatedAtDesc() {
        let now: Int64 = 1_000_000
        let clips = [
            clip("a", content: "alpha", created: 1),
            clip("c", content: "gamma", created: 3),
            clip("b", content: "beta", created: 2)
        ]
        let out = engine.cleanupLocalDb(clips, retentionMs: nil, now: now)
        XCTAssertEqual(out.map(\.id), ["c", "b", "a"])
    }

    // MARK: - cleanupLocalDb: adjacent-only dedupe collapse

    func testCleanupCollapsesAdjacentDuplicatesWithin60s() {
        let now: Int64 = 1_000_000
        // Two identical-content clips 1s apart collapse; the third differs.
        let clips = [
            clip("dup-1", content: "same", created: now),
            clip("dup-2", content: "same", created: now - 1000),
            clip("other", content: "different", created: now - 2000)
        ]
        let out = engine.cleanupLocalDb(clips, retentionMs: nil, now: now)
        XCTAssertEqual(out.count, 2)
        // The first (newest) survives; the older dup folds into it.
        XCTAssertEqual(out.map(\.id), ["dup-1", "other"])
    }

    func testCleanupDoesNotCollapseDuplicatesBeyond60s() {
        let now: Int64 = 1_000_000
        let clips = [
            clip("a", content: "same", created: now),
            clip("b", content: "same", created: now - 61_000) // > 60s apart
        ]
        let out = engine.cleanupLocalDb(clips, retentionMs: nil, now: now)
        XCTAssertEqual(out.count, 2, "duplicates more than 60s apart are NOT collapsed")
    }

    func testCleanupAdjacentOnlyABASurvivesAsThree() {
        // risks #9: only CONSECUTIVE equal dedupeKeys collapse. "A,B,A" survives.
        let now: Int64 = 1_000_000
        let clips = [
            clip("a1", content: "A", created: now),
            clip("b1", content: "B", created: now - 1000),
            clip("a2", content: "A", created: now - 2000)
        ]
        let out = engine.cleanupLocalDb(clips, retentionMs: nil, now: now)
        XCTAssertEqual(out.map(\.id), ["a1", "b1", "a2"])
    }

    func testCleanupCollapseUnionsFavoriteAndTags() {
        // On collapse: prev.isFavorite ||= clip.isFavorite, prev.tags = union.
        let now: Int64 = 1_000_000
        let clips = [
            clip("dup-1", content: "same", favorite: false, tags: ["x"], created: now),
            clip("dup-2", content: "same", favorite: true, tags: ["y"], created: now - 1000)
        ]
        let out = engine.cleanupLocalDb(clips, retentionMs: nil, now: now)
        XCTAssertEqual(out.count, 1)
        XCTAssertTrue(out[0].isFavorite, "collapse OR's favorite")
        XCTAssertEqual(out[0].tags, ["x", "y"], "collapse unions tags")
    }

    // MARK: - snapshot key (change detection)

    func testSnapshotKeyStableShapeAndChangeDetection() {
        // main.cjs:671-677 — JSON([clipSyncTs, fav, sortedTags, deleted]).
        let base = clip("t1", favorite: false, deleted: false, tags: ["b", "a"], client: 5, server: 9, created: 3)
        XCTAssertEqual(engine.clipSyncSnapshotKey(base), "[9,false,[\"a\",\"b\"],false]")

        // A payload-only change (content) with same sync state => SAME key.
        var sameSyncState = base
        sameSyncState.content = "totally different content"
        XCTAssertEqual(engine.clipSyncSnapshotKey(sameSyncState), engine.clipSyncSnapshotKey(base))

        // A favorite flip => DIFFERENT key.
        var favFlip = base
        favFlip.isFavorite = true
        XCTAssertNotEqual(engine.clipSyncSnapshotKey(favFlip), engine.clipSyncSnapshotKey(base))

        // A delete => DIFFERENT key.
        var del = base
        del.isDeleted = true
        XCTAssertNotEqual(engine.clipSyncSnapshotKey(del), engine.clipSyncSnapshotKey(base))
    }

    // MARK: - dedupe key

    func testDedupeKeyIgnoresPayloadBeyond200CharsAndUsesTrim() {
        let a = clip("a", content: "  hello  ", sourceURL: " http://x ", contentHTML: " <p>x</p> ")
        let b = clip("b", content: "hello", sourceURL: "http://x", contentHTML: "<p>x</p>")
        XCTAssertEqual(engine.dedupeKey(a), engine.dedupeKey(b), "trim applied before keying")
    }
}
