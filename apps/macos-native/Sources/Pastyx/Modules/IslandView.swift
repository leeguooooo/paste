import SwiftUI
import AppKit

// MARK: - View Model

/// Observable state backing the SwiftUI island. The PanelController fires
/// onShown/onHidden into this; the watcher's clipsChanged refreshes `clips`.
///
/// This is the binding surface between the AppKit subsystems (panel, watcher,
/// store, paste, hotkey) and the SwiftUI island. AppDelegate wires the
/// callbacks; the SwiftUI views only ever talk to this object.
@MainActor
public final class IslandViewModel: ObservableObject {
    @Published public var clips: [ClipItem] = []
    @Published public var query: String = ""
    @Published public var favoritesOnly: Bool = false
    @Published public var selectedIndex: Int = 0
    @Published public var showingSettings: Bool = false
    @Published public var config: AppConfig = AppConfig()

    /// iCloud sync surface (icloud:status). Drives any UI/menu sync indicator.
    @Published public var syncStatus: SyncStatus = SyncStatus()
    /// Auth surface (auth:status). Reflects SSO sign-in state.
    @Published public var authStatus: AuthStatus = AuthStatus(
        remoteEnabled: false, authenticated: false, authConfigured: false, user: nil
    )

    /// Bumped on every reveal so the SwiftUI side can replay the entrance
    /// animation and re-focus the search field deterministically.
    @Published public var revealToken: Int = 0

    /// Wired by AppDelegate.
    public var onPaste: ((ClipItem, _ plainText: Bool) -> Void)?
    public var onDelete: ((ClipItem) -> Void)?
    public var onToggleFavorite: ((ClipItem) -> Void)?
    public var onRefresh: (() -> Void)?
    public var onSaveConfig: ((AppConfig) -> Void)?
    public var onHide: (() -> Void)?

    public init() {}

    /// Called on window show: reset selection / refresh list / replay entrance.
    public func windowDidShow() {
        if query.isEmpty && !showingSettings { selectedIndex = 0 }
        revealToken &+= 1
        onRefresh?()
    }

    /// Called on window hide: exit settings.
    public func windowDidHide() {
        showingSettings = false
    }

    // MARK: Intent (called from the SwiftUI layer)

    /// Clamp the selection into the current clip range.
    func clampSelection() {
        guard !clips.isEmpty else { selectedIndex = 0; return }
        selectedIndex = min(max(0, selectedIndex), clips.count - 1)
    }

    func moveSelection(by delta: Int) {
        guard !clips.isEmpty else { return }
        selectedIndex = min(max(0, selectedIndex + delta), clips.count - 1)
    }

    /// Paste the clip at `index` (quick-paste via Cmd+1..9 and clicks).
    func paste(at index: Int, plainText: Bool) {
        guard clips.indices.contains(index) else { return }
        selectedIndex = index
        onPaste?(clips[index], plainText)
    }

    func pasteSelected(plainText: Bool) {
        paste(at: selectedIndex, plainText: plainText)
    }

    func deleteSelected() {
        guard clips.indices.contains(selectedIndex) else { return }
        onDelete?(clips[selectedIndex])
    }

    func toggleFavorite(_ clip: ClipItem) {
        onToggleFavorite?(clip)
    }

    /// Esc: clear query if any, else hide the window.
    func handleEscape() {
        if !query.isEmpty {
            query = ""
            requestRefresh()
        } else {
            onHide?()
        }
    }

    func requestRefresh() {
        onRefresh?()
    }
}

// MARK: - Color helpers

private extension Color {
    /// Parse a `#rrggbb` hex string. Falls back to gray.
    init(hex: String) {
        let s = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        var value: UInt64 = 0
        Scanner(string: s).scanHexInt64(&value)
        let r = Double((value >> 16) & 0xff) / 255.0
        let g = Double((value >> 8) & 0xff) / 255.0
        let b = Double(value & 0xff) / 255.0
        self = Color(.sRGB, red: r, green: g, blue: b, opacity: 1)
    }
}

private extension ClipType {
    var accent: Color { Color(hex: accentHex) }

    var displayLabel: String {
        switch self {
        case .text:  return "TEXT"
        case .link:  return "LINK"
        case .code:  return "CODE"
        case .html:  return "HTML"
        case .image: return "IMAGE"
        }
    }
}

