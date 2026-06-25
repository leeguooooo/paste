import Foundation

/// iCloud Documents file sync coordinator (ICloudSyncing).
///
/// Cloud wire format: a single JSON file
///   ~/Library/Mobile Documents/com~apple~CloudDocs/Pastyx/pastyx-local-clips.json
/// = `{clips:[...full ClipItem with inline imageDataUrl...]}` (main.cjs:755-873).
///
/// Drives the Layer-1 merge (MergeEngine.mergeClipsForLocalSync) + cleanupLocalDb
/// through the ClipStore, then writes the capped JSON back. Faithful port of
/// `syncLocalDbWithICloud` / `runICloudSyncIfNeeded` / `scheduleICloudSyncIfNeeded`
/// / `startICloudSyncWatcher`.
@MainActor
public final class ICloudSyncCoordinator: ICloudSyncing {
    public var onClipsChanged: (() -> Void)?

    private let store: ClipStore
    private let config: ConfigStore
    private let merge: MergeEngine

    /// Direct-sqlite accessor for the read-all (tombstones included) + hard-delete
    /// the ClipStore protocol does not expose.
    private let syncStore = ICloudSyncStore()

    /// Last sync state (icloud:status, main.cjs:261-265).
    private var lastSyncAt: Int64?
    private var lastResult: SyncOutcome = .idle
    private var lastMessage: String?

    /// Debounce guard (pendingICloudSyncTimer) + mtime gate.
    private var pendingSyncTimer: Timer?
    private var periodicTimer: Timer?
    /// Starts at -1 so the very first periodic tick is never gated out by a
    /// missing cloud file (mtime 0 != -1), matching main.cjs:268.
    private var lastSyncedICloudFileMtimeMs: Int64 = -1
    private var lastOversizedICloudAbsorbAt: Int64 = 0
    /// Guards against a periodic tick re-entering while a sync is in flight.
    private var isSyncing = false

    // iCloud paths (main.cjs:241-243). Literal CloudDocs path under home.
    private static let cloudFileName = "pastyx-local-clips.json"
    private static let appDirName = "Pastyx"
    private static let maxFullDbReadBytes: Int64 = 75 * 1024 * 1024
    private static let oversizedAbsorbCooldownMs: Int64 = 60 * 60 * 1000 // 1 hour

