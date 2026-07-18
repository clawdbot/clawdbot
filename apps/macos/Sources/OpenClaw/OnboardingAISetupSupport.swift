import Foundation
import OpenClawChatUI
import OpenClawKit

extension OnboardingAISetupModel {
    struct Candidate: Identifiable, Equatable {
        let kind: String
        let label: String
        let detail: String
        let modelRef: String
        let credentials: Bool?

        var id: String {
            self.kind
        }
    }

    struct CandidatePresentation: Equatable {
        let icon: String?
        let website: String?
    }

    struct UnavailableCandidate: Identifiable, Equatable, Decodable {
        let id: String
        let label: String
        let detail: String
        let reason: String
    }

    enum CandidateStatus: Equatable {
        case untried
        case testing
        case failed(Failure)
        case connected
    }

    struct Failure: Equatable {
        let summary: String
        let detail: String?

        var copyText: String {
            self.detail ?? self.summary
        }
    }

    enum Phase: Equatable {
        case idle
        case detecting
        case ready
        case testing
        case connected
    }

    enum PendingVerificationOutcome: Equatable {
        case connected
        case freshSetupAllowed
        case notConnected
        case superseded
    }

    struct ManualProvider: Identifiable, Equatable, Decodable {
        let id: String
        let label: String
        let hint: String?
        let icon: String?
        let website: String?
    }

    struct AuthOption: Identifiable, Equatable, Decodable {
        let id: String
        let label: String
        let hint: String?
        let groupLabel: String?
        let icon: String?
        let website: String?
        let kind: String
        let featured: Bool
    }

    struct RecommendedInstall: Identifiable, Equatable, Decodable {
        let id: String
        let label: String
        let hint: String
        let website: String
        let icon: String
    }

    static func canAcceptProviderAuthReconciliation(
        pending: Bool,
        setupComplete: Bool,
        configuredModel: String?) -> Bool
    {
        pending && setupComplete && configuredModel?.isEmpty == false
    }

    /// Transport/protocol failures deserve plain language, not RPC codes.
    static func friendlyTransportError(_ raw: String) -> String {
        if raw.localizedCaseInsensitiveContains("unknown method") {
            return "The Gateway is running an older OpenClaw version that doesn’t support " +
                "app-guided setup. Update OpenClaw on the gateway, then try again."
        }
        return raw.isEmpty
            ? "The Gateway setup request failed."
            : "The Gateway setup request failed. Show details to inspect or copy the error."
    }

    static func activationRequestTimeoutMs(for kind: String) -> Double {
        // Codex can spend 305s installing its runtime plugin before the 90s live probe.
        // Keep a bounded client deadline with room for registry refresh and finalization.
        kind == "codex-cli"
            ? OnboardingSystemAgentResumeStore.maximumActivationTimeoutMs
            : 150_000
    }

    static func activationFailureIsDefinitive(_ error: Error) -> Bool {
        if let response = error as? GatewayResponseError {
            let code = response.code.uppercased()
            let message = response.message.lowercased()
            // These responses are emitted before the activation handler runs.
            // Handler failures are UNAVAILABLE and can arrive after mutation.
            return code == "UNKNOWN_METHOD" ||
                (code == "INVALID_REQUEST" &&
                    (message.contains("unknown method") ||
                        message.contains("invalid openclaw.setup.activate params")))
        }
        return error is GatewayConnectAuthError ||
            error is GatewayTLSValidationError ||
            error is OpenClawChatTransportSendError
    }

    static func activationParams(
        kind: String,
        modelRef: String,
        supportsExactModel: Bool) -> [String: AnyCodable]
    {
        var params = ["kind": AnyCodable(kind)]
        if supportsExactModel {
            params["modelRef"] = AnyCodable(modelRef)
        }
        return params
    }

    static func providerAuthCancellationSessionID(requested: String, returned: String) -> String? {
        requested == returned ? nil : returned
    }

    static func normalizedSetupLines(_ lines: [String]?) -> [String] {
        (lines ?? []).compactMap { line in
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
    }

    /// Keep the exact Gateway-sanitized error available behind the friendly
    /// summary so users can copy it into support or diagnostics.
    static func failure(label: String, status: String?, error: String?) -> Failure {
        let detail = error?.trimmingCharacters(in: .whitespacesAndNewlines)
        return Failure(
            summary: self.friendlyFailure(label: label, status: status, error: detail),
            detail: detail?.isEmpty == false ? detail : nil)
    }

    static func transportFailure(_ raw: String) -> Failure {
        let detail = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return Failure(
            summary: self.friendlyTransportError(detail),
            detail: detail.isEmpty ? nil : detail)
    }

    /// One friendly sentence per failure bucket.
    static func friendlyFailure(label: String, status: String?, error: String?) -> String {
        let detail = error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        switch status {
        case "auth":
            return "\(label) is installed, but the login didn’t work. Sign in again, then retry."
        case "billing":
            return "\(label) responded, but the account has a billing problem."
        case "rate_limit":
            return "\(label) is temporarily rate-limited. Try again in a moment."
        case "timeout":
            return "\(label) didn’t answer in time."
        case "format", "unavailable":
            return detail.isEmpty
                ? "\(label) couldn’t complete the test."
                : "\(label) couldn’t complete the test. Show details to inspect or copy the error."
        default:
            return detail.isEmpty
                ? "\(label) couldn’t complete the test."
                : "\(label) couldn’t complete the test. Show details to inspect or copy the error."
        }
    }

    var connectedSummary: String {
        guard let modelRef = connectedModelRef else { return "Your AI is connected." }
        let label = candidates.first { $0.kind == self.selectedKind }?.label ??
            (selectedKind == "api-key" ? selectedManualProvider?.label : nil)
        let via = label.map { " via \($0)" } ?? ""
        if let latency = connectedLatencyMs {
            let seconds = Double(latency) / 1000
            return "\(modelRef)\(via) — replied in \(String(format: "%.1f", seconds))s"
        }
        return "\(modelRef)\(via)"
    }

    var connectedSetupCopyText: String {
        connectedSetupLines.joined(separator: "\n")
    }
}
