import Foundation
import Observation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import SwiftUI

struct ControlHeartbeatEvent: Codable {
    let ts: Double
    let status: String
    let to: String?
    let preview: String?
    let durationMs: Double?
    let hasMedia: Bool?
    let reason: String?
}

struct ControlAgentEvent: Codable, Identifiable {
    var id: String {
        "\(self.runId)-\(self.seq)"
    }

    let runId: String
    let seq: Int
    let stream: String
    let ts: Double
    let data: [String: OpenClawProtocol.AnyCodable]
    let summary: String?
}

enum ControlChannelError: Error, LocalizedError {
    case disconnected
    case badResponse(String)

    var errorDescription: String? {
        switch self {
        case .disconnected: "Control channel disconnected"
        case let .badResponse(msg): msg
        }
    }
}

struct ControlChannelStateDebouncer {
    private let interval: TimeInterval
    private var lastAppliedAt: Date

    init(interval: TimeInterval = 0.5, lastAppliedAt: Date = .distantPast) {
        self.interval = interval
        self.lastAppliedAt = lastAppliedAt
    }

    mutating func delayBeforeApplying(
        currentState: ControlChannel.ConnectionState,
        newState: ControlChannel.ConnectionState,
        now: Date) -> TimeInterval?
    {
        if Self.isTerminal(currentState) || Self.isTerminal(newState) {
            self.lastAppliedAt = now
            return nil
        }

        let elapsed = now.timeIntervalSince(self.lastAppliedAt)
        guard elapsed < self.interval else {
            self.lastAppliedAt = now
            return nil
        }

        return self.interval - max(0, elapsed)
    }

    mutating func recordDeferredApply(at date: Date) {
        self.lastAppliedAt = date
    }

    private static func isTerminal(_ state: ControlChannel.ConnectionState) -> Bool {
        switch state {
        case .connected, .disconnected:
            true
        case .connecting, .degraded:
            false
        }
    }
}

struct ControlChannelCompatibilityAlerts {
    struct Presentation: Equatable {
        let issue: GatewayCompatibilityIssue
        let id = UUID()
    }

    private(set) var routeGeneration: UInt64 = 0
    private(set) var presentation: Presentation?
    private var endpointRevision: UInt64?

    mutating func observeEndpoint(revision: UInt64) -> Bool {
        defer { self.endpointRevision = revision }
        guard let endpointRevision, endpointRevision != revision else { return false }
        self.routeChanged()
        return true
    }

    mutating func routeChanged() {
        self.routeGeneration &+= 1
        self.presentation = nil
    }

    mutating func observeConnection(revision: UInt64?) -> ControlChannel.ConnectionState? {
        guard let revision, revision == self.endpointRevision else { return nil }
        return self.updateConnection(generation: self.routeGeneration, state: .connected)
    }

    mutating func updateConnection(
        generation: UInt64,
        state: ControlChannel.ConnectionState) -> ControlChannel.ConnectionState?
    {
        guard generation == self.routeGeneration else { return nil }
        if state == .connected { self.presentation = nil }
        // A retry may fail before hello. Keep the last authoritative incompatibility
        // until this route connects successfully or its owner retires it.
        return self.presentation.map { .degraded($0.issue.message) } ?? state
    }

    mutating func prepare(_ issue: GatewayCompatibilityIssue, generation: UInt64) -> Presentation? {
        guard generation == self.routeGeneration, self.presentation?.issue != issue else { return nil }
        let presentation = Presentation(issue: issue)
        self.presentation = presentation
        return presentation
    }
}

@MainActor
@Observable
final class ControlChannel {
    static let shared = ControlChannel()

    enum Mode {
        case local
        case remote(target: String, identity: String)
    }

    enum ConnectionState: Equatable {
        case disconnected
        case connecting
        case connected
        case degraded(String)
    }

