import Foundation

// =============================================================================
// SYNC LAYER CONTRACTS
//
// Ported from the Electron sources (electron/local-history.cjs, electron/main.cjs,
// docs/SSO_INTEGRATION_PLAN.md, docs/api-contract.md). These are the protocol
// surfaces the sync subsystems conform to. Implementations live in
// Sources/Pastyx/Modules/Sync/ as inert STUBS for this scaffold — the math /
// algorithm bodies are filled in by the module agents.
//
// ZERO external SPM deps: URLSession for network, FileManager for iCloud.
// =============================================================================

// MARK: - Sync errors

/// Errors surfaced by the sync layer. Distinct from PastyxError so callers can
/// pattern-match sync-specific failures (and so the merge math stays pure).
public enum SyncError: Error, Sendable {
    /// iCloud Drive container is not reachable (mkdir of the app dir failed).
    case icloudUnavailable
    /// Remote mode is not configured (apiBase is empty / not http(s)).
    case remoteDisabled
    /// SSO/auth precondition failed (e.g. remote not enabled before sign-in).
    case authNotConfigured(String)
    /// The loopback OAuth callback returned an error / bad state, or timed out.
    case ssoFailed(String)
    /// Server returned a structured error envelope (`{ok:false, code, message}`).
    case remote(code: String, message: String)
    /// URLSession transport failure.
    case network(String)
    /// The cloud JSON / legacy export could not be read or was malformed.
    case badCloudFile(String)
    /// Migration source (Electron data dir) missing or unreadable.
    case migrationSource(String)
    /// Generic.
    case generic(String)

    /// Human-readable message for surfacing in the UI.
    public var userMessage: String {
        switch self {
        case .icloudUnavailable: return "iCloud Drive is unavailable."
        case .remoteDisabled: return "Cloud sync is not enabled."
        case .authNotConfigured(let m): return m
        case .ssoFailed(let m): return m
        case .remote(_, let m): return m
        case .network(let m): return m
        case .badCloudFile(let m): return m
        case .migrationSource(let m): return m
        case .generic(let m): return m
        }
    }
}

// =============================================================================
// MARK: - MergeEngine — the crown jewel (pure, tombstone-aware)
//
// Ports BOTH Electron merge layers FAITHFULLY:
//   Layer 1  mergeClipsForLocalSync (main.cjs:639-669)        — iCloud sync
//   Layer 2  runJsonImportTransaction upsert (local-history.cjs:538-592)
//                                                              — JSON history import
//
// CRITICAL DIVERGENCE (risks #1): the two layers differ on `isFavorite`:
//   Layer 1 → NEWER's favorite wins   (so un-favoriting can propagate)
//   Layer 2 → favorite is OR'd        (never lose a favorite on import)
// Do NOT unify them. Tags are unioned in both. `>=` tie-break in both (risks #2).
// =============================================================================

/// Pure, I/O-free merge math. No state, no store access — every method is a
/// deterministic function of its inputs so it can be unit-tested in isolation
/// (mirrors the pure Electron functions exactly).
public protocol MergeEngine: Sendable {
    /// `clipSyncTs(clip) = max(serverUpdatedAt||0, clientUpdatedAt||0, createdAt||0)`
    /// (main.cjs:632-637 / local-history.cjs:125-130). Missing => 0.
    /// This is the LWW timestamp for LOCAL + iCloud merges (NOT the remote API,
    /// which compares clientUpdatedAt only — risks #3).
    func clipSyncTs(_ clip: ClipItem) -> Int64

    /// Stable change-detection key (NOT a merge key): main.cjs:671-677
    /// `JSON([clipSyncTs, Boolean(isFavorite), tags.slice().sort(), Boolean(isDeleted)])`.
    /// Used to detect whether a clip actually changed without materializing the
    /// (possibly huge) base64 payload. Port as a stable string.
    func clipSyncSnapshotKey(_ clip: ClipItem) -> String

