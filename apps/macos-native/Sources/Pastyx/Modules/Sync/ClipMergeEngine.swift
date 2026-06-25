import Foundation

/// Pure, tombstone-aware merge math (the crown jewel).
///
/// Faithful Swift port of BOTH Electron merge layers:
///   Layer 1  mergeClipsForLocalSync (main.cjs:639-669)            — iCloud sync
///   Layer 2  runJsonImportTransaction upsert (local-history.cjs:538-592)
///                                                                  — JSON history import
/// plus the change-detection / dedupe helpers (clipSyncTs, clipSyncSnapshotKey,
/// dedupeKey) and cleanupLocalDb (main.cjs:927-994).
///
/// CRITICAL DIVERGENCE (risks #1): the two layers differ on `isFavorite`:
///   Layer 1 → NEWER's favorite wins   (so un-favoriting can propagate)
///   Layer 2 → favorite is OR'd        (never lose a favorite on import)
/// Both layers union tags and use `>=` tie-break on clipSyncTs (risks #2):
/// equal timestamps → the INCOMING / second-ingested record wins (cloud wins ties).
///
/// No I/O, no store access, no `Date.now()` — `now` is injected for testability.
public struct ClipMergeEngine: MergeEngine {
    public init() {}

    // MARK: - Timestamps / keys

    /// `clipSyncTs(clip) = max(serverUpdatedAt||0, clientUpdatedAt||0, createdAt||0)`
    /// (main.cjs:632-637 / local-history.cjs:125-130). Missing => 0.
    /// This is the LWW timestamp for LOCAL + iCloud merges (NOT the remote API,
    /// which compares clientUpdatedAt only — risks #3).
    public func clipSyncTs(_ clip: ClipItem) -> Int64 {
        let server = max(clip.serverUpdatedAt ?? 0, 0)
        let client = max(clip.clientUpdatedAt ?? 0, 0)
        let created = max(clip.createdAt, 0)
        return max(server, max(client, created))
    }

    /// Stable change-detection key (NOT a merge key), main.cjs:671-677:
    /// `JSON.stringify([clipSyncTs, Boolean(isFavorite), tags.slice().sort(), Boolean(isDeleted)])`.
    /// We reproduce the exact JSON-array byte shape so two records with identical
    /// sync-relevant state compare equal regardless of payload differences.
    public func clipSyncSnapshotKey(_ clip: ClipItem) -> String {
        let ts = clipSyncTs(clip)
        let fav = clip.isFavorite ? "true" : "false"
        let del = clip.isDeleted ? "true" : "false"
        // tags.slice().sort() — JS default sort is lexicographic on the string form.
        let sortedTags = clip.tags.sorted()
        let tagsJson = "[" + sortedTags.map(jsonStringLiteral).joined(separator: ",") + "]"
        return "[\(ts),\(fav),\(tagsJson),\(del)]"
    }

    /// Adjacent-duplicate collapse key (cleanupLocalDb, main.cjs:927-994):
    /// `[type, content.trim().slice(0,200), sourceUrl.trim(),
    ///   contentHtml.trim().slice(0,200), imageMarker].join("|")`.
    ///
    /// Electron keys the image marker off the inline `imageDataUrl`. The native
    /// ClipItem keeps the full image as a file and travels the inline image as
    /// `imagePreviewDataURL`, so that is the inline field used here. (During an
    /// iCloud merge the cloud wire format hydrates images inline; the coordinator
    /// is responsible for placing the inline data in `imagePreviewDataURL` before
    /// calling cleanup, so adjacent image duplicates still collapse.)
    public func dedupeKey(_ clip: ClipItem) -> String {
        let type = clip.type.rawValue
        let content = jsTrim(clip.content ?? "").jsPrefix(200)
        let sourceUrl = jsTrim(clip.sourceURL ?? "")
        let html = jsTrim(clip.contentHTML ?? "").jsPrefix(200)
        let inlineImage = clip.imagePreviewDataURL ?? ""
        let img: String
        if !inlineImage.isEmpty {
            img = "\(inlineImage.jsPrefix(64)):\(inlineImage.utf16.count)"
        } else {
            img = ""
        }
        return [type, content, sourceUrl, html, img].joined(separator: "|")
    }

