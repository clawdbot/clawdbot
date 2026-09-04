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

    private struct GatewayReadinessContext {
        let purpose: GatewayReadinessPurpose
        let port: Int
        let generation: UInt64
        let readinessPID: Int32?
        let readinessRevision: UInt64
        let readinessCandidate: LaunchAgentReadinessCandidate?
        let readinessFailure: LaunchAgentReadinessFailure?
        let endpointPIDBeforeProbe: Int32?
        let launchAgentInstalled: Bool
    }

    private enum GatewayReadinessPurpose {
        case attach
        case launchd
        case audit
    }

    private enum GatewayProbeFailureDisposition: Equatable {
        case retryWithoutRepair
        case retryWithRepair
        case fail
    }

    private enum GatewayReadinessDeadlinePolicy {
        case migration(window: TimeInterval, tolerance: TimeInterval)
        case fixed(timeout: TimeInterval)
    }

    private enum GatewayReadinessFailure {
        case attachProbe(String)
        case responsiveProbe(String)
        case timeoutWithRepairEvidence(LaunchAgentReadinessFailure)
        case deadlineWithoutRepairEvidence

        var reason: String {
            switch self {
            case let .attachProbe(reason), let .responsiveProbe(reason): reason
            case .timeoutWithRepairEvidence: "Gateway did not start in time"
            case .deadlineWithoutRepairEvidence: "Gateway did not become ready in time"
            }
        }
    }

    private enum GatewayReadinessTerminal {
        case ready(
            instance: PortGuardian.Descriptor?,
            startingPID: Int32?,
            snapshot: HealthSnapshot?)
        case superseded
        case failed(GatewayReadinessFailure)
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

    /// Pause removes managed service records without changing installation responsibility.
    /// Remember the established owner, not just that this port once answered.
    private var gatewayOwnership: (port: Int, installation: Installation)?

    private(set) var log: String = ""
    private(set) var environmentStatus: GatewayEnvironmentStatus = .checking
    private(set) var existingGatewayDetails: String?
    private(set) var lastFailureReason: String?

    enum Installation {
        case managed, external, unreadable

        static let ownershipFailure =
            "Could not read the Gateway service ownership record. Check the Gateway LaunchAgent and retry."
    }

    var installation: Installation {
        self.installation(for: GatewayEnvironment.gatewayPort(), whenMissing: .managed)
    }

    private func installation(for port: Int, whenMissing: Installation) -> Installation {
        if GatewayLaunchAgentManager.isLaunchAgentWriteDisabled() { return .external }
        guard let arguments = GatewayLaunchAgentManager.launchdProgramArguments() else { return .unreadable }
        if !arguments.isEmpty {
            return CLIInstallPrompter.launchAgentUsesManagedCLI(programArguments: arguments) ? .managed : .external
        }
        if let gatewayOwnership, gatewayOwnership.port == port { return gatewayOwnership.installation }
        return whenMissing
    }

    private var desiredActive = false
    private var environmentRefreshTask: Task<Void, Never>?
    private var lastEnvironmentRefresh: Date?
    private var logRefreshTask: Task<Void, Never>?
    private var launchAgentEnableTask: Task<[UInt64: LaunchAgentEnableResult], Never>?
    private var launchAgentEnableCurrentRequest: LaunchAgentEnableRequest?
    private var launchAgentEnablePendingRequest: LaunchAgentEnableRequest?
    private var launchAgentEnableNextInvocationID: UInt64 = 0
    private var launchAgentDisableTask: Task<Void, Never>?
    private var launchAgentDisableGeneration: UInt64?
    private var launchAgentReadinessFailure: LaunchAgentReadinessFailure?
    private var launchAgentReadinessCandidate: LaunchAgentReadinessCandidate?
    private var launchAgentReadinessRevision: UInt64 = 0
    private var launchAgentInstallGeneration: UInt64?
    private var launchAgentFreshInstallGeneration: UInt64?
    private var profilePortConflict: String?
    private var lastObservedGatewayPID: Int32?
    /// Async readiness audits may outlive stop/restart. Only the current generation may publish
    /// their failure state or retain a PID for a later repair.
    private var gatewayStartGeneration: UInt64 = 0
    private var gatewayStartTask: Task<Void, Never>?
    private var gatewayStartTaskGeneration: UInt64?
    #if DEBUG
    private var testingConnection: GatewayConnection?
    private var testingLaunchAgentDisableWaitHook: (() -> Void)?
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
        // Remote mode should never manage a local Gateway; treat as stopped.
        if CommandResolver.connectionModeIsRemote() {
            self.desiredActive = false
            self.stop()
            self.status = .stopped
            self.appendLog("[gateway] remote mode active; skipping local gateway\n")
            self.logger.info("gateway process skipped: remote mode active")
            return
        }
        if active, self.profilePortConflict != nil {
            self.profilePortConflict = nil
            Task { await GatewayEndpointStore.shared.setLocalUnavailableReason(nil) }
        }
        if active, let conflict = GatewayEnvironment.profileGatewayPortConflict() {
            self.desiredActive = false
            self.recordProfilePortConflict(conflict)
            Task { await GatewayEndpointStore.shared.setLocalUnavailableReason(conflict) }
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
        guard self.profilePortConflict == nil else { return false }
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
                self.launchAgentEnablePendingRequest = nil
            } else if var pending = self.launchAgentEnablePendingRequest,
                      pending.hasSameConfiguration(as: request)
            {
                pending.invocationIDs.append(invocationID)
                self.launchAgentEnablePendingRequest = pending
            } else {
                self.launchAgentEnablePendingRequest = request
            }
            let results = await task.value
            return results[invocationID] ?? .skipped
        }

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
            #if DEBUG
            self.testingLaunchAgentDisableWaitHook?()
            #endif
            await disableTask.value
        }
    }

    private func drainLaunchAgentEnableRequests()
        async -> [UInt64: LaunchAgentEnableResult]
    {
        var results: [UInt64: LaunchAgentEnableResult] = [:]
        while let request = self.launchAgentEnablePendingRequest {
            self.launchAgentEnablePendingRequest = nil
            self.launchAgentEnableCurrentRequest = request
            let result = await self.performLaunchAgentEnable(request)
            let completedRequest = self.launchAgentEnableCurrentRequest ?? request
            for invocationID in completedRequest.invocationIDs {
                results[invocationID] = result
            }
            self.launchAgentEnableCurrentRequest = nil
        }
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

        var isReadinessRepair = false
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

            isReadinessRepair = true
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
        self.launchAgentFreshInstallGeneration = isReadinessRepair ? nil : request.generation
        return .installed()
    }

    private func resolveLaunchAgentReadinessFailure(
        port: Int,
        startingPID: Int32?) async -> LaunchAgentReadinessFailure?
    {
        guard let startingPID,
              let pid = await self.reusableLaunchdPIDOwningPort(port: port),
              pid == startingPID
        else {
            return nil
        }
        return LaunchAgentReadinessFailure(port: port, pid: pid)
    }

    private func reusableLaunchdPIDOwningPort(port: Int) async -> Int32? {
        guard let pid = await GatewayLaunchAgentManager.reusableLoadedGatewayPID(port: port) else {
            return nil
        }
        // A stable launchd PID that owns the port can still have a wedged health RPC. A listener
        // owned by anyone else is protected and surfaced through the attach path instead.
        if let listener = await PortGuardian.shared.describe(port: port), listener.pid != pid {
            return nil
        }
        return pid
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
        // Do not start a local Gateway in remote mode; the remote host owns it.
        guard !CommandResolver.connectionModeIsRemote() else {
            self.status = .stopped
            return
        }
        guard OpenClawConfigFile.migrateRetiredAppMetadataForGatewayStart() else {
            let message =
                "Could not repair retired macOS config metadata. Run `openclaw doctor --fix`, then retry."
            self.status = .failed(message)
            self.lastFailureReason = message
            self.appendLog("[gateway] \(message)\n")
            self.logger.error("gateway config metadata migration failed")
            return
        }
        // Many surfaces can call `setActive(true)` in quick succession (startup, Canvas, health checks).
        // Avoid concurrent startup tasks that can thrash launchd and flap the port.
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

        // First try to attach to an already-running Gateway before enabling launchd.
        self.beginGatewayStartTask(generation: startGeneration) { [weak self] in
            guard let self else { return }
            if await self.attachExistingGatewayAfterPendingDisable(startGeneration: startGeneration) {
                return
            }
            await self.enableLaunchdGateway(startGeneration: startGeneration)
        }
    }

    private func beginGatewayStartTask(
        generation: UInt64,
        operation: @escaping @MainActor @Sendable () async -> Void)
    {
        self.gatewayStartTaskGeneration = generation
        self.gatewayStartTask = Task { @MainActor [weak self] in
            guard let self else { return }
            defer {
                if self.gatewayStartTaskGeneration == generation {
                    self.gatewayStartTask = nil
                    self.gatewayStartTaskGeneration = nil
                }
            }
            await operation()
        }
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
        self.launchAgentFreshInstallGeneration = nil
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
            let status = await GatewayEnvironment.check()
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

    private func isCurrentGatewayStart(_ generation: UInt64) -> Bool {
        self.desiredActive && self.gatewayStartGeneration == generation
    }

    private func isCurrentGatewayReadiness(_ context: GatewayReadinessContext) -> Bool {
        !Task.isCancelled &&
            self.isCurrentGatewayStart(context.generation) &&
            self.launchAgentReadinessRevision == context.readinessRevision &&
            self.launchAgentReadinessCandidate == context.readinessCandidate
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
    /// If successful, mark status as attached and skip launchd startup.
    private func attachExistingGatewayIfAvailable(
        port requestedPort: Int? = nil,
        startGeneration: UInt64) async -> Bool
    {
        let port = requestedPort ?? GatewayEnvironment.gatewayPort()
        let instance = await PortGuardian.shared.describe(port: port)
        guard self.isCurrentGatewayStart(startGeneration) else { return true }
        let hasListener = instance != nil
        if hasListener,
           await !(self.profileOwnsGateway(
               instance,
               port: port,
               startGeneration: startGeneration))
        {
            return true
        }

        let context = self.gatewayReadinessContext(
            purpose: .attach,
            port: port,
            generation: startGeneration,
            readinessPID: instance?.pid)
        let terminal = await self.observeGatewayReadiness(
            context: context,
            deadlinePolicy: .fixed(timeout: hasListener ? 6.5 : 2))
        if !hasListener, case .failed = terminal {
            guard self.isCurrentGatewayReadiness(context) else { return true }
            self.existingGatewayDetails = nil
            self.gatewayOwnership = nil
            return false
        }
        let published = await self.publishGatewayReadinessTerminal(terminal, context: context)
        return hasListener || published || !self.isCurrentGatewayStart(startGeneration)
    }

    nonisolated static func profileAllowsExistingGatewayAttachment(
        profile: AppProfile,
        listenerPID: Int32?,
        managedServicePID: Int32?) -> Bool
    {
        guard profile.isActive else { return true }
        guard let listenerPID, let managedServicePID else { return false }
        return listenerPID == managedServicePID
    }

    private func profileOwnsGateway(
        _ instance: PortGuardian.Descriptor?,
        port: Int,
        startGeneration: UInt64) async -> Bool
    {
        guard AppProfile.current.isActive else { return true }
        let managedPID = await GatewayLaunchAgentManager.runningGatewayPID()
        guard self.isCurrentGatewayStart(startGeneration) else { return false }
        guard Self.profileAllowsExistingGatewayAttachment(
            profile: .current,
            listenerPID: instance?.pid,
            managedServicePID: managedPID)
        else {
            await self.failProfilePortOwnership(
                port: port,
                startGeneration: startGeneration)
            return false
        }
        return true
    }

    private func failProfilePortOwnership(port: Int, startGeneration: UInt64) async {
        guard self.isCurrentGatewayStart(startGeneration) else { return }
        let message = "Gateway port \(port) is already owned by another process or OpenClaw profile. " +
            "Set gateway.port to a free port for profile \(AppProfile.current.name ?? "named")."
        self.recordProfilePortConflict(message)
        await GatewayEndpointStore.shared.setLocalUnavailableReason(message)
    }

    private func recordProfilePortConflict(_ message: String) {
        self.profilePortConflict = message
        self.status = .failed(message)
        self.lastFailureReason = message
        self.appendLog("[gateway] \(message)\n")
        self.logger.error("\(message, privacy: .public)")
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
        if let issue = GatewayCompatibilityIssue(error: error) {
            return issue.message
        }
        let ns = error as NSError
        let message = ns.localizedDescription.isEmpty ? "unknown error" : ns.localizedDescription
        let lower = message.lowercased()
        if self.isGatewayAuthFailure(error) {
            return """
            Gateway on port \(port) rejected auth. Set gateway.auth.token to match the running gateway \
            (or clear it on the gateway) and retry.
            """
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
    private func gatewayReadinessContext(
        purpose: GatewayReadinessPurpose,
        port: Int,
        generation: UInt64,
        readinessPID: Int32? = nil,
        launchAgentInstalled: Bool = false) -> GatewayReadinessContext
    {
        GatewayReadinessContext(
            purpose: purpose,
            port: port,
            generation: generation,
            readinessPID: readinessPID,
            readinessRevision: self.launchAgentReadinessRevision,
            readinessCandidate: self.launchAgentReadinessCandidate,
            readinessFailure: self.launchAgentReadinessFailure,
            endpointPIDBeforeProbe: self.lastObservedGatewayPID,
            launchAgentInstalled: launchAgentInstalled)
    }

    private func prepareLaunchdGatewayStart(startGeneration: UInt64) async -> GatewayReadinessContext? {
        guard self.isCurrentGatewayStart(startGeneration) else { return nil }
        self.existingGatewayDetails = nil
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
        return self.gatewayReadinessContext(
            purpose: .launchd,
            port: port,
            generation: startGeneration,
            readinessPID: readinessPID,
            launchAgentInstalled: enableResult.installed)
    }

    private func enableLaunchdGateway(startGeneration: UInt64) async {
        guard let context = await self.prepareLaunchdGatewayStart(startGeneration: startGeneration) else {
            return
        }
        await self.observeLaunchdGatewayReadiness(context: context)
    }

    private func observeLaunchdGatewayReadiness(
        context: GatewayReadinessContext,
        readinessWindow: TimeInterval = 6,
        // Fresh installs keep probing through the same first-run migration budget as the CLI.
        firstInstallReadinessBudget: TimeInterval = GatewayLaunchAgentManager.startupMigrationTolerance) async
    {
        let terminal = await self.observeGatewayReadiness(
            context: context,
            deadlinePolicy: .migration(
                window: readinessWindow,
                tolerance: firstInstallReadinessBudget))
        _ = await self.publishGatewayReadinessTerminal(terminal, context: context)
    }

    private func observeGatewayReadiness(
        context: GatewayReadinessContext,
        deadlinePolicy: GatewayReadinessDeadlinePolicy) async -> GatewayReadinessTerminal
    {
        let startedAt = Date()
        let initialWindow: TimeInterval
        let finalProbeDeadline: Date
        switch deadlinePolicy {
        case let .migration(window, tolerance):
            initialWindow = window
            finalProbeDeadline = startedAt.addingTimeInterval(max(window, tolerance))
        case let .fixed(timeout):
            initialWindow = timeout
            finalProbeDeadline = startedAt.addingTimeInterval(timeout)
        }
        var deadline = startedAt.addingTimeInterval(initialWindow)
        var latestRetryDisposition: GatewayProbeFailureDisposition?
        var readinessPID = context.readinessPID
        var freshInstallGraceAuthorized = false
        var responsiveStartupProgressObserved = false
        var latestProbeError: Error?
        readinessLoop: while true {
            guard self.isCurrentGatewayReadiness(context) else { return .superseded }
            while Date() >= deadline {
                guard deadline < finalProbeDeadline else { break readinessLoop }
                guard case .migration = deadlinePolicy else { break readinessLoop }
                let extensionAuthorization = await self.authorizeReadinessExtension(
                    context: context,
                    responsiveStartupProgressObserved: responsiveStartupProgressObserved,
                    freshInstallGraceAuthorized: freshInstallGraceAuthorized,
                    readinessPID: readinessPID)
                guard self.isCurrentGatewayReadiness(context) else { return .superseded }
                guard extensionAuthorization.allowed else { break readinessLoop }
                readinessPID = extensionAuthorization.readinessPID
                freshInstallGraceAuthorized = true
                deadline = min(
                    deadline.addingTimeInterval(initialWindow),
                    finalProbeDeadline)
                guard Date() < finalProbeDeadline else { break readinessLoop }
            }
            do {
                let remainingMs = max(1, deadline.timeIntervalSinceNow * 1000)
                let data = try await self.probeGatewayHealth(timeoutMs: min(1500, remainingMs))
                guard self.isCurrentGatewayReadiness(context) else { return .superseded }
                let instance = await PortGuardian.shared.describe(port: context.port)
                guard self.isCurrentGatewayReadiness(context) else { return .superseded }
                return .ready(
                    instance: instance,
                    startingPID: readinessPID,
                    snapshot: decodeHealthSnapshot(from: data))
            } catch {
                guard self.isCurrentGatewayReadiness(context) else { return .superseded }
                latestProbeError = error
                switch self.probeFailureDisposition(error) {
                case .fail:
                    return await self.gatewayProbeFailureTerminal(error, context: context)
                case .retryWithRepair:
                    latestRetryDisposition = .retryWithRepair
                case .retryWithoutRepair:
                    // A responsive transient invalidates older connection-failure evidence.
                    latestRetryDisposition = .retryWithoutRepair
                    if self.probeFailureShowsStartupProgress(error) {
                        responsiveStartupProgressObserved = true
                    }
                }
                let retryDelay = min(0.3, max(0, deadline.timeIntervalSinceNow))
                if retryDelay > 0 {
                    try? await Task.sleep(nanoseconds: UInt64(retryDelay * 1_000_000_000))
                }
            }
        }

        return await self.gatewayReadinessTimeout(
            context: context,
            policy: deadlinePolicy,
            latestDisposition: latestRetryDisposition,
            latestError: latestProbeError,
            readinessPID: readinessPID)
    }

    private func gatewayReadinessTimeout(
        context: GatewayReadinessContext,
        policy: GatewayReadinessDeadlinePolicy,
        latestDisposition: GatewayProbeFailureDisposition?,
        latestError: Error?,
        readinessPID: Int32?) async -> GatewayReadinessTerminal
    {
        guard self.isCurrentGatewayReadiness(context) else { return .superseded }
        if case .attach = context.purpose, let latestError {
            return await self.gatewayProbeFailureTerminal(latestError, context: context)
        }
        let migration = if case .migration = policy {
            true
        } else {
            false
        }
        guard latestDisposition == .retryWithRepair else {
            return migration ? .failed(.deadlineWithoutRepairEvidence) : .superseded
        }
        let failure: LaunchAgentReadinessFailure? = if migration || context.readinessCandidate != nil {
            await self.resolveLaunchAgentReadinessFailure(
                port: context.port,
                startingPID: readinessPID)
        } else {
            context.readinessFailure
        }
        guard self.isCurrentGatewayReadiness(context) else { return .superseded }
        guard let failure else {
            return migration ? .failed(.deadlineWithoutRepairEvidence) : .superseded
        }
        return .failed(.timeoutWithRepairEvidence(failure))
    }

    private func gatewayProbeFailureTerminal(
        _ error: Error,
        context: GatewayReadinessContext) async -> GatewayReadinessTerminal
    {
        let instance = await PortGuardian.shared.describe(port: context.port)
        guard self.isCurrentGatewayReadiness(context) else { return .superseded }
        let reason = self.describeAttachFailure(error, port: context.port, instance: instance)
        if case .attach = context.purpose { return .failed(.attachProbe(reason)) }
        return .failed(.responsiveProbe(reason))
    }

    private func authorizeReadinessExtension(
        context: GatewayReadinessContext,
        responsiveStartupProgressObserved: Bool,
        freshInstallGraceAuthorized: Bool,
        readinessPID: Int32?) async -> (allowed: Bool, readinessPID: Int32?)
    {
        if responsiveStartupProgressObserved || freshInstallGraceAuthorized {
            // One live response or verified launchd owner authorizes the bounded migration window;
            // repeating launchd status at every boundary would expand the wall-clock budget.
            return (self.isCurrentGatewayReadiness(context), readinessPID)
        }
        guard self.launchAgentFreshInstallGeneration == context.generation,
              self.isCurrentGatewayReadiness(context)
        else { return (false, nil) }
        guard let reusablePID = await self.reusableLaunchdPIDOwningPort(port: context.port) else {
            return (false, nil)
        }
        let allowed = self.launchAgentFreshInstallGeneration == context.generation &&
            self.isCurrentGatewayReadiness(context)
        return (allowed, allowed ? reusablePID : nil)
    }

    private func probeFailureDisposition(_ error: Error) -> GatewayProbeFailureDisposition {
        if self.probeFailureIsCancellation(error) { return .retryWithoutRepair }
        if self.probeFailureShowsStartupProgress(error) { return .retryWithoutRepair }
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

    private func probeFailureShowsStartupProgress(_ error: Error) -> Bool {
        guard let response = error as? GatewayResponseError else { return false }
        return response.code.uppercased() == "UNAVAILABLE"
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
        if await self.observeCurrentGatewayStart(generation: startGeneration) == true { return true }
        guard !Task.isCancelled, self.isCurrentGatewayStart(startGeneration) else { return false }
        // Only a real launch candidate/install can recover after its owner reports failure.
        if case .failed = self.status,
           !launchAgentInstalled,
           self.launchAgentReadinessCandidate == nil,
           self.launchAgentReadinessFailure == nil,
           self.launchAgentInstallGeneration != startGeneration
        {
            return false
        }
        let readinessPort = self.launchAgentReadinessCandidate?.failure.port
            ?? GatewayEnvironment.gatewayPort()
        let context = self.gatewayReadinessContext(
            purpose: .audit,
            port: readinessPort,
            generation: startGeneration,
            readinessPID: self.launchAgentReadinessCandidate?.failure.pid,
            launchAgentInstalled: launchAgentInstalled)
        let terminal = await self.observeGatewayReadiness(
            context: context,
            deadlinePolicy: .fixed(timeout: timeout))
        return await self.publishGatewayReadinessTerminal(terminal, context: context)
    }

    private func observeCurrentGatewayStart(generation: UInt64) async -> Bool? {
        guard self.gatewayStartTaskGeneration == generation else { return nil }
        while self.gatewayStartTaskGeneration == generation {
            // Cancellation interrupts the sleep, so a waiter can leave without touching the owner.
            try? await Task.sleep(nanoseconds: 100_000_000)
            guard !Task.isCancelled, self.isCurrentGatewayStart(generation) else { return false }
        }
        guard !Task.isCancelled, self.isCurrentGatewayStart(generation) else { return false }
        return switch self.status {
        case .running, .attachedExisting: true
        case .stopped, .starting, .failed: false
        }
    }

    private func publishGatewayReadinessTerminal(
        _ terminal: GatewayReadinessTerminal,
        context: GatewayReadinessContext) async -> Bool
    {
        // Fixed audits without fresh endpoint evidence return `.superseded`, so a terminal failure
        // from this generation is replaced only by a later result carrying endpoint evidence.
        switch terminal {
        case let .ready(instance, startingPID, snapshot):
            guard await self.canPublishGatewayReadiness(instance: instance, context: context) else {
                return false
            }
            let installed = context.launchAgentInstalled || self.launchAgentInstallGeneration == context.generation
            let replaced = installed ||
                Self.gatewayPIDChanged(from: context.endpointPIDBeforeProbe, to: instance?.pid) ||
                Self.gatewayPIDChanged(from: startingPID, to: instance?.pid)
            let details: String?
            let refreshReason: String
            switch context.purpose {
            case .attach:
                details = self.describe(
                    details: instance.map { self.describe(instance: $0) },
                    port: context.port,
                    snap: snapshot)
                refreshReason = "attach existing"
            case .launchd, .audit:
                details = instance.map { "pid \($0.pid)" }
                refreshReason = "gateway readiness recovered"
            }
            self.setLaunchAgentReadinessState(candidate: nil, failure: nil)
            self.clearLastFailure()
            // Only installation evidence replaces a remembered owner. A readiness path
            // may reuse an independent listener, so its purpose does not establish ownership.
            if installed {
                self.gatewayOwnership = nil
            }
            self.gatewayOwnership = (
                context.port,
                self.installation(
                    for: context.port, whenMissing: installed ? .managed : .external))
            if case .attach = context.purpose {
                self.existingGatewayDetails = details
                self.status = .attachedExisting(details: details)
                self.appendLog("[gateway] using existing instance: \(details ?? "unknown")\n")
            } else if case .attachedExisting = self.status, !replaced {
                self.status = .attachedExisting(details: details)
            } else {
                self.status = .running(details: details)
            }
            // A replaced process can leave the old socket briefly marked connected. Routine audits
            // retain the connected channel; only replacement evidence forces refresh.
            self.refreshControlChannelIfNeeded(reason: refreshReason, force: replaced)
            self.lastObservedGatewayPID = instance?.pid ?? self.lastObservedGatewayPID
            if self.launchAgentInstallGeneration == context.generation {
                self.launchAgentInstallGeneration = nil
            }
            if self.launchAgentFreshInstallGeneration == context.generation {
                self.launchAgentFreshInstallGeneration = nil
            }
            self.refreshLog()
            return true

        case let .failed(terminalFailure):
            let instance = await PortGuardian.shared.describe(port: context.port)
            guard await self.canPublishGatewayReadiness(instance: instance, context: context) else {
                return false
            }
            let retainedFailure: LaunchAgentReadinessFailure? = switch terminalFailure {
            case let .timeoutWithRepairEvidence(failure): failure
            case .attachProbe, .responsiveProbe, .deadlineWithoutRepairEvidence: nil
            }
            self.setLaunchAgentReadinessState(candidate: nil, failure: retainedFailure)
            self.status = .failed(terminalFailure.reason)
            switch terminalFailure {
            case .attachProbe:
                self.lastFailureReason = terminalFailure.reason
                self.appendLog("[gateway] existing listener attach failed: \(terminalFailure.reason)\n")
            case .responsiveProbe:
                self.lastFailureReason = terminalFailure.reason
                self.appendLog("[gateway] responsive health probe failed: \(terminalFailure.reason)\n")
            case .timeoutWithRepairEvidence:
                self.lastFailureReason = if case .launchd = context.purpose {
                    "launchd start timeout"
                } else {
                    "gateway readiness timeout"
                }
            case .deadlineWithoutRepairEvidence:
                // Transient responsive/cancellation outcomes never retain a PID for repair.
                self.lastFailureReason = "gateway readiness deadline elapsed"
            }
            self.logger.warning("gateway readiness failed reason=\(terminalFailure.reason)")
            return false

        case .superseded:
            return false
        }
    }

    private func canPublishGatewayReadiness(
        instance: PortGuardian.Descriptor?,
        context: GatewayReadinessContext) async -> Bool
    {
        guard self.isCurrentGatewayReadiness(context) else { return false }
        guard await self.profileOwnsGateway(
            instance,
            port: context.port,
            startGeneration: context.generation)
        else { return false }
        return self.isCurrentGatewayReadiness(context)
    }

    private func probeGatewayHealth(timeoutMs: Double) async throws -> Data {
        let connection = self.connection
        // Startup owns recovery and its wall-clock deadline. A normal request can recursively
        // start the Gateway and spend several 30-second connect retries before its RPC timer begins.
        // Disable the inner RPC timer so it cannot race the owner's typed probe timeout.
        return try await AsyncTimeout.withTimeout(
            seconds: max(0.001, timeoutMs / 1000),
            onTimeout: { GatewayHealthProbeTimeout(timeoutMs: timeoutMs) },
            operation: {
                try await connection.request(
                    method: GatewayConnection.Method.health.rawValue,
                    params: nil,
                    timeoutMs: 0,
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
    func _testSetLaunchAgentDisableWaitHook(_ hook: (() -> Void)?) {
        self.testingLaunchAgentDisableWaitHook = hook
    }

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
        self.launchAgentFreshInstallGeneration = nil
    }

    func _testHasLaunchAgentFreshInstallEvidence() -> Bool {
        self.launchAgentFreshInstallGeneration != nil
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
        self.gatewayOwnership = nil
        switch status {
        case .running, .attachedExisting:
            let port = GatewayEnvironment.gatewayPort()
            let whenMissing: Installation = if case .attachedExisting = status {
                .external
            } else {
                .managed
            }
            self.gatewayOwnership = (
                port, self.installation(for: port, whenMissing: whenMissing))
        case .stopped, .starting, .failed:
            break
        }
        self.status = status
    }

    func _testAttachExistingGatewayIfAvailable(port: Int) async -> Bool {
        self.desiredActive = true
        return await self.attachExistingGatewayIfAvailable(
            port: port,
            startGeneration: self.gatewayStartGeneration)
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
        let context = self.gatewayReadinessContext(
            purpose: .launchd,
            port: port,
            generation: self.gatewayStartGeneration,
            readinessPID: startingPID)
        let failure = await self.resolveLaunchAgentReadinessFailure(
            port: port,
            startingPID: startingPID)
        let terminalFailure: GatewayReadinessFailure = if let failure {
            .timeoutWithRepairEvidence(failure)
        } else {
            .deadlineWithoutRepairEvidence
        }
        _ = await self.publishGatewayReadinessTerminal(
            .failed(terminalFailure),
            context: context)
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

    func _testResetGatewayStartTask() {
        self.desiredActive = false
        self.gatewayStartGeneration &+= 1
        self.gatewayStartTask?.cancel()
        self.gatewayStartTask = nil
        self.gatewayStartTaskGeneration = nil
    }

    func _testStartLaunchdGatewayReadiness(
        port: Int,
        pid: Int32,
        readinessWindow: TimeInterval,
        firstInstallReadinessBudget: TimeInterval)
    {
        self.desiredActive = true
        self.status = .starting
        self.gatewayStartGeneration &+= 1
        let generation = self.gatewayStartGeneration
        self.launchAgentInstallGeneration = generation
        self.launchAgentFreshInstallGeneration = generation
        let context = self.gatewayReadinessContext(
            purpose: .launchd,
            port: port,
            generation: generation,
            readinessPID: pid,
            launchAgentInstalled: true)
        self.beginGatewayStartTask(generation: generation) { [weak self] in
            await self?.observeLaunchdGatewayReadiness(
                context: context,
                readinessWindow: readinessWindow,
                firstInstallReadinessBudget: firstInstallReadinessBudget)
        }
    }
}
#endif
