import Foundation

struct DashboardGatewayMenuItem: Equatable, Identifiable, Sendable {
    let target: DashboardGatewayTarget
    let name: String
    let health: DashboardGatewayHealth
    let isPrimary: Bool
    let canPromote: Bool
    let shortcutNumber: Int?

    var id: String {
        self.target.bridgeID
    }
}

enum DashboardGatewayMenuModel {
    static func items(from entries: [DashboardGatewayEntry]) -> [DashboardGatewayMenuItem] {
        guard entries.count >= 2 else { return [] }
        return entries.enumerated().compactMap { index, entry in
            guard let target = DashboardGatewayTarget(bridgeID: entry.id) else { return nil }
            return DashboardGatewayMenuItem(
                target: target,
                name: entry.name,
                health: entry.health,
                isPrimary: entry.isPrimary,
                canPromote: entry.canPromote,
                shortcutNumber: index < 9 ? index + 1 : nil)
        }
    }

    static func connectionLabel(
        mode: AppState.ConnectionMode,
        controlState: ControlChannel.ConnectionState,
        entries: [DashboardGatewayEntry]) -> String
    {
        guard entries.count >= 2,
              let primaryName = entries.first(where: \.isPrimary)?.name.nonEmpty
        else {
            return switch mode {
            case .unconfigured:
                String(localized: "OpenClaw Not Configured")
            case .remote:
                self.remoteConnectionLabel(state: controlState)
            case .local:
                String(localized: "OpenClaw Active")
            }
        }
        return switch mode {
        case .unconfigured:
            String(localized: "OpenClaw Not Configured — \(primaryName)")
        case .remote:
            self.remoteConnectionLabel(state: controlState, primaryName: primaryName)
        case .local:
            String(localized: "OpenClaw Active — \(primaryName)")
        }
    }

    private static func remoteConnectionLabel(
        state: ControlChannel.ConnectionState,
        primaryName: String? = nil) -> String
    {
        switch (state, primaryName) {
        case (.connected, nil):
            String(localized: "Remote OpenClaw Active")
        case let (.connected, .some(name)):
            String(localized: "Remote OpenClaw Active — \(name)")
        case (.connecting, nil):
            String(localized: "Remote OpenClaw Connecting")
        case let (.connecting, .some(name)):
            String(localized: "Remote OpenClaw Connecting — \(name)")
        case (.disconnected, nil), (.degraded, nil):
            String(localized: "Remote OpenClaw Needs Attention")
        case let (.disconnected, .some(name)), let (.degraded, .some(name)):
            String(localized: "Remote OpenClaw Needs Attention — \(name)")
        }
    }
}
