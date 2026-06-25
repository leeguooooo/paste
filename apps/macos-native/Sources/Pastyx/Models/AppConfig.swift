import Foundation

/// Retention policy. forever => no prune; unknown => 180d.
public enum Retention: String, Codable, Sendable, CaseIterable {
    case d30 = "30d"
    case d180 = "180d"
    case d365 = "365d"
    case forever = "forever"

    /// Retention window in milliseconds, or nil for `forever` (no prune).
    public var milliseconds: Int64? {
        switch self {
        case .d30:     return 30  * 24 * 60 * 60 * 1000
        case .d180:    return 180 * 24 * 60 * 60 * 1000
        case .d365:    return 365 * 24 * 60 * 60 * 1000
        case .forever: return nil
        }
    }
}

/// App configuration, persisted as JSON in
/// ~/Library/Application Support/Pastyx/config.json.
///
/// Defaults mirror the Electron defaultConfig (main.cjs:471-488).
/// Deferred fields (auth/icloud/local-sync) are parked but unused for the MVP.
public struct AppConfig: Codable, Sendable, Equatable {
    /// Empty => LOCAL-ONLY mode (the MVP mode). Non-empty https => remote (out of scope).
    public var apiBase: String
    public var userId: String
    /// "macos_desktop" sentinel is treated as UNSET and replaced with "mac_<8hex>".
    public var deviceId: String
    /// Gates the watcher.
    public var autoCapture: Bool
    /// Applied via SMAppService / login item.
    public var launchAtLogin: Bool
    public var retention: Retention
    /// Electron accelerator string; native maps via Carbon RegisterEventHotKey.
    public var hotkey: String

    // Deferred / out-of-scope fields (parked, round-tripped, unused for MVP).
    public var authToken: String
    public var authGithubLogin: String
    public var icloudSync: Bool

    public init(
        apiBase: String = "",
        userId: String = "mac_user_demo",
        deviceId: String = "macos_desktop",
        autoCapture: Bool = true,
        launchAtLogin: Bool = false,
        retention: Retention = .d180,
        hotkey: String = "CommandOrControl+Shift+V",
        authToken: String = "",
        authGithubLogin: String = "",
        icloudSync: Bool = false
    ) {
        self.apiBase = apiBase
        self.userId = userId
        self.deviceId = deviceId
        self.autoCapture = autoCapture
        self.launchAtLogin = launchAtLogin
        self.retention = retention
        self.hotkey = hotkey
        self.authToken = authToken
        self.authGithubLogin = authGithubLogin
        self.icloudSync = icloudSync
    }

    /// The sentinel that means "no real device id assigned yet".
    public static let deviceIdSentinel = "macos_desktop"

    /// Generate a stable random device id "mac_<8 hex>".
    public static func generatedDeviceID() -> String {
        "mac_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(8).lowercased()
    }

    /// Normalize a freshly-decoded config: replace the device-id sentinel and
    /// fall back to 180d for an unknown retention value. Mirrors main.cjs:511-537.
    public mutating func normalize() {
        if deviceId.isEmpty || deviceId == Self.deviceIdSentinel {
            deviceId = Self.generatedDeviceID()
        }
    }
}
