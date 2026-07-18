import Foundation
import Observation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol

/// Structured "Connect your AI" onboarding step.
///
/// Drives the gateway's `openclaw.setup.detect` / `openclaw.setup.activate`
/// RPCs: detect reusable AI access (CLI logins, provider credentials, and local model
/// servers), live-test candidates in the detected order, and automatically fall
/// through when one fails. Config is only written server-side after a
/// candidate actually answered, so this page can never strand the user with a
/// broken model.
@MainActor
@Observable
final class OnboardingAISetupModel {
    /// Device-code providers advertise windows up to 15 minutes. Keep transport
    /// alive long enough for approval plus the post-login inference probe.
    static let providerAuthRequestTimeoutMs: Double = 1_200_000

    private(set) var phase: Phase = .idle {
        didSet {
            // Close-guard: quitting mid-test is confirmable, not silent.
            OnboardingController.shared.busyReason = if self.phase == .testing {
                "OpenClaw is testing your AI connection."
            } else if self.activeAuthOption != nil {
                "OpenClaw is completing provider sign-in."
            } else {
                nil
            }
        }
    }

    private(set) var candidates: [Candidate] = []
    private(set) var unavailableCandidates: [UnavailableCandidate] = []
    private(set) var manualProviders: [ManualProvider] = []
    private(set) var authOptions: [AuthOption] = []
    private(set) var recommendedInstalls: [RecommendedInstall] = []
    private(set) var candidatePresentation: [String: CandidatePresentation] = [:]
    private(set) var activeAuthOption: AuthOption?
    private(set) var authStep: WizardStep?
    private(set) var authError: Failure?
    private(set) var authBusy = false {
        didSet {
            if self.activeAuthOption != nil {
                OnboardingController.shared.busyReason = "OpenClaw is completing provider sign-in."
            } else if self.phase != .testing {
                OnboardingController.shared.busyReason = nil
            }
        }
    }

    var authText = ""
    var authSelection = 0
    var authConfirmation = true
    private(set) var providerCatalogLoaded = false
    private(set) var providerCatalogError: String?
    private(set) var statuses: [String: CandidateStatus] = [:]
    private(set) var selectedKind: String?
    private(set) var connectedModelRef: String?
    private(set) var connectedLatencyMs: Int?
    private(set) var connectedSetupLines: [String] = []
    private(set) var detectError: Failure?
    private(set) var pendingActivationVerification = false
    private(set) var waitingForPendingActivationDeadline = false
    private(set) var configuredGatewayProbeUnavailable = false
    /// Set once every detected candidate failed; opens the manual key form.
    private(set) var exhaustedAutoCandidates = false

    var manualProviderID = ""
    var manualKey: String = ""
    private(set) var manualTesting = false
    private(set) var manualError: Failure?
    var showManualEntry = false

    var selectedManualProvider: ManualProvider? {
        self.manualProviders.first { $0.id == self.manualProviderID }
    }

    var connected: Bool {
        self.phase == .connected
    }

    var isBusy: Bool {
        self.phase == .detecting || self.phase == .testing || self.manualTesting || self.authBusy ||
            self.pendingActivationVerification
    }

    /// Once setup starts changing inference, its successful result belongs to
    /// OpenClaw rather than the existing-Gateway onboarding bypass.
    var ownsInferenceTransition: Bool {
        (self.phase == .detecting && !self.configuredGatewayProbeUnavailable) ||
            self.phase == .testing || self.manualTesting || self.authBusy || self.connected ||
            self.pendingActivationVerification
    }

    /// Called when a candidate connects so the page can advance.
    var onConnected: (() -> Void)?
    /// Called whenever setup enters the read-only wait for an ambiguous
    /// activation lease. The view owns the route-bound, coalesced timer.
    var onPendingActivationDeadline: ((Date, String) -> Void)?

    private let gateway: GatewayConnection
    private let defaults: UserDefaults
    private let routeIdentityProvider: @MainActor () -> String?
    private var started = false
    private var attemptToken = UUID()
    @ObservationIgnored private var pendingVerification: PendingVerification?
    @ObservationIgnored private var pendingActivationOwner: OnboardingSystemAgentResumeStore.ActivationOwner?
    @ObservationIgnored private var completedHandoff: CompletedHandoff?
    @ObservationIgnored private var pendingActivationRequiresFreshActivation = false
    @ObservationIgnored private var serverLease: GatewayConnection.ServerLease?
    @ObservationIgnored private var lastDetectedActivationState: PersistedActivationState?
    @ObservationIgnored private var authSessionID: String?
    @ObservationIgnored private var authAttemptID = UUID()
    /// Only a just-completed provider flow may trust setupComplete without re-probing.
    @ObservationIgnored private var providerAuthReconciliationPending = false

    private struct PersistedActivationState: Equatable {
        let setupComplete: Bool
        let configuredModel: String?
    }

    private struct AttemptContext: Equatable {
        let token: UUID
        let routeIdentity: String
    }

    private struct PendingVerification {
        let context: AttemptContext
        let task: Task<PendingVerificationOutcome, Never>
    }

    private struct CompletedHandoff {
        let routeIdentity: String
        let activationOwner: OnboardingSystemAgentResumeStore.ActivationOwner?
    }

    init(
        gateway: GatewayConnection = .shared,
        defaults: UserDefaults = .standard,
        routeIdentityProvider: @escaping @MainActor () -> String? = {
            OnboardingSystemAgentResumeStore.selectedRouteIdentity()
        })
    {
        self.gateway = gateway
        self.defaults = defaults
        self.routeIdentityProvider = routeIdentityProvider
    }

    private struct DetectResult: Decodable {
        struct DetectedCandidate: Decodable {
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
        let latencyMs: Double?
        let lines: [String]?
        let status: String?
        let error: String?
    }

    func startIfNeeded() {
        if self.waitingForPendingActivationDeadline {
            self.resetForGatewayChange(clearPendingHandoff: false)
        }
        guard !self.started else { return }
        self.configuredGatewayProbeUnavailable = false
        self.started = true
        self.phase = .detecting
        scheduleDetection()
    }

    func retryFromScratch() {
        // The configured-Gateway preflight has its own read-only retry. Never
        // turn an unavailable agents.list response into setup mutation.
        guard !self.configuredGatewayProbeUnavailable else { return }
        guard !self.waitingForPendingActivationDeadline else { return }
        if self.pendingActivationVerification {
            Task { await self.verifyPendingConfiguredInference() }
            return
        }
        self.resetForGatewayChange()
        self.started = true
        self.phase = .detecting
        scheduleDetection()
    }