    private(set) var state: ConnectionState = .disconnected {
        didSet {
            CanvasManager.shared.refreshDebugStatus()
            guard oldValue != self.state else { return }
            if self.state != .connected {
                self.lastPingMs = nil
                self.authSourceLabel = nil
            }
            NotificationCenter.default.post(name: .controlChannelStateDidChange, object: nil)
            switch self.state {
            case .connected:
                self.logger.info("control channel state -> connected")
            case .connecting:
                self.logger.info("control channel state -> connecting")
            case .disconnected:
                self.logger.info("control channel state -> disconnected")
            case let .degraded(message):
                let detail = message.isEmpty ? "degraded" : "degraded: \(message)"
                self.logger.info("control channel state -> \(detail, privacy: .public)")
                self.scheduleRecovery(reason: message)
            }
        }
    }

    private(set) var lastPingMs: Double?
    private(set) var authSourceLabel: String?

    var lastHeartbeatEvent: ControlHeartbeatEvent? {
        guard let heartbeat, self.gateway.serverLeaseMatchesCurrentRoute(heartbeat.lease) else { return nil }
        return heartbeat.event
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "control")
    let gateway: GatewayConnection
    private let endpointRevision: @Sendable () -> UInt64

    private var eventTask: Task<Void, Never>?
    private var recoveryTask: Task<Void, Never>?
    private var lastRecoveryAt: Date?
    private var compatibilityAlerts = ControlChannelCompatibilityAlerts()
    private var eventServerLease: GatewayConnection.ServerLease?
    private var heartbeat: (event: ControlHeartbeatEvent, lease: GatewayConnection.ServerLease)?
    private var heartbeatReadTask: Task<Void, Never>?

    private func synchronizeRouteGeneration() -> UInt64 {
        // Endpoint stream delivery can lag source adoption; fence UI publication directly.
        if self.compatibilityAlerts.observeEndpoint(revision: self.endpointRevision()) {
            self.cancelPendingStateTask()
            self.cancelRecovery()
            self.retireEventState()
        }
        return self.compatibilityAlerts.routeGeneration
    }

    @discardableResult
    private func reconcileCurrentConnection(generation: UInt64) -> Bool {
        guard generation == self.synchronizeRouteGeneration(),
              let state = self.compatibilityAlerts.observeConnection(
                  revision: self.gateway.connectedEndpointRevision)
        else { return false }
        // Admission can precede its snapshot; publish success and cancel stale deferred status together.
        self.setStateThrottled(state, generation: generation)
        return generation == self.synchronizeRouteGeneration()
    }

    // Coalesce rapid connecting/degraded oscillations while the gateway connection is unstable.
    private var pendingStateTask: Task<Void, Never>?
    private var stateDebouncer = ControlChannelStateDebouncer()

