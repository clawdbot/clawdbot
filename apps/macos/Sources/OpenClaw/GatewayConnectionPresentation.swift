import Foundation

enum GatewayConnectionTone: Equatable {
    case healthy
    case transient
    case attention
}

struct GatewayConnectionPresentation: Equatable {
    let statusLine: String
    let generalTitle: String
    let generalSubtitle: String
    let symbolName: String
    let tone: GatewayConnectionTone
    let showsConnectionAction: Bool
    let needsAttention: Bool

    init(state: ControlChannel.ConnectionState) {
        switch state {
        case .connected:
            self.statusLine = String(localized: "Connected")
            self.generalTitle = String(localized: "OpenClaw active")
            self.generalSubtitle = String(localized: "Connected to your remote Gateway.")
            self.symbolName = "checkmark"
            self.tone = .healthy
            self.showsConnectionAction = false
            self.needsAttention = false
        case .connecting:
            self.statusLine = String(localized: "Connecting…")
            self.generalTitle = String(localized: "OpenClaw connecting")
            self.generalSubtitle = String(localized: "Connecting to your remote Gateway…")
            self.symbolName = "arrow.trianglehead.2.clockwise.rotate.90"
            self.tone = .transient
            self.showsConnectionAction = false
            self.needsAttention = false
        case .disconnected:
            self.statusLine = String(localized: "Disconnected")
            self.generalTitle = String(localized: "OpenClaw needs attention")
            self
                .generalSubtitle =
                String(localized: "Disconnected from your remote Gateway. Open Connection settings to fix it.")
            self.symbolName = "exclamationmark.triangle.fill"
            self.tone = .attention
            self.showsConnectionAction = true
            self.needsAttention = false
        case let .degraded(message):
            let reason = message.trimmingCharacters(in: .whitespacesAndNewlines)
            self.statusLine = reason.isEmpty ? String(localized: "Gateway connection failed.") : reason
            self.generalTitle = String(localized: "OpenClaw needs attention")
            self.generalSubtitle = self.statusLine + " " + String(localized: "Open Connection settings to fix it.")
            self.symbolName = "exclamationmark.triangle.fill"
            self.tone = .attention
            self.showsConnectionAction = true
            self.needsAttention = true
        }
    }
}

struct GeneralStatusPresentation: Equatable {
    let title: String
    let subtitle: String
    let symbolName: String
    let tone: GatewayConnectionTone
    let showsConnectionAction: Bool

    static func resolve(
        mode: AppState.ConnectionMode,
        isPaused: Bool,
        controlState: ControlChannel.ConnectionState,
        localFailure: String? = nil) -> Self
    {
        if mode == .local, let localFailure {
            return Self(
                title: String(localized: "OpenClaw needs attention"),
                subtitle: localFailure,
                symbolName: "exclamationmark.triangle.fill",
                tone: .attention,
                showsConnectionAction: true)
        }
        if isPaused {
            return Self(
                title: String(localized: "OpenClaw paused"),
                subtitle: String(localized: "Gateway work is paused; incoming messages will wait."),
                symbolName: "pause.fill",
                tone: .transient,
                showsConnectionAction: false)
        }

        switch mode {
        case .local:
            return Self(
                title: String(localized: "OpenClaw active"),
                subtitle: String(localized: "Processing messages through the local Gateway on this Mac."),
                symbolName: "checkmark",
                tone: .healthy,
                showsConnectionAction: false)
        case .unconfigured:
            return Self(
                title: String(localized: "OpenClaw active"),
                subtitle: String(localized: "Ready to run after you choose a Gateway connection."),
                symbolName: "checkmark",
                tone: .healthy,
                showsConnectionAction: false)
        case .remote:
            let connection = GatewayConnectionPresentation(state: controlState)
            return Self(
                title: connection.generalTitle,
                subtitle: connection.generalSubtitle,
                symbolName: connection.symbolName,
                tone: connection.tone,
                showsConnectionAction: connection.showsConnectionAction)
        }
    }
}
