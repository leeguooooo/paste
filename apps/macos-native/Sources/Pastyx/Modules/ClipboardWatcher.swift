import AppKit
import CryptoKit
import Foundation

/// Timer polling NSPasteboard.changeCount @700ms; gated by autoCapture;
/// two-tier dedupe (changeCount + probe fingerprint + payload fingerprint with
/// 60s window); self-paste guard snapshot after our own writes; emits clipsChanged.
///
/// Mirrors startClipboardWatcher / captureClipboardNow / the fingerprint helpers
/// in electron/main.cjs.
@MainActor
public final class PasteboardWatcher: ClipboardWatcher {
    public var onClipsChanged: (() -> Void)?

    private let store: ClipStore
    private let config: ConfigStore
    private var timer: Timer?

    // Constants mirrored from main.cjs.
    private static let intervalMs: TimeInterval = 0.700      // CLIPBOARD_WATCH_INTERVAL_MS
    private static let dupWindowMs: Int64 = 60_000
    private static let failureBackoffMs: Int64 = 30_000

    // changeCount pre-filter: only read content when the system bumped it.
    private var lastChangeCount: Int = NSPasteboard.general.changeCount

    // Two-tier dedupe state (mirrors lastClipboardProbeFingerprint / lastClipboardFingerprint).
    private var lastProbeFingerprint = ""
    private var lastPayloadFingerprint = ""

    // 60s rolling window of recently-seen payload fingerprints (kills A,B,A loops).
    private var recentFingerprints: [String: Int64] = [:]

    // Single-flight + failure backoff (mirrors captureClipboardInFlight + lastClipboardFailure).
    private var captureInFlight = false
    private var lastFailureFingerprint = ""
    private var lastFailureAt: Int64 = 0

    public init(store: ClipStore, config: ConfigStore) {
        self.store = store
        self.config = config
    }

