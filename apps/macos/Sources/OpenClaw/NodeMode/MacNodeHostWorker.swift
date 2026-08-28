import Darwin
import Foundation
import OpenClawKit
import OpenClawProtocol
import OSLog
import Subprocess

extension Notification.Name {
    static let openclawNodeHostManifestChanged = Notification.Name("openclaw.node-host-worker.manifest-changed")
    static let openclawNodeHostWorkerFailed = Notification.Name("openclaw.node-host-worker.failed")
    static let openclawNodeHostWorkerRetryExhausted = Notification.Name(
        "openclaw.node-host-worker.retry-exhausted")
}

struct MacNodeHostManifest: Equatable, Sendable {
    let version: String
    let caps: [String]
    let commands: [String]
    let computerUse: AnyCodable?
    let pathEnv: String

    init(
        version: String,
        caps: [String],
        commands: [String],
        computerUse: AnyCodable? = nil,
        pathEnv: String)
    {
        self.version = version
        self.caps = caps
        self.commands = commands
        self.computerUse = computerUse
        self.pathEnv = pathEnv
    }
}

struct MacNodeHostWorkerLaunch: Equatable, Sendable {
    let command: [String]
    let currentDirectoryURL: URL?
    let environment: [String: String]
    let configurationGeneration: UInt64

    init(
        command: [String],
        currentDirectoryURL: URL? = nil,
        environment: [String: String] = [:],
        configurationGeneration: UInt64 = 0)
    {
        self.command = command
        self.currentDirectoryURL = currentDirectoryURL
        self.environment = environment
        self.configurationGeneration = configurationGeneration
    }
}

protocol MacNodeHostWorking: Sendable {
    func start(launch: MacNodeHostWorkerLaunch) async throws -> MacNodeHostManifest
    func supports(_ command: String) async -> Bool
    func invoke(_ request: BridgeInvokeRequest) async -> BridgeInvokeResponse
    func handleInput(invokeId: String, seq: Int, payloadJSON: String) async
    func cancel(invokeId: String) async
    func setRoute(_ route: GatewayNodeSessionRoute?, authorityGeneration: UInt64) async -> Bool
    func gatewayConnected(ifCurrentRoute route: GatewayNodeSessionRoute) async

    func stop() async
}

/// Runs the canonical TypeScript node-host runtime as an app-owned JSONL worker.
/// The worker never connects to Gateway; this app remains the sole node identity
/// and keeps TCC-sensitive execution behind the native exec-host socket.
final class MacNodeHostWorker: MacNodeHostWorking, @unchecked Sendable {
    nonisolated static let defaultStartupTimeout: TimeInterval = 300
    private static let maxPendingInvokeControlIDs = 32
    private static let maxPendingInvokeControlsPerID = 64

    private enum PendingInvokeControl {
        case input(seq: Int, payloadJSON: String)
        case cancel
    }

    enum WorkerError: LocalizedError {
        case unavailable(reason: String, diagnostic: String? = nil)

        var errorDescription: String? {
            switch self {
            case let .unavailable(reason, diagnostic):
                diagnostic?
                    .split(separator: "\n", omittingEmptySubsequences: true)
                    .first
                    .map { "\(reason): \($0)" } ?? reason
            }
        }
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "node-host-worker")
    private let queue = DispatchQueue(label: "ai.openclaw.node-host-worker")
    private let writerQueue = DispatchQueue(label: "ai.openclaw.node-host-worker.writer")
    private let session: GatewayNodeSession
    private let startupTimeout: TimeInterval
    private let onUnexpectedExit: @Sendable (UInt64) -> Void
    private var process: ManagedProcess?
    private var processCleanupTask: Task<Void, Never>?
    private var stdinPipe: Pipe?
    private var stdoutPipe: Pipe?
    private var stderrPipe: Pipe?
    private var stdoutSource: DispatchSourceRead?
    private var stderrSource: DispatchSourceRead?
    private var processGeneration: UUID?
    private var launchedWorker: MacNodeHostWorkerLaunch?
    private var stdoutBuffer = Data()
    // Bounded head of worker stderr. CLI startup failures print their cause
    // first; without this the operator-visible error is just "exited(1)".
    private var stderrHead = ""
    private static let maxStderrHeadLength = 700
    private var manifest: MacNodeHostManifest?
    private var route: GatewayNodeSessionRoute?
    private var routeAuthorityGeneration: UInt64 = 0
    private var startContinuation: CheckedContinuation<MacNodeHostManifest, Error>?
    private var invokeContinuations: [String: CheckedContinuation<BridgeInvokeResponse, Never>] = [:]
    private var pendingInvokeControls: [String: [PendingInvokeControl]] = [:]
    private var pendingInvokeControlOrder: [String] = []
    private var startTimer: DispatchSourceTimer?
    private var eventDeliveryTask: Task<Void, Never>?
    private var gatewayGeneration: UInt64 = 0

