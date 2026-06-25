import AppKit
import Foundation

// MARK: - Errors

public enum PastyxError: Error, Sendable {
    case accessibilityNotTrusted
    case noTargetApp
    case imageTooLarge
    case store(String)
    case generic(String)
}

// MARK: - ClipStore (HistoryStore.swift)

/// SQLite-backed clip store mirroring the clips schema (local-history.cjs).
public protocol ClipStore: AnyObject, Sendable {
    /// List clips honoring the query (limit, substring filter, favorite filter,
    /// lite projection that strips html/full image but keeps the preview data url).
    /// Excludes tombstones (is_deleted=1). Ordered by created_at DESC, seq DESC.
    func list(_ query: ClipQuery) throws -> [ClipItem]

    /// Fetch the FULL clip by id (hydrates html/image payloads). nil if missing/deleted.
    func get(id: String) throws -> ClipItem?

    /// Insert a new clip (assigns seq). Returns the stored item.
    @discardableResult
    func create(_ item: ClipItem) throws -> ClipItem

    /// Toggle / set the favorite flag.
    func setFavorite(id: String, _ isFavorite: Bool) throws

    /// Soft delete (sets is_deleted=1 tombstone).
    func softDelete(id: String) throws

    /// Retention prune: drop non-favorite clips older than the cutoff (favorites
    /// exempt, forever=noop), cap at 5000 (favorites first then newest), reap
    /// tombstones older than the TTL. Mirrors cleanupLocalDb (main.cjs:927).
    func prune(retention: Retention) throws
}

// MARK: - ClipboardWatcher (ClipboardWatcher.swift)

/// Source that triggered a capture (mirrors the Electron capture sources).
public enum CaptureSource: String, Sendable {
    case watcher
    case hotkey
    case menu
    case manual
}

/// Polls NSPasteboard.changeCount and captures new clips, with two-tier dedupe
/// and a self-paste guard.
@MainActor
public protocol ClipboardWatcher: AnyObject {
    /// Called after a successful capture so any open window can refresh.
    var onClipsChanged: (() -> Void)? { get set }

    /// Begin polling (~700ms). Gated by config.autoCapture.
    func start()
    func stop()

    /// Force an immediate capture (e.g. on hotkey reveal). Bypasses the probe
    /// short-circuit for `.manual`.
    func captureNow(source: CaptureSource)

    /// Self-paste guard: snapshot changeCount + content fingerprint right after
    /// WE write the pasteboard, so the next tick treats it as already-seen.
    func syncFingerprintsFromSystemClipboard()
}

// MARK: - PasteService (Paste.swift)

/// Writes a payload to the pasteboard and synthesizes Cmd+V after restoring the
/// previously-frontmost app, gated on Accessibility trust.
@MainActor
public protocol PasteService: AnyObject {
    /// Whether the process is AX-trusted right now.
    var isAccessibilityTrusted: Bool { get }

    /// Prompt the user to grant Accessibility (AXIsProcessTrustedWithOptions).
    func promptForAccessibility()

    /// Record the frontmost non-self app at reveal time so we can restore it.
    func captureFrontmostApp()

    /// Full paste-and-hide flow: gate on AX, write payload, snapshot fingerprint,
    /// hide the panel, restore the target app, CGEventPost Cmd+V.
    /// Throws PastyxError on failure.
    func pasteAndHide(_ payload: PastePayload) throws
}

// MARK: - HotKeyManager (Hotkey.swift)

/// Carbon RegisterEventHotKey wrapper. Default Cmd+Shift+V toggles the panel.
@MainActor
public protocol HotKeyManager: AnyObject {
    /// Fired when the registered hotkey is pressed.
    var onTrigger: (() -> Void)? { get set }

    /// Register the accelerator string. Returns the accelerator actually used
    /// (may differ if a fallback was needed). Throws on total failure.
    @discardableResult
    func register(_ accelerator: String) throws -> String

    func unregister()
}

// MARK: - PanelControlling (PanelController.swift)

/// The non-activating NSPanel that hosts the SwiftUI island.
@MainActor
public protocol PanelControlling: AnyObject {
    var isVisible: Bool { get }

    /// Fired when the panel becomes/loses key (renderer replays entrance / refreshes).
    var onShown: (() -> Void)? { get set }
    var onHidden: (() -> Void)? { get set }

    /// Reveal: lazy-create, capture frontmost app, capture clipboard, fit geometry
    /// to the cursor's display, become key WITHOUT activating the app.
    func reveal()
    func hide()
    func toggle()
}

// MARK: - StatusItemControlling (StatusItem.swift)

/// NSStatusItem menu: Show/Hide, Settings, Capture Now, Quit.
@MainActor
public protocol StatusItemControlling: AnyObject {
    var onToggleWindow: (() -> Void)? { get set }
    var onOpenSettings: (() -> Void)? { get set }
    var onCaptureNow: (() -> Void)? { get set }
    var onQuit: (() -> Void)? { get set }

    func install()
    /// Update the hotkey status label shown (disabled) in the menu.
    func updateHotkeyLabel(_ accelerator: String)
}

// MARK: - ConfigStore (Config.swift)

/// Codable config persisted as JSON.
public protocol ConfigStore: AnyObject {
    var config: AppConfig { get }

    /// Load from disk (writing normalized defaults on miss).
    func load()
    /// Persist the given config (normalizes first).
    func save(_ config: AppConfig)
}
