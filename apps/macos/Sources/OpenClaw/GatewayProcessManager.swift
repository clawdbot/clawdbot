import Foundation
import Observation
import OpenClawKit

private struct GatewayHealthProbeTimeout: LocalizedError, Sendable {
    let timeoutMs: Double

    var errorDescription: String? {
        "Gateway health probe timed out after \(Int(self.timeoutMs))ms"
    }
}

@MainActor
@Observable
final class GatewayProcessManager {
    static let shared = GatewayProcessManager()

    private struct LaunchAgentEnableRequest: Sendable {
        let bundlePath: String
        let port: Int
        let generation: UInt64
        var invocationIDs: [UInt64]

        func hasSameConfiguration(as other: LaunchAgentEnableRequest) -> Bool {
            self.bundlePath == other.bundlePath &&
                self.port == other.port &&
                self.generation == other.generation
        }
    }

    private struct LaunchAgentReadinessFailure: Equatable {
        let port: Int
        let pid: Int32
    }

    private struct LaunchAgentReadinessCandidate: Equatable {
        let failure: LaunchAgentReadinessFailure
        let generation: UInt64
    }

    private struct LaunchAgentEnableResult: Sendable {
        let error: String?
        let installed: Bool

        static let skipped = LaunchAgentEnableResult(error: nil, installed: false)

        static func failed(_ error: String) -> LaunchAgentEnableResult {
            LaunchAgentEnableResult(error: error, installed: false)
        }

        static func installed() -> LaunchAgentEnableResult {
            LaunchAgentEnableResult(error: nil, installed: true)
        }
    }

    private struct LaunchAgentStartupContext {
        let port: Int
        let enableResult: LaunchAgentEnableResult
        let readinessPID: Int32?
        let readinessRevision: UInt64
    }

    private enum GatewayProbeFailureDisposition: Equatable {
        case retryWithoutRepair
        case retryWithRepair
        case fail
    }

    enum Status: Equatable {
        case stopped
        case starting
        case running(details: String?)
        case attachedExisting(details: String?)
        case failed(String)

        var label: String {
            switch self {
            case .stopped: return "Stopped"
            case .starting: return "Starting…"
            case let .running(details):
                if let details, !details.isEmpty { return "Running (\(details))" }
                return "Running"
            case let .attachedExisting(details):
                if let details, !details.isEmpty {
                    return "Using existing gateway (\(details))"
                }
                return "Using existing gateway"
            case let .failed(reason): return "Failed: \(reason)"
            }
        }
    }

    private(set) var status: Status = .stopped {
        didSet { CanvasManager.shared.refreshDebugStatus() }
    }

    private(set) var log: String = ""
    private(set) var environmentStatus: GatewayEnvironmentStatus = .checking
    private(set) var existingGatewayDetails: String?
    private(set) var lastFailureReason: String?
    private var desiredActive = false
    private var environmentRefreshTask: Task<Void, Never>?
    private var lastEnvironmentRefresh: Date?
    private var logRefreshTask: Task<Void, Never>?
    private var launchAgentEnableTask: Task<[UInt64: LaunchAgentEnableResult], Never>?
    private var launchAgentEnableCurrentRequest: LaunchAgentEnableRequest?
    private var launchAgentEnablePendingRequest: LaunchAgentEnableRequest?
    private var launchAgentEnableSupersededInvocationIDs: Set<UInt64> = []
    private var launchAgentEnableNextInvocationID: UInt64 = 0
    private var launchAgentDisableTask: Task<Void, Never>?
    private var launchAgentDisableGeneration: UInt64?
    private var launchAgentReadinessFailure: LaunchAgentReadinessFailure?
    private var launchAgentReadinessCandidate: LaunchAgentReadinessCandidate?
    private var launchAgentReadinessRevision: UInt64 = 0
    private var launchAgentInstallGeneration: UInt64?
    private var lastObservedGatewayPID: Int32?
    /// Async readiness audits may outlive stop/restart. Only the current generation may publish
    /// their failure state or retain a PID for a later repair.
    private var gatewayStartGeneration: UInt64 = 0
    private var gatewayStartTask: Task<Void, Never>?
    private var gatewayStartTaskGeneration: UInt64?
    #if DEBUG
    private var testingConnection: GatewayConnection?
    private var testingSkipControlChannelRefresh = false
    private var testingControlChannelRefreshForces: [Bool] = []
    #endif
    private let logger = Logger(subsystem: "ai.openclaw", category: "gateway.process")

    private let logLimit = 20000 // characters to keep in-memory
    private let environmentRefreshMinInterval: TimeInterval = 30
    private var connection: GatewayConnection {
        #if DEBUG
        return self.testingConnection ?? .shared
        #else
        return .shared
        #endif
    }

    func setActive(_ active: Bool) {
        // Remote mode should never spawn a local gateway; treat as stopped.
        if CommandResolver.connectionModeIsRemote() {
            self.desiredActive = false
            self.stop()
            self.status = .stopped
            self.appendLog("[gateway] remote mode active; skipping local gateway\n")
            self.logger.info("gateway process skipped: remote mode active")
            return
        }
        self.logger.debug("gateway active requested active=\(active)")
        self.desiredActive = active
        self.refreshEnvironmentStatus()
        if active {
            self.startIfNeeded()
        } else {
            self.stop()
        }
    }

    func ensureLaunchAgentEnabledIfNeeded() async -> Bool {
        guard !CommandResolver.connectionModeIsRemote() else { return false }
        guard self.desiredActive else { return false }
        if GatewayLaunchAgentManager.isLaunchAgentWriteDisabled() {
            self.appendLog("[gateway] launchd auto-enable skipped (attach-only)\n")
            self.logger.info("gateway launchd auto-enable skipped (disable marker set)")
            return false
        }
        let bundlePath = Bundle.main.bundleURL.path
        let port = GatewayEnvironment.gatewayPort()
        let result = await self.enableLaunchAgentIfNeeded(
            bundlePath: bundlePath,
            port: port,
            generation: self.gatewayStartGeneration)
        if let err = result.error {
            self.appendLog("[gateway] launchd auto-enable failed: \(err)\n")
        }
        return result.installed
    }

