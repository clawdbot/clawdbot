import Foundation
import OpenClawKit

enum GatewayDisplayState: Equatable {
    case connected
    case connecting
    case error
    case disconnected
}

enum GatewayStatusBuilder {
    @MainActor
    static func build(appModel: NodeAppModel) -> GatewayDisplayState {
        self.build(
            gatewayServerName: appModel.gatewayServerName,
            lastGatewayProblem: appModel.lastGatewayProblem,
            gatewayStatusText: appModel.gatewayStatusText)
    }

    static func build(
        gatewayServerName: String?,
        lastGatewayProblem: GatewayConnectionProblem?,
        gatewayStatusText: String) -> GatewayDisplayState
    {
        if gatewayServerName != nil { return .connected }
        if let lastGatewayProblem, lastGatewayProblem.pauseReconnect { return .error }

        let text = gatewayStatusText.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.localizedCaseInsensitiveContains("connecting") ||
            text.localizedCaseInsensitiveContains("reconnecting")
        {
            return .connecting
        }

        if text.localizedCaseInsensitiveContains("error") {
            return .error
        }

        return .disconnected
    }
}