    // MARK: - Layer 1: iCloud sync merge (NEWER's favorite wins)

    /// LAYER 1 — main.cjs:639-669. Builds a Map<id,clip> ingesting LOCAL first
    /// then CLOUD. On collision the newer (by clipSyncTs, `>=` => incoming/cloud
    /// wins ties) wins ALL fields, EXCEPT `isFavorite = newer.isFavorite` (NEWER
    /// wins — NOT a union) and `tags = union(newer.tags, older.tags)`. Insertion
    /// order = local order, then cloud-only ids appended.
    public func mergeClipsForLocalSync(local: [ClipItem], cloud: [ClipItem]) -> [ClipItem] {
        var order: [String] = []
        var byId: [String: ClipItem] = [:]

        func ingest(_ clip: ClipItem) {
            let id = clip.id.trimmingCharacters(in: .whitespacesAndNewlines)
            if id.isEmpty { return }
            guard let existing = byId[id] else {
                byId[id] = clip
                order.append(id)
                return
            }
            let aTs = clipSyncTs(existing)
            let bTs = clipSyncTs(clip)
            // `>=`: the second-ingested (cloud, on a tie) wins.
            let incomingWins = bTs >= aTs
            let newer = incomingWins ? clip : existing
            let older = incomingWins ? existing : clip

            var merged = newer
            // The newer record's favorite flag wins: a boolean union would make
            // un-favoriting impossible to propagate (the stale true always sticks).
            merged.isFavorite = newer.isFavorite
            merged.tags = unionTags(newer.tags, older.tags)
            byId[id] = merged
        }

        for c in local { ingest(c) }
        for c in cloud { ingest(c) }
        return order.compactMap { byId[$0] }
    }

    // MARK: - Layer 2: JSON-import upsert merge (favorite OR'd)

    /// LAYER 2 — local-history.cjs:538-592. `incomingNewer = ts(incoming) >= ts(existing)`.
    /// merged = (incomingNewer ? incoming : existing) with
    /// `isFavorite = incoming.isFavorite || existing.isFavorite` (OR'd — differs
    /// from Layer 1!) and `tags = union(existing.tags, incoming.tags)`.
    /// `existing == nil` => return incoming unchanged (caller assigns a negative seq).
    public func mergeImportedClip(incoming: ClipItem, existing: ClipItem?) -> ClipItem {
        guard let existing else { return incoming }
        let incomingNewer = clipSyncTs(incoming) >= clipSyncTs(existing)
        var merged = incomingNewer ? incoming : existing
        merged.isFavorite = incoming.isFavorite || existing.isFavorite
        // Note the order: existing.tags first, then incoming.tags (matches Electron
        // `existing.tags.concat(incoming.tags)`).
        merged.tags = unionTags(existing.tags, incoming.tags)
        return merged
    }

    // MARK: - cleanupLocalDb (retention + cap + adjacent collapse)