    /// Adjacent-duplicate collapse key (cleanupLocalDb, main.cjs:927-994):
    /// `[type, content.trim().prefix(200), sourceUrl.trim(), contentHtml.trim().prefix(200),
    ///   imageDataUrl ? prefix(64)+":"+length : ""].join("|")`.
    func dedupeKey(_ clip: ClipItem) -> String

    /// LAYER 1 — iCloud sync merge. Pure (main.cjs:639-669).
    /// Builds a Map<id,clip> ingesting LOCAL first then CLOUD. On collision the
    /// newer (by clipSyncTs, `>=` => incoming/cloud wins ties) wins ALL fields,
    /// EXCEPT: `isFavorite = newer.isFavorite` (NEWER wins — NOT a union), and
    /// `tags = union(newer.tags, older.tags)`. Insertion order = local then
    /// cloud-only ids appended.
    func mergeClipsForLocalSync(local: [ClipItem], cloud: [ClipItem]) -> [ClipItem]

    /// LAYER 2 — JSON-import upsert merge for ONE incoming clip against an
    /// existing row (local-history.cjs:538-592). `incomingNewer = ts(incoming) >= ts(existing)`.
    /// merged = (incomingNewer ? incoming : existing) with
    /// `isFavorite = incoming.isFavorite || existing.isFavorite` (OR'd — differs
    /// from Layer 1!) and `tags = union(existing.tags, incoming.tags)`.
    /// `existing == nil` => return incoming unchanged (caller assigns negative seq).
    func mergeImportedClip(incoming: ClipItem, existing: ClipItem?) -> ClipItem

    /// `cleanupLocalDb(cfg, {clips})` (main.cjs:927-994) applied to a merged set:
    /// retention filter (keep if isFavorite || createdAt >= cutoff; forever=>keep
    /// all), cap 5000 (favorites first, then non-favorites createdAt DESC),
    /// sort createdAt DESC, then ADJACENT-ONLY duplicate collapse (collapse into
    /// previous iff dedupeKey equal AND |ΔcreatedAt| <= 60_000ms; on collapse
    /// prev.isFavorite ||= clip.isFavorite, prev.tags = union). "A,B,A" survives.
    /// `now` injected for testability; `retentionMs == nil` => forever.
    func cleanupLocalDb(_ clips: [ClipItem], retentionMs: Int64?, now: Int64) -> [ClipItem]
}

// =============================================================================
// MARK: - SyncStatus model
//
// Mirrors the icloud:status / auth:status / local-sync:status surfaces
// (main.cjs:2558-2568, 2590-2630, 2656-2700).
// =============================================================================

/// Outcome of the last sync attempt (icloud:status `lastResult`).
public enum SyncOutcome: String, Codable, Sendable {
    case idle
    case ok
    case error
    case skipped
}

/// Snapshot of the iCloud sync subsystem (icloud:status, main.cjs:2558-2568).
public struct SyncStatus: Codable, Sendable, Equatable {
    /// `config.icloudSync`.
    public var enabled: Bool
    /// iCloud Drive container reachable right now.
    public var available: Bool
    /// "local" | "remote" — whether a remote API base is configured too.
    public var remoteMode: String
    /// ms epoch of the last completed sync, or nil.
    public var lastSyncAt: Int64?
    /// idle | ok | error | skipped.
    public var lastResult: SyncOutcome
    /// Human-readable message from the last sync (e.g. "iCloud Drive unavailable…").
    public var lastMessage: String?

    public init(
        enabled: Bool = false,
        available: Bool = false,
        remoteMode: String = "local",
        lastSyncAt: Int64? = nil,
        lastResult: SyncOutcome = .idle,
        lastMessage: String? = nil
    ) {
        self.enabled = enabled
        self.available = available
        self.remoteMode = remoteMode
        self.lastSyncAt = lastSyncAt
        self.lastResult = lastResult
        self.lastMessage = lastMessage
    }
}

