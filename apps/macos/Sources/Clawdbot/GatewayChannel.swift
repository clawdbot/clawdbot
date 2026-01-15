import ClawdbotKit
import ClawdbotProtocol
import Foundation
import OSLog

protocol WebSocketTasking: AnyObject {
    var state: URLSessionTask.State { get }
    func resume()
    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?)
    func send(_ message: URLSessionWebSocketTask.Message) async throws
    func receive() async throws -> URLSessionWebSocketTask.Message
    func receive(completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
}

extension URLSessionWebSocketTask: WebSocketTasking {}

struct WebSocketTaskBox: @unchecked Sendable {
    let task: any WebSocketTasking

    var state: URLSessionTask.State { self.task.state }

    func resume() { self.task.resume() }

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        self.task.cancel(with: closeCode, reason: reason)
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        try await self.task.send(message)
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        try await self.task.receive()
    }

    func receive(completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void) {
        self.task.receive(completionHandler: completionHandler)
    }
}

protocol WebSocketSessioning: AnyObject {
    func makeWebSocketTask(url: URL) -> WebSocketTaskBox
}

extension URLSession: WebSocketSessioning {
    func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
        let task = self.webSocketTask(with: url)
        // Avoid "Message too long" receive errors for large snapshots / history payloads.
        task.maximumMessageSize = 16 * 1024 * 1024 // 16 MB
        return WebSocketTaskBox(task: task)
    }
}

struct WebSocketSessionBox: @unchecked Sendable {
    let session: any WebSocketSessioning
}

// Avoid ambiguity with the app's own AnyCodable type.
private typealias ProtoAnyCodable = ClawdbotProtocol.AnyCodable