    init(
        session: GatewayNodeSession,
        startupTimeout: TimeInterval = MacNodeHostWorker.defaultStartupTimeout,
        onUnexpectedExit: @escaping @Sendable (UInt64) -> Void = { _ in })
    {
        self.session = session
        self.startupTimeout = startupTimeout
        self.onUnexpectedExit = onUnexpectedExit
    }

    func start(launch: MacNodeHostWorkerLaunch) async throws -> MacNodeHostManifest {
        try await withCheckedThrowingContinuation { continuation in
            self.queue.async {
                if let manifest = self.manifest,
                   self.process?.isRunning == true,
                   self.launchedWorker == launch
                {
                    continuation.resume(returning: manifest)
                    return
                }
                guard self.startContinuation == nil else {
                    continuation.resume(throwing: WorkerError.unavailable(
                        reason: "node-host worker is already starting"))
                    return
                }
                self.startContinuation = continuation
                self.startLocked(launch: launch)
            }
        }
    }

    func supports(_ command: String) async -> Bool {
        await withCheckedContinuation { continuation in
            self.queue.async {
                continuation.resume(returning: self.manifest?.commands.contains(command) == true)
            }
        }
    }

    func invoke(_ request: BridgeInvokeRequest) async -> BridgeInvokeResponse {
        await withCheckedContinuation { continuation in
            self.queue.async {
                guard self.process?.isRunning == true, self.manifest != nil else {
                    continuation.resume(returning: Self.unavailableResponse(
                        request.id,
                        "UNAVAILABLE: node-host worker is not running"))
                    return
                }
                guard self.invokeContinuations[request.id] == nil else {
                    continuation.resume(returning: Self.unavailableResponse(
                        request.id,
                        "UNAVAILABLE: duplicate node-host worker request"))
                    return
                }
                self.invokeContinuations[request.id] = continuation
                do {
                    let workerRequest: [String: Any] = [
                        "id": request.id,
                        "nodeId": request.nodeId ?? "",
                        "command": request.command,
                        "paramsJSON": request.paramsJSON ?? NSNull(),
                        "sessionKey": request.sessionKey ?? NSNull(),
                        "timeoutMs": request.timeoutMs ?? NSNull(),
                        "idempotencyKey": request.idempotencyKey ?? NSNull(),
                    ]
                    try self.enqueueWriteLocked([
                        "type": "invoke",
                        "generation": self.gatewayGeneration,
                        "request": workerRequest,
                    ])
                    for control in self.takePendingInvokeControlsLocked(invokeId: request.id) {
                        try self.enqueueInvokeControlLocked(control, invokeId: request.id)
                        if case .cancel = control {
                            self.finishCancelledInvokeLocked(invokeId: request.id)
                        }
                    }
                } catch {
                    self.invokeContinuations.removeValue(forKey: request.id)?.resume(returning:
                        Self.unavailableResponse(request.id, "UNAVAILABLE: node-host worker write failed"))
                }
            }
        }
    }

    func handleInput(invokeId: String, seq: Int, payloadJSON: String) async {
        await withCheckedContinuation { continuation in
            self.queue.async {
                let control = PendingInvokeControl.input(seq: seq, payloadJSON: payloadJSON)
                if self.invokeContinuations[invokeId] != nil {
                    try? self.enqueueInvokeControlLocked(control, invokeId: invokeId)
                } else if self.process?.isRunning == true, self.manifest != nil {
                    self.bufferInvokeControlLocked(control, invokeId: invokeId)
                }
                continuation.resume()
            }
        }
    }

    func cancel(invokeId: String) async {
        await withCheckedContinuation { continuation in
            self.queue.async {
                let control = PendingInvokeControl.cancel
                if self.invokeContinuations[invokeId] != nil {
                    try? self.enqueueInvokeControlLocked(control, invokeId: invokeId)
                    self.finishCancelledInvokeLocked(invokeId: invokeId)
                } else if self.process?.isRunning == true, self.manifest != nil {
                    self.bufferInvokeControlLocked(control, invokeId: invokeId)
                }
                continuation.resume()
            }
        }
    }

