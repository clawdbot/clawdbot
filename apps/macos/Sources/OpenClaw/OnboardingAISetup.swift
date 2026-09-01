import Foundation
import Observation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol

/// Structured "Connect your AI" onboarding step.
///
/// Detects reusable AI access and hosts the Gateway's interactive activation
/// wizard. The Gateway owns capability review and only saves a model after a
/// live completion; the app preserves route ownership across delayed responses.
@MainActor
@Observable
final class OnboardingAISetupModel {
    private(set) var phase: Phase = .idle {
        didSet { self.updateBusyReason() }
    }

    private(set) var candidates: [Candidate] = []
    private(set) var unavailableCandidates: [UnavailableCandidate] = []
    private(set) var manualProviders: [ManualProvider] = []
    private(set) var authOptions: [AuthOption] = []
    private(set) var recommendedInstalls: [RecommendedInstall] = []
    private(set) var detectedPrepareOptions: [PrepareOption]?
    private(set) var prepareAvailable = false
    private(set) var candidatePresentation: [String: CandidatePresentation] = [:]
    private(set) var activeAuthOption: AuthOption?
    private(set) var providerWizardKind: ProviderWizardKind?
    private(set) var authStep: WizardStep?
    private(set) var authError: Failure?
    private(set) var authBusy = false {
        didSet { self.updateBusyReason() }
    }

    var authText = ""
    var authSelection = 0
    var authConfirmation = true
    private(set) var providerCatalogLoaded = false
    private(set) var providerCatalogError: String?
    private(set) var statuses: [String: CandidateStatus] = [:]
    private(set) var selectedKind: String?
    private(set) var detectError: Failure?
    private(set) var pendingActivationVerification = false
    private(set) var waitingForPendingActivationDeadline = false
    private(set) var configuredGatewayBlocker: ConfiguredGatewayBlocker?
    /// Set once every detected candidate failed; opens the manual key form.
    private(set) var exhaustedAutoCandidates = false

    var manualProviderID = ""
    var manualKey: String = ""
    private(set) var manualTesting = false {
        didSet { self.updateBusyReason() }
    }

    private(set) var manualError: Failure?
    var showManualEntry = false

    /// Called when a candidate connects so the page can advance.
    var onConnected: (() -> Void)?
    /// Called whenever setup enters the read-only wait for an ambiguous
    /// activation lease. The view owns the route-bound, coalesced timer.
    var onPendingActivationDeadline: ((Date, String) -> Void)?

    private let gateway: GatewayConnection
    private let defaults: UserDefaults
    private let routeIdentityProvider: @MainActor () -> String?
    private let connectionModeProvider: @MainActor () -> AppState.ConnectionMode
    private var started = false
    private var attemptToken = UUID()
    @ObservationIgnored private var pendingVerification: PendingVerification?
    @ObservationIgnored private var pendingActivationOwner: OnboardingSystemAgentResumeStore.ActivationOwner?
    @ObservationIgnored private var completedHandoff: CompletedHandoff?
    @ObservationIgnored private var pendingActivationRequiresFreshActivation = false
    @ObservationIgnored private var serverLease: GatewayConnection.ServerLease?
    @ObservationIgnored private var lastDetectedActivationState: PersistedActivationState?
    @ObservationIgnored private var activationWizardCompletion: CheckedContinuation<ActivateResult, Error>?
    @ObservationIgnored private var authSessionID: String?
    @ObservationIgnored private var authAttemptID = UUID()
    @ObservationIgnored private var authRequestID: UUID?
    @ObservationIgnored private var providerAuthCancellationRequested = false
    /// Only a just-completed provider flow may trust setupComplete without re-probing.
    @ObservationIgnored private var providerAuthReconciliationPending = false

    init(
        gateway: GatewayConnection = .shared,
        defaults: UserDefaults = AppDefaults.standard,
        routeIdentityProvider: @escaping @MainActor () -> String? = {
            OnboardingSystemAgentResumeStore.selectedRouteIdentity()
        },
        connectionModeProvider: @escaping @MainActor () -> AppState.ConnectionMode = {
            AppStateStore.shared.connectionMode
        })
    {
        self.gateway = gateway
        self.defaults = defaults
        self.routeIdentityProvider = routeIdentityProvider
        self.connectionModeProvider = connectionModeProvider
    }

    private func updateBusyReason() {
        // Every connection attempt must make quitting mid-setup confirmable.
        OnboardingController.shared.busyReason = if self.phase == .testing || self.manualTesting ||
            self.phase == .detecting && self.pendingActivationVerification
        {
            "OpenClaw is testing your AI connection."
        } else if self.activeAuthOption != nil {
            self.isPreparingModel
                ? "OpenClaw is preparing a local model."
                : "OpenClaw is completing provider sign-in."
        } else {
            nil
        }
    }