actor GatewayChannelActor {
    private let logger = Logger(subsystem: "com.clawdbot", category: "gateway")
    private var task: WebSocketTaskBox?
    private var pending: [String: CheckedContinuation<GatewayFrame, Error>] = [:]
    private var connected = false
    private var isConnecting = false
    private var connectWaiters: [CheckedContinuation<Void, Error>] = []
    private var url: URL
    private var token: String?
    private var password: String?
    private let session: WebSocketSessioning
    private var backoffMs: Double = 500
    private var shouldReconnect = true
    private var lastSeq: Int?
    private var lastTick: Date?
    private var tickIntervalMs: Double = 30000
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private let connectTimeoutSeconds: Double = 6
    private var watchdogTask: Task<Void, Never>?
    private var tickTask: Task<Void, Never>?
    private let defaultRequestTimeoutMs: Double = 15000
    private let pushHandler: (@Sendable (GatewayPush) async -> Void)?

    init(
        url: URL,
        token: String?,
        password: String? = nil,
        session: WebSocketSessionBox? = nil,
        pushHandler: (@Sendable (GatewayPush) async -> Void)? = nil)
    {
        self.url = url
        self.token = token
        self.password = password
        self.session = session?.session ?? URLSession(configuration: .default)
        self.pushHandler = pushHandler
        Task { [weak self] in
            await self?.startWatchdog()
        }
    }

    func shutdown() async {
        self.shouldReconnect = false
        self.connected = false

        self.watchdogTask?.cancel()
        self.watchdogTask = nil

        self.tickTask?.cancel()
        self.tickTask = nil

        self.task?.cancel(with: .goingAway, reason: nil)
        self.task = nil

        await self.failPending(NSError(
                                domain: "Gateway",
                                code: 0,
                                userInfo: [NSLocalizedDescriptionKey: "gateway channel shutdown"]))

        let waiters = self.connectWaiters
        self.connectWaiters.removeAll()
        for waiter in waiters {
            waiter.resume(throwing: NSError(
                            domain: "Gateway",
                            code: 0,
                            userInfo: [NSLocalizedDescriptionKey: "gateway channel shutdown"]))
        }
    }

    private func startWatchdog() {
        self.watchdogTask?.cancel()
        self.watchdogTask = Task { [weak self] in
            guard let self else { return }
            await self.watchdogLoop()
        }
    }

    private func watchdogLoop() async {
        // Keep nudging reconnect in case exponential backoff stalls.
        while self.shouldReconnect {
            try? await Task.sleep(nanoseconds: 30 * 1_000_000_000) // 30s cadence
            guard self.shouldReconnect else { return }
            if self.connected { continue }
            do {
                try await self.connect()
            } catch {
                let wrapped = self.wrap(error, context: "gateway watchdog reconnect")
                self.logger.error("gateway watchdog reconnect failed \(wrapped.localizedDescription, privacy: .public)")
            }
        }
    }

    func connect() async throws {
        if self.connected, self.task?.state == .running { return }
        if self.isConnecting {
            try await withCheckedThrowingContinuation { cont in
                self.connectWaiters.append(cont)
            }
            return
        }
        self.isConnecting = true
        defer { self.isConnecting = false }

        self.task?.cancel(with: .goingAway, reason: nil)
        self.task = self.session.makeWebSocketTask(url: self.url)
        self.task?.resume()
        do {
            try await AsyncTimeout.withTimeout(
                seconds: self.connectTimeoutSeconds,
                onTimeout: {
                    NSError(
                        domain: "Gateway",
                        code: 1,
                        userInfo: [NSLocalizedDescriptionKey: "connect timed out"])
                },
                operation: { try await self.sendConnect() })
        } catch {
            let wrapped = self.wrap(error, context: "connect to gateway @ \(self.url.absoluteString)")
            self.connected = false
            self.task?.cancel(with: .goingAway, reason: nil)
            let waiters = self.connectWaiters
            self.connectWaiters.removeAll()
            for waiter in waiters {
                waiter.resume(throwing: wrapped)
            }
            self.logger.error("gateway ws connect failed \(wrapped.localizedDescription, privacy: .public)")
            throw wrapped
        }
        self.listen()
        self.connected = true
        self.backoffMs = 500
        self.lastSeq = nil

        let waiters = self.connectWaiters
        self.connectWaiters.removeAll()
        for waiter in waiters {
            waiter.resume(returning: ())
        }
    }

    private func sendConnect() async throws {
        let osVersion = ProcessInfo.processInfo.operatingSystemVersion
        let platform = "macos \(osVersion.majorVersion).\(osVersion.minorVersion).\(osVersion.patchVersion)"
        let primaryLocale = Locale.preferredLanguages.first ?? Locale.current.identifier
        let clientDisplayName = InstanceIdentity.displayName
        let clientId = "clawdbot-macos"

        let reqId = UUID().uuidString
        var client: [String: ProtoAnyCodable] = [
            "id": ProtoAnyCodable(clientId),
            "displayName": ProtoAnyCodable(clientDisplayName),
            "version": ProtoAnyCodable(
                Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"),
            "platform": ProtoAnyCodable(platform),
            "mode": ProtoAnyCodable("ui"),
            "instanceId": ProtoAnyCodable(InstanceIdentity.instanceId),
        ]
        client["deviceFamily"] = ProtoAnyCodable("Mac")
        if let model = InstanceIdentity.modelIdentifier {
            client["modelIdentifier"] = ProtoAnyCodable(model)
        }
        var params: [String: ProtoAnyCodable] = [
            "minProtocol": ProtoAnyCodable(GATEWAY_PROTOCOL_VERSION),
            "maxProtocol": ProtoAnyCodable(GATEWAY_PROTOCOL_VERSION),
            "client": ProtoAnyCodable(client),
            "caps": ProtoAnyCodable([] as [String]),
            "locale": ProtoAnyCodable(primaryLocale),
            "userAgent": ProtoAnyCodable(ProcessInfo.processInfo.operatingSystemVersionString),
        ]
        if let token = self.token {
            params["auth"] = ProtoAnyCodable(["token": ProtoAnyCodable(token)])
        } else if let password = self.password {
            params["auth"] = ProtoAnyCodable(["password": ProtoAnyCodable(password)])
        }

        let frame = RequestFrame(
            type: "req",
            id: reqId,
            method: "connect",
            params: ProtoAnyCodable(params))
        let data = try self.encoder.encode(frame)
        try await self.task?.send(.data(data))
        guard let msg = try await task?.receive() else {
            throw NSError(
                domain: "Gateway",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "connect failed (no response)"])
        }
        try await self.handleConnectResponse(msg, reqId: reqId)
    }

    private func handleConnectResponse(_ msg: URLSessionWebSocketTask.Message, reqId: String) async throws {
        let data: Data? = switch msg {
        case let .data(d): d
        case let .string(s): s.data(using: .utf8)
        @unknown default: nil
        }
        guard let data else {
            throw NSError(
                domain: "Gateway",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "connect failed (empty response)"])
        }
        let decoder = JSONDecoder()
        guard let frame = try? decoder.decode(GatewayFrame.self, from: data) else {
            throw NSError(
                domain: "Gateway",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "connect failed (invalid response)"])
        }
        guard case let .res(res) = frame, res.id == reqId else {
            throw NSError(
                domain: "Gateway",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "connect failed (unexpected response)"])
        }
        if res.ok == false {
            let msg = (res.error?["message"]?.value as? String) ?? "gateway connect failed"
            throw NSError(domain: "Gateway", code: 1008, userInfo: [NSLocalizedDescriptionKey: msg])
        }
        guard let payload = res.payload else {
            throw NSError(
                domain: "Gateway",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "connect failed (missing payload)"])
        }
        let payloadData = try self.encoder.encode(payload)
        let ok = try decoder.decode(HelloOk.self, from: payloadData)
        if let tick = ok.policy["tickIntervalMs"]?.value as? Double {
            self.tickIntervalMs = tick
        } else if let tick = ok.policy["tickIntervalMs"]?.value as? Int {
            self.tickIntervalMs = Double(tick)
        }
        self.lastTick = Date()
        self.tickTask?.cancel()
        self.tickTask = Task { [weak self] in
            guard let self else { return }
            await self.watchTicks()
        }
        await self.pushHandler?(.snapshot(ok))
    }

    private func listen() {
        self.task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case let .failure(err):
                Task { await self.handleReceiveFailure(err) }
            case let .success(msg):
                Task {
                    await self.handle(msg)
                    await self.listen()
                }
            }
        }
    }

    private func handleReceiveFailure(_ err: Error) async {
        let wrapped = self.wrap(err, context: "gateway receive")
        self.logger.error("gateway ws receive failed \(wrapped.localizedDescription, privacy: .public)")
        self.connected = false
        await self.failPending(wrapped)
        await self.scheduleReconnect()
    }

    private func handle(_ msg: URLSessionWebSocketTask.Message) async {
        let data: Data? = switch msg {
        case let .data(d): d
        case let .string(s): s.data(using: .utf8)
        @unknown default: nil
        }
        guard let data else { return }
        guard let frame = try? self.decoder.decode(GatewayFrame.self, from: data) else {
            self.logger.error("gateway decode failed")
            return
        }
        switch frame {
        case let .res(res):
            let id = res.id
            if let waiter = pending.removeValue(forKey: id) {
                waiter.resume(returning: .res(res))
            }
        case let .event(evt):
            if let seq = evt.seq {
                if let last = lastSeq, seq > last + 1 {
                    await self.pushHandler?(.seqGap(expected: last + 1, received: seq))
                }
                self.lastSeq = seq
            }
            if evt.event == "tick" { self.lastTick = Date() }
            await self.pushHandler?(.event(evt))
        default:
            break
        }
    }

    private func watchTicks() async {
        let tolerance = self.tickIntervalMs * 2
        while self.connected {
            try? await Task.sleep(nanoseconds: UInt64(tolerance * 1_000_000))
            guard self.connected else { return }
            if let last = self.lastTick {
                let delta = Date().timeIntervalSince(last) * 1000
                if delta > tolerance {
                    self.logger.error("gateway tick missed; reconnecting")
                    self.connected = false
                    await self.failPending(
                        NSError(
                            domain: "Gateway",
                            code: 4,
                            userInfo: [NSLocalizedDescriptionKey: "gateway tick missed; reconnecting"]))
                    await self.scheduleReconnect()
                    return
                }
            }
        }
    }

    private func scheduleReconnect() async {
        guard self.shouldReconnect else { return }
        let delay = self.backoffMs / 1000
        self.backoffMs = min(self.backoffMs * 2, 30000)
        try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
        guard self.shouldReconnect else { return }
        do {
            try await self.connect()
        } catch {
            let wrapped = self.wrap(error, context: "gateway reconnect")
            self.logger.error("gateway reconnect failed \(wrapped.localizedDescription, privacy: .public)")
            await self.scheduleReconnect()
        }
    }

    func request(
        method: String,
        params: [String: ClawdbotProtocol.AnyCodable]?,
        timeoutMs: Double? = nil) async throws -> Data
    {
        do {
            try await self.connect()
        } catch {
            throw self.wrap(error, context: "gateway connect")
        }
        let id = UUID().uuidString
        let effectiveTimeout = timeoutMs ?? self.defaultRequestTimeoutMs
        // Encode request using the generated models to avoid JSONSerialization/ObjC bridging pitfalls.
        let paramsObject: ProtoAnyCodable? = params.map { entries in
            let dict = entries.reduce(into: [String: ProtoAnyCodable]()) { dict, entry in
                dict[entry.key] = ProtoAnyCodable(entry.value.value)
            }
            return ProtoAnyCodable(dict)
        }
        let frame = RequestFrame(
            type: "req",
            id: id,
            method: method,
            params: paramsObject)
        let data = try self.encoder.encode(frame)
        let response = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<GatewayFrame, Error>) in
            self.pending[id] = cont
            Task { [weak self] in
                guard let self else { return }
                try? await Task.sleep(nanoseconds: UInt64(effectiveTimeout * 1_000_000))
                await self.timeoutRequest(id: id, timeoutMs: effectiveTimeout)
            }
            Task {
                do {
                    try await self.task?.send(.data(data))
                } catch {
                    let wrapped = self.wrap(error, context: "gateway send \(method)")
                    let waiter = self.pending.removeValue(forKey: id)
                    // Treat send failures as a broken socket: mark disconnected and trigger reconnect.
                    self.connected = false
                    self.task?.cancel(with: .goingAway, reason: nil)
                    Task { [weak self] in
                        guard let self else { return }
                        await self.scheduleReconnect()
                    }
                    if let waiter { waiter.resume(throwing: wrapped) }
                }
            }
        }
        guard case let .res(res) = response else {
            throw NSError(domain: "Gateway", code: 2, userInfo: [NSLocalizedDescriptionKey: "unexpected frame"])
        }
        if res.ok == false {
            let code = res.error?["code"]?.value as? String
            let msg = res.error?["message"]?.value as? String
            let details: [String: ClawdbotProtocol.AnyCodable] = (res.error ?? [:]).reduce(into: [:]) { acc, pair in
                acc[pair.key] = ClawdbotProtocol.AnyCodable(pair.value.value)
            }
            throw GatewayResponseError(method: method, code: code, message: msg, details: details)
        }
        if let payload = res.payload {
            // Encode back to JSON with Swift's encoder to preserve types and avoid ObjC bridging exceptions.
            return try self.encoder.encode(payload)
        }
        return Data() // Should not happen, but tolerate empty payloads.
    }

    // Wrap low-level URLSession/WebSocket errors with context so UI can surface them.
    private func wrap(_ error: Error, context: String) -> Error {
        if let urlError = error as? URLError {
            let desc = urlError.localizedDescription.isEmpty ? "cancelled" : urlError.localizedDescription
            return NSError(
                domain: URLError.errorDomain,
                code: urlError.errorCode,
                userInfo: [NSLocalizedDescriptionKey: "\(context): \(desc)"])
        }
        let ns = error as NSError
        let desc = ns.localizedDescription.isEmpty ? "unknown" : ns.localizedDescription
        return NSError(domain: ns.domain, code: ns.code, userInfo: [NSLocalizedDescriptionKey: "\(context): \(desc)"])
    }

    private func failPending(_ error: Error) async {
        let waiters = self.pending
        self.pending.removeAll()
        for (_, waiter) in waiters {
            waiter.resume(throwing: error)
        }
    }

    private func timeoutRequest(id: String, timeoutMs: Double) async {
        guard let waiter = self.pending.removeValue(forKey: id) else { return }
        let err = NSError(
            domain: "Gateway",
            code: 5,
            userInfo: [NSLocalizedDescriptionKey: "gateway request timed out after \(Int(timeoutMs))ms"])
        waiter.resume(throwing: err)
    }
}

// Intentionally no `GatewayChannel` wrapper: the app should use the single shared `GatewayConnection`.
