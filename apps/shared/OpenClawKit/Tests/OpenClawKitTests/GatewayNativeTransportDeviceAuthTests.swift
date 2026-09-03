#if os(macOS)
import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawKit

private func nativeNodeConnectOptions(
    allowStoredDeviceAuth: Bool,
    deviceAuthGatewayID: String? = nil) -> GatewayConnectOptions
{
    GatewayConnectOptions(
        role: "node",
        scopes: [],
        caps: [],
        commands: [],
        permissions: [:],
        clientId: "openclaw-native-transport-test",
        clientMode: "node",
        clientDisplayName: "Native Transport Test",
        includeDeviceIdentity: true,
        allowStoredDeviceAuth: allowStoredDeviceAuth,
        deviceAuthGatewayID: deviceAuthGatewayID)
}

extension GatewayNodeSession {
    fileprivate func connectThroughURLSessionForTest(
        _ url: URL,
        credentials: GatewayNodeSessionCredentials = .init(),
        options: GatewayConnectOptions) async throws
    {
        try await self.connect(
            url: url,
            credentials: credentials,
            connectOptions: options,
            sessionBox: nil,
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
    }
}

@Suite(.serialized)
struct GatewayNativeTransportDeviceAuthTests {
    @Test(.stateDirectoryIsolated)
    @MainActor
    func `legacy unscoped token rotation persists and reconnects with replacement`() async throws {
        let previousToken = "native-legacy-previous-token"
        let rotatedToken = "native-legacy-rotated-token"
        let fixture = try await NativeGatewayWebSocketFixture.start(
            issuedDeviceTokens: [rotatedToken, nil])
        defer { fixture.stop() }

        let identity = DeviceIdentityStore.loadOrCreate()
        _ = DeviceAuthStore.storeToken(
            deviceId: identity.deviceId,
            role: "node",
            token: previousToken)
        let gateway = GatewayNodeSession()
        let options = nativeNodeConnectOptions(allowStoredDeviceAuth: true)

        try await gateway.connectThroughURLSessionForTest(fixture.url(), options: options)

        #expect(fixture.capturedAuth(at: 0) == .init(
            token: previousToken,
            bootstrapToken: nil,
            deviceToken: nil))
        #expect(DeviceAuthStore.loadToken(
            deviceId: identity.deviceId,
            role: "node")?.token == rotatedToken)

        fixture.closeConnection(at: 0)
        try await waitUntil("native legacy token rotation reconnect") {
            await fixture.capturedAuth(at: 1) != nil
        }
        #expect(fixture.capturedAuth(at: 1) == .init(
            token: rotatedToken,
            bootstrapToken: nil,
            deviceToken: nil))

        await gateway.disconnect()
    }

    @Test(.stateDirectoryIsolated)
    @MainActor
    func `owner-bound issuance persists scoped token and sends it on reconnect`() async throws {
        let gatewayID = "native-owner"
        let issuedToken = "native-owner-issued-token"
        let fixture = try await NativeGatewayWebSocketFixture.start(
            issuedDeviceTokens: [issuedToken, nil])
        defer { fixture.stop() }

        let identity = DeviceIdentityStore.loadOrCreate()
        let gateway = GatewayNodeSession()
        let options = nativeNodeConnectOptions(
            allowStoredDeviceAuth: false,
            deviceAuthGatewayID: gatewayID)

        try await gateway.connectThroughURLSessionForTest(fixture.url(), options: options)

        #expect(fixture.capturedAuth(at: 0) == .init(
            token: nil,
            bootstrapToken: nil,
            deviceToken: nil))
        let stored = try #require(DeviceAuthStore.loadToken(
            deviceId: identity.deviceId,
            role: "node",
            gatewayID: gatewayID))
        #expect(stored.token == issuedToken)
        #expect(DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "node") == nil)

        fixture.closeConnection(at: 0)
        try await waitUntil("native owner-bound reconnect") {
            await fixture.capturedAuth(at: 1) != nil
        }
        #expect(fixture.capturedAuth(at: 1) == .init(
            token: issuedToken,
            bootstrapToken: nil,
            deviceToken: nil))

        await gateway.disconnect()
    }

    @Test(.stateDirectoryIsolated)
    @MainActor
    func `gateway A reconnect never claims gateway B legacy token`() async throws {
        let gatewayAID = "native-gateway-a"
        let gatewayBLegacyToken = "native-gateway-b-legacy-token"
        let gatewayASharedToken = "native-gateway-a-shared-token"
        let gatewayAScopedToken = "native-gateway-a-device-token"
        let fixture = try await NativeGatewayWebSocketFixture.start(
            issuedDeviceTokens: [gatewayAScopedToken, nil, nil])
        defer { fixture.stop() }

        let identity = DeviceIdentityStore.loadOrCreate()
        _ = DeviceAuthStore.storeToken(
            deviceId: identity.deviceId,
            role: "node",
            token: gatewayBLegacyToken)

        let authenticatedGateway = GatewayNodeSession()
        let options = nativeNodeConnectOptions(
            allowStoredDeviceAuth: true,
            deviceAuthGatewayID: gatewayAID)
        try await authenticatedGateway.connectThroughURLSessionForTest(
            fixture.url(),
            credentials: .init(token: gatewayASharedToken),
            options: options)
        #expect(fixture.capturedAuth(at: 0) == .init(
            token: gatewayASharedToken,
            bootstrapToken: nil,
            deviceToken: nil))
        #expect(DeviceAuthStore.loadToken(
            deviceId: identity.deviceId,
            role: "node",
            gatewayID: gatewayAID)?.token == gatewayAScopedToken)
        #expect(DeviceAuthStore.loadToken(
            deviceId: identity.deviceId,
            role: "node")?.token == gatewayBLegacyToken)
        await authenticatedGateway.disconnect()

        let gateway = GatewayNodeSession()
        try await gateway.connectThroughURLSessionForTest(fixture.url(), options: options)

        #expect(fixture.capturedAuth(at: 1) == .init(
            token: gatewayAScopedToken,
            bootstrapToken: nil,
            deviceToken: nil))
        #expect(DeviceAuthStore.loadToken(
            deviceId: identity.deviceId,
            role: "node")?.token == gatewayBLegacyToken)

        fixture.closeConnection(at: 1)
        try await waitUntil("native gateway-scoped token reconnect") {
            await fixture.capturedAuth(at: 2) != nil
        }
        #expect(fixture.capturedAuth(at: 2) == .init(
            token: gatewayAScopedToken,
            bootstrapToken: nil,
            deviceToken: nil))
        #expect(DeviceAuthStore.loadToken(
            deviceId: identity.deviceId,
            role: "node")?.token == gatewayBLegacyToken)

        await gateway.disconnect()
    }

    @Test(.stateDirectoryIsolated)
    @MainActor
    func `unproven legacy token enters visible native re-pair recovery`() async throws {
        let gatewayID = "native-unproven-owner"
        let fixture = try await NativeGatewayWebSocketFixture.start(
            issuedDeviceTokens: [nil],
            connectFailures: [0: .pairingRequired])
        defer { fixture.stop() }

        let identity = DeviceIdentityStore.loadOrCreate()
        _ = DeviceAuthStore.storeToken(
            deviceId: identity.deviceId,
            role: "node",
            token: "unproven-legacy-token")
        let gateway = GatewayNodeSession()
        let options = nativeNodeConnectOptions(
            allowStoredDeviceAuth: true,
            deviceAuthGatewayID: gatewayID)

        do {
            try await gateway.connectThroughURLSessionForTest(fixture.url(), options: options)
            Issue.record("expected pairing-required recovery")
        } catch let error as GatewayConnectAuthError {
            #expect(error.detail == .pairingRequired)
            let problem = try #require(GatewayConnectionProblemMapper.map(error: error))
            #expect(problem.needsPairingApproval)
            #expect(problem.actionLabel == "Approve on gateway")
        }

        #expect(fixture.capturedAuth(at: 0) == .init(
            token: nil,
            bootstrapToken: nil,
            deviceToken: nil))
        #expect(DeviceAuthStore.loadToken(
            deviceId: identity.deviceId,
            role: "node")?.token == "unproven-legacy-token")
        #expect(DeviceAuthStore.loadToken(
            deviceId: identity.deviceId,
            role: "node",
            gatewayID: gatewayID) == nil)

        await gateway.disconnect()
    }

    @Test(.stateDirectoryIsolated)
    @MainActor
    func `ownerless issuance is not persisted and reconnect sends no credential`() async throws {
        let previousToken = "previous-ownerless-token"
        let fixture = try await NativeGatewayWebSocketFixture.start(
            issuedDeviceTokens: ["ownerless-issued-token", nil])
        defer { fixture.stop() }

        let identity = DeviceIdentityStore.loadOrCreate()
        _ = DeviceAuthStore.storeToken(
            deviceId: identity.deviceId,
            role: "node",
            token: previousToken)
        let gateway = GatewayNodeSession()
        let options = nativeNodeConnectOptions(allowStoredDeviceAuth: false)

        try await gateway.connectThroughURLSessionForTest(fixture.url(), options: options)

        #expect(fixture.capturedAuth(at: 0) == .init(
            token: nil,
            bootstrapToken: nil,
            deviceToken: nil))
        let roles = await gateway.currentDeviceAuthRoles()
        #expect(roles.received == ["node"])
        #expect(roles.persisted.isEmpty)
        #expect(DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "node")?
            .token == previousToken)

        fixture.closeConnection(at: 0)
        try await waitUntil("native ownerless reconnect") {
            await fixture.capturedAuth(at: 1) != nil
        }
        #expect(fixture.capturedAuth(at: 1) == .init(
            token: nil,
            bootstrapToken: nil,
            deviceToken: nil))

        await gateway.disconnect()
    }
}
#endif
