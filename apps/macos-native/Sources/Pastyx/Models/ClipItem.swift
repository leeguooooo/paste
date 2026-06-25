import Foundation

/// Clip content type.
///
/// ENUM in practice only {text, link, html, image} are produced by the capture
/// pipeline. `code` is kept for forward-compat (purple accent in the UI) but the
/// MVP watcher never emits it.
public enum ClipType: String, Codable, Sendable, CaseIterable {
    case text
    case link
    case code
    case html
    case image

    /// Card accent color (hex), per the Electron source (App.tsx:111, index.css:8-13).
    /// Follow the code, NOT the spec HTML.
    public var accentHex: String {
        switch self {
        case .link:  return "#007aff" // blue
        case .text:  return "#ff9500" // orange
        case .code:  return "#af52de" // purple
        case .html:  return "#34c759" // green
        case .image: return "#ff2d55" // pink
        }
    }
}

/// GROUND-TRUTH ClipItem. The SQLite schema (local-history.cjs:26-51) is the
/// canonical store; this struct mirrors those columns. Column name -> property:
///
///   id                      -> id
///   seq                     -> seq
///   user_id                 -> userId
///   device_id               -> deviceId
///   type                    -> type
///   summary                 -> summary
///   content                 -> content
///   content_html            -> contentHtml
///   source_url              -> sourceURL
///   image_path              -> imagePath
///   image_mime              -> imageMime
///   image_preview_data_url  -> imagePreviewDataURL
///   image_url               -> imageURL
///   is_favorite             -> isFavorite
///   is_deleted              -> isDeleted
///   tags                    -> tags
///   client_updated_at       -> clientUpdatedAt
///   server_updated_at       -> serverUpdatedAt
///   created_at              -> createdAt
///   extra                   -> extra
public struct ClipItem: Identifiable, Codable, Sendable, Equatable {
    /// TEXT PK. A random UUID string when none supplied.
    public var id: String
    /// Monotonic insert order; secondary sort key after createdAt.
    public var seq: Int
    /// Default "mac_user_demo".
    public var userId: String
    /// Default generated "mac_<8hex>"; the "macos_desktop" sentinel is treated as unset.
    public var deviceId: String
    public var type: ClipType
    /// First 120 chars of text/url.
    public var summary: String?
    /// Plain text; for image clips falls back to "[Image]".
    public var content: String?
    /// Rich HTML when meaningful; nil otherwise.
    public var contentHTML: String?
    /// The URL for link clips / extracted <a href> for html/image.
    public var sourceURL: String?
    /// Full-res image stored as a FILE on disk at <dir>/images/<id>.<ext>, NOT inline.
    public var imagePath: String?
    public var imageMime: String?
    /// Small JPEG data URL kept inline for fast card thumbnails (<=250KB).
    public var imagePreviewDataURL: String?
    /// Remote R2-style URL; remote mode only.
    public var imageURL: String?
    public var isFavorite: Bool
    /// SOFT DELETE / tombstone. Tombstones survive retention prune until tombstoneTtlMs.
    public var isDeleted: Bool
    /// JSON array; watcher-captured clips auto-tagged ["auto"], manual [].
    public var tags: [String]
    /// ms epoch.
    public var clientUpdatedAt: Int64?
    /// ms epoch; remote mode.
    public var serverUpdatedAt: Int64?
    /// ms epoch; PRIMARY ordering key, DESC.
    public var createdAt: Int64
    /// JSON catch-all for any non-column field (round-trips unknown keys).
    public var extra: [String: String]?

    public init(
        id: String = UUID().uuidString,
        seq: Int = 0,
        userId: String = "mac_user_demo",
        deviceId: String = "",
        type: ClipType = .text,
        summary: String? = nil,
        content: String? = nil,
        contentHTML: String? = nil,
        sourceURL: String? = nil,
        imagePath: String? = nil,
        imageMime: String? = nil,
        imagePreviewDataURL: String? = nil,
        imageURL: String? = nil,
        isFavorite: Bool = false,
        isDeleted: Bool = false,
        tags: [String] = [],
        clientUpdatedAt: Int64? = nil,
        serverUpdatedAt: Int64? = nil,
        createdAt: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        extra: [String: String]? = nil
    ) {
        self.id = id
        self.seq = seq
        self.userId = userId
        self.deviceId = deviceId
        self.type = type
        self.summary = summary
        self.content = content
        self.contentHTML = contentHTML
        self.sourceURL = sourceURL
        self.imagePath = imagePath
        self.imageMime = imageMime
        self.imagePreviewDataURL = imagePreviewDataURL
        self.imageURL = imageURL
        self.isFavorite = isFavorite
        self.isDeleted = isDeleted
        self.tags = tags
        self.clientUpdatedAt = clientUpdatedAt
        self.serverUpdatedAt = serverUpdatedAt
        self.createdAt = createdAt
        self.extra = extra
    }
}

/// Filter/projection options for listing clips (mirrors clip-list.cjs).
public struct ClipQuery: Sendable, Equatable {
    /// Case-insensitive substring match on summary/content/sourceURL.
    public var search: String
    /// Favorites-only filter.
    public var favoritesOnly: Bool
    /// Server-side list cap (Electron uses 60).
    public var limit: Int

    public init(search: String = "", favoritesOnly: Bool = false, limit: Int = 60) {
        self.search = search
        self.favoritesOnly = favoritesOnly
        self.limit = limit
    }
}

/// Payload written to the system pasteboard during a paste.
public struct PastePayload: Sendable, Equatable {
    public var text: String?
    public var html: String?
    /// PNG/JPEG bytes for image clips.
    public var imageData: Data?
    /// Remote image URL (remote mode only; ignored for MVP).
    public var imageURL: String?
    /// Shift+Enter forces plain-text paste (html/image nulled by the caller).
    public var plainTextOnly: Bool

    public init(
        text: String? = nil,
        html: String? = nil,
        imageData: Data? = nil,
        imageURL: String? = nil,
        plainTextOnly: Bool = false
    ) {
        self.text = text
        self.html = html
        self.imageData = imageData
        self.imageURL = imageURL
        self.plainTextOnly = plainTextOnly
    }
}
