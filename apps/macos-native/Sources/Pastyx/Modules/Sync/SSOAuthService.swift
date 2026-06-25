import AppKit
import CryptoKit
import Foundation

/// SSO auth via OAuth2 Authorization Code + PKCE over a loopback redirect
/// (SSO_INTEGRATION_PLAN.md §6 + main.cjs:1506-1688).
///
/// Defaults (main.cjs:231-236):
///   issuer       = PASTE_SSO_ISSUER || https://account.misonote.com
///   clientId     = PASTE_SSO_CLIENT_ID || misonote-paste-macos
///   timeoutMs    = PASTE_SSO_AUTH_TIMEOUT_MS || 300000
///   loopbackPort = PASTE_SSO_LOOPBACK_PORT || 45897
///
/// Token + login are persisted into AppConfig (`authToken` + `authGithubLogin`)
/// for parity with Electron — the same fields `URLSessionRemoteClient` reads to
/// build the `Authorization: Bearer <token>` header (buildRemoteHeaders,
/// main.cjs:1437-1451). Each network call here is built from the *current*
/// config snapshot (mirrors Electron's `remoteRequest(cfg, …)` always reading
/// fresh config), so the token exchange (no token) and the subsequent
/// `/auth/me` (with the freshly-stored token) both carry the right headers even
/// though the injected `RemoteClient` captured an older token at launch.
@MainActor
public final class SSOAuthService: AuthService {
    private let config: ConfigStore
    private let remote: RemoteClient
    private let session: URLSession

    private static func env(_ key: String, _ fallback: String) -> String {
        let v = ProcessInfo.processInfo.environment[key]?.trimmingCharacters(in: .whitespaces)
        return (v?.isEmpty == false) ? v! : fallback
    }
    private var issuer: String {
        // Must match the issuer the paste API trusts (SSO_ISSUER in the API's
        // wrangler config) — otherwise the authorization code is signed by a
        // different issuer than the one the broker exchanges/verifies against.
        var s = Self.env("PASTE_SSO_ISSUER", "https://account.leeguoo.com")
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }
    private var clientId: String { Self.env("PASTE_SSO_CLIENT_ID", "misonote-paste-macos") }
    private var authTimeoutMs: Int { Int(Self.env("PASTE_SSO_AUTH_TIMEOUT_MS", "300000")) ?? 300000 }
    private var loopbackPort: Int { Int(Self.env("PASTE_SSO_LOOPBACK_PORT", "45897")) ?? 45897 }
    private let callbackPath = "/auth/sso/callback"
    private var redirectUri: String { "http://127.0.0.1:\(loopbackPort)\(callbackPath)" }

    public init(config: ConfigStore, remote: RemoteClient) {
        self.config = config
        self.remote = remote
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 30
        cfg.timeoutIntervalForResource = 60
        self.session = URLSession(configuration: cfg)
    }

    // MARK: - status (auth:status, main.cjs:2590-2630)

    public func status() async -> AuthStatus {
        guard remote.isRemoteEnabled else {
            return AuthStatus(remoteEnabled: false, authenticated: false, authConfigured: false, user: nil)
        }

        let env = await getAuthMe()
        guard env.ok else {
            // Transport / server error: report unauthenticated but keep the token
            // (could be a transient outage — don't nuke a possibly-valid token).
            return AuthStatus(remoteEnabled: true, authenticated: false, authConfigured: false, user: nil)
        }

        let me = decodeAuthMe(env.data)
        let authenticated = me.authenticated && me.user != nil

        if !authenticated {
            // Self-heal an expired token: if /auth/me says unauthenticated but we
            // still hold a token, clear it (main.cjs:2607-2609).
            if !config.config.authToken.isEmpty {
                var cfg = config.config
                cfg.authToken = ""
                cfg.authGithubLogin = ""
                config.save(cfg)
            }
            return AuthStatus(remoteEnabled: true, authenticated: false, authConfigured: me.authConfigured, user: nil)
        }

        // Refresh stored identity from the server (main.cjs:2610-2615).
        if let user = me.user {
            let nextUserId = user.userId.isEmpty ? config.config.userId : user.userId
            let nextLogin = user.githubLogin ?? config.config.authGithubLogin
            if nextUserId != config.config.userId || nextLogin != config.config.authGithubLogin {
                var cfg = config.config
                cfg.userId = nextUserId
                cfg.authGithubLogin = nextLogin
                config.save(cfg)
            }
        }

        return AuthStatus(
            remoteEnabled: true,
            authenticated: true,
            authConfigured: me.authConfigured,
            user: me.user
        )
    }

