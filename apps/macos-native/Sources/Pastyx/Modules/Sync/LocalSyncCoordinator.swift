import Foundation

/// One-time bulk upload of local history to remote after SSO login
/// (local-sync:status/run/dismiss, main.cjs:2656-2762).
///
/// Decision stored per-user in AppConfig.localSyncDecisionByUser
/// ("imported" | "skipped"). status() only prompts when remote is enabled, the
/// user is token-authenticated, and no decision exists yet for this userId.
@MainActor
public final class LocalSyncCoordinator: LocalSyncing {
    public var onProgress: ((LocalSyncProgress) -> Void)?

    private let store: ClipStore
    private let config: ConfigStore
    private let remote: RemoteSyncing
    private let remoteClient: RemoteClient

    public init(store: ClipStore, config: ConfigStore, remote: RemoteSyncing, remoteClient: RemoteClient) {
        self.store = store
        self.config = config
        self.remote = remote
        self.remoteClient = remoteClient
    }

    /// status() returns pendingCount only when remoteEnabled AND tokenAuth AND
    /// no decision yet for this userId (main.cjs:2656-2700).
    public func status() async -> LocalSyncStatus {
        let userId = config.config.userId
        let decision = config.config.localSyncDecisionByUser[userId]
        let tokenAuth = !config.config.authToken.trimmingCharacters(in: .whitespaces).isEmpty
        let shouldPrompt = remoteClient.isRemoteEnabled && tokenAuth && decision == nil
        let pending = shouldPrompt ? pendingCount() : 0
        return LocalSyncStatus(shouldPrompt: shouldPrompt, pendingCount: pending, decision: decision)
    }

    /// Count of non-deleted local clips eligible to upload (countPending).
    private func pendingCount() -> Int {
        (try? store.list(ClipQuery(limit: Int.max)).count) ?? 0
    }

    /// Stream all non-deleted local clips (images hydrated) and POST each to
    /// /clips; broadcast progress; on zero failures record decision "imported"
    /// (main.cjs:2677-2762). Preserves each clip's original clientUpdatedAt
    /// (||createdAt) so the server LWW keeps the real authoring time.
    public func run() async throws {
        guard remoteClient.isRemoteEnabled else {
            throw SyncError.authNotConfigured("Please configure API Endpoint first")
        }
        let tokenAuth = !config.config.authToken.trimmingCharacters(in: .whitespaces).isEmpty
        guard tokenAuth else {
            throw SyncError.authNotConfigured("Please sign in with Cloudflare SSO first")
        }
        let userId = config.config.userId.trimmingCharacters(in: .whitespaces)
        guard !userId.isEmpty else {
            throw SyncError.generic("userId is missing")
        }

        // If the user already has a decision, there's nothing pending.
        let decision = config.config.localSyncDecisionByUser[userId]
        let lite = decision != nil ? [] : ((try? store.list(ClipQuery(limit: Int.max))) ?? [])
        let total = lite.count

        emit(phase: "start", total: total, uploaded: 0, failed: 0)
        if total == 0 {
            recordDecision(userId: userId, "imported")
            emit(phase: "done", total: 0, uploaded: 0, failed: 0)
            return
        }

        var uploaded = 0
        var failed = 0

        for item in lite {
            // Hydrate the full clip (list() is lite — html/full image stripped).
            let full = (try? store.get(id: item.id)) ?? item
            if full.isDeleted { continue }
            // Preserve the original timestamp (clientUpdatedAt || createdAt),
            // mirroring main.cjs:2740.
            let stamp = full.clientUpdatedAt ?? full.createdAt
            let body = RemoteWireCodec.encodeUpsertBody(full, now: stamp)
            let env = await remoteClient.request(method: "POST", path: "/clips", body: body, extraHeaders: [:])
            if env.ok {
                uploaded += 1
            } else {
                failed += 1
            }
            emit(phase: "progress", total: total, uploaded: uploaded, failed: failed)
        }

        if failed == 0 {
            recordDecision(userId: userId, "imported")
        }
        emit(phase: "done", total: total, uploaded: uploaded, failed: failed)
    }

    /// Record "skipped" for the current user (main.cjs:2667-2675).
    public func dismiss() {
        let userId = config.config.userId.trimmingCharacters(in: .whitespaces)
        guard !userId.isEmpty else { return }
        recordDecision(userId: userId, "skipped")
    }

    // MARK: - Helpers

    private func recordDecision(userId: String, _ decision: String) {
        var cfg = config.config
        cfg.localSyncDecisionByUser[userId] = decision
        config.save(cfg)
    }

    private func emit(phase: String, total: Int, uploaded: Int, failed: Int) {
        let processed = max(0, min(total, uploaded + failed))
        let percent = total <= 0 ? 100 : max(0, min(100, Int((Double(processed) / Double(total) * 100).rounded())))
        onProgress?(LocalSyncProgress(
            phase: phase,
            total: total,
            uploaded: uploaded,
            failed: failed,
            processed: processed,
            percent: percent
        ))
    }
}