    func showConfiguredGatewayProbeUnavailable() {
        guard !self.ownsInferenceTransition ||
            self.configuredGatewayProbeUnavailable ||
            self.waitingForPendingActivationDeadline
        else { return }
        // Retire stale candidates and `started` state. A later successful
        // missing-model probe must be able to run a fresh detect/activate flow.
        self.resetForGatewayChange(clearPendingHandoff: false)
        self.configuredGatewayProbeUnavailable = true
        self.phase = .ready
        self.detectError = Failure(
            summary: "The Gateway did not answer the inference check. Nothing was changed.",
            detail: nil)
    }

    func beginConfiguredGatewayProbeRetry() {
        guard self.configuredGatewayProbeUnavailable else { return }
        self.phase = .detecting
        self.detectError = nil
    }

    func waitForPendingActivationDeadline() {
        guard !self.connected,
              self.phase != .testing,
              !self.manualTesting,
              !self.pendingActivationVerification,
              let routeIdentity = routeIdentityProvider(),
              let deadline = activePendingActivationDeadline(for: routeIdentity)
        else { return }
        if !self.waitingForPendingActivationDeadline {
            self.resetForGatewayChange(clearPendingHandoff: false)
        }
        self.beginPendingActivationDeadlineWait(
            deadline: deadline,
            routeIdentity: routeIdentity)
    }

    /// Restore only the pending handoff state. A configured model label is not
    /// proof that the ambiguous activation completed or that inference works.
    func resumeConfiguredInference(modelRef: String) {
        let model = modelRef.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !model.isEmpty else { return }
        if self.waitingForPendingActivationDeadline {
            self.resetForGatewayChange(clearPendingHandoff: false)
        }
        // Reconnects and page changes can discover the same pending handoff
        // repeatedly. Keep the first attempt and let every caller await it.
        guard !self.ownsInferenceTransition else { return }
        let routeIdentity = self.routeIdentityProvider()
        let pendingState = OnboardingSystemAgentResumeStore.pendingState(
            for: routeIdentity,
            defaults: self.defaults)
        let inMemoryOwner = self.pendingActivationOwner
        let restoredOwner = OnboardingSystemAgentResumeStore.activationOwner(
            for: routeIdentity,
            defaults: self.defaults)
        let activationOwner = inMemoryOwner ?? restoredOwner
        // A completed receipt may resume only after live inference and an exact
        // owner check. Other relaunched states must repeat activation because a
        // model label alone does not prove which attempt committed it.
        let requiresFreshActivation = inMemoryOwner != nil || pendingState != .none
        self.resetForGatewayChange(clearPendingHandoff: false)
        // resetForGatewayChange retires the async attempt but the route-owned
        // durable receipt above must survive into this reconciliation attempt.
        self.pendingActivationOwner = activationOwner
        self.pendingActivationRequiresFreshActivation = requiresFreshActivation
        self.started = true
        self.pendingActivationVerification = true
        self.phase = .detecting
    }

    /// Reconcile an ambiguous activation on the same Gateway route. A live turn
    /// is necessary, but only a matching durable completion receipt may hand off;
    /// otherwise setup repeats a fresh activate round-trip.
    @discardableResult
    func verifyPendingConfiguredInference() async -> PendingVerificationOutcome {
        guard self.pendingActivationVerification,
              let context = captureAttemptContext()
        else { return .superseded }
        if let pendingVerification, pendingVerification.context == context {
            let outcome = await pendingVerification.task.value
            guard isCurrentAttempt(context), !Task.isCancelled else { return .superseded }
            return outcome
        }
        let task = Task { @MainActor [weak self] in
            guard let self else { return PendingVerificationOutcome.superseded }
            return await self.performPendingConfiguredInferenceVerification(context: context)
        }
        pendingVerification = PendingVerification(context: context, task: task)
        let outcome = await task.value
        if pendingVerification?.context == context {
            pendingVerification = nil
        }
        guard isCurrentAttempt(context), !Task.isCancelled else { return .superseded }
        if outcome == .freshSetupAllowed, isCurrentAttempt(context) {
            self.resetForGatewayChange(clearPendingHandoff: false)
            self.startIfNeeded()
        }
        return outcome
    }

    private func performPendingConfiguredInferenceVerification(
        context: AttemptContext) async -> PendingVerificationOutcome
    {
        guard self.pendingActivationVerification, isCurrentAttempt(context), !Task.isCancelled else {
            return .superseded
        }
        self.phase = .detecting
        self.detectError = nil
        let lease: GatewayConnection.ServerLease
        do {
            lease = try await self.gateway.acquireServerLease()
        } catch {
            guard isCurrentAttempt(context), !Task.isCancelled else { return .superseded }
            self.phase = .ready
            self.detectError = Self.transportFailure(
                "The selected Gateway changed before inference could be verified. Try again.")
            return self.pendingVerificationFailureOutcome(context: context)
        }
        guard isCurrentAttempt(context),
              !Task.isCancelled,
              await self.gateway.isCurrentServerLease(lease)
        else { return .superseded }
        if let activationOwner = pendingActivationOwner {
            guard let currentFingerprint = await gateway.activationOwnershipFingerprint(
                ifCurrentServerLease: lease)
            else {
                self.phase = .ready
                self.detectError = Self.transportFailure(
                    "Secure storage is unavailable, so OpenClaw cannot verify which Gateway completed AI setup.")
                return .notConnected
            }
            guard activationOwner.routeFingerprint == currentFingerprint else {
                switch OnboardingSystemAgentResumeStore.pendingState(
                    for: context.routeIdentity,
                    defaults: self.defaults)
                {
                case let .activating(deadline), let .verified(deadline):
                    // Replacement auth cannot verify this owner, but the old
                    // activation may still mutate the same route. Keep its lease.
                    self.pendingActivationVerification = false
                    self.beginPendingActivationDeadlineWait(
                        deadline: deadline,
                        routeIdentity: context.routeIdentity)
                    return .notConnected
                case .activationExpired, .completed, .none:
                    // No live mutation remains to overlap. Retire only this
                    // owner, then let the replacement credentials start fresh.
                    OnboardingSystemAgentResumeStore.clear(
                        ifOwnedBy: context.routeIdentity,
                        activationOwner: activationOwner,
                        defaults: self.defaults)
                    self.pendingActivationVerification = false
                    self.phase = .ready
                    self.detectError = Self.transportFailure(
                        "The Gateway authentication changed while AI setup was finishing. Testing it again.")
                    return .freshSetupAllowed
                }
            }
        }
        do {
            let data = try await gateway.request(
                method: "openclaw.setup.verify",
                params: [:],
                timeoutMs: 150_000,
                ifCurrentServerLease: lease)
            guard await self.gateway.isCurrentServerLease(lease),
                  isCurrentAttempt(context),
                  !Task.isCancelled
            else { return .superseded }
            let result = try JSONDecoder().decode(ActivateResult.self, from: data)
            if result.ok, let modelRef = result.modelRef {
                let pendingState = OnboardingSystemAgentResumeStore.pendingState(
                    for: context.routeIdentity,
                    defaults: self.defaults)
                switch pendingState {
                case let .activating(deadline), let .verified(deadline):
                    // This proves inference works, but not that the dropped
                    // activation stopped mutating. Preserve its deadline.
                    OnboardingSystemAgentResumeStore.markVerified(
                        ifOwnedBy: context.routeIdentity,
                        activationOwner: self.pendingActivationOwner,
                        defaults: self.defaults)
                    self.pendingActivationVerification = false
                    self.detectError = nil
                    self.beginPendingActivationDeadlineWait(
                        deadline: deadline,
                        routeIdentity: context.routeIdentity)
                    return .notConnected
                case .activationExpired, .none:
                    if self.pendingActivationRequiresFreshActivation {
                        self.pendingActivationVerification = false
                        clearPendingHandoff(ifOwnedBy: context)
                        return .freshSetupAllowed
                    }
                case .completed:
                    finishConnected(
                        kind: "existing-model",
                        result: result,
                        activationOwner: self.pendingActivationOwner,
                        requireExistingReceipt: true)
                    if self.connected {
                        return .connected
                    }
                    // The receipt owner changed while verification was in flight.
                    // Adopt it only for a fresh verification; this result cannot attest it.
                    self.retainCompletedReceiptForRetry(context: context)
                    return .notConnected
                }
                self.acceptVerifiedPendingInference(
                    modelRef: modelRef,
                    latencyMs: result.latencyMs)
                return self.connected ? .connected : .superseded
            }
            self.phase = .ready
            self.detectError = Self.failure(
                label: "Configured AI",
                status: result.status,
                error: result.error)
            return self.pendingVerificationFailureOutcome(context: context)
        } catch {
            guard isCurrentAttempt(context), !Task.isCancelled else { return .superseded }
            // A failed read-only verification never proves activation failed.
            // Keep the marker and let Try again repeat this same verification.
            self.phase = .ready
            self.detectError = Self.transportFailure(error.localizedDescription)
            return self.pendingVerificationFailureOutcome(context: context)
        }
    }

