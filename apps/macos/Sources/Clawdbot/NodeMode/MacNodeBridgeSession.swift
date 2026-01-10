import ClawdbotKit
import Foundation
import Network
import OSLog

actor MacNodeBridgeSession {
    private struct TimeoutError: LocalizedError {
        var message: String
        var errorDescription: String? { self.message }
    }

    enum State: Sendable, Equatable {
        case idle
        case connecting
        case connected(serverName: String)
        case failed(message: String)
    }

    private let logger = Logger(subsystem: "com.clawdbot", category: "node.bridge-session")
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private let clock = ContinuousClock()
    private var disconnectHandler: (@Sendable (String) async -> Void)?

    private var connection: NWConnection?
    private var queue: DispatchQueue?
    private var buffer = Data()
    private var pendingRPC: [String: CheckedContinuation<BridgeRPCResponse, Error>] = [:]
    private var serverEventSubscribers: [UUID: AsyncStream<BridgeEventFrame>.Continuation] = [:]
    private var invokeTasks: [UUID: Task<Void, Never>] = [:]
    private var pingTask: Task<Void, Never>?
    private var lastPongAt: ContinuousClock.Instant?

    private(set) var state: State = .idle

    func connect(
        endpoint: NWEndpoint,
        hello: BridgeHello,
        onConnected: (@Sendable (String) async -> Void)? = nil,
        onDisconnected: (@Sendable (String) async -> Void)? = nil,
        onInvoke: @escaping @Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse)
        async throws
    {
        await self.disconnect()
        self.disconnectHandler = onDisconnected
        self.state = .connecting

        let params = NWParameters.tcp
        params.includePeerToPeer = true
        let tcpOptions = NWProtocolTCP.Options()
        tcpOptions.enableKeepalive = true
        tcpOptions.keepaliveIdle = 30
        tcpOptions.keepaliveInterval = 15
        tcpOptions.keepaliveCount = 3
        params.defaultProtocolStack.transportProtocol = tcpOptions
        let connection = NWConnection(to: endpoint, using: params)
        let queue = DispatchQueue(label: "com.clawdbot.macos.bridge-session")
        self.connection = connection
        self.queue = queue

        let stateStream = Self.makeStateStream(for: connection)
        connection.start(queue: queue)

        try await Self.waitForReady(stateStream, timeoutSeconds: 6)
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            Task { await self.handleConnectionState(state) }
        }

        try await AsyncTimeout.withTimeout(
            seconds: 6,
            onTimeout: {
                TimeoutError(message: "operation timed out")
            },
            operation: {
                try await self.send(hello)
            })

        guard let line = try await AsyncTimeout.withTimeout(
            seconds: 6,
            onTimeout: {
                TimeoutError(message: "operation timed out")
            },
            operation: {
                try await self.receiveLine()
            }),
            let data = line.data(using: .utf8),
            let base = try? self.decoder.decode(BridgeBaseFrame.self, from: data)
        else {
            self.logger.error("node bridge hello failed (unexpected response)")
            await self.disconnect()
            throw NSError(domain: "Bridge", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Unexpected bridge response",
            ])
        }

        if base.type == "hello-ok" {
            let ok = try self.decoder.decode(BridgeHelloOk.self, from: data)
            self.state = .connected(serverName: ok.serverName)
            self.startPingLoop()
            await onConnected?(ok.serverName)
        } else if base.type == "error" {
            let err = try self.decoder.decode(BridgeErrorFrame.self, from: data)
            self.state = .failed(message: "\(err.code): \(err.message)")
            self.logger.error("node bridge hello error: \(err.code, privacy: .public)")
            await self.disconnect()
            throw NSError(domain: "Bridge", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "\(err.code): \(err.message)",
            ])
        } else {
            self.state = .failed(message: "Unexpected bridge response")
            self.logger.error("node bridge hello failed (unexpected frame)")
            await self.disconnect()
            throw NSError(domain: "Bridge", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "Unexpected bridge response",
            ])
        }

        do {
            while true {
                guard let next = try await self.receiveLine() else { break }
                guard let nextData = next.data(using: .utf8) else { continue }
                guard let nextBase = try? self.decoder.decode(BridgeBaseFrame.self, from: nextData) else { continue }

                switch nextBase.type {
                case "res":
                    let res = try self.decoder.decode(BridgeRPCResponse.self, from: nextData)
                    if let cont = self.pendingRPC.removeValue(forKey: res.id) {
                        cont.resume(returning: res)
                    }

                case "event":
                    let evt = try self.decoder.decode(BridgeEventFrame.self, from: nextData)
                    self.broadcastServerEvent(evt)

                case "ping":
                    let ping = try self.decoder.decode(BridgePing.self, from: nextData)
                    try await self.send(BridgePong(type: "pong", id: ping.id))

                case "pong":
                    let pong = try self.decoder.decode(BridgePong.self, from: nextData)
                    self.notePong(pong)

                case "invoke":
                    let req = try self.decoder.decode(BridgeInvokeRequest.self, from: nextData)
                    let taskID = UUID()
                    let task = Task { [weak self] in
                        let res = await onInvoke(req)
                        guard let self else { return }
                        await self.sendInvokeResponse(res, taskID: taskID)
                    }
                    self.invokeTasks[taskID] = task

                default:
                    continue
                }
            }

            await self.handleDisconnect(reason: "connection closed")
        } catch {
            self.logger.error(
                "node bridge receive failed: \(error.localizedDescription, privacy: .public)")
            await self.handleDisconnect(reason: "receive failed")
            throw error
        }
    }

    func sendEvent(event: String, payloadJSON: String?) async throws {
        try await self.send(BridgeEventFrame(type: "event", event: event, payloadJSON: payloadJSON))
    }

    func request(method: String, paramsJSON: String?, timeoutSeconds: Int = 15) async throws -> Data {
        guard self.connection != nil else {
            throw NSError(domain: "Bridge", code: 11, userInfo: [
                NSLocalizedDescriptionKey: "not connected",
            ])
        }

        let id = UUID().uuidString
        let req = BridgeRPCRequest(type: "req", id: id, method: method, paramsJSON: paramsJSON)

        let timeoutTask = Task {
            try await Task.sleep(nanoseconds: UInt64(timeoutSeconds) * 1_000_000_000)
            await self.timeoutRPC(id: id)
        }
        defer { timeoutTask.cancel() }

        let res: BridgeRPCResponse = try await withCheckedThrowingContinuation { cont in
            Task { [weak self] in
                guard let self else { return }
                await self.beginRPC(id: id, request: req, continuation: cont)
            }
        }

        if res.ok {
            let payload = res.payloadJSON ?? ""
            guard let data = payload.data(using: .utf8) else {
                throw NSError(domain: "Bridge", code: 12, userInfo: [
                    NSLocalizedDescriptionKey: "Bridge response not UTF-8",
                ])
            }
            return data
        }

        let code = res.error?.code ?? "UNAVAILABLE"
        let message = res.error?.message ?? "request failed"
        throw NSError(domain: "Bridge", code: 13, userInfo: [
            NSLocalizedDescriptionKey: "\(code): \(message)",
        ])
    }

    func subscribeServerEvents(bufferingNewest: Int = 200) -> AsyncStream<BridgeEventFrame> {
        let id = UUID()
        let session = self
        return AsyncStream(bufferingPolicy: .bufferingNewest(bufferingNewest)) { continuation in
            self.serverEventSubscribers[id] = continuation
            continuation.onTermination = { @Sendable _ in
                Task { await session.removeServerEventSubscriber(id) }
            }
        }
    }

    func disconnect() async {
        self.pingTask?.cancel()
        self.pingTask = nil
        self.lastPongAt = nil
        self.disconnectHandler = nil
        self.cancelInvokeTasks()

        self.connection?.cancel()
        self.connection = nil
        self.queue = nil
        self.buffer = Data()

        let pending = self.pendingRPC.values
        self.pendingRPC.removeAll()
        for cont in pending {
            cont.resume(throwing: NSError(domain: "Bridge", code: 14, userInfo: [
                NSLocalizedDescriptionKey: "UNAVAILABLE: connection closed",
            ]))
        }

        for (_, cont) in self.serverEventSubscribers {
            cont.finish()
        }
        self.serverEventSubscribers.removeAll()

        self.state = .idle
    }

    private func beginRPC(
        id: String,
        request: BridgeRPCRequest,
        continuation: CheckedContinuation<BridgeRPCResponse, Error>) async
    {
        self.pendingRPC[id] = continuation
        do {
            try await self.send(request)
        } catch {
            await self.failRPC(id: id, error: error)
        }
    }

    private func failRPC(id: String, error: Error) async {
        if let cont = self.pendingRPC.removeValue(forKey: id) {
            cont.resume(throwing: error)
        }
    }

    private func timeoutRPC(id: String) async {
        if let cont = self.pendingRPC.removeValue(forKey: id) {
            cont.resume(throwing: TimeoutError(message: "request timed out"))
        }
    }

    private func removeServerEventSubscriber(_ id: UUID) {
        self.serverEventSubscribers[id] = nil
    }

    private func broadcastServerEvent(_ evt: BridgeEventFrame) {
        for (_, cont) in self.serverEventSubscribers {
            cont.yield(evt)
        }
    }

    private func send(_ obj: some Encodable) async throws {
        guard let connection = self.connection else {
            throw NSError(domain: "Bridge", code: 15, userInfo: [
                NSLocalizedDescriptionKey: "not connected",
            ])
        }
        let data = try self.encoder.encode(obj)
        var line = Data()
        line.append(data)
        line.append(0x0A)
        try await withCheckedThrowingContinuation(isolation: self) { (cont: CheckedContinuation<Void, Error>) in
            connection.send(content: line, completion: .contentProcessed { err in
                if let err { cont.resume(throwing: err) } else { cont.resume(returning: ()) }
            })
        }
    }

    private func receiveLine() async throws -> String? {
        while true {
            if let idx = self.buffer.firstIndex(of: 0x0A) {
                let line = self.buffer.prefix(upTo: idx)
                self.buffer.removeSubrange(...idx)
                return String(data: line, encoding: .utf8)
            }
            let chunk = try await self.receiveChunk()
            if chunk.isEmpty { return nil }
            self.buffer.append(chunk)
        }
    }

    private func receiveChunk() async throws -> Data {
        guard let connection else { return Data() }
        return try await withCheckedThrowingContinuation(isolation: self) { (cont: CheckedContinuation<Data, Error>) in
            connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, isComplete, error in
                if let error {
                    cont.resume(throwing: error)
                    return
                }
                if isComplete {
                    cont.resume(returning: Data())
                    return
                }
                cont.resume(returning: data ?? Data())
            }
        }
    }

    private func startPingLoop() {
        self.pingTask?.cancel()
        self.lastPongAt = self.clock.now
        self.logger.debug("node bridge ping loop started")
        self.pingTask = Task { [weak self] in
            guard let self else { return }
            await self.runPingLoop()
        }
    }

    private func runPingLoop() async {
        let interval: Duration = .seconds(15)
        let timeout: Duration = .seconds(45)

        while !Task.isCancelled {
            try? await Task.sleep(for: interval)

            guard self.connection != nil else { return }

            if let last = self.lastPongAt {
                let now = self.clock.now
                if now > last.advanced(by: timeout) {
                    let age = last.duration(to: now)
                    let ageDescription = String(describing: age)
                    let message =
                        "Node bridge heartbeat timed out; disconnecting " +
                        "(age: \(ageDescription, privacy: .public))."
                    self.logger.warning(message)
                    await self.handleDisconnect(reason: "ping timeout")
                    return
                }
            }

            let id = UUID().uuidString
            do {
                try await self.send(BridgePing(type: "ping", id: id))
            } catch {
                let errorDescription = String(describing: error)
                let message =
                    "Node bridge ping send failed; disconnecting " +
                    "(error: \(errorDescription, privacy: .public))."
                self.logger.warning(message)
                await self.handleDisconnect(reason: "ping send failed")
                return
            }
        }
    }

    private func notePong(_ pong: BridgePong) {
        _ = pong
        self.lastPongAt = self.clock.now
    }

    private func handleConnectionState(_ state: NWConnection.State) async {
        switch state {
        case let .failed(error):
            let errorDescription = String(describing: error)
            let message =
                "Node bridge connection failed; disconnecting " +
                "(error: \(errorDescription, privacy: .public))."
            self.logger.warning(message)
            await self.handleDisconnect(reason: "connection failed")
        case .cancelled:
            self.logger.warning("Node bridge connection cancelled; disconnecting.")
            await self.handleDisconnect(reason: "connection cancelled")
        default:
            break
        }
    }

    private func handleDisconnect(reason: String) async {
        self.logger.info("node bridge disconnect reason=\(reason, privacy: .public)")
        if let handler = self.disconnectHandler {
            await handler(reason)
        }
        await self.disconnect()
    }

    private func logInvokeSendFailure(_ error: Error) {
        self.logger.error(
            "node bridge invoke response send failed: \(error.localizedDescription, privacy: .public)")
    }

    private func sendInvokeResponse(_ response: BridgeInvokeResponse, taskID: UUID) async {
        defer { self.invokeTasks[taskID] = nil }
        if Task.isCancelled { return }
        do {
            try await self.send(response)
        } catch {
            await self.logInvokeSendFailure(error)
        }
    }

    private func cancelInvokeTasks() {
        for task in self.invokeTasks.values {
            task.cancel()
        }
        self.invokeTasks.removeAll()
    }

    private static func makeStateStream(
        for connection: NWConnection) -> AsyncStream<NWConnection.State>
    {
        AsyncStream { continuation in
            connection.stateUpdateHandler = { state in
                continuation.yield(state)
                switch state {
                case .ready, .failed, .cancelled:
                    continuation.finish()
                default:
                    break
                }
            }
        }
    }

    private static func waitForReady(
        _ stream: AsyncStream<NWConnection.State>,
        timeoutSeconds: Double) async throws
    {
        try await AsyncTimeout.withTimeout(
            seconds: timeoutSeconds,
            onTimeout: {
                TimeoutError(message: "operation timed out")
            },
            operation: {
                for await state in stream {
                    switch state {
                    case .ready:
                        return
                    case let .failed(err):
                        throw err
                    case .cancelled:
                        throw NSError(domain: "Bridge", code: 20, userInfo: [
                            NSLocalizedDescriptionKey: "Connection cancelled",
                        ])
                    default:
                        continue
                    }
                }
                throw NSError(domain: "Bridge", code: 21, userInfo: [
                    NSLocalizedDescriptionKey: "Connection closed",
                ])
            })
    }
}
