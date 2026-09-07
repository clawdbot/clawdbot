import Foundation
import Testing
@testable import OpenClaw

struct CloudflareAccessLoginTests {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func `discovery supports configured hosts and dashboard mounts`() throws {
        let gateway = try #require(URL(string: "https://gateway.example.net:8443/dashboard/"))
        let application = try CloudflareAccessLogin.application(
            gatewayURL: gateway, metadata: self.metadata(), now: self.now)
        #expect(application.gatewayURL == gateway)
        let claims = try CloudflareAccessLogin.claims(
            token: self.token(), application: application, now: self.now)
        #expect(claims.sub == "user-42")
        #expect(claims.exp == self.now.timeIntervalSince1970 + 3600)
    }

    @Test(arguments: ["hostname", "issuer", "audience", "stale", "future", "algorithm"])
    func `rejects malformed or mismatched advertised discovery`(_ mutation: String) throws {
        var claims = self.metadataClaims
        var algorithm = "RS256"
        switch mutation {
        case "hostname": claims["hostname"] = "other.example.net"
        case "issuer": claims["auth_domain"] = "tenant.cloudflareaccess.com.attacker.example"
        case "audience": claims["aud"] = ""
        case "stale": claims["iat"] = self.now.timeIntervalSince1970 - 86401
        case "future": claims["iat"] = self.now.timeIntervalSince1970 + 301
        default: algorithm = "none"
        }
        let metadata = try self.jwt(claims, algorithm: algorithm)
        let gateway = try #require(URL(string: "https://gateway.example.net/"))
        #expect(throws: CloudflareAccessLogin.LoginError.self) {
            try CloudflareAccessLogin.application(gatewayURL: gateway, metadata: metadata, now: self.now)
        }
    }

    @Test(arguments: [
        "http://gateway.example.net/", "https://user@gateway.example.net/",
        "https://gateway.example.net/?token=secret", "https://gateway.example.net/#token=secret",
    ])
    func `does not launch credential-bearing or insecure gateway URLs`(_ value: String) throws {
        let gateway = try #require(URL(string: value))
        let metadata = try self.metadata()
        #expect(throws: CloudflareAccessLogin.LoginError.self) {
            try CloudflareAccessLogin.application(gatewayURL: gateway, metadata: metadata, now: self.now)
        }
    }

    @Test func `discovery rejects URL password credentials`() throws {
        var address = try #require(URLComponents(string: "https://gateway.example.net/"))
        address.user = "fixture-user"
        address.password = "fixture-password"
        let gateway = try #require(address.url)
        let metadata = try self.metadata()
        #expect(throws: CloudflareAccessLogin.LoginError.self) {
            try CloudflareAccessLogin.application(gatewayURL: gateway, metadata: metadata, now: self.now)
        }
    }

    @Test(arguments: ["issuer", "audience", "organization", "expired", "not-yet-valid", "subject", "size"])
    func `rejects helper results outside the discovered application session`(_ mutation: String) throws {
        var claims = self.tokenClaims
        switch mutation {
        case "issuer": claims["iss"] = "https://other.cloudflareaccess.com"
        case "audience": claims["aud"] = ["other-application"]
        case "organization": claims["type"] = "org"
        case "expired": claims["exp"] = self.now.timeIntervalSince1970
        case "not-yet-valid": claims["nbf"] = self.now.timeIntervalSince1970 + 1
        case "subject": claims["sub"] = ""
        default: claims["extra"] = String(repeating: "x", count: 32768)
        }
        let application = try self.application()
        let token = try self.jwt(claims)
        #expect(throws: CloudflareAccessLogin.LoginError.self) {
            try CloudflareAccessLogin.claims(token: token, application: application, now: self.now)
        }
    }

    @Test func `accepts the upstream string audience representation`() throws {
        var claims = self.tokenClaims
        claims["aud"] = "application-123"
        let result = try CloudflareAccessLogin.claims(
            token: self.jwt(claims), application: self.application(), now: self.now)
        #expect(result.aud.values == ["application-123"])
    }

    private var metadataClaims: [String: Any] {
        [
            "type": "match",
            "hostname": "gateway.example.net",
            "auth_domain": "tenant.cloudflareaccess.com",
            "aud": "application-123",
            "iat": self.now.timeIntervalSince1970,
        ]
    }

    private var tokenClaims: [String: Any] {
        [
            "iss": "https://tenant.cloudflareaccess.com",
            "aud": ["application-123"],
            "type": "app",
            "sub": "user-42",
            "exp": self.now.timeIntervalSince1970 + 3600,
        ]
    }

    private func application() throws -> CloudflareAccessLogin.Application {
        try CloudflareAccessLogin.application(
            gatewayURL: #require(URL(string: "https://gateway.example.net/")),
            metadata: self.metadata(),
            now: self.now)
    }

    private func metadata() throws -> String {
        try self.jwt(self.metadataClaims)
    }

    private func token() throws -> String {
        try self.jwt(self.tokenClaims)
    }

    /// These tests cover claim binding, not signature validation: the pinned helper owns RS256
    /// verification and browser transfer before production invokes the result boundary.
    private func jwt(_ claims: [String: Any], algorithm: String = "RS256") throws -> String {
        let encode: (Data) -> String = {
            $0.base64EncodedString().replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        }
        return try [
            encode(JSONSerialization.data(withJSONObject: ["alg": algorithm])),
            encode(JSONSerialization.data(withJSONObject: claims)),
            encode(Data("signature-fixture".utf8)),
        ].joined(separator: ".")
    }
}
