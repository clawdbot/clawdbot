import CryptoKit
import Foundation
import OpenClawChatUI
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@Suite(.serialized)
@MainActor
struct GatewayConnectionMediaAuthorityTests {
    private nonisolated static let artifactID = "artifact_managed_image_authority"
    private nonisolated static let ticket = "/api/chat/media/outgoing/image?mediaTicket=synthetic"

    @Test(arguments: [false, true])
    func `cancellation before transport creation cannot dispatch or invalidate its session`(
        afterAdmission: Bool) async throws
    {
        let tls = try DashboardTLSFixture()
        var requests: [String] = []
        let server = try await DashboardHTTPFixture.start(tlsIdentity: tls.identity, requestHandler: { request in
            requests.append(request)
            return Self.imageResponse
        })
        defer { server.stop() }
        let transport = GatewayTLSPinningSession(params: Self.tlsParams(tls))
        defer { transport.finishTasksAndInvalidate() }
        let gate = GatewayConnectionSuspensionGate()
        let request = URLRequest(url: server.url("/cancelled"))
        let pending = Task {
            if !afterAdmission { await gate.suspend() }
            return try await transport.data(for: request, maximumBytes: 5) {
                if afterAdmission { withUnsafeCurrentTask { $0?.cancel() } }
                return true
            }
        }
        if !afterAdmission {
            await gate.waitUntilStarted()
            pending.cancel()
            await gate.open()
        }
        do {
            _ = try await pending.value
            Issue.record("Cancelled media request completed")
        } catch {
            #expect(error is CancellationError || (error as? URLError)?.code == .cancelled)
        }
        let (bytes, _) = try await transport.data(
            for: URLRequest(url: server.url("/control")),
            maximumBytes: 5)
        #expect(bytes == Data("image".utf8))
        #expect(requests.count == 1)
        #expect(requests.first?.hasPrefix("GET /control ") == true)
    }