    private func enableLaunchAgentIfNeeded(
        bundlePath: String,
        port: Int,
        generation expectedGeneration: UInt64? = nil) async -> LaunchAgentEnableResult
    {
        let generation = expectedGeneration ?? self.gatewayStartGeneration
        await self.waitForPendingLaunchAgentDisable()
        guard generation == self.gatewayStartGeneration else { return .skipped }
        self.launchAgentEnableNextInvocationID &+= 1
        let invocationID = self.launchAgentEnableNextInvocationID
        let request = LaunchAgentEnableRequest(
            bundlePath: bundlePath,
            port: port,
            generation: generation,
            invocationIDs: [invocationID])
        if let task = self.launchAgentEnableTask {
            if var current = self.launchAgentEnableCurrentRequest,
               current.hasSameConfiguration(as: request)
            {
                // The in-flight request already represents the newest configuration. Drop an
                // older queued change so A -> B -> A cannot finish on B.
                current.invocationIDs.append(invocationID)
                self.launchAgentEnableCurrentRequest = current
                if let pending = self.launchAgentEnablePendingRequest {
                    self.launchAgentEnableSupersededInvocationIDs.formUnion(pending.invocationIDs)
                }
                self.launchAgentEnablePendingRequest = nil
            } else if var pending = self.launchAgentEnablePendingRequest,
                      pending.hasSameConfiguration(as: request)
            {
                pending.invocationIDs.append(invocationID)
                self.launchAgentEnablePendingRequest = pending
            } else {
                if let pending = self.launchAgentEnablePendingRequest {
                    self.launchAgentEnableSupersededInvocationIDs.formUnion(pending.invocationIDs)
                }
                self.launchAgentEnablePendingRequest = request
            }
            let results = await task.value
            return results[invocationID] ?? .skipped
        }

        self.launchAgentEnableSupersededInvocationIDs.removeAll(keepingCapacity: true)
        self.launchAgentEnablePendingRequest = request
        let task = Task { @MainActor in
            await self.drainLaunchAgentEnableRequests()
        }
        self.launchAgentEnableTask = task
        let results = await task.value
        return results[invocationID] ?? .skipped
    }

    private func waitForPendingLaunchAgentDisable() async {
        // A stop may already be uninstalling launchd. Wait until it finishes so a newer start's
        // attach/install is ordered last; loop because another stop can supersede it while waiting.
        while let disableTask = self.launchAgentDisableTask {
            await disableTask.value
        }
    }

    private func drainLaunchAgentEnableRequests()
        async -> [UInt64: LaunchAgentEnableResult]
    {
        var results: [UInt64: LaunchAgentEnableResult] = [:]
        while let request = self.launchAgentEnablePendingRequest {
            self.launchAgentEnablePendingRequest = nil
            self.launchAgentEnableSupersededInvocationIDs.subtract(request.invocationIDs)
            self.launchAgentEnableCurrentRequest = request
            let result = await self.performLaunchAgentEnable(request)
            let completedRequest = self.launchAgentEnableCurrentRequest ?? request
            for invocationID in completedRequest.invocationIDs {
                results[invocationID] = result
            }
            self.launchAgentEnableCurrentRequest = nil
        }
        for invocationID in self.launchAgentEnableSupersededInvocationIDs {
            guard results[invocationID] == nil else { continue }
            results[invocationID] = .skipped
        }
        self.launchAgentEnableSupersededInvocationIDs.removeAll(keepingCapacity: true)
        // Clear the task before returning. A later caller then starts a fresh drain instead of
        // joining a completed task after the final pending-request check.
        self.launchAgentEnableTask = nil
        return results
    }

    private func performLaunchAgentEnable(_ request: LaunchAgentEnableRequest) async -> LaunchAgentEnableResult {
        // App startup and onboarding can request persistence together. One drain owns all installs;
        // a second forced install would kill the first Gateway during startup migrations.
        let launchAgent = await GatewayLaunchAgentManager.loadedGatewayState(port: request.port)
        // Pair one launchd snapshot with a current listener read. A PID that starts after the
        // status read cannot look reusable, so the ownership guard preserves it instead of forcing
        // an install; a reusable PID from this same snapshot receives its readiness cycle below.
        let listener = await PortGuardian.shared.describe(port: request.port)
        if let listener {
            guard listener.pid == launchAgent.runningPID else {
                // A healthy manually started Gateway may be attached without becoming app-owned.
                // Persistence checks and retained repair markers must not replace it.
                return .skipped
            }
        }

        if let pid = launchAgent.reusablePID {
            let failure = LaunchAgentReadinessFailure(port: request.port, pid: pid)
            if self.launchAgentReadinessFailure != failure {
                // A new launchd PID may still be running migrations. It must fail one complete
                // readiness cycle before a later retry is allowed to replace it.
                self.setLaunchAgentReadinessState(
                    candidate: LaunchAgentReadinessCandidate(
                        failure: failure,
                        generation: request.generation),
                    failure: nil)
                return .skipped
            }

            self.appendLog(
                "[gateway] launchd pid \(pid) failed readiness on port \(request.port); repairing\n")
            self.logger.warning(
                "gateway launchd pid=\(pid) failed readiness on port=\(request.port); repairing")
        }
        self.setLaunchAgentReadinessState(candidate: nil, failure: nil)
        self.appendLog(
            "[gateway] enabling launchd job (\(gatewayLaunchdLabel)) on port \(request.port)\n")
        if let error = await GatewayLaunchAgentManager.set(
            enabled: true,
            bundlePath: request.bundlePath,
            port: request.port)
        {
            return .failed(error)
        }
        // Keep replacement evidence until a healthy audit refreshes the control channel. Startup
        // and persistence calls coalesce, so the later caller may not receive `installed` itself.
        self.launchAgentInstallGeneration = request.generation
        return .installed()
    }

