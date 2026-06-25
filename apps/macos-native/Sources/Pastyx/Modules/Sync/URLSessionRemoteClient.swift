import Foundation

/// URLSession-backed RemoteClient (remoteRequest + buildRemoteHeaders,
/// main.cjs:1437-1479). Decodes the `{ok,code,message,data}` envelope.
///
/// Envelope convention (main.cjs:1453-1479): every response is
/// `{ok:bool, code?, message?, data?}`. On a non-2xx with a structured
/// `{ok:false,...}` body the server error is returned verbatim; on any other
/// non-2xx → `{ok:false, code:"HTTP_ERROR", message:"HTTP <status>"}`; on a
/// transport throw → `{ok:false, code:"NETWORK_ERROR", message}`.
///
/// ZERO external deps: URLSession only.
public struct URLSessionRemoteClient: RemoteClient {
    /// Live identity snapshot (apiBase / userId / deviceId / authToken).
    public struct Identity: Sendable {
        public var apiBase: String
        public var userId: String
        public var deviceId: String
        public var authToken: String
        public init(apiBase: String, userId: String, deviceId: String, authToken: String) {
            self.apiBase = apiBase
            self.userId = userId
            self.deviceId = deviceId
            self.authToken = authToken
        }
    }

    /// Read the current identity ON EACH REQUEST so that a token minted by SSO
    /// AFTER this client was constructed is honored without rebuilding the client
    /// (mirrors Electron's `remoteRequest(cfg, …)` always reading fresh config).
    private let identity: @Sendable () -> Identity
    private let session: URLSession

    /// Static-snapshot init (identity fixed at construction).
    public init(apiBase: String, userId: String, deviceId: String, authToken: String) {
        let snapshot = Identity(apiBase: apiBase, userId: userId, deviceId: deviceId, authToken: authToken)
        self.identity = { snapshot }
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 30
        cfg.timeoutIntervalForResource = 60
        cfg.waitsForConnectivity = false
        self.session = URLSession(configuration: cfg)
    }

    /// Live-config init: identity is read from the ConfigStore on every request,
    /// so post-login token/userId changes take effect immediately.
    public init(config: ConfigStore) {
        // ConfigStore is a class (reference); the closure reads its current
        // `config` value at call time. The store is owned by @MainActor
        // AppDelegate and only mutated there, so this read is safe.
        let box = UncheckedSendableBox(config)
        self.identity = {
            let c = box.value.config
            return Identity(apiBase: c.apiBase, userId: c.userId, deviceId: c.deviceId, authToken: c.authToken)
        }
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 30
        cfg.timeoutIntervalForResource = 60
        cfg.waitsForConnectivity = false
        self.session = URLSession(configuration: cfg)
    }

    private var apiBase: String { identity().apiBase }
    private var userId: String { identity().userId }
    private var deviceId: String { identity().deviceId }
    private var authToken: String { identity().authToken }

    /// `isRemoteEnabled(cfg)` (main.cjs:561): apiBase matches `^https?://`.
    public var isRemoteEnabled: Bool {
        let b = apiBase.trimmingCharacters(in: .whitespaces).lowercased()
        return b.hasPrefix("http://") || b.hasPrefix("https://")
    }

    /// `normalizeApiBase` (main.cjs:492-509): strip hash/query + trailing
    /// slashes; if the path is empty default it to `/v1`.
    public func normalizedApiBase() -> String? {
        let trimmed = apiBase.trimmingCharacters(in: .whitespaces)
        guard isRemoteEnabled, var comps = URLComponents(string: trimmed) else { return nil }
        comps.fragment = nil
        comps.query = nil
        var path = comps.path
        while path.hasSuffix("/") { path.removeLast() }
        if path.isEmpty { path = "/v1" }
        comps.path = path
        return comps.string
    }

    /// buildRemoteHeaders (main.cjs:1437-1451). Token auth (authToken non-empty)
    /// => Bearer + x-device-id; legacy header identity => x-user-id + x-device-id.
    /// Always content-type: application/json; per-call extras merged last.
    private func headers(extra: [String: String]) -> [String: String] {
        var h: [String: String] = ["content-type": "application/json"]
        let token = authToken.trimmingCharacters(in: .whitespaces)
        if !token.isEmpty {
            h["authorization"] = "Bearer \(token)"
            h["x-device-id"] = deviceId
        } else {
            h["x-user-id"] = userId
            h["x-device-id"] = deviceId
        }
        for (k, v) in extra { h[k] = v }
        return h
    }

