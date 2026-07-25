import Foundation
import Testing
@testable import OpenClaw

/// Gateway custom headers are proxy credentials scoped to one gateway. They ride only the
/// gateway WebSocket upgrade; the push relay is a different trust domain and must never
/// observe them, even while they sit in the store.
private final class CapturingURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private nonisolated(unsafe) static var requests: [URLRequest] = []

    static func drain() -> [URLRequest] {
        self.lock.lock()
        defer { self.lock.unlock() }
        let drained = self.requests
        self.requests = []
        return drained
    }

    private static func record(_ request: URLRequest) {
        self.lock.lock()
        self.requests.append(request)
        self.lock.unlock()
    }

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        Self.record(self.request)
        guard let url = self.request.url,
              let response = HTTPURLResponse(
                  url: url,
                  statusCode: 503,
                  httpVersion: nil,
                  headerFields: ["Content-Type": "application/json"])
        else {
            self.client?.urlProtocol(self, didFailWithError: URLError(.badURL))
            return
        }
        self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        self.client?.urlProtocol(self, didLoad: Data("{}".utf8))
        self.client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

struct PushRelayHeaderIsolationTests {
    @Test func `push relay requests never carry gateway custom headers`() async throws {
        let gatewayID = "manual|proxied.example.com|443|\(UUID().uuidString)"
        defer { GatewaySettingsStore.saveGatewayCustomHeaders([:], gatewayStableID: gatewayID) }
        #expect(GatewaySettingsStore.saveGatewayCustomHeaders(
            ["CF-Access-Client-Id": "client-id", "CF-Access-Client-Secret": "client-secret"],
            gatewayStableID: gatewayID))

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CapturingURLProtocol.self]
        let client = try PushRelayClient(
            baseURL: #require(URL(string: "https://relay.example.invalid")),
            session: URLSession(configuration: configuration))
        let input = PushRelayRegistrationInput(
            installationId: "test-install",
            bundleId: "ai.openclaw.tests",
            appVersion: "1.0",
            environment: .sandbox,
            relayProfile: .deviceSandbox,
            proofPolicy: .appleDevelopment,
            distribution: .local,
            apnsTokenHex: "00",
            gatewayIdentity: PushRelayGatewayIdentity(deviceId: "device", publicKey: "key"))

        // Registration fails at the stubbed challenge; the captured request is what matters.
        _ = try? await client.register(input)

        let requests = CapturingURLProtocol.drain()
        #expect(!requests.isEmpty)
        for request in requests {
            #expect(request.value(forHTTPHeaderField: "CF-Access-Client-Id") == nil)
            #expect(request.value(forHTTPHeaderField: "CF-Access-Client-Secret") == nil)
        }
    }
}