    func startIfNeeded() {
        if self.waitingForPendingActivationDeadline {
            self.resetForGatewayChange(clearPendingHandoff: false)
        }
        guard !self.started else { return }
        self.configuredGatewayBlocker = nil
        self.started = true
        self.phase = .detecting
        scheduleDetection()
    }

    func retryFromScratch() {
        // The configured-Gateway preflight has its own read-only retry. Never
        // turn an unavailable agents.list response into setup mutation.
        guard self.configuredGatewayBlocker == nil else { return }
        guard !self.waitingForPendingActivationDeadline else { return }
        if self.pendingActivationVerification {
            self.detectError = nil
            self.phase = .detecting
            Task { await self.verifyPendingConfiguredInference() }
            return
        }
        self.resetForGatewayChange()
        self.started = true
        self.phase = .detecting
        scheduleDetection()
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

    func updateConfiguredGatewayBlockerState(
        _ blocker: ConfiguredGatewayBlocker?,
        phase: Phase,
        detectError: Failure?)
    {
        self.configuredGatewayBlocker = blocker
        self.phase = phase
        self.detectError = detectError
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
            if activationOwner.isUnbound {
                // Unbound receipts never resume across relaunch or verification
                // retry; a fresh activation is the only safe continuation.
                self.pendingActivationVerification = false
                clearPendingHandoff(ifOwnedBy: context)
                return .freshSetupAllowed
            }
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
                    guard let receiptOwner = self.pendingActivationOwner, !receiptOwner.isUnbound
                    else {
                        // Ownerless and unbound receipts carry no auth binding,
                        // so they can belong to replaced credentials on this
                        // route. Never let one authorize a handoff — repeat a
                        // fresh activation instead.
                        self.pendingActivationVerification = false
                        clearPendingHandoff(ifOwnedBy: context)
                        return .freshSetupAllowed
                    }
                    finishConnected(
                        kind: "existing-model",
                        activationOwner: receiptOwner)
                    if self.connected {
                        return .connected
                    }
                    // The receipt owner changed while verification was in flight.
                    // Adopt it only for a fresh verification; this result cannot attest it.
                    self.retainCompletedReceiptForRetry(context: context)
                    return .notConnected
                }
                self.acceptVerifiedPendingInference(modelRef: modelRef)
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

    /// Live verification without an activation owner reopens pre-existing inference.
    func acceptVerifiedPendingInference(modelRef: String) {
        let model = modelRef.trimmingCharacters(in: .whitespacesAndNewlines)
        guard self.pendingActivationVerification, !model.isEmpty else { return }
        guard self.pendingActivationOwner == nil else { return }
        finishConnected(
            kind: "existing-model",
            handoff: .dashboard)
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
        finishActivationWizard(.failure(CancellationError()))
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
        self.detectedPrepareOptions = nil
        self.prepareAvailable = false
        self.candidatePresentation = [:]
        self.clearProviderAuth()
        self.providerAuthReconciliationPending = false
        self.providerCatalogLoaded = false
        self.providerCatalogError = nil
        self.statuses = [:]
        self.selectedKind = nil
        self.detectError = nil
        self.pendingActivationVerification = false
        self.waitingForPendingActivationDeadline = false
        self.configuredGatewayBlocker = nil
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

    private func scheduleDetection(
        preparedChoiceID: String? = nil,
        preparedProviderLabel: String? = nil)
    {
        guard let context = captureAttemptContext() else {
            self.failDetectionForMissingRoute()
            return
        }
        Task {
            await self.detectAndAutoConnect(
                context: context,
                preparedChoiceID: preparedChoiceID,
                preparedProviderLabel: preparedProviderLabel)
        }
    }

    private func detectAndAutoConnect(
        context: AttemptContext,
        preparedChoiceID: String? = nil,
        preparedProviderLabel: String? = nil) async
    {
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
                timeoutMs: Double(Self.setupDetectionRequestTimeoutMs),
                ifCurrentServerLease: lease)
            guard await self.gateway.isCurrentServerLease(lease),
                  self.isCurrentAttempt(context),
                  !Task.isCancelled
            else { return }
            let result = try JSONDecoder().decode(DetectResult.self, from: data)
            let prepareAvailable = await self.gateway.supportsServerMethod(
                "openclaw.setup.prepare.start",
                ifCurrentServerLease: lease) == true
            guard await self.gateway.isCurrentServerLease(lease),
                  self.isCurrentAttempt(context),
                  !Task.isCancelled
            else { return }
            self.serverLease = lease
            self.prepareAvailable = prepareAvailable
            self.lastDetectedActivationState = result.persistedActivationState
            let manualProviders = result.manualProviders ?? []
            let authOptions = result.authOptions ?? []
            self.authOptions = authOptions
            self.recommendedInstalls = result.recommendedInstalls ?? []
            self.detectedPrepareOptions = result.prepareOptions
            self.candidatePresentation = Dictionary(
                result.candidates.map { candidate in
                    (
                        candidate.kind,
                        CandidatePresentation(
                            brandId: candidate.brandId,
                            icon: candidate.icon,
                            website: candidate.website))
                },
                uniquingKeysWith: { current, _ in current })
            let providerAuthReconciliationPending = self.providerAuthReconciliationPending
            self.providerAuthReconciliationPending = false
            if Self.canAcceptProviderAuthReconciliation(
                pending: providerAuthReconciliationPending,
                setupComplete: result.setupComplete == true,
                configuredModel: result.configuredModel)
            {
                finishConnected(kind: "provider-auth")
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
            if let preparedChoiceID {
                // Detection kinds encode the provider-auth choice ID, while
                // PrepareOption.brandId owns the model-ref namespace.
                let preparedKind = Self.providerAutoSetupKind(choiceID: preparedChoiceID)
                if let prepared = candidates.first(where: {
                    $0.kind == preparedKind && $0.credentials != false
                }) {
                    await self.activate(kind: prepared.kind, context: context)
                } else {
                    let label = preparedProviderLabel ?? preparedChoiceID
                    self.detectError = Self.failure(
                        label: label,
                        status: "unavailable",
                        error: "\(label) did not expose a usable local model. Review setup, then retry.")
                    self.showManualEntry = !self.manualProviders.isEmpty
                }
                return
            }
            if let first = autoCandidateAfter(kind: nil) {
                await self.activate(kind: first.kind, context: context)
            } else {
                self.showManualEntry = !self.manualProviders.isEmpty
            }
        } catch {
            guard self.isCurrentAttempt(context) else { return }
            if self.connectionModeProvider() == .remote, let authIssue = RemoteGatewayAuthIssue(error: error) {
                self.enterGatewayAuthBlocker(authIssue)
                return
            }
            self.phase = .ready
            self.detectError = Self.transportFailure(error.localizedDescription)
            self.showManualEntry = self.candidates.isEmpty
        }
    }

    private func captureAttemptContext(
        supersededAttemptDeadline: Date? = nil) -> AttemptContext?
    {
        let identity = self.routeIdentityProvider()?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let identity, !identity.isEmpty else { return nil }
        return AttemptContext(
            token: self.attemptToken,
            routeIdentity: identity,
            supersededAttemptDeadline: supersededAttemptDeadline)
    }

    private func beginAttemptContext(
        supersededAttemptDeadline: Date? = nil) -> AttemptContext?
    {
        self.attemptToken = UUID()
        return self.captureAttemptContext(supersededAttemptDeadline: supersededAttemptDeadline)
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

    func userSelect(kind: String) {
        guard self.canSelectCandidate(kind: kind) else { return }
        var supersededKind: String?
        var supersededAttemptDeadline: Date?
        if self.phase == .testing, let selectedKind {
            // A user pick supersedes auto-testing; the attempt token rejects every late result.
            supersededKind = selectedKind
            let routeIdentity = self.routeIdentityProvider()
            supersededAttemptDeadline = routeIdentity.flatMap {
                self.activePendingActivationDeadline(for: $0)
            }
                ?? Date().addingTimeInterval(
                    Self.activationRequestTimeoutMs(for: selectedKind) / 1000 + 5)
        }
        guard let context = beginAttemptContext(
            supersededAttemptDeadline: supersededAttemptDeadline)
        else { return }
        // A fresh user-picked attempt owns the verdict; keeping the stale
        // "none of the found options worked" card up during its test would
        // contradict the visible Testing state.
        self.exhaustedAutoCandidates = false
        if let supersededKind {
            self.statuses[supersededKind] = .untried
            self.selectedKind = kind
            self.statuses[kind] = .testing
        }
        Task {
            await self.activate(kind: kind, context: context)
        }
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
        guard let candidate = candidates.first(where: { $0.kind == kind })
        else {
            requireFreshDetection(after: Self.transportFailure(
                "The Gateway connection changed. Check for AI accounts again."))
            return
        }
        await self.activate(
            .candidate(kind: kind, modelRef: candidate.modelRef, label: candidate.label, tryNextOnFailure: true),
            context: context)
    }

    private func activate(
        _ request: ActivationRequest,
        context: AttemptContext) async
    {
        defer {
            if request.isManual, self.isCurrentAttempt(context) { self.manualTesting = false }
        }
        let kind = request.kind
        guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
        guard let lease = serverLease,
              await gateway.isCurrentServerLease(lease)
        else {
            requireFreshDetection(after: Self.transportFailure(
                "The Gateway connection changed. Check for AI accounts again."))
            return
        }
        guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
        let persistedStateBeforeActivation = self.lastDetectedActivationState
        let requestTimeoutMs = await Self.activationRequestTimeoutMs(
            for: kind,
            gateway: self.gateway,
            serverLease: lease)
        var supportsExactModel = false
        if !request.isManual {
            self.selectedKind = kind
            self.phase = .testing
            self.statuses[kind] = .testing
            guard let supported = await gateway.supportsServerCapability(
                .systemAgentSetupModelRef,
                ifCurrentServerLease: lease),
                isCurrentAttempt(context), !Task.isCancelled
            else {
                requireFreshDetection(after: Self.transportFailure(
                    "The Gateway connection changed. Check for AI accounts again."))
                return
            }
            supportsExactModel = supported
        }
        let routeFingerprint = await gateway.activationOwnershipFingerprint(
            ifCurrentServerLease: lease)
        guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
        let params = request.params(supportsExactModel: supportsExactModel)
        // Keychain-unavailable degrades to an unbound per-attempt lease instead
        // of refusing setup: live matching stays attempt-exact, and relaunch
        // repeats activation rather than trusting the receipt, so a broken
        // login keychain cannot dead-end onboarding.
        let activationOwner = routeFingerprint.map { fingerprint in
            OnboardingSystemAgentResumeStore.ActivationOwner(
                id: UUID().uuidString,
                routeFingerprint: fingerprint)
        } ?? .unbound()
        self.pendingActivationOwner = activationOwner
        self.pendingActivationRequiresFreshActivation = true
        let supersededWaitMs = max(
            0,
            (context.supersededAttemptDeadline?.timeIntervalSinceNow ?? 0) * 1000)
        // Activation can persist before the response reaches the app. Cover the
        // whole ambiguous window so relaunch can inspect the actual Gateway state.
        guard let activationDeadline = OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: context.routeIdentity,
            activationOwner: activationOwner,
            activationTimeoutMs: requestTimeoutMs + supersededWaitMs,
            defaults: defaults)
        else {
            let failure = Self.transportFailure(
                "No Gateway is selected. Select a Gateway, then try again.")
            self.exposeActivationFailure(failure, for: request)
            self.phase = .ready
            return
        }
        guard !Task.isCancelled else {
            self.clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
            self.phase = .ready
            return
        }
        do {
            let result = try await requestActivation(
                params: params,
                timeoutMs: requestTimeoutMs,
                serverLease: lease,
                context: context)
            guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
            if result.ok {
                if let failure = await finishSuccessfulActivation(
                    request: request,
                    result: result,
                    context: context,
                    activationOwner: activationOwner,
                    before: persistedStateBeforeActivation,
                    originalServerLease: lease)
                {
                    self.exposeActivationFailure(failure, for: request)
                }
            } else {
                guard await self.gateway.isCurrentServerLease(lease) else {
                    self.pendingActivationVerification = false
                    self.clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
                    requireFreshDetection(after: Self.transportFailure(
                        "The Gateway connection changed while AI setup was finishing. Check again."))
                    return
                }
                self.pendingActivationVerification = false
                self.clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
                let failure = Self.failure(
                    label: request.label,
                    status: result.status,
                    error: result.error)
                self.exposeActivationFailure(failure, for: request)
                if request.tryNextOnFailure {
                    await tryNextAfterFailure(of: kind, context: context)
                } else if !request.isManual {
                    self.phase = .ready
                    self.showManualEntry = !self.manualProviders.isEmpty
                }
            }
        } catch {
            guard self.isCurrentAttempt(context) else { return }
            // Cancellation, decoding, and transport failures after dispatch are
            // ambiguous. Keep the marker; model-label detection is not proof that
            // this activation and its credential mutation completed safely.
            let failure = Self.transportFailure(error.localizedDescription)
            self.exposeActivationFailure(failure, for: request)
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
                // Unbound (keychain-unavailable) leases cannot prove ownership;
                // reconciliation's fingerprint guard rejects them and setup
                // falls through to the deadline probe instead.
                if let modelRef = request.modelRef, !Task.isCancelled,
                   await !(self.gateway.isCurrentServerLease(lease)),
                   await self.reconcileActivationAfterGatewayRestart(
                       kind: kind,
                       expectedModel: modelRef,
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

    private func requestActivation(
        params: [String: AnyCodable],
        timeoutMs: Double,
        serverLease: GatewayConnection.ServerLease,
        context: AttemptContext) async throws -> ActivateResult
    {
        var retryDelayMs: UInt64 = 250
        while true {
            guard self.isCurrentAttempt(context), !Task.isCancelled else {
                throw CancellationError()
            }
            do {
                let supportsActivationWizard = await self.gateway.supportsServerMethod(
                    "openclaw.setup.activate.start",
                    ifCurrentServerLease: serverLease) == true
                guard self.isCurrentAttempt(context), !Task.isCancelled else {
                    throw CancellationError()
                }
                if supportsActivationWizard {
                    return try await self.requestActivationWizard(params: params, serverLease: serverLease)
                }
                let data = try await gateway.request(
                    method: "openclaw.setup.activate",
                    params: params,
                    timeoutMs: timeoutMs,
                    ifCurrentServerLease: serverLease)
                return try JSONDecoder().decode(ActivateResult.self, from: data)
            } catch {
                guard let supersededAttemptDeadline = context.supersededAttemptDeadline,
                      Date() < supersededAttemptDeadline,
                      Self.setupAdmissionIsBusy(error)
                else { throw error }
                try await Task.sleep(nanoseconds: retryDelayMs * 1_000_000)
                retryDelayMs = min(retryDelayMs * 2, 5000)
            }
        }
    }

    private func requestActivationWizard(
        params: [String: AnyCodable],
        serverLease: GatewayConnection.ServerLease) async throws -> ActivateResult
    {
        guard self.activationWizardCompletion == nil else {
            throw OnboardingAISetupError.activationOutcomeUnavailable
        }
        return try await withCheckedThrowingContinuation { continuation in
            self.activationWizardCompletion = continuation
            self.startSetupWizard(.activation, kind: .activation, params: params, serverLease: serverLease)
        }
    }

    private func finishActivationWizard(_ result: Result<ActivateResult, Error>) {
        let continuation = self.activationWizardCompletion
        self.activationWizardCompletion = nil
        continuation?.resume(with: result)
    }

    private func exposeActivationFailure(_ failure: Failure, for request: ActivationRequest) {
        if request.isManual {
            self.manualError = failure
        } else {
            self.statuses[request.kind] = .failed(failure)
            if !request.tryNextOnFailure { self.detectError = failure }
        }
    }

    private func reconcileActivationAfterGatewayRestart(
        kind: String,
        expectedModel: String,
        context: AttemptContext,
        activationOwner: OnboardingSystemAgentResumeStore.ActivationOwner,
        before: PersistedActivationState?,
        originalServerLease: GatewayConnection.ServerLease) async -> Bool
    {
        let deadline = ReconciliationDeadline(timeout: .seconds(45))
        var delayMs = 250
        while deadline.hasTimeRemaining {
            guard self.isCurrentAttempt(context), !Task.isCancelled else { return false }
            let leaseTimeoutMs = deadline.remainingMilliseconds(cappedAt: 3000)
            guard leaseTimeoutMs > 0 else { return false }
            // A successful activation reply can precede its deferred restart.
            // Never verify or hand off on the physical socket that scheduled it.
            if await !(self.gateway.isCurrentServerLease(originalServerLease)),
               let replacementLease = try? await self.gateway.acquireServerLease(
                   ifSameRouteAs: originalServerLease,
                   timeoutMs: Double(leaseTimeoutMs)),
               await self.reconcilePersistedActivation(
                   kind: kind,
                   expectedModel: expectedModel,
                   context: context,
                   activationOwner: activationOwner,
                   before: before,
                   serverLease: replacementLease,
                   deadline: deadline)
            {
                self.serverLease = replacementLease
                return true
            }
            let sleepMs = deadline.remainingMilliseconds(cappedAt: delayMs)
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

    private func finishSuccessfulActivation(
        request: ActivationRequest,
        result: ActivateResult,
        context: AttemptContext,
        activationOwner: OnboardingSystemAgentResumeStore.ActivationOwner,
        before: PersistedActivationState?,
        originalServerLease: GatewayConnection.ServerLease) async -> Failure?
    {
        if request.isManual { self.manualKey = "" }
        let kind = request.kind
        let expectedModel = request.modelRef ?? result.modelRef ?? ""
        let originalLeaseWasReplaced = await !(self.gateway.isCurrentServerLease(originalServerLease))
        let restartRequired = result.gatewayRestartRequired == true || originalLeaseWasReplaced
        guard self.isCurrentAttempt(context), !Task.isCancelled else { return nil }
        guard restartRequired else {
            self.finishConnected(kind: kind, activationOwner: activationOwner)
            return nil
        }
        self.pendingActivationVerification = true
        self.phase = .detecting
        if await self.reconcileActivationAfterGatewayRestart(
            kind: kind,
            expectedModel: expectedModel,
            context: context,
            activationOwner: activationOwner,
            before: before,
            originalServerLease: originalServerLease)
        {
            return nil
        }
        guard self.isCurrentAttempt(context), !Task.isCancelled else { return nil }
        self.phase = .ready
        return Self.transportFailure(
            "The Gateway did not finish restarting after AI setup. Try again once it is available.")
    }

    private func reconcilePersistedActivation(
        kind: String,
        expectedModel: String,
        context: AttemptContext,
        activationOwner: OnboardingSystemAgentResumeStore.ActivationOwner,
        before: PersistedActivationState?,
        serverLease: GatewayConnection.ServerLease,
        deadline: ReconciliationDeadline) async -> Bool
    {
        let detectTimeoutMs = deadline.remainingMilliseconds(
            cappedAt: Self.setupDetectionRequestTimeoutMs)
        guard detectTimeoutMs > 0,
              self.isCurrentAttempt(context),
              !Task.isCancelled,
              OnboardingSystemAgentResumeStore.isOwned(
                  by: activationOwner,
                  for: context.routeIdentity,
                  defaults: self.defaults),
              await self.gateway.activationOwnershipFingerprint(ifCurrentServerLease: serverLease) ==
              activationOwner.routeFingerprint
        else { return false }
        guard let detectData = try? await gateway.request(
            method: "openclaw.setup.detect",
            params: [:],
            timeoutMs: Double(detectTimeoutMs),
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
        let verifyTimeoutMs = deadline.remainingMilliseconds(
            cappedAt: Self.setupDetectionRequestTimeoutMs)
        guard verifyTimeoutMs > 0 else { return false }
        guard let verifyData = try? await gateway.request(
            method: "openclaw.setup.verify",
            params: [:],
            timeoutMs: Double(verifyTimeoutMs),
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
            activationOwner: activationOwner)
        return self.connected
    }
}

extension OnboardingAISetupModel {
    func startProviderWizard(_ option: AuthOption, kind: ProviderWizardKind) {
        guard !isBusy, self.activeAuthOption == nil, let serverLease else { return }
        self.startSetupWizard(
            option,
            kind: kind,
            params: ["authChoice": AnyCodable(option.id)],
            serverLease: serverLease)
    }

    private func startSetupWizard(
        _ option: AuthOption,
        kind: ProviderWizardKind,
        params: [String: AnyCodable],
        serverLease: GatewayConnection.ServerLease)
    {
        self.clearProviderAuth()
        self.activeAuthOption = option
        self.providerWizardKind = kind
        self.authBusy = true
        self.providerAuthReconciliationPending = false
        let token = self.attemptToken
        let authAttemptID = self.authAttemptID
        let authSessionID = UUID().uuidString
        self.authSessionID = authSessionID
        let requestID = UUID()
        self.authRequestID = requestID
        Task {
            defer {
                if self.authRequestID == requestID { self.authRequestID = nil }
            }
            do {
                let data = try await self.gateway.request(
                    method: kind.startMethod,
                    params: params.merging(["sessionId": AnyCodable(authSessionID)]) { _, sessionId in sessionId },
                    timeoutMs: 600_000,
                    ifCurrentServerLease: serverLease)
                let result = try JSONDecoder().decode(WizardStartResult.self, from: data)
                guard token == self.attemptToken, authAttemptID == self.authAttemptID else {
                    // A route reset can race the start response. Cancel the
                    // decoded server session so the discarded flow cannot commit.
                    await self.gateway.cancelWizardSession(result.sessionid, on: serverLease)
                    return
                }
                if self.providerAuthCancellationRequested {
                    // Cancel can race admission before the Gateway registers the requested id.
                    // Redeem the late response only to release its exact admitted session.
                    self.authSessionID = result.sessionid
                    self.cancelProviderAuth()
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
                    error: result.error,
                    preparedModelRef: result.preparedmodelref,
                    modelActivation: result.modelactivation)
            } catch {
                if self.activationWizardCompletion != nil, Self.setupAdmissionIsBusy(error),
                   token == self.attemptToken, authAttemptID == self.authAttemptID
                {
                    self.finishActivationWizard(.failure(error))
                    self.clearProviderAuth()
                    return
                }
                if Self.setupAdmissionIsBusy(error) {
                    guard token == self.attemptToken, authAttemptID == self.authAttemptID else { return }
                    // No session was admitted; cancelling or reconciling could adopt another operation.
                    self.applyAuthWizardResult(
                        done: true,
                        step: nil,
                        status: "error",
                        error: error.localizedDescription,
                        preparedModelRef: nil)
                    return
                }
                // The Gateway session survives socket loss; cancel by its known
                // id before reporting failure so it cannot persist config later.
                let cancellation = await self.gateway.cancelWizardSession(
                    authSessionID,
                    on: serverLease)
                guard token == self.attemptToken, authAttemptID == self.authAttemptID else { return }
                if self.activationWizardCompletion != nil {
                    let failure = cancellation == .cancelled ? OnboardingAISetupError.activationCancelled : error
                    self.finishActivationWizard(.failure(failure))
                    self.clearProviderAuth()
                    return
                }
                if cancellation != .cancelled,
                   await self.reconcileProviderAuthAfterUnknownOutcome(
                       token: token,
                       authAttemptID: authAttemptID,
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

    func cancelProviderAuth() {
        let sessionID = self.authSessionID
        let authServerLease = self.serverLease
        guard let sessionID, let authServerLease else {
            self.providerAuthReconciliationPending = false
            self.clearProviderAuth()
            return
        }
        let keepPresented = self.activationWizardCompletion != nil
        let context = (token: self.attemptToken, state: self.lastDetectedActivationState, authID: self.authAttemptID)
        self.providerAuthCancellationRequested = true
        if keepPresented { self.authBusy = true } else { self.dismissProviderAuth() }
        Task {
            let cancellation = await self.gateway.cancelWizardSession(
                sessionID,
                on: authServerLease)
            // Closing the sheet wins locally. Gateway admission keeps replacement
            // setup fenced until this exact runner has authoritatively settled.
            guard context.token == self.attemptToken, context.authID == self.authAttemptID else { return }
            if self.activationWizardCompletion != nil, cancellation != .unresolved {
                if cancellation == .absent, self.authRequestID != nil {
                    // A terminal reply can outlive its purged server session. Only
                    // its tracked request, never the Cancel button's busy state, owns that result.
                    return
                }
                self.finishActivationWizard(.failure(cancellation == .cancelled
                        ? OnboardingAISetupError.activationCancelled
                        : OnboardingAISetupError.activationOutcomeUnavailable))
                self.clearProviderAuth()
                return
            }
            if cancellation == .absent,
               await self.reconcileProviderAuthAfterUnknownOutcome(
                   token: context.token,
                   authAttemptID: context.authID,
                   before: context.state,
                   originalServerLease: authServerLease)
            {
                return
            }
            guard context.authID == self.authAttemptID else { return }
            if cancellation == .unresolved, keepPresented {
                // Activation review keeps its existing retry path; provider sign-in
                // has already dismissed its sheet and relies on Gateway settlement.
                if self.authRequestID == nil, self.authStep == nil {
                    self.advanceProviderAuth(stepID: nil, value: nil)
                }
                self.authError = Self.providerAuthCancellationUnconfirmed()
                return
            }
            if cancellation != .unresolved { self.clearProviderAuth() }
        }
    }

    func advanceProviderAuth(stepID: String?, value: AnyCodable?) {
        guard let sessionID = authSessionID,
              let serverLease,
              let option = activeAuthOption,
              let kind = providerWizardKind
        else { return }
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
        let requestID = UUID()
        self.authRequestID = requestID
        Task {
            var requestLease = serverLease
            defer {
                if self.authRequestID == requestID { self.authRequestID = nil }
            }
            do {
                let data: Data
                do {
                    data = try await self.gateway.request(
                        method: "wizard.next",
                        params: params,
                        timeoutMs: Self.providerAuthRequestTimeoutMs,
                        ifCurrentServerLease: requestLease)
                } catch OpenClawChatTransportSendError.notDispatched {
                    guard token == self.attemptToken, authAttemptID == self.authAttemptID else { return }
                    // Only this error proves the callback never reached the Gateway.
                    // Keep the wizard identity and retry once on the same route.
                    let replacementLease = try await self.gateway.acquireServerLease(
                        ifSameRouteAs: requestLease,
                        timeoutMs: 5000)
                    guard token == self.attemptToken, authAttemptID == self.authAttemptID else { return }
                    requestLease = replacementLease
                    self.serverLease = requestLease
                    data = try await self.gateway.request(
                        method: "wizard.next",
                        params: params,
                        timeoutMs: Self.providerAuthRequestTimeoutMs,
                        ifCurrentServerLease: requestLease)
                }
                guard token == self.attemptToken, authAttemptID == self.authAttemptID else { return }
                let result = try JSONDecoder().decode(WizardNextResult.self, from: data)
                self.applyAuthWizardResult(
                    done: result.done,
                    step: result.step,
                    status: wizardStatusString(result.status),
                    error: result.error,
                    preparedModelRef: result.preparedmodelref,
                    modelActivation: result.modelactivation,
                    context: (option, kind))
            } catch {
                let cancellation = await self.gateway.cancelWizardSession(sessionID, on: requestLease)
                guard token == self.attemptToken, authAttemptID == self.authAttemptID else { return }
                if self.activationWizardCompletion != nil {
                    let failure = cancellation == .cancelled ? OnboardingAISetupError.activationCancelled : error
                    self.finishActivationWizard(.failure(failure))
                    self.clearProviderAuth()
                    return
                }
                if cancellation != .cancelled,
                   await self.reconcileProviderAuthAfterUnknownOutcome(
                       token: token,
                       authAttemptID: authAttemptID,
                       before: self.lastDetectedActivationState,
                       originalServerLease: requestLease)
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
        error: String?,
        preparedModelRef: String?,
        modelActivation: [String: AnyCodable]? = nil,
        context: (option: AuthOption, kind: ProviderWizardKind)? = nil)
    {
        guard let option = context?.option ?? self.activeAuthOption,
              let kind = context?.kind ?? self.providerWizardKind else { return }
        self.authBusy = false
        if self.activationWizardCompletion != nil,
           done || status == "done" || status == "cancelled" || status == "error"
        {
            let result = Self.activationWizardResult(status: status, error: error, modelActivation: modelActivation)
            self.finishActivationWizard(result)
            self.clearProviderAuth()
            return
        }
        let validationError = !done && status == "running" && error?.isEmpty == false
        let preserveEnteredValue = validationError && self.authStep?.id == step?.id
        if status == "error" || (done && error != nil) {
            // Terminal sessions are removed by the Gateway. Drop the local id
            // so Cancel dismisses the preserved, copyable error immediately.
            self.authSessionID = nil
            self.authStep = nil
            self.authError = Self.failure(
                label: option.label,
                status: "unavailable",
                error: error)
            return
        }
        if status == "cancelled" {
            self.clearProviderAuth()
            return
        }
        if done || status == "done" {
            let preparedProvider = kind == .prepare
                ? (id: option.id, label: option.label)
                : nil
            let preparedModel = preparedModelRef?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            self.providerAuthReconciliationPending = kind == .auth
            self.clearProviderAuth()
            if let preparedProvider,
               let preparedModel,
               !preparedModel.isEmpty
            {
                guard let context = self.captureAttemptContext() else {
                    self.failDetectionForMissingRoute()
                    return
                }
                let kind = Self.providerAutoSetupKind(choiceID: preparedProvider.id)
                self.statuses[kind] = .untried
                Task {
                    await self.activate(
                        .candidate(
                            kind: kind,
                            modelRef: preparedModel,
                            label: preparedProvider.label,
                            tryNextOnFailure: false),
                        context: context)
                }
                return
            }
            self.scheduleDetection(
                preparedChoiceID: preparedProvider?.id,
                preparedProviderLabel: preparedProvider?.label)
            return
        }
        self.authStep = step
        if validationError {
            self.authError = Self.failure(
                label: option.label,
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
        // Gateway-executed steps render progress and expose no input control, so
        // no user action would ever ask for the next frame. Keep polling; the
        // session long-polls until the next update or the terminal result, so a
        // download reports live instead of freezing on its first frame.
        if let step, wizardStepExecutor(step) == "gateway" {
            self.advanceProviderAuth(stepID: nil, value: nil)
        }
    }

    private func reconcileProviderAuthAfterUnknownOutcome(
        token: UUID,
        authAttemptID: UUID,
        before: PersistedActivationState?,
        originalServerLease: GatewayConnection.ServerLease) async -> Bool
    {
        guard authAttemptID == self.authAttemptID, let before else { return false }
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
            timeoutMs: Double(Self.setupDetectionRequestTimeoutMs),
            ifCurrentServerLease: lease),
            token == attemptToken,
            authAttemptID == self.authAttemptID,
            let result = try? JSONDecoder().decode(DetectResult.self, from: data),
            let configuredModel = result.configuredModel,
            Self.activationTransitionWasPersisted(
                expectedModel: configuredModel,
                before: before,
                after: result.persistedActivationState)
        else { return false }
        self.serverLease = lease
        self.clearProviderAuth()
        finishConnected(kind: "provider-auth")
        return true
    }

    private func clearProviderAuth() {
        // Closing a wizard retires every reply captured by its generation.
        self.authAttemptID = UUID()
        self.authRequestID = nil
        self.providerAuthCancellationRequested = false
        self.dismissProviderAuth()
    }

    private func dismissProviderAuth() {
        self.activeAuthOption = nil
        self.providerWizardKind = nil
        self.authSessionID = nil
        self.authStep = nil
        self.authError = nil
        self.authBusy = false
        self.authText = ""
    }

    #if DEBUG
    func _test_setProviderAuth(option: AuthOption, sessionID: String) {
        self.activeAuthOption = option
        self.providerWizardKind = .auth
        self.authSessionID = sessionID
        self.authBusy = true
    }

    func _test_applyAuthWizardResult(
        done: Bool,
        status: String?,
        error: String?,
        preparedModelRef: String? = nil)
    {
        self.applyAuthWizardResult(
            done: done,
            step: nil,
            status: status,
            error: error,
            preparedModelRef: preparedModelRef)
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
        Task { await self.activate(.manual(key: key, provider: provider), context: context) }
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
        activationOwner: OnboardingSystemAgentResumeStore.ActivationOwner? = nil,
        handoff: OnboardingDashboardHandoff = .custodianOnboarding)
    {
        let routeIdentity = self.routeIdentityProvider()?.trimmingCharacters(in: .whitespacesAndNewlines)
        let completedReceipt = OnboardingSystemAgentResumeStore.markCompleted(
            ifOwnedBy: routeIdentity,
            activationOwner: activationOwner,
            defaults: self.defaults)
        if activationOwner != nil {
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
        self.selectedKind = kind
        // Verification labels and completion receipts do not encode setup intent.
        // Keep the destination in the completion itself, including after receipt cleanup.
        self.phase = .connected(handoff)
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
}
