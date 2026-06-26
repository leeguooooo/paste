import AppKit
import ApplicationServices
import Carbon.HIToolbox
import Foundation

/// CGEvent paste injection.
///
/// Reproduces the Electron `clipboard:paste-and-hide` flow (main.cjs:2944-3064)
/// natively, with NO osascript:
///   1. Gate on Accessibility trust (AXIsProcessTrusted). Prompt + abort if untrusted.
///   2. Write the payload to NSPasteboard (text / html / image).
///   3. Snapshot fingerprints (self-paste guard) so the watcher ignores our write.
///   4. Hide the panel.
///   5. Restore the previously-frontmost (non-self) app and poll until it is
///      truly frontmost (fixed sleeps are flaky).
///   6. CGEventPost a Cmd+V key-down/up (kVK_ANSI_V + .maskCommand).
///
/// Native simplification: because the island lives in a non-activating NSPanel,
/// the user's frontmost app usually never loses focus. We capture
/// `NSWorkspace.frontmostApplication` at reveal time (`captureFrontmostApp`) and
/// re-activate it after hide as a belt-and-suspenders measure.
@MainActor
public final class CGEventPasteService: PasteService {
    private weak var panel: PanelControlling?
    private let watcher: ClipboardWatcher
    private var targetApp: NSRunningApplication?

    public init(panel: PanelControlling?, watcher: ClipboardWatcher) {
        self.panel = panel
        self.watcher = watcher
    }

    // MARK: - Accessibility

    public var isAccessibilityTrusted: Bool {
        AXIsProcessTrusted()
    }

    public func promptForAccessibility() {
        // AXIsProcessTrustedWithOptions with the prompt key triggers the system
        // "grant Accessibility" dialog and deep-links into System Settings.
        // The Carbon constant kAXTrustedCheckOptionPrompt is a mutable global that
        // Swift 6 flags as non-concurrency-safe, so use its literal value.
        let key = "AXTrustedCheckOptionPrompt"
        _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    }

    /// Open System Settings -> Privacy & Security -> Accessibility directly.
    private func openAccessibilityPrefs() {
        if let url = URL(
            string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        ) {
            NSWorkspace.shared.open(url)
        }
    }

    // MARK: - Frontmost app capture

    public func captureFrontmostApp() {
        // Capture the frontmost NON-self app at reveal time. Because the panel is
        // non-activating, the prior app usually stays frontmost, so this is the
        // reliable record of the paste target.
        let me = NSRunningApplication.current
        if let front = NSWorkspace.shared.frontmostApplication,
            front.processIdentifier != me.processIdentifier {
            targetApp = front
        }
    }

    /// Resolve the frontmost non-self app right now (after hiding our panel),
    /// preferring the freshly-observed app but falling back to the one captured
    /// at reveal time. Mirrors `waitForFrontmostNonSelfAppAsync` + `lastTargetApp`.
    private func resolveTargetApp() -> NSRunningApplication? {
        let me = NSRunningApplication.current
        if let front = NSWorkspace.shared.frontmostApplication,
            front.processIdentifier != me.processIdentifier {
            targetApp = front
            return front
        }
        return targetApp
    }

    // MARK: - Paste flow

    public func pasteAndHide(_ payload: PastePayload) throws {
        // Step 1 — gate on Accessibility trust.
        guard isAccessibilityTrusted else {
            promptForAccessibility()
            openAccessibilityPrefs()
            throw PastyxError.accessibilityNotTrusted
        }

        // Step 2 — write the payload to the system pasteboard.
        writePayloadToPasteboard(payload)

        // Step 3 — self-paste guard: record what we just wrote so the watcher's
        // next tick treats it as already-seen (changeCount + fingerprint).
        watcher.syncFingerprintsFromSystemClipboard()

        // Step 4 — hide the panel (begins focus restoration to the prior app).
        panel?.hide()

        // Step 5 — restore the target app, wait until it is truly frontmost.
        let target = resolveTargetApp()
        guard let target else {
            // Nothing to paste into; the pasteboard write still succeeded so the
            // user can paste manually, but report the failure for diagnostics.
            throw PastyxError.noTargetApp
        }

        // Give macOS a beat to begin restoring focus after orderOut (~40ms).
        spinRunLoop(seconds: 0.04)

        // Re-activate the target if it isn't already frontmost.
        if !isFrontmost(target) {
            target.activate(options: [])
        }

        // Poll until the target is actually frontmost (1500ms budget). Fixed
        // sleeps are flaky; a frontmost app is the precondition for the keystroke
        // landing in the right place.
        let frontOk = waitForFrontmost(target, timeoutMs: 1500)

        // Step 6 — synthesize Cmd+V via CGEventPost.
        let posted = postCommandV()

        if !posted {
            throw PastyxError.generic(
                pasteFailureDiagnostic(target: target, frontOk: frontOk)
            )
        }
    }