    @Test(arguments: ["current", "redirect", "expired", "wrong-origin"])
    func `browser authority controls the actual media HTTP request`(_ scenario: String) async throws {
        let tls = try DashboardTLSFixture()
        var otherRequests = 0
        let other = try await DashboardHTTPFixture.start(tlsIdentity: tls.identity, requestHandler: { _ in
            otherRequests += 1
            return Self.imageResponse
        })
        defer { other.stop() }
        var requests: [String] = []
        let cookieName = "media-\(UUID().uuidString)"
        let server = try await DashboardHTTPFixture.start(tlsIdentity: tls.identity, requestHandler: { request in
            requests.append(request)
            return scenario == "redirect"
                ? "HTTP/1.1 302 Found\r\nLocation: \(other.url(Self.ticket))\r\nContent-Length: 0\r\n\r\n"
                : Self.imageResponse.replacingOccurrences(
                    of: "Connection: close",
                    with: "Set-Cookie: \(cookieName)-response=other-account; Secure; Path=/\r\nConnection: close")
        })
        defer { server.stop() }
        let ambient = try #require(HTTPCookie(properties: [
            .name: cookieName, .value: "ambient-account", .originURL: server.url(), .path: "/",
            .secure: "TRUE",
        ]))
        HTTPCookieStorage.shared.setCookie(ambient)
        #expect(HTTPCookieStorage.shared.cookies(for: server.url())?
            .contains { $0.name == cookieName } == true)
        defer {
            for cookie in HTTPCookieStorage.shared.cookies ?? [] where cookie.name.hasPrefix(cookieName) {
                HTTPCookieStorage.shared.deleteCookie(cookie)
            }
        }
        let browser = try gatewayBrowserSessionFixture(
            origin: (scenario == "wrong-origin" ? other.url() : server.url()).absoluteString,
            expiresAt: scenario == "expired" ? Date(timeIntervalSince1970: 1) : Date().addingTimeInterval(300))
        let source = GatewayConnectionEndpointSource(endpoint: Self.endpoint(server, tls: tls, browser: browser))
        let connection = Self.connection(source)
        let outcome: Result<Void, Error>
        do {
            if scenario == "expired" || scenario == "wrong-origin" {
                await #expect(throws: scenario == "expired"
                    ? GatewayBrowserSessionError.expired : GatewayBrowserSessionError.wrongOrigin)
                {
                    _ = try await connection.acquireServerLease()
                }
                #expect(requests.isEmpty)
            } else {
                let lease = try await connection.acquireServerLease()
                let media = try await Self.load(connection, lease: lease)
                #expect(requests.count == 1)
                #expect(requests.first?.lowercased().contains("cf-access-token: synthetic-browser-session") == true)
                if scenario == "redirect" {
                    #expect(media == nil)
                } else {
                    guard case let .data(image) = media else {
                        Issue.record("Expected authenticated image bytes")
                        throw CancellationError()
                    }
                    #expect(image.data == Data("image".utf8))
                    _ = try await Self.load(connection, lease: lease)
                    #expect(requests.count == 2)
                }
            }
            #expect(otherRequests == 0)
            #expect(requests.allSatisfy { !$0.contains(cookieName) })
            #expect(HTTPCookieStorage.shared.cookies?.contains { $0.name == "\(cookieName)-response" } != true)
            outcome = .success(())
        } catch {
            outcome = .failure(error)
        }
        await connection.shutdown()
        try outcome.get()
    }

    @Test(arguments: ["manual-upgrade", "browser-replacement", "expiry"])
    func `retiring authority cancels media waiting for HTTP headers`(_ retirement: String) async throws {
        let tls = try DashboardTLSFixture()
        let gate = GatewayConnectionSuspensionGate()
        var requests: [String] = []
        let server = try await DashboardHTTPFixture.start(
            beforeResponse: { await gate.suspend() },
            tlsIdentity: tls.identity,
            requestHandler: { request in
                requests.append(request)
                return Self.imageResponse
            })
        defer { server.stop() }
        let browser = try gatewayBrowserSessionFixture(
            origin: server.url().absoluteString,
            expiresAt: Date().addingTimeInterval(retirement == "expiry" ? 3 : 300))
        let source = GatewayConnectionEndpointSource(endpoint: Self.endpoint(
            server, tls: tls, browser: retirement == "manual-upgrade" ? nil : browser))
        let connection = Self.connection(source)
        let lease = try await connection.acquireServerLease()
        let media = Task { try await Self.load(connection, lease: lease) }
        let outcome: Result<Void, Error>
        do {
            try await AsyncTimeout.withTimeout(
                seconds: 2,
                onTimeout: { URLError(.timedOut) },
                operation: { await gate.waitUntilStarted() })
            if retirement != "expiry" {
                let successor = try gatewayBrowserSessionFixture(
                    origin: server.url().absoluteString, token: "successor-browser-session")
                source.setEndpoint(Self.endpoint(server, tls: tls, browser: successor))
                _ = try await connection.request(method: "health", params: nil)
            }
            // The fixture withholds headers: rejection must come from retirement,
            // not a completed response discarded by the later lease check.
            let cancelled = try await AsyncTimeout.withTimeout(
                seconds: retirement == "expiry" ? 4 : 2,
                onTimeout: { URLError(.timedOut) },
                operation: {
                    do {
                        _ = try await media.value
                        return false
                    } catch {
                        return error is CancellationError || (error as? URLError)?.code == .cancelled
                    }
                })
            #expect(cancelled)
            await gate.open()
            if retirement != "expiry" {
                let current = try await connection.acquireServerLease()
                guard case .data = try await Self.load(connection, lease: current) else {
                    Issue.record("Replacement authority could not load media")
                    throw CancellationError()
                }
                #expect(requests.last?.lowercased().contains("cf-access-token: successor-browser-session") == true)
            }
            outcome = .success(())
        } catch {
            outcome = .failure(error)
        }
        media.cancel()
        await gate.open()
        await connection.shutdown()
        _ = await media.result
        try outcome.get()
    }

    private static func endpoint(
        _ server: DashboardHTTPFixture,
        tls: DashboardTLSFixture,
        browser: GatewayBrowserSession?) -> GatewayConnection.EndpointSnapshot
    {
        .init(
            config: (server.websocketURL(), browser == nil ? "synthetic-owner" : nil, nil),
            tls: GatewayTLSRoute(
                params: self.tlsParams(tls),
                allowsTrustedPinReplacement: false),
            routeAuthority: nil,
            browserSession: browser)
    }

    private static func connection(_ source: GatewayConnectionEndpointSource) -> GatewayConnection {
        let session = GatewayTestWebSocketSession {
            GatewayTestWebSocketTask(sendHook: { socket, message, index in
                guard index > 0, let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                if GatewayWebSocketTestSupport.requestMethod(from: message) == "artifacts.download" {
                    let response: [String: Any] = [
                        "type": "res", "id": id, "ok": true,
                        "payload": [
                            "artifact": [
                                "id": Self.artifactID, "type": "image", "title": "Synthetic image",
                                "mimeType": "image/png", "sizeBytes": 5, "download": [:],
                            ],
                            "url": Self.ticket,
                        ],
                    ]
                    try socket.emitReceiveSuccess(.data(JSONSerialization.data(withJSONObject: response)))
                } else {
                    socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                }
            })
        }
        return GatewayConnection(
            testEndpointProvider: { source.snapshot() },
            sessionBox: WebSocketSessionBox(session: session))
    }

    private static func tlsParams(_ tls: DashboardTLSFixture) -> GatewayTLSParams {
        GatewayTLSParams(
            required: true,
            expectedFingerprint: SHA256.hash(data: tls.certificate).map { String(format: "%02x", $0) }.joined(),
            allowTOFU: false,
            storeKey: nil)
    }

    private static func load(
        _ connection: GatewayConnection,
        lease: GatewayConnection.ServerLease) async throws -> OpenClawChatLoadedMedia?
    {
        try await connection.loadMediaArtifact(
            sessionKey: "agent:main:media",
            agentID: "main",
            artifactId: self.artifactID,
            kind: .image,
            playback: nil,
            ifCurrentServerLease: lease)
    }

    private static var imageResponse: String {
        "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 5\r\nConnection: close\r\n\r\nimage"
    }
}
