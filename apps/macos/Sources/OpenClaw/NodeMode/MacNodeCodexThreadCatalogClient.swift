import Darwin
import Foundation
import Subprocess

final class MacNodeCodexThreadCatalogClient: @unchecked Sendable {
    private let loadRoot: () -> [String: Any]
    private let appServerClient: CodexAppServerThreadClient

    init(
        idleTimeoutSeconds: Double = MacNodeCodexThreadCatalog.defaultIdleTimeoutSeconds,
        loadRoot: @escaping () -> [String: Any] = { OpenClawConfigFile.loadDict() })
    {
        self.loadRoot = loadRoot
        self.appServerClient = CodexAppServerThreadClient(
            idleTimeoutSeconds: idleTimeoutSeconds)
    }

    func list(paramsJSON: String?) async throws -> String {
        try await MacNodeCodexThreadCatalog.list(
            paramsJSON: paramsJSON,
            loadRoot: self.loadRoot,
            client: self.appServerClient)
    }

    func turns(paramsJSON: String?) async throws -> String {
        try await MacNodeCodexThreadCatalog.turns(
            paramsJSON: paramsJSON,
            loadRoot: self.loadRoot,
            client: self.appServerClient)
    }

    func shutdown() async {
        await self.appServerClient.shutdown()
    }
}

final class CodexAppServerThreadClient: @unchecked Sendable {
    private final class CancellationState: @unchecked Sendable {
        private let lock = NSLock()
        private var cancelled = false

        func cancel() {
            self.lock.lock()
            self.cancelled = true
            self.lock.unlock()
        }

        func isCancelled() -> Bool {
            self.lock.lock()
            defer { self.lock.unlock() }
            return self.cancelled
        }
    }

    private final class PendingRequest: @unchecked Sendable {
        let token: UUID
        let invocation: MacNodeCodexThreadCatalog.ResolvedInvocation
        let method: String
        let requestParamsData: Data
        let maxLineBytes: Int
        var requestID: Int?
        var requestData: Data?
        var continuation: CheckedContinuation<Data, Error>?
        var timer: DispatchSourceTimer?

        init(
            token: UUID,
            invocation: MacNodeCodexThreadCatalog.ResolvedInvocation,
            method: String,
            requestParamsData: Data,
            maxLineBytes: Int,
            continuation: CheckedContinuation<Data, Error>)
        {
            self.token = token
            self.invocation = invocation
            self.method = method
            self.requestParamsData = requestParamsData
            self.maxLineBytes = maxLineBytes
            self.continuation = continuation
        }
    }

    private final class Connection: @unchecked Sendable {
        enum Lifecycle {
            case running
            case stopping
        }

        let generation = UUID()
        let invocation: MacNodeCodexThreadCatalog.ResolvedInvocation
        let initializeRequestID: Int
        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        var process: ManagedProcess?
        var cleanupTask: Task<Void, Never>?
        var stdoutBuffer = Data()
        var initialized = false
        var stdoutReachedEOF = false
        var lifecycle: Lifecycle = .running

        init(
            invocation: MacNodeCodexThreadCatalog.ResolvedInvocation,
            initializeRequestID: Int)
        {
            self.invocation = invocation
            self.initializeRequestID = initializeRequestID
        }
    }

    private static let maxQueuedRequests = 64
    private static let maxStdoutDrainBytes = 256 * 1024
    private static let gracefulShutdownTimeout: Duration = .seconds(
        AppTerminationTiming.cleanupDeadlineSeconds * 0.75)

    private let queue = DispatchQueue(label: "ai.openclaw.codex-thread-catalog")
    private let idleTimeoutSeconds: Double
    private let idleReadLimit: Int
    private var nextRequestID = 1
    private var pending: [PendingRequest] = []
    private var active: PendingRequest?
    private var connection: Connection?
    private var idleTimer: DispatchSourceTimer?

    init(
        idleTimeoutSeconds: Double = MacNodeCodexThreadCatalog.defaultIdleTimeoutSeconds,
        idleReadLimit: Int = 20 * 1024 * 1024)
    {
        self.idleTimeoutSeconds = max(0.01, idleTimeoutSeconds)
        self.idleReadLimit = max(1, idleReadLimit)
    }

    deinit {
        self.cancelIdleTimer()
        self.connection?.process?.requestTermination()
    }

