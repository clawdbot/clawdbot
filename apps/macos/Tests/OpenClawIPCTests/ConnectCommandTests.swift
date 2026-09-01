import Foundation
import Testing
@testable import OpenClawKit
@testable import OpenClawMacCLI

private final class CLIConnectAuthRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var sawConnect = false
    private var sawAuth = false

    func record(_ message: URLSessionWebSocketTask.Message) {
        guard let params = GatewayWebSocketTestSupport.connectRequestParams(from: message) else { return }
        self.lock.lock()
        defer { self.lock.unlock() }
        self.sawConnect = true
        self.sawAuth = params["auth"] != nil
    }

    func snapshot() -> (sawConnect: Bool, sawAuth: Bool) {
        self.lock.lock()
        defer { self.lock.unlock() }
        return (self.sawConnect, self.sawAuth)
    }
}

@Suite(.serialized)
struct ConnectCommandTests {
    @Test func `explicit URL never inherits config credentials`() throws {
        var config = GatewayConfig()
        config.mode = "remote"
        config.token = "local-config-token" // pragma: allowlist secret
        config.password = "local-config-password" // pragma: allowlist secret
        config.remoteToken = "remote-config-token" // pragma: allowlist secret
        config.remotePassword = "remote-config-password" // pragma: allowlist secret

        let endpoint = try resolveGatewayEndpoint(
            opts: ConnectOptions.parse(["--url", "wss://gateway-b.example.test"]),
            config: config)

        #expect(endpoint.token == nil)
        #expect(endpoint.password == nil)
    }

    @Test func `explicit URL accepts only explicit credentials`() throws {
        var config = GatewayConfig()
        config.mode = "remote"
        config.remoteToken = "wrong-config-token" // pragma: allowlist secret
        config.remotePassword = "wrong-config-password" // pragma: allowlist secret

        let endpoint = try resolveGatewayEndpoint(
            opts: ConnectOptions.parse([
                "--url", "wss://gateway-b.example.test",
                "--token", "explicit-token", // pragma: allowlist secret
                "--password", "explicit-password", // pragma: allowlist secret
            ]),
            config: config)

        #expect(endpoint.token == "explicit-token") // pragma: allowlist secret
        #expect(endpoint.password == "explicit-password") // pragma: allowlist secret
    }

    @Test func `explicit URL owner ignores embedded credentials`() throws {
        let first = try #require(URL(
            string: "wss://alice:first-pass@gateway.example.test/socket?tenant=alpha&token=first-token#first"))
        let rotated = try #require(URL(
            string: "wss://alice:second-pass@gateway.example.test/socket?tenant=alpha&token=second-token#second"))
        let otherRoute = try #require(URL(
            string: "wss://gateway.example.test/socket?tenant=beta&token=second-token"))

        let firstOwner = gatewayURLDeviceAuthOwner(first, mode: "remote")
        let rotatedOwner = gatewayURLDeviceAuthOwner(rotated, mode: "remote")
        let otherOwner = gatewayURLDeviceAuthOwner(otherRoute, mode: "remote")

        #expect(firstOwner == rotatedOwner)
        #expect(firstOwner != otherOwner)
        #expect(!firstOwner.contains("first-pass"))
        #expect(!firstOwner.contains("first-token"))
    }

    @Test func `explicit URL sends neither legacy nor scoped stored token`() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        try await DeviceIdentityStore.withStateDirectory(tempDir) {
            var config = GatewayConfig()
            config.mode = "remote"
            config.remoteToken = "gateway-a-config-token" // pragma: allowlist secret
            let opts = ConnectOptions.parse(["--url", "wss://gateway-b.example.test"])
            let endpoint = try resolveGatewayEndpoint(opts: opts, config: config)
            let connectOptions = makeGatewayConnectOptions(
                opts: opts,
                endpoint: endpoint,
                displayName: "CLI Test")
            let owner = try #require(connectOptions.deviceAuthGatewayID)
            let identity = DeviceIdentityStore.loadOrCreate()
            _ = DeviceAuthStore.storeToken(
                deviceId: identity.deviceId,
                role: "operator",
                token: "legacy-device-token") // pragma: allowlist secret
            _ = DeviceAuthStore.storeToken(
                deviceId: identity.deviceId,
                role: "operator",
                token: "same-route-device-token", // pragma: allowlist secret
                gatewayID: owner)

            let recorder = CLIConnectAuthRecorder()
            let session = GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask(sendHook: { _, message, sendIndex in
                    if sendIndex == 0 {
                        recorder.record(message)
                    }
                })
            })
            let channel = GatewayChannelActor(
                url: endpoint.url,
                token: endpoint.token,
                password: endpoint.password,
                session: WebSocketSessionBox(session: session),
                connectOptions: connectOptions)

            try await channel.connect()
            let captured = recorder.snapshot()
            #expect(captured.sawConnect)
            #expect(!captured.sawAuth)
            #expect(!connectOptions.allowStoredDeviceAuth)
            await channel.shutdown()
        }
    }

    @Test func `config URL sends neither legacy nor another route stored token`() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        try await DeviceIdentityStore.withStateDirectory(tempDir) {
            var configA = GatewayConfig()
            configA.mode = "remote"
            configA.remoteUrl = "wss://gateway-a.example.test"
            let opts = ConnectOptions.parse([])
            let endpointA = try resolveGatewayEndpoint(opts: opts, config: configA)
            let optionsA = makeGatewayConnectOptions(
                opts: opts,
                endpoint: endpointA,
                displayName: "CLI Test")

            var configB = configA
            configB.remoteUrl = "wss://gateway-b.example.test"
            let endpointB = try resolveGatewayEndpoint(opts: opts, config: configB)
            let optionsB = makeGatewayConnectOptions(
                opts: opts,
                endpoint: endpointB,
                displayName: "CLI Test")
            let ownerA = try #require(optionsA.deviceAuthGatewayID)
            let ownerB = try #require(optionsB.deviceAuthGatewayID)
            #expect(ownerA != ownerB)
            #expect(optionsB.allowStoredDeviceAuth)

            let identity = DeviceIdentityStore.loadOrCreate()
            _ = DeviceAuthStore.storeToken(
                deviceId: identity.deviceId,
                role: "operator",
                token: "legacy-device-token") // pragma: allowlist secret
            _ = DeviceAuthStore.storeToken(
                deviceId: identity.deviceId,
                role: "operator",
                token: "route-a-device-token", // pragma: allowlist secret
                gatewayID: ownerA)

            let recorder = CLIConnectAuthRecorder()
            let session = GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask(sendHook: { _, message, sendIndex in
                    if sendIndex == 0 {
                        recorder.record(message)
                    }
                })
            })
            let channel = GatewayChannelActor(
                url: endpointB.url,
                token: endpointB.token,
                password: endpointB.password,
                session: WebSocketSessionBox(session: session),
                connectOptions: optionsB)

            try await channel.connect()
            let captured = recorder.snapshot()
            #expect(captured.sawConnect)
            #expect(!captured.sawAuth)
            await channel.shutdown()
        }
    }
}
