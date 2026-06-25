import AppKit
import ApplicationServices
import Foundation

/// Accessibility (AX) permission helper.
///
/// Pastyx synthesizes Cmd+V via CGEvent to paste into the previously-frontmost
/// app, which macOS only allows once the process is granted Accessibility access
/// (System Settings → Privacy & Security → Accessibility). This helper centralizes
/// the trust check, the system prompt, and the deep link that jumps the user
/// straight to the right pane.
@MainActor
public enum AccessibilityHelper {
    /// Whether the process is AX-trusted right now (no prompt).
    public static var isTrusted: Bool {
        AXIsProcessTrusted()
    }

    /// Trigger the system "grant Accessibility" prompt. Returns the trust state
    /// at call time (the user may grant it asynchronously afterwards).
    @discardableResult
    public static func prompt() -> Bool {
        // kAXTrustedCheckOptionPrompt is a non-concurrency-safe global `var` under
        // Swift 6; its value is the stable string "AXTrustedCheckOptionPrompt".
        let promptKey = "AXTrustedCheckOptionPrompt" as CFString
        let options = [promptKey: true] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    /// Deep link to System Settings → Privacy & Security → Accessibility.
    public static let settingsURL = URL(
        string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
    )!

    /// Open the Accessibility pane in System Settings.
    public static func openSettings() {
        NSWorkspace.shared.open(settingsURL)
    }

    /// Show the standard prompt and, if still untrusted, surface a short alert
    /// with a button that jumps to the Accessibility pane. Safe to call from any
    /// flow that needs paste to work (e.g. the menu-bar item or a failed paste).
    public static func requestWithGuidance() {
        // First fire the native prompt (adds Pastyx to the list, toggled off).
        if prompt() { return }

        let alert = NSAlert()
        alert.messageText = "Enable Accessibility for paste"
        alert.informativeText = """
        To paste your selected clip back into the app you were using, paste needs \
        Accessibility access.

        Open System Settings → Privacy & Security → Accessibility, then turn on paste.
        """
        alert.alertStyle = .informational
        alert.addButton(withTitle: "Open System Settings")
        alert.addButton(withTitle: "Later")

        let response = alert.runModal()
        if response == .alertFirstButtonReturn {
            openSettings()
        }
    }
}
