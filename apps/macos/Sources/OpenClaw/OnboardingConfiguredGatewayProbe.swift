import Foundation

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

    enum Outcome: Equatable {
        case configured(modelRef: String, route: BoundRoute)
        case missing(route: BoundRoute)
        case unavailable
        case superseded

        var boundRoute: BoundRoute? {
            switch self {
            case let .configured(_, route), let .missing(route):
                route
            case .unavailable, .superseded:
                nil
            }
        }
    }

    private let gateway: GatewayConnection
    private let timeoutMs: Double
    private var generation: UInt64 = 0
    private var activeProbeCount = 0
    private var reconnectPending = false
    private var reconnectHandler: (@MainActor () -> Void)?
    private var pendingActivationDeadlineTask: Task<Void, Never>?
    private var temporaryConnectionCheckDepth = 0

    init(
        gateway: GatewayConnection = .shared,
        timeoutMs: Double = 15000)
    {
        self.gateway = gateway
        self.timeoutMs = timeoutMs
    }

    /// Allocate before queuing async work so user-event order, not Task start
    /// order, decides which selected Gateway owns the result.
    func beginProbe() -> Attempt {
        self.generation &+= 1
        return Attempt(generation: self.generation)
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
        routeIdentity: String? = nil) async -> Outcome
    {
        guard self.isCurrent(attempt) else { return .superseded }
        self.activeProbeCount += 1
        defer { self.finishProbe() }
        guard connectionMode != .unconfigured else { return .unavailable }
        guard let route = await gateway.captureRoute() else {
            return self.isCurrent(attempt) ? .unavailable : .superseded
        }
        guard self.isCurrent(attempt) else { return .superseded }
        let boundRoute = BoundRoute(route: route, identity: routeIdentity)

        do {
            let model = try await gateway.configuredInferenceModel(
                ifCurrentRoute: route,
                timeoutMs: self.timeoutMs)
            guard await self.gateway.isCurrentRoute(route),
                  self.isCurrent(attempt)
            else { return .superseded }
            guard let model = model?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !model.isEmpty
            else { return .missing(route: boundRoute) }
            return .configured(modelRef: model, route: boundRoute)
        } catch is CancellationError {
            return .superseded
        } catch {
            guard await self.gateway.isCurrentRoute(route),
                  self.isCurrent(attempt)
            else { return .superseded }
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
            self.reconnectPending = false
        }
        let stream = await gateway.subscribe(bufferingNewest: 1)
        for await push in stream {
            guard !Task.isCancelled else { return }
            guard case .snapshot = push else { continue }
            // captureRoute can create the socket whose hello produced this
            // snapshot. Coalesce it until that route-bound check finishes so a
            // real reconnect is never lost behind the in-flight request.
            guard self.activeProbeCount == 0 else {
                self.reconnectPending = true
                continue
            }
            onReconnect()
        }
    }

    private func finishProbe() {
        self.activeProbeCount -= 1
        guard self.activeProbeCount == 0, self.reconnectPending else { return }
        self.reconnectPending = false
        self.reconnectHandler?()
    }
}
