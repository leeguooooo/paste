import Foundation

/// A single-shot loopback HTTP server for the OAuth2 redirect callback.
///
/// Ports the Electron `runSsoAuthorizationFlow` loopback `http.createServer`
/// (main.cjs:1506-1627): listen on `127.0.0.1:<port>`, accept exactly one GET to
/// `/auth/sso/callback`, validate `code` + `state`, serve a tiny HTML page, then
/// close. ZERO external deps — a raw POSIX TCP socket on the loopback interface.
///
/// Not `@MainActor`: it runs its accept loop on a background queue and reports
/// the result through a continuation. The caller (SSOAuthService) hops back to
/// the main actor.
final class SSOLoopbackServer: @unchecked Sendable {
    /// Validated callback payload.
    struct Callback: Sendable {
        let code: String
        let redirectUri: String
    }

    enum LoopbackError: Error, Sendable {
        /// The browser came back with `?error=...` (user denied / server error).
        case callback(String)
        /// Missing code or `state` mismatch (CSRF guard).
        case invalidState
        /// The single-shot window elapsed without a callback.
        case timedOut
        /// `bind`/`listen`/`accept` failed (port in use, etc.).
        case socket(String)
    }

    private let port: Int
    private let callbackPath: String
    private let expectedState: String
    private let redirectUri: String

    private var listenFD: Int32 = -1
    private let queue = DispatchQueue(label: "pastyx.sso.loopback")
    private var settled = false
    private let lock = NSLock()

    init(port: Int, callbackPath: String, expectedState: String, redirectUri: String) {
        self.port = port
        self.callbackPath = callbackPath
        self.expectedState = expectedState
        self.redirectUri = redirectUri
    }

    /// Bind + listen NOW (synchronous) so the caller can open the browser only
    /// after the loopback port is actually accepting connections. Throws on a
    /// bind/listen failure (e.g. the port is already in use).
    func start() throws {
        try bindAndListen()
    }

