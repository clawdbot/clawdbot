import Foundation
import Subprocess

/// The bundled upstream helper owns signed Access discovery and encrypted browser transfer.
enum CloudflareAccessLogin {
    struct Application: Sendable {
        let gatewayURL: URL
        fileprivate let issuer: URL
        fileprivate let audience: String
    }

    enum LoginError: Error, LocalizedError {
        case invalidGateway
        case helperUnavailable
        case invalidApplication
        case connectionFailed
        case loginFailed
        case timedOut
        case invalidSession

        var errorDescription: String? {
            switch self {
            case .invalidGateway:
                "Enter an HTTPS gateway address without credentials, a query, or a fragment."
            case .helperUnavailable:
                "The browser sign-in helper is missing. Install a complete copy of OpenClaw and try again."
            case .invalidApplication:
                "This gateway did not provide valid browser sign-in details. Contact its administrator."
            case .connectionFailed:
                "Could not reach the gateway’s sign-in service. Check your connection and try again."
            case .loginFailed:
                "Browser sign-in did not complete. Check that your account can access this gateway and try again."
            case .timedOut:
                "Browser sign-in timed out. Start sign-in again to continue."
            case .invalidSession:
                "The sign-in session could not be verified or has expired. Sign in again."
            }
        }
    }

    private struct Metadata: Decodable {
        let type: String
        let hostname: String
        let authDomain: String
        let aud: String
        let iat: Double

        enum CodingKeys: String, CodingKey {
            case type, hostname, aud, iat
            case authDomain = "auth_domain"
        }
    }

    struct TokenClaims: Decodable {
        let iss: String
        let aud: Audience
        let type: String
        let sub: String
        let exp: Double
        let nbf: Double?
    }

