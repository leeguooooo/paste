import Foundation

/// JSON codec for the iCloud Documents wire format.
///
/// The cloud file is a single `{ "clips": [ ... ] }` document using the Electron
/// camelCase clip shape with images INLINE as base64 data urls
/// (`imageDataUrl` / `imagePreviewDataUrl`). It is the cross-device wire format;
/// the local sqlite is local-only (risks #14).
///
/// The native `ClipItem` keeps the full-res image OUT of the row — it lives on
/// disk and is surfaced via `extra["__rawImageDataUrl"]` as a `data:` url. So:
///   - DECODE (cloud -> ClipItem): map `imageDataUrl` into
///     `extra["__rawImageDataUrl"]` so `HistoryStore.create()` routes it to a
///     file (never into sqlite — risks #12).
///   - ENCODE (ClipItem -> cloud): read the inline image back out of
///     `extra["__rawImageDataUrl"]` (populated by the hydrating read) into
///     `imageDataUrl`.
///
/// Reads are tolerant: a missing / malformed / non-array file yields `[]`
/// (readDbFile, main.cjs:606-622) — a bad cloud file must never hard-fail a
/// sync (risks #14).
enum CloudClipCodec {
    static let inlineImageExtraKey = "__rawImageDataUrl"

    // MARK: - Decode (cloud JSON -> ClipItems)

    /// Parse the cloud file bytes into clips. Returns `[]` on any error.
    static func decode(_ data: Data) -> [ClipItem] {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rawClips = root["clips"] as? [Any] else {
            return []
        }
        var out: [ClipItem] = []
        out.reserveCapacity(rawClips.count)
        for case let obj as [String: Any] in rawClips {
            if let clip = decodeClip(obj) { out.append(clip) }
        }
        return out
    }

    private static func str(_ v: Any?) -> String? {
        if let s = v as? String { return s }
        return nil
    }
    private static func int64(_ v: Any?) -> Int64? {
        if let n = v as? NSNumber { return n.int64Value }
        if let s = v as? String, let n = Int64(s) { return n }
        return nil
    }
    private static func bool(_ v: Any?) -> Bool {
        if let b = v as? Bool { return b }
        if let n = v as? NSNumber { return n.intValue != 0 }
        return false
    }