    // MARK: - startSignIn (startSsoSignIn, main.cjs:1629-1688)

    public func startSignIn() async throws -> AuthUser {
        // 1. Precondition: remote configured (main.cjs:1630-1632).
        guard remote.isRemoteEnabled else {
            throw SyncError.authNotConfigured("Please configure API Endpoint first")
        }

        // 2. PKCE pair + CSRF state (makePkcePair, main.cjs:1488-1492).
        let verifier = Self.base64url(Self.randomBytes(48))
        let challenge = Self.base64url(Data(SHA256.hash(data: Data(verifier.utf8))))
        let state = Self.base64url(Self.randomBytes(24))

        // 3. Loopback server live BEFORE opening the browser.
        let server = SSOLoopbackServer(
            port: loopbackPort,
            callbackPath: callbackPath,
            expectedState: state,
            redirectUri: redirectUri
        )

        // 4. Build the authorize URL and open the system browser
        //    (shell.openExternal -> NSWorkspace.open, main.cjs:1605).
        guard var authComps = URLComponents(string: issuer + "/authorize") else {
            throw SyncError.ssoFailed("SSO issuer is not configured.")
        }
        authComps.queryItems = [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "redirect_uri", value: redirectUri),
            URLQueryItem(name: "scope", value: "openid profile email"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
        ]
        guard let authUrl = authComps.url else {
            throw SyncError.ssoFailed("Failed to build the authorization URL.")
        }

        // 5. Bind the loopback listener FIRST (so the port is live), then open the
        //    browser, then await the callback (validates code + state, honors the
        //    timeout). Binding before opening avoids a race where the browser
        //    redirect lands before the port is accepting.
        do {
            try server.start()
        } catch let e as SSOLoopbackServer.LoopbackError {
            throw Self.mapLoopbackError(e)
        } catch {
            throw SyncError.ssoFailed(error.localizedDescription)
        }

        if !NSWorkspace.shared.open(authUrl) {
            NSLog("[pastyx] sso: failed to open browser for \(authUrl.absoluteString)")
            // The listener will time out and surface .ssoFailed; nothing else to do.
        }

        let callback: SSOLoopbackServer.Callback
        do {
            callback = try await server.waitForCallback(timeoutMs: authTimeoutMs)
        } catch let e as SSOLoopbackServer.LoopbackError {
            throw Self.mapLoopbackError(e)
        } catch {
            throw SyncError.ssoFailed(error.localizedDescription)
        }

        // 6. Token exchange: POST /auth/sso/token (main.cjs:1645-1656).
        let exchangeBody: [String: String] = [
            "grantType": "authorization_code",
            "code": callback.code,
            "codeVerifier": verifier,
            "redirectUri": callback.redirectUri,
            // The code is bound to THIS client; tell the broker to exchange with
            // it instead of defaulting to the web client.
            "clientId": clientId,
        ]
        let exchange = await postJSON(path: "/auth/sso/token", body: exchangeBody)
        guard exchange.ok else {
            throw SyncError.remote(code: exchange.code ?? "SSO_TOKEN_EXCHANGE_FAILED",
                                   message: exchange.message ?? "Failed to exchange SSO token.")
        }
        let accessToken = decodeAccessToken(exchange.data)
        guard !accessToken.isEmpty else {
            throw SyncError.ssoFailed("SSO access token is missing.")
        }

        // 7. Persist the token (main.cjs:1663-1667). Resets authGithubLogin until
        //    /auth/me refreshes it.
        var cfg = config.config
        cfg.authToken = accessToken
        cfg.authGithubLogin = ""
        config.save(cfg)

        // 8. Fetch identity with the new token (main.cjs:1669-1679).
        let meEnv = await getAuthMe()
        let me = decodeAuthMe(meEnv.data)
        if meEnv.ok, me.authenticated, let user = me.user {
            let nextUserId = user.userId.isEmpty ? config.config.userId : user.userId
            let nextLogin = (user.githubLogin?.isEmpty == false) ? user.githubLogin! : nextUserId
            var c = config.config
            c.userId = nextUserId
            c.authGithubLogin = nextLogin
            config.save(c)
        }

        // 9. Return the approved user (main.cjs:1681-1687).
        return AuthUser(
            userId: config.config.userId,
            githubLogin: config.config.authGithubLogin.isEmpty ? config.config.userId : config.config.authGithubLogin
        )
    }