    /// Await the first valid callback. Must be called after `start()`. `timeoutMs`
    /// mirrors the Electron floor of 30s (`max(30_000, AUTH_TIMEOUT_MS)`).
    func waitForCallback(timeoutMs: Int) async throws -> Callback {
        defer { closeListener() }

        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Callback, Error>) in
            // Timeout watchdog (single-shot guard via `finish`).
            queue.asyncAfter(deadline: .now() + .milliseconds(max(30_000, timeoutMs))) { [weak self] in
                self?.finish(continuation, .failure(LoopbackError.timedOut))
            }
            // Accept loop.
            queue.async { [weak self] in
                self?.acceptLoop(continuation)
            }
        }
    }

    // MARK: - Socket setup

    private func bindAndListen() throws {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw LoopbackError.socket("socket() failed: \(errno)") }

        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(UInt16(port)).bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1") // loopback only
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)

        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Foundation.bind(fd, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0 else {
            close(fd)
            throw LoopbackError.socket("bind() failed on port \(port): \(errno)")
        }
        guard listen(fd, 1) == 0 else {
            close(fd)
            throw LoopbackError.socket("listen() failed: \(errno)")
        }
        listenFD = fd
    }

    private func acceptLoop(_ continuation: CheckedContinuation<Callback, Error>) {
        while true {
            lock.lock(); let done = settled; let fd = listenFD; lock.unlock()
            if done || fd < 0 { return }

            let client = accept(fd, nil, nil)
            if client < 0 {
                // Listener closed (settled) => bail quietly; otherwise keep trying.
                lock.lock(); let stop = settled; lock.unlock()
                if stop { return }
                continue
            }
            handleClient(client, continuation)
            // We only ever resolve on a *valid* callback (matches Electron, which
            // keeps the server open and replies 404 to stray paths). On a bad
            // request we reply with an error page and keep looping until timeout
            // or a valid hit — EXCEPT an explicit `?error=` / bad-state, which
            // settles, mirroring the Electron reject-and-close.
            lock.lock(); let stop = settled; lock.unlock()
            if stop { return }
        }
    }

    private func handleClient(_ client: Int32, _ continuation: CheckedContinuation<Callback, Error>) {
        defer { close(client) }

        guard let requestLine = readRequestLine(client) else { return }
        // "GET /auth/sso/callback?code=...&state=... HTTP/1.1"
        let parts = requestLine.split(separator: " ", maxSplits: 2)
        guard parts.count >= 2 else {
            respond(client, status: "400 Bad Request", title: "Sign-in Failed", message: "Malformed request.")
            return
        }
        let target = String(parts[1])
        guard let comps = URLComponents(string: "http://127.0.0.1:\(port)\(target)") else {
            respond(client, status: "400 Bad Request", title: "Sign-in Failed", message: "Malformed request.")
            return
        }

        // Stray path => 404, keep listening (Electron parity).
        guard comps.path == callbackPath else {
            respond(client, status: "404 Not Found", title: "Not Found", message: "Invalid callback path.")
            return
        }

        let items = comps.queryItems ?? []
        func value(_ name: String) -> String {
            (items.first(where: { $0.name == name })?.value ?? "").trimmingCharacters(in: .whitespaces)
        }

        let errorCode = value("error")
        if !errorCode.isEmpty {
            let desc = value("error_description")
            let msg = desc.isEmpty ? errorCode : desc
            respond(client, status: "400 Bad Request", title: "Sign-in Failed", message: msg)
            finish(continuation, .failure(LoopbackError.callback(msg)))
            return
        }

        let code = value("code")
        let returnedState = value("state")
        guard !code.isEmpty, !returnedState.isEmpty, returnedState == expectedState else {
            respond(client, status: "400 Bad Request", title: "Sign-in Failed", message: "Invalid SSO callback state.")
            finish(continuation, .failure(LoopbackError.invalidState))
            return
        }

        respond(client, status: "200 OK", title: "Sign-in Complete", message: "You can close this tab and return to Pastyx.")
        finish(continuation, .success(Callback(code: code, redirectUri: redirectUri)))
    }

    // MARK: - Minimal HTTP I/O

    /// Read just the request line (the first CRLF-terminated line). The query
    /// string carries everything we need; we never read the body.
    private func readRequestLine(_ client: Int32) -> String? {
        var buffer = [UInt8]()
        var byte: UInt8 = 0
        // Cap the read so a malicious client can't make us spin forever.
        for _ in 0..<8192 {
            let n = read(client, &byte, 1)
            if n <= 0 { break }
            if byte == 0x0A { break }           // \n ends the line
            if byte != 0x0D { buffer.append(byte) } // skip \r
        }
        guard !buffer.isEmpty else { return nil }
        return String(decoding: buffer, as: UTF8.self)
    }

    private func respond(_ client: Int32, status: String, title: String, message: String) {
        let body = """
        <!doctype html><html><head><meta charset="utf-8"><title>\(title)</title>\
        <style>body{font:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;\
        max-width:32rem;margin:6rem auto;padding:0 1.5rem;color:#1d1d1f;text-align:center}\
        h2{font-weight:600}p{color:#6e6e73}</style></head>\
        <body><h2>\(title)</h2><p>\(message)</p></body></html>
        """
        let bodyBytes = Array(body.utf8)
        let header = """
        HTTP/1.1 \(status)\r
        content-type: text/html; charset=utf-8\r
        content-length: \(bodyBytes.count)\r
        connection: close\r
        \r

        """
        var out = Array(header.utf8)
        out.append(contentsOf: bodyBytes)
        out.withUnsafeBytes { raw in
            var sent = 0
            while sent < raw.count {
                let n = write(client, raw.baseAddress!.advanced(by: sent), raw.count - sent)
                if n <= 0 { break }
                sent += n
            }
        }
    }

    // MARK: - Single-shot settle

    private func finish(_ continuation: CheckedContinuation<Callback, Error>, _ result: Result<Callback, Error>) {
        lock.lock()
        if settled { lock.unlock(); return }
        settled = true
        lock.unlock()
        closeListener()
        continuation.resume(with: result)
    }

    private func closeListener() {
        lock.lock()
        let fd = listenFD
        listenFD = -1
        lock.unlock()
        if fd >= 0 { close(fd) }
    }
}