// MARK: - Clip presentation helpers

enum ClipPresentation {
    /// Relative age: "9s/5m/3h/2d" (formatAgeShort, App.tsx:122).
    static func ageShort(_ createdAtMs: Int64) -> String {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let delta = max(0, now - createdAtMs)
        if delta < 60_000 { return "\(max(1, delta / 1000))s" }
        if delta < 3_600_000 { return "\(delta / 60_000)m" }
        if delta < 86_400_000 { return "\(delta / 3_600_000)h" }
        return "\(delta / 86_400_000)d"
    }

    /// Strip tags to plain text (htmlToText, App.tsx:77).
    static func htmlToText(_ html: String?) -> String {
        guard let html, !html.isEmpty else { return "" }
        var s = html
        for pattern in [#"<style[\s\S]*?</style>"#, #"<script[\s\S]*?</script>"#, #"<[^>]+>"#] {
            if let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) {
                let range = NSRange(s.startIndex..., in: s)
                s = re.stringByReplacingMatches(in: s, options: [], range: range, withTemplate: " ")
            }
        }
        return s.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Preview text for a non-image card: html->text, else content/summary/sourceURL
    /// clamped to 300 chars (App.tsx:1211).
    static func previewText(_ clip: ClipItem) -> String {
        let fromHTML = htmlToText(clip.contentHTML)
        let raw = !fromHTML.isEmpty ? fromHTML
            : (clip.summary?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 }
                ?? (clip.sourceURL?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 }
                ?? (clip.content?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "")
        return String(raw.prefix(300))
    }

    /// Decode the inline preview JPEG data URL into an NSImage.
    static func previewImage(_ clip: ClipItem) -> NSImage? {
        guard let dataURL = clip.imagePreviewDataURL, dataURL.hasPrefix("data:image/") else { return nil }
        guard let comma = dataURL.firstIndex(of: ","),
              let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...]),
                              options: .ignoreUnknownCharacters)
        else { return nil }
        return NSImage(data: data)
    }

    /// Device badge derivation (App.tsx:1182).
    static func deviceMeta(_ deviceId: String) -> (symbol: String, label: String) {
        let raw = deviceId.trimmingCharacters(in: .whitespaces)
        let lower = raw.lowercased()
        if lower.contains("web") || lower.contains("browser") { return ("globe", "WEB") }
        if lower.contains("mac") { return ("display", "MAC") }
        if lower.contains("ios") || lower.contains("iphone") || lower.contains("ipad") { return ("iphone", "IOS") }
        if lower.contains("android") { return ("iphone", "ANDROID") }
        if !raw.isEmpty {
            let cleaned = raw.replacingOccurrences(of: #"[_-]+"#, with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespaces)
            let short = cleaned.count > 14 ? String(cleaned.prefix(14)) + "..." : cleaned
            return ("cpu", short.uppercased())
        }
        return ("cpu", "DEVICE")
    }
}

// MARK: - Island root

/// SwiftUI Liquid Glass island: GlassEffectContainer, search field, horizontal
/// clip card scroller, type-colored pills, selection/hover/keyboard nav
/// (arrows, Enter, Shift+Enter plain, Cmd+1..9, Backspace delete, Esc, Cmd+,),
/// entrance animation on reveal.
public struct IslandView: View {
    @ObservedObject var viewModel: IslandViewModel

