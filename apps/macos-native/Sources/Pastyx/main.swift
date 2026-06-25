import AppKit

// Entry point for the Pastyx agent app.
// Single-instance guard + accessory (no Dock) activation policy live here / AppDelegate.

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