    public func start() {
        stop()
        // Snapshot the current pasteboard so the first tick doesn't capture stale content.
        lastChangeCount = NSPasteboard.general.changeCount
        let t = Timer(timeInterval: Self.intervalMs, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
        // .common so the timer keeps firing while a panel/menu tracking loop runs.
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    public func stop() {
        timer?.invalidate()
        timer = nil
    }

    private func tick() {
        guard config.config.autoCapture else { return }
        // Cheap pre-filter: bail unless the system bumped changeCount.
        let cc = NSPasteboard.general.changeCount
        guard cc != lastChangeCount else { return }
        captureNow(source: .watcher)
    }

    public func captureNow(source: CaptureSource) {
        // Manual capture always reads/encodes; everything else short-circuits on
        // the cheap probe fingerprint first.
        let probe = source == .manual ? "" : probeFingerprint()
        if !probe.isEmpty && probe == lastProbeFingerprint {
            lastChangeCount = NSPasteboard.general.changeCount
            return
        }

        if captureInFlight {
            // Concurrent watcher ticks just back off ("busy"); manual still proceeds
            // since a stuck flight should not block an explicit request — but we keep
            // it simple and single-flight by source here.
            if source != .manual { return }
        }

        let now = Int64(Date().timeIntervalSince1970 * 1000)
        if !probe.isEmpty,
           lastFailureFingerprint == probe,
           now - lastFailureAt < Self.failureBackoffMs,
           source != .manual {
            return
        }

        captureInFlight = true
        defer { captureInFlight = false }

        guard let clip = ClipFactory.buildClip(
            from: NSPasteboard.general, config: config.config, source: source
        ) else {
            // Nothing capturable; still advance the changeCount so we don't re-probe.
            lastChangeCount = NSPasteboard.general.changeCount
            return
        }

        let fingerprint = payloadFingerprint(clip)

        // 60s window suppresses re-inserting the same payload for watcher captures.
        if source == .watcher {
            if seenRecently(fingerprint, now: now, windowMs: Self.dupWindowMs) {
                if !probe.isEmpty { lastProbeFingerprint = probe }
                lastChangeCount = NSPasteboard.general.changeCount
                return
            }
        }
        if fingerprint == lastPayloadFingerprint && source != .manual {
            if !probe.isEmpty { lastProbeFingerprint = probe }
            lastChangeCount = NSPasteboard.general.changeCount
            return
        }

        do {
            _ = try store.create(clip)
            lastPayloadFingerprint = fingerprint
            if !probe.isEmpty { lastProbeFingerprint = probe }
            lastFailureFingerprint = ""
            lastFailureAt = 0
            lastChangeCount = NSPasteboard.general.changeCount
            onClipsChanged?()
        } catch {
            if !probe.isEmpty && source != .manual {
                lastFailureFingerprint = probe
                lastFailureAt = now
            }
        }
    }

    public func syncFingerprintsFromSystemClipboard() {
        // Self-paste guard: after WE wrote the pasteboard, align both fingerprints
        // (and changeCount) with the just-written content so the next tick treats
        // it as already-seen.
        lastChangeCount = NSPasteboard.general.changeCount
        lastProbeFingerprint = probeFingerprint()
        if let clip = ClipFactory.buildClip(
            from: NSPasteboard.general, config: config.config, source: .manual
        ) {
            lastPayloadFingerprint = payloadFingerprint(clip)
        }
    }

    // MARK: - Fingerprints

    /// Payload fingerprint: type + content[0..160] + sourceUrl + html[0..160] +
    /// image marker (mirrors payloadFingerprint, main.cjs:1350).
    private func payloadFingerprint(_ clip: ClipItem) -> String {
        let content = String((clip.content ?? "").prefix(160))
        let html = clip.contentHTML.map { String($0.prefix(160)) } ?? ""
        // The full inline image data url is carried in extra["__rawImageDataUrl"].
        let imageMarker: String = {
            if let raw = clip.extra?["__rawImageDataUrl"], !raw.isEmpty {
                return "image:\(raw.count)"
            }
            return ""
        }()
        return [clip.type.rawValue, content, clip.sourceURL ?? "", html, imageMarker].joined(separator: "|")
    }

    /// Cheap probe fingerprint: text[0..160] + html[0..80] + imageKey where
    /// imageKey = "<format>:<byteLen>:<sha1 of first 4096 bytes>"
    /// (mirrors probeClipboardFingerprint, main.cjs:1408).
    private func probeFingerprint() -> String {
        let pb = NSPasteboard.general
        let text = (pb.string(forType: .string) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let html = (pb.string(forType: .html) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

        var imageKey = ""
        let preferred: NSPasteboard.PasteboardType? =
            pb.types?.contains(.png) == true ? .png :
            pb.types?.contains(.tiff) == true ? .tiff : nil
        if let type = preferred, let data = pb.data(forType: type) {
            imageKey = "\(type.rawValue):\(data.count):\(Self.sha1HexPrefix(data))"
        }

        return [String(text.prefix(160)), String(html.prefix(80)), imageKey].joined(separator: "|")
    }

    private static func sha1HexPrefix(_ data: Data) -> String {
        guard !data.isEmpty else { return "" }
        let head = data.prefix(4096)
        return Insecure.SHA1.hash(data: head).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Recent-window helper

    private func seenRecently(_ fingerprint: String, now: Int64, windowMs: Int64) -> Bool {
        guard !fingerprint.isEmpty else { return false }
        // Prune on read.
        recentFingerprints = recentFingerprints.filter { now - $0.value <= windowMs }
        if let prev = recentFingerprints[fingerprint], now - prev <= windowMs {
            recentFingerprints[fingerprint] = now
            return true
        }
        recentFingerprints[fingerprint] = now
        return false
    }
}

/// Builds a ClipItem from the pasteboard. Type-detection priority
/// image > html(link/html) > text; summary/sourceURL extraction; full image to
/// extra["__rawImageDataUrl"] (the HistoryStore persists it to images/<id>.<ext>)
/// + inline preview JPEG ladder (512/360/256/192, 250KB cap); full-size cap 1.5MB.
///
/// Mirrors buildClipboardPayload (main.cjs:1272-1340).
public enum ClipFactory {
    private static let maxImageDataURLLength = 1_500_000          // MAX_IMAGE_DATA_URL_LENGTH
    private static let maxImagePreviewDataURLLength = 250_000     // MAX_IMAGE_PREVIEW_DATA_URL_LENGTH

    public static func buildClip(
        from pasteboard: NSPasteboard,
        config: AppConfig,
        source: CaptureSource
    ) -> ClipItem? {
        let text = (pasteboard.string(forType: .string) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let html = (pasteboard.string(forType: .html) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let richHTML = hasMeaningfulHTML(html, text: text) ? html : nil
        let image = readImage(pasteboard)

        let deviceId = config.deviceId == AppConfig.deviceIdSentinel ? "" : config.deviceId
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let tags: [String] = source == .manual ? [] : ["auto"]

        func base(_ type: ClipType) -> ClipItem {
            ClipItem(
                userId: config.userId,
                deviceId: deviceId,
                type: type,
                tags: tags,
                clientUpdatedAt: now,
                createdAt: now
            )
        }

        // 1. Image present -> type "image".
        if let image {
            guard let full = bestImageDataURL(image), full.count <= maxImageDataURLLength else {
                // "Image too large" — reject (parity with main.cjs).
                return nil
            }
            let preview = previewImageDataURL(image)
            let sourceURL = isProbablyURL(text) ? text : extractURLFromHTML(richHTML)

            var clip = base(.image)
            clip.content = text.isEmpty ? "[Image]" : text
            clip.summary = text.isEmpty ? "Image" : String(text.prefix(120))
            clip.contentHTML = richHTML
            clip.sourceURL = sourceURL
            clip.imagePreviewDataURL = preview
            clip.imageMime = full.hasPrefix("data:image/png") ? "image/png" : "image/jpeg"
            // Carry the full-res data url for the store to write to disk.
            clip.extra = ["__rawImageDataUrl": full]
            return clip
        }

        // 2. Meaningful HTML present -> link (if URL extractable) else html.
        if let richHTML {
            let sourceURL = isProbablyURL(text) ? text : extractURLFromHTML(richHTML)
            let plain = text.isEmpty ? htmlToText(richHTML) : text
            var clip = base(sourceURL != nil ? .link : .html)
            clip.content = plain.isEmpty ? "[HTML]" : plain
            clip.summary = String((sourceURL ?? (plain.isEmpty ? "HTML" : plain)).prefix(120))
            clip.contentHTML = richHTML
            clip.sourceURL = sourceURL
            return clip
        }

        // 3. Plain text only -> link if it's a bare URL, else text.
        if !text.isEmpty {
            let isURL = isProbablyURL(text)
            var clip = base(isURL ? .link : .text)
            clip.content = text
            clip.summary = String(text.prefix(120))
            clip.sourceURL = isURL ? text : nil
            return clip
        }

        // Nothing capturable.
        return nil
    }

    // MARK: - Image reading / encoding

    private static func readImage(_ pasteboard: NSPasteboard) -> NSImage? {
        // Prefer real bitmap formats; reject when only text/html is on the board.
        let types = pasteboard.types ?? []
        guard types.contains(.png) || types.contains(.tiff)
            || types.contains(NSPasteboard.PasteboardType("public.jpeg")) else {
            return nil
        }
        guard let objs = pasteboard.readObjects(forClasses: [NSImage.self], options: nil),
              let image = objs.first as? NSImage, image.size.width > 0, image.size.height > 0 else {
            return nil
        }
        return image
    }

    /// Best full-size data url: PNG if under the cap, else a resized JPEG ladder.
    /// Mirrors buildBestImageDataUrl (main.cjs:1172).
    private static func bestImageDataURL(_ image: NSImage) -> String? {
        guard let bitmap = bitmap(from: image) else { return nil }
        if let png = bitmap.representation(using: .png, properties: [:]) {
            let url = "data:image/png;base64,\(png.base64EncodedString())"
            if url.count <= maxImageDataURLLength { return url }
        }
        let targets: [CGFloat] = [1920, 1440, 1080, 720, 512]
        let qualities: [CGFloat] = [0.80, 0.70, 0.60, 0.50, 0.40, 0.30]
        for target in targets {
            guard let candidate = resized(bitmap, maxSide: target) else { continue }
            for q in qualities {
                guard let jpeg = candidate.representation(using: .jpeg,
                    properties: [.compressionFactor: q]) else { continue }
                let url = "data:image/jpeg;base64,\(jpeg.base64EncodedString())"
                if url.count <= maxImageDataURLLength { return url }
            }
        }
        return nil
    }

    /// Small inline preview JPEG (targets 512/360/256/192, qualities 50/40/30/25,
    /// 250KB cap). Mirrors buildImagePreviewDataUrl (main.cjs:1224).
    private static func previewImageDataURL(_ image: NSImage) -> String? {
        guard let bitmap = bitmap(from: image) else { return nil }
        let targets: [CGFloat] = [512, 360, 256, 192]
        let qualities: [CGFloat] = [0.50, 0.40, 0.30, 0.25]
        for target in targets {
            guard let candidate = resized(bitmap, maxSide: target) else { continue }
            for q in qualities {
                guard let jpeg = candidate.representation(using: .jpeg,
                    properties: [.compressionFactor: q]) else { continue }
                let url = "data:image/jpeg;base64,\(jpeg.base64EncodedString())"
                if url.count <= maxImagePreviewDataURLLength { return url }
            }
        }
        // Fallback: a tiny PNG.
        if let tiny = resized(bitmap, maxSide: 192),
           let png = tiny.representation(using: .png, properties: [:]) {
            let url = "data:image/png;base64,\(png.base64EncodedString())"
            if url.count <= maxImagePreviewDataURLLength { return url }
        }
        return nil
    }

    private static func bitmap(from image: NSImage) -> NSBitmapImageRep? {
        if let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) {
            return rep
        }
        for rep in image.representations {
            if let bmp = rep as? NSBitmapImageRep { return bmp }
        }
        return nil
    }

    /// Resize so the longest side <= maxSide (only downscales).
    private static func resized(_ rep: NSBitmapImageRep, maxSide: CGFloat) -> NSBitmapImageRep? {
        let w = CGFloat(rep.pixelsWide), h = CGFloat(rep.pixelsHigh)
        let longest = max(w, h)
        if longest <= maxSide { return rep }
        let scale = maxSide / longest
        let newW = Int((w * scale).rounded()), newH = Int((h * scale).rounded())
        guard newW > 0, newH > 0,
              let out = NSBitmapImageRep(
                bitmapDataPlanes: nil, pixelsWide: newW, pixelsHigh: newH,
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
              ) else { return nil }
        out.size = NSSize(width: newW, height: newH)

        guard let ctx = NSGraphicsContext(bitmapImageRep: out) else { return nil }
        let saved = NSGraphicsContext.current
        NSGraphicsContext.current = ctx
        ctx.imageInterpolation = .high
        rep.draw(in: NSRect(x: 0, y: 0, width: newW, height: newH))
        NSGraphicsContext.current = saved
        return out
    }

    // MARK: - Text / HTML helpers (mirror main.cjs)

    static func isProbablyURL(_ value: String) -> Bool {
        let v = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return v.range(of: "^https?://\\S+$", options: [.regularExpression, .caseInsensitive]) != nil
    }

    static func extractURLFromHTML(_ value: String?) -> String? {
        guard let value else { return nil }
        // Only real <a href="..."> anchors count as link sources.
        guard let m = value.range(of: "<a\\b[^>]*\\bhref\\s*=\\s*['\"]([^'\"]+)['\"]",
                                  options: [.regularExpression, .caseInsensitive]) else {
            return nil
        }
        let snippet = String(value[m])
        guard let inner = snippet.range(of: "href\\s*=\\s*['\"]([^'\"]+)['\"]",
                                        options: [.regularExpression, .caseInsensitive]) else {
            return nil
        }
        // Extract the captured URL between the quotes.
        let hrefPart = String(snippet[inner])
        guard let q1 = hrefPart.firstIndex(where: { $0 == "'" || $0 == "\"" }) else { return nil }
        let afterQuote = hrefPart.index(after: q1)
        guard let q2 = hrefPart[afterQuote...].firstIndex(where: { $0 == "'" || $0 == "\"" }) else { return nil }
        let url = String(hrefPart[afterQuote..<q2])
        return isProbablyURL(url) ? url : nil
    }

    static func htmlToText(_ html: String) -> String {
        var s = html
        s = s.replacingOccurrences(of: "<style[\\s\\S]*?</style>", with: " ", options: [.regularExpression, .caseInsensitive])
        s = s.replacingOccurrences(of: "<script[\\s\\S]*?</script>", with: " ", options: [.regularExpression, .caseInsensitive])
        s = s.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
        s = s.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// hasMeaningfulHtml (main.cjs:1153): rejects bare <meta charset> and html
    /// whose plain text equals the plain text (unless it has img/table/a/code/pre).
    static func hasMeaningfulHTML(_ html: String, text: String) -> Bool {
        let normalized = html.trimmingCharacters(in: .whitespacesAndNewlines)
        if normalized.isEmpty { return false }
        if normalized == "<meta charset='utf-8'>" || normalized == "<meta charset=\"utf-8\">" {
            return false
        }
        let plain = htmlToText(normalized)
        let structural = normalized.range(of: "<img\\b|<table\\b|<a\\b|<code\\b|<pre\\b",
                                          options: [.regularExpression, .caseInsensitive]) != nil
        if plain.isEmpty {
            return normalized.range(of: "<img\\b|<table\\b|<a\\b",
                                    options: [.regularExpression, .caseInsensitive]) != nil
        }
        return plain != text.trimmingCharacters(in: .whitespacesAndNewlines) || structural
    }
}