    private func pendingVerificationFailureOutcome(
        context: AttemptContext) -> PendingVerificationOutcome
    {
        switch OnboardingSystemAgentResumeStore.pendingState(
            for: context.routeIdentity,
            defaults: self.defaults)
        {
        case let .activating(deadline), let .verified(deadline):
            // The dropped activation may still be writing config or credentials.
            // Verification may repeat, but mutation stays blocked until its lease ends.
            if let activationOwner = pendingActivationOwner,
               !OnboardingSystemAgentResumeStore.isOwned(
                   by: activationOwner,
                   for: context.routeIdentity,
                   defaults: defaults)
            {
                self.pendingActivationVerification = false
                self.beginPendingActivationDeadlineWait(
                    deadline: deadline,
                    routeIdentity: context.routeIdentity)
                return .notConnected
            }
            self.pendingActivationVerification = true
            return .notConnected
        case .completed:
            // Completion is durable proof that activation returned success. A
            // read-only transport failure cannot authorize replacement setup.
            self.retainCompletedReceiptForRetry(context: context)
            return .notConnected
        case .activationExpired, .none:
            self.pendingActivationVerification = false
            clearPendingHandoff(ifOwnedBy: context)
            return .freshSetupAllowed
        }
    }

    private func retainCompletedReceiptForRetry(context: AttemptContext) {
        self.pendingActivationOwner = OnboardingSystemAgentResumeStore.activationOwner(
            for: context.routeIdentity,
            defaults: self.defaults)
        self.pendingActivationRequiresFreshActivation = true
        self.pendingActivationVerification = true
    }

    private func activePendingActivationDeadline(for routeIdentity: String) -> Date? {
        switch OnboardingSystemAgentResumeStore.pendingState(
            for: routeIdentity,
            defaults: self.defaults)
        {
        case let .activating(deadline), let .verified(deadline):
            deadline
        case .activationExpired, .completed, .none:
            nil
        }
    }

    private func beginPendingActivationDeadlineWait(
        deadline: Date,
        routeIdentity: String)
    {
        self.waitingForPendingActivationDeadline = true
        self.phase = .detecting
        self.onPendingActivationDeadline?(deadline, routeIdentity)
    }

    private func retainAmbiguousActivation(
        ifOwnedBy context: AttemptContext,
        activationOwner: OnboardingSystemAgentResumeStore.ActivationOwner,
        activationDeadline: Date)
    {
        guard isCurrentAttempt(context) else { return }
        self.pendingActivationVerification = true
        switch OnboardingSystemAgentResumeStore.pendingState(
            for: context.routeIdentity,
            defaults: self.defaults)
        {
        case let .activating(deadline), let .verified(deadline):
            guard OnboardingSystemAgentResumeStore.isOwned(
                by: activationOwner,
                for: context.routeIdentity,
                defaults: self.defaults)
            else {
                // Another process replaced this lease. Never let our result
                // complete or clear the newer activation.
                self.pendingActivationVerification = false
                self.beginPendingActivationDeadlineWait(
                    deadline: deadline,
                    routeIdentity: context.routeIdentity)
                return
            }
            self.beginPendingActivationDeadlineWait(
                deadline: deadline,
                routeIdentity: context.routeIdentity)
        case .none:
            // A concurrent read-only probe can clear the marker while the
            // dispatched handler is still returning. Restore route ownership
            // before probing so failure or relaunch cannot start a duplicate.
            OnboardingSystemAgentResumeStore.restorePending(
                routeIdentity: context.routeIdentity,
                activationOwner: activationOwner,
                deadline: activationDeadline,
                defaults: self.defaults)
            self.beginPendingActivationDeadlineWait(
                deadline: Date(),
                routeIdentity: context.routeIdentity)
        case .activationExpired, .completed:
            // The marker no longer blocks mutation, but the dispatched handler
            // may still commit. Probe immediately so only observed Gateway
            // state can decide when a fresh activation is safe.
            self.beginPendingActivationDeadlineWait(
                deadline: Date(),
                routeIdentity: context.routeIdentity)
        }
    }

    /// Complete a receipt-backed restored handoff after route-bound live inference.
    func acceptVerifiedPendingInference(modelRef: String, latencyMs: Double? = nil) {
        let model = modelRef.trimmingCharacters(in: .whitespacesAndNewlines)
        guard self.pendingActivationVerification, !model.isEmpty else { return }
        guard self.pendingActivationOwner == nil else { return }
        finishConnected(
            kind: "existing-model",
            result: ActivateResult(
                ok: true,
                modelRef: model,
                latencyMs: latencyMs,
                lines: nil,
                status: nil,
                error: nil),
            activationOwner: self.pendingActivationOwner)
    }