    /// Copy-only: write the payload to the system clipboard without pasting or
    /// hiding the panel. No Accessibility gate needed (no synthetic keystroke).
    public func copyToPasteboard(_ payload: PastePayload) {
        writePayloadToPasteboard(payload)
        // Mark it as already-seen so the watcher doesn't re-capture our own write.
        watcher.syncFingerprintsFromSystemClipboard()
    }

    // MARK: - Pasteboard writing

    /// Write {text, html, image} to NSPasteboard following the Electron priority:
    /// non-empty image -> {text, html, image}; else html -> {text|htmlToText, html};
    /// else plain text. (main.cjs:2988-2994)
    private func writePayloadToPasteboard(_ payload: PastePayload) {
        let pb = NSPasteboard.general
        pb.clearContents()

        // Resolve image bytes (MVP: local imageData only; remote imageURL ignored).
        var image: NSImage?
        if let data = payload.imageData, !data.isEmpty,
            let img = NSImage(data: data), img.isValid {
            image = img
        }

        if let image {
            // Image as TIFF (universal) so any app can consume it, plus PNG.
            if let tiff = image.tiffRepresentation {
                pb.setData(tiff, forType: .tiff)
            }
            if let png = pngData(from: image) {
                pb.setData(png, forType: .png)
            }
            if let text = payload.text, !text.isEmpty {
                pb.setString(text, forType: .string)
            }
            if let html = payload.html, !html.isEmpty {
                pb.setString(html, forType: .html)
            }
        } else if let html = payload.html, !html.isEmpty {
            let plain = (payload.text?.isEmpty == false) ? payload.text! : Self.htmlToText(html)
            pb.setString(html, forType: .html)
            pb.setString(plain, forType: .string)
        } else {
            pb.setString(payload.text ?? "", forType: .string)
        }
    }

    private func pngData(from image: NSImage) -> Data? {
        guard let tiff = image.tiffRepresentation,
            let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .png, properties: [:])
    }

    /// Mirror of htmlToText (main.cjs:1145): strip <style>/<script>/tags, collapse
    /// whitespace.
    static func htmlToText(_ html: String) -> String {
        var s = html
        let patterns = [
            "<style[\\s\\S]*?</style>",
            "<script[\\s\\S]*?</script>",
            "<[^>]+>"
        ]
        for p in patterns {
            s = s.replacingOccurrences(
                of: p, with: " ",
                options: [.regularExpression, .caseInsensitive]
            )
        }
        s = s.replacingOccurrences(
            of: "\\s+", with: " ", options: .regularExpression
        )
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Focus polling

    private func isFrontmost(_ app: NSRunningApplication) -> Bool {
        NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier
    }

    /// Poll (on the run loop) until `app` is frontmost or the budget elapses.
    /// Returns whether the target became frontmost.
    @discardableResult
    private func waitForFrontmost(_ app: NSRunningApplication, timeoutMs: Int) -> Bool {
        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
        while Date() < deadline {
            if isFrontmost(app) { return true }
            spinRunLoop(seconds: 0.025)
        }
        return isFrontmost(app)
    }

    /// Pump the main run loop for `seconds` without blocking AppKit (the panel is
    /// orderOut at this point but timers/animations should keep ticking).
    private func spinRunLoop(seconds: TimeInterval) {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(seconds))
    }

    // MARK: - CGEvent Cmd+V

    /// Synthesize Cmd+V: post key-down then key-up for 'v' with .maskCommand to
    /// the combined session event tap. Returns false if event creation failed.
    @discardableResult
    private func postCommandV() -> Bool {
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            return false
        }
        let vKey = CGKeyCode(kVK_ANSI_V)

        guard
            let keyDown = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: true),
            let keyUp = CGEvent(keyboardEventSource: source, virtualKey: vKey, keyDown: false)
        else {
            return false
        }

        keyDown.flags = .maskCommand
        keyUp.flags = .maskCommand

        let tap = CGEventTapLocation.cghidEventTap
        keyDown.post(tap: tap)
        keyUp.post(tap: tap)
        return true
    }

    // MARK: - Diagnostics

    private func pasteFailureDiagnostic(target: NSRunningApplication, frontOk: Bool) -> String {
        let name = target.localizedName ?? "(unknown)"
        let bundle = target.bundleIdentifier ?? "no bundle id"
        let front = NSWorkspace.shared.frontmostApplication
        let frontName = front?.localizedName ?? "(unknown)"
        let frontBundle = front?.bundleIdentifier ?? "no bundle id"
        return """
        paste failed to synthesize Cmd+V.

        Target app: \(name) (\(bundle))
        Frontmost before paste: \(frontName) (\(frontBundle))
        Frontmost matched target: \(frontOk ? "yes" : "no")

        If this keeps happening, enable Accessibility for paste in
        System Settings -> Privacy & Security -> Accessibility.
        """
    }
}
