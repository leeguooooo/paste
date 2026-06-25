import Foundation

/// Codable config persisted as JSON in
/// ~/Library/Application Support/paste/config.json.
///
/// load(): reads the JSON from `url`; on miss (or unreadable/corrupt) writes
/// normalized defaults. Re-normalizes (device-id sentinel) and rewrites if
/// normalization changed anything, so a freshly-minted device id is persisted.
///
/// save(): normalizes + pretty-prints JSON to `url` (creating the parent dir).
///
/// Thread-affine to whoever owns it (AppDelegate is @MainActor); reads/writes are
/// synchronous. This is the single source of truth the whole sync layer reads
/// (the remote client reads identity live from here, the migrator writes the
/// migrated config here, SSO persists the token here).
public final class JSONConfigStore: ConfigStore {
    public private(set) var config: AppConfig

    /// Path to the config JSON.
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
        if let data = try? Data(contentsOf: url),
           var decoded = try? JSONDecoder().decode(AppConfig.self, from: data) {
            let before = decoded
            decoded.normalize()
            config = decoded
            // Persist a normalization that changed something (e.g. a freshly
            // generated device id) so it stays stable across launches.
            if decoded != before {
                writeToDisk(decoded)
            }
            return
        }
        // Miss / corrupt: write normalized defaults.
        var c = AppConfig()
        c.normalize()
        config = c
        writeToDisk(c)
    }

    public func save(_ config: AppConfig) {
        var c = config
        c.normalize()
        self.config = c
        writeToDisk(c)
    }

    /// Pretty-print + atomically write the config JSON, creating the parent dir.
    private func writeToDisk(_ config: AppConfig) {
        let dir = url.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(config) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