    /// Clear only the completed receipt created by this setup attempt.
    /// A replacement activation on the same route retains its own receipt.
    func clearCompletedHandoffIfOwned() {
        guard let completedHandoff else { return }
        OnboardingSystemAgentResumeStore.clear(
            ifOwnedBy: completedHandoff.routeIdentity,
            activationOwner: completedHandoff.activationOwner,
            defaults: self.defaults)
        self.completedHandoff = nil
    }

    /// Cancel route-bound work and discard results that belong to the previous Gateway.
    func resetForGatewayChange(clearPendingHandoff: Bool = true) {
        let authSessionToCancel = self.authSessionID
        let authServerLease = self.serverLease
        if clearPendingHandoff, let routeIdentity = routeIdentityProvider() {
            OnboardingSystemAgentResumeStore.clear(
                ifOwnedBy: routeIdentity,
                activationOwner: self.pendingActivationOwner,
                defaults: self.defaults)
        }
        self.attemptToken = UUID()
        self.pendingVerification?.task.cancel()
        self.pendingVerification = nil
        self.pendingActivationOwner = nil
        self.completedHandoff = nil
        self.pendingActivationRequiresFreshActivation = false
        self.lastDetectedActivationState = nil
        self.started = false
        self.phase = .idle
        self.candidates = []
        self.unavailableCandidates = []
        self.manualProviders = []
        self.authOptions = []
        self.recommendedInstalls = []
        self.candidatePresentation = [:]
        self.activeAuthOption = nil
        self.authStep = nil
        self.authError = nil
        self.authBusy = false
        self.authText = ""
        self.authSessionID = nil
        self.authAttemptID = UUID()
        self.providerAuthReconciliationPending = false
        self.providerCatalogLoaded = false
        self.providerCatalogError = nil
        self.statuses = [:]
        self.selectedKind = nil
        self.connectedModelRef = nil
        self.connectedLatencyMs = nil
        self.connectedSetupLines = []
        self.detectError = nil
        self.pendingActivationVerification = false
        self.waitingForPendingActivationDeadline = false
        self.configuredGatewayProbeUnavailable = false
        self.exhaustedAutoCandidates = false
        self.serverLease = nil
        self.manualProviderID = ""
        self.manualKey = ""
        self.manualError = nil
        self.manualTesting = false
        self.showManualEntry = false
        if let authSessionToCancel, let authServerLease {
            Task {
                await self.gateway.cancelWizardSession(authSessionToCancel, on: authServerLease)
            }
        }
    }
}

extension OnboardingAISetupModel {
    func detectAndAutoConnect() async {
        guard let context = captureAttemptContext() else {
            self.failDetectionForMissingRoute()
            return
        }
        await self.detectAndAutoConnect(context: context)
    }

    private func scheduleDetection() {
        guard let context = captureAttemptContext() else {
            self.failDetectionForMissingRoute()
            return
        }
        Task { await self.detectAndAutoConnect(context: context) }
    }

    private func detectAndAutoConnect(context: AttemptContext) async {
        // Gateway awaits can yield to a route reset or cancellation. Revalidate
        // before every activation side effect so stale attempts cannot hand off.
        guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
        self.phase = .detecting
        self.detectError = nil
        self.providerCatalogError = nil
        do {
            let lease = try await gateway.acquireServerLease()
            guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
            let data = try await gateway.request(
                method: "openclaw.setup.detect",
                params: [:],
                timeoutMs: 20000,
                ifCurrentServerLease: lease)
            guard await self.gateway.isCurrentServerLease(lease),
                  self.isCurrentAttempt(context),
                  !Task.isCancelled
            else { return }
            let result = try JSONDecoder().decode(DetectResult.self, from: data)
            self.serverLease = lease
            self.lastDetectedActivationState = result.persistedActivationState
            let manualProviders = result.manualProviders ?? []
            let authOptions = result.authOptions ?? []
            self.authOptions = authOptions
            self.recommendedInstalls = result.recommendedInstalls ?? []
            self.candidatePresentation = Dictionary(
                result.candidates.map { candidate in
                    (candidate.kind, CandidatePresentation(icon: candidate.icon, website: candidate.website))
                },
                uniquingKeysWith: { current, _ in current })
            let providerAuthReconciliationPending = self.providerAuthReconciliationPending
            self.providerAuthReconciliationPending = false
            if Self.canAcceptProviderAuthReconciliation(
                pending: providerAuthReconciliationPending,
                setupComplete: result.setupComplete == true,
                configuredModel: result.configuredModel),
                let configuredModel = result.configuredModel
            {
                finishConnected(
                    kind: "provider-auth",
                    result: ActivateResult(
                        ok: true,
                        modelRef: configuredModel,
                        latencyMs: nil,
                        lines: nil,
                        status: nil,
                        error: nil))
                return
            }
            self.candidates = result.candidates.map { detected in
                Candidate(
                    kind: detected.kind,
                    label: detected.label,
                    detail: detected.detail,
                    modelRef: detected.modelRef,
                    credentials: detected.credentials)
            }
            self.manualProviders = manualProviders
            self.providerCatalogLoaded = result.manualProviders != nil
            if result.manualProviders == nil {
                self.providerCatalogError = OnboardingAISetupError.providerCatalogUnavailable.localizedDescription
            }
            self.unavailableCandidates = result.unavailableCandidates ?? []
            if !manualProviders.contains(where: { $0.id == self.manualProviderID }) {
                self.manualProviderID = manualProviders.first?.id ?? ""
            }
            for candidate in self.candidates {
                self.statuses[candidate.kind] = .untried
            }
            self.phase = .ready
            if let first = autoCandidateAfter(kind: nil) {
                // Candidate found: connect without asking. Switching later
                // stays one click away while the test runs server-side.
                await self.activate(kind: first.kind, context: context)
            } else {
                self.showManualEntry = !self.manualProviders.isEmpty
            }
        } catch {
            guard self.isCurrentAttempt(context) else { return }
            self.phase = .ready
            self.detectError = Self.transportFailure(error.localizedDescription)
            self.showManualEntry = self.candidates.isEmpty
        }
    }

    private func captureAttemptContext() -> AttemptContext? {
        let identity = self.routeIdentityProvider()?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let identity, !identity.isEmpty else { return nil }
        return AttemptContext(token: self.attemptToken, routeIdentity: identity)
    }

    private func beginAttemptContext() -> AttemptContext? {
        self.attemptToken = UUID()
        return self.captureAttemptContext()
    }

    private func isCurrentAttempt(_ context: AttemptContext) -> Bool {
        context.token == self.attemptToken &&
            self.routeIdentityProvider()?.trimmingCharacters(in: .whitespacesAndNewlines) == context.routeIdentity
    }