/// Result of a single sync run (syncLocalDbWithICloud return value).
public struct SyncRunResult: Sendable, Equatable {
    public var ok: Bool
    /// Whether the LOCAL store changed (drives the clips:changed broadcast).
    public var localChanged: Bool
    /// Whether the CLOUD file was rewritten.
    public var cloudChanged: Bool
    /// "disabled" | "unavailable" | "ok" | "skipped" | error reason.
    public var reason: String

    public init(ok: Bool, localChanged: Bool = false, cloudChanged: Bool = false, reason: String = "ok") {
        self.ok = ok
        self.localChanged = localChanged
        self.cloudChanged = cloudChanged
        self.reason = reason
    }
}

// =============================================================================
// MARK: - ICloudSyncing — iCloud Documents file sync coordinator
//
// Drives the Layer-1 merge through HistoryStore. The cloud wire format is a
// SINGLE JSON file `<CloudDocs>/Pastyx/pastyx-local-clips.json` = `{clips:[...]}`
// with images INLINE as base64 data urls (main.cjs:755-873).
// =============================================================================

@MainActor
public protocol ICloudSyncing: AnyObject {
    /// Broadcast when a sync changed the local store (source:"icloud"); wire to
    /// the view-model refresh so open windows reload.
    var onClipsChanged: (() -> Void)? { get set }

    /// Current status snapshot (icloud:status).
    func status() -> SyncStatus

    /// `isICloudDriveAvailable()` (main.cjs:585-596): try mkdir of the app dir.
    func isAvailable() -> Bool

    /// Forced immediate sync (icloud:sync-now IPC). Reads cloud JSON, runs the
    /// Layer-1 merge + cleanupLocalDb, applies create/update/hard-delete through
    /// the store, then writes the capped JSON back. `notify` broadcasts on a
    /// local change.
    func syncNow(notify: Bool) async -> SyncRunResult

    /// Debounced sync (scheduleICloudSyncIfNeeded, main.cjs:906-915): single
    /// pending-timer guard, fires after `delayMs`. Called after every local
    /// mutation. No-op when icloudSync disabled.
    func scheduleSyncIfNeeded(delayMs: Int, notify: Bool)

    /// Periodic mtime-gated watcher tick (skips the expensive full sync when the
    /// cloud file's mtime is unchanged since the last completed sync).
    func startPeriodicWatcher()
    func stopPeriodicWatcher()
}

// =============================================================================
// MARK: - RemoteClient + RemoteSyncing — remote API client
//
// Envelope convention: EVERY response is `{ok:bool, code?, message?, data?}`
// (remoteRequest, main.cjs:1453-1479). base = normalized apiBase (includes /v1).
// =============================================================================

/// Decoded response envelope. `data` stays as raw bytes so each caller decodes
/// its own payload shape (clips, items, auth/me, etc.).
public struct RemoteEnvelope: Sendable {
    public var ok: Bool
    public var code: String?
    public var message: String?
    /// Raw JSON of the `data` field (nil when absent). Callers JSONDecode this.
    public var data: Data?

    public init(ok: Bool, code: String? = nil, message: String? = nil, data: Data? = nil) {
        self.ok = ok
        self.code = code
        self.message = message
        self.data = data
    }
}

/// Low-level transport (remoteRequest + buildRemoteHeaders, main.cjs:1437-1479).
/// URLSession-backed. Adds content-type:application/json and the identity headers
/// (Bearer token + x-device-id when token auth, else x-user-id + x-device-id).
public protocol RemoteClient: Sendable {
    /// Remote enabled iff apiBase matches `^https?://` (isRemoteEnabled, main.cjs:561).
    var isRemoteEnabled: Bool { get }

    /// `normalizeApiBase` (main.cjs:492-509): strip hash/query + trailing slashes;
    /// empty path defaults to `/v1`. Returns the base used for requests.
    func normalizedApiBase() -> String?

    /// Issue a request and decode the `{ok,code,message,data}` envelope. `method`
    /// is GET/POST/PATCH/DELETE; `path` is appended to the normalized base; `body`
    /// is the JSON request payload (nil for GET); `extraHeaders` are merged in.
    func request(method: String, path: String, body: Data?, extraHeaders: [String: String]) async -> RemoteEnvelope
}

