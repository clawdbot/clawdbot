import ConcurrencyExtras
import Foundation
import OpenClawChatUI
import Testing
import WebKit
@testable import OpenClaw
@testable import OpenClawKit

func gatewayBrowserSessionFixture(
    origin: String = "https://gateway.example.test/",
    subject: String = "fixture-account",
    token: String = "synthetic-browser-session",
    expiresAt: Date = Date().addingTimeInterval(3600)) throws -> GatewayBrowserSession
{
    try GatewayBrowserSession(
        origin: #require(URL(string: origin)),
        issuer: #require(URL(string: "https://issuer.example.test/")),
        audience: "synthetic-application",
        subject: subject,
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
            #"""
            {"version":1,"profiles":[{
              "profile":{"id":"saved","name":"Saved","url":"wss://gateway.example.test/"},
              "credentials":{"token":"owner"}
            }]}
            """#
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
                seconds: 2, onTimeout: { URLError(.timedOut) }, operation: {
                    for await delivery in subscription {
                        if case .snapshot = delivery.push, delivery.isCurrent {
                            return delivery.serverLease
                        }
                    }
                    throw CancellationError()
                })
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
                seconds: 20, onTimeout: { URLError(.timedOut) }, operation: {
                    for await delivery in subscription {
                        if case .disconnected = delivery.event { return delivery }
                    }
                    throw CancellationError()
                })
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
    func `failed same-account renewal refreshes the surviving browser credentials`() async throws {
        try await self.withIsolatedStore { store in
            let host = "failed-renewal-\(UUID().uuidString.lowercased()).example.test"
            let url = try #require(URL(string: "wss://\(host)/"))
            let original = try gatewayBrowserSessionFixture(origin: "https://\(host)/", token: "original-session")
            let initial = try await store.beginBrowserSignIn(url: url)
            let profile = try await store.saveBrowserSession(name: "Saved", session: original, attempt: initial)
            let browser = DashboardBrowserSessionStore.persistent(
                profileID: profile.id, registryNamespace: MacGatewayProfileStore.service, currentSession: original)
            let oldLease = browser.lease(for: original)
            try await oldLease.prepare(for: original.origin, in: WKUserContentController())
            let refreshes = LockIsolated(0)
            let observation = NotificationCenter.default.addObserver(
                forName: MacGatewayProfileStore.didChangeNotification, object: nil, queue: .main)
            { notification in
                if notification.userInfo?[MacGatewayProfileStore.changedProfileIDKey] as? String == profile.id {
                    refreshes.withValue { $0 += 1 }
                }
            }
            defer { NotificationCenter.default.removeObserver(observation) }
            let blockedDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try Data("not a state directory".utf8).write(to: blockedDirectory)
            defer { try? FileManager.default.removeItem(at: blockedDirectory) }
            let result: Result<Void, Error>
            do {
                let replacement = try gatewayBrowserSessionFixture(
                    origin: "https://\(host)/",
                    token: "replacement-session")
                let attempt = try await store.beginBrowserSignIn(url: url)
                await #expect(throws: GatewayBrowserSessionError.credentialRetirementFailed) {
                    try await DeviceIdentityStore.withStateDirectory(blockedDirectory) {
                        try await store.saveBrowserSession(name: "Failed", session: replacement, attempt: attempt)
                    }
                }
                let deadline = ContinuousClock.now + .seconds(2)
                while refreshes.value == 0, ContinuousClock.now < deadline {
                    try await Task.sleep(for: .milliseconds(10))
                }
                #expect(refreshes.value == 1)
                #expect(!oldLease.isCurrent)
                let surviving = try #require(await store.endpoint(profileID: profile.id).browserSession)
                #expect(surviving == original)
                try await browser.lease(for: surviving).prepare(for: surviving.origin, in: WKUserContentController())
                #expect(await browser.dataStore.httpCookieStore.allCookies().first {
                    $0.name == "CF_Authorization"
                }?.value == "original-session")
                result = .success(())
            } catch {
                result = .failure(error)
            }
            try await store.remove(profileID: profile.id)
            try result.get()
        }
    }

    @Test @MainActor
    func `deletion cannot admit an intervening owner while the retired socket shuts down`() async throws {
        try await self.withIsolatedStore { store in
            let host = "deletion-\(UUID().uuidString.lowercased()).example.test"
            let url = try #require(URL(string: "wss://\(host)/"))
            let session = try gatewayBrowserSessionFixture(origin: "https://\(host)/")
            let attempt = try await store.beginBrowserSignIn(url: url)
            let profile = try await store.saveBrowserSession(name: "Deleted", session: session, attempt: attempt)
            let owner = await MacGatewayConnectionFleet.shared.connection(profileID: profile.id)
            let entered = AsyncStream.makeStream(of: Void.self)
            let release = DispatchSemaphore(value: 0)
            defer { release.signal() }
            let held = Task.detached { await owner.holdForDeletionAdmission(
                entered: entered.continuation,
                release: release) }
            var enteredIterator = entered.stream.makeAsyncIterator()
            await enteredIterator.next()
            let removing = AsyncStream.makeStream(of: Void.self)
            let observation = NotificationCenter.default.addObserver(
                forName: MacGatewayProfileStore.willChangePrincipalNotification, object: nil, queue: .main)
            { notification in
                if notification.userInfo?[MacGatewayProfileStore.changedProfileIDKey] as? String == profile.id {
                    removing.continuation.yield()
                }
            }
            defer { NotificationCenter.default.removeObserver(observation) }
            let deletion = Task { try await store.remove(profileID: profile.id) }
            var removalIterator = removing.stream.makeAsyncIterator()
            await removalIterator.next()
            let lookupStarted = AsyncStream.makeStream(of: Void.self)
            let identity = Task {
                try await store.identityDuringDeletion(profileID: profile.id, started: lookupStarted.continuation)
            }
            var lookupIterator = lookupStarted.stream.makeAsyncIterator()
            await lookupIterator.next()
            #expect(try await store.profiles().contains { $0.id == profile.id })
            let binding = Task { try await MacGatewayConnectionFleet.shared.binding(profileID: profile.id) }
            let cancelled = Task { try await store.chatStoreID(profileID: profile.id) }
            cancelled.cancel()
            await #expect(throws: CancellationError.self) { try await cancelled.value }
            release.signal()
            #expect(await held.value)
            _ = try await deletion.value
            await #expect(throws: MacGatewayProfileError.profileNotFound) { try await identity.value }
            await #expect(throws: MacGatewayProfileError.profileNotFound) { try await binding.value }
            let readd = try await store.beginBrowserSignIn(url: url)
            _ = try await store.saveBrowserSession(name: "Re-added", session: session, attempt: readd)
            await #expect(throws: GatewayBrowserSessionError.superseded) {
                try await owner.request(method: "health", params: nil)
            }
            try await store.remove(profileID: profile.id)
        }
    }

    @Test @MainActor
    func `superseded credential retirement cannot remove a successor owner or disconnect its socket`() async throws {
        try await self.withIsolatedStore { store in
            let host = "late-retirement-\(UUID().uuidString.lowercased()).example.test"
            let url = try #require(URL(string: "wss://\(host)/"))
            let session = try gatewayBrowserSessionFixture(origin: "https://\(host)/")
            let stale = try await store.beginBrowserSignIn(url: url)
            let current = try await store.beginBrowserSignIn(url: url)
            let profile = try await store.saveBrowserSession(name: "Successor", session: session, attempt: current)
            let owner = await MacGatewayConnectionFleet.shared.connection(profileID: profile.id)
            let recorder = BrowserSessionWebSocketRecorder()
            let connection = GatewayConnection(
                testEndpointProvider: { try await store.endpoint(profileID: profile.id) },
                sessionBox: WebSocketSessionBox(session: recorder))
            let result: Result<Void, Error>
            do {
                _ = try await connection.request(method: "health", params: nil)
                let lease = try #require(await connection.captureServerLease())
                // Run work admitted by the old attempt only after its successor
                // owns the profile; actor enqueue order cannot grant it authority.
                _ = await MacGatewayConnectionFleet.shared.remove(
                    profileID: profile.id, ifCurrent: { stale.isCurrent })
                await connection.shutdown(ifCurrent: { stale.isCurrent })
                #expect(await MacGatewayConnectionFleet.shared.connection(profileID: profile.id) === owner)
                #expect(await connection.isCurrentServerLease(lease))
                _ = try await connection.request(method: "health", params: nil)
                #expect(recorder.requests.value.count == 1)
                result = .success(())
            } catch {
                result = .failure(error)
            }
            await connection.shutdown()
            try await store.remove(profileID: profile.id)
            try result.get()
        }
    }

    @Test @MainActor
    func `account replacement isolates queued attachments and cannot revive retained transports`() async throws {
        try await self.withIsolatedStore { store in
            let host = "accounts-\(UUID().uuidString.lowercased()).example.test"
            let url = try #require(URL(string: "wss://\(host)/gateway/"))
            let accountA = try gatewayBrowserSessionFixture(origin: "https://\(host)/", subject: "account-a")
            let accountB = try gatewayBrowserSessionFixture(origin: "https://\(host)/", subject: "account-b")
            let attemptA = try await store.beginBrowserSignIn(url: url)
            let profile = try await store.saveBrowserSession(name: "Accounts", session: accountA, attempt: attemptA)
            // This models an active dashboard's store lifetime. Dropping its last
            // owner after setCookie is not a WebKit disk-flush/restart contract.
            let browser = DashboardBrowserSessionStore.persistent(
                profileID: profile.id, registryNamespace: MacGatewayProfileStore.service, currentSession: accountA)
            try await self.setBrowserPreference(in: browser, origin: accountA.origin)
            #expect(await self.browserPreference(in: browser) == "dark")
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: directory) }
            let result: Result<Void, Error>
            do {
                let first = try await MacGatewayConnectionFleet.shared.binding(profileID: profile.id)
                let firstStoreID = first.chatStoreID
                let outboxA = try #require(MacChatTranscriptCache.store(
                    databaseDirectoryURL: directory, gatewayID: firstStoreID))
                let attachment = OpenClawChatOutboxAttachment(
                    type: "file", mimeType: "text/plain", fileName: "account-a.txt", data: Data("private-a".utf8))
                #expect(await outboxA.enqueueCommand(OpenClawChatOutboxCommand(
                    id: UUID().uuidString,
                    sessionKey: "main",
                    text: "Queued by account A",
                    attachments: [attachment],
                    thinking: "off",
                    createdAt: Date().timeIntervalSince1970,
                    status: .queued,
                    retryCount: 0,
                    lastError: nil)))

                let renewal = try gatewayBrowserSessionFixture(
                    origin: "https://\(host)/", subject: "account-a", token: "renewed-token")
                let renewalAttempt = try await store.beginBrowserSignIn(url: url)
                _ = try await store.saveBrowserSession(name: "Accounts", session: renewal, attempt: renewalAttempt)
                let renewed = try await MacGatewayConnectionFleet.shared.binding(profileID: profile.id)
                #expect(renewed.chatStoreID == firstStoreID)
                #expect(renewed.connection === first.connection)
                #expect(await self.browserPreference(in: browser) == "dark")

                let attemptB = try await store.beginBrowserSignIn(url: url)
                _ = try await store.saveBrowserSession(name: "Accounts", session: accountB, attempt: attemptB)
                let second = try await MacGatewayConnectionFleet.shared.binding(profileID: profile.id)
                #expect(second.connection !== first.connection)
                #expect(await self.browserPreference(in: browser) == nil)
                let secondStoreID = second.chatStoreID
                #expect(secondStoreID != firstStoreID)
                let outboxB = try #require(MacChatTranscriptCache.store(
                    databaseDirectoryURL: directory, gatewayID: secondStoreID))
                #expect(await outboxB.loadCommands().isEmpty)
                #expect(await outboxB.claimNextCommand() == nil)
                await #expect(throws: GatewayBrowserSessionError.superseded) {
                    try await first.connection.request(method: "chat.send", params: nil)
                }

                let returnAttempt = try await store.beginBrowserSignIn(url: url)
                _ = try await store.saveBrowserSession(name: "Accounts", session: renewal, attempt: returnAttempt)
                let returned = try await MacGatewayConnectionFleet.shared.binding(profileID: profile.id)
                #expect(returned.chatStoreID == firstStoreID)
                #expect(returned.connection !== first.connection)
                let restored = try #require(MacChatTranscriptCache.store(
                    databaseDirectoryURL: directory, gatewayID: returned.chatStoreID))
                let commands = await restored.loadCommands()
                #expect(commands.map(\.text) == ["Queued by account A"])
                #expect(commands.first?.attachments == [attachment])
                await #expect(throws: GatewayBrowserSessionError.superseded) {
                    try await first.connection.request(method: "chat.send", params: nil)
                }
                await #expect(throws: GatewayBrowserSessionError.superseded) {
                    try await second.connection.request(method: "chat.send", params: nil)
                }
                let manualAttempt = try await store.beginBrowserSignIn(url: url)
                _ = try await store.saveConnection(
                    name: "Accounts", token: "explicit-owner", password: nil, attempt: manualAttempt)
                let manual = try await MacGatewayConnectionFleet.shared.binding(profileID: profile.id)
                #expect(manual.chatStoreID == profile.id)
                await #expect(throws: GatewayBrowserSessionError.superseded) {
                    try await returned.connection.request(method: "chat.send", params: nil)
                }
                try await store.remove(profileID: profile.id)
                let readd = try await store.beginBrowserSignIn(url: url)
                _ = try await store.saveBrowserSession(name: "Accounts", session: renewal, attempt: readd)
                try await self.setBrowserPreference(in: browser, origin: accountA.origin)
                await #expect(throws: GatewayBrowserSessionError.superseded) {
                    try await manual.connection.request(method: "chat.send", params: nil)
                }
                result = .success(())
            } catch {
                result = .failure(error)
            }
            if try await store.profiles().contains(where: { $0.id == profile.id }) {
                try await store.remove(profileID: profile.id)
            }
            #expect(await self.browserPreference(in: browser) == nil)
            try result.get()
        }
    }

    @Test @MainActor
    func `browser sign-in atomically replaces Owner and survives reopening the profile store`() async throws {
        try await self.withIsolatedStore { store in
            let host = "signin-\(UUID().uuidString.lowercased()).example.test"
            let url = try #require(URL(string: "wss://\(host)/gateway/"))
            let session = try gatewayBrowserSessionFixture(origin: "https://\(host)/")
            let initial = try await store.beginBrowserSignIn(url: url)
            let profile = try await store.saveConnection(
                name: "Before",
                token: "owner",
                password: nil,
                attempt: initial)
            let observedConnection = await MacGatewayConnectionFleet.shared.connection(profileID: profile.id)
            let identity = try #require(DeviceIdentityStore.loadOrCreatePersisted())
            #expect(DeviceAuthStore.storeTokenPersisted(
                deviceId: identity.deviceId, role: "operator", token: "old-device-owner", gatewayID: profile.id))
            let result: Result<Void, Error>
            do {
                let attempt = try await store.beginBrowserSignIn(url: url)
                let saved = try await store.saveBrowserSession(name: "Personal", session: session, attempt: attempt)
                #expect(saved.id == profile.id)
                let browserConnection = await MacGatewayConnectionFleet.shared.connection(profileID: profile.id)
                #expect(browserConnection !== observedConnection)
                await #expect(throws: GatewayBrowserSessionError.superseded) {
                    try await observedConnection.request(method: "health", params: nil)
                }
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
                #expect(await MacGatewayConnectionFleet.shared.connection(profileID: profile.id) === browserConnection)
                #expect(try await store.endpoint(profileID: profile.id).browserSession == successor)
                result = .success(())
            } catch {
                result = .failure(error)
            }
            let removedConnection = await MacGatewayConnectionFleet.shared.connection(profileID: profile.id)
            try await store.remove(profileID: profile.id)
            await #expect(throws: GatewayBrowserSessionError.superseded) {
                try await removedConnection.request(method: "health", params: nil)
            }
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
            let initial = try await store.beginBrowserSignIn(url: url)
            let profile = try await store.saveConnection(
                name: "Before",
                token: "owner",
                password: nil,
                attempt: initial)
            let attempt = try await store.beginBrowserSignIn(url: url)
            let result: Result<Void, Error>
            do {
                switch mutation {
                case "cancelled": await store.cancelBrowserSignIn(attempt)
                case "superseded":
                    let next = try await store.beginBrowserSignIn(url: url)
                    await store.cancelBrowserSignIn(next)
                case "edited":
                    let edit = try await store.beginBrowserSignIn(url: url)
                    _ = try await store.saveConnection(
                        name: "Edited",
                        token: "replacement",
                        password: nil,
                        attempt: edit)
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
    private func setBrowserPreference(in store: DashboardBrowserSessionStore, origin: URL) async throws {
        let cookie = try #require(HTTPCookie(properties: [
            .name: "ui-theme", .value: "dark", .originURL: origin, .path: "/",
            .expires: Date().addingTimeInterval(3600),
        ]))
        await store.dataStore.httpCookieStore.setCookie(cookie)
    }

    @MainActor
    private func browserPreference(in store: DashboardBrowserSessionStore) async -> String? {
        await store.dataStore.httpCookieStore.allCookies().first { $0.name == "ui-theme" }?.value
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
                try await body(MacGatewayProfileStore.shared)
            }
        }
    }
}

extension GatewayConnection {
    fileprivate func holdForDeletionAdmission(
        entered: AsyncStream<Void>.Continuation,
        release: DispatchSemaphore) -> Bool
    {
        entered.yield()
        return release.wait(timeout: .now() + 10) == .success
    }
}

extension MacGatewayProfileStore {
    fileprivate func identityDuringDeletion(
        profileID: String,
        started: AsyncStream<Void>.Continuation) async throws -> String
    {
        started.yield()
        return try await self.chatStoreID(profileID: profileID)
    }
}
