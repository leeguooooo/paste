import AppKit
import SwiftUI

// Entry point for the Pastyx agent app.
// Single-instance guard + accessory (no Dock) activation policy live here / AppDelegate.

// Headless snapshot mode: `PASTYX_SNAPSHOT=/path/out.png` renders the island with
// mock data straight to a PNG via ImageRenderer and exits — no window, no global
// hotkey, no Accessibility permission. Used to verify UI changes offscreen.
if let snapshotPath = ProcessInfo.processInfo.environment["PASTYX_SNAPSHOT"], !snapshotPath.isEmpty {
    MainActor.assumeIsolated {
        renderIslandSnapshot(to: snapshotPath)
    }
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()

@MainActor
private func renderIslandSnapshot(to path: String) {
    let snapApp = NSApplication.shared
    snapApp.setActivationPolicy(.accessory)
    let now = Int64(Date().timeIntervalSince1970 * 1000)
    let vm = IslandViewModel()
    vm.disableEntrance = true
    vm.selectedIndex = 0
    let snapView = ProcessInfo.processInfo.environment["PASTYX_SNAPSHOT_VIEW"]
    vm.justCopied = snapView == "copied"
    let showSettings = snapView == "settings" || snapView == "settings_loggedout"
    vm.showingSettings = showSettings
    if snapView == "settings" {
        vm.authStatus = AuthStatus(
            remoteEnabled: true, authenticated: true, authConfigured: true,
            user: AuthUser(userId: "u_1", email: "leeguooooo@gmail.com", name: "郭立")
        )
    } else if snapView == "settings_loggedout" {
        vm.authStatus = AuthStatus(remoteEnabled: true, authenticated: false, authConfigured: true, user: nil)
    }
    vm.clips = [
        ClipItem(deviceId: "mac_studio", type: .text,
                 content: "rm -rf /Users/leo/clawd/skills/xhs-skill", createdAt: now - 9_000),
        ClipItem(deviceId: "web_chrome", type: .link,
                 content: "https://account.leeguoo.com/login",
                 sourceURL: "https://account.leeguoo.com/login", createdAt: now - 60_000),
        ClipItem(deviceId: "mac_studio", type: .code,
                 content: "func boil() -> some View {\n  Rectangle().fill(.coral)\n}", createdAt: now - 320_000),
        ClipItem(deviceId: "iphone", type: .text,
                 content: "记得买牛奶、鸡蛋和咖啡豆", isFavorite: true, createdAt: now - 3_600_000),
        ClipItem(deviceId: "web_safari", type: .link,
                 content: "https://github.com/leeguooooo/paste",
                 sourceURL: "https://github.com/leeguooooo/paste", createdAt: now - 7_200_000)
    ]
    if snapView == "selection", vm.clips.count >= 3 {
        vm.selection = Set([vm.clips[0].id, vm.clips[2].id])
    }

    // Render the real AppKit-hosted view tree (glass, ScrollView, the NSTextField
    // search bridge) in an off-screen window, spin the run loop so SwiftUI lays
    // out + draws, then snapshot the layer. ImageRenderer can't do glass/scroll.
    let size = NSSize(width: 1320, height: showSettings ? 600 : 440)
    let host = NSHostingView(rootView: IslandView(viewModel: vm))
    host.frame = NSRect(origin: .zero, size: size)

    let window = NSWindow(
        contentRect: NSRect(origin: .zero, size: size),
        styleMask: [.borderless], backing: .buffered, defer: false
    )
    window.backgroundColor = NSColor(white: 0.06, alpha: 1) // dark backdrop for glass
    window.contentView = host
    window.setFrameOrigin(NSPoint(x: -6000, y: 200)) // off-screen, no flash
    window.orderFrontRegardless()

    // Let SwiftUI complete onAppear + layout + draw.
    RunLoop.main.run(until: Date().addingTimeInterval(0.8))
    host.layoutSubtreeIfNeeded()

    guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
        FileHandle.standardError.write(Data("snapshot: no bitmap rep\n".utf8))
        return
    }
    host.cacheDisplay(in: host.bounds, to: rep)
    guard let png = rep.representation(using: .png, properties: [:]) else {
        FileHandle.standardError.write(Data("snapshot: png encode failed\n".utf8))
        return
    }
    do {
        try png.write(to: URL(fileURLWithPath: path))
        FileHandle.standardOutput.write(Data("snapshot written: \(path)\n".utf8))
    } catch {
        FileHandle.standardError.write(Data("snapshot: write failed \(error)\n".utf8))
    }
}