/// High-level remote clip + sync operations over RemoteClient (main.cjs clips:*
/// IPC handlers + the /clips endpoints). The dual-write / local-first-on-failure
/// degradation logic lives in the coordinator that owns both this and the store.
public protocol RemoteSyncing: Sendable {
    /// `GET /clips?q=&favorite=1&limit=&lite=1` → items (main.cjs:2771-2776).
    func listClips(_ query: ClipQuery) async throws -> [ClipItem]

    /// `GET /clips/:id` → full clip (main.cjs:2801).
    func getClip(id: String) async throws -> ClipItem?

    /// `POST /clips` upsert; body = full clip patch (main.cjs:1715/2843/2726).
    func upsertClip(_ clip: ClipItem) async throws -> ClipItem

    /// `PATCH /clips/:id` `{isFavorite, clientUpdatedAt}` (main.cjs:2868).
    func setFavorite(id: String, isFavorite: Bool, clientUpdatedAt: Int64) async throws

    /// `DELETE /clips/:id` body `{clientUpdatedAt}` (main.cjs:2894).
    func deleteClip(id: String, clientUpdatedAt: Int64) async throws

    /// `GET /images/:clipId?u=&h=` — optional R2 image fetch (api-contract §4.1).
    func fetchImage(clipId: String, userId: String, sha256: String?) async throws -> Data?
}

// =============================================================================
// MARK: - AuthService — SSO (OAuth2 Authorization Code + PKCE via loopback)
//
// SSO_INTEGRATION_PLAN.md + main.cjs:1506-1688. Loopback redirect on
// 127.0.0.1:45897/auth/sso/callback. Token + login stored in config (parity);
// Keychain upgrade optional but the config fields must persist for round-trip.
// =============================================================================

/// The authenticated identity (auth:status `user`).
public struct AuthUser: Codable, Sendable, Equatable {
    public var userId: String
    public var githubLogin: String?
    public var githubId: String?
    public var email: String?
    public var name: String?

    public init(userId: String, githubLogin: String? = nil, githubId: String? = nil, email: String? = nil, name: String? = nil) {
        self.userId = userId
        self.githubLogin = githubLogin
        self.githubId = githubId
        self.email = email
        self.name = name
    }

    /// Friendly label for UI: real name → email → github login → short id.
    public var displayName: String {
        if let name = name?.trimmingCharacters(in: .whitespaces), !name.isEmpty { return name }
        if let email = email?.trimmingCharacters(in: .whitespaces), !email.isEmpty { return email }
        if let login = githubLogin?.trimmingCharacters(in: .whitespaces), !login.isEmpty, login != userId { return login }
        return String(userId.prefix(8))
    }
}

/// auth:status return shape (main.cjs:2590-2630).
public struct AuthStatus: Sendable, Equatable {
    public var remoteEnabled: Bool
    public var authenticated: Bool
    /// Whether the server has SSO configured at all.
    public var authConfigured: Bool
    public var user: AuthUser?

    public init(remoteEnabled: Bool, authenticated: Bool, authConfigured: Bool, user: AuthUser?) {
        self.remoteEnabled = remoteEnabled
        self.authenticated = authenticated
        self.authConfigured = authConfigured
        self.user = user
    }
}

@MainActor
public protocol AuthService: AnyObject {
    /// auth:status (main.cjs:2590-2630). Self-heals an expired token (clears
    /// authToken/authGithubLogin when /auth/me says unauthenticated).
    func status() async -> AuthStatus

    /// auth:sso-start (startSsoSignIn, main.cjs:1629-1688): PKCE pair + loopback
    /// server on :45897, open the browser, capture the code, exchange at
    /// `POST /auth/sso/token`, store token, fetch identity at `GET /auth/me`.
    /// Returns the approved user. Throws SyncError.ssoFailed / .authNotConfigured.
    func startSignIn() async throws -> AuthUser