    /// Decode one camelCase clip object. Returns nil only when the id is empty.
    static func decodeClip(_ obj: [String: Any]) -> ClipItem? {
        let id = (str(obj["id"]) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !id.isEmpty else { return nil }

        let tags = (obj["tags"] as? [Any])?.compactMap { $0 as? String } ?? []
        let typeRaw = str(obj["type"]) ?? "text"
        let type = ClipType(rawValue: typeRaw) ?? .text

        // Preserve unknown keys (round-trip) into `extra`, mirroring rowToClip's
        // spread of `extra`. Skip the well-known camelCase columns.
        var extra: [String: String] = [:]
        for (k, v) in obj where !knownKeys.contains(k) {
            if let s = v as? String { extra[k] = s }
        }
        // Inline full image -> the file-routing extra key.
        if let dataURL = str(obj["imageDataUrl"]), !dataURL.isEmpty {
            extra[inlineImageExtraKey] = dataURL
        }

        return ClipItem(
            id: id,
            seq: Int(int64(obj["seq"]) ?? 0),
            userId: str(obj["userId"]) ?? "mac_user_demo",
            deviceId: str(obj["deviceId"]) ?? "",
            type: type,
            summary: str(obj["summary"]),
            content: str(obj["content"]),
            contentHTML: str(obj["contentHtml"]),
            sourceURL: str(obj["sourceUrl"]),
            imagePath: nil,                       // local-only; never on the wire
            imageMime: nil,
            imagePreviewDataURL: str(obj["imagePreviewDataUrl"]),
            imageURL: str(obj["imageUrl"]),
            isFavorite: bool(obj["isFavorite"]),
            isDeleted: bool(obj["isDeleted"]),
            tags: tags,
            clientUpdatedAt: int64(obj["clientUpdatedAt"]),
            serverUpdatedAt: int64(obj["serverUpdatedAt"]),
            createdAt: int64(obj["createdAt"]) ?? 0,
            extra: extra.isEmpty ? nil : extra
        )
    }

    private static let knownKeys: Set<String> = [
        "id", "seq", "userId", "deviceId", "type", "summary", "content",
        "contentHtml", "sourceUrl", "imageDataUrl", "imagePreviewDataUrl",
        "imageUrl", "isFavorite", "isDeleted", "tags", "clientUpdatedAt",
        "serverUpdatedAt", "createdAt"
    ]

    // MARK: - Encode (ClipItems -> cloud JSON)

    /// Build the camelCase JSON dictionary for one clip. The inline full image
    /// is pulled from `extra["__rawImageDataUrl"]` (the hydrating read populates
    /// it); when stripped by the cap it becomes NSNull (-> JSON `null`).
    static func encodeClip(_ clip: ClipItem) -> [String: Any] {
        var dict: [String: Any] = [:]
        // Round-trip any unknown extra keys first (excluding our private one).
        if let extra = clip.extra {
            for (k, v) in extra where k != inlineImageExtraKey {
                dict[k] = v
            }
        }
        dict["id"] = clip.id
        dict["userId"] = clip.userId
        dict["deviceId"] = clip.deviceId
        dict["type"] = clip.type.rawValue
        dict["summary"] = clip.summary ?? NSNull()
        dict["content"] = clip.content ?? NSNull()
        dict["contentHtml"] = clip.contentHTML ?? NSNull()
        dict["sourceUrl"] = clip.sourceURL ?? NSNull()
        dict["imageDataUrl"] = clip.extra?[inlineImageExtraKey] ?? NSNull()
        dict["imagePreviewDataUrl"] = clip.imagePreviewDataURL ?? NSNull()
        dict["imageUrl"] = clip.imageURL ?? NSNull()
        dict["isFavorite"] = clip.isFavorite
        dict["isDeleted"] = clip.isDeleted
        dict["tags"] = clip.tags
        dict["clientUpdatedAt"] = clip.clientUpdatedAt ?? NSNull()
        dict["serverUpdatedAt"] = clip.serverUpdatedAt ?? NSNull()
        dict["createdAt"] = clip.createdAt
        return dict
    }

    /// Encode `{ clips: [...] }` pretty-printed (JSON.stringify(.,null,2) parity).
    static func encode(_ clips: [ClipItem]) -> Data? {
        let root: [String: Any] = ["clips": clips.map(encodeClip)]
        return try? JSONSerialization.data(
            withJSONObject: root,
            options: [.prettyPrinted, .sortedKeys]
        )
    }

    // MARK: - Cap (strip oldest non-favorite full images under budget)

    /// `capCloudPayloadClips` (main.cjs:760-778): if the estimated payload
    /// exceeds the budget, strip the full `imageDataUrl` from the OLDEST
    /// non-favorite clips first (favorites' images preserved) until it fits.
    /// `clips` are already sorted newest-first by cleanupLocalDb, so iterate
    /// from the tail (oldest).
    static func cap(_ clips: [ClipItem], budgetBytes: Int) -> [ClipItem] {
        var total = clips.reduce(0) { $0 + estimateJsonBytes($1) }
        if total <= budgetBytes { return clips }

        var capped = clips
        var i = capped.count - 1
        while i >= 0 && total > budgetBytes {
            let clip = capped[i]
            if !clip.isFavorite,
               let dataURL = clip.extra?[inlineImageExtraKey], !dataURL.isEmpty {
                total -= dataURL.utf8.count
                var e = clip.extra ?? [:]
                e[inlineImageExtraKey] = nil
                capped[i].extra = e.isEmpty ? nil : e
            }
            i -= 1
        }
        return capped
    }

    /// estimateClipJsonBytes (main.cjs:737-742).
    static func estimateJsonBytes(_ clip: ClipItem) -> Int {
        (clip.content?.utf8.count ?? 0)
            + (clip.contentHTML?.utf8.count ?? 0)
            + (clip.extra?[inlineImageExtraKey]?.utf8.count ?? 0)
            + (clip.imagePreviewDataURL?.utf8.count ?? 0)
            + 256
    }
}
