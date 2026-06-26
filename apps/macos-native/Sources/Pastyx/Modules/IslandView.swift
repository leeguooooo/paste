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

    /// Set while an SSO sign-in / sign-out is in flight (disables the button).
    @Published public var authBusy: Bool = false

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
    public var onSignIn: (() -> Void)?
    public var onSignOut: (() -> Void)?

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
            let shelf = UnevenRoundedRectangle(
                topLeadingRadius: 20, bottomLeadingRadius: 0,
                bottomTrailingRadius: 0, topTrailingRadius: 20, style: .continuous
            )
            shelf
                // Slightly graded near-black base — deep enough for constant text
                // contrast over any backdrop, with a subtle top-to-bottom fall-off
                // so the shelf reads as a crafted surface, not a flat black bar.
                .fill(
                    LinearGradient(
                        colors: [
                            Color(.sRGB, red: 26/255, green: 26/255, blue: 31/255, opacity: 0.94),
                            Color(.sRGB, red: 17/255, green: 17/255, blue: 21/255, opacity: 0.95)
                        ],
                        startPoint: .top, endPoint: .bottom
                    )
                )
                // Crisp hairline that's brightest along the top edge (catches light).
                .overlay {
                    shelf.strokeBorder(
                        LinearGradient(
                            colors: [.white.opacity(0.16), .white.opacity(0.05)],
                            startPoint: .top, endPoint: .bottom
                        ),
                        lineWidth: 1
                    )
                }
        }
        .ignoresSafeArea()
        // Soft specular sheen hugging the top edge — restrained, not a hard band.
        .overlay(alignment: .top) {
            LinearGradient(
                colors: [Color.white.opacity(0.07), Color.white.opacity(0)],
                startPoint: .top, endPoint: .bottom
            )
            .frame(height: 58)
            .blendMode(.plusLighter)
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
            HStack(spacing: 11) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.45))
                SearchField(text: $viewModel.query, focused: $searchFocused) {
                    viewModel.requestRefresh()
                } onArrow: { delta in
                    viewModel.moveSelection(by: delta)
                } onEnter: { plain in
                    viewModel.pasteSelected(plainText: plain)
                } onEscape: {
                    viewModel.handleEscape()
                }
                if !viewModel.clips.isEmpty {
                    Text("\(viewModel.clips.count)")
                        .font(.system(size: 11, weight: .semibold).monospacedDigit())
                        .foregroundStyle(.white.opacity(0.4))
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(.white.opacity(0.07), in: Capsule())
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity)
            .glassEffect(.regular, in: .rect(cornerRadius: 13))
            .overlay(
                RoundedRectangle(cornerRadius: 13)
                    .strokeBorder(.white.opacity(0.10), lineWidth: 1)
            )

            // Favorites-only toggle.
            ToolbarIconButton(
                systemName: viewModel.favoritesOnly ? "star.fill" : "star",
                active: viewModel.favoritesOnly,
                accent: Color(hex: "#ffcc00")
            ) {
                viewModel.favoritesOnly.toggle()
                viewModel.requestRefresh()
            }

            // Settings gear.
            ToolbarIconButton(systemName: "gearshape", active: false, accent: .white) {
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
        VStack(spacing: 12) {
            Image(systemName: viewModel.favoritesOnly ? "star" : "doc.on.clipboard")
                .font(.system(size: 26, weight: .regular))
                .foregroundStyle(.white.opacity(0.28))
                .frame(width: 56, height: 56)
                .background(.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(.white.opacity(0.06), lineWidth: 1))
            VStack(spacing: 3) {
                Text(viewModel.favoritesOnly ? "No favorites yet"
                     : (viewModel.query.isEmpty ? "Your clipboard history is empty"
                        : "No matches"))
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.7))
                Text(viewModel.favoritesOnly ? "Star a clip to keep it here."
                     : (viewModel.query.isEmpty ? "Copy anything and it shows up instantly."
                        : "Nothing matches \u{201C}\(viewModel.query)\u{201D}."))
                    .font(.system(size: 12, weight: .regular))
                    .foregroundStyle(.white.opacity(0.4))
            }
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

    @State private var hovering = false
    private var accent: Color { clip.type.accent }
    private let radius: CGFloat = 15

    var body: some View {
        VStack(spacing: 0) {
            accentStrip
            head
            preview
            footer
        }
        .frame(width: 280, height: 244)
        // Crisp dark slab with a faint top-down grade so it reads as a real surface.
        .background {
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [
                            Color(.sRGB, red: 34/255, green: 34/255, blue: 40/255, opacity: 0.97),
                            Color(.sRGB, red: 27/255, green: 27/255, blue: 32/255, opacity: 0.97)
                        ],
                        startPoint: .top, endPoint: .bottom
                    )
                )
        }
        .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
        // Hairline border; warms to the accent on selection.
        .overlay {
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .strokeBorder(
                    selected ? accent.opacity(0.85) : .white.opacity(hovering ? 0.16 : 0.08),
                    lineWidth: selected ? 1.5 : 1
                )
        }
        // Depth: soft ambient shadow always, plus a tinted accent glow when selected.
        .shadow(color: .black.opacity(selected ? 0.4 : 0.22), radius: selected ? 18 : 10, x: 0, y: selected ? 12 : 6)
        .shadow(color: selected ? accent.opacity(0.28) : .clear, radius: 16, x: 0, y: 6)
        .scaleEffect(selected ? 1.0 : (hovering ? 0.995 : 0.97), anchor: .bottom)
        .offset(y: selected ? -6 : 0)
        .animation(.spring(response: 0.32, dampingFraction: 0.82), value: selected)
        .animation(.easeOut(duration: 0.16), value: hovering)
        .contentShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
        .onTapGesture(perform: onTap)
        .onHover { h in hovering = h; if h { onHover() } }
        .zIndex(selected ? 10 : 0)
    }

    // Thin type-colored strip across the very top — instant visual structure.
    private var accentStrip: some View {
        accent.opacity(selected ? 1 : 0.85)
            .frame(height: 3)
    }

    private var head: some View {
        HStack(spacing: 8) {
            Text(clip.type.displayLabel)
                .font(.system(size: 9.5, weight: .bold))
                .tracking(0.7)
                .foregroundStyle(accent)
            Text(ClipPresentation.ageShort(clip.createdAt))
                .font(.system(size: 11, weight: .medium).monospacedDigit())
                .foregroundStyle(.white.opacity(0.4))
            Spacer(minLength: 4)
            Button(action: onToggleFavorite) {
                Image(systemName: clip.isFavorite ? "star.fill" : "star")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(clip.isFavorite ? Color(hex: "#ffcc00") : .white.opacity(hovering ? 0.5 : 0.3))
                    .frame(width: 26, height: 26)
                    .background(
                        (clip.isFavorite ? Color(hex: "#ffcc00").opacity(0.14) : .white.opacity(hovering ? 0.08 : 0)),
                        in: RoundedRectangle(cornerRadius: 7)
                    )
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 14)
        .frame(height: 40)
    }

    @ViewBuilder
    private var preview: some View {
        Group {
            if let image = ClipPresentation.previewImage(clip) {
                // Full-bleed thumbnail with a faint inner edge so it reads as media.
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
                    .aspectRatio(contentMode: .fill)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .clipped()
                    .overlay {
                        LinearGradient(
                            colors: [.black.opacity(0.0), .black.opacity(0.22)],
                            startPoint: .center, endPoint: .bottom
                        )
                        .allowsHitTesting(false)
                    }
            } else if clip.type == .link, let src = clip.sourceURL,
                      !src.trimmingCharacters(in: .whitespaces).isEmpty {
                linkPreview(src)
            } else if clip.type == .code {
                codePreview
            } else {
                Text(ClipPresentation.previewText(clip))
                    .font(.system(size: 13.5, weight: .regular))
                    .lineSpacing(4)
                    .foregroundStyle(.white.opacity(0.92))
                    .lineLimit(6)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .padding(.horizontal, 16)
                    .padding(.top, 10)
                    .padding(.bottom, 12)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // Link card: favicon + domain headline, path, then any title/summary.
    private func linkPreview(_ src: String) -> some View {
        let parts = Self.hostAndPath(src)
        let extra = Self.linkSubtitle(clip, host: parts.host, path: parts.path)
        return VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 9) {
                FaviconView(host: parts.host, accent: accent)
                Text(parts.host)
                    .font(.system(size: 14.5, weight: .semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            if !parts.path.isEmpty, parts.path != "/" {
                Text(parts.path)
                    .font(.system(size: 11.5, weight: .regular))
                    .foregroundStyle(accent.opacity(0.85))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            if let extra, !extra.isEmpty {
                Text(extra)
                    .font(.system(size: 12.5))
                    .lineSpacing(3)
                    .foregroundStyle(.white.opacity(0.6))
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 12)
    }

    // Code card: monospaced text on a slightly inset darker panel.
    private var codePreview: some View {
        Text(ClipPresentation.previewText(clip))
            .font(.system(size: 12, weight: .regular, design: .monospaced))
            .lineSpacing(2)
            .foregroundStyle(.white.opacity(0.9))
            .lineLimit(7)
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding(12)
            .background(.black.opacity(0.28), in: RoundedRectangle(cornerRadius: 9))
            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(.white.opacity(0.06), lineWidth: 0.5))
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
    }

    /// Split a URL into (host without leading www., path+query).
    static func hostAndPath(_ url: String) -> (host: String, path: String) {
        let trimmed = url.trimmingCharacters(in: .whitespaces)
        guard let u = URL(string: trimmed), let rawHost = u.host else {
            return (trimmed, "")
        }
        let host = rawHost.hasPrefix("www.") ? String(rawHost.dropFirst(4)) : rawHost
        var path = u.path
        if let q = u.query, !q.isEmpty { path += "?\(q)" }
        return (host, path)
    }

    /// A link's title/summary, if it adds anything beyond the host + path.
    static func linkSubtitle(_ clip: ClipItem, host: String, path: String) -> String? {
        let text = ClipPresentation.previewText(clip).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        // Hide it when the preview is just the raw URL again.
        if text.contains(host) && text.count <= host.count + path.count + 12 { return nil }
        return text
    }

    private var footer: some View {
        let device = ClipPresentation.deviceMeta(clip.deviceId)
        return HStack(spacing: 6) {
            Image(systemName: device.symbol)
                .font(.system(size: 10.5))
            Text(device.label)
                .font(.system(size: 10.5, weight: .medium))
                .tracking(0.3)
                .lineLimit(1)
            Spacer(minLength: 4)
            if selected {
                HStack(spacing: 5) {
                    Text("paste")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.7))
                    Keycap("return")
                }
                .transition(.opacity)
            }
        }
        .foregroundStyle(.white.opacity(0.42))
        .padding(.horizontal, 14)
        .frame(height: 36)
        .overlay(alignment: .top) {
            Rectangle().fill(.white.opacity(0.07)).frame(height: 1)
        }
        .animation(.easeOut(duration: 0.2), value: selected)
    }
}

// MARK: - Favicon

/// Domain favicon for link cards. Loads the real icon asynchronously (cached by
/// URLSession), and shows a colored monogram while loading / on failure — so the
/// card is instant and still looks finished offline.
private struct FaviconView: View {
    let host: String
    let accent: Color

    private var faviconURL: URL? {
        URL(string: "https://www.google.com/s2/favicons?sz=64&domain=\(host)")
    }

    var body: some View {
        AsyncImage(url: faviconURL) { phase in
            if case .success(let image) = phase {
                image
                    .resizable()
                    .interpolation(.high)
                    .scaledToFit()
                    .padding(5)
            } else {
                monogram
            }
        }
        .frame(width: 30, height: 30)
        .background(.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.white.opacity(0.10), lineWidth: 0.5))
    }

    private var monogram: some View {
        Text(host.first.map { String($0).uppercased() } ?? "•")
            .font(.system(size: 14, weight: .bold))
            .foregroundStyle(accent)
    }
}

// MARK: - Keycap

/// A small SF-Symbol keycap pill used for inline keyboard hints (⏎ etc.).
private struct Keycap: View {
    let symbol: String
    init(_ symbol: String) { self.symbol = symbol }

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 9.5, weight: .bold))
            .foregroundStyle(.white.opacity(0.85))
            .frame(width: 20, height: 18)
            .background(.white.opacity(0.10), in: RoundedRectangle(cornerRadius: 5))
            .overlay(
                RoundedRectangle(cornerRadius: 5)
                    .strokeBorder(.white.opacity(0.14), lineWidth: 0.5)
            )
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
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(active ? accent : .white.opacity(0.65))
                .frame(width: 40, height: 40)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(active ? accent.opacity(0.45) : .white.opacity(0.08), lineWidth: 1)
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
                VStack(alignment: .leading, spacing: 18) {
                    accountSection
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
        HStack(spacing: 10) {
            Image(systemName: "gearshape.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white.opacity(0.5))
            Text("Settings")
                .font(.system(size: 18, weight: .bold))
            Spacer()
            // Single MVP tab.
            Text("System")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Color(hex: "#ff5447"))
                .padding(.horizontal, 13).padding(.vertical, 7)
                .background(Color(hex: "#ff5447").opacity(0.14), in: Capsule())
        }
    }

    private var accountSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionTitle("ACCOUNT")
            if viewModel.authStatus.authenticated, let user = viewModel.authStatus.user {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Signed in")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(.white.opacity(0.45))
                        Text(user.displayName)
                            .font(.system(size: 14, weight: .semibold))
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer()
                    Button("Sign out") { viewModel.onSignOut?() }
                        .buttonStyle(.plain)
                        .font(.system(size: 12, weight: .bold))
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                        .disabled(viewModel.authBusy)
                }
            } else {
                Button {
                    viewModel.onSignIn?()
                } label: {
                    Text(viewModel.authBusy ? "Opening browser…" : "Sign in to sync")
                        .font(.system(size: 14, weight: .heavy))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Color(hex: "#ff5447"), in: RoundedRectangle(cornerRadius: 12))
                        .foregroundStyle(.white)
                }
                .buttonStyle(.plain)
                .disabled(viewModel.authBusy)
            }
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
        .background(
            Color(.sRGB, red: 32/255, green: 32/255, blue: 38/255, opacity: 0.85),
            in: RoundedRectangle(cornerRadius: 16, style: .continuous)
        )
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(.white.opacity(0.08), lineWidth: 1))
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
            .background(Color(hex: "#ff5447"), in: RoundedRectangle(cornerRadius: 12))
        }
        .font(.system(size: 13, weight: .bold))
    }
}