    /// auth:logout (main.cjs:2637-2654): best-effort `POST /auth/logout {}`, then
    /// clear authToken + authGithubLogin from config. Returns the prior userId.
    @discardableResult
    func logout() async -> String
}

// =============================================================================
// MARK: - LocalSyncing — one-time bulk upload of local history after SSO login
//
// local-sync:status/run/dismiss (main.cjs:2656-2762). Decision stored per-user
// in AppConfig.localSyncDecisionByUser ("imported" | "skipped").
// =============================================================================

/// local-sync:status return (main.cjs:2656-2700).
public struct LocalSyncStatus: Sendable, Equatable {
    /// Whether the one-time prompt should show (remote + token auth + no decision).
    public var shouldPrompt: Bool
    /// Count of non-deleted local clips eligible to upload (countPending).
    public var pendingCount: Int
    /// The recorded decision for the current user, if any.
    public var decision: String?

    public init(shouldPrompt: Bool, pendingCount: Int, decision: String?) {
        self.shouldPrompt = shouldPrompt
        self.pendingCount = pendingCount
        self.decision = decision
    }
}

/// Progress broadcast during a run (local-sync:progress, main.cjs).
public struct LocalSyncProgress: Sendable, Equatable {
    public var phase: String
    public var total: Int
    public var uploaded: Int
    public var failed: Int
    public var processed: Int
    public var percent: Int

    public init(phase: String, total: Int, uploaded: Int, failed: Int, processed: Int, percent: Int) {
        self.phase = phase
        self.total = total
        self.uploaded = uploaded
        self.failed = failed
        self.processed = processed
        self.percent = percent
    }
}

@MainActor
public protocol LocalSyncing: AnyObject {
    /// Fired as clips upload (wire to UI progress).
    var onProgress: ((LocalSyncProgress) -> Void)? { get set }

    func status() async -> LocalSyncStatus

    /// Stream all non-deleted local clips (images hydrated) and POST each to
    /// /clips; on zero failures record decision "imported".
    func run() async throws

    /// Record decision "skipped" for the current user.
    func dismiss()
}

// =============================================================================
// MARK: - Migrator — one-time Electron -> native data migration
//
// Source: ~/Library/Application Support/@paste/macos (Electron userData).
// Target: ~/Library/Application Support/paste (native HistoryStore dir).
// Strategy: the sqlite schema is byte-identical, so copy
//   pastyx-local-clips.sqlite -> local-history.sqlite + the images/ dir verbatim
// (preserves seq/tombstones/favorites/timestamps/image links). Then map the
// Electron config JSON into AppConfig. Guarded by a "migrated" marker so it
// never re-runs. Do NOT touch the .json.migrated*.bak legacy exports (superseded).
// =============================================================================

/// Outcome of a migration attempt.
public struct MigrationResult: Sendable, Equatable {
    /// Whether the migration ran this time (false => already migrated / no source).
    public var migrated: Bool
    /// Clips carried over (best-effort count).
    public var clipCount: Int
    /// Image files copied.
    public var imageCount: Int
    /// Whether the Electron config JSON was mapped into AppConfig.
    public var configMigrated: Bool
    /// Human-readable note (e.g. "already migrated", "no electron data found").
    public var note: String

    public init(migrated: Bool, clipCount: Int = 0, imageCount: Int = 0, configMigrated: Bool = false, note: String = "") {
        self.migrated = migrated
        self.clipCount = clipCount
        self.imageCount = imageCount
        self.configMigrated = configMigrated
        self.note = note
    }
}

@MainActor
public protocol Migrator: AnyObject {
    /// True if the Electron data dir exists AND no native "migrated" marker yet.
    func needsMigration() -> Bool

    /// Run the one-time migration (copy sqlite + images, map config). Idempotent:
    /// writes a marker on success so subsequent launches no-op. Returns what it
    /// did. Never deletes the Electron dir (the user is uninstalling it themself).
    @discardableResult
    func migrateIfNeeded() async -> MigrationResult
}
