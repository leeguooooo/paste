import Carbon.HIToolbox
import Foundation

/// Carbon `RegisterEventHotKey` wrapper. Default Cmd+Shift+V toggles the panel.
///
/// Parses the Electron accelerator string ("CommandOrControl+Shift+V") into a
/// Carbon virtual keycode + modifier mask, registers a process-wide hotkey, and
/// installs a single Carbon event handler that fires `onTrigger`. On conflict
/// (the hotkey is already owned by another app) it walks a small list of fallback
/// candidates and returns the accelerator that actually registered, so the caller
/// can write it back to config (mirrors registerGlobalShortcut, main.cjs:~2475).
@MainActor
public final class CarbonHotKeyManager: HotKeyManager {
    public var onTrigger: (() -> Void)?

    private var hotKeyRef: EventHotKeyRef?
    private var eventHandlerRef: EventHandlerRef?
    private var registeredAccelerator: String?

    /// Stable id so the Carbon handler can match our hotkey events.
    private static let hotKeyID = EventHotKeyID(
        signature: OSType(0x50535458), // 'PSTX'
        id: 1
    )

    public init() {}

    @discardableResult
    public func register(_ accelerator: String) throws -> String {
        // Re-register: tear down any existing registration first.
        unregister()

        installHandlerIfNeeded()

        // Build the candidate list: the requested accelerator first, then a few
        // fallbacks so a taken hotkey doesn't leave the user with nothing.
        var candidates: [String] = [accelerator]
        for fallback in Self.fallbackCandidates where !candidates.contains(fallback) {
            candidates.append(fallback)
        }

        var lastError: OSStatus = noErr
        for candidate in candidates {
            guard let parsed = Self.parse(candidate) else { continue }
            var ref: EventHotKeyRef?
            let status = RegisterEventHotKey(
                parsed.keyCode,
                parsed.modifiers,
                Self.hotKeyID,
                GetEventDispatcherTarget(),
                0,
                &ref
            )
            if status == noErr, let ref {
                hotKeyRef = ref
                registeredAccelerator = candidate
                return candidate
            }
            lastError = status
        }

        throw PastyxError.generic(
            "could not register global hotkey '\(accelerator)' (it may be in use by another app); Carbon error \(lastError)"
        )
    }

    public func unregister() {
        if let ref = hotKeyRef {
            UnregisterEventHotKey(ref)
            hotKeyRef = nil
        }
        registeredAccelerator = nil
    }

    // MARK: - Carbon event handler

    private func installHandlerIfNeeded() {
        guard eventHandlerRef == nil else { return }

        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )

        // Pass an unretained pointer to self; the manager outlives the handler
        // (it lives on the AppDelegate for the app's lifetime).
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()

        let callback: EventHandlerUPP = { _, eventRef, userData in
            guard let eventRef, let userData else { return noErr }
            var firedID = EventHotKeyID()
            let status = GetEventParameter(
                eventRef,
                EventParamName(kEventParamDirectObject),
                EventParamType(typeEventHotKeyID),
                nil,
                MemoryLayout<EventHotKeyID>.size,
                nil,
                &firedID
            )
            guard status == noErr,
                  firedID.signature == CarbonHotKeyManager.hotKeyID.signature,
                  firedID.id == CarbonHotKeyManager.hotKeyID.id
            else { return noErr }

            let manager = Unmanaged<CarbonHotKeyManager>.fromOpaque(userData).takeUnretainedValue()
            // Carbon delivers the event on the main thread; hop onto the main
            // actor explicitly to satisfy Swift 6 isolation.
            Task { @MainActor in
                manager.onTrigger?()
            }
            return noErr
        }

