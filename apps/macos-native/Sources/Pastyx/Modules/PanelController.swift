import AppKit
import SwiftUI

/// Non-activating panel that can become key WITHOUT activating the app.
/// THIS IS THE BUG FIX: clicks/keys are never swallowed by construction.
///
/// An `LSUIElement` agent app has no main window and never becomes active, so a
/// normal `NSWindow` (or an Electron `BrowserWindow`) will not reliably accept
/// keyboard input — that is the "点击没反应" bug the rewrite targets. An
/// `NSPanel` with the `.nonactivatingPanel` style mask plus a `canBecomeKey`
/// override accepts key + mouse events while the owning app stays inactive, so
/// macOS never switches Spaces away from a fullscreen app underneath.
public final class NonActivatingPanel: NSPanel {
    public override var canBecomeKey: Bool { true }
    public override var canBecomeMain: Bool { false }
}

/// NSPanel-based overlay window controller. Hosts the SwiftUI island via an
/// NSHostingView; reveals centered + bottom-anchored on the cursor's display;
/// becomes KEY without activating the app; hides on resignKey with a short
/// post-show suppression window (mirrors the Electron 900ms grace).
///
/// Geometry, reveal sequence, and grace handling all mirror the Electron source
/// (toggleMainWindow main.cjs:1906; getMainWindowBounds 1867; blur handler
/// 2171). The native NSPanel makes "becoming key" reliable by construction.
@MainActor
public final class PanelController: NSObject, PanelControlling, NSWindowDelegate {
    public var onShown: (() -> Void)?
    public var onHidden: (() -> Void)?

    private let viewModel: IslandViewModel
    private let pasteService: () -> PasteService?
    private var panel: NonActivatingPanel?

    // Geometry constants. Full-width island: span the display's work area minus a
    // small side inset so the rounded glass corners + shadow still breathe at the
    // screen edges, instead of capping at a centered fixed width.
    public static let sideMargin: CGFloat = 12
    public static let height: CGFloat = 440
    public static let bottomMargin: CGFloat = 16
    // Initial content size before fitToDisplay resizes to the actual display.
    public static let maxWidth: CGFloat = 1440

    /// Post-show grace window: while now < this timestamp, resignKey does NOT
    /// hide the panel (mirrors `suppressBlurHideUntil = now + 900` in main.cjs:1920).
    /// The focus churn during reveal would otherwise immediately self-hide.
    private static let revealGrace: TimeInterval = 0.9
    private var suppressHideUntil: TimeInterval = 0

    public init(viewModel: IslandViewModel, pasteService: @escaping () -> PasteService?) {
        self.viewModel = viewModel
        self.pasteService = pasteService
        super.init()
    }

    public var isVisible: Bool { panel?.isVisible ?? false }

    // MARK: - Reveal / Hide / Toggle

    public func reveal() {
        let panel = ensurePanel()

        // Record the frontmost non-self app BEFORE we order the panel front, so
        // the paste flow can restore it. Because the panel is non-activating the
        // prior app usually stays frontmost anyway, but capturing here is robust.
        pasteService()?.captureFrontmostApp()

        // Fit geometry to the cursor's display when hidden; stay put when already
        // visible (matches fitMainWindowToDisplay, main.cjs:1878).
        fitToDisplay(panel: panel)

        // Open the grace window before the focus churn of showing the panel.
        suppressHideUntil = Self.nowInterval() + Self.revealGrace

        // Become KEY without activating the app. orderFrontRegardless brings the
        // panel forward even though the app is inactive; makeKey then routes
        // keyboard + mouse to it. NO NSApp.activate -> no Space switch.
        panel.orderFrontRegardless()
        panel.makeKey()

        onShown?()
    }

    public func hide() {
        guard let panel, panel.isVisible else { return }
        panel.orderOut(nil)
        onHidden?()
    }

    public func toggle() {
        if isVisible { hide() } else { reveal() }
    }

    // MARK: - Panel construction