    private func resolveLaunchAgentReadinessFailure(
        port: Int,
        startingPID: Int32?) async -> LaunchAgentReadinessFailure?
    {
        guard let startingPID,
              let pid = await GatewayLaunchAgentManager.reusableLoadedGatewayPID(port: port),
              pid == startingPID
        else {
            return nil
        }
        // A stable launchd PID that owns the port can still have a wedged health RPC. A listener
        // owned by anyone else is protected and surfaced through the attach path instead.
        if let listener = await PortGuardian.shared.describe(port: port), listener.pid != pid {
            return nil
        }
        return LaunchAgentReadinessFailure(port: port, pid: pid)
    }

    private func setLaunchAgentReadinessState(
        candidate: LaunchAgentReadinessCandidate?,
        failure: LaunchAgentReadinessFailure?)
    {
        self.launchAgentReadinessCandidate = candidate
        self.launchAgentReadinessFailure = failure
        self.launchAgentReadinessRevision &+= 1
    }

    func startIfNeeded() {
        guard self.desiredActive else { return }
        // Do not spawn in remote mode (the gateway should run on the remote host).
        guard !CommandResolver.connectionModeIsRemote() else {
            self.status = .stopped
            return
        }
        // Many surfaces can call `setActive(true)` in quick succession (startup, Canvas, health checks).
        // Avoid spawning multiple concurrent "start" tasks that can thrash launchd and flap the port.
        switch self.status {
        case .starting, .running, .attachedExisting:
            return
        case .stopped, .failed:
            break
        }
        self.status = .starting
        self.gatewayStartGeneration &+= 1
        let startGeneration = self.gatewayStartGeneration
        self.logger.debug("gateway start requested")

        // First try to latch onto an already-running gateway to avoid spawning a duplicate.
        let task = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.gatewayStartTaskGeneration == startGeneration {
                    self.gatewayStartTask = nil
                    self.gatewayStartTaskGeneration = nil
                }
            }
            if await self.attachExistingGatewayAfterPendingDisable(startGeneration: startGeneration) {
                return
            }
            await self.enableLaunchdGateway(startGeneration: startGeneration)
        }
        self.gatewayStartTaskGeneration = startGeneration
        self.gatewayStartTask = task
    }

    func waitForStartupAttempt() async {
        // Persistence/repair follows the complete attach-or-start decision. This prevents the
        // automatic ensure path from replacing a PID while startup is accepting that same PID.
        while let task = self.gatewayStartTask {
            await task.value
        }
    }

    func stop() {
        self.gatewayStartGeneration &+= 1
        let stopGeneration = self.gatewayStartGeneration
        self.desiredActive = false
        self.existingGatewayDetails = nil
        self.lastFailureReason = nil
        self.setLaunchAgentReadinessState(candidate: nil, failure: nil)
        self.launchAgentInstallGeneration = nil
        // Queued work belongs to the previous lifecycle. The active enable cannot be cancelled
        // safely, so the disable waits for its drain and wins unless a newer start supersedes it.
        self.launchAgentEnablePendingRequest = nil
        let enableTask = self.launchAgentEnableTask
        self.status = .stopped
        self.logger.info("gateway stop requested")
        let bundlePath = Bundle.main.bundleURL.path
        let priorDisableTask = self.launchAgentDisableTask
        let disableTask = Task { @MainActor in
            _ = await priorDisableTask?.value
            _ = await enableTask?.value
            if self.launchAgentDisableGeneration == stopGeneration {
                _ = await GatewayLaunchAgentManager.set(
                    enabled: false,
                    bundlePath: bundlePath,
                    port: GatewayEnvironment.gatewayPort())
            }
            if self.launchAgentDisableGeneration == stopGeneration {
                self.launchAgentDisableTask = nil
                self.launchAgentDisableGeneration = nil
            }
        }
        self.launchAgentDisableGeneration = stopGeneration
        self.launchAgentDisableTask = disableTask
    }

    func clearLastFailure() {
        self.lastFailureReason = nil
    }

    func refreshEnvironmentStatus(force: Bool = false) {
        let now = Date()
        if !force {
            if self.environmentRefreshTask != nil { return }
            if let last = self.lastEnvironmentRefresh,
               now.timeIntervalSince(last) < self.environmentRefreshMinInterval
            {
                return
            }
        }
        self.lastEnvironmentRefresh = now
        self.environmentRefreshTask = Task { [weak self] in
            let status = await Task.detached(priority: .utility) {
                GatewayEnvironment.check()
            }.value
            await MainActor.run {
                guard let self else { return }
                self.environmentStatus = status
                self.environmentRefreshTask = nil
            }
        }
    }

    func refreshLog() {
        guard self.logRefreshTask == nil else { return }
        let path = GatewayLaunchAgentManager.launchdGatewayLogPath()
        let limit = self.logLimit
        self.logRefreshTask = Task { [weak self] in
            let log = await Task.detached(priority: .utility) {
                Self.readGatewayLog(path: path, limit: limit)
            }.value
            await MainActor.run {
                guard let self else { return }
                if !log.isEmpty {
                    self.log = log
                }
                self.logRefreshTask = nil
            }
        }
    }

    // MARK: - Internals

    private func isCurrentGatewayStart(_ generation: UInt64?) -> Bool {
        guard let generation else { return true }
        return self.desiredActive && self.gatewayStartGeneration == generation
    }

    private func attachExistingGatewayAfterPendingDisable(
        port requestedPort: Int? = nil,
        startGeneration: UInt64) async -> Bool
    {
        // A gateway that is still reachable during uninstall is not reusable. Let the stop finish
        // before attachment so the new lifecycle cannot latch onto a process launchd then removes.
        await self.waitForPendingLaunchAgentDisable()
        guard self.isCurrentGatewayStart(startGeneration) else { return true }
        return await self.attachExistingGatewayIfAvailable(
            port: requestedPort,
            startGeneration: startGeneration)
    }

    /// Attempt to connect to an already-running gateway on the configured port.
    /// If successful, mark status as attached and skip spawning a new process.
    private func attachExistingGatewayIfAvailable(
        port requestedPort: Int? = nil,
        startGeneration: UInt64? = nil) async -> Bool
    {
        let port = requestedPort ?? GatewayEnvironment.gatewayPort()
        let instance = await PortGuardian.shared.describe(port: port)
        guard self.isCurrentGatewayStart(startGeneration) else { return true }
        let instanceText = instance.map { self.describe(instance: $0) }
        let hasListener = instance != nil

        let attemptAttach = {
            try await self.probeGatewayHealth(timeoutMs: 2000)
        }

        for attempt in 0..<(hasListener ? 3 : 1) {
            guard self.isCurrentGatewayStart(startGeneration) else { return true }
            do {
                let data = try await attemptAttach()
                guard self.isCurrentGatewayStart(startGeneration) else { return true }
                let attachedInstance = await PortGuardian.shared.describe(port: port)
                guard self.isCurrentGatewayStart(startGeneration) else { return true }
                let snap = decodeHealthSnapshot(from: data)
                let attachedInstanceText = attachedInstance.map { self.describe(instance: $0) }
                let details = self.describe(details: attachedInstanceText, port: port, snap: snap)
                let endpointPIDChanged = Self.gatewayPIDChanged(
                    from: self.lastObservedGatewayPID,
                    to: attachedInstance?.pid) || Self.gatewayPIDChanged(
                    from: instance?.pid,
                    to: attachedInstance?.pid)
                self.existingGatewayDetails = details
                self.setLaunchAgentReadinessState(candidate: nil, failure: nil)
                self.clearLastFailure()
                self.status = .attachedExisting(details: details)
                self.appendLog("[gateway] using existing instance: \(details)\n")
                self.logger.info("gateway using existing instance details=\(details)")
                self.refreshControlChannelIfNeeded(
                    reason: "attach existing",
                    force: endpointPIDChanged)
                self.lastObservedGatewayPID = attachedInstance?.pid ?? self.lastObservedGatewayPID
                self.refreshLog()
                return true
            } catch {
                guard self.isCurrentGatewayStart(startGeneration) else { return true }
                if attempt < 2, hasListener {
                    try? await Task.sleep(nanoseconds: 250_000_000)
                    continue
                }

                if hasListener {
                    let reason = self.describeAttachFailure(error, port: port, instance: instance)
                    self.existingGatewayDetails = instanceText
                    self.status = .failed(reason)
                    self.lastFailureReason = reason
                    self.appendLog("[gateway] existing listener on port \(port) but attach failed: \(reason)\n")
                    self.logger.warning("gateway attach failed reason=\(reason)")
                    return true
                }

                // No reachable gateway (and no listener) — fall through to spawn.
                self.existingGatewayDetails = nil
                return false
            }
        }

        self.existingGatewayDetails = nil
        return false
    }

    private func describe(details instance: String?, port: Int, snap: HealthSnapshot?) -> String {
        let instanceText = instance ?? "pid unknown"
        if let snap {
            let order = snap.channelOrder ?? Array(snap.channels.keys)
            let linkId = order.first(where: { snap.channels[$0]?.linked == true })
                ?? order.first(where: { snap.channels[$0]?.linked != nil })
            guard let linkId else {
                return "port \(port), health probe succeeded, \(instanceText)"
            }
            let linked = snap.channels[linkId]?.linked ?? false
            let authAge = snap.channels[linkId]?.authAgeMs.flatMap(msToAge) ?? "unknown age"
            let label =
                snap.channelLabels?[linkId] ??
                linkId.capitalized
            let linkText = linked ? "linked" : "not linked"
            return "port \(port), \(label) \(linkText), auth \(authAge), \(instanceText)"
        }
        return "port \(port), health probe succeeded, \(instanceText)"
    }

    private func describe(instance: PortGuardian.Descriptor) -> String {
        let path = instance.executablePath ?? "path unknown"
        return "pid \(instance.pid) \(instance.command) @ \(path)"
    }

    private func describeAttachFailure(_ error: Error, port: Int, instance: PortGuardian.Descriptor?) -> String {
        let ns = error as NSError
        let message = ns.localizedDescription.isEmpty ? "unknown error" : ns.localizedDescription
        let lower = message.lowercased()
        if self.isGatewayAuthFailure(error) {
            return """
            Gateway on port \(port) rejected auth. Set gateway.auth.token to match the running gateway \
            (or clear it on the gateway) and retry.
            """
        }
        if lower.contains("protocol mismatch") {
            return "Gateway on port \(port) is incompatible (protocol mismatch). Update the app/gateway."
        }
        if lower.contains("unexpected response") || lower.contains("invalid response") {
            return "Port \(port) returned non-gateway data; another process is using it."
        }
        if let instance {
            let instanceText = self.describe(instance: instance)
            return "Gateway listener found on port \(port) (\(instanceText)) but health check failed: \(message)"
        }
        return "Gateway listener found on port \(port) but health check failed: \(message)"
    }

    private func isGatewayAuthFailure(_ error: Error) -> Bool {
        if let urlError = error as? URLError, urlError.code == .dataNotAllowed {
            return true
        }
        let ns = error as NSError
        if ns.domain == "Gateway", ns.code == 1008 { return true }
        let lower = ns.localizedDescription.lowercased()
        return lower.contains("unauthorized") || lower.contains("auth")
    }
}