    func request(
        invocation: MacNodeCodexThreadCatalog.ResolvedInvocation,
        method: String,
        requestParams: [String: Any],
        timeoutSeconds: Double,
        maxLineBytes: Int) async throws -> Data
    {
        try Task.checkCancellation()
        let requestParamsData = try Self.jsonData(requestParams)
        let token = UUID()
        let cancellationState = CancellationState()
        let result: Data = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.queue.async {
                    guard !cancellationState.isCancelled() else {
                        continuation.resume(throwing: CancellationError())
                        return
                    }
                    guard self.pending.count + (self.active == nil ? 0 : 1) <
                        Self.maxQueuedRequests
                    else {
                        continuation.resume(
                            throwing: MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable)
                        return
                    }
                    let request = PendingRequest(
                        token: token,
                        invocation: invocation,
                        method: method,
                        requestParamsData: requestParamsData,
                        maxLineBytes: max(1, maxLineBytes),
                        continuation: continuation)
                    // Callers pass the operation's remaining wall-clock deadline.
                    // Queue wait therefore counts, matching the former one-shot session.
                    request.timer = self.makeRequestTimer(
                        token: token,
                        timeoutSeconds: timeoutSeconds)
                    self.pending.append(request)
                    self.cancelIdleTimer()
                    self.startNextIfNeeded()
                }
            }
        } onCancel: {
            cancellationState.cancel()
            self.queue.async {
                self.cancel(token: token)
            }
        }
        try Task.checkCancellation()
        return result
    }

    func shutdown() async {
        let cleanup: Task<Void, Never>? = await withCheckedContinuation { continuation in
            self.queue.async {
                self.cancelIdleTimer()
                if let active = self.active {
                    self.active = nil
                    self.complete(active, with: .failure(CancellationError()))
                }
                let pending = self.pending
                self.pending.removeAll()
                for request in pending {
                    self.complete(request, with: .failure(CancellationError()))
                }
                continuation.resume(returning: self.stopConnection(abortive: false))
            }
        }
        await cleanup?.value
    }

    private func takeRequestIDOnQueue() -> Int {
        let requestID = self.nextRequestID
        self.nextRequestID = requestID == Int.max ? 1 : requestID + 1
        return requestID
    }

    private func makeRequestTimer(token: UUID, timeoutSeconds: Double) -> DispatchSourceTimer {
        let timer = DispatchSource.makeTimerSource(queue: self.queue)
        timer.schedule(deadline: .now() + max(0.01, timeoutSeconds))
        timer.setEventHandler { [weak self] in
            self?.timeout(token: token)
        }
        timer.resume()
        return timer
    }

    private func startNextIfNeeded() {
        guard self.active == nil, !self.pending.isEmpty else {
            if self.active == nil, self.pending.isEmpty {
                self.scheduleIdleShutdown()
            }
            return
        }
        let request = self.pending[0]
        if let connection = self.connection {
            guard case .running = connection.lifecycle else { return }
            if connection.process?.isRunning != true ||
                connection.invocation != request.invocation
            {
                // Invocation replacement is graceful, but the successor remains
                // fenced until this connection's process and stdout have closed.
                self.stopConnection(abortive: false)
                return
            }
        }
        self.pending.removeFirst()
        self.active = request
        guard let connection = self.connection else {
            self.startConnection(for: request)
            return
        }
        guard connection.initialized else { return }
        self.sendActiveRequest(over: connection)
    }

    private func startConnection(for request: PendingRequest) {
        let connection = Connection(
            invocation: request.invocation,
            initializeRequestID: self.takeRequestIDOnQueue())
        self.connection = connection
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = CommandResolver.preferredPaths().joined(separator: ":")
        for key in request.invocation.clearEnv {
            environment.removeValue(forKey: key)
        }
        // DispatchSource readability callbacks may be followed by future drain
        // loops. Keep both pipes non-blocking so an open App Server cannot stall
        // the catalog handshake after emitting one JSON-RPC frame.
        Self.setNonBlocking(connection.stdoutPipe.fileHandleForReading)
        Self.setNonBlocking(connection.stderrPipe.fileHandleForReading)
        let generation = connection.generation
        connection.stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            guard let self else { return }
            self.queue.async {
                self.drainStdout(from: handle, generation: generation)
            }
        }
        connection.stderrPipe.fileHandleForReading.readabilityHandler = { handle in
            if Self.drainAvailable(from: handle) {
                handle.readabilityHandler = nil
            }
        }
        let configuration = Subprocess.Configuration(
            .path(.init(request.invocation.executable)),
            arguments: Arguments(request.invocation.arguments),
            environment: ManagedProcess.environment(from: environment),
            workingDirectory: request.invocation.cwd.map { .init($0.path) })
        // Leave enough of the app's cleanup budget for group termination and joined reaping.
        let process = ManagedProcess.launch(
            configuration: configuration,
            stdin: connection.stdinPipe.fileHandleForReading,
            stdout: connection.stdoutPipe.fileHandleForWriting,
            stderr: connection.stderrPipe.fileHandleForWriting,
            closeStdinForGracefulShutdown: connection.stdinPipe.fileHandleForWriting,
            gracefulShutdownTimeout: Self.gracefulShutdownTimeout)
        connection.process = process
        Task { [weak self] in
            let started = await (try? process.waitUntilStarted()) != nil
            self?.queue.async { [weak self] in
                self?.finishConnectionLaunch(started: started, generation: generation)
            }
        }
    }

    private func finishConnectionLaunch(
        started: Bool,
        generation: UUID)
    {
        guard let connection = self.connection,
              connection.generation == generation,
              connection.cleanupTask == nil
        else { return }
        guard started, let process = connection.process else {
            self.discardUnstartedConnection(connection)
            self.finishActive(
                .failure(MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable),
                restartConnection: false)
            return
        }
        Task { [weak self, completionTask = process.completionTask] in
            _ = await completionTask.value
            self?.queue.async { [weak self] in
                self?.handleTermination(generation: generation)
            }
        }
        do {
            try self.write(
                Self.initializeRequestData(id: connection.initializeRequestID),
                over: connection)
        } catch {
            self.finishActive(
                .failure(MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable),
                restartConnection: true)
        }
    }

    private func sendActiveRequest(over connection: Connection) {
        guard let active = self.active else { return }
        do {
            if active.requestData == nil {
                let requestID = self.takeRequestIDOnQueue()
                let requestParams = try JSONSerialization.jsonObject(
                    with: active.requestParamsData)
                active.requestID = requestID
                active.requestData = try Self.jsonData([
                    "id": requestID,
                    "method": active.method,
                    "params": requestParams,
                ])
            }
            guard let requestData = active.requestData else {
                throw MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable
            }
            try self.write(requestData, over: connection)
        } catch {
            self.finishActive(
                .failure(MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable),
                restartConnection: true)
        }
    }

    private func drainStdout(from handle: FileHandle, generation: UUID) {
        guard let connection = self.connection, connection.generation == generation else { return }
        var drainedBytes = 0
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            // Yield after a bounded batch so request timers, cancellation, and
            // shutdown work queued behind a noisy App Server can still run.
            if drainedBytes >= Self.maxStdoutDrainBytes {
                self.queue.async { [weak self] in
                    self?.drainStdout(from: handle, generation: generation)
                }
                return
            }
            let count = buffer.withUnsafeMutableBytes { bytes in
                Darwin.read(handle.fileDescriptor, bytes.baseAddress, bytes.count)
            }
            if count > 0 {
                drainedBytes += count
                self.consumeStdout(
                    Data(buffer.prefix(count)),
                    connection: connection)
                guard self.connection?.generation == generation else { return }
                continue
            }
            if count == 0 {
                connection.stdoutReachedEOF = true
                handle.readabilityHandler = nil
                self.finishTerminatedConnectionIfNeeded(generation: generation)
                return
            }
            if errno == EINTR { continue }
            if errno == EAGAIN || errno == EWOULDBLOCK {
                if connection.process?.isRunning == false {
                    self.queue.asyncAfter(deadline: .now() + .milliseconds(1)) { [weak self] in
                        self?.drainStdout(from: handle, generation: generation)
                    }
                }
                return
            }
            connection.stdoutReachedEOF = true
            handle.readabilityHandler = nil
            self.finishTerminatedConnectionIfNeeded(generation: generation)
            return
        }
    }

    private func consumeStdout(
        _ data: Data,
        connection: Connection)
    {
        connection.stdoutBuffer.append(data)

        while let newline = connection.stdoutBuffer.firstIndex(of: 0x0A) {
            let line = connection.stdoutBuffer.prefix(upTo: newline)
            let maxLineBytes = self.active?.maxLineBytes ?? self.idleReadLimit
            guard line.count <= maxLineBytes else {
                self.rejectOversizedFrame()
                return
            }
            connection.stdoutBuffer.removeSubrange(...newline)
            guard !line.isEmpty else { continue }
            self.handleLine(Data(line), connection: connection)
            guard self.connection?.generation == connection.generation else { return }
        }
        let maxLineBytes = self.active?.maxLineBytes ?? self.idleReadLimit
        guard connection.stdoutBuffer.count <= maxLineBytes else {
            self.rejectOversizedFrame()
            return
        }
    }

    private func rejectOversizedFrame() {
        if self.active == nil {
            self.stopConnection(abortive: true)
            self.startNextIfNeeded()
        } else {
            self.finishActive(
                .failure(MacNodeCodexThreadCatalog.CatalogError.responseTooLarge),
                restartConnection: true)
        }
    }

    private func handleLine(_ data: Data, connection: Connection) {
        guard let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = (message["id"] as? NSNumber)?.intValue
        else { return }

        if id == connection.initializeRequestID {
            guard message["error"] == nil, message["result"] is [String: Any] else {
                self.finishActive(
                    .failure(MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable),
                    restartConnection: true)
                return
            }
            connection.initialized = true
            do {
                try self.write(Self.initializedNotificationData(), over: connection)
                self.sendActiveRequest(over: connection)
            } catch {
                self.finishActive(
                    .failure(MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable),
                    restartConnection: true)
            }
            return
        }

        guard let active = self.active, id == active.requestID else { return }
        guard message["error"] == nil,
              let result = message["result"] as? [String: Any],
              let resultData = try? Self.jsonData(result)
        else {
            self.finishActive(
                .failure(MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable),
                restartConnection: message["error"] == nil)
            return
        }
        self.finishActive(.success(resultData), restartConnection: false)
    }

    private func handleTermination(generation: UUID) {
        guard let connection = self.connection, connection.generation == generation else { return }
        // A short-lived server can exit before its readability callback runs.
        // Drain its final frame before projecting termination onto the request.
        if !connection.stdoutReachedEOF {
            self.drainStdout(
                from: connection.stdoutPipe.fileHandleForReading,
                generation: generation)
        }
        self.finishTerminatedConnectionIfNeeded(generation: generation)
    }

    private func finishTerminatedConnectionIfNeeded(generation: UUID) {
        guard let connection = self.connection,
              connection.generation == generation,
              connection.process?.isRunning == false,
              connection.stdoutReachedEOF,
              connection.cleanupTask == nil
        else { return }

        let wasRunning = if case .running = connection.lifecycle {
            true
        } else {
            false
        }
        self.retireConnection(connection)
        if wasRunning, self.active != nil {
            self.finishActive(
                .failure(MacNodeCodexThreadCatalog.CatalogError.appServerUnavailable),
                restartConnection: false)
        } else {
            self.startNextIfNeeded()
        }
    }

    private func timeout(token: UUID) {
        if let index = self.pending.firstIndex(where: { $0.token == token }) {
            let request = self.pending.remove(at: index)
            self.complete(
                request,
                with: .failure(MacNodeCodexThreadCatalog.CatalogError.timedOut))
            if self.active == nil {
                self.stopConnection(abortive: true)
            }
            return
        }
        guard self.active?.token == token else { return }
        self.finishActive(
            .failure(MacNodeCodexThreadCatalog.CatalogError.timedOut),
            restartConnection: true)
    }

    private func cancel(token: UUID) {
        if let index = self.pending.firstIndex(where: { $0.token == token }) {
            let request = self.pending.remove(at: index)
            self.complete(request, with: .failure(CancellationError()))
            if self.active == nil {
                self.stopConnection(abortive: true)
            }
            return
        }
        guard self.active?.token == token else { return }
        self.finishActive(.failure(CancellationError()), restartConnection: true)
    }

    private func finishActive(
        _ result: Result<Data, Error>,
        restartConnection: Bool)
    {
        guard let active = self.active else { return }
        self.active = nil
        self.complete(active, with: result)
        if restartConnection {
            self.stopConnection(abortive: true)
        }
        self.startNextIfNeeded()
    }

    private func complete(_ request: PendingRequest, with result: Result<Data, Error>) {
        request.timer?.cancel()
        request.timer = nil
        guard let continuation = request.continuation else { return }
        request.continuation = nil
        continuation.resume(with: result)
    }

    private func scheduleIdleShutdown() {
        guard let connection = self.connection,
              case .running = connection.lifecycle,
              self.idleTimer == nil
        else { return }
        let timer = DispatchSource.makeTimerSource(queue: self.queue)
        timer.schedule(deadline: .now() + self.idleTimeoutSeconds)
        timer.setEventHandler { [weak self] in
            guard let self, self.active == nil, self.pending.isEmpty else { return }
            self.cancelIdleTimer()
            self.stopConnection(abortive: false)
        }
        self.idleTimer = timer
        timer.resume()
    }

    private func cancelIdleTimer() {
        self.idleTimer?.cancel()
        self.idleTimer = nil
    }

    @discardableResult
    private func stopConnection(abortive: Bool) -> Task<Void, Never>? {
        guard let connection = self.connection else { return nil }
        if let cleanupTask = connection.cleanupTask {
            if abortive {
                connection.process?.requestTermination(gracefully: false)
            }
            return cleanupTask
        }
        guard let process = connection.process else { return nil }
        connection.lifecycle = .stopping
        let generation = connection.generation
        let cleanupTask = Task { [weak self] in
            await process.terminate(gracefully: !abortive)
            await withCheckedContinuation { continuation in
                guard let self else {
                    continuation.resume()
                    return
                }
                self.queue.async {
                    if let current = self.connection, current.generation == generation {
                        if !current.stdoutReachedEOF {
                            self.drainStdout(
                                from: current.stdoutPipe.fileHandleForReading,
                                generation: generation)
                        }
                        self.retireConnection(current)
                        self.startNextIfNeeded()
                    }
                    continuation.resume()
                }
            }
        }
        connection.cleanupTask = cleanupTask
        return cleanupTask
    }

    private func discardUnstartedConnection(_ connection: Connection) {
        guard self.connection?.generation == connection.generation else { return }
        self.connection = nil
        self.closeLocalPipeHandles(connection)
    }

    private func retireConnection(_ connection: Connection) {
        guard self.connection?.generation == connection.generation else { return }
        self.connection = nil
        self.closeLocalPipeHandles(connection)
    }

    private func closeLocalPipeHandles(_ connection: Connection) {
        connection.stdoutPipe.fileHandleForReading.readabilityHandler = nil
        connection.stderrPipe.fileHandleForReading.readabilityHandler = nil
        try? connection.stdinPipe.fileHandleForWriting.close()
        try? connection.stdoutPipe.fileHandleForReading.close()
        try? connection.stderrPipe.fileHandleForReading.close()
    }

    private func write(_ data: Data, over connection: Connection) throws {
        var frame = data
        frame.append(0x0A)
        try connection.stdinPipe.fileHandleForWriting.write(contentsOf: frame)
    }

    private static func initializeRequestData(id: Int) throws -> Data {
        try self.jsonData([
            "id": id,
            "method": "initialize",
            "params": [
                "clientInfo": [
                    "name": "openclaw_macos",
                    "title": "OpenClaw macOS Node",
                    "version": GatewayEnvironment.appVersionString() ?? "unknown",
                ],
                "capabilities": ["experimentalApi": true],
            ],
        ])
    }

    private static func initializedNotificationData() throws -> Data {
        try self.jsonData(["method": "initialized"])
    }

    private static func jsonData(_ object: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: object)
    }

    private static func drainAvailable(from handle: FileHandle) -> Bool {
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = buffer.withUnsafeMutableBytes { bytes in
                Darwin.read(handle.fileDescriptor, bytes.baseAddress, bytes.count)
            }
            if count > 0 {
                continue
            }
            if count == 0 {
                return true
            }
            if errno == EINTR { continue }
            if errno == EAGAIN || errno == EWOULDBLOCK {
                return false
            }
            return true
        }
    }

    private static func setNonBlocking(_ handle: FileHandle) {
        let descriptor = handle.fileDescriptor
        let flags = Darwin.fcntl(descriptor, F_GETFL)
        if flags >= 0 {
            _ = Darwin.fcntl(descriptor, F_SETFL, flags | O_NONBLOCK)
        }
    }
}
