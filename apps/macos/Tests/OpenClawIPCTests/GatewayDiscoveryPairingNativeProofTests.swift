import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

/// Opt-in proof that the macOS client crosses the real TLS Gateway boundary with route-owned credentials.
@Suite(.serialized)
@MainActor
struct GatewayDiscoveryPairingNativeProofTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["OPENCLAW_MACOS_GATEWAY_PAIRING_PROOF"] == "1"))
    func `mismatched discovery is denied before full access pairing and routed reconnects succeed`() async throws {
        let environment = ProcessInfo.processInfo.environment
        let statePath = try #require(environment["OPENCLAW_STATE_DIR"])
        let stateURL = URL(fileURLWithPath: statePath).resolvingSymlinksInPath()
        let root = stateURL.deletingLastPathComponent()
        let setupURL = root.appendingPathComponent("gateway-setup.json")
        let readyURL = root.appendingPathComponent("gateway-ready")
        let gatewayStateURL = root.appendingPathComponent("gateway-state", isDirectory: true)
        let logURL = root.appendingPathComponent("gateway.log")

        var repo = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 {
            repo.deleteLastPathComponent()
        }
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        child.arguments = [
            "node", "--import", "tsx",
            repo.appendingPathComponent(
                "test/e2e/qa-lab/runtime/macos-gateway-discovery-pairing.native.test-support.ts").path,
            setupURL.path,
            readyURL.path,
            gatewayStateURL.path,
        ]
        child.currentDirectoryURL = repo
        child.environment = environment
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        let output = try FileHandle(forWritingTo: logURL)
        child.standardOutput = output
        child.standardError = output
        try child.run()
        defer {
            if child.isRunning {
                child.terminate()
                child.waitUntilExit()
            }
            try? output.close()
        }

        try await self.waitForReadyFile(readyURL, child: child)
        let setupData = try Data(contentsOf: setupURL)
        var wrongSetup = try #require(JSONSerialization.jsonObject(with: setupData) as? [String: Any])
        let fingerprint = try #require(wrongSetup["tlsFingerprint"] as? String)
        let replacement = fingerprint.hasSuffix("0") ? "1" : "0"
        wrongSetup["tlsFingerprint"] = String(fingerprint.dropLast()) + replacement
        let wrongSetupData = try JSONSerialization.data(withJSONObject: wrongSetup)
        let wrongSetupInput = try #require(String(data: wrongSetupData, encoding: .utf8))

        do {
            _ = try await GatewayDiscoveryPairing.authenticate(setupInput: wrongSetupInput)
            Issue.record("A mismatched TLS discovery route reached Gateway authentication")
        } catch {
            #expect(error.localizedDescription.localizedCaseInsensitiveContains("fingerprint"))
        }

        let setupInput = try #require(String(data: setupData, encoding: .utf8))
        let route = try await GatewayDiscoveryPairing.authenticate(setupInput: setupInput)
        #expect(route.tlsFingerprint == fingerprint.lowercased())

        let state = AppState(preview: true)
        state.remoteToken = "inherited-token-must-not-route"
        let applied = GatewayDiscoverySelectionSupport.applyAuthenticatedSelection(
            stableID: "bonjour|native-proof",
            route: route,
            state: state)
        #expect(applied)

        let source = await GatewayEndpointStore._testLiveSourceSnapshot(
            state: state,
            profile: AppProfile(environment: [
                "OPENCLAW_GATEWAY_TOKEN": "ambient-token-must-not-route",
            ]),
            beforeConfigRead: {})
        #expect(source.token == nil)
        #expect(source.password == nil)
        let owner = try #require(source.deviceAuthGatewayID)
        #expect(owner == "tls-sha256:\(fingerprint.lowercased())")

        let endpoint = GatewayConnection.EndpointSnapshot(
            config: (route.url, source.token, source.password),
            tls: GatewayTLSRoute.resolve(
                url: route.url,
                connectionMode: .remote,
                configuredFingerprint: source.remoteTLSFingerprint),
            routeAuthority: nil,
            deviceAuthGatewayID: owner)
        let operatorConnection = GatewayConnection(endpointProvider: { endpoint })
        defer { Task { await operatorConnection.shutdown() } }
        _ = try await operatorConnection.request(method: "health", params: nil, timeoutMs: 15_000)
        #expect(await operatorConnection.authSource() == .deviceToken)

        let nodeOptions = MacNodeModeCoordinator.connectOptions(
            GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "openclaw-macos",
                clientMode: "node",
                clientDisplayName: "macOS Gateway pairing proof",
                deviceIdentityProfile: .node),
            for: endpoint)
        #expect(nodeOptions.deviceIdentityProfile == .primary)
        let nodeChannel = GatewayChannelActor(
            url: route.url,
            token: endpoint.config.token,
            password: endpoint.config.password,
            session: endpoint.tls.map { WebSocketSessionBox(session: GatewayTLSPinningSession(params: $0.params)) },
            connectOptions: nodeOptions)
        defer { Task { await nodeChannel.shutdown() } }
        try await nodeChannel.connect()
        #expect(await nodeChannel.authSource() == .deviceToken)
    }

    private func waitForReadyFile(_ url: URL, child: Process) async throws {
        let deadline = ContinuousClock.now + .seconds(30)
        while ContinuousClock.now < deadline {
            if FileManager.default.fileExists(atPath: url.path) {
                return
            }
            if !child.isRunning {
                throw NSError(
                    domain: "GatewayDiscoveryPairingNativeProof",
                    code: Int(child.terminationStatus),
                    userInfo: [NSLocalizedDescriptionKey: "The real Gateway exited before becoming ready"])
            }
            try await Task.sleep(for: .milliseconds(25))
        }
        throw NSError(
            domain: "GatewayDiscoveryPairingNativeProof",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "Timed out waiting for the real Gateway"])
    }
}