    private func clearPendingHandoff(
        ifOwnedBy context: AttemptContext,
        activationOwner: OnboardingSystemAgentResumeStore.ActivationOwner? = nil)
    {
        guard self.isCurrentAttempt(context) else { return }
        OnboardingSystemAgentResumeStore.clear(
            ifOwnedBy: context.routeIdentity,
            activationOwner: activationOwner ?? self.pendingActivationOwner,
            defaults: self.defaults)
    }

    private func failDetectionForMissingRoute() {
        self.phase = .ready
        self.detectError = Self.transportFailure(
            "No Gateway is selected. Select a Gateway, then try again.")
    }

    private static func activationTransitionWasPersisted(
        expectedModel: String,
        before: PersistedActivationState?,
        after: PersistedActivationState?) -> Bool
    {
        guard let before, let after else { return false }
        let wasAlreadyPersisted = before.setupComplete && before.configuredModel == expectedModel
        return !wasAlreadyPersisted && after.setupComplete && after.configuredModel == expectedModel
    }

    /// Candidates the automatic ladder may try: skip definitively logged-out
    /// installs and anything already attempted.
    private func autoCandidateAfter(kind: String?) -> Candidate? {
        let startIndex: Int = if let kind, let index = candidates.firstIndex(where: { $0.kind == kind }) {
            index + 1
        } else {
            0
        }
        guard startIndex <= self.candidates.count else { return nil }
        return self.candidates[startIndex...].first { candidate in
            candidate.credentials != false && self.statuses[candidate.kind] == .untried
        }
    }

    func userSelect(kind: String) {
        guard !self.isBusy else { return }
        guard self.statuses[kind] != .connected else { return }
        guard let context = beginAttemptContext() else { return }
        Task { await self.activate(kind: kind, context: context) }
    }

    func activate(kind: String) async {
        guard !self.pendingActivationVerification else { return }
        guard let context = captureAttemptContext() else {
            self.statuses[kind] = .failed(Self.transportFailure(
                "No Gateway is selected. Select a Gateway, then try again."))
            self.phase = .ready
            return
        }
        await self.activate(kind: kind, context: context)
    }

    private func activate(kind: String, context: AttemptContext) async {
        guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
        guard let candidate = candidates.first(where: { $0.kind == kind }),
              let lease = serverLease,
              await gateway.isCurrentServerLease(lease)
        else {
            requireFreshDetection(after: Self.transportFailure(
                "The Gateway connection changed. Check for AI accounts again."))
            return
        }
        guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
        let persistedStateBeforeActivation = self.lastDetectedActivationState
        let requestTimeoutMs = Self.activationRequestTimeoutMs(for: kind)
        self.selectedKind = kind
        self.phase = .testing
        self.statuses[kind] = .testing
        guard let supportsExactModel = await gateway.supportsServerCapability(
            .systemAgentSetupModelRef,
            ifCurrentServerLease: lease),
            isCurrentAttempt(context),
            !Task.isCancelled
        else {
            requireFreshDetection(after: Self.transportFailure(
                "The Gateway connection changed. Check for AI accounts again."))
            return
        }
        guard let routeFingerprint = await gateway.activationOwnershipFingerprint(
            ifCurrentServerLease: lease)
        else {
            self.statuses[kind] = .failed(Self.transportFailure(
                "Secure storage is unavailable, so OpenClaw cannot safely resume this AI setup."))
            self.phase = .ready
            return
        }
        guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
        let params = Self.activationParams(
            kind: kind,
            modelRef: candidate.modelRef,
            supportsExactModel: supportsExactModel)
        let activationOwner = OnboardingSystemAgentResumeStore.ActivationOwner(
            id: UUID().uuidString,
            routeFingerprint: routeFingerprint)
        self.pendingActivationOwner = activationOwner
        self.pendingActivationRequiresFreshActivation = true
        // Activation can persist before the response reaches the app. Cover the
        // whole ambiguous window so relaunch can inspect the actual Gateway state.
        guard let activationDeadline = OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: context.routeIdentity,
            activationOwner: activationOwner,
            activationTimeoutMs: requestTimeoutMs,
            defaults: defaults)
        else {
            self.statuses[kind] = .failed(Self.transportFailure(
                "No Gateway is selected. Select a Gateway, then try again."))
            self.phase = .ready
            return
        }
        guard !Task.isCancelled else {
            self.clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
            self.phase = .ready
            return
        }
        do {
            let data = try await gateway.request(
                method: "openclaw.setup.activate",
                params: params,
                timeoutMs: requestTimeoutMs,
                ifCurrentServerLease: lease)
            let result = try JSONDecoder().decode(ActivateResult.self, from: data)
            guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
            guard await self.gateway.isCurrentServerLease(lease) else {
                if result.ok,
                   OnboardingSystemAgentResumeStore.markCompleted(
                       ifOwnedBy: context.routeIdentity,
                       activationOwner: activationOwner,
                       defaults: self.defaults)
                {
                    self.pendingActivationVerification = true
                    self.phase = .detecting
                    _ = await self.verifyPendingConfiguredInference()
                } else {
                    self.pendingActivationVerification = false
                    self.clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
                    requireFreshDetection(after: Self.transportFailure(
                        "The Gateway connection changed while AI setup was finishing. Check again."))
                }
                return
            }
            guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
            if result.ok {
                finishConnected(kind: kind, result: result, activationOwner: activationOwner)
            } else {
                self.pendingActivationVerification = false
                self.clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
                self.statuses[kind] = .failed(Self.failure(
                    label: self.candidates.first { $0.kind == kind }?.label ?? kind,
                    status: result.status,
                    error: result.error))
                await tryNextAfterFailure(of: kind, context: context)
            }
        } catch {
            guard self.isCurrentAttempt(context) else { return }
            // Cancellation, decoding, and transport failures after dispatch are
            // ambiguous. Keep the marker; model-label detection is not proof that
            // this activation and its credential mutation completed safely.
            let failure = Self.transportFailure(error.localizedDescription)
            self.statuses[kind] = .failed(failure)
            if Self.activationFailureIsDefinitive(error) {
                self.pendingActivationVerification = false
                self.clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
                if await self.gateway.isCurrentServerLease(lease) {
                    self.phase = .ready
                } else {
                    requireFreshDetection(after: failure)
                }
            } else {
                // A managed Gateway can restart after persisting fresh-Mac Codex setup.
                // The retired process cannot mutate further, so accept only the same
                // route/auth owner, an exact persisted transition, and a fresh live turn.
                if !Task.isCancelled,
                   await !(self.gateway.isCurrentServerLease(lease)),
                   await self.reconcileActivationAfterGatewayRestart(
                       kind: kind,
                       context: context,
                       activationOwner: activationOwner,
                       before: persistedStateBeforeActivation,
                       originalServerLease: lease)
                {
                    return
                }
                // Do not start another provider while the request can still commit.
                // The route-bound deadline probe decides whether setup may resume.
                self.retainAmbiguousActivation(
                    ifOwnedBy: context,
                    activationOwner: activationOwner,
                    activationDeadline: activationDeadline)
            }
        }
    }

