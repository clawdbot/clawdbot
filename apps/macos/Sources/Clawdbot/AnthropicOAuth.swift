import CryptoKit
import Foundation
import OSLog
import Security

struct AnthropicOAuthCredentials: Codable {
    let type: String
    let refresh: String
    let access: String
    let expires: Int64
}

enum AnthropicAuthMode: Equatable {
    case oauthFile
    case oauthEnv
    case apiKeyEnv
    case missing

    var shortLabel: String {
        switch self {
        case .oauthFile: "OAuth (Moltbot token file)"
        case .oauthEnv: "OAuth (env var)"
        case .apiKeyEnv: "API key (env var)"
        case .missing: "Missing credentials"
        }
    }

    var isConfigured: Bool {
        switch self {
        case .missing: false
        case .oauthFile, .oauthEnv, .apiKeyEnv: true
        }
    }
}

enum AnthropicAuthResolver {
    static func resolve(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        oauthStatus: MoltbotOAuthStore.AnthropicOAuthStatus = MoltbotOAuthStore
            .anthropicOAuthStatus()) -> AnthropicAuthMode
    {
        if oauthStatus.isConnected { return .oauthFile }

        if let token = environment["ANTHROPIC_OAUTH_TOKEN"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !token.isEmpty
        {
            return .oauthEnv
        }

        if let key = environment["ANTHROPIC_API_KEY"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !key.isEmpty
        {
            return .apiKeyEnv
        }

        return .missing
    }
}

enum AnthropicOAuth {
    private static let logger = Logger(subsystem: "com.clawdbot", category: "anthropic-oauth")

    private static let clientId = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
    private static let authorizeURL = URL(string: "https://claude.ai/oauth/authorize")!
    private static let tokenURL = URL(string: "https://console.anthropic.com/v1/oauth/token")!
    private static let redirectURI = "https://console.anthropic.com/oauth/code/callback"
    private static let scopes = "org:create_api_key user:profile user:inference"

    struct PKCE {
        let verifier: String
        let challenge: String
    }

    static func generatePKCE() throws -> PKCE {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
        let verifier = Data(bytes).base64URLEncodedString()
        let hash = SHA256.hash(data: Data(verifier.utf8))
        let challenge = Data(hash).base64URLEncodedString()
        return PKCE(verifier: verifier, challenge: challenge)
    }

    static func buildAuthorizeURL(pkce: PKCE) -> URL {
        var components = URLComponents(url: self.authorizeURL, resolvingAgainstBaseURL: false)!
        components.queryItems = [
            URLQueryItem(name: "code", value: "true"),
            URLQueryItem(name: "client_id", value: self.clientId),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "redirect_uri", value: self.redirectURI),
            URLQueryItem(name: "scope", value: self.scopes),
            URLQueryItem(name: "code_challenge", value: pkce.challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            // Match legacy flow: state is the verifier.
            URLQueryItem(name: "state", value: pkce.verifier),
        ]
        return components.url!
    }

    static func exchangeCode(
        code: String,
        state: String,
        verifier: String) async throws -> AnthropicOAuthCredentials
    {
        let payload: [String: Any] = [
            "grant_type": "authorization_code",
            "client_id": self.clientId,
            "code": code,
            "state": state,
            "redirect_uri": self.redirectURI,
            "code_verifier": verifier,
        ]
        let body = try JSONSerialization.data(withJSONObject: payload, options: [])

        var request = URLRequest(url: self.tokenURL)
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        guard (200..<300).contains(http.statusCode) else {
            let text = String(data: data, encoding: .utf8) ?? "<non-utf8>"
            throw NSError(
                domain: "AnthropicOAuth",
                code: http.statusCode,
                userInfo: [NSLocalizedDescriptionKey: "Token exchange failed: \(text)"])
        }

        let decoded = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let access = decoded?["access_token"] as? String
        let refresh = decoded?["refresh_token"] as? String
        let expiresIn = decoded?["expires_in"] as? Double
        guard let access, let refresh, let expiresIn else {
            throw NSError(domain: "AnthropicOAuth", code: 0, userInfo: [
                NSLocalizedDescriptionKey: "Unexpected token response.",
            ])
        }

        // Match legacy flow: expiresAt = now + expires_in - 5 minutes.
        let expiresAtMs = Int64(Date().timeIntervalSince1970 * 1000)
            + Int64(expiresIn * 1000)
            - Int64(5 * 60 * 1000)

        self.logger.info("Anthropic OAuth exchange ok; expiresAtMs=\(expiresAtMs, privacy: .public)")
        return AnthropicOAuthCredentials(type: "oauth", refresh: refresh, access: access, expires: expiresAtMs)
    }

    static func refresh(refreshToken: String) async throws -> AnthropicOAuthCredentials {
        let payload: [String: Any] = [
            "grant_type": "refresh_token",
            "client_id": self.clientId,
            "refresh_token": refreshToken,
        ]
        let body = try JSONSerialization.data(withJSONObject: payload, options: [])

        var request = URLRequest(url: self.tokenURL)
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        guard (200..<300).contains(http.statusCode) else {
            let text = String(data: data, encoding: .utf8) ?? "<non-utf8>"
            throw NSError(
                domain: "AnthropicOAuth",
                code: http.statusCode,
                userInfo: [NSLocalizedDescriptionKey: "Token refresh failed: \(text)"])
        }

        let decoded = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let access = decoded?["access_token"] as? String
        let refresh = (decoded?["refresh_token"] as? String) ?? refreshToken
        let expiresIn = decoded?["expires_in"] as? Double
        guard let access, let expiresIn else {
            throw NSError(domain: "AnthropicOAuth", code: 0, userInfo: [
                NSLocalizedDescriptionKey: "Unexpected token response.",
            ])
        }

        let expiresAtMs = Int64(Date().timeIntervalSince1970 * 1000)
            + Int64(expiresIn * 1000)
            - Int64(5 * 60 * 1000)

        self.logger.info("Anthropic OAuth refresh ok; expiresAtMs=\(expiresAtMs, privacy: .public)")
        return AnthropicOAuthCredentials(type: "oauth", refresh: refresh, access: access, expires: expiresAtMs)
    }
}

enum MoltbotOAuthStore {
    static let oauthFilename = "oauth.json"
    private static let providerKey = "anthropic"
    private static let moltbotOAuthDirEnv = "CLAWDBOT_OAUTH_DIR"
    private static let legacyPiDirEnv = "PI_CODING_AGENT_DIR"

    enum AnthropicOAuthStatus: Equatable {
        case missingFile
        case unreadableFile
        case invalidJSON
        case missingProviderEntry
        case missingTokens
        case connected(expiresAtMs: Int64?)

        var isConnected: Bool {
            if case .connected = self { return true }
            return false
        }

        var shortDescription: String {
            switch self {
            case .missingFile: "Moltbot OAuth token file not found"
            case .unreadableFile: "Moltbot OAuth token file not readable"
            case .invalidJSON: "Moltbot OAuth token file invalid"
            case .missingProviderEntry: "No Anthropic entry in Moltbot OAuth token file"
            case .missingTokens: "Anthropic entry missing tokens"
            case .connected: "Moltbot OAuth credentials found"
            }
        }
    }

    static func oauthDir() -> URL {
        if let override = ProcessInfo.processInfo.environment[self.clawdbotOAuthDirEnv]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !override.isEmpty
        {
            let expanded = NSString(string: override).expandingTildeInPath
            return URL(fileURLWithPath: expanded, isDirectory: true)
        }

        return FileManager().homeDirectoryForCurrentUser
            .appendingPathComponent(".clawdbot", isDirectory: true)
            .appendingPathComponent("credentials", isDirectory: true)
    }

    static func oauthURL() -> URL {
        self.oauthDir().appendingPathComponent(self.oauthFilename)
    }

    static func legacyOAuthURLs() -> [URL] {
        var urls: [URL] = []
        let env = ProcessInfo.processInfo.environment
        if let override = env[self.legacyPiDirEnv]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !override.isEmpty
        {
            let expanded = NSString(string: override).expandingTildeInPath
            urls.append(URL(fileURLWithPath: expanded, isDirectory: true).appendingPathComponent(self.oauthFilename))
        }

        let home = FileManager().homeDirectoryForCurrentUser
        urls.append(home.appendingPathComponent(".pi/agent/\(self.oauthFilename)"))
        urls.append(home.appendingPathComponent(".claude/\(self.oauthFilename)"))
        urls.append(home.appendingPathComponent(".config/claude/\(self.oauthFilename)"))
        urls.append(home.appendingPathComponent(".config/anthropic/\(self.oauthFilename)"))

        var seen = Set<String>()
        return urls.filter { url in
            let path = url.standardizedFileURL.path
            if seen.contains(path) { return false }
            seen.insert(path)
            return true
        }
    }

    static func importLegacyAnthropicOAuthIfNeeded() -> URL? {
        let dest = self.oauthURL()
        guard !FileManager().fileExists(atPath: dest.path) else { return nil }

        for url in self.legacyOAuthURLs() {
            guard FileManager().fileExists(atPath: url.path) else { continue }
            guard self.anthropicOAuthStatus(at: url).isConnected else { continue }
            guard let storage = self.loadStorage(at: url) else { continue }
            do {
                try self.saveStorage(storage)
                return url
            } catch {
                continue
            }
        }

        return nil
    }

    static func anthropicOAuthStatus() -> AnthropicOAuthStatus {
        self.anthropicOAuthStatus(at: self.oauthURL())
    }

    static func hasAnthropicOAuth() -> Bool {
        self.anthropicOAuthStatus().isConnected
    }

    static func anthropicOAuthStatus(at url: URL) -> AnthropicOAuthStatus {
        guard FileManager().fileExists(atPath: url.path) else { return .missingFile }

        guard let data = try? Data(contentsOf: url) else { return .unreadableFile }
        guard let json = try? JSONSerialization.jsonObject(with: data, options: []) else { return .invalidJSON }
        guard let storage = json as? [String: Any] else { return .invalidJSON }
        guard let rawEntry = storage[self.providerKey] else { return .missingProviderEntry }
        guard let entry = rawEntry as? [String: Any] else { return .invalidJSON }

        let refresh = self.firstString(in: entry, keys: ["refresh", "refresh_token", "refreshToken"])
        let access = self.firstString(in: entry, keys: ["access", "access_token", "accessToken"])
        guard refresh?.isEmpty == false, access?.isEmpty == false else { return .missingTokens }

        let expiresAny = entry["expires"] ?? entry["expires_at"] ?? entry["expiresAt"]
        let expiresAtMs: Int64? = if let ms = expiresAny as? Int64 {
            ms
        } else if let number = expiresAny as? NSNumber {
            number.int64Value
        } else if let ms = expiresAny as? Double {
            Int64(ms)
        } else {
            nil
        }

        return .connected(expiresAtMs: expiresAtMs)
    }

    static func loadAnthropicOAuthRefreshToken() -> String? {
        let url = self.oauthURL()
        guard let storage = self.loadStorage(at: url) else { return nil }
        guard let rawEntry = storage[self.providerKey] as? [String: Any] else { return nil }
        let refresh = self.firstString(in: rawEntry, keys: ["refresh", "refresh_token", "refreshToken"])
        return refresh?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func firstString(in dict: [String: Any], keys: [String]) -> String? {
        for key in keys {
            if let value = dict[key] as? String { return value }
        }
        return nil
    }

    private static func loadStorage(at url: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        guard let json = try? JSONSerialization.jsonObject(with: data, options: []) else { return nil }
        return json as? [String: Any]
    }

    static func saveAnthropicOAuth(_ creds: AnthropicOAuthCredentials) throws {
        let url = self.oauthURL()
        let existing: [String: Any] = self.loadStorage(at: url) ?? [:]

        var updated = existing
        updated[self.providerKey] = [
            "type": creds.type,
            "refresh": creds.refresh,
            "access": creds.access,
            "expires": creds.expires,
        ]

        try self.saveStorage(updated)
    }

    private static func saveStorage(_ storage: [String: Any]) throws {
        let dir = self.oauthDir()
        try FileManager().createDirectory(
            at: dir,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])

        let url = self.oauthURL()
        let data = try JSONSerialization.data(
            withJSONObject: storage,
            options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: [.atomic])
        try FileManager().setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
}

extension Data {
    fileprivate func base64URLEncodedString() -> String {
        self.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