extension GatewayProcessManager {
    private func prepareLaunchdGatewayStart(startGeneration: UInt64) async -> LaunchAgentStartupContext? {
        guard self.isCurrentGatewayStart(startGeneration) else { return nil }
        self.existingGatewayDetails = nil
        let resolution = await Task.detached(priority: .utility) {
            GatewayEnvironment.resolveGatewayCommand()
        }.value
        guard self.isCurrentGatewayStart(startGeneration) else { return nil }
        await MainActor.run { self.environmentStatus = resolution.status }
        guard resolution.command != nil else {
            await MainActor.run {
                self.status = .failed(resolution.status.message)
            }
            self.logger.error("gateway command resolve failed: \(resolution.status.message)")
            return nil
        }

        if GatewayLaunchAgentManager.isLaunchAgentWriteDisabled() {
            let message = "Launchd disabled; start the Gateway manually or disable attach-only."
            self.status = .failed(message)
            self.lastFailureReason = "launchd disabled"
            self.appendLog("[gateway] launchd disabled; skipping auto-start\n")
            self.logger.info("gateway launchd enable skipped (disable marker set)")
            return nil
        }

        let bundlePath = Bundle.main.bundleURL.path
        let port = GatewayEnvironment.gatewayPort()
        self.logger.info("gateway ensuring launchd port=\(port)")
        let enableResult = await self.enableLaunchAgentIfNeeded(
            bundlePath: bundlePath,
            port: port,
            generation: startGeneration)
        guard self.isCurrentGatewayStart(startGeneration) else { return nil }
        if let err = enableResult.error {
            self.status = .failed(err)
            self.lastFailureReason = err
            self.logger.error("gateway launchd enable failed: \(err)")
            return nil
        }

        let readinessPID = await GatewayLaunchAgentManager.reusableLoadedGatewayPID(port: port)
        guard self.isCurrentGatewayStart(startGeneration) else { return nil }
        return LaunchAgentStartupContext(
            port: port,
            enableResult: enableResult,
            readinessPID: readinessPID,
            readinessRevision: self.launchAgentReadinessRevision)
    }

