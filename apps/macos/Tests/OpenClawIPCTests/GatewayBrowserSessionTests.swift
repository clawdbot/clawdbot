import ConcurrencyExtras
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

func gatewayBrowserSessionFixture(
    origin: String = "https://gateway.example.test/",
    token: String = "synthetic-browser-session",
    expiresAt: Date = Date().addingTimeInterval(3600)) throws -> GatewayBrowserSession
{
    try GatewayBrowserSession(
        origin: #require(URL(string: origin)),
        issuer: #require(URL(string: "https://issuer.example.test/")),
        audience: "synthetic-application",
        token: token,
        expiresAt: expiresAt)
}

struct GatewayBrowserSessionTests {
    @Test func `browser session persists and projects only its issuer cookie and header`() throws {
        let original = try gatewayBrowserSessionFixture(origin: "https://GATEWAY.example.test:443/")
        let session = try JSONDecoder().decode(
            GatewayBrowserSession.self, from: JSONEncoder().encode(original))
        #expect(session == original)
        #expect(session.origin.absoluteString == "https://gateway.example.test/")
        let cookie = try session.cookie()
        #expect(cookie.name == "CF_Authorization")
        #expect(cookie.value == "synthetic-browser-session")
        #expect(cookie.domain == "gateway.example.test")
        #expect(cookie.path == "/")
        #expect(cookie.isSecure)
        #expect(cookie.isHTTPOnly)
        #expect(try abs(#require(cookie.expiresDate).timeIntervalSince(session.expiresAt)) < 1)
        #expect(try session.headers(for: #require(URL(string: "wss://gateway.example.test:443/team/"))) == [
            "CF-Access-Token": cookie.value,
        ])
    }

    @Test(arguments: [
        "http://gateway.example.test/", "ws://gateway.example.test/",
        "https://other.example.test/", "https://gateway.example.test:8443/",
        "https://gateway.example.test.attacker.test/", "https://user@gateway.example.test/",
    ])
    func `browser session never supplies credentials to another authority`(_ destination: String) throws {
        let session = try gatewayBrowserSessionFixture()
        #expect(throws: GatewayBrowserSessionError.wrongOrigin) {
            try session.headers(for: #require(URL(string: destination)))
        }
    }

    @Test func `expired browser session remains readable but cannot authenticate`() throws {
        let session = try gatewayBrowserSessionFixture(expiresAt: Date(timeIntervalSince1970: 1))
        let restored = try JSONDecoder().decode(
            GatewayBrowserSession.self, from: JSONEncoder().encode(session))
        #expect(throws: GatewayBrowserSessionError.expired) { try restored.cookie() }
        #expect(throws: GatewayBrowserSessionError.expired) {
            try restored.headers(for: #require(URL(string: "https://gateway.example.test/")))
        }
    }

    @Test(arguments: ["value\r\nInjected: true", "cookie; injected=value", "value,other", ""])
    func `issuer credential rejects request splitting and cookie delimiters`(_ token: String) {
        #expect(throws: GatewayBrowserSessionError.invalidSession) {
            try gatewayBrowserSessionFixture(token: token)
        }
    }

    @Test func `old Keychain registry remains readable and empty forms preserve browser sign-in`() throws {
        let old = Data(
            #"{"version":1,"profiles":[{"profile":{"id":"saved","name":"Saved","url":"wss://gateway.example.test/"},"credentials":{"token":"owner"}}]}"#
                .utf8)
        let registry = try JSONDecoder().decode(MacGatewayProfileStore.Registry.self, from: old)
        #expect(registry.profiles.first?.credentials.browserSession == nil)
        let saved = try MacGatewayProfileStore.Credentials(
            token: nil, password: nil, browserSession: gatewayBrowserSessionFixture())
        #expect(MacGatewayProfileStore.resolvedCredentials(
            saved: saved, submittedToken: " ", submittedPassword: nil) == saved)
        let replacement = MacGatewayProfileStore.resolvedCredentials(
            saved: saved, submittedToken: "explicit-owner", submittedPassword: nil)
        #expect(replacement.browserSession == nil)
        #expect(replacement.token == "explicit-owner")
    }
}