    public func request(method: String, path: String, body: Data?, extraHeaders: [String: String]) async -> RemoteEnvelope {
        guard let base = normalizedApiBase() else {
            return RemoteEnvelope(ok: false, code: "REMOTE_DISABLED", message: "remote not configured")
        }
        // base already normalized (trailing slash stripped); path begins with "/".
        let urlString = base + path
        guard let url = URL(string: urlString) else {
            return RemoteEnvelope(ok: false, code: "NETWORK_ERROR", message: "bad url: \(urlString)")
        }

        var req = URLRequest(url: url)
        req.httpMethod = method.uppercased()
        req.httpBody = body
        for (k, v) in headers(extra: extraHeaders) { req.setValue(v, forHTTPHeaderField: k) }

        do {
            let (data, response): (Data, URLResponse) = try await session.data(for: req)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let ok2xx = (200...299).contains(status)

            // Parse the body as the {ok,code,message,data} envelope.
            let parsed = Self.parseEnvelope(data)

            if !ok2xx {
                // Server returned a structured error envelope -> return verbatim.
                if let env = parsed, env.ok == false {
                    return env
                }
                return RemoteEnvelope(ok: false, code: "HTTP_ERROR", message: "HTTP \(status)")
            }

            // 2xx: trust the parsed envelope; if the body wasn't an envelope but
            // the request succeeded, synthesize an ok envelope carrying the body.
            if let env = parsed {
                return env
            }
            return RemoteEnvelope(ok: true, code: nil, message: nil, data: data.isEmpty ? nil : data)
        } catch {
            return RemoteEnvelope(ok: false, code: "NETWORK_ERROR", message: error.localizedDescription)
        }
    }

    /// Parse raw response bytes into a RemoteEnvelope. Returns nil if the bytes
    /// are not a JSON object carrying an `ok` field (i.e. not an envelope).
    /// `data` is re-serialized to raw JSON so callers can decode their own shape.
    private static func parseEnvelope(_ bytes: Data) -> RemoteEnvelope? {
        guard !bytes.isEmpty,
              let obj = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any]
        else { return nil }
        guard let ok = obj["ok"] as? Bool else { return nil }

        let code = obj["code"] as? String
        let message = obj["message"] as? String
        var dataBytes: Data? = nil
        if let dataField = obj["data"], !(dataField is NSNull) {
            dataBytes = try? JSONSerialization.data(withJSONObject: dataField)
        }
        return RemoteEnvelope(ok: ok, code: code, message: message, data: dataBytes)
    }
}

/// Wraps a reference so a closure can capture it across the Sendable boundary.
/// Used to read the ConfigStore live from the (Sendable) remote client; the
/// stored config is only mutated on the @MainActor, so reads are safe.
final class UncheckedSendableBox<T>: @unchecked Sendable {
    let value: T
    init(_ value: T) { self.value = value }
}

/// High-level remote clip operations (RemoteSyncing) over a RemoteClient.
/// Maps each operation to the /clips + /images endpoints (main.cjs:2760-2907,
/// api-contract §2/§4.1). The dual-write / local-first-on-failure degradation
/// logic lives in the coordinator that owns both this and the local store; this
/// type only speaks to the remote.
public struct RemoteClipSync: RemoteSyncing {
    private let client: RemoteClient

    /// Server-side list cap (MAX_LOCAL_LIST_LIMIT, clip-list.cjs:1).
    private static let listLimit = 60

    public init(client: RemoteClient) {
        self.client = client
    }

    /// Map an envelope into a thrown SyncError when not ok.
    private func unwrap(_ env: RemoteEnvelope) throws {
        guard env.ok else {
            throw Self.error(from: env)
        }
    }

    private static func error(from env: RemoteEnvelope) -> SyncError {
        let code = env.code ?? "REMOTE_ERROR"
        if code == "NETWORK_ERROR" {
            return .network(env.message ?? "network error")
        }
        return .remote(code: code, message: env.message ?? "remote error")
    }

    /// `GET /clips?q=&favorite=1&limit=&lite=1` (main.cjs:2771-2776).
    public func listClips(_ query: ClipQuery) async throws -> [ClipItem] {
        guard client.isRemoteEnabled else { throw SyncError.remoteDisabled }
        var params: [String] = []
        let q = query.search.trimmingCharacters(in: .whitespacesAndNewlines)
        if !q.isEmpty {
            params.append("q=\(Self.urlEncode(q))")
        }
        if query.favoritesOnly {
            params.append("favorite=1")
        }
        params.append("limit=\(Self.listLimit)")
        params.append("lite=1")
        let path = "/clips?" + params.joined(separator: "&")

        let env = await client.request(method: "GET", path: path, body: nil, extraHeaders: [:])
        try unwrap(env)
        guard let data = env.data else { return [] }
        return RemoteWireCodec.decodeClipList(data)
    }