    private func enableLaunchdGateway(startGeneration: UInt64) async {
        guard let context = await self.prepareLaunchdGatewayStart(startGeneration: startGeneration) else {
            return
        }
        // Best-effort: wait for the gateway to accept connections.
        let deadline = Date().addingTimeInterval(6)
        var latestRetryDisposition: GatewayProbeFailureDisposition?
        while Date() < deadline {
            guard !Task.isCancelled else { return }
            guard self.isCurrentGatewayStart(startGeneration) else { return }
            do {
                let remainingMs = max(1, deadline.timeIntervalSinceNow * 1000)
                _ = try await self.probeGatewayHealth(timeoutMs: min(1500, remainingMs))
                guard !Task.isCancelled else { return }
                let instance = await PortGuardian.shared.describe(port: context.port)
                guard self.publishLaunchdGatewayReady(
                    instance: instance,
                    context: context,
                    startGeneration: startGeneration)
                else { return }
                return
            } catch {
                if Task.isCancelled || !self.isCurrentGatewayStart(startGeneration) {
                    return
                }
                switch self.probeFailureDisposition(error) {
                case .fail:
                    await self.finishResponsiveGatewayProbeFailure(
                        error,
                        port: context.port,
                        startGeneration: startGeneration,
                        expectedCandidate: self.launchAgentReadinessCandidate,
                        expectedReadinessRevision: context.readinessRevision)
                    return
                case .retryWithRepair:
                    latestRetryDisposition = .retryWithRepair
                case .retryWithoutRepair:
                    // A responsive transient invalidates older connection-failure evidence.
                    latestRetryDisposition = .retryWithoutRepair
                }
                let retryDelay = min(0.4, max(0, deadline.timeIntervalSinceNow))
                if retryDelay > 0 {
                    try? await Task.sleep(nanoseconds: UInt64(retryDelay * 1_000_000_000))
                }
            }
        }

        // Only a PID that survived this entire readiness cycle may be replaced later. launchd can
        // restart the service while polling; that replacement needs its own full startup chance.
        guard !Task.isCancelled else { return }
        if latestRetryDisposition == .retryWithRepair {
            await self.finishLaunchAgentReadinessFailure(
                port: context.port,
                startingPID: context.readinessPID,
                startGeneration: startGeneration,
                expectedReadinessRevision: context.readinessRevision)
        } else {
            self.finishGatewayReadinessDeadlineWithoutRepair(
                startGeneration: startGeneration,
                expectedReadinessRevision: context.readinessRevision)
        }
    }

    private func publishLaunchdGatewayReady(
        instance: PortGuardian.Descriptor?,
        context: LaunchAgentStartupContext,
        startGeneration: UInt64) -> Bool
    {
        guard !Task.isCancelled else { return false }
        guard self.isCurrentGatewayStart(startGeneration) else { return false }
        guard self.launchAgentReadinessRevision == context.readinessRevision else { return false }
        let details = instance.map { "pid \($0.pid)" }
        let endpointPIDChanged = if let readinessPID = context.readinessPID,
                                    let observedPID = instance?.pid
        {
            readinessPID != observedPID
        } else {
            false
        }
        let previouslyObservedPIDChanged = Self.gatewayPIDChanged(
            from: self.lastObservedGatewayPID,
            to: instance?.pid)
        let launchAgentReplaced = context.enableResult.installed ||
            self.launchAgentInstallGeneration == startGeneration ||
            endpointPIDChanged ||
            previouslyObservedPIDChanged
        self.setLaunchAgentReadinessState(candidate: nil, failure: nil)
        self.clearLastFailure()
        self.status = .running(details: details)
        self.logger.info("gateway started details=\(details ?? "ok")")
        self.refreshControlChannelIfNeeded(
            reason: "gateway started",
            force: launchAgentReplaced)
        self.lastObservedGatewayPID = instance?.pid ?? self.lastObservedGatewayPID
        if self.launchAgentInstallGeneration == startGeneration {
            self.launchAgentInstallGeneration = nil
        }
        self.refreshLog()
        return true
    }