    private func bufferInvokeControlLocked(_ control: PendingInvokeControl, invokeId: String) {
        // Gateway control events can overtake detached invoke dispatch. Keep the
        // short race window bounded, then flush controls after the invoke frame.
        if self.pendingInvokeControls[invokeId] == nil {
            if self.pendingInvokeControlOrder.count >= Self.maxPendingInvokeControlIDs,
               let oldest = self.pendingInvokeControlOrder.first
            {
                self.pendingInvokeControlOrder.removeFirst()
                self.pendingInvokeControls.removeValue(forKey: oldest)
            }
            self.pendingInvokeControlOrder.append(invokeId)
            self.pendingInvokeControls[invokeId] = []
        }
        var controls = self.pendingInvokeControls[invokeId] ?? []
        if controls.contains(where: {
            if case .cancel = $0 { return true }
            return false
        }) {
            return
        }
        if controls.count >= Self.maxPendingInvokeControlsPerID {
            controls.removeFirst()
        }
        controls.append(control)
        self.pendingInvokeControls[invokeId] = controls
    }

    private func takePendingInvokeControlsLocked(invokeId: String) -> [PendingInvokeControl] {
        self.pendingInvokeControlOrder.removeAll { $0 == invokeId }
        return self.pendingInvokeControls.removeValue(forKey: invokeId) ?? []
    }

    private func enqueueInvokeControlLocked(_ control: PendingInvokeControl, invokeId: String) throws {
        switch control {
        case let .input(seq, payloadJSON):
            try self.enqueueWriteLocked([
                "type": "invoke-input",
                "generation": self.gatewayGeneration,
                "invokeId": invokeId,
                "seq": seq,
                "payloadJSON": payloadJSON,
            ])
        case .cancel:
            try self.enqueueWriteLocked([
                "type": "invoke-cancel",
                "generation": self.gatewayGeneration,
                "invokeId": invokeId,
            ])
        }
    }

    private func finishCancelledInvokeLocked(invokeId: String) {
        self.invokeContinuations.removeValue(forKey: invokeId)?.resume(returning:
            Self.unavailableResponse(invokeId, "UNAVAILABLE: node-host worker invocation cancelled"))
    }

    func setRoute(_ route: GatewayNodeSessionRoute?, authorityGeneration: UInt64) async -> Bool {
        await withCheckedContinuation { continuation in
            self.queue.async {
                guard Self.routeUpdateIsCurrent(
                    candidateGeneration: authorityGeneration,
                    currentGeneration: self.routeAuthorityGeneration)
                else {
                    continuation.resume(returning: false)
                    return
                }
                self.routeAuthorityGeneration = authorityGeneration
                self.route = route
                self.gatewayGeneration &+= 1
                try? self.enqueueWriteLocked([
                    "type": "gateway-connection", "generation": self.gatewayGeneration, "connection": NSNull(),
                ])
                let pending = self.invokeContinuations
                self.invokeContinuations.removeAll()
                self.pendingInvokeControls.removeAll()
                self.pendingInvokeControlOrder.removeAll()
                for (id, waiter) in pending {
                    waiter.resume(returning: Self.unavailableResponse(id, "UNAVAILABLE: Gateway route changed"))
                }
                self.eventDeliveryTask?.cancel()
                self.eventDeliveryTask = nil
                continuation.resume(returning: true)
            }
        }
    }

    nonisolated static func routeUpdateIsCurrent(
        candidateGeneration: UInt64,
        currentGeneration: UInt64) -> Bool
    {
        candidateGeneration >= currentGeneration
    }