    private var cloudAppDir: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Mobile Documents/com~apple~CloudDocs", isDirectory: true)
            .appendingPathComponent(Self.appDirName, isDirectory: true)
    }
    private var cloudFileURL: URL {
        cloudAppDir.appendingPathComponent(Self.cloudFileName)
    }

    public init(store: ClipStore, config: ConfigStore, merge: MergeEngine = ClipMergeEngine()) {
        self.store = store
        self.config = config
        self.merge = merge
    }

    // MARK: - Status

    public func status() -> SyncStatus {
        SyncStatus(
            enabled: config.config.icloudSync,
            available: isAvailable(),
            remoteMode: isRemoteConfigured() ? "remote" : "local",
            lastSyncAt: lastSyncAt,
            lastResult: lastResult,
            lastMessage: lastMessage
        )
    }

    public func isAvailable() -> Bool {
        // isICloudDriveAvailable(): try mkdir -p <CloudDocs>/Pastyx.
        do {
            try FileManager.default.createDirectory(at: cloudAppDir, withIntermediateDirectories: true)
            return true
        } catch {
            return false
        }
    }

    // MARK: - Forced sync (icloud:sync-now / runICloudSyncIfNeeded)

    public func syncNow(notify: Bool) async -> SyncRunResult {
        let result = runSync()

        // State surface (runICloudSyncIfNeeded, main.cjs:883-904).
        let isSkipped = result.ok && result.reason == "disabled"
        lastSyncAt = Self.nowMs()
        lastResult = isSkipped ? .skipped : (result.ok ? .ok : .error)
        lastMessage = result.reason

        // After a success OR a deterministic failure (won't fix itself on the
        // next tick), hold the periodic watcher off until the cloud file changes.
        if (result.ok && !isSkipped)
            || result.reason == "history-too-large"
            || result.reason == "local-read-failed" {
            lastSyncedICloudFileMtimeMs = iCloudFileMtimeMs()
        }

        // Broadcast only on a real local change (clips:changed {source:"icloud"}).
        if notify && result.ok && result.localChanged {
            onClipsChanged?()
        }
        return result
    }

    /// The full `syncLocalDbWithICloud` algorithm (main.cjs:755-873).
    private func runSync() -> SyncRunResult {
        guard config.config.icloudSync else {
            return SyncRunResult(ok: true, reason: "disabled")
        }
        guard isAvailable() else {
            return SyncRunResult(ok: false, reason: "icloud-unavailable")
        }

        // 1. Oversized cloud file (written by the pre-sqlite engine) would brick
        //    sync forever. Absorb once/hour via Layer-2 import, then treat cloud
        //    as empty and rewrite capped below. Throttled by lastOversizedAbsorbAt.
        var oversizedCloudRecovered = false
        if cloudFileSizeBytes() > Self.maxFullDbReadBytes {
            let now = Self.nowMs()
            if now - lastOversizedICloudAbsorbAt < Self.oversizedAbsorbCooldownMs {
                return SyncRunResult(ok: false, reason: "history-too-large")
            }
            lastOversizedICloudAbsorbAt = now
            guard absorbOversizedCloudFile() else {
                return SyncRunResult(ok: false, reason: "history-too-large")
            }
            oversizedCloudRecovered = true
        }

        // 2. Read local clips (tombstones included) with images hydrated within
        //    the budget. nil => hard read failure.
        guard let localClips = syncStore.readAllForSync(byteBudget: Self.maxFullDbReadBytes) else {
            return SyncRunResult(ok: false, reason: "local-read-failed")
        }

        // 3. Snapshot BEFORE merge (cleanupLocalDb mutates clips in place — risks #8).
        var localBeforeById: [String: String] = [:]
        for clip in localClips {
            localBeforeById[clip.id] = merge.clipSyncSnapshotKey(clip)
        }

        let cloudClips: [ClipItem] = oversizedCloudRecovered ? [] : readCloudFile()
        var cloudBeforeById: [String: String] = [:]
        for clip in cloudClips where !clip.id.isEmpty {
            cloudBeforeById[clip.id] = merge.clipSyncSnapshotKey(clip)
        }

        // 4. Layer-1 merge + retention/cap/adjacent-dedupe cleanup.
        let mergedRaw = merge.mergeClipsForLocalSync(local: localClips, cloud: cloudClips)
        let merged = merge.cleanupLocalDb(
            mergedRaw,
            retentionMs: config.config.retention.milliseconds,
            now: Self.nowMs()
        )

        // 5. Local direction: create new / update changed / hard-delete evicted.
        var localChanged = false
        var mergedIds = Set<String>()
        for clip in merged {
            let id = clip.id.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !id.isEmpty else { continue }
            mergedIds.insert(id)

            let before = localBeforeById[id]
            if let before, before == merge.clipSyncSnapshotKey(clip) {
                continue // unchanged
            }
            // create() is an upsert in HistoryStore, so both the prepend (new id)
            // and update (changed snapshot) paths route through it. The clip
            // carries its inline image in extra["__rawImageDataUrl"], which
            // create() persists to a file (never into sqlite).
            do {
                _ = try store.create(clip)
                localChanged = true
            } catch {
                // best-effort; retried next tick
            }
        }
        // Any local id that fell OUT of the merged/retention set is a retention
        // eviction (NOT a user-delete): hard-delete it (risks #7).
        for id in localBeforeById.keys where !mergedIds.contains(id) {
            syncStore.hardDelete(id: id)
            localChanged = true
        }

        // 6. Cloud direction: rewrite if recovered, count differs, or any
        //    snapshot differs from cloudBefore (per-clip, no payload materialize).
        var cloudChanged = oversizedCloudRecovered || merged.count != cloudBeforeById.count
        if !cloudChanged {
            for clip in merged {
                let before = cloudBeforeById[clip.id]
                if before == nil || before != merge.clipSyncSnapshotKey(clip) {
                    cloudChanged = true
                    break
                }
            }
        }
        if cloudChanged {
            writeCloudFile(merged)
        }

        if localChanged {
            // get()-served images may now differ; the broadcast is fired by the
            // caller (syncNow) based on localChanged.
        }

        return SyncRunResult(
            ok: true,
            localChanged: localChanged,
            cloudChanged: cloudChanged,
            reason: "ok"
        )
    }

    /// Layer-2 absorb of an oversized cloud file (importJsonHistoryFile parity):
    /// stream each cloud clip, merge against the existing local row via the
    /// import-layer rule (favorite OR'd), write it through the store.
    private func absorbOversizedCloudFile() -> Bool {
        let cloudClips = readCloudFile()
        guard !cloudClips.isEmpty else { return true } // nothing to absorb, ok
        for incoming in cloudClips {
            let id = incoming.id.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !id.isEmpty else { continue }
            let existing = try? store.get(id: id)
            let merged = merge.mergeImportedClip(incoming: incoming, existing: existing)
            _ = try? store.create(merged)
        }
        return true
    }

    // MARK: - Debounced schedule (scheduleICloudSyncIfNeeded, main.cjs:906-915)

    public func scheduleSyncIfNeeded(delayMs: Int, notify: Bool) {
        guard config.config.icloudSync else { return }
        // Single pending-timer guard: a timer already pending wins (don't reset).
        guard pendingSyncTimer == nil else { return }
        let delay = max(0.25, Double(delayMs) / 1000.0) // >= 250ms floor
        pendingSyncTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.pendingSyncTimer = nil
                await self.guardedSync(notify: notify)
            }
        }
    }

    // MARK: - Periodic watcher (startICloudSyncWatcher, main.cjs:2503-2522)

    public func startPeriodicWatcher() {
        stopPeriodicWatcher()
        // 5s interval; each tick is mtime-gated so the expensive image-hydrating
        // full sync only runs when another device rewrote the cloud file.
        periodicTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                guard self.config.config.icloudSync else { return }
                // mtime gate: skip when the cloud file is unchanged since the
                // last completed sync.
                if self.iCloudFileMtimeMs() == self.lastSyncedICloudFileMtimeMs { return }
                await self.guardedSync(notify: true)
            }
        }
        // 5s post-startup kick (main.cjs:2520-2521): run once shortly after launch.
        Timer.scheduledTimer(withTimeInterval: 5.0, repeats: false) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.config.config.icloudSync else { return }
                await self.guardedSync(notify: true)
            }
        }
    }

    public func stopPeriodicWatcher() {
        periodicTimer?.invalidate()
        periodicTimer = nil
        pendingSyncTimer?.invalidate()
        pendingSyncTimer = nil
    }

    /// Re-entrancy guard around syncNow so overlapping timers serialize.
    private func guardedSync(notify: Bool) async {
        guard !isSyncing else { return }
        isSyncing = true
        defer { isSyncing = false }
        _ = await syncNow(notify: notify)
    }

    // MARK: - Cloud file I/O

    /// Tolerant read (readDbFile, main.cjs:606-622): missing / malformed /
    /// non-array => []. A bad cloud file must never hard-fail a sync (risks #14).
    private func readCloudFile() -> [ClipItem] {
        guard let data = try? Data(contentsOf: cloudFileURL) else { return [] }
        return CloudClipCodec.decode(data)
    }

    /// Write `{clips}` capped to floor(75MiB * 0.7), ensuring the app dir exists.
    private func writeCloudFile(_ clips: [ClipItem]) {
        _ = isAvailable() // ensures the app dir exists (ensureICloudAppDir)
        let budget = Int(Double(Self.maxFullDbReadBytes) * 0.7)
        let capped = CloudClipCodec.cap(clips, budgetBytes: budget)
        guard let data = CloudClipCodec.encode(capped) else { return }
        try? data.write(to: cloudFileURL, options: .atomic)
    }

    private func cloudFileSizeBytes() -> Int64 {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: cloudFileURL.path),
              let size = attrs[.size] as? Int else { return 0 }
        return Int64(size)
    }

    /// Cloud file mtime in ms (statSync mtimeMs, 0 on miss). Used by the watcher.
    private func iCloudFileMtimeMs() -> Int64 {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: cloudFileURL.path),
              let date = attrs[.modificationDate] as? Date else { return 0 }
        return Int64(date.timeIntervalSince1970 * 1000)
    }

    // MARK: - Helpers

    private func isRemoteConfigured() -> Bool {
        let base = config.config.apiBase.lowercased()
        return base.hasPrefix("http://") || base.hasPrefix("https://")
    }

    private static func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }
}
