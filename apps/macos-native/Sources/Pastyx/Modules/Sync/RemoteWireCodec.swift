import Foundation

// =============================================================================
// REMOTE WIRE CODEC
//
// The remote API speaks camelCase JSON ClipItems (`contentHtml`, `sourceUrl`,
// `imageDataUrl`, `imagePreviewDataUrl`, `imageUrl`, `clientUpdatedAt`, ...) per
// docs/api-contract.md §2. The native ClipItem's default Codable keys do NOT
// match that wire shape (it uses sourceURL/contentHTML/imagePreviewDataURL/…),
// and the canonical column set has no inline full image — the full data url is
// carried in `extra["__rawImageDataUrl"]` (see HistoryStore).
//
// This codec is the SINGLE place that translates between the wire JSON and the
// native ClipItem so the URLSession client + remote sync never hand-roll key
// names. It mirrors:
//   - clips:create body build (main.cjs:2820-2834)
//   - the server ClipItem response shape (api-contract §2)
//
// ZERO external deps: Foundation JSONSerialization only.
// =============================================================================

enum RemoteWireCodec {
    /// Key used inside ClipItem.extra to carry the full-res inline image data url
    /// (matches HistoryStore's convention).
    static let rawImageDataURLKey = "__rawImageDataUrl"

    // MARK: - Decode (wire JSON object -> ClipItem)

    /// Decode a single wire clip object (already a JSON dictionary) into a
    /// native ClipItem. Tolerant: missing fields fall back to ClipItem defaults.
    /// The wire `imageDataUrl` (full inline image) is routed into
    /// `extra["__rawImageDataUrl"]` so HistoryStore.create persists it to a file
    /// instead of a column (risks #12: images never touch a row column).
    static func decodeClip(_ obj: [String: Any]) -> ClipItem {
        func str(_ key: String) -> String? {
            if let s = obj[key] as? String { return s.isEmpty ? nil : s }
            return nil
        }
        func int64(_ key: String) -> Int64? {
            if let n = obj[key] as? NSNumber { return n.int64Value }
            if let s = obj[key] as? String, let v = Int64(s) { return v }
            return nil
        }
        func bool(_ key: String) -> Bool {
            if let b = obj[key] as? Bool { return b }
            if let n = obj[key] as? NSNumber { return n.intValue != 0 }
            if let s = obj[key] as? String { return s == "1" || s.lowercased() == "true" }
            return false
        }

        let id = (obj["id"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? UUID().uuidString
        let typeRaw = (obj["type"] as? String) ?? "text"
        let type = ClipType(rawValue: typeRaw) ?? .text

        let tags: [String]
        if let arr = obj["tags"] as? [Any] {
            tags = arr.compactMap { $0 as? String }
        } else {
            tags = []
        }

        var extra: [String: String] = [:]
        // Full inline image -> extra raw key so it lands on disk, not a column.
        if let dataURL = str("imageDataUrl") {
            extra[rawImageDataURLKey] = dataURL
        }

        let createdAt = int64("createdAt") ?? Int64(Date().timeIntervalSince1970 * 1000)

        return ClipItem(
            id: id,
            seq: Int(int64("seq") ?? 0),
            userId: str("userId") ?? "mac_user_demo",
            deviceId: str("deviceId") ?? "",
            type: type,
            summary: str("summary"),
            content: str("content"),
            contentHTML: str("contentHtml"),
            sourceURL: str("sourceUrl"),
            imagePath: str("imagePath"),
            imageMime: str("imageMime"),
            imagePreviewDataURL: str("imagePreviewDataUrl"),
            imageURL: str("imageUrl"),
            isFavorite: bool("isFavorite"),
            isDeleted: bool("isDeleted"),
            tags: tags,
            clientUpdatedAt: int64("clientUpdatedAt"),
            serverUpdatedAt: int64("serverUpdatedAt"),
            createdAt: createdAt,
            extra: extra.isEmpty ? nil : extra
        )
    }

    /// Decode a `{items:[...]}` or bare-array `data` payload into ClipItems.
    /// Accepts either `{items:[clip…]}` (the /clips list shape) or a raw array.
    static func decodeClipList(_ data: Data) -> [ClipItem] {
        guard let root = try? JSONSerialization.jsonObject(with: data) else { return [] }
        let rawItems: [Any]
        if let dict = root as? [String: Any], let items = dict["items"] as? [Any] {
            rawItems = items
        } else if let arr = root as? [Any] {
            rawItems = arr
        } else {
            return []
        }
        return rawItems.compactMap { $0 as? [String: Any] }.map(decodeClip)
    }

    /// Decode a single clip from a `data` payload (the /clips/:id response shape).
    static func decodeSingleClip(_ data: Data) -> ClipItem? {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        // Some servers wrap the clip under data.clip / data.item; accept both.
        if let inner = obj["clip"] as? [String: Any] { return decodeClip(inner) }
        if let inner = obj["item"] as? [String: Any] { return decodeClip(inner) }
        return decodeClip(obj)
    }

    // MARK: - Encode (ClipItem -> wire JSON body for POST /clips)

    /// Build the `POST /clips` upsert body (mirrors main.cjs:2820-2834). The full
    /// inline image is pulled from `extra["__rawImageDataUrl"]` if present.
    /// `clientUpdatedAt` is always stamped to `now` (the upsert is a fresh write).
    static func encodeUpsertBody(_ clip: ClipItem, now: Int64) -> Data {
        var body: [String: Any] = [
            "id": clip.id,
            "type": clip.type.rawValue,
            "content": clip.content ?? "",
            "isFavorite": clip.isFavorite,
            "isDeleted": clip.isDeleted,
            "tags": clip.tags,
            "clientUpdatedAt": now
        ]
        if let s = clip.summary { body["summary"] = s }
        body["contentHtml"] = clip.contentHTML ?? NSNull()
        body["sourceUrl"] = clip.sourceURL ?? NSNull()
        body["imageDataUrl"] = (clip.extra?[rawImageDataURLKey]) ?? NSNull()
        body["imagePreviewDataUrl"] = clip.imagePreviewDataURL ?? NSNull()
        body["imageUrl"] = clip.imageURL ?? NSNull()

        return (try? JSONSerialization.data(withJSONObject: body)) ?? Data("{}".utf8)
    }

    /// Build a JSON body from a flat dictionary (favorite / delete patches).
    static func encodeBody(_ dict: [String: Any]) -> Data {
        (try? JSONSerialization.data(withJSONObject: dict)) ?? Data("{}".utf8)
    }
}
