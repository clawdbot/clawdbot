import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct GatewayMenuCardModelTests {
    private static let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test func `secondary line omits missing facts and abbreviates builds`() {
        let cases: [(String?, String?, String?, String?, String)] = [
            (
                "2026.9.1",
                "2026.9.1-release-6b97bae123ab-2026-09-05T21-06-03.000Z",
                "studio.local via ssh",
                nil,
                "2026.9.1 · 6b97bae · studio.local via ssh"),
            (
                "2026.9.2",
                "2026.9.2-303796cd7872-2026-09-06T00-38-10.000Z",
                "studio.local",
                nil,
                "2026.9.2 · 303796c · studio.local"),
            ("2026.9.1", "40a6b50abc", "stable.example", "Access", "2026.9.1 · 40a6b50 · stable.example · Access"),
            (nil, "6b97bae123", "studio.local", "token", "6b97bae · studio.local · token"),
            ("2026.9.1", nil, "studio.local", nil, "2026.9.1 · studio.local"),
            (nil, "abc", nil, nil, "abc"),
            (nil, "2026.9.1", nil, nil, "2026.9."),
            (nil, nil, nil, nil, ""),
        ]
        for (version, buildId, endpoint, transport, expected) in cases {
            let model = Self.model(
                version: version,
                buildId: buildId,
                endpointLabel: endpoint,
                transportLabel: transport)
            #expect(model.secondaryLine(now: Self.now) == expected)
        }
    }

    @Test func `tertiary line distinguishes cached health from a first probe`() {
        let cases: [(GatewayMenuCardModel, String)] = [
            (Self.model(health: .ok, latencyMs: 12.4, windowCount: 2), "12 ms · 2 windows"),
            (Self.model(windowCount: 1), "1 window"),
            (Self.model(), "0 windows"),
            (Self.model(isProbing: true), "checking…"),
            (Self.model(health: .ok, isProbing: true), "checking…"),
            (Self.model(health: .ok, version: "2026.9.1", latencyMs: 12, isProbing: true), "12 ms · 0 windows"),
            (Self.model(
                health: .error,
                latencyMs: 12,
                windowCount: 1,
                lastSeen: Self.now.addingTimeInterval(-120)), "unreachable · last seen 2 min ago · 1 window"),
            (Self.model(health: .error, isProbing: true), "unreachable · 0 windows"),
            (
                Self.model(health: .error, lastSeen: Self.now.addingTimeInterval(-30)),
                "unreachable · last seen just now · 0 windows"),
        ]
        for (model, expected) in cases {
            #expect(model.tertiaryLine(now: Self.now) == expected)
        }
    }

    @Test func `browser expiry reports days hours minutes and expiration`() {
        let cases: [(TimeInterval, String)] = [
            (6 * 86400, "session expires in 6d"),
            (2 * 3600, "session expires in 2h"),
            (2 * 60, "session expires in 2 min"),
            (30, "session expires in <1 min"),
            (0, "session expired"),
            (-60, "session expired"),
        ]
        for (remaining, expected) in cases {
            let model = Self.model(
                health: .ok,
                latencyMs: 12,
                windowCount: 2,
                browserSessionExpiresAt: Self.now.addingTimeInterval(remaining))
            #expect(model.tertiaryLine(now: Self.now) == "12 ms · 2 windows · " + expected)
        }
    }

    @Test func `primary endpoint describes the connection rather than its SSH tunnel`() throws {
        let cases: [(AppState.ConnectionMode, AppState.RemoteTransport, String?, String?, String?)] = [
            (.local, .ssh, nil, nil, "localhost:18789"),
            (.remote, .ssh, "user@studio.local:2222", "ws://127.0.0.1:49800", "studio.local via ssh"),
            (.remote, .direct, nil, "wss://gateway.example:443/control", "gateway.example"),
            (.remote, .direct, nil, "wss://gateway.example:8443/control", "gateway.example:8443"),
            (.remote, .direct, nil, "ws://gateway.local:80", "gateway.local"),
            (.unconfigured, .ssh, nil, nil, nil),
        ]
        for (mode, transport, sshTarget, remoteURL, expected) in cases {
            let url = try remoteURL.map { try #require(URL(string: $0)) }
            let labels = GatewayMenuEndpointLabels.primary(
                mode: mode,
                transport: transport,
                localPort: 18789,
                sshTarget: sshTarget,
                remoteURL: url,
                resolvedHostLabel: nil)
            #expect(labels.endpointLabel == expected)
            #expect(labels.transportLabel == nil)
        }
    }

    @Test func `profile endpoint retains nondefault ports and describes authentication`() throws {
        let cases: [(String, MacGatewayCatalogProfile.AuthKind?, Bool, String, String?)] = [
            ("wss://gateway.example:443", .token, false, "gateway.example", "token"),
            ("wss://gateway.example:8443/control", .browser, true, "gateway.example:8443", "Access"),
            ("ws://gateway.local:80", .password, false, "gateway.local", "password"),
            ("ws://gateway.local:18789", nil, false, "gateway.local:18789", nil),
        ]
        for (address, authKind, usesBrowserIdentity, expectedEndpoint, expectedTransport) in cases {
            let profile = try MacGatewayCatalogProfile(
                profile: MacGatewayProfile(id: "synthetic", name: "Gateway", url: #require(URL(string: address))),
                canPromote: false,
                usesBrowserIdentity: usesBrowserIdentity,
                authKind: authKind)
            let labels = GatewayMenuEndpointLabels.profile(profile)
            #expect(labels.endpointLabel == expectedEndpoint)
            #expect(labels.transportLabel == expectedTransport)
        }
    }

    private static func model(
        health: DashboardGatewayHealth = .unknown,
        version: String? = nil,
        buildId: String? = nil,
        endpointLabel: String? = nil,
        transportLabel: String? = nil,
        latencyMs: Double? = nil,
        windowCount: Int = 0,
        browserSessionExpiresAt: Date? = nil,
        lastSeen: Date? = nil,
        isProbing: Bool = false) -> GatewayMenuCardModel
    {
        GatewayMenuCardModel(
            name: "Gateway",
            isPrimary: false,
            isFrontmost: false,
            shortcutNumber: nil,
            health: health,
            version: version,
            buildId: buildId,
            endpointLabel: endpointLabel,
            transportLabel: transportLabel,
            latencyMs: latencyMs,
            windowCount: windowCount,
            browserSessionExpiresAt: browserSessionExpiresAt,
            lastSeen: lastSeen,
            isProbing: isProbing)
    }
}
