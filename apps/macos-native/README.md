# paste (native)

Native macOS rewrite of the paste clipboard manager. Replaces the Electron app
in `../macos` with a SwiftUI + AppKit agent app built on SwiftPM, with zero
external package dependencies (system SQLite3 via `import SQLite3`).

- Target: macOS 26 (Tahoe), Swift 6 tools.
- Agent app: `LSUIElement = true`, `NSApp.setActivationPolicy(.accessory)` (no Dock icon).
- Window: non-activating `NSPanel` that becomes key WITHOUT activating the app —
  this makes the Electron "clicks/keys swallowed" bug impossible by construction.

## Status

**Working MVP.** All core modules are fully implemented and wired in `AppDelegate`:
NSPanel overlay, Liquid Glass island UI, NSPasteboard watcher, raw-SQLite3 history
store, CGEvent paste injection, Carbon global hotkey, and the menu-bar status item.
`swift build` is green and `scripts/make-app.sh` produces a launchable `paste.app`.

**Deferred (still in the Electron app, not yet ported):** iCloud / local sync,
SSO auth + remote API sync, auto-update (Sparkle), and fetching remote image clips
for paste. These are the next migration step.

## Build & run

```bash
# From this directory:
swift build                 # debug build (must stay green)
swift run                   # run the executable directly (dev)

# Assemble a proper agent .app with Info.plist:
scripts/make-app.sh         # release build -> .build/release/paste.app
open .build/release/paste.app
```

`make-app.sh` builds with SwiftPM and assembles `paste.app` with an `Info.plist`
(`LSUIElement=true`, `NSAppleEventsUsageDescription`, accessibility usage strings,
bundle id `com.paste.native`, app name "paste"), then ad-hoc signs it.

The app has no Dock icon — after launch, look for the menu-bar status item.
The paste flow requires **Accessibility** permission (System Settings > Privacy &
Security > Accessibility); the app prompts on first paste.

## Layout

```
Package.swift                       executable target "Pastyx"
Sources/Pastyx/
  main.swift                        entry point (NSApplication + AppDelegate)
  AppDelegate.swift                 agent bootstrap; wires all subsystems
  Models/
    ClipItem.swift                  ClipItem, ClipType, ClipQuery, PastePayload
    AppConfig.swift                 AppConfig, Retention (defaults = ground truth)
  Protocols/
    Protocols.swift                 the CONTRACT: ClipStore, ClipboardWatcher,
                                    PasteService, HotKeyManager, PanelControlling,
                                    StatusItemControlling, ConfigStore, PastyxError
  Modules/
    Config.swift                    JSONConfigStore : ConfigStore
    HistoryStore.swift              HistoryStore : ClipStore  (raw SQLite3)
    ClipboardWatcher.swift          PasteboardWatcher : ClipboardWatcher, ClipFactory
    Paste.swift                     CGEventPasteService : PasteService
    Hotkey.swift                    CarbonHotKeyManager : HotKeyManager
    PanelController.swift           PanelController : PanelControlling (NSPanel)
    StatusItem.swift                StatusItemController : StatusItemControlling
    IslandView.swift                IslandView, SettingsView, IslandViewModel
scripts/make-app.sh                 build + bundle paste.app
```

## For module implementers

Conform to the protocols in `Protocols/Protocols.swift` and the model types in
`Models/`. Keep `swift build` green at every step. Concrete stub classes are
already wired into `AppDelegate`, so replacing a stub's bodies in place keeps the
app launchable. Most AppKit-touching protocols are `@MainActor`-isolated.
