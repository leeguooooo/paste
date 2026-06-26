import AppKit
import Foundation

/// LSUIElement agent bootstrap: hide from Dock, install NSStatusItem,
/// single-instance guard, wire up subsystems, run startup retention prune.
@MainActor
public final class AppDelegate: NSObject, NSApplicationDelegate {
    // Subsystems (concrete stubs; module agents flesh out the bodies).
    let configStore: ConfigStore = JSONConfigStore()
    let store: ClipStore = HistoryStore()
    let viewModel = IslandViewModel()

    var watcher: ClipboardWatcher!
    var panel: PanelController!
    var pasteService: PasteService!
    var hotKey: HotKeyManager = CarbonHotKeyManager()
    var statusItem: StatusItemControlling = StatusItemController()

    // Sync layer.
    let merge: MergeEngine = ClipMergeEngine()
    var icloud: ICloudSyncing!
    var auth: AuthService!
    var localSync: LocalSyncing!
    var migrator: Migrator!
    var remoteSync: RemoteSyncCoordinator!

    /// Periodic remote pull-and-merge timer (remote mode only).
    private var remotePullTimer: Timer?
    /// Periodic sync-status surface refresh (UI/menu).
    private var statusRefreshTimer: Timer?

    public func applicationDidFinishLaunching(_ notification: Notification) {
        // Agent app: no Dock icon (also LSUIElement=true in Info.plist).
        NSApp.setActivationPolicy(.accessory)

        // 1. Config.
        configStore.load()
        viewModel.config = configStore.config

        // 1c. Sync layer. The remote client reads identity (apiBase/userId/
        //     deviceId/authToken) LIVE from the config store on every request, so
        //     a token minted by SSO after launch is honored without a relaunch.
        migrator = ElectronMigrator(store: store, config: configStore)
        let remoteClient = URLSessionRemoteClient(config: configStore)
        let remoteClipSync = RemoteClipSync(client: remoteClient)
        icloud = ICloudSyncCoordinator(store: store, config: configStore, merge: merge)
        auth = SSOAuthService(config: configStore, remote: remoteClient)
        localSync = LocalSyncCoordinator(store: store, config: configStore, remote: remoteClipSync, remoteClient: remoteClient)
        remoteSync = RemoteSyncCoordinator(
            store: store, config: configStore, remote: remoteClipSync,
            remoteClient: remoteClient, merge: merge
        )
        icloud.onClipsChanged = { [weak self] in
            Task { @MainActor in
                self?.viewModel.onRefresh?()
                self?.refreshSyncStatus()
            }
        }
        remoteSync.onClipsChanged = { [weak self] in
            Task { @MainActor in self?.viewModel.onRefresh?() }
        }

        // 2. Wire subsystems.
        watcher = PasteboardWatcher(store: store, config: configStore)
        panel = PanelController(viewModel: viewModel, pasteService: { [weak self] in self?.pasteService })
        pasteService = CGEventPasteService(panel: panel, watcher: watcher)

        // 3. Watcher -> view model refresh + schedule an iCloud sync (a fresh
        //    capture is a local mutation; mirrors localCreateClip's
        //    scheduleICloudSyncIfNeeded at main.cjs:1067).
        watcher.onClipsChanged = { [weak self] in
            Task { @MainActor in
                self?.viewModel.onRefresh?()
                self?.icloud.scheduleSyncIfNeeded(delayMs: 1000, notify: true)
            }
        }

        // 4. Panel show/hide -> view model.
        panel.onShown = { [weak self] in
            Task { @MainActor in
                self?.watcher.captureNow(source: .hotkey)
                self?.viewModel.windowDidShow()
            }
        }
        panel.onHidden = { [weak self] in
            Task { @MainActor in self?.viewModel.windowDidHide() }
        }

        // 5. View model callbacks.
        viewModel.onRefresh = { [weak self] in self?.refreshClips() }
        viewModel.onPaste = { [weak self] clip, plain in self?.paste(clip, plainText: plain) }
        viewModel.onCopy = { [weak self] clip in self?.copy(clip) }
        viewModel.onDelete = { [weak self] clip in
            try? self?.store.softDelete(id: clip.id)
            self?.refreshClips()
            // Soft-delete tombstone is a local mutation -> propagate via iCloud
            // (mirrors localDeleteClip's scheduleICloudSyncIfNeeded, main.cjs:1103).
            self?.icloud.scheduleSyncIfNeeded(delayMs: 1000, notify: true)
        }
        viewModel.onToggleFavorite = { [weak self] clip in
            try? self?.store.setFavorite(id: clip.id, !clip.isFavorite)
            self?.refreshClips()
            // Favorite toggle is a local mutation (main.cjs:1084).
            self?.icloud.scheduleSyncIfNeeded(delayMs: 1000, notify: true)
        }
        viewModel.onHide = { [weak self] in self?.panel.hide() }
        viewModel.onSaveConfig = { [weak self] cfg in self?.saveConfig(cfg) }
        viewModel.onSignIn = { [weak self] in
            guard let self else { return }
            Task { @MainActor in
                self.viewModel.authBusy = true
                self.viewModel.ssoError = nil
                do {
                    _ = try await self.auth.startSignIn()
                } catch {
                    let msg = (error as? SyncError)?.userMessage ?? error.localizedDescription
                    self.viewModel.ssoError = msg
                    NSLog("[pastyx] sign-in failed: \(msg)")
                }
                self.viewModel.authStatus = await self.auth.status()
                self.viewModel.config = self.configStore.config
                self.viewModel.authBusy = false
                self.viewModel.onRefresh?()
                self.refreshSyncStatus()
            }
        }
        viewModel.onSignOut = { [weak self] in
            guard let self else { return }
            Task { @MainActor in
                self.viewModel.authBusy = true
                _ = await self.auth.logout()
                self.viewModel.authStatus = await self.auth.status()
                self.viewModel.config = self.configStore.config
                self.viewModel.authBusy = false
                self.viewModel.onRefresh?()
            }
        }

        // 6. Hotkey -> toggle panel.
        hotKey.onTrigger = { [weak self] in
            Task { @MainActor in self?.panel.toggle() }
        }

        // 7. Status item.
        statusItem.onToggleWindow = { [weak self] in self?.panel.toggle() }
        statusItem.onOpenSettings = { [weak self] in
            self?.viewModel.showingSettings = true
            self?.panel.reveal()
        }
        statusItem.onCaptureNow = { [weak self] in self?.watcher.captureNow(source: .menu) }
        statusItem.onQuit = { NSApp.terminate(nil) }
        statusItem.install()

        // 7b. Register the hotkey now that the status item exists, and reconcile
        // the actually-used accelerator back into config + the menu-bar label.
        registerHotkeyAndReconcile()

        // 8. One-time Electron -> native migration MUST complete BEFORE the
        //    watcher starts (the migrator opens the old DB read-only and imports
        //    rows through the same store; starting the watcher first would race
        //    fresh captures against the bulk import and could reorder seqs). So
        //    we run migration first, then start the watcher + sync subsystems.
        Task { @MainActor in
            await migrator.migrateIfNeeded()
            // Migration may have replaced the config (apiBase/userId/icloudSync…);
            // reflect it into the view model before starting the subsystems.
            viewModel.config = configStore.config

            // 8a. Start watcher + startup retention prune.
            watcher.start()
            try? store.prune(retention: configStore.config.retention)

            // 8b. iCloud Documents periodic watcher (mtime-gated) + 5s kick.
            icloud.startPeriodicWatcher()

            // 8c. Remote pull-and-merge timer (remote mode only — no-op when the
            //     apiBase isn't http(s)). An immediate pull on startup, then every
            //     60s, keeps the local mirror current and feeds auth status.
            startRemotePullTimer()

            // 8d. Periodic sync-status surface refresh for the UI/menu.
            startStatusRefreshTimer()
            refreshSyncStatus()
        }
    }

