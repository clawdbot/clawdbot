import ClawdbotKit
import Foundation
import Network
import OSLog

struct BridgeNodeInfo: Sendable {
    var nodeId: String
    var displayName: String?
    var platform: String?
    var version: String?
    var deviceFamily: String?
    var modelIdentifier: String?
    var remoteAddress: String?
    var caps: [String]?
}

actor BridgeConnectionHandler {
    private let connection: NWConnection
    private let logger: Logger
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private let queue = DispatchQueue(label: "com.clawdbot.bridge.connection")

    private var buffer = Data()
    private var isAuthenticated = false
    private var nodeId: String?
    private var pendingInvokes: [String: CheckedContinuation<BridgeInvokeResponse, Error>] = [:]
    private var isClosed = false

    init(connection: NWConnection, logger: Logger) {
        self.connection = connection
        self.logger = logger
    }

    enum AuthResult: Sendable {
        case ok
        case notPaired
        case unauthorized
        case error(code: String, message: String)
    }

    enum PairResult: Sendable {
        case ok(token: String)
        case rejected
        case error(code: String, message: String)
    }

    private struct FrameContext: Sendable {
        var serverName: String
        var resolveAuth: @Sendable (BridgeHello) async -> AuthResult
        var handlePair: @Sendable (BridgePairRequest) async -> PairResult
        var onAuthenticated: (@Sendable (BridgeNodeInfo) async -> Void)?
        var onEvent: (@Sendable (String, BridgeEventFrame) async -> Void)?
        var onRequest: (@Sendable (String, BridgeRPCRequest) async -> BridgeRPCResponse)?
    }

    func run(
        resolveAuth: @escaping @Sendable (BridgeHello) async -> AuthResult,
        handlePair: @escaping @Sendable (BridgePairRequest) async -> PairResult,
        onAuthenticated: (@Sendable (BridgeNodeInfo) async -> Void)? = nil,
        onDisconnected: (@Sendable (String) async -> Void)? = nil,
        onEvent: (@Sendable (String, BridgeEventFrame) async -> Void)? = nil,
        onRequest: (@Sendable (String, BridgeRPCRequest) async -> BridgeRPCResponse)? = nil) async
    {
        self.configureStateLogging()
        self.connection.start(queue: self.queue)

        let context = FrameContext(
            serverName: Host.current().localizedName ?? ProcessInfo.processInfo.hostName,
            resolveAuth: resolveAuth,
            handlePair: handlePair,
            onAuthenticated: onAuthenticated,
            onEvent: onEvent,
            onRequest: onRequest)

        while true {
            do {
                guard let line = try await self.receiveLine() else { break }
                guard let data = line.data(using: .utf8) else { continue }
                let base = try self.decoder.decode(BridgeBaseFrame.self, from: data)
                try await self.handleFrame(
                    baseType: base.type,
                    data: data,
                    context: context)
            } catch {
                await self.sendError(code: "INVALID_REQUEST", message: error.localizedDescription)
            }
        }

        await self.close(with: onDisconnected)
    }

    private func configureStateLogging() {
        self.connection.stateUpdateHandler = { [logger] state in
            switch state {
            case .ready:
                logger.debug("bridge conn ready")
            case let .failed(err):
                logger.error("bridge conn failed: \(err.localizedDescription, privacy: .public)")
            default:
                break
            }
        }
    }

    private func handleFrame(
        baseType: String,
        data: Data,
        context: FrameContext) async throws
    {
        switch baseType {
        case "hello":
            await self.handleHelloFrame(
                data: data,
                context: context)
        case "pair-request":
            await self.handlePairRequestFrame(
                data: data,
                context: context)
        case "event":
            await self.handleEventFrame(data: data, onEvent: context.onEvent)
        case "req":
            try await self.handleRPCRequestFrame(data: data, onRequest: context.onRequest)
        case "ping":
            try await self.handlePingFrame(data: data)
        case "invoke-res":
            await self.handleInvokeResponseFrame(data: data)
        default:
            await self.sendError(code: "INVALID_REQUEST", message: "unknown type")
        }
    }

    private func handleHelloFrame(
        data: Data,
        context: FrameContext) async
    {
        do {
            let hello = try self.decoder.decode(BridgeHello.self, from: data)
            let nodeId = hello.nodeId.trimmingCharacters(in: .whitespacesAndNewlines)
            self.nodeId = nodeId
            let result = await context.resolveAuth(hello)
            await self.handleAuthResult(result, serverName: context.serverName)
            if case .ok = result {
                await context.onAuthenticated?(
                    BridgeNodeInfo(
                        nodeId: nodeId,
                        displayName: hello.displayName,
                        platform: hello.platform,
                        version: hello.version,
                        deviceFamily: hello.deviceFamily,
                        modelIdentifier: hello.modelIdentifier,
                        remoteAddress: self.remoteAddressString(),
                        caps: hello.caps))
            }
        } catch {
            await self.sendError(code: "INVALID_REQUEST", message: error.localizedDescription)
        }
    }

    private func handlePairRequestFrame(
        data: Data,
        context: FrameContext) async
    {
        do {
            let req = try self.decoder.decode(BridgePairRequest.self, from: data)
            let nodeId = req.nodeId.trimmingCharacters(in: .whitespacesAndNewlines)
            self.nodeId = nodeId
            let enriched = BridgePairRequest(
                type: req.type,
                nodeId: nodeId,
                displayName: req.displayName,
                platform: req.platform,
                version: req.version,
                deviceFamily: req.deviceFamily,
                modelIdentifier: req.modelIdentifier,
                caps: req.caps,
                commands: req.commands,
                remoteAddress: self.remoteAddressString(),
                silent: req.silent)
            let result = await context.handlePair(enriched)
            await self.handlePairResult(result, serverName: context.serverName)
            if case .ok = result {
                await context.onAuthenticated?(
                    BridgeNodeInfo(
                        nodeId: nodeId,
                        displayName: enriched.displayName,
                        platform: enriched.platform,
                        version: enriched.version,
                        deviceFamily: enriched.deviceFamily,
                        modelIdentifier: enriched.modelIdentifier,
                        remoteAddress: enriched.remoteAddress,
                        caps: enriched.caps))
            }
        } catch {
            await self.sendError(code: "INVALID_REQUEST", message: error.localizedDescription)
        }
    }

    private func handleEventFrame(
        data: Data,
        onEvent: (@Sendable (String, BridgeEventFrame) async -> Void)?) async
    {
        guard self.isAuthenticated, let nodeId = self.nodeId else {
            await self.sendError(code: "UNAUTHORIZED", message: "not authenticated")
            return
        }
        do {
            let evt = try self.decoder.decode(BridgeEventFrame.self, from: data)
            await onEvent?(nodeId, evt)
        } catch {
            await self.sendError(code: "INVALID_REQUEST", message: error.localizedDescription)
        }
    }

    private func handleRPCRequestFrame(
        data: Data,
        onRequest: (@Sendable (String, BridgeRPCRequest) async -> BridgeRPCResponse)?) async throws
    {
        let req = try self.decoder.decode(BridgeRPCRequest.self, from: data)
        guard self.isAuthenticated, let nodeId = self.nodeId else {
            try await self.send(
                BridgeRPCResponse(
                    id: req.id,
                    ok: false,
                    error: BridgeRPCError(code: "UNAUTHORIZED", message: "not authenticated")))
            return
        }

        if let onRequest {
            let res = await onRequest(nodeId, req)
            try await self.send(res)
        } else {
            try await self.send(
                BridgeRPCResponse(
                    id: req.id,
                    ok: false,
                    error: BridgeRPCError(code: "UNAVAILABLE", message: "RPC not supported")))
        }
    }

    private func handlePingFrame(data: Data) async throws {
        guard self.isAuthenticated else {
            await self.sendError(code: "UNAUTHORIZED", message: "not authenticated")
            return
        }
        let ping = try self.decoder.decode(BridgePing.self, from: data)
        try await self.send(BridgePong(type: "pong", id: ping.id))
    }

    private func handleInvokeResponseFrame(data: Data) async {
        guard self.isAuthenticated else {
            await self.sendError(code: "UNAUTHORIZED", message: "not authenticated")
            return
        }
        do {
            let res = try self.decoder.decode(BridgeInvokeResponse.self, from: data)
            if let cont = self.pendingInvokes.removeValue(forKey: res.id) {
                cont.resume(returning: res)
            }
        } catch {
            await self.sendError(code: "INVALID_REQUEST", message: error.localizedDescription)
        }
    }

    private func remoteAddressString() -> String? {
        switch self.connection.endpoint {
        case let .hostPort(host: host, port: _):
            let value = String(describing: host)
            return value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : value
        default:
            return nil
        }
    }

    func remoteAddress() -> String? {
        self.remoteAddressString()
    }

    private func handlePairResult(_ result: PairResult, serverName: String) async {
        switch result {
        case let .ok(token):
            do {
                try await self.send(BridgePairOk(type: "pair-ok", token: token))
                self.isAuthenticated = true
                let mainSessionKey = await GatewayConnection.shared.mainSessionKey()
                try await self.send(
                    BridgeHelloOk(
                        type: "hello-ok",
                        serverName: serverName,
                        mainSessionKey: mainSessionKey))
            } catch {
                self.logger.error("bridge send pair-ok failed: \(error.localizedDescription, privacy: .public)")
            }
        case .rejected:
            await self.sendError(code: "UNAUTHORIZED", message: "pairing rejected")
        case let .error(code, message):
            await self.sendError(code: code, message: message)
        }
    }

    private func handleAuthResult(_ result: AuthResult, serverName: String) async {
        switch result {
        case .ok:
            self.isAuthenticated = true
            do {
                let mainSessionKey = await GatewayConnection.shared.mainSessionKey()
                try await self.send(
                    BridgeHelloOk(
                        type: "hello-ok",
                        serverName: serverName,
                        mainSessionKey: mainSessionKey))
            } catch {
                self.logger.error("bridge send hello-ok failed: \(error.localizedDescription, privacy: .public)")
            }
        case .notPaired:
            await self.sendError(code: "NOT_PAIRED", message: "pairing required")
        case .unauthorized:
            await self.sendError(code: "UNAUTHORIZED", message: "invalid token")
        case let .error(code, message):
            await self.sendError(code: code, message: message)
        }
    }

    private func sendError(code: String, message: String) async {
        do {
            try await self.send(BridgeErrorFrame(type: "error", code: code, message: message))
        } catch {
            self.logger.error("bridge send error failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    func invoke(command: String, paramsJSON: String?) async throws -> BridgeInvokeResponse {
        guard self.isAuthenticated else {
            throw NSError(domain: "Bridge", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "UNAUTHORIZED: not authenticated",
            ])
        }
        let id = UUID().uuidString
        let req = BridgeInvokeRequest(type: "invoke", id: id, command: command, paramsJSON: paramsJSON)

        let timeoutTask = Task {
            try await Task.sleep(nanoseconds: 15 * 1_000_000_000)
            await self.timeoutInvoke(id: id)
        }
        defer { timeoutTask.cancel() }

        return try await withCheckedThrowingContinuation { cont in
            Task { [weak self] in
                guard let self else { return }
                await self.beginInvoke(id: id, request: req, continuation: cont)
            }
        }
    }

    private func beginInvoke(
        id: String,
        request: BridgeInvokeRequest,
        continuation: CheckedContinuation<BridgeInvokeResponse, Error>) async
    {
        self.pendingInvokes[id] = continuation
        do {
            try await self.send(request)
        } catch {
            await self.failInvoke(id: id, error: error)
        }
    }

    private func timeoutInvoke(id: String) async {
        guard let cont = self.pendingInvokes.removeValue(forKey: id) else { return }
        cont.resume(throwing: NSError(domain: "Bridge", code: 3, userInfo: [
            NSLocalizedDescriptionKey: "UNAVAILABLE: invoke timeout",
        ]))
    }

    private func failInvoke(id: String, error: Error) async {
        guard let cont = self.pendingInvokes.removeValue(forKey: id) else { return }
        cont.resume(throwing: error)
    }

    private func send(_ obj: some Encodable) async throws {
        let data = try self.encoder.encode(obj)
        var line = Data()
        line.append(data)
        line.append(0x0A) // \n
        let _: Void = try await withCheckedThrowingContinuation { cont in
            self.connection.send(content: line, completion: .contentProcessed { err in
                if let err {
                    cont.resume(throwing: err)
                } else {
                    cont.resume(returning: ())
                }
            })
        }
    }

    func sendServerEvent(event: String, payloadJSON: String?) async {
        guard self.isAuthenticated else { return }
        do {
            try await self.send(BridgeEventFrame(type: "event", event: event, payloadJSON: payloadJSON))
        } catch {
            self.logger.error("bridge send event failed: \(error.localizedDescription, privacy: .public)")
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
        try await withCheckedThrowingContinuation { cont in
            self.connection
                .receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, isComplete, error in
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

    private func close(with onDisconnected: (@Sendable (String) async -> Void)? = nil) async {
        if self.isClosed { return }
        self.isClosed = true

        let nodeId = self.nodeId
        let pending = self.pendingInvokes.values
        self.pendingInvokes.removeAll()
        for cont in pending {
            cont.resume(throwing: NSError(domain: "Bridge", code: 4, userInfo: [
                NSLocalizedDescriptionKey: "UNAVAILABLE: connection closed",
            ]))
        }

        self.connection.cancel()
        if let nodeId {
            await onDisconnected?(nodeId)
        }
    }
}
