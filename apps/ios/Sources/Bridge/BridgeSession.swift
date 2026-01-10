import ClawdbotKit
import Foundation
import Network

actor BridgeSession {
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

    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    private var connection: NWConnection?
    private var queue: DispatchQueue?
    private var buffer = Data()
    private var pendingRPC: [String: CheckedContinuation<BridgeRPCResponse, Error>] = [:]
    private var serverEventSubscribers: [UUID: AsyncStream<BridgeEventFrame>.Continuation] = [:]

    private(set) var state: State = .idle
    private var canvasHostUrl: String?

    func currentCanvasHostUrl() -> String? {
        self.canvasHostUrl
    }

    func currentRemoteAddress() -> String? {
        guard let endpoint = self.connection?.currentPath?.remoteEndpoint else { return nil }
        return Self.prettyRemoteEndpoint(endpoint)
    }

    private static func prettyRemoteEndpoint(_ endpoint: NWEndpoint) -> String? {
        switch endpoint {
        case let .hostPort(host, port):
            let hostString = Self.prettyHostString(host)
            if hostString.contains(":") {
                return "[\(hostString)]:\(port)"
            }
            return "\(hostString):\(port)"
        default:
            return String(describing: endpoint)
        }
    }

    private static func prettyHostString(_ host: NWEndpoint.Host) -> String {
        var hostString = String(describing: host)
        hostString = hostString.replacingOccurrences(of: "::ffff:", with: "")

        guard let percentIndex = hostString.firstIndex(of: "%") else { return hostString }

        let prefix = hostString[..<percentIndex]
        let allowed = CharacterSet(charactersIn: "0123456789abcdefABCDEF:.")
        let isIPAddressPrefix = prefix.unicodeScalars.allSatisfy { allowed.contains($0) }
        if isIPAddressPrefix {
            return String(prefix)
        }

        return hostString
    }

    func connect(
        endpoint: NWEndpoint,
        hello: BridgeHello,
        onConnected: (@Sendable (String) async -> Void)? = nil,
        onInvoke: @escaping @Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse)
        async throws
    {
        await self.disconnect()
        self.state = .connecting

        let params = NWParameters.tcp
        params.includePeerToPeer = true
        let connection = NWConnection(to: endpoint, using: params)
        let queue = DispatchQueue(label: "com.clawdbot.ios.bridge-session")
        self.connection = connection
        self.queue = queue

        let stateStream = Self.makeStateStream(for: connection)
        connection.start(queue: queue)

        try await Self.waitForReady(stateStream, timeoutSeconds: 6)

        try await Self.withTimeout(seconds: 6) {
            try await self.send(hello)
        }

        guard let line = try await Self.withTimeout(seconds: 6, operation: {
            try await self.receiveLine()
        }),
            let data = line.data(using: .utf8),
            let base = try? self.decoder.decode(BridgeBaseFrame.self, from: data)
        else {
            await self.disconnect()
            throw NSError(domain: "Bridge", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Unexpected bridge response",
            ])
        }

        if base.type == "hello-ok" {
            let ok = try self.decoder.decode(BridgeHelloOk.self, from: data)
            self.state = .connected(serverName: ok.serverName)
            self.canvasHostUrl = ok.canvasHostUrl?.trimmingCharacters(in: .whitespacesAndNewlines)
            await onConnected?(ok.serverName)
        } else if base.type == "error" {
            let err = try self.decoder.decode(BridgeErrorFrame.self, from: data)
            self.state = .failed(message: "\(err.code): \(err.message)")
            await self.disconnect()
            throw NSError(domain: "Bridge", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "\(err.code): \(err.message)",
            ])
        } else {
            self.state = .failed(message: "Unexpected bridge response")
            await self.disconnect()
            throw NSError(domain: "Bridge", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "Unexpected bridge response",
            ])
        }

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

            case "invoke":
                let req = try self.decoder.decode(BridgeInvokeRequest.self, from: nextData)
                let res = await onInvoke(req)
                try await self.send(res)

            default:
                continue
            }
        }

        await self.disconnect()
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
        self.connection?.cancel()
        self.connection = nil
        self.queue = nil
        self.buffer = Data()
        self.canvasHostUrl = nil

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

    private func timeoutRPC(id: String) async {
        guard let cont = self.pendingRPC.removeValue(forKey: id) else { return }
        cont.resume(throwing: NSError(domain: "Bridge", code: 15, userInfo: [
            NSLocalizedDescriptionKey: "UNAVAILABLE: request timeout",
        ]))
    }

    private func failRPC(id: String, error: Error) async {
        guard let cont = self.pendingRPC.removeValue(forKey: id) else { return }
        cont.resume(throwing: error)
    }

    private func broadcastServerEvent(_ evt: BridgeEventFrame) {
        for (_, cont) in self.serverEventSubscribers {
            cont.yield(evt)
        }
    }

    private func removeServerEventSubscriber(_ id: UUID) {
        self.serverEventSubscribers[id] = nil
    }

    private func send(_ obj: some Encodable) async throws {
        guard let connection = self.connection else {
            throw NSError(domain: "Bridge", code: 10, userInfo: [
                NSLocalizedDescriptionKey: "not connected",
            ])
        }
        let data = try self.encoder.encode(obj)
        var line = Data()
        line.append(data)
        line.append(0x0A)
        try await withCheckedThrowingContinuation(isolation: nil) { (cont: CheckedContinuation<Void, Error>) in
            connection.send(content: line, completion: .contentProcessed { err in
                if let err { cont.resume(throwing: err) } else { cont.resume(returning: ()) }
            })
        }
    }

    private func receiveLine() async throws -> String? {
        while true {
            if let idx = self.buffer.firstIndex(of: 0x0A) {
                let lineData = self.buffer.prefix(upTo: idx)
                self.buffer.removeSubrange(...idx)
                return String(data: lineData, encoding: .utf8)
            }

            let chunk = try await self.receiveChunk()
            if chunk.isEmpty { return nil }
            self.buffer.append(chunk)
        }
    }

    private func receiveChunk() async throws -> Data {
        guard let connection = self.connection else { return Data() }
        return try await withCheckedThrowingContinuation(isolation: nil) { (cont: CheckedContinuation<Data, Error>) in
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

    private static func withTimeout<T: Sendable>(
        seconds: Double,
        operation: @escaping @Sendable () async throws -> T) async throws -> T
    {
        try await AsyncTimeout.withTimeout(
            seconds: seconds,
            onTimeout: { TimeoutError(message: "UNAVAILABLE: connection timeout") },
            operation: operation)
    }

    private static func makeStateStream(for connection: NWConnection) -> AsyncStream<NWConnection.State> {
        AsyncStream { continuation in
            continuation.onTermination = { @Sendable _ in
                connection.stateUpdateHandler = nil
            }

            connection.stateUpdateHandler = { state in
                continuation.yield(state)
                switch state {
                case .ready, .cancelled, .failed, .waiting:
                    continuation.finish()
                case .setup, .preparing:
                    break
                @unknown default:
                    break
                }
            }
        }
    }

    private static func waitForReady(
        _ stateStream: AsyncStream<NWConnection.State>,
        timeoutSeconds: Double) async throws
    {
        try await self.withTimeout(seconds: timeoutSeconds) {
            for await state in stateStream {
                switch state {
                case .ready:
                    return
                case let .failed(error):
                    throw error
                case let .waiting(error):
                    throw error
                case .cancelled:
                    throw TimeoutError(message: "UNAVAILABLE: connection cancelled")
                case .setup, .preparing:
                    break
                @unknown default:
                    break
                }
            }

            throw TimeoutError(message: "UNAVAILABLE: connection ended")
        }
    }
}