    private func reconcileActivationAfterGatewayRestart(
        kind: String,
        context: AttemptContext,
        activationOwner: OnboardingSystemAgentResumeStore.ActivationOwner,
        before: PersistedActivationState?,
        originalServerLease: GatewayConnection.ServerLease) async -> Bool
    {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(30))
        var delayMs = 250
        while clock.now < deadline {
            guard self.isCurrentAttempt(context), !Task.isCancelled else { return false }
            let leaseTimeoutMs = Self.remainingMilliseconds(
                until: deadline,
                clock: clock,
                cappedAt: 3000)
            guard leaseTimeoutMs > 0 else { return false }
            if let replacementLease = try? await gateway.acquireServerLease(
                ifSameRouteAs: originalServerLease,
                timeoutMs: Double(leaseTimeoutMs)),
                await reconcilePersistedActivation(
                    kind: kind,
                    context: context,
                    activationOwner: activationOwner,
                    before: before,
                    serverLease: replacementLease,
                    timeoutMs: Self.remainingMilliseconds(
                        until: deadline,
                        clock: clock,
                        cappedAt: 10000))
            {
                self.serverLease = replacementLease
                return true
            }
            let sleepMs = Self.remainingMilliseconds(
                until: deadline,
                clock: clock,
                cappedAt: delayMs)
            guard sleepMs > 0 else { return false }
            do {
                try await Task.sleep(nanoseconds: UInt64(sleepMs) * 1_000_000)
            } catch {
                return false
            }
            delayMs = min(delayMs * 2, 2000)
        }
        return false
    }

    private func reconcilePersistedActivation(
        kind: String,
        context: AttemptContext,
        activationOwner: OnboardingSystemAgentResumeStore.ActivationOwner,
        before: PersistedActivationState?,
        serverLease: GatewayConnection.ServerLease,
        timeoutMs: Int) async -> Bool
    {
        guard timeoutMs > 0,
              let expectedModel = candidates.first(where: { $0.kind == kind })?.modelRef,
              isCurrentAttempt(context),
              !Task.isCancelled,
              OnboardingSystemAgentResumeStore.isOwned(
                  by: activationOwner,
                  for: context.routeIdentity,
                  defaults: defaults),
              await gateway.activationOwnershipFingerprint(ifCurrentServerLease: serverLease) ==
              activationOwner.routeFingerprint
        else { return false }
        guard let detectData = try? await gateway.request(
            method: "openclaw.setup.detect",
            params: [:],
            timeoutMs: Double(timeoutMs),
            ifCurrentServerLease: serverLease),
            await gateway.isCurrentServerLease(serverLease),
            isCurrentAttempt(context),
            !Task.isCancelled,
            let detection = try? JSONDecoder().decode(DetectResult.self, from: detectData),
            Self.activationTransitionWasPersisted(
                expectedModel: expectedModel,
                before: before,
                after: detection.persistedActivationState)
        else { return false }
        guard let verifyData = try? await gateway.request(
            method: "openclaw.setup.verify",
            params: [:],
            timeoutMs: Double(timeoutMs),
            ifCurrentServerLease: serverLease),
            await gateway.isCurrentServerLease(serverLease),
            isCurrentAttempt(context),
            !Task.isCancelled,
            let result = try? JSONDecoder().decode(ActivateResult.self, from: verifyData),
            result.ok,
            result.modelRef == expectedModel
        else { return false }
        finishConnected(
            kind: kind,
            result: result,
            activationOwner: activationOwner)
        return self.connected
    }

    private static func remainingMilliseconds(
        until deadline: ContinuousClock.Instant,
        clock: ContinuousClock,
        cappedAt capMs: Int) -> Int
    {
        let components = clock.now.duration(to: deadline).components
        let milliseconds = components.seconds * 1000 + components.attoseconds / 1_000_000_000_000_000
        return max(0, min(capMs, Int(milliseconds)))
    }
}

extension OnboardingAISetupModel {
    func startProviderAuth(_ option: AuthOption) {
        guard !self.isBusy, self.activeAuthOption == nil, let serverLease else { return }
        self.activeAuthOption = option
        self.authStep = nil
        self.authError = nil
        self.authText = ""
        self.authBusy = true
        self.providerAuthReconciliationPending = false
        let token = self.attemptToken
        let authAttemptID = UUID()
        let authSessionID = UUID().uuidString
        self.authAttemptID = authAttemptID
        self.authSessionID = authSessionID
        Task {
            do {
                let data = try await self.gateway.request(
                    method: "openclaw.setup.auth.start",
                    params: [
                        "sessionId": AnyCodable(authSessionID),
                        "authChoice": AnyCodable(option.id),
                    ],
                    timeoutMs: 600_000,
                    ifCurrentServerLease: serverLease)
                let result = try JSONDecoder().decode(WizardStartResult.self, from: data)
                guard token == self.attemptToken, authAttemptID == self.authAttemptID else {
                    // A route reset can race the start response. Cancel the
                    // decoded server session so the discarded flow cannot commit.
                    await self.gateway.cancelWizardSession(result.sessionid, on: serverLease)
                    return
                }
                if let cancellationSessionID = Self.providerAuthCancellationSessionID(
                    requested: authSessionID,
                    returned: result.sessionid)
                {
                    // The returned id owns the live server session. Cancel that
                    // session even when the Gateway violated the echo contract.
                    self.authSessionID = cancellationSessionID
                    self.cancelProviderAuth()
                    return
                }
                if !result.done, result.step == nil, wizardStatusString(result.status) == "running" {
                    self.advanceProviderAuth(stepID: nil, value: nil)
                    return
                }
                self.applyAuthWizardResult(
                    done: result.done,
                    step: result.step,
                    status: wizardStatusString(result.status),
                    error: result.error)
            } catch {
                // The Gateway session survives socket loss; cancel by its known
                // id before reporting failure so it cannot persist config later.
                let cancellation = await self.gateway.cancelWizardSession(
                    authSessionID,
                    on: serverLease)
                guard token == self.attemptToken, authAttemptID == self.authAttemptID else { return }
                if cancellation != .cancelled,
                   await self.reconcileProviderAuthAfterUnknownOutcome(
                       token: token,
                       before: self.lastDetectedActivationState,
                       originalServerLease: serverLease)
                {
                    return
                }
                if cancellation != .unresolved {
                    self.authSessionID = nil
                }
                self.authBusy = false
                self.authError = Self.transportFailure(error.localizedDescription)
            }
        }
    }

