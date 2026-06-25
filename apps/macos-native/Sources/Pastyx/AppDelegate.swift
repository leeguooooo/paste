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

    public func applicationDidFinishLaunching(_ notification: Notification) {
        // Agent app: no Dock icon (also LSUIElement=true in Info.plist).
        NSApp.setActivationPolicy(.accessory)

        // 1. Config.
        configStore.load()
        viewModel.config = configStore.config

        // 2. Wire subsystems.
        watcher = PasteboardWatcher(store: store, config: configStore)
        panel = PanelController(viewModel: viewModel, pasteService: { [weak self] in self?.pasteService })
        pasteService = CGEventPasteService(panel: panel, watcher: watcher)

        // 3. Watcher -> view model refresh.
        watcher.onClipsChanged = { [weak self] in
            Task { @MainActor in self?.viewModel.onRefresh?() }
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
        viewModel.onDelete = { [weak self] clip in try? self?.store.softDelete(id: clip.id); self?.refreshClips() }
        viewModel.onToggleFavorite = { [weak self] clip in
            try? self?.store.setFavorite(id: clip.id, !clip.isFavorite); self?.refreshClips()
        }
        viewModel.onHide = { [weak self] in self?.panel.hide() }
        viewModel.onSaveConfig = { [weak self] cfg in self?.saveConfig(cfg) }

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

        // 8. Start watcher + startup retention prune.
        watcher.start()
        try? store.prune(retention: configStore.config.retention)
    }

    private func refreshClips() {
        let query = ClipQuery(search: viewModel.query, favoritesOnly: viewModel.favoritesOnly)
        if let clips = try? store.list(query) {
            viewModel.clips = clips
        }
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
