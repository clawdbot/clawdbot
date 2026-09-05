import CryptoKit
import Foundation
import OpenClawKit

enum GatewayBrowserSessionError: LocalizedError, Equatable {
    case invalidSession
    case wrongOrigin
    case expired
    case superseded
    case credentialRetirementFailed

    var errorDescription: String? {
        switch self {
        case .invalidSession:
            "The browser returned an invalid Gateway sign-in. Start sign-in again."
        case .wrongOrigin:
            "This browser sign-in belongs to a different Gateway. Sign in to the selected Gateway."
        case .expired:
            "Your Gateway browser sign-in has expired. Sign in again in Gateway settings."
        case .superseded:
            "Gateway settings changed while signing in. Start sign-in again."
        case .credentialRetirementFailed:
            "Could not replace the old Gateway credential. Try signing in again."
        }
    }
}

/// An issuer-owned browser session, not a Gateway shared token. Its credential
/// travels only to the HTTPS authority that completed the verified sign-in.
struct GatewayBrowserSession: Codable, Equatable, Sendable {
    enum Provider: String, Codable, Sendable {
        case cloudflareAccess
    }

    let provider: Provider
    let origin: URL
    let issuer: URL
    let audience: String
    let subject: String
    let expiresAt: Date
    private let token: String

    init(origin: URL, issuer: URL, audience: String, subject: String, token: String, expiresAt: Date) throws {
        self.provider = .cloudflareAccess
        self.origin = try Self.httpsOrigin(origin)
        self.issuer = try Self.httpsOrigin(issuer)
        guard !audience.isEmpty, audience.utf8.count <= 4096,
              !subject.isEmpty, subject.utf8.count <= 512,
              !token.isEmpty, token.utf8.count <= 32768,
              token.utf8.allSatisfy({
                  (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) ||
                      [45, 46, 95].contains($0)
              }),
              expiresAt.timeIntervalSince1970.isFinite,
              expiresAt.timeIntervalSince1970 > 0
        else { throw GatewayBrowserSessionError.invalidSession }
        self.audience = audience
        self.subject = subject
        self.token = token
        self.expiresAt = expiresAt
    }

    private enum CodingKeys: String, CodingKey {
        case provider, origin, issuer, audience, subject, expiresAt, token
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        _ = try values.decode(Provider.self, forKey: .provider)
        try self.init(
            origin: values.decode(URL.self, forKey: .origin),
            issuer: values.decode(URL.self, forKey: .issuer),
            audience: values.decode(String.self, forKey: .audience),
            subject: values.decode(String.self, forKey: .subject),
            token: values.decode(String.self, forKey: .token),
            expiresAt: values.decode(Date.self, forKey: .expiresAt))
    }

    func validate(for url: URL, now: Date = Date()) throws {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              ["https", "wss"].contains(components.scheme?.lowercased() ?? ""),
              components.user == nil, components.password == nil,
              let target = GatewayTLSAuthority(url: url),
              let owner = GatewayTLSAuthority(url: self.origin),
              target.host == owner.host, target.port == owner.port
        else { throw GatewayBrowserSessionError.wrongOrigin }
        guard self.expiresAt > now else { throw GatewayBrowserSessionError.expired }
    }

    func headers(for url: URL, now: Date = Date()) throws -> [String: String] {
        try self.validate(for: url, now: now)
        return ["CF-Access-Token": self.token]
    }

    var credentialFingerprint: String {
        SHA256.hash(data: Data(self.token.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    func chatStoreID(profileID: String) -> String {
        // Issuer-verified identity survives token renewal; endpoint-only keys
        // would let another account read cached history or replay queued work.
        let identity = [self.provider.rawValue, self.issuer.absoluteString, self.audience, self.subject]
            .map { "\($0.utf8.count):\($0)" }.joined()
        let digest = SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
        return "\(profileID):account:\(digest)"
    }

    var browserDataPrincipal: String {
        self.chatStoreID(profileID: self.origin.absoluteString)
    }

    func cookie(now: Date = Date()) throws -> HTTPCookie {
        try self.validate(for: self.origin, now: now)
        guard let cookie = HTTPCookie(properties: [
            .name: "CF_Authorization",
            .value: self.token,
            .originURL: self.origin,
            .path: "/",
            .secure: "TRUE",
            .expires: self.expiresAt,
            HTTPCookiePropertyKey("HttpOnly"): "TRUE",
        ]) else { throw GatewayBrowserSessionError.invalidSession }
        return cookie
    }

    private static func httpsOrigin(_ url: URL) throws -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == "https",
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/",
              components.port.map({ (1...65535).contains($0) }) ?? true
        else { throw GatewayBrowserSessionError.invalidSession }
        components.scheme = "https"
        components.host = host.lowercased()
        if components.port == 443 { components.port = nil }
        components.path = "/"
        guard let origin = components.url else { throw GatewayBrowserSessionError.invalidSession }
        return origin
    }
}
