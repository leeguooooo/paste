import Foundation

/// STUB. Codable config persisted as JSON in
/// ~/Library/Application Support/Pastyx/config.json.
///
/// Module agent: implement load() (read-on-miss writes defaults, re-normalizes
/// on every read) and save() (normalize + pretty-print JSON).
public final class JSONConfigStore: ConfigStore {
    public private(set) var config: AppConfig

    /// Path to the config JSON. Implementer should ensure the directory exists.
    public let url: URL

    public init() {
        let base = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first ?? URL(fileURLWithPath: NSTemporaryDirectory())
        self.url = base
            .appendingPathComponent("paste", isDirectory: true)
            .appendingPathComponent("config.json")
        self.config = AppConfig()
    }

    public func load() {
        // TODO(module: Config): read JSON from `url`; on miss, write defaults.
        // Re-normalize (device-id sentinel, retention fallback) and rewrite.
        var c = AppConfig()
        c.normalize()
        config = c
    }

    public func save(_ config: AppConfig) {
        // TODO(module: Config): normalize + pretty-print JSON to `url`.
        var c = config
        c.normalize()
        self.config = c
    }
}