    private func ensurePanel() -> NonActivatingPanel {
        if let panel { return panel }

        let panel = NonActivatingPanel(
            contentRect: NSRect(x: 0, y: 0, width: Self.maxWidth, height: Self.height),
            styleMask: [.nonactivatingPanel, .borderless, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        // Float above normal windows but still let fullscreen apps stay put.
        panel.level = .floating
        // Join all Spaces, ride along over fullscreen apps, and don't get pulled
        // into the active-app cycle (mirrors setVisibleOnAllWorkspaces +
        // skipTransformProcessType in main.cjs:2150-2160).
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]

        // Spotlight-style dark HUD glass. The SwiftUI island draws its own Liquid
        // Glass on top; this backs the rounded frame.
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        // Force the dark HUD appearance so Liquid Glass always renders its dark
        // variant. Without this the glass follows whatever is behind the panel —
        // over a light webpage it turns pale and the white text vanishes.
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovable = false
        panel.isMovableByWindowBackground = false
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.animationBehavior = .none
        panel.delegate = self

        // Host the SwiftUI island.
        let host = NSHostingView(rootView: IslandView(viewModel: viewModel))
        host.frame = panel.contentView?.bounds ?? .zero
        host.autoresizingMask = [.width, .height]
        host.appearance = NSAppearance(named: .darkAqua)
        // Let the glass corners show through the hosting layer.
        host.wantsLayer = true
        host.layer?.backgroundColor = NSColor.clear.cgColor
        panel.contentView = host

        self.panel = panel
        return panel
    }

    // MARK: - Geometry

    /// Compute the bottom-anchored, horizontally-centered island frame for a
    /// display's visible work area. Mirrors getMainWindowBounds (main.cjs:1867).
    ///
    /// NOTE: AppKit uses a bottom-left origin, so "bottom-anchored" places the
    /// panel `bottomMargin` points above the work-area minY (above the Dock).
    static func bounds(in workArea: NSRect) -> NSRect {
        // Stretch the full work-area width (minus a small side inset).
        let width = (workArea.width - sideMargin * 2).rounded(.down)
        let height = min(self.height, workArea.height - bottomMargin * 2)
        let x = workArea.minX + sideMargin
        let y = workArea.minY + bottomMargin
        return NSRect(x: x, y: y, width: width, height: height)
    }

    private func fitToDisplay(panel: NonActivatingPanel) {
        let screen: NSScreen?
        if panel.isVisible {
            // Stay on the display the panel currently occupies.
            screen = screenMatching(panel.frame) ?? NSScreen.main
        } else {
            // Open on the display under the cursor.
            screen = screenContainingCursor() ?? NSScreen.main
        }
        guard let workArea = screen?.visibleFrame else { return }
        let next = Self.bounds(in: workArea)
        if panel.frame != next {
            panel.setFrame(next, display: true)
        }
    }

    private func screenContainingCursor() -> NSScreen? {
        let cursor = NSEvent.mouseLocation
        return NSScreen.screens.first { NSMouseInRect(cursor, $0.frame, false) }
    }

    private func screenMatching(_ rect: NSRect) -> NSScreen? {
        // Pick the screen with the largest intersection area with the panel.
        NSScreen.screens.max { a, b in
            a.frame.intersection(rect).area < b.frame.intersection(rect).area
        }
    }

    // MARK: - NSWindowDelegate

    public func windowDidResignKey(_ notification: Notification) {
        // Hide on losing key focus, UNLESS we're inside the post-show grace
        // window (the reveal's own focus churn would otherwise self-hide).
        // Mirrors the blur handler suppress check (main.cjs:2171).
        if Self.nowInterval() < suppressHideUntil { return }
        hide()
    }

    /// Monotonic-ish wall clock used for the post-show grace comparison.
    private static func nowInterval() -> TimeInterval {
        Date().timeIntervalSinceReferenceDate
    }
}

private extension NSRect {
    var area: CGFloat { width * height }
}