    func gatewayConnected(ifCurrentRoute route: GatewayNodeSessionRoute) async {
        guard let data = await self.session.workerConnectionData(ifCurrentRoute: route) else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            self.queue.async {
                defer { continuation.resume() }
                guard self.route == route,
                      let connection = try? JSONSerialization.jsonObject(with: data) else { return }
                self.gatewayGeneration &+= 1
                try? self.enqueueWriteLocked([
                    "type": "gateway-connection", "generation": self.gatewayGeneration, "connection": connection,
                ])
            }
        }
    }

    func stop() async {
        let cleanup: Task<Void, Never>? = await withCheckedContinuation { continuation in
            self.queue.async {
                continuation.resume(returning: self.stopLocked(reason: "worker stopped"))
            }
        }
        await cleanup?.value
    }

    private func startLocked(launch: MacNodeHostWorkerLaunch) {
        let command = launch.command
        guard let executable = command.first, !executable.isEmpty else {
            self.finishStartLocked(.failure(WorkerError.unavailable(reason: "node-host worker command missing")))
            return
        }
        if self.process != nil {
            let cleanup = self.stopLocked(reason: "worker restarted", preserveStart: true)
            Task { [weak self] in
                await cleanup?.value
                self?.queue.async { [weak self] in
                    guard let self, self.startContinuation != nil else { return }
                    self.startLocked(launch: launch)
                }
            }
            return
        }
        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        guard stdinPipe.fileHandleForWriting.disableSIGPIPE() else {
            self.finishStartLocked(.failure(WorkerError.unavailable(reason: "could not protect worker input pipe")))
            return
        }
        var environment = ProcessInfo.processInfo.environment.filter { key, _ in
            !CuaDriverWorkerEnvironment.inheritedFamilyPrefixes.contains { key.hasPrefix($0) }
        }
        environment.merge(launch.environment, uniquingKeysWith: { _, explicit in explicit })
        environment["PATH"] = CommandResolver.preferredPaths().joined(separator: ":")
        environment["OPENCLAW_NODE_EXEC_HOST"] = "app"
        environment["OPENCLAW_NODE_EXEC_FALLBACK"] = "0"
        self.launchedWorker = launch
        self.stdinPipe = stdinPipe
        self.stdoutPipe = stdoutPipe
        self.stderrPipe = stderrPipe
        let processGeneration = UUID()
        self.processGeneration = processGeneration

        let timer = DispatchSource.makeTimerSource(queue: self.queue)
        // Cold config and plugin discovery can exceed the old 20-second bound.
        // Keep a hard deadline, but leave enough room for a cold CLI worker start.
        timer.schedule(deadline: .now() + self.startupTimeout)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            let state = self.process?.isRunning == true ? "running" : "exited"
            self.finishStartLocked(.failure(WorkerError.unavailable(
                reason: "node-host worker startup timed out (process \(state), " +
                    "buffered \(self.stdoutBuffer.count) bytes)")))
            self.stopLocked(reason: "worker startup timed out", notifyUnexpectedExit: true)
        }
        self.startTimer = timer
        timer.resume()

        let configuration = Subprocess.Configuration(
            executable: .path(.init(executable)),
            arguments: Arguments(Array(command.dropFirst())),
            environment: ManagedProcess.environment(from: environment),
            workingDirectory: launch.currentDirectoryURL.map { .init($0.path) })
        let process = ManagedProcess.launch(
            configuration: configuration,
            stdin: stdinPipe.fileHandleForReading,
            stdout: stdoutPipe.fileHandleForWriting,
            stderr: stderrPipe.fileHandleForWriting)
        self.process = process
        Task { [weak self] in
            let started = await (try? process.waitUntilStarted()) != nil
            self?.queue.async { [weak self] in
                self?.finishProcessLaunch(started: started, generation: processGeneration)
            }
        }
    }

    private func finishProcessLaunch(
        started: Bool,
        generation: UUID)
    {
        guard self.processGeneration == generation, self.processCleanupTask == nil else { return }
        guard started,
              let process = self.process,
              let stdoutPipe = self.stdoutPipe,
              let stderrPipe = self.stderrPipe
        else {
            self.stopLocked(reason: "worker launch failed")
            return
        }
        let stdoutSource = DispatchSource.makeReadSource(
            fileDescriptor: stdoutPipe.fileHandleForReading.fileDescriptor,
            queue: self.queue)
        stdoutSource.setEventHandler { [weak self] in
            guard let self, self.processGeneration == generation else { return }
            let data = Self.readAvailable(
                fileDescriptor: stdoutPipe.fileHandleForReading.fileDescriptor,
                byteCount: stdoutSource.data)
            if data.isEmpty {
                self.stdoutSource?.cancel()
            } else {
                self.consumeStdoutLocked(data)
            }
        }
        self.stdoutSource = stdoutSource
        stdoutSource.resume()

        let stderrSource = DispatchSource.makeReadSource(
            fileDescriptor: stderrPipe.fileHandleForReading.fileDescriptor,
            queue: self.queue)
        stderrSource.setEventHandler { [weak self] in
            guard let self, self.processGeneration == generation else { return }
            let data = Self.readAvailable(
                fileDescriptor: stderrPipe.fileHandleForReading.fileDescriptor,
                byteCount: stderrSource.data)
            guard !data.isEmpty else {
                self.stderrSource?.cancel()
                return
            }
            if let message = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
                !message.isEmpty
            {
                self.logger.error("node-host worker stderr: \(message, privacy: .private)")
                if self.stderrHead.count < Self.maxStderrHeadLength {
                    self.stderrHead.append(self.stderrHead.isEmpty ? message : "\n" + message)
                    self.stderrHead = String(self.stderrHead.prefix(Self.maxStderrHeadLength))
                }
            }
        }
        self.stderrSource = stderrSource
        stderrSource.resume()
        Task { [weak self, completionTask = process.completionTask] in
            let status = await completionTask.value
            self?.queue.async { [weak self] in
                guard let self,
                      self.processGeneration == generation,
                      self.processCleanupTask == nil
                else { return }
                self.stopLocked(
                    reason: status.map { String(localized: "worker exited with status \(String(describing: $0))") }
                        ?? String(localized: "worker exited with unknown status"),
                    notifyUnexpectedExit: true)
            }
        }
    }

    private func consumeStdoutLocked(_ data: Data) {
        var searchStart = self.stdoutBuffer.count
        self.stdoutBuffer.append(data)
        guard self.stdoutBuffer.count <= 25 * 1024 * 1024 else {
            self.stopLocked(reason: "worker response exceeded limit", notifyUnexpectedExit: true)
            return
        }
        while let newline = self.stdoutBuffer[searchStart...].firstIndex(of: 0x0A) {
            let line = self.stdoutBuffer.prefix(upTo: newline)
            self.stdoutBuffer.removeSubrange(...newline)
            searchStart = 0
            guard !line.isEmpty,
                  let message = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any]
            else { continue }
            self.handleMessageLocked(message)
        }
    }

    private func handleMessageLocked(_ message: [String: Any]) {
        let type = message["type"] as? String
        if type == "invoke-result" || type == "node-event" || type == "gateway-request" {
            guard (message["generation"] as? NSNumber)?.uint64Value == self.gatewayGeneration else { return }
        }
        switch type {
        case "ready", "manifest":
            guard let version = message["version"] as? String,
                  let rawManifest = message["manifest"] as? [String: Any],
                  let caps = rawManifest["caps"] as? [String],
                  let commands = rawManifest["commands"] as? [String],
                  let pathEnv = rawManifest["pathEnv"] as? String
            else {
                self.stopLocked(reason: "worker returned invalid manifest")
                return
            }
            let computerUse: AnyCodable?
            if let rawComputerUse = rawManifest["computerUse"] {
                guard let rawComputerUse = rawComputerUse as? [String: Any],
                      let data = try? JSONSerialization.data(withJSONObject: rawComputerUse),
                      let decoded = try? JSONDecoder().decode(AnyCodable.self, from: data)
                else {
                    self.stopLocked(reason: "worker returned invalid computer-use descriptor")
                    return
                }
                computerUse = decoded
            } else {
                computerUse = nil
            }
            let manifest = MacNodeHostManifest(
                version: version,
                caps: caps,
                commands: commands,
                computerUse: computerUse,
                pathEnv: pathEnv)
            self.manifest = manifest
            if type == "ready" {
                self.finishStartLocked(.success(manifest))
            } else {
                NotificationCenter.default.post(name: .openclawNodeHostManifestChanged, object: nil)
            }
        case "invoke-result":
            guard let result = message["result"] as? [String: Any],
                  let id = result["id"] as? String,
                  let continuation = self.invokeContinuations.removeValue(forKey: id)
            else { return }
            continuation.resume(returning: Self.decodeInvokeResponse(result, id: id))
        case "node-event":
            guard let event = message["event"] as? [String: Any],
                  let name = event["event"] as? String,
                  let route = self.route
            else { return }
            let payload = event["payloadJSON"] as? String
            let previous = self.eventDeliveryTask
            let session = self.session
            let delivery = Task {
                await previous?.value
                guard !Task.isCancelled else { return }
                _ = await session.sendEvent(
                    event: name,
                    payloadJSON: payload,
                    ifCurrentRoute: route)
            }
            self.eventDeliveryTask = delivery
        case "gateway-request":
            guard let id = message["id"] as? String,
                  let method = message["method"] as? String
            else { return }
            guard let route = self.route else {
                self.writeGatewayUnavailableLocked(id: id)
                return
            }
            guard let paramsData = Self.jsonData(message["params"] ?? [:]),
                  let processGeneration = self.processGeneration
            else {
                self.writeGatewayUnavailableLocked(id: id)
                return
            }
            let timeoutMs = (message["timeoutMs"] as? NSNumber)?.intValue ?? 15000
            let gatewayGeneration = self.gatewayGeneration
            Task {
                await self.handleGatewayRequest(
                    id: id,
                    method: method,
                    paramsData: paramsData,
                    timeoutMs: timeoutMs,
                    route: route,
                    processGeneration: processGeneration,
                    gatewayGeneration: gatewayGeneration)
            }
        case "protocol-error":
            self.logger.error("node-host worker rejected a protocol frame")
        default:
            break
        }
    }

    private func handleGatewayRequest(
        id: String,
        method: String,
        paramsData: Data,
        timeoutMs: Int,
        route: GatewayNodeSessionRoute,
        processGeneration: UUID,
        gatewayGeneration: UInt64) async
    {
        do {
            guard let paramsJSON = String(bytes: paramsData, encoding: .utf8) else {
                throw WorkerError.unavailable(reason: "node-host worker gateway request was not UTF-8")
            }
            let data = try await self.session.request(
                method: method,
                paramsJSON: paramsJSON,
                timeoutSeconds: max(1, Int(ceil(Double(timeoutMs) / 1000.0))),
                ifCurrentRoute: route,
                distinguishPreDispatchRouteChange: true)
            self.queue.async {
                // A replacement worker restarts request ids. Never deliver an old
                // route response into the replacement process.
                guard self.processGeneration == processGeneration,
                      self.gatewayGeneration == gatewayGeneration,
                      self.route == route else { return }
                guard let result = try? JSONSerialization.jsonObject(with: data) else { return }
                try? self.enqueueWriteLocked([
                    "type": "gateway-response",
                    "generation": gatewayGeneration,
                    "id": id,
                    "ok": true,
                    "result": result,
                ])
            }
        } catch {
            // Preserve only the public RPC code/message for shared publication classification.
            let responseError = error as? GatewayResponseError
            let code = responseError?.code ?? "UNAVAILABLE"
            let publicMessage = responseError?.message
            let message = code == "INVALID_REQUEST" &&
                (publicMessage == "unknown method: \(method)" || publicMessage == "unauthorized role: node")
                ? publicMessage! : "Gateway request unavailable"
            self.queue.async {
                guard self.processGeneration == processGeneration,
                      self.gatewayGeneration == gatewayGeneration,
                      self.route == route else { return }
                self.writeGatewayUnavailableLocked(id: id, code: code, message: message)
            }
        }
    }

    private func writeGatewayUnavailableLocked(
        id: String, code: String = "UNAVAILABLE", message: String = "Gateway request unavailable")
    {
        try? self.enqueueWriteLocked([
            "type": "gateway-response",
            "generation": self.gatewayGeneration,
            "id": id,
            "ok": false,
            "error": ["code": code, "message": message],
        ])
    }

    private func enqueueWriteLocked(_ object: [String: Any]) throws {
        guard let handle = self.stdinPipe?.fileHandleForWriting,
              self.process?.isRunning == true,
              let processGeneration = self.processGeneration
        else {
            throw WorkerError.unavailable(reason: "node-host worker is not running")
        }
        var data = try JSONSerialization.data(withJSONObject: object)
        data.append(0x0A)
        let frame = data
        self.writerQueue.async { [weak self] in
            do {
                try handle.write(contentsOf: frame)
            } catch {
                self?.queue.async { [weak self] in
                    guard let self, self.processGeneration == processGeneration else { return }
                    self.stopLocked(reason: "worker input write failed", notifyUnexpectedExit: true)
                }
            }
        }
    }

    private func finishStartLocked(_ result: Result<MacNodeHostManifest, Error>) {
        self.startTimer?.cancel()
        self.startTimer = nil
        self.eventDeliveryTask?.cancel()
        self.eventDeliveryTask = nil
        guard let continuation = self.startContinuation else { return }
        self.startContinuation = nil
        continuation.resume(with: result)
    }

    @discardableResult
    private func stopLocked(
        reason: String,
        preserveStart: Bool = false,
        notifyUnexpectedExit: Bool = false) -> Task<Void, Never>?
    {
        let stoppedWorker = self.launchedWorker
        // A worker that dies before its ready manifest still needs its stderr
        // surfaced: the raw exit status alone cannot explain a CLI bootstrap
        // refusal (missing runtime, incompatible state database, bad install).
        let diagnostic = self.stderrHead.nonEmpty
        self.stderrHead = ""
        self.startTimer?.cancel()
        self.startTimer = nil
        self.launchedWorker = nil
        self.stdoutBuffer.removeAll(keepingCapacity: false)
        self.manifest = nil
        self.route = nil
        if !preserveStart {
            self.finishStartLocked(.failure(WorkerError.unavailable(reason: reason, diagnostic: diagnostic)))
        }
        if let processCleanupTask = self.processCleanupTask { return processCleanupTask }
        let pending = self.invokeContinuations
        self.invokeContinuations.removeAll()
        self.pendingInvokeControls.removeAll()
        self.pendingInvokeControlOrder.removeAll()
        for (id, continuation) in pending {
            continuation.resume(returning: Self.unavailableResponse(id, "UNAVAILABLE: node-host worker stopped"))
        }
        // Startup-time exits count too: without this, a worker that dies before
        // its ready manifest never consumes retry budget and the coordinator
        // respawns a broken CLI forever instead of latching retry exhaustion.
        if notifyUnexpectedExit, let stoppedWorker {
            self.onUnexpectedExit(stoppedWorker.configurationGeneration)
        }
        guard let process = self.process else {
            return nil
        }
        let cleanupTask = Task { [weak self] in
            await process.terminate()
            await withCheckedContinuation { continuation in
                guard let self else {
                    continuation.resume()
                    return
                }
                self.queue.async {
                    self.stdoutSource?.cancel()
                    self.stdoutSource = nil
                    self.stderrSource?.cancel()
                    self.stderrSource = nil
                    try? self.stdinPipe?.fileHandleForWriting.close()
                    try? self.stdoutPipe?.fileHandleForReading.close()
                    try? self.stderrPipe?.fileHandleForReading.close()
                    self.process = nil
                    self.processCleanupTask = nil
                    self.stdinPipe = nil
                    self.stdoutPipe = nil
                    self.stderrPipe = nil
                    self.processGeneration = nil
                    continuation.resume()
                }
            }
        }
        self.processCleanupTask = cleanupTask
        return cleanupTask
    }

    private static func decodeInvokeResponse(_ result: [String: Any], id: String) -> BridgeInvokeResponse {
        let ok = result["ok"] as? Bool ?? false
        let payload = result["payload"].map(AnyCodable.init)
        let payloadJSON = result["payloadJSON"] as? String
        let rawError = result["error"] as? [String: Any]
        let code = OpenClawNodeErrorCode(rawValue: rawError?["code"] as? String ?? "UNAVAILABLE") ?? .unavailable
        let error = ok ? nil : OpenClawNodeError(
            code: code,
            message: rawError?["message"] as? String ?? "UNAVAILABLE: node-host worker failed")
        return BridgeInvokeResponse(id: id, ok: ok, payload: payload, payloadJSON: payloadJSON, error: error)
    }

    private static func unavailableResponse(_ id: String, _ message: String) -> BridgeInvokeResponse {
        BridgeInvokeResponse(
            id: id,
            ok: false,
            error: OpenClawNodeError(code: .unavailable, message: message))
    }

    private static func paramsJSON(_ object: [String: Any]) -> String? {
        guard let data = self.jsonData(object) else { return nil }
        return String(bytes: data, encoding: .utf8)
    }

    private static func jsonData(_ object: Any) -> Data? {
        guard JSONSerialization.isValidJSONObject(object) else { return nil }
        return try? JSONSerialization.data(withJSONObject: object)
    }

    private static func readAvailable(fileDescriptor: Int32, byteCount: UInt) -> Data {
        let count = max(1, min(Int(byteCount), 64 * 1024))
        var data = Data(count: count)
        let bytesRead = data.withUnsafeMutableBytes { buffer in
            Darwin.read(fileDescriptor, buffer.baseAddress, count)
        }
        guard bytesRead > 0 else { return Data() }
        data.removeSubrange(bytesRead..<data.count)
        return data
    }
}