    func continueProviderAuth() {
        guard let step = authStep else { return }
        let value: AnyCodable? = switch wizardStepType(step) {
        case "text": AnyCodable(self.authText)
        case "select": self.selectedAuthWizardOption?.value
        case "confirm": AnyCodable(self.authConfirmation)
        default: nil
        }
        self.advanceProviderAuth(stepID: step.id, value: value)
    }

    func cancelProviderAuth() {
        let sessionID = self.authSessionID
        let authServerLease = self.serverLease
        guard let sessionID, let authServerLease else {
            self.authAttemptID = UUID()
            self.providerAuthReconciliationPending = false
            self.clearProviderAuth()
            return
        }
        let authAttemptID = self.authAttemptID
        let token = self.attemptToken
        let activationState = self.lastDetectedActivationState
        self.authBusy = true
        Task {
            let cancellation = await self.gateway.cancelWizardSession(
                sessionID,
                on: authServerLease)
            guard authAttemptID == self.authAttemptID else { return }
            if cancellation == .absent,
               await self.reconcileProviderAuthAfterUnknownOutcome(
                   token: token,
                   before: activationState,
                   originalServerLease: authServerLease)
            {
                return
            }
            if cancellation != .unresolved {
                self.authAttemptID = UUID()
                self.providerAuthReconciliationPending = false
                self.clearProviderAuth()
            }
        }
    }

    var authWizardOptions: [WizardOption] {
        parseWizardOptions(self.authStep?.options)
    }

    var selectedAuthWizardOption: WizardOption? {
        let options = self.authWizardOptions
        guard options.indices.contains(self.authSelection) else { return options.first }
        return options[self.authSelection]
    }

    private func advanceProviderAuth(stepID: String?, value: AnyCodable?) {
        guard let sessionID = authSessionID, let serverLease else { return }
        self.authBusy = true
        self.authError = nil
        var params: [String: AnyCodable] = ["sessionId": AnyCodable(sessionID)]
        if let stepID {
            var answer: [String: AnyCodable] = ["stepId": AnyCodable(stepID)]
            if let value {
                answer["value"] = value
            }
            params["answer"] = AnyCodable(answer)
        }
        let token = self.attemptToken
        let authAttemptID = self.authAttemptID
        Task {
            do {
                let data = try await self.gateway.request(
                    method: "wizard.next",
                    params: params,
                    timeoutMs: Self.providerAuthRequestTimeoutMs,
                    ifCurrentServerLease: serverLease)
                guard token == self.attemptToken, authAttemptID == self.authAttemptID else { return }
                let result = try JSONDecoder().decode(WizardNextResult.self, from: data)
                self.applyAuthWizardResult(
                    done: result.done,
                    step: result.step,
                    status: wizardStatusString(result.status),
                    error: result.error)
            } catch {
                let cancellation = await self.gateway.cancelWizardSession(sessionID, on: serverLease)
                guard token == self.attemptToken, authAttemptID == self.authAttemptID else { return }
                if cancellation != .cancelled,
                   await self.reconcileProviderAuthAfterUnknownOutcome(
                       token: token,
                       before: self.lastDetectedActivationState,
                       originalServerLease: serverLease)
                {
                    return
                }
                if cancellation != .unresolved {
                    self.authSessionID = nil
                }
                self.authBusy = false
                self.authError = Self.transportFailure(error.localizedDescription)
            }
        }
    }

    private func applyAuthWizardResult(
        done: Bool,
        step: WizardStep?,
        status: String?,
        error: String?)
    {
        self.authBusy = false
        let validationError = !done && status == "running" && error?.isEmpty == false
        let preserveEnteredValue = validationError && self.authStep?.id == step?.id
        if status == "error" || (done && error != nil) {
            // Terminal sessions are removed by the Gateway. Drop the local id
            // so Cancel dismisses the preserved, copyable error immediately.
            self.authSessionID = nil
            self.authStep = nil
            self.authError = Self.failure(
                label: self.activeAuthOption?.label ?? "Provider login",
                status: "unavailable",
                error: error)
            return
        }
        if status == "cancelled" {
            self.clearProviderAuth()
            return
        }
        if done || status == "done" {
            self.providerAuthReconciliationPending = true
            self.clearProviderAuth()
            self.scheduleDetection()
            return
        }
        self.authStep = step
        if validationError {
            self.authError = Self.failure(
                label: self.activeAuthOption?.label ?? "Provider login",
                status: "format",
                error: error)
        }
        if !preserveEnteredValue {
            self.authText = anyCodableString(step?.initialvalue)
        }
        self.authConfirmation = anyCodableBool(step?.initialvalue)
        let options = parseWizardOptions(step?.options)
        self.authSelection = max(0, options.firstIndex {
            anyCodableEqual($0.value, step?.initialvalue)
        } ?? 0)
    }

    private func reconcileProviderAuthAfterUnknownOutcome(
        token: UUID,
        before: PersistedActivationState?,
        originalServerLease: GatewayConnection.ServerLease) async -> Bool
    {
        guard let before else { return false }
        let lease: GatewayConnection.ServerLease
        if await self.gateway.isCurrentServerLease(originalServerLease) {
            lease = originalServerLease
        } else {
            guard let replacement = try? await gateway.acquireServerLease(
                ifSameRouteAs: originalServerLease,
                timeoutMs: 5000)
            else { return false }
            lease = replacement
        }
        guard let data = try? await gateway.request(
            method: "openclaw.setup.detect",
            params: [:],
            timeoutMs: 10000,
            ifCurrentServerLease: lease),
            token == attemptToken,
            let result = try? JSONDecoder().decode(DetectResult.self, from: data),
            let configuredModel = result.configuredModel,
            Self.activationTransitionWasPersisted(
                expectedModel: configuredModel,
                before: before,
                after: result.persistedActivationState)
        else { return false }
        self.serverLease = lease
        self.clearProviderAuth()
        finishConnected(
            kind: "provider-auth",
            result: ActivateResult(
                ok: true,
                modelRef: configuredModel,
                latencyMs: nil,
                lines: nil,
                status: nil,
                error: nil))
        return true
    }

    private func clearProviderAuth() {
        self.activeAuthOption = nil
        self.authSessionID = nil
        self.authStep = nil
        self.authError = nil
        self.authBusy = false
        self.authText = ""
    }

    #if DEBUG
    func _test_setProviderAuth(option: AuthOption, sessionID: String) {
        self.activeAuthOption = option
        self.authSessionID = sessionID
        self.authBusy = true
    }

    func _test_applyAuthWizardResult(done: Bool, status: String?, error: String?) {
        self.applyAuthWizardResult(done: done, step: nil, status: status, error: error)
    }

    var _test_authSessionID: String? {
        self.authSessionID
    }
    #endif
}

