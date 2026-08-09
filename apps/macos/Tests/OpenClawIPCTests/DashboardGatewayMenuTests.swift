import Testing
@testable import OpenClaw

@MainActor
struct DashboardGatewayMenuTests {
    @Test func `connection label names primary only for multiple gateways`() {
        let primary = Self.entry(id: "primary", name: "Mac Studio", isPrimary: true, health: .ok)
        let profile = Self.entry(id: "profile:travel", name: "Travel", canPromote: true)
        let cases: [(AppState.ConnectionMode, ControlChannel.ConnectionState, [DashboardGatewayEntry], String)] = [
            (.unconfigured, .degraded("ignored"), [primary], "OpenClaw Not Configured"),
            (.unconfigured, .degraded("ignored"), [primary, profile], "OpenClaw Not Configured — Mac Studio"),
            (.local, .degraded("ignored"), [primary], "OpenClaw Active"),
            (.local, .degraded("ignored"), [primary, profile], "OpenClaw Active — Mac Studio"),
            (.remote, .connected, [primary], "Remote OpenClaw Active"),
            (.remote, .connected, [primary, profile], "Remote OpenClaw Active — Mac Studio"),
            (.remote, .connecting, [primary], "Remote OpenClaw Connecting"),
            (.remote, .degraded("auth failed"), [primary], "Remote OpenClaw Needs Attention"),
            (.remote, .degraded("auth failed"), [primary, profile], "Remote OpenClaw Needs Attention — Mac Studio"),
        ]

        for (mode, controlState, entries, expected) in cases {
            #expect(DashboardGatewayMenuModel.connectionLabel(
                mode: mode,
                controlState: controlState,
                entries: entries) == expected)
        }
    }

    @Test func `menu model is gated and preserves catalog facts`() {
        let primary = Self.entry(id: "primary", name: "Mac Studio", isPrimary: true, health: .ok)
        let profile = Self.entry(
            id: "profile:travel",
            name: "Travel",
            canPromote: true,
            health: .unknown)
        let cases: [([DashboardGatewayEntry], [DashboardGatewayMenuItem])] = [
            ([primary], []),
            ([primary, profile], [
                DashboardGatewayMenuItem(
                    target: .primary,
                    name: "Mac Studio",
                    health: .ok,
                    isPrimary: true,
                    canPromote: false,
                    shortcutNumber: 1),
                DashboardGatewayMenuItem(
                    target: .profile("travel"),
                    name: "Travel",
                    health: .unknown,
                    isPrimary: false,
                    canPromote: true,
                    shortcutNumber: 2),
            ]),
        ]

        for (entries, expected) in cases {
            #expect(DashboardGatewayMenuModel.items(from: entries) == expected)
        }
    }

    @Test func `gateway shortcuts stop after command nine`() {
        let entries = [
            Self.entry(id: "primary", name: "Primary", isPrimary: true, health: .ok),
        ] + (1...10).map { index in
            Self.entry(id: "profile:\(index)", name: "Gateway \(index)", canPromote: true)
        }

        let shortcuts = DashboardGatewayMenuModel.items(from: entries).map(\.shortcutNumber)

        #expect(shortcuts == [1, 2, 3, 4, 5, 6, 7, 8, 9, nil, nil])
    }

    private static func entry(
        id: String,
        name: String,
        isPrimary: Bool = false,
        canPromote: Bool = false,
        health: DashboardGatewayHealth = .unknown) -> DashboardGatewayEntry
    {
        DashboardGatewayEntry(
            id: id,
            name: name,
            kind: isPrimary ? "local" : "remote",
            isPrimary: isPrimary,
            canPromote: canPromote,
            health: health)
    }
}
