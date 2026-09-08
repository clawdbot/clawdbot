import Foundation
import OpenClawKit
import OpenClawProtocol

struct GatewayCompatibilityIssue: Equatable {
    let problem: GatewayConnectionProblem
    let versions: String

    init?(error: Error, appVersion: String? = GatewayEnvironment.appVersionString()) {
        guard let rejection = error as? GatewayConnectAuthError else { return nil }
        let minimum = GATEWAY_MIN_PROTOCOL_VERSION
        let maximum = GATEWAY_PROTOCOL_VERSION
        guard rejection.isProtocolMismatch(supportedProtocols: minimum...maximum) else { return nil }
        let normalized = GatewayConnectAuthError(
            message: rejection.message,
            detailCode: GatewayConnectAuthDetailCode.protocolMismatch.rawValue,
            canRetryWithDeviceToken: false,
            clientMinProtocol: minimum,
            clientMaxProtocol: maximum,
            expectedProtocol: rejection.expectedProtocol)
        guard let problem = GatewayConnectionProblemMapper.map(error: normalized) else { return nil }
        self.problem = problem
        let appProtocol = minimum == maximum ? "\(maximum)" : "\(minimum)–\(maximum)"
        let gatewayProtocol = rejection.expectedProtocol.map(String.init) ?? "unknown"
        self.versions = "OpenClaw app: \(appVersion ?? "unknown"). " +
            "App protocol: \(appProtocol). Gateway protocol: \(gatewayProtocol). " +
            "The Gateway did not report its release version."
    }

    var message: String {
        let action = self.problem.actionCommand.map { "Run \($0) on the Gateway host, then reconnect." }
            ?? "Update app from https://docs.openclaw.ai/platforms/macos, then reconnect."
        return "\(self.problem.title). \(self.versions) \(self.problem.message) \(action)"
    }
}

enum GatewayConnectionTone: Equatable {
    case healthy
    case transient
    case attention
}

struct GatewayConnectionPresentation: Equatable {
    let statusLine: String
    let generalSubtitle: String
    let tone: GatewayConnectionTone
    let needsAttention: Bool

    init(state: ControlChannel.ConnectionState) {
        switch state {
        case .connected:
            self.statusLine = String(localized: "Connected")
            self.generalSubtitle = String(localized: "Connected to your remote Gateway.")
            self.tone = .healthy
            self.needsAttention = false
        case .connecting:
            self.statusLine = String(localized: "Connecting…")
            self.generalSubtitle = String(localized: "Connecting to your remote Gateway…")
            self.tone = .transient
            self.needsAttention = false
        case .disconnected:
            self.statusLine = String(localized: "Disconnected")
            self
                .generalSubtitle =
                String(localized: "Disconnected from your remote Gateway. Open Connection settings to fix it.")
            self.tone = .attention
            self.needsAttention = false
        case let .degraded(message):
            let reason = message.trimmingCharacters(in: .whitespacesAndNewlines)
            self.statusLine = reason.isEmpty ? String(localized: "Gateway connection failed.") : reason
            self.generalSubtitle = self.statusLine + " " + String(localized: "Open Connection settings to fix it.")
            self.tone = .attention
            self.needsAttention = true
        }
    }
}