    /// `GET /clips/:id` → full clip (main.cjs:2801).
    public func getClip(id: String) async throws -> ClipItem? {
        guard client.isRemoteEnabled else { throw SyncError.remoteDisabled }
        let clipId = id.trimmingCharacters(in: .whitespaces)
        guard !clipId.isEmpty else { throw SyncError.generic("id is required") }
        let env = await client.request(method: "GET", path: "/clips/\(Self.pathEscape(clipId))", body: nil, extraHeaders: [:])
        if !env.ok {
            // A NOT_FOUND envelope is a legitimate "no clip" answer, not an error.
            if env.code == "NOT_FOUND" { return nil }
            throw Self.error(from: env)
        }
        guard let data = env.data else { return nil }
        return RemoteWireCodec.decodeSingleClip(data)
    }

    /// `POST /clips` upsert; body = full clip patch (main.cjs:2820-2854).
    /// `clientUpdatedAt` is stamped now (fresh write — drives remote LWW, §5).
    public func upsertClip(_ clip: ClipItem) async throws -> ClipItem {
        guard client.isRemoteEnabled else { throw SyncError.remoteDisabled }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let body = RemoteWireCodec.encodeUpsertBody(clip, now: now)
        let env = await client.request(method: "POST", path: "/clips", body: body, extraHeaders: [:])
        try unwrap(env)
        // Prefer the server's returned clip (carries serverUpdatedAt); fall back
        // to the input with the stamped clientUpdatedAt on a bodyless ok.
        if let data = env.data, let decoded = RemoteWireCodec.decodeSingleClip(data) {
            return decoded
        }
        var out = clip
        out.clientUpdatedAt = now
        return out
    }

    /// `PATCH /clips/:id` `{isFavorite, clientUpdatedAt}` (main.cjs:2868).
    public func setFavorite(id: String, isFavorite: Bool, clientUpdatedAt: Int64) async throws {
        guard client.isRemoteEnabled else { throw SyncError.remoteDisabled }
        let body = RemoteWireCodec.encodeBody([
            "isFavorite": isFavorite,
            "clientUpdatedAt": clientUpdatedAt
        ])
        let env = await client.request(method: "PATCH", path: "/clips/\(Self.pathEscape(id))", body: body, extraHeaders: [:])
        try unwrap(env)
    }

    /// `DELETE /clips/:id` body `{clientUpdatedAt}` (main.cjs:2894).
    public func deleteClip(id: String, clientUpdatedAt: Int64) async throws {
        guard client.isRemoteEnabled else { throw SyncError.remoteDisabled }
        let body = RemoteWireCodec.encodeBody(["clientUpdatedAt": clientUpdatedAt])
        let env = await client.request(method: "DELETE", path: "/clips/\(Self.pathEscape(id))", body: body, extraHeaders: [:])
        try unwrap(env)
    }

    /// `GET /images/:clipId?u=<userId>&h=<sha256>` — optional R2 image fetch
    /// (api-contract §4.1). `u` required, `h` optional immutable-cache hint.
    /// Returns the raw image bytes (NOT an envelope — this endpoint streams the
    /// image directly), or nil on a non-2xx.
    public func fetchImage(clipId: String, userId: String, sha256: String?) async throws -> Data? {
        guard client.isRemoteEnabled else { throw SyncError.remoteDisabled }
        var params: [String] = ["u=\(Self.urlEncode(userId))"]
        if let h = sha256, !h.isEmpty {
            params.append("h=\(Self.urlEncode(h))")
        }
        let path = "/images/\(Self.pathEscape(clipId))?" + params.joined(separator: "&")
        let env = await client.request(method: "GET", path: path, body: nil, extraHeaders: [:])
        // The image endpoint returns raw bytes, which parseEnvelope won't read as
        // an envelope; request() then synthesizes ok:true with the raw body.
        guard env.ok else {
            if env.code == "NOT_FOUND" || env.code == "HTTP_ERROR" { return nil }
            throw Self.error(from: env)
        }
        return env.data
    }

    // MARK: - URL helpers

    private static func urlEncode(_ s: String) -> String {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=+?#")
        return s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s
    }

    private static func pathEscape(_ s: String) -> String {
        s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? s
    }
}
