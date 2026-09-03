import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

private func makeControlUIAuthSession(
    issuedDeviceToken: String? = nil) -> GatewayTestWebSocketSession
{
    GatewayTestWebSocketSession(taskFactory: {
        GatewayTestWebSocketTask(
            sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
            },
            receiveHook: { task, receiveIndex in
                if receiveIndex == 0 {
                    return .data(GatewayWebSocketTestSupport.connectChallengeData())
                }
                let id = task.snapshotConnectRequestID() ?? "connect"
                return .data(GatewayWebSocketTestSupport.connectOkData(
                    id: id,
                    deviceToken: issuedDeviceToken))
            })
    })
}

private func controlUIRoute(_ rawURL: String, token: String? = nil) throws -> GatewayConnection.Config {
    try (
        url: #require(URL(string: rawURL)),
        token: token,
        password: nil)
}

@Suite(.serialized)
struct GatewayConnectionControlUIAuthTests {
    @Test func `shared token requires the current live route and socket`() async throws {
        let routeA = try controlUIRoute("ws://route-a.invalid", token: " shared-token ")
        let source = GatewayConnectionEndpointSource(endpoint: .init(
            config: routeA,
            routeAuthority: 1,
            deviceAuthGatewayID: "route-a"))
        let connection = GatewayConnection(
            testEndpointProvider: { source.snapshot() },
            sessionBox: WebSocketSessionBox(session: makeControlUIAuthSession()))

        #expect(await connection.controlUiAutoAuthToken(config: routeA) == nil)
        _ = try await connection.request(
            method: "health",
            params: nil,
            retryTransportFailures: false)
        #expect(await connection.controlUiAutoAuthToken(config: routeA) == "shared-token")

        let routeB = try controlUIRoute("ws://route-b.invalid", token: routeA.token)
        source.setEndpoint(.init(
            config: routeB,
            routeAuthority: 2,
            deviceAuthGatewayID: "route-b"))

        // The old socket is still physically alive, but neither the old nor
        // the newly selected route may borrow its credential.
        #expect(await connection.controlUiAutoAuthToken(config: routeA) == nil)
        #expect(await connection.controlUiAutoAuthToken(config: routeB) == nil)
        await connection.shutdown()
    }

    @Test func `device auto auth reads only the live route scoped token`() async throws {
        let stateDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: stateDir) }

        try await DeviceIdentityStore.withStateDirectory(stateDir) {
            let identity = DeviceIdentityStore.loadOrCreate()
            _ = DeviceAuthStore.storeToken(
                deviceId: identity.deviceId,
                role: "operator",
                token: "legacy-unscoped-token")
            _ = DeviceAuthStore.storeToken(
                deviceId: identity.deviceId,
                role: "operator",
                token: "route-a-device-token",
                gatewayID: "route-a")

            let routeA = try controlUIRoute("ws://route-a.invalid")
            let routeAConnection = GatewayConnection(
                endpointProvider: {
                    .init(
                        config: routeA,
                        routeAuthority: 1,
                        deviceAuthGatewayID: "route-a")
                },
                supportsSharedEndpointRecovery: false,
                activationBindingKeyProvider: { nil },
                sessionBox: WebSocketSessionBox(session: makeControlUIAuthSession()))
            _ = try await routeAConnection.request(
                method: "health",
                params: nil,
                retryTransportFailures: false)
            #expect(
                await routeAConnection.controlUiAutoAuthToken(config: routeA) ==
                    "route-a-device-token")
            await routeAConnection.shutdown()

            let routeB = try controlUIRoute("ws://route-b.invalid")
            let routeBConnection = GatewayConnection(
                endpointProvider: {
                    .init(
                        config: routeB,
                        routeAuthority: 2,
                        deviceAuthGatewayID: "route-b")
                },
                supportsSharedEndpointRecovery: false,
                activationBindingKeyProvider: { nil },
                sessionBox: WebSocketSessionBox(session: makeControlUIAuthSession()))
            _ = try await routeBConnection.request(
                method: "health",
                params: nil,
                retryTransportFailures: false)
            #expect(await routeBConnection.controlUiAutoAuthToken(config: routeB) == nil)
            await routeBConnection.shutdown()
        }
    }

    @Test func `hello token cannot cross to a newly selected route`() async throws {
        let stateDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: stateDir) }

        try await DeviceIdentityStore.withStateDirectory(stateDir) {
            let identity = DeviceIdentityStore.loadOrCreate()
            _ = DeviceAuthStore.storeToken(
                deviceId: identity.deviceId,
                role: "operator",
                token: "route-a-device-token",
                gatewayID: "route-a")
            let routeA = try controlUIRoute("ws://route-a.invalid")
            let source = GatewayConnectionEndpointSource(endpoint: .init(
                config: routeA,
                routeAuthority: 1,
                deviceAuthGatewayID: "route-a"))
            let connection = GatewayConnection(
                endpointProvider: { source.snapshot() },
                supportsSharedEndpointRecovery: false,
                activationBindingKeyProvider: { nil },
                sessionBox: WebSocketSessionBox(session: makeControlUIAuthSession(
                    issuedDeviceToken: "route-a-issued-token")))

            _ = try await connection.request(
                method: "health",
                params: nil,
                retryTransportFailures: false)
            #expect(
                await connection.controlUiAutoAuthToken(config: routeA) ==
                    "route-a-issued-token")

            source.setEndpoint(.init(
                config: routeA,
                routeAuthority: 1,
                deviceAuthGatewayID: "route-b"))
            #expect(await connection.controlUiAutoAuthToken(config: routeA) == nil)

            let routeB = try controlUIRoute("ws://route-b.invalid")
            source.setEndpoint(.init(
                config: routeB,
                routeAuthority: 2,
                deviceAuthGatewayID: "route-b"))
            #expect(await connection.controlUiAutoAuthToken(config: routeA) == nil)
            #expect(await connection.controlUiAutoAuthToken(config: routeB) == nil)
            await connection.shutdown()
        }
    }
}
