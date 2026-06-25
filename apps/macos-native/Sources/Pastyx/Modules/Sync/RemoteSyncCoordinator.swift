import Foundation

/// Remote pull + merge-in coordinator.
///
/// Pulls clips from the remote API (`GET /clips`) and merges them into the local
/// HistoryStore so a configured-but-remote-backed install keeps a local mirror
/// (this is what makes the clips:list local fallback on remote failure show real
/// history — main.cjs:2780-2783). The merge uses the MergeEngine's Layer-2
/// JSON-import upsert (favorite OR'd, tags unioned, `>=` LWW tie-break) against
/// the matching local row, exactly as the Electron JSON import path does.
///
/// Respects `isRemoteEnabled` (apiBase is http(s)): when remote is disabled every
/// method is a no-op success. ZERO external deps.
@MainActor
public final class RemoteSyncCoordinator {
    private let store: ClipStore
    private let config: ConfigStore
    private let remote: RemoteSyncing
    private let remoteClient: RemoteClient
    private let merge: MergeEngine

    /// Fired after a pull changed the local store (wire to the view-model refresh).
    public var onClipsChanged: (() -> Void)?

    public init(
        store: ClipStore,
        config: ConfigStore,
        remote: RemoteSyncing,
        remoteClient: RemoteClient,
        merge: MergeEngine = ClipMergeEngine()
    ) {
        self.store = store
        self.config = config
        self.remote = remote
        self.remoteClient = remoteClient
        self.merge = merge
    }

    /// Pull the remote clip list and merge each remote clip into the local store.
    ///
    /// For each remote clip:
    ///   - hydrate its full payload via `GET /clips/:id` only when the list was
    ///     lite (the list strips contentHtml/imageDataUrl);
    ///   - look up the existing local row (`store.get`);
    ///   - run the Layer-2 merge (`mergeImportedClip`) — skip the write if the
    ///     merged snapshot key is unchanged (avoids rewriting unchanged rows /
    ///     re-persisting huge base64 payloads, risks #8);
    ///   - apply the merged result through the store (create or upsert-via-create;
    ///     setFavorite / softDelete reflected from the merged flags).
    ///
    /// Returns whether the local store changed. No-op success when remote is off.
    @discardableResult
    public func pullAndMerge(_ query: ClipQuery = ClipQuery(limit: 60)) async -> SyncRunResult {
        guard remoteClient.isRemoteEnabled else {
            return SyncRunResult(ok: true, localChanged: false, reason: "disabled")
        }

        let remoteClips: [ClipItem]
        do {
            remoteClips = try await remote.listClips(query)
        } catch let e as SyncError {
            return SyncRunResult(ok: false, reason: Self.reason(for: e))
        } catch {
            return SyncRunResult(ok: false, reason: error.localizedDescription)
        }

        var localChanged = false
        for lite in remoteClips {
            // Hydrate the full clip (the list is lite, so html/full image were
            // stripped). Fall back to the lite copy if the detail fetch fails.
            let existing = (try? store.get(id: lite.id)) ?? nil

            // CHEAP change-detection on the LITE copy first (risks #8): the
            // snapshot key is [clipSyncTs, favorite, sorted tags, isDeleted] —
            // ALL of which lite mode carries — so we can skip the expensive full
            // `getClip` hydrate + write when the merge wouldn't change the row.
            if let existing {
                let liteMerged = merge.mergeImportedClip(incoming: lite, existing: existing)
                if merge.clipSyncSnapshotKey(existing) == merge.clipSyncSnapshotKey(liteMerged) {
                    continue
                }
            }

            // The row will change: hydrate the full payload (lite stripped
            // contentHtml/imageDataUrl) so the merge keeps the real content.
            var incoming = lite
            if let full = try? await remote.getClip(id: lite.id) {
                incoming = full
            }
            let merged = merge.mergeImportedClip(incoming: incoming, existing: existing)

            do {
                // The native ClipStore has no batch-merge, but create() is an
                // upsert (INSERT … ON CONFLICT(id) DO UPDATE, HistoryStore:436)
                // that writes the WHOLE merged row verbatim — payload, flags
                // (is_favorite / is_deleted) AND the winning timestamps. So a
                // single create() faithfully applies the import-merge result for
                // new rows, live updates AND tombstones, preserving the merged
                // clipSyncTs (no re-stamping a delete to now). This mirrors the
                // Electron JSON-import upsert, which stores the merged record as-is.
                _ = try store.create(merged)
                localChanged = true
            } catch {
                // Best-effort: one bad row must not abort the whole pull.
                continue
            }
        }

        if localChanged { onClipsChanged?() }
        return SyncRunResult(ok: true, localChanged: localChanged, reason: "ok")
    }

    private static func reason(for error: SyncError) -> String {
        switch error {
        case .remoteDisabled: return "disabled"
        case .network(let m): return m
        case .remote(let code, let message): return "\(code): \(message)"
        default: return "error"
        }
    }
}