    private func finishLaunchAgentReadinessFailure(
        port: Int,
        startingPID: Int32?,
        startGeneration: UInt64,
        expectedCandidate: LaunchAgentReadinessCandidate? = nil,
        candidateMustMatch: Bool = false,
        expectedReadinessRevision: UInt64? = nil) async
    {
        let failure = await self.resolveLaunchAgentReadinessFailure(
            port: port,
            startingPID: startingPID)
        guard !Task.isCancelled else { return }
        guard self.isCurrentGatewayStart(startGeneration) else { return }
        if let expectedReadinessRevision,
           self.launchAgentReadinessRevision != expectedReadinessRevision
        {
            return
        }
        if candidateMustMatch, self.launchAgentReadinessCandidate != expectedCandidate {
            return
        }
        self.setLaunchAgentReadinessState(candidate: nil, failure: failure)
        self.status = .failed("Gateway did not start in time")
        self.lastFailureReason = "launchd start timeout"
        self.logger.warning("gateway start timed out")
    }

    private func finishResponsiveGatewayProbeFailure(
        _ error: Error,
        port: Int,
        startGeneration: UInt64,
        expectedCandidate: LaunchAgentReadinessCandidate?,
        expectedReadinessRevision: UInt64) async
    {
        let instance = await PortGuardian.shared.describe(port: port)
        guard !Task.isCancelled else { return }
        guard self.isCurrentGatewayStart(startGeneration) else { return }
        guard self.launchAgentReadinessRevision == expectedReadinessRevision else { return }
        guard self.launchAgentReadinessCandidate == expectedCandidate else { return }
        let reason = self.describeAttachFailure(error, port: port, instance: instance)
        self.setLaunchAgentReadinessState(candidate: nil, failure: nil)
        self.status = .failed(reason)
        self.lastFailureReason = reason
        self.appendLog("[gateway] responsive health probe failed: \(reason)\n")
        self.logger.warning("gateway responsive health probe failed reason=\(reason)")
    }

    private func finishGatewayReadinessDeadlineWithoutRepair(
        startGeneration: UInt64,
        expectedReadinessRevision: UInt64)
    {
        guard self.isCurrentGatewayStart(startGeneration) else { return }
        guard self.launchAgentReadinessRevision == expectedReadinessRevision else { return }
        // Transient RPC/cancellation responses do not prove the endpoint is unreachable. End the
        // startup cleanly, but do not retain a PID that would authorize destructive repair.
        self.setLaunchAgentReadinessState(
            candidate: nil,
            failure: self.launchAgentReadinessFailure)
        self.status = .failed("Gateway did not become ready in time")
        self.lastFailureReason = "gateway readiness deadline elapsed"
        self.logger.warning("gateway readiness deadline elapsed without endpoint failure")
    }

    private func probeFailureDisposition(_ error: Error) -> GatewayProbeFailureDisposition {
        if self.probeFailureIsCancellation(error) { return .retryWithoutRepair }
        if let response = error as? GatewayResponseError,
           response.code.uppercased() == "UNAVAILABLE"
        {
            return .retryWithoutRepair
        }
        if error is GatewayHealthProbeTimeout { return .retryWithRepair }
        let nsError = error as NSError
        guard nsError.domain == NSURLErrorDomain else { return .fail }
        switch URLError.Code(rawValue: nsError.code) {
        case .timedOut,
             .cannotFindHost,
             .cannotConnectToHost,
             .networkConnectionLost,
             .dnsLookupFailed,
             .notConnectedToInternet,
             .resourceUnavailable:
            return .retryWithRepair
        default:
            return .fail
        }
    }