    private func setStateThrottled(_ newState: ConnectionState, generation: UInt64? = nil) {
        let currentGeneration = self.synchronizeRouteGeneration()
        let generation = generation ?? currentGeneration
        guard let newState = self.compatibilityAlerts.updateConnection(
            generation: generation,
            state: newState)
        else { return }
        let now = Date()
        if let delay = self.stateDebouncer.delayBeforeApplying(
            currentState: self.state,
            newState: newState,
            now: now)
        {
            self.pendingStateTask?.cancel()
            self.pendingStateTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: Self.nanoseconds(for: delay))
                guard let self, !Task.isCancelled, generation == self.synchronizeRouteGeneration() else { return }
                self.pendingStateTask = nil
                self.stateDebouncer.recordDeferredApply(at: Date())
                self.applyState(newState)
            }
            return
        }

        self.cancelPendingStateTask()
        self.applyState(newState)
    }

    private func cancelPendingStateTask() {
        self.pendingStateTask?.cancel()
        self.pendingStateTask = nil
    }

    private func applyState(_ newState: ConnectionState) {
        self.state = newState
    }

    private static func nanoseconds(for interval: TimeInterval) -> UInt64 {
        UInt64(max(0, interval) * 1_000_000_000)
    }

    init(
        gateway: GatewayConnection = .shared,
        endpointRevision: @escaping @Sendable () -> UInt64 = { GatewayEndpointStore.shared.routeRevision })
    {
        self.gateway = gateway
        self.endpointRevision = endpointRevision
        self.startEventStream()
    }

    isolated deinit {
        self.eventTask?.cancel()
        self.recoveryTask?.cancel()
        self.pendingStateTask?.cancel()
        self.heartbeatReadTask?.cancel()
    }

    func configure() async {
        self.logger.info("control channel configure mode=local")
        await self.refreshEndpoint(reason: "configure")
    }

    func configure(mode: Mode = .local) async throws {
        switch mode {
        case .local:
            await self.configure()
        case let .remote(target, identity):
            let generation = self.synchronizeRouteGeneration()
            do {
                _ = (target, identity)
                let idSet = !identity.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                self.logger.info(
                    "control channel configure mode=remote " +
                        "target=\(target, privacy: .public) identitySet=\(idSet, privacy: .public)")
                self.setStateThrottled(.connecting)
                _ = try await GatewayEndpointStore.shared.ensureRemoteControlTunnel()
                await self.refreshEndpoint(reason: "configure", generation: generation)
            } catch {
                guard !Task.isCancelled, generation == self.synchronizeRouteGeneration() else { return }
                self.setStateThrottled(.degraded(error.localizedDescription), generation: generation)
                throw error
            }
        }
    }

    func endpointDidChange(_ state: GatewayEndpointState) {
        guard state.routeRevision == self.endpointRevision() else { return }
        let generation = self.synchronizeRouteGeneration()
        Task { [gateway] in try? await gateway.adoptSelectedEndpoint() }
        switch state {
        case .ready:
            Task { await self.refreshEndpoint(reason: "endpoint changed", generation: generation) }
        case .connecting:
            self.setStateThrottled(.connecting)
        case let .unavailable(_, reason, _):
            self.setStateThrottled(.degraded(reason))
        }
    }

    func refreshEndpoint(reason: String, generation: UInt64? = nil) async {
        let generation = generation ?? self.synchronizeRouteGeneration()
        guard !Task.isCancelled, generation == self.synchronizeRouteGeneration() else { return }
        self.logger.info("control channel refresh endpoint reason=\(reason, privacy: .public)")
        if self.eventTask == nil { self.startEventStream() }
        self.setStateThrottled(.connecting)
        do {
            try await self.establishGatewayConnection()
            guard !Task.isCancelled, self.reconcileCurrentConnection(generation: generation) else { return }
            guard let lease = await self.gateway.captureServerLease(),
                  generation == self.synchronizeRouteGeneration(),
                  self.gateway.serverLeaseMatchesCurrentState(lease) else { return }
            let authSource = await self.gateway.authSource()
            guard !Task.isCancelled, generation == self.synchronizeRouteGeneration(),
                  self.gateway.serverLeaseMatchesCurrentState(lease) else { return }
            self.authSourceLabel = Self.formatAuthSource(authSource, isRemote: CommandResolver.connectionModeIsRemote())
            PresenceReporter.shared.sendImmediate(reason: "connect")
        } catch {
            guard !Task.isCancelled else { return }
            self.reportFailure(error, generation: generation)
        }
    }

    func disconnect() async {
        self.compatibilityAlerts.routeChanged()
        self.cancelRecovery()
        self.eventTask?.cancel()
        self.eventTask = nil
        self.retireEventState()
        self.setStateThrottled(.disconnected)
        await self.gateway.shutdown()
    }

    func health(
        timeout: TimeInterval? = nil,
        ifCurrentServerLease lease: GatewayConnection.ServerLease? = nil) async throws -> Data
    {
        let generation = self.synchronizeRouteGeneration()
        let start = Date()
        var params: [String: AnyHashable]?
        if let timeout {
            params = ["timeout": AnyHashable(Int(timeout * 1000))]
        }
        let timeoutMs = (timeout ?? 15) * 1000
        let payload = try await self.request(
            method: "health", params: params, timeoutMs: timeoutMs, ifCurrentServerLease: lease)
        if lease.map(self.gateway.serverLeaseMatchesCurrentState) != false,
           self.reconcileCurrentConnection(generation: generation)
        {
            self.lastPingMs = Date().timeIntervalSince(start) * 1000
        }
        return payload
    }

    func acquireServerLease() async throws -> GatewayConnection.ServerLease {
        let generation = self.synchronizeRouteGeneration()
        return try await self.performRequest {
            let connected = await self.gateway.captureServerLease()
            try Task.checkCancellation()
            // Reuse and acquisition are one admission. A lookup closed by disconnect
            // must not become a fresh request that reopens the connection.
            guard generation == self.synchronizeRouteGeneration() else { throw CancellationError() }
            if let connected { return connected }
            return try await self.gateway.acquireServerLease()
        }
    }

    func request(
        method: String,
        params: [String: AnyHashable]? = nil,
        timeoutMs: Double? = nil,
        retryTransportFailures: Bool = true,
        ifCurrentServerLease lease: GatewayConnection.ServerLease? = nil) async throws -> Data
    {
        try await self.performRequest(ifCurrentServerLease: lease) {
            let rawParams = params?.reduce(into: [String: OpenClawKit.AnyCodable]()) {
                $0[$1.key] = OpenClawKit.AnyCodable($1.value.base)
            }
            if let lease {
                return try await self.gateway.request(
                    method: method, params: rawParams, timeoutMs: timeoutMs, ifCurrentServerLease: lease)
            }
            return try await self.gateway.request(
                method: method,
                params: rawParams,
                timeoutMs: timeoutMs,
                retryTransportFailures: retryTransportFailures)
        }
    }

    func request(
        _ request: OpenClawChatGatewayRequest,
        retryTransportFailures: Bool = true) async throws -> Data
    {
        try await self.performRequest {
            try await self.gateway.request(request, retryTransportFailures: retryTransportFailures)
        }
    }

    private func performRequest<Result: Sendable>(
        ifCurrentServerLease lease: GatewayConnection.ServerLease? = nil,
        _ operation: () async throws -> Result) async throws -> Result
    {
        try Task.checkCancellation()
        let generation = self.synchronizeRouteGeneration()
        if self.eventTask == nil { self.startEventStream() }
        do {
            let data = try await operation()
            try Task.checkCancellation()
            guard lease.map(self.gateway.serverLeaseMatchesCurrentState) != false else { throw CancellationError() }
            self.reconcileCurrentConnection(generation: generation)
            return data
        } catch {
            // Closing a view cancels its requests, not the shared connection.
            // Only failures belonging to a live caller may trigger recovery.
            try Task.checkCancellation()
            // A retired read cannot change status, ping, or start recovery on its replacement.
            guard !(error is CancellationError),
                  lease.map(self.gateway.serverLeaseMatchesCurrentState) != false else { throw CancellationError() }
            let message = self.reportFailure(error, generation: generation)
            throw ControlChannelError.badResponse(message)
        }
    }

    @discardableResult
    private func reportFailure(_ error: Error, generation: UInt64) -> String {
        _ = self.synchronizeRouteGeneration()
        let message = Self.friendlyGatewayMessage(error, configRoot: OpenClawConfigFile.loadDict())
        let issue = GatewayCompatibilityIssue(error: error)
        self.logger.error("control channel operation failed \(message, privacy: .public)")
        if issue != nil, self.reconcileCurrentConnection(generation: generation) { return message }
        let presentation = issue.flatMap { self.compatibilityAlerts.prepare($0, generation: generation) }
        self.setStateThrottled(.degraded(message), generation: generation)
        if let presentation {
            let issue = presentation.issue
            // Present once per route failure. A unique claim also retires queued alerts
            // after a route switch or successful connection with the same later issue.
            DispatchQueue.main.async { [weak self] in
                guard let self, generation == self.synchronizeRouteGeneration(),
                      self.compatibilityAlerts.presentation?.id == presentation.id
                else { return }
                self.reconcileCurrentConnection(generation: generation)
                guard generation == self.synchronizeRouteGeneration(),
                      self.compatibilityAlerts.presentation?.id == presentation.id
                else { return }
                let alert = NSAlert()
                alert.messageText = issue.problem.title
                alert.informativeText = issue.message
                alert.addButton(withTitle: String(localized: "OK"))
                NSApp.activate(ignoringOtherApps: true)
                alert.runModal()
            }
        }
        return message
    }

    static func friendlyGatewayMessage(_ error: Error, configRoot: [String: Any]) -> String {
        // Map URLSession/WS errors into user-facing, actionable text.
        if let ctrlErr = error as? ControlChannelError, let desc = ctrlErr.errorDescription {
            return desc
        }

        if let issue = GatewayCompatibilityIssue(error: error) {
            return issue.message
        }

        if let authIssue = RemoteGatewayAuthIssue(error: error) {
            return authIssue.statusMessage
        }

        let mode = ConnectionModeResolver.resolve(root: configRoot).mode
        let transport = GatewayRemoteConfig.resolveTransportResolution(root: configRoot)
        let localPort = GatewayEnvironment.gatewayPort()
        let directURL = mode == .remote && transport.transport == .direct ? transport.directURL : nil
        let endpoint = if let url = directURL, let host = url.host,
                          let port = GatewayRemoteConfig.defaultPort(for: url)
        {
            "\(host.contains(":") && !host.hasPrefix("[") ? "[" + host + "]" : host):\(port)"
        } else {
            "localhost:\(localPort)"
        }

        // If the gateway explicitly rejects the hello (e.g., auth/token mismatch), surface it.
        if let urlErr = error as? URLError,
           urlErr.code == .dataNotAllowed // used for WS close 1008 auth failures
        {
            let reason = urlErr.failureURLString ?? urlErr.localizedDescription
            let tokenKey = mode == .remote
                ? "gateway.remote.token"
                : "gateway.auth.token"
            return
                "Gateway rejected token; set \(tokenKey) or clear it on the gateway. Reason: \(reason)"
        }

        // Common misfire: we connected to the configured localhost port but it is occupied
        // by some other process (e.g. a local dev gateway or a stuck SSH forward).
        // The gateway handshake returns something we can't parse, which currently
        // surfaces as "hello failed (unexpected response)". Give the user a pointer
        // to free the port instead of a vague message.
        let nsError = error as NSError
        if nsError.domain == "Gateway",
           nsError.localizedDescription.contains("hello failed (unexpected response)")
        {
            if directURL != nil {
                return "Gateway handshake got non-gateway data on \(endpoint); check the Gateway URL and server."
            }
            return """
            Gateway handshake got non-gateway data on \(endpoint).
            Another process is using that port or the SSH forward failed.
            Stop the local gateway/port-forward on \(localPort) and retry Remote mode.
            """
        }

        if let urlError = error as? URLError {
            switch urlError.code {
            case .cancelled:
                return "Gateway connection was closed; start the gateway (\(endpoint)) and retry."
            case .cannotFindHost, .cannotConnectToHost:
                if directURL != nil {
                    return "Cannot reach gateway at \(endpoint); check the Gateway URL and remote gateway."
                }
                if mode == .remote {
                    return """
                    Cannot reach gateway at \(endpoint).
                    Remote mode uses an SSH tunnel—check the SSH target and that the tunnel is running.
                    """
                }
                return "Cannot reach gateway at \(endpoint); ensure the gateway is running."
            case .networkConnectionLost:
                return "Gateway connection dropped; gateway likely restarted—retry."
            case .timedOut:
                return "Gateway request timed out; check gateway on \(endpoint)."
            case .notConnectedToInternet:
                if Self.isLikelyLocalNetworkPermissionBlock(configRoot: configRoot) {
                    return """
                    macOS is blocking OpenClaw Local Network access.
                    Allow OpenClaw in System Settings → Privacy & Security → Local Network, then relaunch the app.
                    """
                }
                return "No network connectivity; cannot reach gateway."
            default:
                break
            }
        }

        if nsError.domain == "Gateway", nsError.code == 5 {
            return "Gateway request timed out; check the gateway process on \(endpoint)."
        }

        let detail = nsError.localizedDescription.isEmpty ? "unknown gateway error" : nsError.localizedDescription
        let trimmed = detail.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.lowercased().hasPrefix("gateway error:") { return trimmed }
        return "Gateway error: \(trimmed)"
    }

    private static func isLikelyLocalNetworkPermissionBlock(configRoot: [String: Any]) -> Bool {
        let resolution = GatewayRemoteConfig.resolveTransportResolution(root: configRoot)
        guard ConnectionModeResolver.resolve(root: configRoot).mode == .remote,
              resolution.transport == .direct,
              let url = resolution.directURL,
              url.scheme?.lowercased() == "ws",
              let host = url.host,
              GatewayRemoteConfig.isTrustedPlaintextRemoteHost(host),
              !LoopbackHost.isLoopbackHost(host)
        else {
            return false
        }
        return true
    }

    private func cancelRecovery() {
        self.recoveryTask?.cancel()
        self.recoveryTask = nil
        self.lastRecoveryAt = nil
    }

    private func scheduleRecovery(reason: String) {
        let generation = self.synchronizeRouteGeneration()
        let mode = AppStateStore.shared.connectionMode
        guard mode != .unconfigured else { return }
        let now = Date()
        if let last = self.lastRecoveryAt, now.timeIntervalSince(last) < 10 { return }
        guard self.recoveryTask == nil else { return }
        self.lastRecoveryAt = now

        self.recoveryTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if generation == self.synchronizeRouteGeneration() { self.recoveryTask = nil }
            }
            // Explicit disconnect and route replacement retire recovery before it can manage a process or tunnel.
            guard !Task.isCancelled, generation == self.synchronizeRouteGeneration(),
                  AppStateStore.shared.connectionMode == mode, self.state != .connected else { return }

            let trimmedReason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
            let reasonText = trimmedReason.isEmpty ? "unknown" : trimmedReason
            self.logger.info(
                "control channel recovery starting " +
                    "mode=\(String(describing: mode), privacy: .public) " +
                    "reason=\(reasonText, privacy: .public)")
            if mode == .local {
                GatewayProcessManager.shared.setActive(true)
            }
            if mode == .remote {
                do {
                    let port = try await GatewayEndpointStore.shared.ensureRemoteControlTunnel()
                    self.logger.info("control channel recovery ensured remote endpoint port=\(port, privacy: .public)")
                } catch {
                    guard !Task.isCancelled, generation == self.synchronizeRouteGeneration() else { return }
                    self.logger.error(
                        "control channel remote endpoint failed \(error.localizedDescription, privacy: .public)")
                }
            }

            guard !Task.isCancelled, generation == self.synchronizeRouteGeneration(),
                  AppStateStore.shared.connectionMode == mode else { return }
            await self.refreshEndpoint(reason: "recovery:\(reasonText)", generation: generation)
            guard !Task.isCancelled, generation == self.synchronizeRouteGeneration() else { return }
            if case .connected = self.state {
                self.logger.info("control channel recovery finished")
            } else if case let .degraded(message) = self.state {
                self.logger.error("control channel recovery failed \(message, privacy: .public)")
            }
        }
    }

    private func establishGatewayConnection(timeoutMs: Int = 5000) async throws {
        try await self.gateway.refresh()
        let ok = try await self.gateway.healthOK(timeoutMs: timeoutMs)
        if ok == false {
            throw NSError(
                domain: "Gateway",
                code: 0,
                userInfo: [NSLocalizedDescriptionKey: "gateway health not ok"])
        }
    }

    private static func formatAuthSource(_ source: GatewayAuthSource?, isRemote: Bool) -> String? {
        guard let source else { return nil }
        switch source {
        case .deviceToken:
            return "Auth: device token (paired device)"
        case .bootstrapToken:
            return "Auth: bootstrap token (setup code)"
        case .sharedToken:
            return "Auth: shared token (\(isRemote ? "gateway.remote.token" : "gateway.auth.token"))"
        case .password:
            return "Auth: password (\(isRemote ? "gateway.remote.password" : "gateway.auth.password"))"
        case .none:
            return "Auth: none"
        }
    }

    func sendSystemEvent(_ text: String, params: [String: AnyHashable] = [:]) async throws {
        var merged = params
        merged["text"] = AnyHashable(text)
        _ = try await self.request(method: "system-event", params: merged)
    }

    private func startEventStream() {
        GatewayPushSubscription.restartTask(task: &self.eventTask, connection: self.gateway) { [weak self] delivery in
            self?.handle(delivery: delivery)
        }
    }

    private func retireEventState() {
        self.eventServerLease = nil
        self.heartbeatReadTask?.cancel()
        // Keep the last known main key until a current hello replaces it.
        // Retired deliveries cannot use that metadata to recreate old work.
        WorkActivityStore.shared.reset()
    }

    private func handle(delivery: GatewayConnection.PushDelivery) {
        let generation = self.synchronizeRouteGeneration()
        guard delivery.isCurrent, delivery.serverLease.endpointRevision == self.endpointRevision() else { return }
        guard let push = delivery.push else {
            guard case let .disconnected(reason) = delivery.event else { return }
            self.retireEventState()
            self.setStateThrottled(reason.map(ConnectionState.degraded) ?? .disconnected, generation: generation)
            return
        }
        // Agent events may precede the ordinary hello notification. Adopt the
        // admitted handshake once, before any current work can be projected.
        if self.eventServerLease != delivery.serverLease {
            WorkActivityStore.shared.reset()
            if let mainSessionKey = delivery.mainSessionKey {
                WorkActivityStore.shared.setMainSessionKey(mainSessionKey)
            }
            self.eventServerLease = delivery.serverLease
            self.refreshHeartbeat(delivery: delivery)
        }
        switch push {
        case let .event(evt) where evt.event == "agent":
            if let payload = evt.payload,
               let agent = try? GatewayPayloadDecoding.decode(payload, as: ControlAgentEvent.self)
            {
                AgentEventStore.shared.append(agent)
                self.routeWorkActivity(from: agent)
            }
        case let .event(evt) where evt.event == "heartbeat":
            if let payload = evt.payload,
               let heartbeat = try? GatewayPayloadDecoding.decode(payload, as: ControlHeartbeatEvent.self)
            {
                self.heartbeatReadTask?.cancel()
                self.heartbeat = (heartbeat, delivery.serverLease)
            }
        case let .event(evt) where evt.event == "shutdown":
            self.setStateThrottled(.degraded("gateway shutdown"))
        case let .event(evt) where evt.event == "users.prefs.changed":
            // The gateway targets this event at connections bound to the
            // caller's own profile; receipt means our profile appearance
            // changed on another device.
            self.refreshProfileAccent(delivery: delivery)
        case .snapshot:
            self.reconcileCurrentConnection(generation: self.synchronizeRouteGeneration())
            self.refreshProfileAccent(delivery: delivery)
        default:
            break
        }
    }

    private func refreshHeartbeat(delivery: GatewayConnection.PushDelivery) {
        self.heartbeatReadTask?.cancel()
        self.heartbeatReadTask = Task { [weak self] in
            guard let self else { return }
            do {
                let data = try await self.request(
                    method: "last-heartbeat", ifCurrentServerLease: delivery.serverLease)
                // A newer push wins over this initial read, even on the same socket.
                guard !Task.isCancelled, delivery.isCurrent else { return }
                // GatewayChannel represents a successful null payload as empty data.
                self.heartbeat = data.isEmpty ? nil : try JSONDecoder()
                    .decode(ControlHeartbeatEvent?.self, from: data).map { ($0, delivery.serverLease) }
            } catch {
                // Keep the last good event across same-Gateway reconnects; the getter fences replaced routes.
            }
        }
    }

    private func refreshProfileAccent(delivery: GatewayConnection.PushDelivery) {
        Task {
            guard delivery.isCurrent else { return }
            let accent = await self.fetchProfileAccentHex(serverLease: delivery.serverLease)
            // A replaced request can fail as well as succeed; neither outcome
            // may repaint the newly selected Gateway's profile appearance.
            guard delivery.isCurrent else { return }
            AppStateStore.shared.profileAccentHex = accent
        }
    }

    /// Caller's per-profile accent (users.prefs.get). nil covers profile-less
    /// connections (no_durable_identity), older gateways without the method,
    /// and malformed stored values, so the gateway seam color stays the
    /// fallback. Goes straight through GatewayConnection: routing this through
    /// ControlChannel.request would mark the channel degraded on the expected
    /// older-gateway failure.
    private func fetchProfileAccentHex(serverLease: GatewayConnection.ServerLease) async -> String? {
        do {
            let data = try await self.gateway.request(
                method: "users.prefs.get",
                params: ["keys": OpenClawKit.AnyCodable(["ui.accent"])],
                timeoutMs: 8000,
                ifCurrentServerLease: serverLease)
            return try GatewayUserPreferences.decodeProfileAccentHex(data)
        } catch {
            return nil
        }
    }

    private func routeWorkActivity(from event: ControlAgentEvent) {
        // We currently treat VoiceWake as the "main" session for UI purposes.
        // In the future, the gateway can include a sessionKey to distinguish runs.
        let sessionKey = (event.data["sessionKey"]?.value as? String) ?? "main"

        switch event.stream.lowercased() {
        case "job":
            if let state = event.data["state"]?.value as? String {
                WorkActivityStore.shared.handleJob(sessionKey: sessionKey, state: state)
            }
        case "tool":
            let phase = event.data["phase"]?.value as? String ?? ""
            let name = event.data["name"]?.value as? String
            let meta = event.data["meta"]?.value as? String
            let args = Self.bridgeToProtocolArgs(event.data["args"])
            WorkActivityStore.shared.handleTool(
                sessionKey: sessionKey,
                phase: phase,
                name: name,
                meta: meta,
                args: args)
        default:
            break
        }
    }

    private static func bridgeToProtocolArgs(
        _ value: OpenClawProtocol.AnyCodable?) -> [String: OpenClawProtocol.AnyCodable]?
    {
        guard let value else { return nil }
        if let dict = value.value as? [String: OpenClawProtocol.AnyCodable] {
            return dict
        }
        if let dict = value.value as? [String: OpenClawKit.AnyCodable],
           let data = try? JSONEncoder().encode(dict),
           let decoded = try? JSONDecoder().decode([String: OpenClawProtocol.AnyCodable].self, from: data)
        {
            return decoded
        }
        if let data = try? JSONEncoder().encode(value),
           let decoded = try? JSONDecoder().decode([String: OpenClawProtocol.AnyCodable].self, from: data)
        {
            return decoded
        }
        return nil
    }
}

extension Notification.Name {
    static let controlChannelStateDidChange = Notification.Name("openclaw.control-channel.state-did-change")
}