    public init(viewModel: IslandViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        GlassEffectContainer(spacing: 18) {
            ZStack {
                if viewModel.showingSettings {
                    SettingsView(viewModel: viewModel)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                } else {
                    HistoryShelf(viewModel: viewModel)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .animation(.spring(response: 0.32, dampingFraction: 0.86), value: viewModel.showingSettings)
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Guaranteed dark substrate. Liquid Glass follows whatever is behind the
        // panel, so over a light backdrop the white text becomes unreadable. A
        // solid dark scrim under the whole island keeps contrast constant on any
        // background; the glass on the search pill + cards still reads on top.
        //
        // Full-bleed bottom shelf: only the TOP corners are rounded — the left,
        // right, and bottom edges sit flush against the screen, so rounding them
        // would just leak the backdrop through the gaps.
        .background {
            UnevenRoundedRectangle(
                topLeadingRadius: 22, bottomLeadingRadius: 0,
                bottomTrailingRadius: 0, topTrailingRadius: 22, style: .continuous
            )
            .fill(Color(.sRGB, red: 18/255, green: 18/255, blue: 22/255, opacity: 0.86))
            .overlay(
                UnevenRoundedRectangle(
                    topLeadingRadius: 22, bottomLeadingRadius: 0,
                    bottomTrailingRadius: 0, topTrailingRadius: 22, style: .continuous
                )
                .strokeBorder(.white.opacity(0.12), lineWidth: 1)
            )
        }
        .ignoresSafeArea()
        // Top specular band across the island (App.tsx .app-shell::before).
        .overlay(alignment: .top) {
            LinearGradient(
                colors: [Color.white.opacity(0.12), Color.white.opacity(0)],
                startPoint: .top, endPoint: .bottom
            )
            .frame(height: 84)
            .allowsHitTesting(false)
        }
        // Hidden keyboard command sinks (Cmd+1..9, Cmd+,) handled at root.
        .background(KeyboardCommandSink(viewModel: viewModel))
    }
}

// MARK: - History shelf (search + card scroller)

private struct HistoryShelf: View {
    @ObservedObject var viewModel: IslandViewModel
    @FocusState private var searchFocused: Bool
    @State private var entered = false

    var body: some View {
        VStack(spacing: 12) {
            toolbar
            cardScroller
        }
        .offset(y: entered ? 0 : 24)
        .opacity(entered ? 1 : 0)
        .onAppear {
            entered = false
            withAnimation(.timingCurve(0.21, 1.02, 0.55, 1, duration: 0.22)) { entered = true }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.02) { searchFocused = true }
        }
        // Replay entrance + refocus on every reveal.
        .onChange(of: viewModel.revealToken) { _, _ in
            entered = false
            withAnimation(.timingCurve(0.21, 1.02, 0.55, 1, duration: 0.22)) { entered = true }
            searchFocused = true
        }
    }

    private var toolbar: some View {
        HStack(spacing: 10) {
            // Search field pill.
            HStack(spacing: 10) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.55))
                SearchField(text: $viewModel.query, focused: $searchFocused) {
                    viewModel.requestRefresh()
                } onArrow: { delta in
                    viewModel.moveSelection(by: delta)
                } onEnter: { plain in
                    viewModel.pasteSelected(plainText: plain)
                } onEscape: {
                    viewModel.handleEscape()
                }
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 11)
            .frame(maxWidth: .infinity)
            .glassEffect(.regular, in: .rect(cornerRadius: 16))
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .strokeBorder(.white.opacity(0.18), lineWidth: 1)
            )

            // Favorites-only toggle.
            ToolbarIconButton(
                systemName: "star.fill",
                active: viewModel.favoritesOnly,
                accent: Color(hex: "#ffcc00")
            ) {
                viewModel.favoritesOnly.toggle()
                viewModel.requestRefresh()
            }

            // Settings gear.
            ToolbarIconButton(systemName: "gearshape.fill", active: false, accent: .accentColor) {
                withAnimation { viewModel.showingSettings = true }
            }
        }
    }

    @ViewBuilder
    private var cardScroller: some View {
        if viewModel.clips.isEmpty {
            emptyState
        } else {
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 20) {
                        ForEach(Array(viewModel.clips.enumerated()), id: \.element.id) { index, clip in
                            ClipCard(
                                clip: clip,
                                selected: index == viewModel.selectedIndex,
                                onHover: { viewModel.selectedIndex = index },
                                onTap: { viewModel.paste(at: index, plainText: false) },
                                onToggleFavorite: { viewModel.toggleFavorite(clip) }
                            )
                            .id(index)
                        }
                    }
                    .padding(.horizontal, 6)
                    .padding(.vertical, 8)
                    .frame(maxHeight: .infinity, alignment: .center)
                }
                .onChange(of: viewModel.selectedIndex) { _, newValue in
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(newValue, anchor: .center)
                    }
                }
                .onChange(of: viewModel.revealToken) { _, _ in
                    proxy.scrollTo(viewModel.selectedIndex, anchor: .center)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            // Soft-fade the leading/trailing edges so cards entering/leaving the
            // viewport dissolve instead of being hard-clipped at the screen edge.
            .mask(
                HStack(spacing: 0) {
                    LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing)
                        .frame(width: 28)
                    Rectangle().fill(.black)
                    LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing)
                        .frame(width: 28)
                }
            )
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: viewModel.favoritesOnly ? "star" : "doc.on.clipboard")
                .font(.system(size: 30, weight: .light))
                .foregroundStyle(.white.opacity(0.35))
            Text(viewModel.favoritesOnly ? "No favorites yet"
                 : (viewModel.query.isEmpty ? "Copy something to get started"
                    : "No clips match \u{201C}\(viewModel.query)\u{201D}"))
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.white.opacity(0.5))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Clip card

