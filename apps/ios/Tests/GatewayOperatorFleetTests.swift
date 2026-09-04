import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@Suite(.serialized)
@MainActor
struct GatewayOperatorFleetTests {
    @Test(arguments: [false, true])
    func `healthy background connections survive maintenance and endpoint gaps`(customTransport: Bool) async throws {
        try await self.withFleet(customTransport: customTransport) { fleet, fixture, config in
            try await self.waitUntil { fixture.capturedAuth(at: 0) != nil }
            fleet.reconcile(desiredStableIDs: [config.stableID], configs: [])

            // Observe actual sockets across maintenance passes, including the custom URLSession path.
            try await Task.sleep(for: .milliseconds(2200))
            #expect(fixture.capturedAuth(at: 1) == nil)
            #expect(fixture.activeConnectionCount == 1)

            fixture.closeConnection(at: 0)
            try await self.waitUntil { fixture.capturedAuth(at: 1) != nil }
            #expect(fixture.activeConnectionCount == 1)

            fleet.reconcile(desiredStableIDs: [], configs: [])
            try await self.waitUntil { fixture.activeConnectionCount == 0 }
            #expect(fixture.capturedAuth(at: 2) == nil)
        }
    }

    @Test
    func `stale socket replacement invalidates only the old connect admission`() async throws {
        let transport = GatewayTestWebSocketSession()
        let gateway = GatewayNodeSession()
        let url = try #require(URL(string: "ws://127.0.0.1:1"))
        func connect() async throws {
            try await gateway.connect(
                url: url,
                credentials: .init(),
                connectOptions: GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions,
                sessionBox: WebSocketSessionBox(session: transport),
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
        }
        try await connect()
        let socket = try #require(transport.latestTask())
        socket.state = .completed
        #expect(await gateway.currentRoute() == nil)

        await #expect(throws: CancellationError.self) { try await connect() }
        #expect(!Task.isCancelled)
        #expect(transport.snapshotMakeCount() == 2)
        #expect(await gateway.currentRoute() != nil)
        try await connect()
        #expect(transport.snapshotMakeCount() == 2)
        await gateway.disconnect()
    }

    @Test(arguments: [GatewayConnectAuthDetailCode.pairingRequired, .authTokenMismatch])
    func `auth pauses survive reconciliation until connection inputs change`(
        detail: GatewayConnectAuthDetailCode) async throws
    {
        let failure = NativeGatewayWebSocketFixture.ConnectFailure(
            message: "Synthetic authentication rejection",
            detailCode: detail.rawValue,
            requestId: "fleet-auth-rejection")
        try await self.withFleet(connectFailures: [0: failure]) { fleet, fixture, config in
            try await self.waitUntil {
                fixture.capturedAuth(at: 0) != nil && fixture.activeConnectionCount == 0
            }
            fleet.reconcile(desiredStableIDs: [config.stableID], configs: [config])
            try await Task.sleep(for: .milliseconds(2200))
            #expect(fixture.capturedAuth(at: 1) == nil)

            let replacement = GatewayConnectConfig(
                url: config.url,
                stableID: config.stableID,
                tls: config.tls,
                token: "replacement-token",
                bootstrapToken: nil,
                password: nil,
                nodeOptions: config.nodeOptions)
            fleet.reconcile(desiredStableIDs: [config.stableID], configs: [replacement])
            try await self.waitUntil { fixture.capturedAuth(at: 1) != nil }
            #expect(fixture.capturedAuth(at: 1)?.token == "replacement-token")
            #expect(fixture.activeConnectionCount == 1)
        }
    }

    private func withFleet(
        customTransport: Bool = false,
        connectFailures: [Int: NativeGatewayWebSocketFixture.ConnectFailure] = [:],
        operation: (GatewayOperatorFleet, NativeGatewayWebSocketFixture, GatewayConnectConfig) async throws -> Void)
        async throws
    {
        let stateDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("operator-fleet-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: stateDirectory) }
        try await DeviceIdentityStore.withStateDirectory(stateDirectory) {
            let fixture = try await NativeGatewayWebSocketFixture.start(
                issuedDeviceTokens: [],
                connectFailures: connectFailures)
            defer { fixture.stop() }
            let fleet = GatewayOperatorFleet()
            defer { fleet.stopAll() }
            let stableID = "operator-fleet-\(UUID().uuidString)"
            let config = GatewayConnectConfig(
                url: fixture.url(),
                stableID: stableID,
                // Loopback exercises both native session owners without needing a certificate fixture.
                tls: customTransport
                    ? GatewayTLSParams(required: false, expectedFingerprint: nil, allowTOFU: false, storeKey: nil)
                    : nil,
                token: nil,
                bootstrapToken: nil,
                password: nil,
                nodeOptions: GatewayConnectOptions(
                    role: "node",
                    scopes: [],
                    caps: [],
                    commands: [],
                    permissions: [:],
                    clientId: "openclaw-ios",
                    clientMode: "node",
                    clientDisplayName: "Fleet Test",
                    includeDeviceIdentity: true,
                    allowStoredDeviceAuth: false,
                    deviceAuthGatewayID: stableID))
            fleet.reconcile(desiredStableIDs: [stableID], configs: [config])
            try await operation(fleet, fixture, config)
            fleet.stopAll()
            try await self.waitUntil { fixture.activeConnectionCount == 0 }
        }
    }

    private func waitUntil(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        try #require(condition())
    }
}
