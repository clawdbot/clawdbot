import Foundation
import OpenClawKit

/// Route-bound check used before onboarding starts creating inference config.
/// A superseded result must never complete onboarding for the replacement Gateway.
@MainActor
final class OnboardingConfiguredGatewayProbe {
    struct Attempt: Equatable {
        fileprivate let generation: UInt64
    }

    struct BoundRoute: Equatable {
        fileprivate let route: GatewayConnection.Route
        let identity: String?
    }

    struct VerificationProof: Equatable {
        let activationOwnershipFingerprint: String?
    }

    enum Outcome: Equatable {
        case configured(modelRef: String, verification: VerificationProof?, route: BoundRoute)
        case verificationFailed(
            modelRef: String,
            status: String?,
            error: String?,
            verification: VerificationProof,
            route: BoundRoute)
        case missing(route: BoundRoute)
        case authIssue(RemoteGatewayAuthIssue)
        case unavailable
        case superseded

        var boundRoute: BoundRoute? {
            switch self {
            case let .configured(_, _, route),
                 let .verificationFailed(_, _, _, _, route),
                 let .missing(route):
                route
            case .authIssue, .unavailable, .superseded:
                nil
            }
        }
    }

    private let gateway: GatewayConnection
    private let timeoutMs: Double
    private let verificationTimeoutMs: Double
    private var generation: UInt64 = 0
    private var scheduledProbeGenerations = Set<UInt64>()
    private var activeProbeGenerations = Set<UInt64>()
    private var observedServerIdentity: GatewayConnection.ServerIdentity?
    private var pendingReconnectIdentity: GatewayConnection.ServerIdentity?
    private var reconnectHandler: (@MainActor () -> Void)?
    private var pendingActivationDeadlineTask: Task<Void, Never>?
    private var temporaryConnectionCheckDepth = 0

    init(
        gateway: GatewayConnection = .shared,
        timeoutMs: Double = 15000,
        verificationTimeoutMs: Double = 150_000)
    {
        self.gateway = gateway
        self.timeoutMs = timeoutMs
        self.verificationTimeoutMs = verificationTimeoutMs
    }

    /// Allocate before queuing async work so user-event order, not Task start
    /// order, decides which selected Gateway owns the result.
    func beginProbe() -> Attempt {
        self.generation &+= 1
        let attempt = Attempt(generation: self.generation)
        // Only the newest queued attempt can still start; active superseded
        // attempts remain tracked until their route-bound work unwinds.
        self.scheduledProbeGenerations = [attempt.generation]
        return attempt
    }

    func isCurrent(_ attempt: Attempt) -> Bool {
        self.generation == attempt.generation
    }

    var isSuppressedForTemporaryConnectionCheck: Bool {
        self.temporaryConnectionCheckDepth > 0
    }

    func beginTemporaryConnectionCheck() {
        self.temporaryConnectionCheckDepth += 1
        // A probe already in flight for the committed selection must not finish
        // against the temporary mode borrowed by Check connection.
        self.invalidate()
    }

    func endTemporaryConnectionCheck() {
        self.temporaryConnectionCheckDepth = max(0, self.temporaryConnectionCheckDepth - 1)
    }

    func invalidate() {
        self.generation &+= 1
        self.scheduledProbeGenerations.removeAll()
        self.pendingActivationDeadlineTask?.cancel()
        self.pendingActivationDeadlineTask = nil
    }