private struct ClipCard: View {
    let clip: ClipItem
    let selected: Bool
    let onHover: () -> Void
    let onTap: () -> Void
    let onToggleFavorite: () -> Void

    private var accent: Color { clip.type.accent }

    var body: some View {
        VStack(spacing: 0) {
            head
            preview
            footer
        }
        .frame(width: 280, height: 244)
        .background {
            // Dark glass slab; native Liquid Glass tinted toward the card bg.
            RoundedRectangle(cornerRadius: 16)
                .fill(Color(.sRGB, red: 38/255, green: 38/255, blue: 46/255, opacity: 0.92))
        }
        // Diagonal specular gloss (.clip-card::after).
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .fill(
                    LinearGradient(
                        stops: [
                            .init(color: .white.opacity(0.10), location: 0),
                            .init(color: .white.opacity(0.02), location: 0.38),
                            .init(color: .clear, location: 0.60)
                        ],
                        startPoint: .topTrailing, endPoint: .bottomLeading
                    )
                )
                .allowsHitTesting(false)
        }
        // Hairline border tinted to the accent when selected.
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .strokeBorder(
                    selected ? accent.opacity(0.6) : .white.opacity(0.22),
                    lineWidth: selected ? 1 : 0.5
                )
        }
        // Accent wash when selected.
        .overlay {
            if selected {
                RoundedRectangle(cornerRadius: 16)
                    .fill(accent.opacity(0.09))
                    .allowsHitTesting(false)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .shadow(color: .black.opacity(0.28), radius: 12, x: 0, y: 8)
        .offset(y: selected ? -4 : 0)
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: selected)
        .contentShape(RoundedRectangle(cornerRadius: 16))
        .onTapGesture(perform: onTap)
        .onHover { hovering in if hovering { onHover() } }
        .zIndex(selected ? 10 : 0)
    }

    private var head: some View {
        HStack {
            HStack(spacing: 8) {
                Text(clip.type.displayLabel)
                    .font(.system(size: 10, weight: .heavy))
                    .tracking(0.5)
                    .foregroundStyle(accent)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(accent.opacity(0.16), in: RoundedRectangle(cornerRadius: 6))
                Text(ClipPresentation.ageShort(clip.createdAt))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.55))
            }
            Spacer(minLength: 4)
            Button(action: onToggleFavorite) {
                Image(systemName: clip.isFavorite ? "star.fill" : "star")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(clip.isFavorite ? Color(hex: "#ffcc00") : .white.opacity(0.55))
                    .frame(width: 28, height: 28)
                    .background(.white.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 14)
        .frame(height: 44)
    }

    @ViewBuilder
    private var preview: some View {
        Group {
            if let image = ClipPresentation.previewImage(clip) {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else {
                Text(ClipPresentation.previewText(clip))
                    .font(.system(size: 14))
                    .lineSpacing(3)
                    .foregroundStyle(.white)
                    .lineLimit(6)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 18)
        .padding(.vertical, 16)
        .clipped()
    }

    private var footer: some View {
        let device = ClipPresentation.deviceMeta(clip.deviceId)
        return HStack {
            HStack(spacing: 6) {
                Image(systemName: device.symbol)
                    .font(.system(size: 11))
                Text(device.label)
                    .font(.system(size: 11, weight: .semibold))
            }
            .foregroundStyle(.white.opacity(0.55))
            Spacer()
            if selected {
                Text("ENTER")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(accent)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            } else {
                Text("Click to paste")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.45))
            }
        }
        .padding(.horizontal, 16)
        .frame(height: 38)
        .background(.white.opacity(0.02))
        .overlay(alignment: .top) {
            Rectangle().fill(.white.opacity(0.1)).frame(height: 0.5)
        }
        .animation(.easeOut(duration: 0.25), value: selected)
    }
}