        InstallEventHandler(
            GetEventDispatcherTarget(),
            callback,
            1,
            &eventType,
            selfPtr,
            &eventHandlerRef
        )
    }

    // No deinit cleanup: the manager is owned by the AppDelegate for the whole
    // app lifetime, and `unregister()` (called on every re-register / shutdown)
    // releases the Carbon refs. A nonisolated deinit cannot touch these
    // MainActor-isolated, non-Sendable OpaquePointer refs under Swift 6.

    // MARK: - Accelerator parsing

    struct Parsed {
        var keyCode: UInt32
        var modifiers: UInt32
    }

    /// Fallback hotkeys tried (in order) when the requested one is taken.
    private static let fallbackCandidates = [
        "CommandOrControl+Shift+V",
        "Command+Shift+V",
        "Command+Option+V",
        "Control+Shift+V"
    ]

    /// Parse an Electron-style accelerator ("CommandOrControl+Shift+V") into a
    /// Carbon keycode + modifier mask. Returns nil if the key token is unknown.
    static func parse(_ accelerator: String) -> Parsed? {
        let tokens = accelerator
            .split(separator: "+")
            .map { $0.trimmingCharacters(in: .whitespaces) }
        guard !tokens.isEmpty else { return nil }

        var modifiers: UInt32 = 0
        var keyToken: String?

        for token in tokens {
            switch token.lowercased() {
            case "command", "cmd", "commandorcontrol", "cmdorctrl", "super", "meta":
                modifiers |= UInt32(cmdKey)
            case "control", "ctrl":
                modifiers |= UInt32(controlKey)
            case "shift":
                modifiers |= UInt32(shiftKey)
            case "alt", "option", "opt":
                modifiers |= UInt32(optionKey)
            default:
                keyToken = token
            }
        }

        guard let keyToken, let keyCode = keyCode(for: keyToken) else { return nil }
        return Parsed(keyCode: keyCode, modifiers: modifiers)
    }

    /// Map a key name to its Carbon virtual keycode. Covers letters, digits, and
    /// the keys an accelerator realistically uses.
    static func keyCode(for token: String) -> UInt32? {
        let key = token.uppercased()
        let letters: [String: Int] = [
            "A": kVK_ANSI_A, "B": kVK_ANSI_B, "C": kVK_ANSI_C, "D": kVK_ANSI_D,
            "E": kVK_ANSI_E, "F": kVK_ANSI_F, "G": kVK_ANSI_G, "H": kVK_ANSI_H,
            "I": kVK_ANSI_I, "J": kVK_ANSI_J, "K": kVK_ANSI_K, "L": kVK_ANSI_L,
            "M": kVK_ANSI_M, "N": kVK_ANSI_N, "O": kVK_ANSI_O, "P": kVK_ANSI_P,
            "Q": kVK_ANSI_Q, "R": kVK_ANSI_R, "S": kVK_ANSI_S, "T": kVK_ANSI_T,
            "U": kVK_ANSI_U, "V": kVK_ANSI_V, "W": kVK_ANSI_W, "X": kVK_ANSI_X,
            "Y": kVK_ANSI_Y, "Z": kVK_ANSI_Z,
            "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3,
            "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7,
            "8": kVK_ANSI_8, "9": kVK_ANSI_9,
            "SPACE": kVK_Space, "RETURN": kVK_Return, "ENTER": kVK_Return,
            "TAB": kVK_Tab, "ESCAPE": kVK_Escape, "ESC": kVK_Escape,
            "-": kVK_ANSI_Minus, "=": kVK_ANSI_Equal,
            "[": kVK_ANSI_LeftBracket, "]": kVK_ANSI_RightBracket,
            ";": kVK_ANSI_Semicolon, "'": kVK_ANSI_Quote,
            ",": kVK_ANSI_Comma, ".": kVK_ANSI_Period, "/": kVK_ANSI_Slash,
            "`": kVK_ANSI_Grave, "\\": kVK_ANSI_Backslash
        ]
        guard let code = letters[key] else { return nil }
        return UInt32(code)
    }
}

/// Render an Electron-style accelerator as the symbolic mac form (⌘⇧V) for menus.
enum AcceleratorFormatter {
    static func symbolic(_ accelerator: String) -> String {
        let tokens = accelerator
            .split(separator: "+")
            .map { $0.trimmingCharacters(in: .whitespaces) }
        var out = ""
        var key = ""
        for token in tokens {
            switch token.lowercased() {
            case "command", "cmd", "commandorcontrol", "cmdorctrl", "super", "meta":
                out += "\u{2318}" // ⌘
            case "control", "ctrl":
                out += "\u{2303}" // ⌃
            case "shift":
                out += "\u{21E7}" // ⇧
            case "alt", "option", "opt":
                out += "\u{2325}" // ⌥
            default:
                key = token.uppercased()
            }
        }
        return out + key
    }
}
