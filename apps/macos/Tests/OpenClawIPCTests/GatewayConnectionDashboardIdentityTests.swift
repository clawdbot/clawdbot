import AppKit
import ConcurrencyExtras
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

struct DashboardIdentityFixture: Sendable {
    let config: GatewayConnection.Config
    let source: GatewayConnectionEndpointSource
    let announcement: LockIsolated<String?>
    let requests: LockIsolated<[String]>
    let suspendEndpoint: LockIsolated<Bool>
    let connection: GatewayConnection
    let session: GatewayTestWebSocketSession

    init(
        announcement: String?,
        endpointGate: GatewayConnectionSuspensionGate? = nil,
        source: GatewayConnectionEndpointSource? = nil) throws
    {
        let config: GatewayConnection.Config = try source?.snapshot().config ?? (
            #require(URL(string: "ws://127.0.0.1:28901")), "synthetic-owner-token", nil)
        let source = source ?? GatewayConnectionEndpointSource(endpoint: .init(
            config: config, routeAuthority: 1, revision: 1))
        let announcement = LockIsolated(announcement)
        let requests = LockIsolated<[String]>([])
        let suspendEndpoint = LockIsolated(false)
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0, let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                let data: Data = switch message {
                case let .data(data): data
                case let .string(string): Data(string.utf8)
                @unknown default: Data()
                }
                let frame = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                let method = try #require(frame?["method"] as? String)
                requests.withValue { $0.append(method) }
                socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
            }, receiveHook: { socket, index in
                if index == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
                let data = GatewayWebSocketTestSupport.connectOkData(id: socket.snapshotConnectRequestID() ?? "connect")
                guard let identityURL = announcement.value else { return .data(data) }
                var frame = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
                var payload = try #require(frame["payload"] as? [String: Any])
                var snapshot = try #require(payload["snapshot"] as? [String: Any])
                snapshot["controlUiIdentityUrl"] = identityURL
                payload["snapshot"] = snapshot
                frame["payload"] = payload
                return try .data(JSONSerialization.data(withJSONObject: frame))
            })
        })
        self.config = config
        self.source = source
        self.announcement = announcement
        self.requests = requests
        self.suspendEndpoint = suspendEndpoint
        self.session = session
        let currentEndpointRevision: (@Sendable () -> UInt64)? =
            source.snapshot().revision == nil ? nil : { @Sendable in source.snapshot().revision! }
        self.connection = GatewayConnection(
            testEndpointProvider: {
                if suspendEndpoint.value { await endpointGate?.suspend() }
                return source.snapshot()
            },
            currentEndpointRevision: currentEndpointRevision,
            sessionBox: WebSocketSessionBox(session: session))
    }

    func reconnect(announcement: String?) async throws {
        let lease = try #require(await self.connection.captureServerLease())
        self.announcement.withValue { $0 = announcement }
        self.session.latestTask()?.emitReceiveFailure()
        let deadline = ContinuousClock.now + .seconds(3)
        while self.connection.serverLeaseMatchesCurrentState(lease), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        try #require(!self.connection.serverLeaseMatchesCurrentState(lease))
        _ = try await self.connection.request(method: "health", params: nil)
        try #require(try await self.connection.controlUiBrowserIdentityURL(config: self.config)?.absoluteString ==
            announcement)
    }
}