extension OnboardingAISetupModel {
    func submitManualKey() {
        let key = self.manualKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let provider = selectedManualProvider, !key.isEmpty, !self.isBusy else { return }
        guard let context = beginAttemptContext() else {
            self.manualError = Self.transportFailure(
                "No Gateway is selected. Select a Gateway, then try again.")
            return
        }
        self.manualError = nil
        self.manualTesting = true
        Task { await self.submitManualKey(key: key, provider: provider, context: context) }
    }

    private func submitManualKey(
        key: String,
        provider: ManualProvider,
        context: AttemptContext) async
    {
        defer {
            if self.isCurrentAttempt(context) {
                self.manualTesting = false
            }
        }
        guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
        guard let lease = serverLease,
              await gateway.isCurrentServerLease(lease)
        else {
            let failure = Self.transportFailure(
                "The Gateway connection changed. Check for AI accounts again.")
            self.manualError = failure
            self.requireFreshDetection(after: failure)
            return
        }
        guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
        guard let routeFingerprint = await gateway.activationOwnershipFingerprint(
            ifCurrentServerLease: lease)
        else {
            self.manualError = Self.transportFailure(
                "Secure storage is unavailable, so OpenClaw cannot safely resume this AI setup.")
            return
        }
        guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
        let requestTimeoutMs = Self.activationRequestTimeoutMs(for: "api-key")
        let activationOwner = OnboardingSystemAgentResumeStore.ActivationOwner(
            id: UUID().uuidString,
            routeFingerprint: routeFingerprint)
        self.pendingActivationOwner = activationOwner
        self.pendingActivationRequiresFreshActivation = true
        // Manual activation has the same persist-before-response ambiguity as
        // detected candidates, so relaunch must inspect exact Gateway truth.
        guard let activationDeadline = OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: context.routeIdentity,
            activationOwner: activationOwner,
            activationTimeoutMs: requestTimeoutMs,
            defaults: defaults)
        else {
            self.manualError = Self.transportFailure(
                "No Gateway is selected. Select a Gateway, then try again.")
            return
        }
        guard !Task.isCancelled else {
            self.clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
            return
        }
        do {
            let data = try await gateway.request(
                method: "openclaw.setup.activate",
                params: [
                    "kind": AnyCodable("api-key"),
                    "authChoice": AnyCodable(provider.id),
                    "apiKey": AnyCodable(key),
                ],
                timeoutMs: requestTimeoutMs,
                ifCurrentServerLease: lease)
            let result = try JSONDecoder().decode(ActivateResult.self, from: data)
            guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
            guard await self.gateway.isCurrentServerLease(lease) else {
                if result.ok,
                   OnboardingSystemAgentResumeStore.markCompleted(
                       ifOwnedBy: context.routeIdentity,
                       activationOwner: activationOwner,
                       defaults: self.defaults)
                {
                    self.pendingActivationVerification = true
                    self.phase = .detecting
                    _ = await self.verifyPendingConfiguredInference()
                } else {
                    self.pendingActivationVerification = false
                    self.clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
                    self.requireFreshDetection(after: Self.transportFailure(
                        "The Gateway connection changed while AI setup was finishing. Check again."))
                }
                return
            }
            guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
            if result.ok {
                self.manualKey = ""
                self.finishConnected(
                    kind: "api-key",
                    result: result,
                    activationOwner: activationOwner)
            } else {
                self.pendingActivationVerification = false
                self.clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
                self.manualError = Self.failure(
                    label: provider.label,
                    status: result.status,
                    error: result.error)
            }
        } catch {
            guard self.isCurrentAttempt(context) else { return }
            // A cancellation after request dispatch is ambiguous; keep the
            // pending marker so relaunch reconciles against this exact route.
            let failure = Self.transportFailure(error.localizedDescription)
            self.manualError = failure
            if Self.activationFailureIsDefinitive(error) {
                self.pendingActivationVerification = false
                self.clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
                if await !(self.gateway.isCurrentServerLease(lease)) {
                    self.requireFreshDetection(after: failure)
                }
            } else {
                self.retainAmbiguousActivation(
                    ifOwnedBy: context,
                    activationOwner: activationOwner,
                    activationDeadline: activationDeadline)
            }
        }
    }

    /// A retired socket invalidates every candidate and provider record learned
    /// from that server generation. Preserve the error, but require a fresh
    /// detection lease before the user can dispatch another setup mutation.
    func requireFreshDetection(after failure: Failure) {
        self.resetForGatewayChange()
        self.phase = .ready
        self.detectError = failure
    }

    private func finishConnected(
        kind: String,
        result: ActivateResult,
        activationOwner: OnboardingSystemAgentResumeStore.ActivationOwner? = nil,
        requireExistingReceipt: Bool = false)
    {
        let routeIdentity = self.routeIdentityProvider()?.trimmingCharacters(in: .whitespacesAndNewlines)
        let completedReceipt = OnboardingSystemAgentResumeStore.markCompleted(
            ifOwnedBy: routeIdentity,
            activationOwner: activationOwner,
            defaults: self.defaults)
        if activationOwner != nil || requireExistingReceipt {
            guard completedReceipt else {
                self.pendingActivationVerification = false
                self.statuses[kind] = .failed(Self.transportFailure(
                    "Another AI setup attempt replaced this activation. Waiting for its result."))
                self.phase = .ready
                return
            }
        }
        self.pendingActivationVerification = false
        self.waitingForPendingActivationDeadline = false
        self.statuses[kind] = .connected
        self.selectedKind = kind
        self.connectedModelRef = result.modelRef
        self.connectedLatencyMs = result.latencyMs.map { Int($0.rounded()) }
        self.connectedSetupLines = Self.normalizedSetupLines(result.lines)
        self.phase = .connected
        self.pendingActivationOwner = activationOwner
        self.completedHandoff = completedReceipt ? routeIdentity.flatMap { routeIdentity in
            routeIdentity.isEmpty ? nil : CompletedHandoff(
                routeIdentity: routeIdentity,
                activationOwner: activationOwner)
        } : nil
        self.pendingActivationRequiresFreshActivation = false
        self.onConnected?()
    }

    private func tryNextAfterFailure(of kind: String, context: AttemptContext) async {
        guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
        if let next = autoCandidateAfter(kind: kind) {
            await self.activate(kind: next.kind, context: context)
            return
        }
        self.phase = .ready
        self.exhaustedAutoCandidates = true
        self.showManualEntry = true
    }

    #if DEBUG
    func _test_setConnectedSetupLines(_ lines: [String]?) {
        self.connectedSetupLines = Self.normalizedSetupLines(lines)
    }
    #endif
}

private enum OnboardingAISetupError: LocalizedError {
    case providerCatalogUnavailable

    var errorDescription: String? {
        switch self {
        case .providerCatalogUnavailable:
            "The Gateway is running an older OpenClaw version that doesn’t provide the " +
                "supported provider list. Update OpenClaw on the gateway, then try again."
        }
    }
}
