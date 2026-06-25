import AppKit

/// NSStatusItem menu-bar controller.
///
/// Menu (top to bottom): Toggle (Show/Hide), Open Settings, Capture Clipboard Now,
/// a disabled "Hotkey: …" status line, an Accessibility status/affordance line,
/// a disabled version line, and Quit. Menu actions fan out to the `on*` callbacks
/// wired by the AppDelegate. The status item uses a template SF Symbol so it
/// adapts to light/dark menu bars.
@MainActor
public final class StatusItemController: NSObject, StatusItemControlling {
    public var onToggleWindow: (() -> Void)?
    public var onOpenSettings: (() -> Void)?
    public var onCaptureNow: (() -> Void)?
    public var onQuit: (() -> Void)?

    private var statusItem: NSStatusItem?
    /// The disabled "Hotkey: …" line; kept so we can update its title in place.
    private var hotkeyMenuItem: NSMenuItem?
    /// The Accessibility status line; reflects current AX-trust state.
    private var accessibilityMenuItem: NSMenuItem?

    public override init() {
        super.init()
    }

    public func install() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        if let button = item.button {
            // Template image tints automatically for the menu bar.
            let image = NSImage(
                systemSymbolName: "doc.on.clipboard",
                accessibilityDescription: "paste"
            )
            image?.isTemplate = true
            button.image = image
            // Fallback glyph if the symbol is unavailable.
            if button.image == nil {
                button.title = "P"
            }
        }

        item.menu = buildMenu()
        self.statusItem = item
    }

    public func updateHotkeyLabel(_ accelerator: String) {
        hotkeyMenuItem?.title = "Hotkey: \(AcceleratorFormatter.symbolic(accelerator))"
    }

    // MARK: - Menu construction

    private func buildMenu() -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.delegate = self

        let toggle = NSMenuItem(
            title: "Show / Hide paste",
            action: #selector(handleToggle),
            keyEquivalent: ""
        )
        toggle.target = self
        menu.addItem(toggle)

        let settings = NSMenuItem(
            title: "Settings…",
            action: #selector(handleSettings),
            keyEquivalent: ","
        )
        settings.target = self
        menu.addItem(settings)

        let capture = NSMenuItem(
            title: "Capture Clipboard Now",
            action: #selector(handleCaptureNow),
            keyEquivalent: ""
        )
        capture.target = self
        menu.addItem(capture)

        menu.addItem(.separator())

        // Disabled status line for the active hotkey.
        let hotkey = NSMenuItem(title: "Hotkey: —", action: nil, keyEquivalent: "")
        hotkey.isEnabled = false
        menu.addItem(hotkey)
        self.hotkeyMenuItem = hotkey

        // Accessibility status / affordance. When untrusted, clicking opens the
        // grant flow; when trusted it's a disabled status line.
        let accessibility = NSMenuItem(
            title: "Accessibility: —",
            action: #selector(handleAccessibility),
            keyEquivalent: ""
        )
        accessibility.target = self
        menu.addItem(accessibility)
        self.accessibilityMenuItem = accessibility

        menu.addItem(.separator())

        // Disabled version line.
        let version = NSMenuItem(title: "paste \(Self.appVersion)", action: nil, keyEquivalent: "")
        version.isEnabled = false
        menu.addItem(version)

        let quit = NSMenuItem(
            title: "Quit paste",
            action: #selector(handleQuit),
            keyEquivalent: "q"
        )
        quit.target = self
        menu.addItem(quit)

        return menu
    }

    /// Refresh the Accessibility status line to match the current trust state.
    private func refreshAccessibilityItem() {
        guard let item = accessibilityMenuItem else { return }
        if AccessibilityHelper.isTrusted {
            item.title = "Accessibility: granted"
            item.isEnabled = false
        } else {
            item.title = "Enable Accessibility…"
            item.isEnabled = true
        }
    }

    /// App version from the bundle's CFBundleShortVersionString.
    private static var appVersion: String {
        let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
        return short ?? "dev"
    }

    // MARK: - Actions

    @objc private func handleToggle() { onToggleWindow?() }
    @objc private func handleSettings() { onOpenSettings?() }
    @objc private func handleCaptureNow() { onCaptureNow?() }
    @objc private func handleQuit() { onQuit?() }

    @objc private func handleAccessibility() {
        AccessibilityHelper.requestWithGuidance()
        refreshAccessibilityItem()
    }
}

// MARK: - NSMenuDelegate

extension StatusItemController: NSMenuDelegate {
    public func menuWillOpen(_ menu: NSMenu) {
        // Reflect live AX-trust state each time the menu opens.
        refreshAccessibilityItem()
    }
}
