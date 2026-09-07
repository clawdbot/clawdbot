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
        didSet { OnboardingController.shared.busyReason = self.busyReason }
    }

    private(set) var candidates: [Candidate] = []
    private(set) var unavailableCandidates: [UnavailableCandidate] = []
    private(set) var manualProviders: [ManualProvider] = []
    private(set) var authOptions: [AuthOption] = []
    private(set) var recommendedInstalls: [RecommendedInstall] = []
    private(set) var nativeSessionCatalogs: [NativeSessionCatalog] = []
    var nativeSessionCatalogsEnabled = false
    private(set) var nativeSessionCatalogPreferenceRequired = false
    private(set) var detectedPrepareOptions: [PrepareOption]?
    private(set) var prepareAvailable = false
    private(set) var candidatePresentation: [String: CandidatePresentation] = [:]
    private(set) var activeAuthOption: AuthOption?
    private(set) var providerWizardKind: ProviderWizardKind?
    private(set) var authStep: WizardStep?
    private(set) var authError: Failure?
    private(set) var providerAuthCancellation: ProviderAuthCancellation?
    private(set) var authBusy = false {
        didSet { OnboardingController.shared.busyReason = self.busyReason }
    }

    var authText = ""
    var authSelection = 0
    var authConfirmation = false
    private(set) var providerCatalogLoaded = false
    private(set) var providerCatalogError: String?
    private(set) var statuses: [String: CandidateStatus] = [:]
    private(set) var selectedKind: String?
    private(set) var detectError: Failure?
    private(set) var pendingActivationVerification = false
    private(set) var waitingForPendingActivationDeadline = false
    private(set) var configuredGatewayBlocker: ConfiguredGatewayBlocker?

    var manualProviderID = ""
    var manualKey: String = ""
    private(set) var manualTesting = false {
        didSet { OnboardingController.shared.busyReason = self.busyReason }
    }

    private(set) var manualError: Failure?
    var showManualEntry = false

    /// Called when a candidate connects so the page can advance.
    var onConnected: (() -> Void)?
    /// Mutating attempts request a route-bound wakeup for uncertain results.
    /// Read-only verification leaves automatic recovery to its caller.
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

    var automaticSetupIntent: SetupIntent {
        self.started || self.waitingForPendingActivationDeadline ? .resumePending : .startSetup
    }

    func startIfNeeded() {
        guard self.automaticSetupIntent == .startSetup || self.configuredGatewayBlocker != nil else { return }
        self.resumeSetup(intent: self.automaticSetupIntent)
    }

    func retryFromScratch() {
        // The configured-Gateway preflight has its own read-only retry. Never
        // turn an unavailable agents.list response into setup mutation.
        guard self.configuredGatewayBlocker == nil else { return }
        guard !self.waitingForPendingActivationDeadline else { return }
        if self.pendingActivationVerification {
            self.detectError = nil
            self.phase = .detecting
            guard let context = self.captureAttemptContext() else { return }
            Task {
                let outcome = await self.verifyPendingConfiguredInference()
                guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
                if case let .freshSetupAllowed(context) = outcome {
                    self.resumeSetup(ifCurrent: context)
                } else if self.waitingForPendingActivationDeadline,
                          let deadline = self.activePendingActivationDeadline(for: context.routeIdentity)
                {
                    self.onPendingActivationDeadline?(deadline, context.routeIdentity)
                }
            }
            return
        }
        self.resetForGatewayChange()
        scheduleDetection()
    }

    func waitForPendingActivationDeadline() {
        guard !self.connected,
              self.phase != .testing,
              !self.manualTesting,
              !self.pendingActivationVerification,
              let routeIdentity = routeIdentityProvider(),
              activePendingActivationDeadline(for: routeIdentity) != nil
        else { return }
        if !self.waitingForPendingActivationDeadline {
            self.resetForGatewayChange(clearPendingHandoff: false)
        }
        self.beginPendingActivationDeadlineWait()
    }

    func enterConfiguredGatewayBlocker(_ blocker: ConfiguredGatewayBlocker, failure: Failure? = nil) {
        // Retire stale route work without turning a prior attempt back into first
        // setup. Only an initial blocked probe remains eligible for automatic testing.
        let started = self.started
        self.resetForGatewayChange(clearPendingHandoff: false)
        self.started = started
        self.configuredGatewayBlocker = blocker
        self.phase = .ready
        self.detectError = failure
    }

    func beginConfiguredGatewayProbeRetry() {
        guard self.configuredGatewayBlocker != nil else { return }
        self.phase = .detecting
        self.detectError = nil
    }

    /// Restore only the pending handoff state. A configured model label is not
    /// proof that the ambiguous activation completed or that inference works.
    func resumeConfiguredInference(modelRef: String) {
        let model = modelRef.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !model.isEmpty else { return }
        // Reconnects and page changes can discover the same pending handoff
        // repeatedly. Keep the first attempt and let every caller await it.
        guard self.waitingForPendingActivationDeadline || !self.ownsInferenceTransition else { return }
        let routeIdentity = self.routeIdentityProvider()
        let pendingState = OnboardingSystemAgentResumeStore.pendingState(
            for: routeIdentity,
            defaults: self.defaults)
        let inMemoryOwner = self.waitingForPendingActivationDeadline ? nil : self.pendingActivationOwner
        let activationOwner = inMemoryOwner ?? OnboardingSystemAgentResumeStore.activationOwner(
            for: routeIdentity,
            defaults: self.defaults)
        // A completed receipt may resume only after live inference and an exact
        // owner check. Other relaunched states must repeat activation because a
        // model label alone does not prove which attempt committed it.
        let requiresFreshActivation = inMemoryOwner != nil || pendingState != .none
        let failure = self.detectError
        self.resetForGatewayChange(clearPendingHandoff: false)
        self.detectError = failure
        // resetForGatewayChange retires the async attempt but the route-owned
        // durable receipt above must survive into this reconciliation attempt.
        self.pendingActivationOwner = activationOwner
        self.pendingActivationRequiresFreshActivation = requiresFreshActivation
        self.started = true
        self.pendingActivationVerification = true
        self.phase = .detecting
    }

    /// Reconcile an ambiguous activation on the same Gateway route. A live turn
    /// is necessary, but only a matching durable completion receipt may hand off.
    /// Otherwise the caller decides whether to repeat activation on this exact attempt.
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
        if case .freshSetupAllowed = outcome {
            self.waitingForPendingActivationDeadline = false
            self.phase = .ready
            if self.detectError == nil {
                self.detectError = Failure(
                    summary: "The previous AI setup result could not be confirmed. Choose a connection to test again.",
                    detail: nil)
            }
        }
        return outcome
    }

    func resumeSetup(ifCurrent context: AttemptContext? = nil, intent: SetupIntent = .resumePending) {
        guard let context = context ?? self.captureAttemptContext(),
              self.isCurrentAttempt(context), !Task.isCancelled else { return }
        if OnboardingSystemAgentResumeStore.pendingState(for: context.routeIdentity, defaults: self.defaults) != .none {
            // A new receipt can arrive after verification returned. Its owner
            // must be reconciled before this caller may start another activation.
            let deadline = self.activePendingActivationDeadline(for: context.routeIdentity) ?? Date()
            self.beginPendingActivationDeadlineWait()
            self.onPendingActivationDeadline?(deadline, context.routeIdentity)
            return
        }
        let failure = self.detectError
        self.resetForGatewayChange(clearPendingHandoff: false)
        self.detectError = failure
        self.scheduleDetection(intent: intent)
    }

    private func performPendingConfiguredInferenceVerification(
        context: AttemptContext) async -> PendingVerificationOutcome
    {
        guard self.pendingActivationVerification, isCurrentAttempt(context), !Task.isCancelled else {
            return .superseded
        }
        self.phase = .detecting
        let lease: GatewayConnection.ServerLease
        do {
            lease = try await self.gateway.acquireServerLease()
        } catch {
            guard isCurrentAttempt(context), !Task.isCancelled else { return .superseded }
            self.detectError = Self.transportFailure(
                "The selected Gateway changed before inference could be verified. Try again.")
            return self.pendingVerificationFailureOutcome(context: context)
        }
        guard await self.gateway.isCurrentServerLease(lease),
              isCurrentAttempt(context), !Task.isCancelled
        else { return .superseded }
        if let activationOwner = pendingActivationOwner {
            let currentFingerprint = await gateway.activationOwnershipFingerprint(ifCurrentServerLease: lease)
            guard isCurrentAttempt(context), !Task.isCancelled else { return .superseded }
            guard activationOwner.isUnbound || currentFingerprint != nil else {
                self.phase = .ready
                self.detectError = Self.transportFailure(
                    "Secure storage is unavailable, so OpenClaw cannot verify which Gateway completed AI setup.")
                return .notConnected
            }
            if activationOwner.isUnbound || activationOwner.routeFingerprint != currentFingerprint {
                // Missing or replaced bindings cannot authorize a handoff, but
                // their active attempts still own the full mutation lease.
                self.pendingActivationVerification = false
                if self.activePendingActivationDeadline(for: context.routeIdentity) != nil {
                    self.beginPendingActivationDeadlineWait()
                    return .notConnected
                }
                clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
                self.detectError = activationOwner.isUnbound ? self.detectError : Self.transportFailure(
                    "The Gateway authentication changed while AI setup was finishing. Test it again.")
                return .freshSetupAllowed(context)
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
                case .activating, .verified:
                    // This proves inference works, but not that the dropped
                    // activation stopped mutating. Preserve its deadline.
                    OnboardingSystemAgentResumeStore.markVerified(
                        ifOwnedBy: context.routeIdentity,
                        activationOwner: self.pendingActivationOwner,
                        defaults: self.defaults)
                    self.pendingActivationVerification = false
                    self.detectError = nil
                    self.beginPendingActivationDeadlineWait()
                    return .notConnected
                case .activationExpired, .none:
                    if self.pendingActivationRequiresFreshActivation {
                        self.pendingActivationVerification = false
                        clearPendingHandoff(ifOwnedBy: context)
                        return .freshSetupAllowed(context)
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
                        return .freshSetupAllowed(context)
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
            self.detectError = Self.failure(
                label: "Configured AI",
                status: result.status,
                error: result.error)
            return self.pendingVerificationFailureOutcome(context: context)
        } catch {
            guard isCurrentAttempt(context), !Task.isCancelled else { return .superseded }
            // A failed read-only verification never proves activation failed.
            // Keep the marker and let Try again repeat this same verification.
            self.detectError = Self.transportFailure(error.localizedDescription)
            return self.pendingVerificationFailureOutcome(context: context)
        }
    }

    private func pendingVerificationFailureOutcome(
        context: AttemptContext) -> PendingVerificationOutcome
    {
        self.phase = .ready
        switch OnboardingSystemAgentResumeStore.pendingState(
            for: context.routeIdentity,
            defaults: self.defaults)
        {
        case .activating, .verified:
            // The dropped activation may still be writing config or credentials.
            // Verification may repeat, but mutation stays blocked until its lease ends.
            if let activationOwner = pendingActivationOwner,
               !OnboardingSystemAgentResumeStore.isOwned(
                   by: activationOwner,
                   for: context.routeIdentity,
                   defaults: defaults)
            {
                self.pendingActivationVerification = false
                self.beginPendingActivationDeadlineWait()
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
            return .freshSetupAllowed(context)
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

    private func beginPendingActivationDeadlineWait() {
        self.waitingForPendingActivationDeadline = true
        self.phase = .detecting
    }

    private func retainAmbiguousActivation(
        _ failure: Failure,
        ifOwnedBy context: AttemptContext,
        activationOwner: OnboardingSystemAgentResumeStore.ActivationOwner,
        activationDeadline: Date)
    {
        guard isCurrentAttempt(context) else { return }
        self.detectError = failure
        self.pendingActivationVerification = true
        let recheckDeadline: Date
        switch OnboardingSystemAgentResumeStore.pendingState(
            for: context.routeIdentity,
            defaults: self.defaults)
        {
        case let .activating(deadline), let .verified(deadline):
            // Another process can replace this lease. Our result may neither
            // complete nor clear that owner, but must still wait for its deadline.
            self.pendingActivationVerification = OnboardingSystemAgentResumeStore.isOwned(
                by: activationOwner,
                for: context.routeIdentity,
                defaults: self.defaults)
            recheckDeadline = deadline
        case .none:
            // Restore a marker cleared while the dispatched handler was still
            // returning, then probe immediately without shortening its lease.
            OnboardingSystemAgentResumeStore.restorePending(
                routeIdentity: context.routeIdentity,
                activationOwner: activationOwner,
                deadline: activationDeadline,
                defaults: self.defaults)
            recheckDeadline = Date()
        case .activationExpired, .completed:
            // A dispatched handler may still commit. Probe observed Gateway
            // state before a caller decides whether to activate again.
            recheckDeadline = Date()
        }
        self.beginPendingActivationDeadlineWait()
        self.onPendingActivationDeadline?(recheckDeadline, context.routeIdentity)
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
        self.nativeSessionCatalogs = []
        self.nativeSessionCatalogsEnabled = false
        self.nativeSessionCatalogPreferenceRequired = false
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
    func detectConnections(intent: SetupIntent = .startSetup) async {
        guard let context = captureAttemptContext() else {
            self.failDetectionForMissingRoute()
            return
        }
        await self.detectConnections(context: context, intent: intent)
    }

    private func scheduleDetection(
        intent: SetupIntent = .startSetup,
        preparedChoiceID: String? = nil,
        preparedProviderLabel: String? = nil)
    {
        self.started = true
        self.phase = .detecting
        guard let context = captureAttemptContext() else {
            self.failDetectionForMissingRoute()
            return
        }
        Task {
            await self.detectConnections(
                context: context,
                intent: intent,
                preparedChoiceID: preparedChoiceID,
                preparedProviderLabel: preparedProviderLabel)
        }
    }

    private func detectConnections(
        context: AttemptContext,
        intent: SetupIntent,
        preparedChoiceID: String? = nil,
        preparedProviderLabel: String? = nil) async
    {
        // Gateway awaits can yield to a route reset or cancellation. Revalidate
        // before every activation side effect so stale attempts cannot hand off.
        guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
        self.phase = .detecting
        // Reconciliation refreshes choices, not mutation authority. Keep its
        // recorded failure until the operator explicitly starts another test.
        if intent == .startSetup { self.detectError = nil }
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
            self.nativeSessionCatalogs = result.nativeSessionCatalogs ?? []
            self.nativeSessionCatalogPreferenceRequired =
                result.nativeSessionCatalogPreferenceRequired == true
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
            // Detection is presentation-only. Existing credentials and native
            // subscriptions are never tested or selected until the user clicks one.
            self.showManualEntry = !self.manualProviders.isEmpty
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
            requireFreshDetection()
            return
        }
        await self.activate(
            .candidate(kind: kind, modelRef: candidate.modelRef, label: candidate.label),
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
        guard let lease = serverLease else {
            requireFreshDetection()
            return
        }
        let leaseIsCurrent = await gateway.isCurrentServerLease(lease)
        guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
        guard leaseIsCurrent else {
            requireFreshDetection()
            return
        }
        self.detectError = nil
        let persistedStateBeforeActivation = self.lastDetectedActivationState
        var supportsExactModel = false
        if !request.isManual {
            self.selectedKind = kind
            self.phase = .testing
            self.statuses[kind] = .testing
            let supported = await gateway.supportsServerCapability(
                .systemAgentSetupModelRef,
                ifCurrentServerLease: lease)
            guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
            guard let supported else {
                requireFreshDetection()
                return
            }
            supportsExactModel = supported
        }
        let routeFingerprint = await gateway.activationOwnershipFingerprint(ifCurrentServerLease: lease)
        let requestTimeoutMs = await Self.activationRequestTimeoutMs(
            for: kind,
            gateway: self.gateway,
            serverLease: lease)
        guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
        var params = request.params(supportsExactModel: supportsExactModel)
        if self.nativeSessionCatalogPreferenceRequired, !self.nativeSessionCatalogs.isEmpty {
            params["nativeSessionCatalogsEnabled"] = AnyCodable(self.nativeSessionCatalogsEnabled)
        }
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
                option: self.activationAuthOption(for: request),
                params: params,
                timeoutMs: requestTimeoutMs,
                serverLease: lease,
                context: context)
            guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
            if result.ok {
                await self.finishSuccessfulActivation(
                    request: request,
                    result: result,
                    context: context,
                    activationOwner: activationOwner,
                    before: persistedStateBeforeActivation,
                    originalServerLease: lease)
            } else {
                let failure = Self.failure(label: request.label, status: result.status, error: result.error)
                _ = await self.settleFailedActivation(
                    failure, request: request, context: context, activationOwner: activationOwner, serverLease: lease)
            }
        } catch {
            guard self.isCurrentAttempt(context) else { return }
            // Confirmed wizard cancellation is an operator outcome; only other
            // errors need transport diagnostics and may require reconciliation.
            let failure = Self.activationFailure(error, label: request.label)
            if Self.activationFailureIsDefinitive(error) {
                await self.settleFailedActivation(
                    failure, request: request, context: context, activationOwner: activationOwner, serverLease: lease)
            } else {
                self.exposeActivationFailure(failure, for: request)
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
                    failure,
                    ifOwnedBy: context,
                    activationOwner: activationOwner,
                    activationDeadline: activationDeadline)
            }
        }
    }

    @discardableResult
    private func settleFailedActivation(
        _ failure: Failure,
        request: ActivationRequest,
        context: AttemptContext,
        activationOwner: OnboardingSystemAgentResumeStore.ActivationOwner,
        serverLease: GatewayConnection.ServerLease) async -> Bool
    {
        let leaseIsCurrent = await self.gateway.isCurrentServerLease(serverLease)
        // Lease validation can yield to a new UI attempt. Retire only the exact
        // failed owner, and never let its late continuation reset replacement state.
        guard self.isCurrentAttempt(context) else { return false }
        self.exposeActivationFailure(failure, for: request)
        self.pendingActivationVerification = false
        self.clearPendingHandoff(ifOwnedBy: context, activationOwner: activationOwner)
        if let deadline = activePendingActivationDeadline(for: context.routeIdentity) {
            self.detectError = failure
            self.beginPendingActivationDeadlineWait()
            self.onPendingActivationDeadline?(deadline, context.routeIdentity)
            return false
        }
        guard leaseIsCurrent else {
            requireFreshDetection(after: failure)
            return false
        }
        self.phase = .ready
        if !request.isManual { self.showManualEntry = !self.manualProviders.isEmpty }
        return true
    }

    private func requestActivation(
        option: AuthOption,
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
                    guard self.activationWizardCompletion == nil else {
                        throw OnboardingAISetupError.activationOutcomeUnavailable
                    }
                    return try await withCheckedThrowingContinuation { continuation in
                        self.activationWizardCompletion = continuation
                        self.startSetupWizard(option, kind: .activation, params: params, serverLease: serverLease)
                    }
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
            self.detectError = failure
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
                guard self.isCurrentAttempt(context), !Task.isCancelled else { return false }
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
        originalServerLease: GatewayConnection.ServerLease) async
    {
        let kind = request.kind
        let expectedModel = request.modelRef ?? result.modelRef ?? ""
        let originalLeaseWasReplaced = await !(self.gateway.isCurrentServerLease(originalServerLease))
        let restartRequired = result.gatewayRestartRequired == true || originalLeaseWasReplaced
        guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
        if request.isManual { self.manualKey = "" }
        guard restartRequired else {
            self.finishConnected(
                kind: kind,
                activationOwner: activationOwner,
                handoff: kind == "existing-model" ? .dashboard : .custodianOnboarding)
            return
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
            return
        }
        guard self.isCurrentAttempt(context), !Task.isCancelled else { return }
        self.phase = .ready
        let failure = Self.transportFailure(
            "The Gateway did not finish restarting after AI setup. Try again once it is available.")
        self.exposeActivationFailure(failure, for: request)
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
            activationOwner: activationOwner,
            handoff: kind == "existing-model" ? .dashboard : .custodianOnboarding)
        return self.connected
    }
}

extension OnboardingAISetupModel {
    func startProviderWizard(_ option: AuthOption, kind: ProviderWizardKind) {
        guard !isBusy, self.activeAuthOption == nil else { return }
        if kind == .auth, option.kind == "custom", self.connectionModeProvider() == .remote {
            self.clearProviderAuth()
            self.activeAuthOption = option
            self.providerWizardKind = kind
            self.authError = Failure(
                summary: "Set up this endpoint on the Gateway host.",
                detail: """
                Custom endpoint setup is available here only for a local Gateway. \
                On the Gateway host, run `openclaw onboard --auth-choice custom-api-key`, \
                finish the endpoint wizard there, then return here and choose Try again.
                """)
            return
        }
        guard let serverLease else { return }
        var params = ["authChoice": AnyCodable(option.id)]
        if self.nativeSessionCatalogPreferenceRequired, !self.nativeSessionCatalogs.isEmpty {
            params["nativeSessionCatalogsEnabled"] = AnyCodable(self.nativeSessionCatalogsEnabled)
        }
        self.startSetupWizard(
            option,
            kind: kind,
            params: params,
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
                if self.providerAuthCancellation != nil {
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
                    modelActivation: result.modelactivation,
                    activationRejection: result.activationrejection)
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
                await self.failProviderAuthRequest(
                    error,
                    token: token,
                    authAttemptID: authAttemptID,
                    sessionID: authSessionID,
                    serverLease: serverLease)
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
        let context = (token: self.attemptToken, state: self.lastDetectedActivationState, authID: self.authAttemptID)
        self.providerAuthCancellation = .requesting
        self.authError = nil
        self.authBusy = true
        Task {
            let cancellation = await self.gateway.cancelWizardSession(
                sessionID,
                on: authServerLease)
            // A stale cancellation reply must not close or hand off a replacement wizard.
            guard context.token == self.attemptToken, context.authID == self.authAttemptID else { return }
            // Absence can precede admission or follow a purged terminal result.
            // Keep the exact pending request alive; absence alone cannot settle it.
            let awaitingResult = cancellation == .absent && self.authRequestID != nil
            if cancellation == .unresolved || awaitingResult {
                if self.authRequestID == nil, self.authStep == nil {
                    self.advanceProviderAuth(stepID: nil, value: nil)
                }
                self.providerAuthCancellation = .unconfirmed
                self.authError = Self.providerAuthCancellationUnconfirmed()
                return
            }
            if self.activationWizardCompletion != nil {
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
            self.clearProviderAuth()
        }
    }

    func advanceProviderAuth(stepID: String?, value: AnyCodable?) {
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
                    activationRejection: result.activationrejection)
            } catch {
                // Admission already succeeded. A later callback's non-dispatch,
                // auth, or TLS error cannot prove the original activation never started.
                let failure: Error = self.activationWizardCompletion == nil
                    ? error : OnboardingAISetupError.activationFailed(error.localizedDescription)
                await self.failProviderAuthRequest(
                    failure,
                    token: token,
                    authAttemptID: authAttemptID,
                    sessionID: sessionID,
                    serverLease: requestLease)
            }
        }
    }

    private func failProviderAuthRequest(
        _ error: Error,
        token: UUID,
        authAttemptID: UUID,
        sessionID: String,
        serverLease: GatewayConnection.ServerLease) async
    {
        // Socket loss does not retire the server session. Cancel its exact lease
        // before reconciling or presenting a failure for this wizard generation.
        let cancellation = await self.gateway.cancelWizardSession(sessionID, on: serverLease)
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
        // Reconciliation also returns false when a replacement retires this flow.
        guard token == self.attemptToken, authAttemptID == self.authAttemptID else { return }
        if cancellation != .unresolved {
            self.retireProviderAuthSession()
        }
        self.authBusy = false
        self.authError = Self.transportFailure(error.localizedDescription)
    }

    private func applyAuthWizardResult(
        done: Bool,
        step: WizardStep?,
        status: String?,
        error: String?,
        preparedModelRef: String?,
        modelActivation: [String: AnyCodable]? = nil,
        activationRejection: [String: AnyCodable]? = nil)
    {
        guard let option = self.activeAuthOption,
              let kind = self.providerWizardKind else { return }
        self.authBusy = false
        if self.activationWizardCompletion != nil,
           done || status == "done" || status == "cancelled" || status == "error"
        {
            let result = Self.activationWizardResult(
                done: done,
                status: status,
                error: error,
                preparedModelRef: preparedModelRef,
                modelActivation: modelActivation,
                activationRejection: activationRejection)
            self.finishActivationWizard(result)
            self.clearProviderAuth()
            return
        }
        let validationError = !done && status == "running" && error?.isEmpty == false
        let preserveEnteredValue = validationError && self.authStep?.id == step?.id
        if status == "error" || (done && error != nil) {
            self.retireProviderAuthSession()
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
                            label: preparedProvider.label),
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

    private func retireProviderAuthSession() {
        // Settled sessions revoke outstanding replies even while their terminal
        // error remains visible for inspection and dismissal.
        self.authAttemptID = UUID()
        self.authRequestID = nil
        self.authSessionID = nil
        self.providerAuthCancellation = nil
        self.authStep = nil
    }

    private func clearProviderAuth() {
        self.retireProviderAuthSession()
        self.activeAuthOption = nil
        self.providerWizardKind = nil
        self.authError = nil
        self.authBusy = false
        self.authText = ""
    }

    #if DEBUG
    var _test_authSessionID: String? {
        self.authSessionID
    }
    #endif
}

extension OnboardingAISetupModel {
    /// Captures submission synchronously; the task settles only after activation recovery finishes.
    @discardableResult
    func submitManualKey() -> Task<Void, Never>? {
        let key = self.manualKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let provider = selectedManualProvider, !key.isEmpty, !self.isBusy else { return nil }
        guard let context = beginAttemptContext() else {
            self.manualError = Self.transportFailure(
                "No Gateway is selected. Select a Gateway, then try again.")
            return nil
        }
        self.manualError = nil
        self.manualTesting = true
        return Task { await self.activate(.manual(key: key, provider: provider), context: context) }
    }

    /// A retired socket invalidates every candidate and provider record learned
    /// from that server generation. Preserve the error, but require a fresh
    /// detection lease before the user can dispatch another setup mutation.
    func requireFreshDetection(
        after failure: Failure = OnboardingAISetupModel.transportFailure(
            "The Gateway connection changed. Check for AI accounts again."))
    {
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
}