    func schedulePendingActivationRecheck(
        deadline: Date,
        onElapsed: @escaping @MainActor () -> Void)
    {
        self.pendingActivationDeadlineTask?.cancel()
        let generation = self.generation
        let delay = max(0, deadline.timeIntervalSinceNow)
        self.pendingActivationDeadlineTask = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(for: .seconds(delay))
            } catch {
                return
            }
            guard let self, self.generation == generation else { return }
            self.pendingActivationDeadlineTask = nil
            onElapsed()
        }
    }

    func cancelPendingActivationRecheck() {
        self.pendingActivationDeadlineTask?.cancel()
        self.pendingActivationDeadlineTask = nil
    }

    func probe(
        connectionMode: AppState.ConnectionMode,
        attempt: Attempt,
        routeIdentity: String? = nil,
        verifyConfiguredInference: Bool = true) async -> Outcome
    {
        self.scheduledProbeGenerations.remove(attempt.generation)
        guard self.isCurrent(attempt) else { return .superseded }
        self.activeProbeGenerations.insert(attempt.generation)
        defer { self.finishProbe(attempt) }
        guard connectionMode != .unconfigured else { return .unavailable }
        let lease: GatewayConnection.ServerLease
        do {
            lease = try await self.gateway.acquireServerLease()
        } catch {
            guard self.isCurrent(attempt) else { return .superseded }
            if connectionMode == .remote,
               let authIssue = RemoteGatewayAuthIssue(error: error)
            {
                return .authIssue(authIssue)
            }
            return .unavailable
        }
        guard self.isCurrent(attempt) else { return .superseded }
        self.registerProbeServer(lease.identity)
        let route = lease.route
        do {
            let agentsData = try await gateway.request(
                method: GatewayConnection.Method.agentsList.rawValue,
                params: [:],
                timeoutMs: self.timeoutMs,
                ifCurrentServerLease: lease)
            let model = try GatewayConnection.decodeConfiguredInferenceModel(agentsData)
            guard await self.gateway.isCurrentServerLease(lease),
                  self.isCurrent(attempt)
            else { return .superseded }
            let boundRoute = BoundRoute(route: route, identity: routeIdentity)
            guard let model else { return .missing(route: boundRoute) }
            // A pending activation receipt has its own route- and owner-bound
            // verifier. Avoid paying for a second turn before reconciliation.
            guard verifyConfiguredInference else {
                return .configured(modelRef: model, verification: nil, route: boundRoute)
            }

            guard let supportsVerification = await self.gateway.supportsServerMethod(
                "openclaw.setup.verify",
                ifCurrentServerLease: lease),
                self.isCurrent(attempt)
            else { return .superseded }
            // Released Gateways predate the live verifier. Preserve their
            // config-only handoff until they are upgraded.
            guard supportsVerification else {
                return .configured(modelRef: model, verification: nil, route: boundRoute)
            }
            let verificationData: Data
            do {
                verificationData = try await self.gateway.request(
                    method: "openclaw.setup.verify",
                    params: [:],
                    timeoutMs: self.verificationTimeoutMs,
                    ifCurrentServerLease: lease)
            } catch {
                guard let response = error as? GatewayResponseError,
                      response.method == "openclaw.setup.verify",
                      response.missingScope == "operator.admin"
                else { throw error }
                guard await self.gateway.isCurrentServerLease(lease),
                      self.isCurrent(attempt)
                else { return .superseded }
                // Released Gateways advertised this method while requiring admin.
                // Persisted macOS device grants can be write-only after an upgrade.
                return .configured(modelRef: model, verification: nil, route: boundRoute)
            }
            guard await self.gateway.isCurrentServerLease(lease),
                  self.isCurrent(attempt)
            else { return .superseded }
            let verification = try JSONDecoder().decode(
                OnboardingAISetupModel.ActivateResult.self,
                from: verificationData)
            guard verification.ok else {
                return .verificationFailed(
                    modelRef: model,
                    status: verification.status,
                    error: verification.error,
                    verification: VerificationProof(
                        activationOwnershipFingerprint: lease.route.activationOwnershipFingerprint),
                    route: boundRoute)
            }
            return .configured(
                modelRef: model,
                verification: VerificationProof(
                    activationOwnershipFingerprint: lease.route.activationOwnershipFingerprint),
                route: boundRoute)
        } catch is CancellationError {
            guard self.isCurrent(attempt) else { return .superseded }
            return await self.gateway.isCurrentServerLease(lease) ? .superseded : .unavailable
        } catch {
            guard self.isCurrent(attempt) else { return .superseded }
            guard await self.gateway.isCurrentServerLease(lease) else { return .unavailable }
            if connectionMode == .remote,
               let authIssue = RemoteGatewayAuthIssue(error: error)
            {
                return .authIssue(authIssue)
            }
            return .unavailable
        }
    }

    func isCurrent(_ route: BoundRoute) async -> Bool {
        await self.gateway.isCurrentRoute(route.route)
    }

    func consumeReconnects(onReconnect: @escaping @MainActor () -> Void) async {
        self.reconnectHandler = onReconnect
        defer {
            self.reconnectHandler = nil
            self.pendingReconnectIdentity = nil
            self.observedServerIdentity = nil
        }
        let subscription = await gateway.subscribeServerSnapshots(bufferingNewest: 1)
        if let baseline = subscription.baseline {
            self.consumeServerSnapshot(baseline, onReconnect: onReconnect)
        }
        for await identity in subscription.stream {
            guard !Task.isCancelled else { return }
            self.consumeServerSnapshot(identity, onReconnect: onReconnect)
        }
    }

    private var hasProbeWork: Bool {
        !self.scheduledProbeGenerations.isEmpty || !self.activeProbeGenerations.isEmpty
    }

    private func registerProbeServer(_ identity: GatewayConnection.ServerIdentity) {
        self.observedServerIdentity = identity
        if self.pendingReconnectIdentity == identity {
            self.pendingReconnectIdentity = nil
        }
    }

    private func consumeServerSnapshot(
        _ identity: GatewayConnection.ServerIdentity,
        onReconnect: @escaping @MainActor () -> Void)
    {
        guard identity != self.observedServerIdentity else { return }
        // Admission and ordinary push delivery can expose the same socket.
        // Record it before starting work so that socket schedules only one probe.
        self.observedServerIdentity = identity
        guard !self.hasProbeWork else {
            self.pendingReconnectIdentity = identity
            return
        }
        onReconnect()
    }

    private func finishProbe(_ attempt: Attempt) {
        self.activeProbeGenerations.remove(attempt.generation)
        guard !self.hasProbeWork, self.pendingReconnectIdentity != nil else { return }
        self.pendingReconnectIdentity = nil
        self.reconnectHandler?()
    }
}
