import Foundation
import OpenClawChatUI
import OpenClawKit

extension OnboardingAISetupModel {
    struct PersistedActivationState: Equatable {
        let setupComplete: Bool
        let configuredModel: String?
    }

    struct AttemptContext: Equatable {
        let token: UUID
        let routeIdentity: String
        let supersededAttemptDeadline: Date?
    }

    struct PendingVerification {
        let context: AttemptContext
        let task: Task<PendingVerificationOutcome, Never>
    }

    struct CompletedHandoff {
        let routeIdentity: String
        let activationOwner: OnboardingSystemAgentResumeStore.ActivationOwner?
    }

    @MainActor
    struct ReconciliationDeadline {
        private let clock: ContinuousClock
        private let deadline: ContinuousClock.Instant

        init(timeout: ContinuousClock.Duration, clock: ContinuousClock = .init()) {
            self.clock = clock
            self.deadline = clock.now.advanced(by: timeout)
        }

        var hasTimeRemaining: Bool {
            self.clock.now < self.deadline
        }

        func remainingMilliseconds(cappedAt capMs: Int) -> Int {
            OnboardingAISetupModel.remainingMilliseconds(
                until: self.deadline,
                clock: self.clock,
                cappedAt: capMs)
        }
    }

    struct DetectResult: Decodable {
        struct DetectedCandidate: Decodable {
            let brandId: String?
            let icon: String?
            let website: String?
            let kind: String
            let label: String
            let detail: String
            let modelRef: String
            let credentials: Bool?
        }

        let candidates: [DetectedCandidate]
        let unavailableCandidates: [UnavailableCandidate]?
        let manualProviders: [ManualProvider]?
        let authOptions: [AuthOption]?
        let prepareOptions: [PrepareOption]?
        let recommendedInstalls: [RecommendedInstall]?
        let configuredModel: String?
        let setupComplete: Bool?

        var persistedActivationState: PersistedActivationState? {
            self.setupComplete.map {
                PersistedActivationState(
                    setupComplete: $0,
                    configuredModel: self.configuredModel)
            }
        }
    }

    struct ActivateResult: Decodable {
        let ok: Bool
        let modelRef: String?
        let status: String?
        let error: String?
    }

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
        let brandId: String?
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
        let brandId: String?
        let label: String
        let hint: String?
        let icon: String?
        let website: String?
    }

    struct AuthOption: Identifiable, Equatable, Decodable {
        let id: String
        let brandId: String?
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
        let brandId: String?
    }

    struct PrepareOption: Identifiable, Equatable, Decodable {
        let id: String
        let label: String
        let hint: String?
        let actionLabel: String?
        let brandId: String?
        let icon: String?
        let website: String?
    }

    enum ProviderWizardKind: Equatable {
        case auth
        case prepare

        var startMethod: String {
            switch self {
            case .auth: "openclaw.setup.auth.start"
            case .prepare: "openclaw.setup.prepare.start"
            }
        }
    }

    var selectedManualProvider: ManualProvider? {
        self.manualProviders.first { $0.id == self.manualProviderID }
    }

    var prepareOptions: [PrepareOption] {
        guard self.prepareAvailable else { return [] }
        return Self.prepareOptions(
            candidates: self.candidates,
            advertisedOptions: self.detectedPrepareOptions)
    }

    var isPreparingModel: Bool {
        self.providerWizardKind == .prepare
    }

    var connected: Bool {
        self.phase == .connected
    }

    var isBusy: Bool {
        self.phase == .detecting || self.phase == .testing || self.manualTesting || self.authBusy ||
            self.pendingActivationVerification
    }

    func canSelectCandidate(kind: String) -> Bool {
        guard !self.connected else { return false }
        return !self.isBusy || (self.phase == .testing && self.selectedKind != kind)
    }

    /// Once setup starts changing inference, its successful result belongs to
    /// OpenClaw rather than the existing-Gateway onboarding bypass.
    var ownsInferenceTransition: Bool {
        (self.phase == .detecting && self.configuredGatewayBlocker == nil) ||
            self.phase == .testing || self.manualTesting || self.authBusy || self.connected ||
            self.pendingActivationVerification
    }

    static func prepareOptions(
        candidates: [Candidate],
        advertisedOptions: [PrepareOption]?) -> [PrepareOption]
    {
        // Released Gateways do not send prepareOptions. Preserve their two
        // existing rows until the connected Gateway advertises provider-owned choices.
        let legacyOptions = [
            PrepareOption(
                id: "ollama",
                label: "Ollama",
                hint: "Download a tools-capable model from your Ollama server",
                actionLabel: nil,
                brandId: "ollama",
                icon: nil,
                website: nil),
            PrepareOption(
                id: "llama-cpp",
                label: "Local model (llama.cpp)",
                hint: "Download an approximately 5.0 GB local model; requires 16 GB RAM",
                actionLabel: nil,
                brandId: "llama-cpp",
                icon: nil,
                website: nil),
        ]
        return (advertisedOptions ?? legacyOptions).filter { choice in
            let providerKind = self.providerAutoSetupKind(choiceID: choice.id)
            guard !candidates.contains(where: {
                $0.credentials != false &&
                    ($0.kind == providerKind ||
                        $0.modelRef.hasPrefix("\(choice.brandId ?? choice.id)/"))
            }) else { return false }
            return true
        }
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

    static func activationAdmissionIsBusy(_ error: Error) -> Bool {
        guard let response = error as? GatewayResponseError else { return false }
        return response.method == "openclaw.setup.activate" &&
            response.code.uppercased() == "UNAVAILABLE" &&
            response.details["retryable"]?.value as? Bool == true
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

    static func providerAutoSetupKind(choiceID: String) -> String {
        let componentCharacters = CharacterSet(
            charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        let encoded = choiceID.addingPercentEncoding(withAllowedCharacters: componentCharacters) ?? choiceID
        return "provider-auto:\(encoded)"
    }

    static func providerAuthCancellationSessionID(requested: String, returned: String) -> String? {
        requested == returned ? nil : returned
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

    static func activationTransitionWasPersisted(
        expectedModel: String,
        before: PersistedActivationState?,
        after: PersistedActivationState?) -> Bool
    {
        guard let before, let after else { return false }
        let wasAlreadyPersisted = before.setupComplete && before.configuredModel == expectedModel
        return !wasAlreadyPersisted && after.setupComplete && after.configuredModel == expectedModel
    }

    static func remainingMilliseconds(
        until deadline: ContinuousClock.Instant,
        clock: ContinuousClock,
        cappedAt capMs: Int) -> Int
    {
        let components = clock.now.duration(to: deadline).components
        let milliseconds = components.seconds * 1000 + components.attoseconds / 1_000_000_000_000_000
        return max(0, min(capMs, Int(milliseconds)))
    }
}

enum OnboardingAISetupError: LocalizedError {
    case providerCatalogUnavailable

    var errorDescription: String? {
        switch self {
        case .providerCatalogUnavailable:
            "The Gateway is running an older OpenClaw version that doesn’t provide the " +
                "supported provider list. Update OpenClaw on the gateway, then try again."
        }
    }
}