    // MARK: - Sync timers + status surface

    /// Remote pull-and-merge on a 60s cadence (immediate first pull). Also
    /// refreshes the auth status so the UI/menu reflect SSO sign-in state. No-op
    /// per-tick when remote is disabled (RemoteSyncCoordinator returns "disabled").
    private func startRemotePullTimer() {
        remotePullTimer?.invalidate()
        let timer = Timer(timeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.runRemotePull() }
        }
        RunLoop.main.add(timer, forMode: .common)
        remotePullTimer = timer
        // Immediate first pull.
        Task { @MainActor in await runRemotePull() }
    }

    private func runRemotePull() async {
        let result = await remoteSync.pullAndMerge()
        if result.localChanged { viewModel.onRefresh?() }
        // Refresh the auth surface (self-heals an expired token).
        viewModel.authStatus = await auth.status()
        refreshSyncStatus()
    }

    /// Refresh the iCloud sync status surface (view model + menu line) every 10s.
    private func startStatusRefreshTimer() {
        statusRefreshTimer?.invalidate()
        let timer = Timer(timeInterval: 10, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshSyncStatus() }
        }
        RunLoop.main.add(timer, forMode: .common)
        statusRefreshTimer = timer
    }

    /// Pull the latest iCloud status snapshot into the view model and the
    /// menu-bar "Sync: …" line.
    private func refreshSyncStatus() {
        let status = icloud.status()
        viewModel.syncStatus = status
        statusItem.updateSyncLabel(Self.syncMenuLabel(status))
    }

    /// Compose the menu-bar sync line from the status snapshot.
    private static func syncMenuLabel(_ s: SyncStatus) -> String {
        guard s.enabled else { return "iCloud Sync: off" }
        if !s.available { return "iCloud Sync: unavailable" }
        switch s.lastResult {
        case .idle:    return "iCloud Sync: idle"
        case .ok:      return "iCloud Sync: up to date"
        case .error:   return "iCloud Sync: error"
        case .skipped: return "iCloud Sync: idle"
        }
    }

    private func refreshClips() {
        let query = ClipQuery(search: viewModel.query, favoritesOnly: viewModel.favoritesOnly)
        if let clips = try? store.list(query) {
            viewModel.clips = clips
        }
    }

    /// Cmd+C copy-only: write the clip (rich) to the clipboard, no paste/hide.
    private func copy(_ clip: ClipItem) {
        let full = (try? store.get(id: clip.id)) ?? clip
        var payload = PastePayload(
            text: full.content,
            html: full.contentHTML,
            imageURL: full.imageURL,
            plainTextOnly: false
        )
        if full.type == .image,
           let dataURL = full.extra?["__rawImageDataUrl"],
           let bytes = Self.decodeDataURL(dataURL) {
            payload.imageData = bytes
        }
        pasteService.copyToPasteboard(payload)
    }

    private func paste(_ clip: ClipItem, plainText: Bool) {
        // Hydrate the full clip, then build the payload and paste-and-hide.
        let full = (try? store.get(id: clip.id)) ?? clip
        var payload = PastePayload(
            text: full.content,
            html: plainText ? nil : full.contentHTML,
            imageURL: full.imageURL,
            plainTextOnly: plainText
        )
        // get() hydrates the full-res image bytes into extra["__rawImageDataUrl"]
        // as a `data:<mime>;base64,...` URL; decode those into raw bytes for the
        // paste service (which writes from payload.imageData). For an explicit
        // plain-text paste we drop the rich/image payloads entirely.
        if plainText {
            payload.html = nil
            payload.imageData = nil
        } else if full.type == .image,
                  let dataURL = full.extra?["__rawImageDataUrl"],
                  let bytes = Self.decodeDataURL(dataURL) {
            payload.imageData = bytes
        }
        do {
            try pasteService.pasteAndHide(payload)
        } catch PastyxError.accessibilityNotTrusted {
            // The whole point of the rewrite is to never "do nothing" silently:
            // surface the one permission gate the user can act on.
            AccessibilityHelper.requestWithGuidance()
        } catch {
            NSSound.beep()
            NSLog("[pastyx] paste failed: \(error)")
        }
    }

    /// Decode a `data:<mime>;base64,<payload>` URL into its raw bytes.
    private static func decodeDataURL(_ dataURL: String) -> Data? {
        guard let commaIdx = dataURL.firstIndex(of: ",") else { return nil }
        let meta = dataURL[dataURL.startIndex..<commaIdx]
        let payload = String(dataURL[dataURL.index(after: commaIdx)...])
        if meta.contains(";base64") {
            return Data(base64Encoded: payload)
        }
        return payload.removingPercentEncoding?.data(using: .utf8)
    }

    private func saveConfig(_ cfg: AppConfig) {
        configStore.save(cfg)
        viewModel.config = configStore.config
        // Re-register hotkey + re-prune on config change.
        registerHotkeyAndReconcile()
        try? store.prune(retention: configStore.config.retention)
        // config:set parity (main.cjs:2531-2536): when iCloud sync is enabled,
        // run an immediate sync so the user sees the surface populate / surfaces
        // the "iCloud Drive unavailable…" state right away.
        if configStore.config.icloudSync {
            Task { @MainActor in
                _ = await icloud.syncNow(notify: true)
                refreshSyncStatus()
            }
        }
        // apiBase may have just been (un)configured; re-pull immediately so the
        // remote mirror + auth surface reflect the new endpoint, and refresh the
        // status line either way.
        Task { @MainActor in await runRemotePull() }
        refreshSyncStatus()
    }

    /// Register the configured hotkey; if the combo was taken and the manager
    /// fell back to another accelerator, persist the one actually in effect and
    /// show it in the menu bar (instead of the failed combo the user asked for).
    private func registerHotkeyAndReconcile() {
        let requested = configStore.config.hotkey
        guard let used = try? hotKey.register(requested) else {
            statusItem.updateHotkeyLabel(requested)
            return
        }
        if used != requested {
            var cfg = configStore.config
            cfg.hotkey = used
            configStore.save(cfg)
            viewModel.config = configStore.config
        }
        statusItem.updateHotkeyLabel(used)
    }
}
