import Foundation
import OpenClawDiscovery
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct GatewayDiscoverySelectionSupportTests {
    private static let preferenceDefaults: [String: Any?] = [
        "gateway.preferredStableID": nil,
        "bridge.preferredStableID": nil,
        "gateway.preferredStableIDRouteBinding.v1": nil,
        "gateway.preferredTLSFingerprint.v1": nil,
    ]

    @Test func `secure setup requires TLS pin and bootstrap credential`() throws {
        let fingerprint = String(repeating: "ab", count: 32)
        let valid = """
        {"url":"wss://gateway.local:18789","tlsFingerprint":"\(fingerprint)","bootstrapToken":"one-time"}
        """
        let link = try GatewayDiscoveryPairing.parseSetup(valid)
        #expect(link.websocketURL?.absoluteString == "wss://gateway.local:18789")
        #expect(link.tlsFingerprintSha256 == fingerprint)

        let missingPin = #"{"url":"wss://gateway.local:18789","bootstrapToken":"one-time"}"#
        #expect(throws: GatewayDiscoveryPairingError.secureSetupRequired) {
            try GatewayDiscoveryPairing.parseSetup(missingPin)
        }

        let plaintext = """
        {"url":"ws://gateway.local:18789","tlsFingerprint":"\(fingerprint)","bootstrapToken":"one-time"}
        """
        #expect(throws: GatewayDiscoveryPairingError.secureSetupRequired) {
            try GatewayDiscoveryPairing.parseSetup(plaintext)
        }
    }

    @Test func `authenticated route suppresses shared auth and owns its device token`() async throws {
        let configPath = TestIsolation.tempConfigPath()
        let fingerprint = String(repeating: "cd", count: 32)
        let url = "wss://gateway.local:18789"
        try Data("""
        {"gateway":{"mode":"remote","remote":{"transport":"direct","url":"\(url)","token":"config-token","password":"config-password","tlsFingerprint":"\(fingerprint)"}}}
        """.utf8).write(to: URL(fileURLWithPath: configPath))
        defer { try? FileManager.default.removeItem(atPath: configPath) }

        try await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_CONFIG_PATH": configPath,
                "OPENCLAW_GATEWAY_TOKEN": "ambient-token",
                "OPENCLAW_GATEWAY_PASSWORD": "ambient-password",
            ],
            defaults: Self.preferenceDefaults)
        {
            let state = AppState(preview: true)
            state.connectionMode = .remote
            state.remoteTransport = .direct
            state.remoteUrl = url
            GatewayDiscoveryPreferences.setAuthenticatedPreferredGateway(
                stableID: "bonjour|gateway",
                tlsFingerprint: fingerprint)

            let source = await GatewayEndpointStore._testLiveSourceSnapshot(
                state: state,
                profile: AppProfile(environment: [:]),
                beforeConfigRead: {})

            #expect(source.token == nil)
            #expect(source.password == nil)
            #expect(source.deviceAuthGatewayID == "tls-sha256:\(fingerprint)")
            #expect(source.remoteTLSFingerprint == fingerprint)
        }
    }

    @Test func `authenticated selection preserves existing shared credential state`() async throws {
        let configPath = TestIsolation.tempConfigPath()
        let fingerprint = String(repeating: "56", count: 32)
        try await TestIsolation.withIsolatedState(
            env: ["OPENCLAW_CONFIG_PATH": configPath],
            defaults: Self.preferenceDefaults)
        {
            let state = AppState(preview: true)
            state.connectionMode = .remote
            state.remoteTransport = .direct
            state.remoteUrl = "wss://old-gateway.local:18789"
            state.remoteToken = "old-shared-token"

            let applied = GatewayDiscoverySelectionSupport.applyAuthenticatedSelection(
                stableID: "bonjour|new-gateway",
                route: AuthenticatedGatewayRoute(
                    url: try #require(URL(string: "wss://new-gateway.local:18789")),
                    tlsFingerprint: fingerprint),
                state: state)

            #expect(applied)
            #expect(state.remoteUrl == "wss://new-gateway.local:18789")
            #expect(state.remoteToken == "old-shared-token")
            #expect(GatewayDiscoveryPreferences.preferredStableID() == "bonjour|new-gateway")
            #expect(GatewayDiscoveryPreferences.authenticatedTLSFingerprint() == fingerprint)
        }
    }

    @Test func `legacy discovery preference cannot claim an authenticated route`() async throws {
        let configPath = TestIsolation.tempConfigPath()
        let fingerprint = String(repeating: "ef", count: 32)
        let url = "wss://gateway.local:18789"
        try Data("""
        {"gateway":{"mode":"remote","remote":{"transport":"direct","url":"\(url)","token":"config-token","tlsFingerprint":"\(fingerprint)"}}}
        """.utf8).write(to: URL(fileURLWithPath: configPath))
        defer { try? FileManager.default.removeItem(atPath: configPath) }

        try await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_CONFIG_PATH": configPath,
                "OPENCLAW_GATEWAY_TOKEN": nil,
            ],
            defaults: Self.preferenceDefaults)
        {
            let state = AppState(preview: true)
            state.connectionMode = .remote
            state.remoteTransport = .direct
            state.remoteUrl = url
            let binding = try #require(GatewayDiscoveryPreferences.routeBinding(
                connectionMode: .remote,
                remoteTransport: .direct,
                remoteURL: url,
                remoteTarget: ""))
            GatewayDiscoveryPreferences.setPreferredStableID(
                "bonjour|gateway",
                routeBinding: binding)

            let source = await GatewayEndpointStore._testLiveSourceSnapshot(
                state: state,
                profile: AppProfile(environment: [:]),
                beforeConfigRead: {})

            #expect(source.token == "config-token")
            #expect(source.deviceAuthGatewayID == binding)
        }
    }

    @Test func `certificate change retires authenticated credential ownership`() async throws {
        let trusted = String(repeating: "12", count: 32)
        let replacement = String(repeating: "34", count: 32)
        await TestIsolation.withUserDefaultsValues(Self.preferenceDefaults) {
            GatewayDiscoveryPreferences.setAuthenticatedPreferredGateway(
                stableID: "bonjour|gateway",
                tlsFingerprint: trusted)

            #expect(GatewayDiscoveryPreferences.hasAuthenticatedTLSIdentity(
                configuredFingerprint: "SHA256:\(trusted.uppercased())"))
            #expect(!GatewayDiscoveryPreferences.hasAuthenticatedTLSIdentity(
                configuredFingerprint: replacement))
            #expect(GatewayDiscoveryPreferences.deviceAuthGatewayID(
                connectionMode: .remote,
                remoteTransport: .direct,
                remoteURL: "wss://gateway.local:18789",
                remoteTarget: "",
                tlsFingerprint: replacement) != "tls-sha256:\(trusted)")
        }
    }
}