private final class BrowserSessionWebSocketRecorder: WebSocketSessioning, @unchecked Sendable {
    let requests = LockIsolated<[URLRequest]>([])
    let connectHasCredentials = LockIsolated<[Bool]>([])
    let sentMessageCount = LockIsolated(0)
    private lazy var session = GatewayTestWebSocketSession { [connectHasCredentials, sentMessageCount] in
        GatewayTestWebSocketTask(sendHook: { socket, message, index in
            sentMessageCount.withValue { $0 += 1 }
            if index == 0 {
                let params = GatewayWebSocketTestSupport.connectRequestParams(from: message)
                let hasCredentials = params?["auth"] != nil
                connectHasCredentials.withValue { $0.append(hasCredentials) }
            } else if let id = GatewayWebSocketTestSupport.requestID(from: message) {
                socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
            }
        })
    }

    func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
        self.makeWebSocketTask(request: URLRequest(url: url))
    }

    func makeWebSocketTask(request: URLRequest) -> WebSocketTaskBox {
        self.requests.withValue { $0.append(request) }
        return self.session.makeWebSocketTask(request: request)
    }
}

struct GatewayConnectionBrowserSessionTests {
    @Test(arguments: [false, true])
    func `browser credential replacement retires route and preserves subscribed observers`(
        disconnectBeforeSave: Bool) async throws
    {
        let url = try #require(URL(string: "wss://gateway.example.test/team/"))
        let original = try gatewayBrowserSessionFixture(token: "first-browser-session")
        let replacement = try gatewayBrowserSessionFixture(token: "second-browser-session")
        let source = GatewayConnectionEndpointSource(endpoint: .init(
            config: (url, "stale-owner-token", "stale-owner-password"),
            routeAuthority: 1,
            deviceAuthGatewayID: "stale-device-owner",
            browserSession: original))
        let recorder = BrowserSessionWebSocketRecorder()
        let connection = GatewayConnection(
            testEndpointProvider: { source.snapshot() },
            sessionBox: WebSocketSessionBox(session: recorder))
        let subscription = await connection.subscribe()
        let result: Result<Void, Error>
        do {
            _ = try await connection.request(method: "health", params: nil)
            let oldLease = try #require(await connection.captureServerLease())
            #expect(oldLease.route.browserSession == original)
            if disconnectBeforeSave { await connection.shutdown() }
            source.setEndpoint(.init(
                config: (url, "stale-owner-token", "stale-owner-password"),
                routeAuthority: 1,
                deviceAuthGatewayID: "stale-device-owner",
                browserSession: replacement))
            #expect(await connection.isCurrentServerLease(oldLease) == false)
            _ = try await connection.request(method: "health", params: nil)
            let successor = try await AsyncTimeout.withTimeout(
                seconds: 2, onTimeout: { URLError(.timedOut) })
            {
                for await delivery in subscription {
                    if case .snapshot = delivery.push, delivery.isCurrent {
                        return delivery.serverLease
                    }
                }
                throw CancellationError()
            }
            #expect(successor != oldLease)
            #expect(successor.route.browserSession == replacement)
            #expect(recorder.requests.value.map { $0.value(forHTTPHeaderField: "CF-Access-Token") } == [
                "first-browser-session", "second-browser-session",
            ])
            #expect(recorder.connectHasCredentials.value == [false, false])
            #expect(await connection.controlUiAutoAuthToken(config: source.snapshot().config) == nil)
            result = .success(())
        } catch {
            result = .failure(error)
        }
        await connection.shutdown()
        try result.get()
    }

    @Test func `expired browser credential fails before opening a socket`() async throws {
        let url = try #require(URL(string: "wss://gateway.example.test/"))
        let session = try gatewayBrowserSessionFixture(expiresAt: Date(timeIntervalSince1970: 1))
        let recorder = BrowserSessionWebSocketRecorder()
        let connection = GatewayConnection(
            testEndpointProvider: {
                .init(config: (url, nil, nil), routeAuthority: nil, browserSession: session)
            },
            sessionBox: WebSocketSessionBox(session: recorder))
        await #expect(throws: GatewayBrowserSessionError.expired) {
            try await connection.request(method: "health", params: nil)
        }
        #expect(recorder.requests.value.isEmpty)
        await connection.shutdown()
    }

    @Test func `scheduled browser expiry retires an authenticated connection and denies later requests`() async throws {
        let url = try #require(URL(string: "wss://gateway.example.test/"))
        let recorder = BrowserSessionWebSocketRecorder()
        let session = try gatewayBrowserSessionFixture(expiresAt: Date().addingTimeInterval(15))
        let connection = GatewayConnection(
            testEndpointProvider: {
                .init(config: (url, nil, nil), routeAuthority: nil, browserSession: session)
            },
            sessionBox: WebSocketSessionBox(session: recorder))
        let subscription = await connection.subscribe()
        let result: Result<Void, Error>
        do {
            _ = try await connection.request(method: "health", params: nil)
            let lease = try #require(await connection.captureServerLease())
            #expect(await connection.isCurrentServerLease(lease))
            let sentBeforeExpiry = recorder.sentMessageCount.value
            let retirement = try await AsyncTimeout.withTimeout(
                seconds: 20, onTimeout: { URLError(.timedOut) })
            {
                for await delivery in subscription {
                    if case .disconnected = delivery.event { return delivery }
                }
                throw CancellationError()
            }
            #expect(retirement.serverLease == lease)
            guard case let .disconnected(reason) = retirement.event else {
                throw CancellationError()
            }
            #expect(reason == GatewayBrowserSessionError.expired.localizedDescription)
            #expect(await connection.isCurrentServerLease(lease) == false)
            await #expect(throws: GatewayBrowserSessionError.expired) {
                try await connection.request(method: "health", params: nil)
            }
            #expect(recorder.requests.value.count == 1)
            #expect(recorder.sentMessageCount.value == sentBeforeExpiry)
            result = .success(())
        } catch {
            result = .failure(error)
        }
        await connection.shutdown()
        try result.get()
    }
}