// MARK: - Toolbar icon button

private struct ToolbarIconButton: View {
    let systemName: String
    let active: Bool
    let accent: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(active ? accent : .white.opacity(0.8))
                .frame(width: 40, height: 40)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(active ? accent.opacity(0.4) : .white.opacity(0.1), lineWidth: 0.5)
        )
    }
}

// MARK: - Search field (NSTextField bridge for key handling)

/// A focusable text field that forwards arrow / Enter / Esc keys to the island
/// while keeping printable typing in the field. Using AppKit directly lets us
/// intercept the navigation keys before SwiftUI consumes them.
private struct SearchField: NSViewRepresentable {
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    var onChange: () -> Void
    var onArrow: (_ delta: Int) -> Void
    var onEnter: (_ plain: Bool) -> Void
    var onEscape: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSTextField {
        let field = NavTextField()
        field.delegate = context.coordinator
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = .systemFont(ofSize: 16, weight: .medium)
        field.textColor = .white
        field.placeholderAttributedString = NSAttributedString(
            string: "Type to search history...",
            attributes: [
                .foregroundColor: NSColor.white.withAlphaComponent(0.55),
                .font: NSFont.systemFont(ofSize: 16, weight: .medium)
            ]
        )
        field.cell?.usesSingleLineMode = true
        field.cell?.wraps = false
        field.cell?.isScrollable = true
        field.onArrow = onArrow
        field.onEnter = onEnter
        field.onEscape = onEscape
        return field
    }

    func updateNSView(_ field: NSTextField, context: Context) {
        if field.stringValue != text { field.stringValue = text }
        if let nav = field as? NavTextField {
            nav.onArrow = onArrow
            nav.onEnter = onEnter
            nav.onEscape = onEscape
        }
        if focused.wrappedValue, field.window?.firstResponder !== field.currentEditor() {
            DispatchQueue.main.async {
                field.window?.makeFirstResponder(field)
            }
        }
    }

    final class Coordinator: NSObject, NSTextFieldDelegate {
        let parent: SearchField
        init(_ parent: SearchField) { self.parent = parent }

        func controlTextDidChange(_ obj: Notification) {
            guard let field = obj.object as? NSTextField else { return }
            parent.text = field.stringValue
            parent.onChange()
        }
    }
}

/// NSTextField that intercepts arrow/Enter/Esc keys so the island can navigate
/// while the field still owns printable input.
private final class NavTextField: NSTextField {
    var onArrow: ((Int) -> Void)?
    var onEnter: ((Bool) -> Void)?
    var onEscape: (() -> Void)?

    override func keyDown(with event: NSEvent) {
        let plain = event.modifierFlags.contains(.shift)
        switch event.keyCode {
        case 123: onArrow?(-1); return          // left
        case 124: onArrow?(1); return           // right
        case 36, 76: onEnter?(plain); return    // return / enter
        case 53: onEscape?(); return            // esc
        default: break
        }
        super.keyDown(with: event)
    }
}

// MARK: - Root keyboard command sink (Cmd+1..9, Cmd+, , Backspace)

/// Captures app-level commands that aren't tied to the search field's editor:
/// Cmd+1..9 quick-paste, Cmd+, settings, and Backspace/Delete (when not typing).
private struct KeyboardCommandSink: NSViewRepresentable {
    @ObservedObject var viewModel: IslandViewModel

    func makeNSView(context: Context) -> NSView {
        let view = CommandSinkView()
        view.viewModel = viewModel
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        (nsView as? CommandSinkView)?.viewModel = viewModel
    }

    final class CommandSinkView: NSView {
        weak var viewModel: IslandViewModel?