@Suite(.serialized)
struct GatewayConnectionDashboardIdentityTests {
    @Test(arguments: [nil, "https://team.example.test/", "https://renewed.example.test/"])
    @MainActor
    func `open saved profile windows follow their native connection identity`(announcement: String?) async throws {
        try await TestIsolation.withIsolatedState {
            _ = AppKitTestSupport.application
            let originalURL = try #require(URL(string: "https://team.example.test/"))
            let fixture = try DashboardIdentityFixture(announcement: originalURL.absoluteString)
            let target = DashboardGatewayTarget.profile("identity-reconnect")
            let manager = DashboardManager._testMake(
                connectionProvider: { _ in fixture.connection },
                browserIdentityURLProvider: nil,
                observeGatewayChanges: true,
                profileEndpointProvider: { _ in fixture.source.snapshot() },
                gatewayEntriesProvider: {
                    [DashboardGatewayEntry(
                        id: target.bridgeID,
                        name: "Saved Gateway",
                        kind: "remote",
                        isPrimary: false,
                        canPromote: true,
                        health: .unknown)]
                })
            let result: Result<Void, Error>
            do {
                await manager._testOpenWindow(for: target)
                await manager._testOpenWindow(for: target)
                let originals = manager._testAuxiliaryWindows().map(\.controller)
                try #require(originals.count == 2)
                let windows = originals.compactMap(\.window)
                try #require(windows.count == 2)
                try #require(originals.allSatisfy { $0.currentURL == originalURL && $0.auth.usesBrowserIdentity })
                let lease = try #require(await fixture.connection.captureServerLease())

                // Serve withdraws its announcement before retiring connections that received it.
                fixture.announcement.withValue { $0 = announcement }
                fixture.session.latestTask()?.emitReceiveFailure()
                let retired = ContinuousClock.now + .seconds(3)
                while await fixture.connection.isCurrentServerLease(lease), ContinuousClock.now < retired {
                    try await Task.sleep(for: .milliseconds(10))
                }
                try #require(await fixture.connection.isCurrentServerLease(lease) == false)
                _ = try await fixture.connection.request(method: "health", params: nil)
                try #require(try await fixture.connection.controlUiBrowserIdentityURL(config: fixture.config)?
                    .absoluteString == announcement)

                let expectedURL = try announcement.flatMap(URL.init(string:)) ?? GatewayEndpointStore.dashboardURL(
                    for: fixture.config, mode: .remote, authToken: fixture.config.token)
                let unchanged = announcement == originalURL.absoluteString
                let refreshed = ContinuousClock.now + .seconds(5)
                while unchanged || manager._testAuxiliaryWindows().contains(where: {
                    $0.controller.currentURL != expectedURL
                }),
                    ContinuousClock.now < refreshed
                {
                    try await Task.sleep(for: .milliseconds(10))
                }
                let current = manager._testAuxiliaryWindows()
                #expect(current.count == 2)
                #expect(current.allSatisfy { $0.target == target && $0.controller.currentURL == expectedURL })
                #expect(current.allSatisfy { instance in windows.contains { $0 === instance.controller.window } })
                #expect(current.allSatisfy { $0.controller.auth.usesBrowserIdentity == (announcement != nil) })
                #expect(current
                    .allSatisfy { $0.controller.auth.token == (announcement == nil ? fixture.config.token : nil) })
                #expect(current.allSatisfy { instance in
                    originals.contains { $0 === instance.controller } == unchanged
                })
                result = .success(())
            } catch {
                result = .failure(error)
            }
            manager.close()
            await fixture.connection.shutdown()
            try result.get()
        }
    }

    @Test(arguments: [nil, "https://team.example.test/", "https://team.example.test/team/"])
    func `first open reads the authenticated hello without admin discovery RPCs`(announcement: String?) async throws {
        let fixture = try DashboardIdentityFixture(announcement: announcement)
        #expect(try await fixture.connection.controlUiBrowserIdentityURL(config: fixture.config)?.absoluteString ==
            announcement)
        #expect(try await fixture.connection.controlUiBrowserIdentityURL(config: fixture.config)?.absoluteString ==
            announcement)
        #expect(fixture.requests.value == ["health"])
        await fixture.connection.shutdown()
    }

    @Test(arguments: ["closed", "switched", "retired", "other-retired"])
    @MainActor
    func `late profile reconciliation cannot replace a retired window or connection`(_ action: String) async throws {
        try await TestIsolation.withIsolatedState {
            _ = AppKitTestSupport.application
            let originalURL = try #require(URL(string: "https://team.example.test/"))
            let endpointGate = GatewayConnectionSuspensionGate()
            let fixture = try DashboardIdentityFixture(
                announcement: originalURL.absoluteString, endpointGate: endpointGate)
            let otherEndpointGate = GatewayConnectionSuspensionGate()
            let other = try DashboardIdentityFixture(
                announcement: "https://other.example.test/", endpointGate: otherEndpointGate)
            let target = DashboardGatewayTarget.profile("held-identity")
            let otherTarget = DashboardGatewayTarget.profile("other-identity")
            let gate = DashboardWindowOwnershipPresentationGate()
            let held = LockIsolated(false)
            let returned = LockIsolated(false)
            let manager = DashboardManager._testMake(
                connectionProvider: { $0 == target ? fixture.connection : other.connection },
                browserIdentityURLProvider: { selected, config in
                    let connection = selected == target ? fixture.connection : other.connection
                    let url = try await connection.controlUiBrowserIdentityURL(config: config)
                    if selected == target, url?.host == "renewed.example.test" {
                        held.setValue(true)
                        await gate.waitForRelease()
                        returned.setValue(true)
                    }
                    return url
                },
                observeGatewayChanges: true,
                profileEndpointProvider: { profileID in
                    profileID == "held-identity" ? fixture.source.snapshot() : other.source.snapshot()
                },
                gatewayEntriesProvider: {
                    [target, otherTarget].map {
                        DashboardGatewayEntry(
                            id: $0.bridgeID,
                            name: $0.bridgeID,
                            kind: "remote",
                            isPrimary: false,
                            canPromote: true,
                            health: .unknown)
                    }
                })
            let result: Result<Void, Error>
            do {
                await manager._testOpenWindow(for: target)
                await manager._testOpenWindow(for: otherTarget)
                let original = try #require(manager._testAuxiliaryWindows().first { $0.target == target }?.controller)
                let originalWindow = try #require(original.window)
                let unrelated = try #require(manager._testAuxiliaryWindows().first { $0.target == otherTarget }?
                    .controller)
                let unrelatedLease = try #require(await other.connection.captureServerLease())
                try await fixture.reconnect(announcement: "https://renewed.example.test/")
                let requested = ContinuousClock.now + .seconds(5)
                while !held.value, ContinuousClock.now < requested {
                    try await Task.sleep(for: .milliseconds(10))
                }
                try #require(held.value, "A fresh profile snapshot must reach dashboard reconciliation")
                switch action {
                case "closed": originalWindow.performClose(nil)
                case "switched": await manager._testSwitchTarget(otherTarget, in: original)
                case "other-retired":
                    other.suspendEndpoint.setValue(true)
                    await other.connection.shutdown()
                default:
                    fixture.suspendEndpoint.setValue(true)
                    await fixture.connection.shutdown()
                }
                await gate.release()
                // Observe delayed work after release; absence at the release boundary alone proves nothing.
                let settled = ContinuousClock.now + .seconds(5)
                while ContinuousClock.now < settled {
                    let current = manager._testAuxiliaryWindows()
                    let survivor = current.first { $0.controller.window === originalWindow }
                    try #require(current.contains { $0.controller === unrelated && $0.target == otherTarget })
                    switch action {
                    case "closed": try #require(survivor == nil)
                    case "switched": try #require(survivor?.target == otherTarget)
                    case "other-retired": break
                    default: try #require(survivor?.controller === original && original.currentURL == originalURL)
                    }
                    try await Task.sleep(for: .milliseconds(20))
                }
                #expect(returned.value)
                if action == "other-retired" {
                    let replacement = try #require(originalWindow.windowController as? DashboardWindowController)
                    #expect(replacement !== original)
                    #expect(replacement.currentURL.absoluteString == "https://renewed.example.test/")
                    #expect(!other.connection.serverLeaseMatchesCurrentState(unrelatedLease))
                }
                if action == "retired" {
                    fixture.announcement.setValue(nil)
                    fixture.suspendEndpoint.setValue(false)
                    await endpointGate.open()
                    _ = try await fixture.connection.request(method: "health", params: nil)
                    let recovered = ContinuousClock.now + .seconds(5)
                    while originalWindow.windowController === original, ContinuousClock.now < recovered {
                        try await Task.sleep(for: .milliseconds(10))
                    }
                    let replacement = try #require(originalWindow.windowController as? DashboardWindowController)
                    #expect(replacement !== original)
                    #expect(!replacement.auth.usesBrowserIdentity)
                    #expect(replacement.auth.token == fixture.config.token)
                }
                result = .success(())
            } catch {
                result = .failure(error)
            }
            manager.close()
            await gate.release()
            fixture.suspendEndpoint.setValue(false)
            await endpointGate.open()
            other.suspendEndpoint.setValue(false)
            await otherEndpointGate.open()
            await fixture.connection.shutdown()
            await other.connection.shutdown()
            try result.get()
        }
    }

    @Test(arguments: [
        "http://team.example.test", "https://user@team.example.test",
        "https://team.example.test?token=secret", "https://team.example.test#token=secret",
    ])
    func `invalid advertised identities fail instead of silently using owner`(announcement: String) async throws {
        let fixture = try DashboardIdentityFixture(announcement: announcement)
        await #expect(throws: URLError.self) {
            try await fixture.connection.controlUiBrowserIdentityURL(config: fixture.config)
        }
        await fixture.connection.shutdown()
    }

    @Test func `a mismatched caller config cannot connect to or borrow the selected Gateway`() async throws {
        let fixture = try DashboardIdentityFixture(announcement: "https://team.example.test/")
        let mismatched: GatewayConnection.Config = (fixture.config.url, "different-owner-token", nil)
        await #expect(throws: CancellationError.self) {
            try await fixture.connection.controlUiBrowserIdentityURL(config: mismatched)
        }
        #expect(fixture.requests.value.isEmpty)
        #expect(fixture.session.snapshotMakeCount() == 0)
        await fixture.connection.shutdown()
    }

    @Test func `a suspended lookup cannot return a replacement Gateway identity`() async throws {
        let gate = GatewayConnectionSuspensionGate()
        let fixture = try DashboardIdentityFixture(
            announcement: "https://team.example.test/", endpointGate: gate)
        #expect(try await fixture.connection.controlUiBrowserIdentityURL(config: fixture.config)?.absoluteString ==
            "https://team.example.test/")
        fixture.suspendEndpoint.withValue { $0 = true }
        let pending = Task { try await fixture.connection.controlUiBrowserIdentityURL(config: fixture.config) }
        await gate.waitUntilStarted()
        let replacement: GatewayConnection.Config = try (
            #require(URL(string: "ws://127.0.0.1:28902")), fixture.config.token, nil)
        fixture.source.setEndpoint(.init(config: replacement, routeAuthority: 2, revision: 2))
        fixture.announcement.withValue { $0 = "https://second.example.test/" }
        await gate.open()
        await #expect(throws: CancellationError.self) { try await pending.value }
        #expect(try await fixture.connection.controlUiBrowserIdentityURL(config: replacement)?.absoluteString ==
            "https://second.example.test/")
        #expect(fixture.requests.value == ["health", "health"])
        await fixture.connection.shutdown()
    }

    @Test(arguments: [nil, "https://renewed.example.test/"])
    func `reconnect at the same address replaces the advertised identity`(announcement: String?) async throws {
        let fixture = try DashboardIdentityFixture(announcement: "https://team.example.test/")
        #expect(try await fixture.connection.controlUiBrowserIdentityURL(config: fixture.config)?.absoluteString ==
            "https://team.example.test/")
        let lease = try #require(await fixture.connection.captureServerLease())
        fixture.announcement.withValue { $0 = announcement }
        fixture.session.latestTask()?.emitReceiveFailure()
        let deadline = ContinuousClock.now + .seconds(2)
        while await fixture.connection.isCurrentServerLease(lease), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(await fixture.connection.isCurrentServerLease(lease) == false)
        #expect(try await fixture.connection.controlUiBrowserIdentityURL(config: fixture.config)?.absoluteString ==
            announcement)
        #expect(fixture.requests.value == ["health", "health"])
        await fixture.connection.shutdown()
    }
}