@Suite(.serialized)
struct MacGatewayBrowserSessionStoreTests {
    @Test @MainActor
    func `browser sign-in atomically replaces Owner and survives reopening the profile store`() async throws {
        try await self.withIsolatedStore { store in
            let host = "signin-\(UUID().uuidString.lowercased()).example.test"
            let url = try #require(URL(string: "wss://\(host)/gateway/"))
            let session = try gatewayBrowserSessionFixture(origin: "https://\(host)/")
            let profile = try await store.upsert(name: "Before", url: url, token: "owner", password: nil)
            let observedConnection = await MacGatewayConnectionFleet.shared.connection(profileID: profile.id)
            let identity = try #require(DeviceIdentityStore.loadOrCreatePersisted())
            #expect(DeviceAuthStore.storeTokenPersisted(
                deviceId: identity.deviceId, role: "operator", token: "old-device-owner", gatewayID: profile.id))
            let result: Result<Void, Error>
            do {
                let attempt = try await store.beginBrowserSignIn(url: url)
                let saved = try await store.saveBrowserSession(name: "Personal", session: session, attempt: attempt)
                #expect(saved.id == profile.id)
                #expect(await MacGatewayConnectionFleet.shared.connection(profileID: profile.id) === observedConnection)
                let reopened = try await MacGatewayProfileStore().endpoint(profileID: profile.id)
                #expect(reopened.config.url.absoluteString == "wss://\(host):443/gateway/")
                #expect(reopened.config.token == nil)
                #expect(reopened.config.password == nil)
                #expect(reopened.deviceAuthGatewayID == nil)
                #expect(reopened.browserSession == session)
                #expect(reopened.tls == nil)
                #expect(DeviceAuthStore.loadToken(
                    deviceId: identity.deviceId, role: "operator", gatewayID: profile.id) == nil)
                await #expect(throws: GatewayBrowserSessionError.superseded) {
                    try await store.saveBrowserSession(name: "Replay", session: session, attempt: attempt)
                }
                let reconnect = try await store.beginBrowserSignIn(url: url)
                let successor = try gatewayBrowserSessionFixture(
                    origin: "https://\(host)/", token: "successor-browser-session")
                _ = try await store.saveBrowserSession(name: "Personal", session: successor, attempt: reconnect)
                #expect(await MacGatewayConnectionFleet.shared.connection(profileID: profile.id) === observedConnection)
                #expect(try await store.endpoint(profileID: profile.id).browserSession == successor)
                result = .success(())
            } catch {
                result = .failure(error)
            }
            try await store.remove(profileID: profile.id)
            let removedConnection = await MacGatewayConnectionFleet.shared.remove(profileID: profile.id)
            #expect(removedConnection === observedConnection)
            try result.get()
        }
    }

    @Test(arguments: ["cancelled", "superseded", "edited", "removed"])
    @MainActor
    func `late sign-in and direct discovery cannot resurrect changed profiles`(_ mutation: String) async throws {
        try await self.withIsolatedStore { store in
            let host = "signin-\(UUID().uuidString.lowercased()).example.test"
            let url = try #require(URL(string: "wss://\(host)/gateway/"))
            let session = try gatewayBrowserSessionFixture(origin: "https://\(host)/")
            let profile = try await store.upsert(name: "Before", url: url, token: "owner", password: nil)
            let attempt = try await store.beginBrowserSignIn(url: url)
            let result: Result<Void, Error>
            do {
                switch mutation {
                case "cancelled": await store.cancelBrowserSignIn(attempt)
                case "superseded":
                    let next = try await store.beginBrowserSignIn(url: url)
                    await store.cancelBrowserSignIn(next)
                case "edited":
                    _ = try await store.upsert(name: "Edited", url: url, token: "replacement", password: nil)
                default: try await store.remove(profileID: profile.id)
                }
                await #expect(throws: GatewayBrowserSessionError.superseded) {
                    try await store.saveBrowserSession(name: "Late", session: session, attempt: attempt)
                }
                await #expect(throws: GatewayBrowserSessionError.superseded) {
                    try await store.saveConnection(name: "Late", token: nil, password: nil, attempt: attempt)
                }
                let saved = try await store.profiles().first { $0.id == profile.id }
                #expect(saved?.name == (mutation == "removed" ? nil : mutation == "edited" ? "Edited" : "Before"))
                result = .success(())
            } catch {
                result = .failure(error)
            }
            if mutation != "removed" { try await store.remove(profileID: profile.id) }
            try result.get()
        }
    }

    @Test(arguments: [true, false])
    @MainActor
    func `cancelled editor cannot commit either browser or direct credentials`(_ browser: Bool) async throws {
        try await self.withIsolatedStore { store in
            let host = "signin-\(UUID().uuidString.lowercased()).example.test"
            let url = try #require(URL(string: "wss://\(host)/"))
            let session = try gatewayBrowserSessionFixture(origin: "https://\(host)/")
            let attempt = try await store.beginBrowserSignIn(url: url)
            let gate = GatewayConnectionSuspensionGate()
            let pending = Task {
                await gate.suspend()
                return if browser {
                    try await store.saveBrowserSession(name: "Cancelled", session: session, attempt: attempt)
                } else {
                    try await store.saveConnection(name: "Cancelled", token: "owner", password: nil, attempt: attempt)
                }
            }
            await gate.waitUntilStarted()
            pending.cancel()
            await gate.open()
            await #expect(throws: CancellationError.self) { try await pending.value }
            await store.cancelBrowserSignIn(attempt)
            #expect(try await store.profiles().contains { $0.id == attempt.profileID } == false)
        }
    }

    @MainActor
    private func withIsolatedStore(_ body: (MacGatewayProfileStore) async throws -> Void) async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("gateway-browser-store-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try await TestIsolation.withIsolatedState(env: [
            "OPENCLAW_CONFIG_PATH": directory.appendingPathComponent("openclaw.json").path,
            "OPENCLAW_STATE_DIR": directory.path,
        ]) {
            try await DeviceIdentityStore.withStateDirectory(directory) {
                try await body(MacGatewayProfileStore())
            }
        }
    }
}