    private func probeFailureIsCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        let nsError = error as NSError
        return nsError.domain == NSURLErrorDomain &&
            nsError.code == URLError.cancelled.rawValue
    }

    private static func gatewayPIDChanged(from previousPID: Int32?, to observedPID: Int32?) -> Bool {
        guard let previousPID, let observedPID else { return false }
        return previousPID != observedPID
    }

    private func appendLog(_ chunk: String) {
        self.log.append(chunk)
        if self.log.count > self.logLimit {
            self.log = String(self.log.suffix(self.logLimit))
        }
    }

    private func refreshControlChannelIfNeeded(reason: String, force: Bool = false) {
        #if DEBUG
        self.testingControlChannelRefreshForces.append(force)
        if self.testingSkipControlChannelRefresh {
            return
        }
        #endif
        if !force {
            switch ControlChannel.shared.state {
            case .connected, .connecting:
                return
            case .disconnected, .degraded:
                break
            }
        }
        self.appendLog("[gateway] refreshing control channel (\(reason))\n")
        self.logger.debug("gateway control channel refresh reason=\(reason)")
        Task { await ControlChannel.shared.configure() }
    }

    func waitForGatewayReady(
        timeout: TimeInterval = 6,
        launchAgentInstalled: Bool = false) async -> Bool
    {
        let startGeneration = self.gatewayStartGeneration
        let readinessCandidate = self.launchAgentReadinessCandidate
        let readinessFailure = self.launchAgentReadinessFailure
        let readinessRevision = self.launchAgentReadinessRevision
        let readinessPort = readinessCandidate?.failure.port
            ?? GatewayEnvironment.gatewayPort()
        let deadline = Date().addingTimeInterval(timeout)
        let endpointPIDBeforeProbe = self.lastObservedGatewayPID
        var latestRetryDisposition: GatewayProbeFailureDisposition?
        while Date() < deadline {
            guard !Task.isCancelled else { return false }
            guard self.isCurrentGatewayStart(startGeneration) else { return false }
            do {
                let remainingMs = max(1, deadline.timeIntervalSinceNow * 1000)
                _ = try await self.probeGatewayHealth(timeoutMs: min(1500, remainingMs))
                guard !Task.isCancelled else { return false }
                let instance = await PortGuardian.shared.describe(port: readinessPort)
                return self.publishGatewayReadinessSuccess(
                    instance: instance,
                    startGeneration: startGeneration,
                    readinessCandidate: readinessCandidate,
                    readinessRevision: readinessRevision,
                    launchAgentInstalled: launchAgentInstalled,
                    endpointPIDBeforeProbe: endpointPIDBeforeProbe)
            } catch {
                if Task.isCancelled || !self.isCurrentGatewayStart(startGeneration) {
                    return false
                }
                switch self.probeFailureDisposition(error) {
                case .fail:
                    await self.finishResponsiveGatewayProbeFailure(
                        error,
                        port: readinessCandidate?.failure.port ?? GatewayEnvironment.gatewayPort(),
                        startGeneration: startGeneration,
                        expectedCandidate: readinessCandidate,
                        expectedReadinessRevision: readinessRevision)
                    return false
                case .retryWithRepair:
                    latestRetryDisposition = .retryWithRepair
                case .retryWithoutRepair:
                    // A responsive transient invalidates older connection-failure evidence.
                    latestRetryDisposition = .retryWithoutRepair
                }
                let retryDelay = min(0.3, max(0, deadline.timeIntervalSinceNow))
                if retryDelay > 0 {
                    try? await Task.sleep(nanoseconds: UInt64(retryDelay * 1_000_000_000))
                }
            }
        }
        await self.finishGatewayReadinessTimeout(
            startGeneration: startGeneration,
            readinessCandidate: readinessCandidate,
            readinessFailure: readinessFailure,
            readinessRevision: readinessRevision,
            latestRetryDisposition: latestRetryDisposition)
        return false
    }

    private func publishGatewayReadinessSuccess(
        instance: PortGuardian.Descriptor?,
        startGeneration: UInt64,
        readinessCandidate: LaunchAgentReadinessCandidate?,
        readinessRevision: UInt64,
        launchAgentInstalled: Bool,
        endpointPIDBeforeProbe: Int32?) -> Bool
    {
        guard !Task.isCancelled else { return false }
        guard self.desiredActive, self.gatewayStartGeneration == startGeneration else { return false }
        guard self.launchAgentReadinessRevision == readinessRevision else { return false }
        guard self.launchAgentReadinessCandidate == readinessCandidate else { return false }
        let details = instance.map { "pid \($0.pid)" }
        let launchAgentReplaced = launchAgentInstalled ||
            self.launchAgentInstallGeneration == startGeneration
        self.setLaunchAgentReadinessState(candidate: nil, failure: nil)
        self.clearLastFailure()
        if case .attachedExisting = self.status {
            self.status = launchAgentReplaced
                ? .running(details: details)
                : .attachedExisting(details: details)
        } else {
            self.status = .running(details: details)
        }
        let endpointPIDChanged = Self.gatewayPIDChanged(
            from: endpointPIDBeforeProbe,
            to: instance?.pid) || Self.gatewayPIDChanged(
            from: readinessCandidate?.failure.pid,
            to: instance?.pid)
        // A replaced process can leave the old socket briefly marked connected. Routine audits
        // retain the connected channel; only replacement evidence forces refresh.
        self.refreshControlChannelIfNeeded(
            reason: "gateway readiness recovered",
            force: launchAgentReplaced || endpointPIDChanged)
        self.lastObservedGatewayPID = instance?.pid ?? self.lastObservedGatewayPID
        if self.launchAgentInstallGeneration == startGeneration {
            self.launchAgentInstallGeneration = nil
        }
        self.refreshLog()
        return true
    }

    private func finishGatewayReadinessTimeout(
        startGeneration: UInt64,
        readinessCandidate: LaunchAgentReadinessCandidate?,
        readinessFailure: LaunchAgentReadinessFailure?,
        readinessRevision: UInt64,
        latestRetryDisposition: GatewayProbeFailureDisposition?) async
    {
        guard !Task.isCancelled else { return }
        guard self.isCurrentGatewayStart(startGeneration) else { return }
        guard self.launchAgentReadinessRevision == readinessRevision else { return }
        guard self.launchAgentReadinessCandidate == readinessCandidate else { return }
        self.appendLog("[gateway] readiness wait timed out\n")
        guard latestRetryDisposition == .retryWithRepair else {
            self.logger.warning("gateway readiness wait ended without endpoint failure evidence")
            return
        }
        if let readinessCandidate,
           readinessCandidate.generation == startGeneration
        {
            await self.finishLaunchAgentReadinessFailure(
                port: readinessCandidate.failure.port,
                startingPID: readinessCandidate.failure.pid,
                startGeneration: startGeneration,
                expectedCandidate: readinessCandidate,
                candidateMustMatch: true,
                expectedReadinessRevision: readinessRevision)
            return
        }

        self.setLaunchAgentReadinessState(candidate: nil, failure: readinessFailure)
        if case .failed = self.status {
            // Startup or persistence already published a concrete launchd/configuration error.
            // A follow-up reachability timeout must not replace that actionable diagnosis.
            self.logger.warning("gateway readiness wait timed out; preserving existing failure")
        } else {
            self.status = .failed("Gateway did not start in time")
            self.lastFailureReason = "gateway readiness timeout"
            self.logger.warning("gateway readiness wait timed out")
        }
    }

    private func probeGatewayHealth(timeoutMs: Double) async throws -> Data {
        let connection = self.connection
        // Startup owns recovery and its wall-clock deadline. A normal request can recursively
        // start the Gateway and spend several 30-second connect retries before its RPC timer begins.
        return try await AsyncTimeout.withTimeout(
            seconds: max(0.001, timeoutMs / 1000),
            onTimeout: { GatewayHealthProbeTimeout(timeoutMs: timeoutMs) },
            operation: {
                try await connection.request(
                    method: GatewayConnection.Method.health.rawValue,
                    params: nil,
                    timeoutMs: timeoutMs,
                    retryTransportFailures: false)
            })
    }

    func clearLog() {
        self.log = ""
        try? FileManager().removeItem(atPath: GatewayLaunchAgentManager.launchdGatewayLogPath())
        self.logger.debug("gateway log cleared")
    }

    func setProjectRoot(path: String) {
        CommandResolver.setProjectRoot(path)
    }

    func projectRootPath() -> String {
        CommandResolver.projectRootPath()
    }

    private nonisolated static func readGatewayLog(path: String, limit: Int) -> String {
        guard FileManager().fileExists(atPath: path) else { return "" }
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { return "" }
        let text = String(data: data, encoding: .utf8) ?? ""
        if text.count <= limit { return text }
        return String(text.suffix(limit))
    }
}