        /// Holds the local event monitor in a way that is safe to release from a
        /// nonisolated deinit (the monitor token itself is `Any`, which is
        /// non-Sendable, so we wrap it in a final class we can hand off).
        private final class MonitorBox: @unchecked Sendable {
            var token: Any?
            func remove() {
                if let t = token { NSEvent.removeMonitor(t) }
                token = nil
            }
        }
        private let monitorBox = MonitorBox()

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if window != nil, monitorBox.token == nil {
                monitorBox.token = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                    self?.handle(event) == true ? nil : event
                }
            } else if window == nil {
                monitorBox.remove()
            }
        }

        deinit { monitorBox.remove() }

        private func handle(_ event: NSEvent) -> Bool {
            guard let vm = viewModel, !vm.showingSettings else { return false }
            let cmd = event.modifierFlags.contains(.command)

            // Cmd+, -> settings.
            if cmd, event.charactersIgnoringModifiers == "," {
                DispatchQueue.main.async { withAnimation { vm.showingSettings = true } }
                return true
            }
            // Cmd+1..9 -> quick paste the Nth visible card.
            if cmd, let ch = event.charactersIgnoringModifiers, ch.count == 1,
               let digit = Int(ch), (1...9).contains(digit) {
                DispatchQueue.main.async { vm.paste(at: digit - 1, plainText: event.modifierFlags.contains(.shift)) }
                return true
            }
            return false
        }
    }
}

// MARK: - Settings view

/// In-island settings (MVP: System tab — hotkey, launch-at-login, auto-capture,
/// retention). Cloud/Account tabs are deferred / out of scope.
public struct SettingsView: View {
    @ObservedObject var viewModel: IslandViewModel
    @State private var draft: AppConfig
    @State private var entered = false

    public init(viewModel: IslandViewModel) {
        self.viewModel = viewModel
        _draft = State(initialValue: viewModel.config)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    systemSection
                }
            }
            .scrollIndicators(.hidden)
            actions
        }
        .foregroundStyle(.white)
        .offset(y: entered ? 0 : 16)
        .opacity(entered ? 1 : 0)
        .onAppear {
            draft = viewModel.config
            withAnimation(.timingCurve(0.21, 1.02, 0.55, 1, duration: 0.18)) { entered = true }
        }
    }

    private var header: some View {
        HStack {
            Text("Settings")
                .font(.system(size: 17, weight: .heavy))
            Spacer()
            // Single MVP tab.
            Text("System")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(Color.accentColor)
                .padding(.horizontal, 14).padding(.vertical, 8)
                .background(Color.accentColor.opacity(0.16), in: RoundedRectangle(cornerRadius: 9))
        }
    }

    private var systemSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionTitle("GLOBAL HOTKEY")
            TextField("CommandOrControl+Shift+V", text: $draft.hotkey)
                .textFieldStyle(.plain)
                .font(.system(size: 13, weight: .semibold))
                .padding(10)
                .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.white.opacity(0.1), lineWidth: 0.5))

            Toggle("Launch at login", isOn: $draft.launchAtLogin)
                .toggleStyle(.switch)
                .font(.system(size: 13, weight: .semibold))

            Toggle("Auto-capture clipboard", isOn: $draft.autoCapture)
                .toggleStyle(.switch)
                .font(.system(size: 13, weight: .semibold))

            sectionTitle("RETENTION")
            Picker("Retention", selection: $draft.retention) {
                Text("30 days").tag(Retention.d30)
                Text("180 days").tag(Retention.d180)
                Text("365 days").tag(Retention.d365)
                Text("Forever").tag(Retention.forever)
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            Text("Favorites are always kept regardless of age.")
                .font(.system(size: 11))
                .foregroundStyle(.white.opacity(0.5))
        }
        .padding(16)
        .background(.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(.white.opacity(0.1), lineWidth: 0.5))
    }

    private func sectionTitle(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 12, weight: .heavy))
            .tracking(0.4)
            .foregroundStyle(.white.opacity(0.55))
    }

    private var actions: some View {
        HStack {
            Spacer()
            Button("Close") { withAnimation { viewModel.showingSettings = false } }
                .buttonStyle(.plain)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
            Button("Save") {
                viewModel.onSaveConfig?(draft)
                withAnimation { viewModel.showingSettings = false }
            }
            .buttonStyle(.plain)
            .foregroundStyle(.white)
            .padding(.horizontal, 16).padding(.vertical, 10)
            .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 12))
        }
        .font(.system(size: 13, weight: .bold))
    }
}