    /// `cleanupLocalDb(cfg, {clips})` (main.cjs:927-994):
    ///   1. Retention filter: keep if `isFavorite || createdAt >= cutoff`
    ///      (cutoff = now - retentionMs; `retentionMs == nil` => keep all).
    ///   2. Cap 5000: favorites first (original order), then non-favorites sorted
    ///      createdAt DESC; slice(0,5000).
    ///   3. Sort all by createdAt DESC (stable).
    ///   4. ADJACENT-ONLY collapse: collapse into the previous kept clip iff
    ///      dedupeKey equal AND |ΔcreatedAt| <= 60_000ms; on collapse
    ///      prev.isFavorite ||= clip.isFavorite, prev.tags = union. "A,B,A" survives.
    public func cleanupLocalDb(_ clips: [ClipItem], retentionMs: Int64?, now: Int64) -> [ClipItem] {
        let collapseWindowMs: Int64 = 60_000
        let maxLocalClips = 5000

        var working = clips

        // 1. Retention filter.
        if let ms = retentionMs {
            let cutoff = now - ms
            working = working.filter { $0.isFavorite || $0.createdAt >= cutoff }
        }

        // 2. Cap 5000: favorites first (original order preserved), then
        //    non-favorites sorted createdAt DESC.
        if working.count > maxLocalClips {
            let favorites = working.filter { $0.isFavorite }
            let rest = working
                .filter { !$0.isFavorite }
                .sorted { $0.createdAt > $1.createdAt }
            working = Array((favorites + rest).prefix(maxLocalClips))
        }

        // 3. Sort all by createdAt DESC. JS Array.prototype.sort is not guaranteed
        //    stable across the spec history but V8 is stable; use a stable sort so
        //    equal-createdAt order matches the input order (parity with V8).
        working = stableSortedByCreatedAtDesc(working)

        // 4. Adjacent-only duplicate collapse.
        var collapsed: [ClipItem] = []
        for clip in working {
            guard var prev = collapsed.last else {
                collapsed.append(clip)
                continue
            }
            let prevKey = dedupeKey(prev)
            let clipKey = dedupeKey(clip)
            let delta = abs(prev.createdAt - clip.createdAt)
            if !prevKey.isEmpty && prevKey == clipKey && delta <= collapseWindowMs {
                prev.isFavorite = prev.isFavorite || clip.isFavorite
                prev.tags = unionTags(prev.tags, clip.tags)
                collapsed[collapsed.count - 1] = prev
                continue
            }
            collapsed.append(clip)
        }

        return collapsed
    }

    // MARK: - Helpers

    /// Ordered set-union of two tag arrays: `Array.from(new Set(a.concat(b)))`.
    /// Preserves first-seen order (a's elements first, then b's new ones).
    private func unionTags(_ a: [String], _ b: [String]) -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for t in a + b where seen.insert(t).inserted {
            out.append(t)
        }
        return out
    }

    /// Stable descending sort by createdAt (mirrors V8's stable sort so equal-key
    /// records keep their relative input order).
    private func stableSortedByCreatedAtDesc(_ clips: [ClipItem]) -> [ClipItem] {
        clips.enumerated()
            .sorted { lhs, rhs in
                if lhs.element.createdAt != rhs.element.createdAt {
                    return lhs.element.createdAt > rhs.element.createdAt
                }
                return lhs.offset < rhs.offset
            }
            .map(\.element)
    }

    /// JSON string literal exactly as JSON.stringify would emit (quotes + the
    /// minimal escape set), so clipSyncSnapshotKey is byte-stable across devices.
    private func jsonStringLiteral(_ s: String) -> String {
        var out = "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
        return out
    }
}

// MARK: - JS-parity string helpers

private extension String {
    /// JS `String.prototype.trim()` removes leading/trailing whitespace AND line
    /// terminators. Swift's `.whitespacesAndNewlines` is the equivalent set.
    /// (Defined as a free function below; this extension hosts `jsPrefix`.)

    /// JS `String.prototype.slice(0, n)` slices by UTF-16 code units. Swift's
    /// `prefix` slices by Character (grapheme). For ASCII content (the common
    /// case for dedupe keys) these agree; for the dedupe key the exact cut point
    /// only needs to be deterministic and collision-resistant, so we slice by
    /// UTF-16 code units to match JS precisely.
    func jsPrefix(_ n: Int) -> String {
        let units = Array(utf16)
        if units.count <= n { return self }
        return String(utf16CodeUnits: Array(units.prefix(n)), count: min(n, units.count))
    }
}

/// JS `String.prototype.trim()` parity.
private func jsTrim(_ s: String) -> String {
    s.trimmingCharacters(in: .whitespacesAndNewlines)
}
