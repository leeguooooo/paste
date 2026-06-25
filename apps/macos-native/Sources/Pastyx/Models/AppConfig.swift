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

    /// One-time bulk-upload decision recorded per userId after SSO login.
    /// Maps userId -> "imported" | "skipped". Mirrors the Electron config field
    /// `localSyncDecisionByUser` (real config shows `{"leeguooooo":"imported"}`).
    /// Required so the SSO bulk-upload prompt doesn't re-fire forever.
    public var localSyncDecisionByUser: [String: String]

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
        icloudSync: Bool = false,
        localSyncDecisionByUser: [String: String] = [:]
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
        self.localSyncDecisionByUser = localSyncDecisionByUser
    }

    // Lenient decoder: every field defaults so an older config JSON missing the
    // newer keys (e.g. localSyncDecisionByUser) still round-trips.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let d = AppConfig()
        apiBase = try c.decodeIfPresent(String.self, forKey: .apiBase) ?? d.apiBase
        userId = try c.decodeIfPresent(String.self, forKey: .userId) ?? d.userId
        deviceId = try c.decodeIfPresent(String.self, forKey: .deviceId) ?? d.deviceId
        autoCapture = try c.decodeIfPresent(Bool.self, forKey: .autoCapture) ?? d.autoCapture
        launchAtLogin = try c.decodeIfPresent(Bool.self, forKey: .launchAtLogin) ?? d.launchAtLogin
        retention = try c.decodeIfPresent(Retention.self, forKey: .retention) ?? d.retention
        hotkey = try c.decodeIfPresent(String.self, forKey: .hotkey) ?? d.hotkey
        authToken = try c.decodeIfPresent(String.self, forKey: .authToken) ?? d.authToken
        authGithubLogin = try c.decodeIfPresent(String.self, forKey: .authGithubLogin) ?? d.authGithubLogin
        icloudSync = try c.decodeIfPresent(Bool.self, forKey: .icloudSync) ?? d.icloudSync
        localSyncDecisionByUser = try c.decodeIfPresent([String: String].self, forKey: .localSyncDecisionByUser) ?? d.localSyncDecisionByUser
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