#if DEBUG
extension GatewayProcessManager {
    func setTestingConnection(_ connection: GatewayConnection?) {
        self.testingConnection = connection
    }

    func setTestingSkipControlChannelRefresh(_ skip: Bool) {
        self.testingSkipControlChannelRefresh = skip
    }

    func _testControlChannelRefreshForces() -> [Bool] {
        self.testingControlChannelRefreshForces
    }

    func _testClearControlChannelRefreshForces() {
        self.testingControlChannelRefreshForces.removeAll(keepingCapacity: true)
    }

    func _testClearLaunchAgentInstallEvidence() {
        self.launchAgentInstallGeneration = nil
    }

    func _testSetLastObservedGatewayPID(_ pid: Int32?) {
        self.lastObservedGatewayPID = pid
    }

    func _testProbeFailureMayNeedLaunchAgentRepair(_ code: URLError.Code) -> Bool {
        if case .retryWithRepair = self.probeFailureDisposition(URLError(code)) {
            return true
        }
        return false
    }

    func _testGatewayResponseRetriesWithoutRepair(_ code: String) -> Bool {
        let error = GatewayResponseError(
            method: "health",
            code: code,
            message: "test",
            details: nil)
        if case .retryWithoutRepair = self.probeFailureDisposition(error) {
            return true
        }
        return false
    }

    func setTestingDesiredActive(_ active: Bool) {
        self.desiredActive = active
    }

    func setTestingLastFailureReason(_ reason: String?) {
        self.lastFailureReason = reason
    }

    func setTestingStatus(_ status: Status) {
        self.status = status
    }

    func _testAttachExistingGatewayIfAvailable(port: Int) async -> Bool {
        await self.attachExistingGatewayIfAvailable(port: port)
    }

    func _testAttachExistingGatewayAfterPendingDisable(port: Int) async -> Bool {
        await self.attachExistingGatewayAfterPendingDisable(
            port: port,
            startGeneration: self.gatewayStartGeneration)
    }

    func _testEnableLaunchAgentIfNeeded(bundlePath: String, port: Int) async -> String? {
        await self.enableLaunchAgentIfNeeded(bundlePath: bundlePath, port: port).error
    }

    func _testEnableLaunchAgentIfNeededInstalled(bundlePath: String, port: Int) async -> Bool {
        await self.enableLaunchAgentIfNeeded(bundlePath: bundlePath, port: port).installed
    }

    func _testRecordLaunchAgentReadinessFailure(port: Int, startingPID: Int32?) async {
        let failure = await self.resolveLaunchAgentReadinessFailure(
            port: port,
            startingPID: startingPID)
        self.setLaunchAgentReadinessState(
            candidate: self.launchAgentReadinessCandidate,
            failure: failure)
    }

    func _testFinishLaunchAgentReadinessFailure(port: Int, startingPID: Int32?) async {
        let startGeneration = self.gatewayStartGeneration
        await self.finishLaunchAgentReadinessFailure(
            port: port,
            startingPID: startingPID,
            startGeneration: startGeneration)
    }

    func _testClearLaunchAgentReadinessFailure() {
        self.setLaunchAgentReadinessState(candidate: nil, failure: nil)
    }

    func _testSetLaunchAgentReadinessFailure(port: Int, pid: Int32) {
        self.setLaunchAgentReadinessState(
            candidate: self.launchAgentReadinessCandidate,
            failure: LaunchAgentReadinessFailure(port: port, pid: pid))
    }

    func _testSetLaunchAgentReadinessCandidate(port: Int, pid: Int32) {
        self.setLaunchAgentReadinessState(
            candidate: LaunchAgentReadinessCandidate(
                failure: LaunchAgentReadinessFailure(port: port, pid: pid),
                generation: self.gatewayStartGeneration),
            failure: self.launchAgentReadinessFailure)
    }

    func _testHasLaunchAgentReadinessFailure() -> Bool {
        self.launchAgentReadinessFailure != nil
    }

    func _testHasLaunchAgentReadinessCandidate() -> Bool {
        self.launchAgentReadinessCandidate != nil
    }

    func _testLaunchAgentReadinessCandidatePID() -> Int32? {
        self.launchAgentReadinessCandidate?.failure.pid
    }

    func _testBeginGatewayStartGeneration() {
        self.desiredActive = true
        self.gatewayStartGeneration &+= 1
    }

    func _testPendingLaunchAgentPort() -> Int? {
        self.launchAgentEnablePendingRequest?.port
    }
}
#endif
