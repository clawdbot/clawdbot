import Darwin
import Foundation
import OpenClawKit
import OSLog

extension Notification.Name {
    static let openclawNodeHostWorkerFailed = Notification.Name("openclaw.node-host-worker.failed")
}

struct MacNodeHostManifest: Equatable, Sendable {
    let version: String
    let caps: [String]
    let commands: [String]
    let pathEnv: String
}

protocol MacNodeHostWorking: Sendable {
    func start(command: [String]) async throws -> MacNodeHostManifest
    func supports(_ command: String) async -> Bool
    func invoke(_ request: BridgeInvokeRequest) async -> BridgeInvokeResponse
    func handleInput(invokeId: String, seq: Int, payloadJSON: String) async
    func cancel(invokeId: String) async
    func setRoute(_ route: GatewayNodeSessionRoute?, authorityGeneration: UInt64) async -> Bool
    func publishInventory(ifCurrentRoute route: GatewayNodeSessionRoute) async
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
        case unavailable(String)

        var errorDescription: String? {
            switch self {
            case let .unavailable(message): message
            }
        }
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "node-host-worker")
    private let queue = DispatchQueue(label: "ai.openclaw.node-host-worker")
    private let writerQueue = DispatchQueue(label: "ai.openclaw.node-host-worker.writer")
    private let session: GatewayNodeSession
    private let startupTimeout: TimeInterval
    private let onUnexpectedExit: @Sendable () -> Void
    private var process: Process?
    private var stdinPipe: Pipe?
    private var stdoutPipe: Pipe?
    private var stderrPipe: Pipe?
    private var stdoutSource: DispatchSourceRead?
    private var stderrSource: DispatchSourceRead?
    private var processGeneration: UUID?
    private var launchedCommand: [String]?
    private var stdoutBuffer = Data()
    private var manifest: MacNodeHostManifest?
    private var inventoryData: Data?
    private var route: GatewayNodeSessionRoute?
    private var routeAuthorityGeneration: UInt64 = 0
    private var startContinuation: CheckedContinuation<MacNodeHostManifest, Error>?
    private var invokeContinuations: [String: CheckedContinuation<BridgeInvokeResponse, Never>] = [:]
    private var pendingInvokeControls: [String: [PendingInvokeControl]] = [:]
    private var pendingInvokeControlOrder: [String] = []
    private var startTimer: DispatchSourceTimer?
    private var eventDeliveryTask: Task<Void, Never>?
    private var inventoryPublicationTask: Task<Void, Never>?
    private var inventoryPublicationGeneration: UInt64 = 0
    private var stopping = false

    init(
        session: GatewayNodeSession,
        startupTimeout: TimeInterval = MacNodeHostWorker.defaultStartupTimeout,
        onUnexpectedExit: @escaping @Sendable () -> Void = {})
    {
        self.session = session
        self.startupTimeout = startupTimeout
        self.onUnexpectedExit = onUnexpectedExit
    }

    func start(command: [String]) async throws -> MacNodeHostManifest {
        try await withCheckedThrowingContinuation { continuation in
            self.queue.async {
                if let manifest = self.manifest,
                   self.process?.isRunning == true,
                   self.launchedCommand == command
                {
                    continuation.resume(returning: manifest)
                    return
                }
                guard self.startContinuation == nil else {
                    continuation.resume(throwing: WorkerError.unavailable("node-host worker is already starting"))
                    return
                }
                self.startContinuation = continuation
                self.startLocked(command: command)
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
                    ]
                    try self.enqueueWriteLocked([
                        "type": "invoke",
                        "request": workerRequest,
                    ])
                    for control in self.takePendingInvokeControlsLocked(invokeId: request.id) {
                        try self.enqueueInvokeControlLocked(control, invokeId: request.id)
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
                "invokeId": invokeId,
                "seq": seq,
                "payloadJSON": payloadJSON,
            ])
        case .cancel:
            try self.enqueueWriteLocked([
                "type": "invoke-cancel",
                "invokeId": invokeId,
            ])
        }
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
                self.inventoryPublicationGeneration &+= 1
                self.inventoryPublicationTask?.cancel()
                self.inventoryPublicationTask = nil
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

    func publishInventory(ifCurrentRoute route: GatewayNodeSessionRoute) async {
        let publication: Task<Void, Never>? = await withCheckedContinuation { continuation in
            self.queue.async {
                guard let inventoryData = self.inventoryData else {
                    continuation.resume(returning: nil)
                    return
                }
                continuation.resume(returning: self.scheduleInventoryPublicationLocked(
                    inventoryData,
                    route: route))
            }
        }
        await publication?.value
    }

    func stop() async {
        await withCheckedContinuation { continuation in
            self.queue.async {
                self.stopLocked(reason: "worker stopped")
                continuation.resume()
            }
        }
    }

    private func startLocked(command: [String]) {
        guard let executable = command.first, !executable.isEmpty else {
            self.finishStartLocked(.failure(WorkerError.unavailable("node-host worker command missing")))
            return
        }
        self.stopLocked(reason: "worker restarted", preserveStart: true)
        self.stopping = false

        let process = Process()
        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = Array(command.dropFirst())
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = CommandResolver.preferredPaths().joined(separator: ":")
        environment["OPENCLAW_NODE_EXEC_HOST"] = "app"
        environment["OPENCLAW_NODE_EXEC_FALLBACK"] = "0"
        process.environment = environment
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        self.process = process
        self.launchedCommand = command
        self.stdinPipe = stdinPipe
        self.stdoutPipe = stdoutPipe
        self.stderrPipe = stderrPipe
        let processGeneration = UUID()
        self.processGeneration = processGeneration

        process.terminationHandler = { [weak self] process in
            guard let self else { return }
            self.queue.async {
                guard self.process === process else { return }
                self.stopLocked(
                    reason: "worker exited with status \(process.terminationStatus)",
                    notifyUnexpectedExit: true)
            }
        }

        let timer = DispatchSource.makeTimerSource(queue: self.queue)
        // Cold config and plugin discovery can exceed the old 20-second bound.
        // Keep a hard deadline, but leave enough room for a cold CLI worker start.
        timer.schedule(deadline: .now() + self.startupTimeout)
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            let state = self.process?.isRunning == true ? "running" : "exited"
            self.finishStartLocked(.failure(WorkerError.unavailable(
                "node-host worker startup timed out (process \(state), buffered \(self.stdoutBuffer.count) bytes)")))
            self.stopLocked(reason: "worker startup timed out")
        }
        self.startTimer = timer
        timer.resume()

        do {
            try process.run()
            let stdoutSource = DispatchSource.makeReadSource(
                fileDescriptor: stdoutPipe.fileHandleForReading.fileDescriptor,
                queue: self.queue)
            stdoutSource.setEventHandler { [weak self] in
                guard let self, self.processGeneration == processGeneration else { return }
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
                guard let self, self.processGeneration == processGeneration else { return }
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
                }
            }
            self.stderrSource = stderrSource
            stderrSource.resume()
            try? stdinPipe.fileHandleForReading.close()
            try? stdoutPipe.fileHandleForWriting.close()
            try? stderrPipe.fileHandleForWriting.close()
        } catch {
            self.finishStartLocked(.failure(WorkerError.unavailable("node-host worker launch failed")))
            self.stopLocked(reason: "worker launch failed")
        }
    }

    private func consumeStdoutLocked(_ data: Data) {
        self.stdoutBuffer.append(data)
        guard self.stdoutBuffer.count <= 25 * 1024 * 1024 else {
            self.stopLocked(reason: "worker response exceeded limit", notifyUnexpectedExit: true)
            return
        }
        while let newline = self.stdoutBuffer.firstIndex(of: 0x0A) {
            let line = self.stdoutBuffer.prefix(upTo: newline)
            self.stdoutBuffer.removeSubrange(...newline)
            guard !line.isEmpty,
                  let message = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any]
            else { continue }
            self.handleMessageLocked(message)
        }
    }

    private func handleMessageLocked(_ message: [String: Any]) {
        switch message["type"] as? String {
        case "ready":
            guard let version = message["version"] as? String,
                  let rawManifest = message["manifest"] as? [String: Any],
                  let caps = rawManifest["caps"] as? [String],
                  let commands = rawManifest["commands"] as? [String],
                  let pathEnv = rawManifest["pathEnv"] as? String
            else {
                self.stopLocked(reason: "worker returned invalid manifest")
                return
            }
            let manifest = MacNodeHostManifest(version: version, caps: caps, commands: commands, pathEnv: pathEnv)
            self.manifest = manifest
            self.inventoryData = (message["inventory"] as? [String: Any]).flatMap(Self.jsonData)
            self.finishStartLocked(.success(manifest))
        case "inventory":
            guard let inventory = message["inventory"] as? [String: Any],
                  let inventoryData = Self.jsonData(inventory)
            else { return }
            self.inventoryData = inventoryData
            if let route = self.route {
                self.scheduleInventoryPublicationLocked(inventoryData, route: route)
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
            Task {
                await self.handleGatewayRequest(
                    id: id,
                    method: method,
                    paramsData: paramsData,
                    timeoutMs: timeoutMs,
                    route: route,
                    processGeneration: processGeneration)
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
        processGeneration: UUID) async
    {
        do {
            guard let paramsJSON = String(bytes: paramsData, encoding: .utf8) else {
                throw WorkerError.unavailable("node-host worker gateway request was not UTF-8")
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
                guard self.processGeneration == processGeneration else { return }
                guard let result = try? JSONSerialization.jsonObject(with: data) else { return }
                try? self.enqueueWriteLocked([
                    "type": "gateway-response",
                    "id": id,
                    "ok": true,
                    "result": result,
                ])
            }
        } catch {
            self.queue.async {
                guard self.processGeneration == processGeneration else { return }
                self.writeGatewayUnavailableLocked(id: id)
            }
        }
    }

    private func writeGatewayUnavailableLocked(id: String) {
        try? self.enqueueWriteLocked([
            "type": "gateway-response",
            "id": id,
            "ok": false,
            "error": "Gateway request unavailable",
        ])
    }

    @discardableResult
    private func scheduleInventoryPublicationLocked(
        _ inventoryData: Data,
        route: GatewayNodeSessionRoute) -> Task<Void, Never>
    {
        self.inventoryPublicationGeneration &+= 1
        let generation = self.inventoryPublicationGeneration
        let previous = self.inventoryPublicationTask
        let publication = Task { [weak self] in
            await previous?.value
            guard let self,
                  !Task.isCancelled,
                  await self.inventoryPublicationIsCurrent(generation, route: route)
            else { return }
            await self.sendInventory(inventoryData, route: route)
        }
        self.inventoryPublicationTask = publication
        return publication
    }

    private func inventoryPublicationIsCurrent(
        _ generation: UInt64,
        route: GatewayNodeSessionRoute) async -> Bool
    {
        await withCheckedContinuation { continuation in
            self.queue.async {
                continuation.resume(returning:
                    self.inventoryPublicationGeneration == generation && self.route == route)
            }
        }
    }

    private func sendInventory(_ inventoryData: Data, route: GatewayNodeSessionRoute) async {
        guard let inventory = try? JSONSerialization.jsonObject(with: inventoryData) as? [String: Any] else { return }
        if let skills = inventory["skills"], !(skills is NSNull),
           let paramsJSON = Self.paramsJSON(["skills": skills])
        {
            _ = try? await self.session.request(
                method: "node.skills.update",
                paramsJSON: paramsJSON,
                ifCurrentRoute: route)
        }
        if let tools = inventory["pluginTools"] as? [Any],
           let paramsJSON = Self.paramsJSON(["tools": tools])
        {
            _ = try? await self.session.request(
                method: "node.pluginTools.update",
                paramsJSON: paramsJSON,
                ifCurrentRoute: route)
        }
    }

    private func enqueueWriteLocked(_ object: [String: Any]) throws {
        guard let handle = self.stdinPipe?.fileHandleForWriting,
              self.process?.isRunning == true,
              let processGeneration = self.processGeneration
        else {
            throw WorkerError.unavailable("node-host worker is not running")
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
        self.inventoryPublicationGeneration &+= 1
        self.inventoryPublicationTask?.cancel()
        self.inventoryPublicationTask = nil
        guard let continuation = self.startContinuation else { return }
        self.startContinuation = nil
        continuation.resume(with: result)
    }

    private func stopLocked(
        reason: String,
        preserveStart: Bool = false,
        notifyUnexpectedExit: Bool = false)
    {
        guard !self.stopping else { return }
        let wasReady = self.manifest != nil
        self.stopping = true
        self.startTimer?.cancel()
        self.startTimer = nil
        self.stdoutSource?.cancel()
        self.stdoutSource = nil
        self.stderrSource?.cancel()
        self.stderrSource = nil
        try? self.stdinPipe?.fileHandleForWriting.close()
        try? self.stdinPipe?.fileHandleForReading.close()
        try? self.stdoutPipe?.fileHandleForReading.close()
        try? self.stdoutPipe?.fileHandleForWriting.close()
        try? self.stderrPipe?.fileHandleForReading.close()
        try? self.stderrPipe?.fileHandleForWriting.close()
        if self.process?.isRunning == true {
            self.process?.terminate()
        }
        self.process = nil
        self.launchedCommand = nil
        self.stdinPipe = nil
        self.stdoutPipe = nil
        self.stderrPipe = nil
        self.processGeneration = nil
        self.stdoutBuffer.removeAll(keepingCapacity: false)
        self.manifest = nil
        self.inventoryData = nil
        self.route = nil
        if !preserveStart {
            self.finishStartLocked(.failure(WorkerError.unavailable(reason)))
        }
        let pending = self.invokeContinuations
        self.invokeContinuations.removeAll()
        self.pendingInvokeControls.removeAll()
        self.pendingInvokeControlOrder.removeAll()
        for (id, continuation) in pending {
            continuation.resume(returning: Self.unavailableResponse(id, "UNAVAILABLE: node-host worker stopped"))
        }
        if notifyUnexpectedExit, wasReady {
            self.onUnexpectedExit()
        }
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