    struct Audience: Decodable {
        let values: [String]

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let value = try? container.decode(String.self) {
                self.values = [value]
            } else {
                self.values = try container.decode([String].self)
            }
        }
    }

    private struct JWTHeader: Decodable { let alg: String }

    private struct HelperManifest: Decodable {
        let version: String
    }

    private struct Identity: Decodable {
        let userUUID: String

        enum CodingKeys: String, CodingKey {
            case userUUID = "user_uuid"
        }
    }

    private final class NoRedirects: NSObject, URLSessionTaskDelegate {
        func urlSession(
            _ session: URLSession,
            task: URLSessionTask,
            willPerformHTTPRedirection response: HTTPURLResponse,
            newRequest request: URLRequest,
            completionHandler: @escaping (URLRequest?) -> Void)
        {
            completionHandler(nil)
        }
    }

    /// Absence means this issuer does not own the gateway; malformed metadata is never a downgrade.
    static func discover(gatewayURL: URL) async throws -> Application? {
        try self.validateGateway(gatewayURL)
        let (_, version) = try self.helper()
        var request = URLRequest(url: gatewayURL)
        request.httpMethod = "HEAD"
        request.setValue("true", forHTTPHeaderField: "Cf-Access-Metadata-Request")
        request.setValue("cloudflared/\(version)", forHTTPHeaderField: "User-Agent")
        let (_, response) = try await self.request(request)
        guard let metadata = response.value(forHTTPHeaderField: "Cf-Access-Metadata") else { return nil }
        return try self.application(gatewayURL: gatewayURL, metadata: metadata)
    }

    static func signIn(application: Application) async throws -> GatewayBrowserSession {
        let (executable, version) = try self.helper()
        let temporary = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-browser-login-\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(
                at: temporary,
                withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o700])
        } catch {
            throw LoginError.loginFailed
        }
        // Upstream writes both app and organization tokens. Keep its HOME private to this attempt
        // and delete it only after the bounded process owner has joined every child.
        defer { try? FileManager.default.removeItem(at: temporary) }
        let result: BoundedProcessResult
        do {
            result = try await BoundedProcess.run(
                path: executable.path,
                arguments: [
                    "access",
                    "login",
                    "--app=\(application.gatewayURL.absoluteString)",
                    "--no-verbose",
                    "--auto-close",
                ],
                environment: [
                    "HOME": temporary.path,
                    "TMPDIR": temporary.path,
                    "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                ],
                workingDirectory: temporary.path,
                standardError: .discarded,
                timeout: 300)
        } catch is CancellationError {
            throw CancellationError()
        } catch BoundedProcessError.timedOut {
            throw LoginError.timedOut
        } catch {
            throw LoginError.loginFailed
        }
        try Task.checkCancellation()
        guard result.terminationStatus == 0, let output = String(data: result.output, encoding: .utf8) else {
            throw LoginError.loginFailed
        }
        let token = output.trimmingCharacters(in: .whitespacesAndNewlines)
        let claims = try self.claims(token: token, application: application)
        guard var components = URLComponents(url: application.gatewayURL, resolvingAgainstBaseURL: false) else {
            throw LoginError.invalidGateway
        }
        components.path = ""
        guard let origin = components.url else { throw LoginError.invalidGateway }
        // login verifies metadata before opening the browser. Only its successful, audience-bound
        // result may be presented to the requested origin; redirects can never forward the credential.
        var identityRequest = URLRequest(url: origin.appendingPathComponent("cdn-cgi/access/get-identity"))
        identityRequest.setValue("CF_Authorization=\(token)", forHTTPHeaderField: "Cookie")
        identityRequest.setValue("cloudflared/\(version)", forHTTPHeaderField: "User-Agent")
        let (data, response) = try await self.request(identityRequest)
        guard response.statusCode == 200,
              let identity = try? JSONDecoder().decode(Identity.self, from: data),
              identity.userUUID == claims.sub
        else { throw LoginError.invalidSession }
        try Task.checkCancellation()
        let session = try GatewayBrowserSession(
            origin: origin,
            issuer: application.issuer,
            audience: application.audience,
            subject: claims.sub,
            token: token,
            expiresAt: Date(timeIntervalSince1970: claims.exp))
        try session.validate(for: origin)
        return session
    }

    /// Discovery candidates are untrusted. The official helper repeats discovery and verifies
    /// its RS256 signature, hostname, and freshness before any browser transfer or credential use.
    static func application(gatewayURL: URL, metadata: String, now: Date = Date()) throws -> Application {
        try self.validateGateway(gatewayURL)
        guard let claims = try? self.decodeJWT(Metadata.self, token: metadata),
              claims.type == "match", claims.hostname.lowercased() == gatewayURL.host?.lowercased(),
              !claims.aud.isEmpty, claims.aud.utf8.count <= 512,
              claims.iat > 0, claims.iat >= now.timeIntervalSince1970 - 86400,
              claims.iat <= now.timeIntervalSince1970 + 300,
              let issuer = URL(string: "https://\(claims.authDomain)"),
              issuer.host?.lowercased().hasSuffix(".cloudflareaccess.com") == true,
              issuer.host?.lowercased() == claims.authDomain.lowercased(),
              issuer.port == nil, issuer.user == nil, issuer.password == nil,
              issuer.path.isEmpty, issuer.query == nil, issuer.fragment == nil
        else { throw LoginError.invalidApplication }
        guard let canonicalIssuer = URL(string: issuer.absoluteString.lowercased()) else {
            throw LoginError.invalidApplication
        }
        return Application(gatewayURL: gatewayURL, issuer: canonicalIssuer, audience: claims.aud)
    }

    static func claims(token: String, application: Application, now: Date = Date()) throws -> TokenClaims {
        guard let claims = try? self.decodeJWT(TokenClaims.self, token: token),
              claims.iss == application.issuer.absoluteString,
              claims.aud.values.contains(application.audience), claims.aud.values.count <= 16,
              claims.type == "app", !claims.sub.isEmpty, claims.sub.utf8.count <= 512,
              claims.exp.isFinite, claims.exp > now.timeIntervalSince1970,
              claims.nbf.map({ $0 <= now.timeIntervalSince1970 }) ?? true
        else { throw LoginError.invalidSession }
        return claims
    }

    private static func validateGateway(_ url: URL) throws {
        guard url.scheme == "https", let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.port.map({ (1...65535).contains($0) }) ?? true,
              url.absoluteString.utf8.count <= 4096
        else { throw LoginError.invalidGateway }
    }

    private static func decodeJWT<Claims: Decodable>(_ type: Claims.Type, token: String) throws -> Claims {
        guard token.utf8.count <= 32768 else { throw LoginError.invalidSession }
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3,
              parts.allSatisfy({ !$0.isEmpty && $0.utf8.allSatisfy { byte in
                  (65...90).contains(byte) || (97...122).contains(byte) || (48...57).contains(byte)
                      || byte == 45 || byte == 95
              } }),
              let header = try? JSONDecoder().decode(JWTHeader.self, from: self.base64URL(parts[0])),
              header.alg == "RS256"
        else { throw LoginError.invalidSession }
        return try JSONDecoder().decode(type, from: self.base64URL(parts[1]))
    }

    private static func base64URL(_ value: Substring) throws -> Data {
        let base64 = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        guard let data = Data(base64Encoded: base64 + String(repeating: "=", count: (4 - base64.count % 4) % 4)) else {
            throw LoginError.invalidSession
        }
        return data
    }

    private static func helper() throws -> (URL, String) {
        #if arch(arm64)
        let architecture = "arm64"
        #else
        let architecture = "x86_64"
        #endif
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("cloudflared"),
              let data = try? Data(contentsOf: root.appendingPathComponent("manifest.json")),
              let manifest = try? JSONDecoder().decode(HelperManifest.self, from: data)
        else { throw LoginError.helperUnavailable }
        let executable = root.appendingPathComponent("\(architecture)/cloudflared")
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw LoginError.helperUnavailable
        }
        return (executable, manifest.version)
    }

    private static func request(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.urlCache = nil
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 30
        let session = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        do {
            let (bytes, response) = try await session.bytes(for: request)
            guard let response = response as? HTTPURLResponse, response.url == request.url else {
                throw LoginError.connectionFailed
            }
            var data = Data()
            for try await byte in bytes {
                guard data.count < 1_048_576 else { throw LoginError.connectionFailed }
                data.append(byte)
            }
            return (data, response)
        } catch {
            if Task.isCancelled { throw CancellationError() }
            throw LoginError.connectionFailed
        }
    }
}