    // MARK: - logout (auth:logout, main.cjs:2637-2654)

    @discardableResult
    public func logout() async -> String {
        let prior = config.config.userId
        if remote.isRemoteEnabled {
            // Best-effort server-side logout; ignore failures.
            _ = await postJSON(path: "/auth/logout", body: [String: String]())
        }
        var cfg = config.config
        cfg.authToken = ""
        cfg.authGithubLogin = ""
        config.save(cfg)
        return prior
    }

    // MARK: - HTTP (built from the CURRENT config, like remoteRequest(cfg, …))

    /// GET /auth/me with the current identity headers.
    private func getAuthMe() async -> RemoteEnvelope {
        await request(method: "GET", path: "/auth/me", bodyData: nil)
    }

    /// POST a JSON dictionary; serialized with sorted keys for determinism.
    private func postJSON(path: String, body: [String: String]) async -> RemoteEnvelope {
        let data = (try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])) ?? Data("{}".utf8)
        return await request(method: "POST", path: path, bodyData: data)
    }

    /// Core request: resolves the base from current config, builds headers per
    /// buildRemoteHeaders, issues the call, and decodes the {ok,code,message,data}
    /// envelope (remoteRequest, main.cjs:1453-1479).
    private func request(method: String, path: String, bodyData: Data?) async -> RemoteEnvelope {
        guard let base = Self.normalizeApiBase(config.config.apiBase) else {
            return RemoteEnvelope(ok: false, code: "REMOTE_DISABLED", message: "remote not configured")
        }
        guard let url = URL(string: base + path) else {
            return RemoteEnvelope(ok: false, code: "BAD_URL", message: "invalid url")
        }

        var req = URLRequest(url: url)
        req.httpMethod = method
        for (k, v) in Self.buildHeaders(config: config.config) { req.setValue(v, forHTTPHeaderField: k) }
        if let bodyData { req.httpBody = bodyData }

        do {
            let (data, response) = try await session.data(for: req)
            let http = response as? HTTPURLResponse
            let status = http?.statusCode ?? 0
            let parsed = Self.parseEnvelope(data)

            if status >= 200, status < 300 {
                // 2xx but a server may still send {ok:false} — honor it.
                if let p = parsed { return p }
                return RemoteEnvelope(ok: true)
            }
            // Non-2xx: prefer the server's structured {ok:false,...} envelope.
            if let p = parsed, p.ok == false { return p }
            return RemoteEnvelope(ok: false, code: "HTTP_ERROR", message: "HTTP \(status)")
        } catch {
            return RemoteEnvelope(ok: false, code: "NETWORK_ERROR", message: error.localizedDescription)
        }
    }

    // MARK: - Header / base helpers (parity with main.cjs)

    /// buildRemoteHeaders (main.cjs:1437-1451). Token auth => Bearer + x-device-id;
    /// legacy => x-user-id + x-device-id. Always content-type: application/json.
    static func buildHeaders(config: AppConfig) -> [String: String] {
        var h: [String: String] = ["content-type": "application/json"]
        if !config.authToken.isEmpty {
            h["authorization"] = "Bearer \(config.authToken)"
            h["x-device-id"] = config.deviceId
        } else {
            h["x-user-id"] = config.userId
            h["x-device-id"] = config.deviceId
        }
        return h
    }

    /// normalizeApiBase (main.cjs:492-509): require http(s); strip hash/query +
    /// trailing slashes; empty path defaults to `/v1`. Returns nil if not remote.
    static func normalizeApiBase(_ raw: String) -> String? {
        let lower = raw.lowercased()
        guard lower.hasPrefix("http://") || lower.hasPrefix("https://") else { return nil }
        guard var comps = URLComponents(string: raw) else { return nil }
        comps.fragment = nil
        comps.query = nil
        var path = comps.path
        while path.hasSuffix("/") { path.removeLast() }
        if path.isEmpty { path = "/v1" }
        comps.path = path
        return comps.string
    }

    // MARK: - Envelope + payload decoding

    /// Parse the `{ok,code,message,data}` envelope. `data` is re-serialized to
    /// raw bytes so each caller decodes its own shape.
    static func parseEnvelope(_ data: Data) -> RemoteEnvelope? {
        guard !data.isEmpty,
              let obj = try? JSONSerialization.jsonObject(with: data),
              let dict = obj as? [String: Any]
        else { return nil }
        let ok = (dict["ok"] as? Bool) ?? false
        let code = dict["code"] as? String
        let message = dict["message"] as? String
        var inner: Data? = nil
        if let d = dict["data"] {
            inner = try? JSONSerialization.data(withJSONObject: d)
        }
        return RemoteEnvelope(ok: ok, code: code, message: message, data: inner)
    }

    /// Decode `data.accessToken` from /auth/sso/token.
    private func decodeAccessToken(_ data: Data?) -> String {
        guard let data,
              let obj = try? JSONSerialization.jsonObject(with: data),
              let dict = obj as? [String: Any]
        else { return "" }
        return (dict["accessToken"] as? String ?? "").trimmingCharacters(in: .whitespaces)
    }

    private struct AuthMe {
        var authenticated: Bool
        var authConfigured: Bool
        var user: AuthUser?
    }

    /// Decode the /auth/me `data` payload: `{authenticated, authConfigured, user}`.
    private func decodeAuthMe(_ data: Data?) -> AuthMe {
        guard let data,
              let obj = try? JSONSerialization.jsonObject(with: data),
              let dict = obj as? [String: Any]
        else { return AuthMe(authenticated: false, authConfigured: false, user: nil) }

        let authenticated = (dict["authenticated"] as? Bool) ?? false
        let authConfigured = (dict["authConfigured"] as? Bool) ?? false
        var user: AuthUser? = nil
        if let u = dict["user"] as? [String: Any] {
            let userId = (u["userId"] as? String) ?? ""
            let login = u["githubLogin"] as? String
            // githubId may arrive as a string or a number.
            var githubId: String? = u["githubId"] as? String
            if githubId == nil, let n = u["githubId"] as? NSNumber, n.intValue != 0 {
                githubId = n.stringValue
            }
            if !userId.isEmpty {
                user = AuthUser(userId: userId,
                                githubLogin: (login?.isEmpty == false) ? login : nil,
                                githubId: githubId)
            }
        }
        return AuthMe(authenticated: authenticated, authConfigured: authConfigured, user: user)
    }

    // MARK: - Error mapping

    private static func mapLoopbackError(_ e: SSOLoopbackServer.LoopbackError) -> SyncError {
        switch e {
        case .callback(let msg): return .ssoFailed(msg)
        case .invalidState:      return .ssoFailed("Invalid SSO callback state.")
        case .timedOut:          return .ssoFailed("SSO sign-in timed out. Please try again.")
        case .socket(let msg):   return .ssoFailed(msg)
        }
    }

    // MARK: - PKCE helpers

    /// base64url(bytes): standard base64 with `+`→`-`, `/`→`_`, `=` stripped.
    static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// CSPRNG bytes via CryptoKit (already a dependency — ClipboardWatcher imports
    /// it). `SymmetricKey` is backed by the system CSPRNG.
    static func randomBytes(_ count: Int) -> Data {
        SymmetricKey(size: .init(bitCount: count * 8)).withUnsafeBytes { Data($0) }
    }
}
