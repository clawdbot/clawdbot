import AppKit
import ClawdbotKit
import ClawdbotProtocol
import Foundation
import Network
import OSLog

actor BridgeServer {
    static let shared = BridgeServer()

    private let logger = Logger(subsystem: "com.clawdbot", category: "bridge")
    private var listener: NWListener?
    private var isRunning = false
    private var store: PairedNodesStore?
    private var connections: [String: BridgeConnectionHandler] = [:]
    private var nodeInfoById: [String: BridgeNodeInfo] = [:]
    private var presenceTasks: [String: Task<Void, Never>] = [:]
    private var chatSubscriptions: [String: Set<String>] = [:]
    private var gatewayPushTask: Task<Void, Never>?

    func start() async {
        if self.isRunning { return }
        self.isRunning = true

        do {
            let storeURL = try Self.defaultStoreURL()
            let store = PairedNodesStore(fileURL: storeURL)
            await store.load()
            self.store = store

            let params = NWParameters.tcp
            params.includePeerToPeer = true
            let listener = try NWListener(using: params, on: .any)

            listener.newConnectionHandler = { [weak self] connection in
                guard let self else { return }
                Task { await self.handle(connection: connection) }
            }

            listener.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                Task { await self.handleListenerState(state) }
            }

            listener.start(queue: DispatchQueue(label: "com.clawdbot.bridge"))
            self.listener = listener
        } catch {
            self.logger.error("bridge start failed: \(error.localizedDescription, privacy: .public)")
            self.isRunning = false
        }
    }

    func stop() async {
        self.isRunning = false
        self.listener?.cancel()
        self.listener = nil
    }

    private func handleListenerState(_ state: NWListener.State) {
        switch state {
        case .ready:
            self.logger.info("bridge listening")
        case let .failed(err):
            self.logger.error("bridge listener failed: \(err.localizedDescription, privacy: .public)")
        case .cancelled:
            self.logger.info("bridge listener cancelled")
        case .waiting:
            self.logger.info("bridge listener waiting")
        case .setup:
            break
        @unknown default:
            break
        }
    }

    private func handle(connection: NWConnection) async {
        let handler = BridgeConnectionHandler(connection: connection, logger: self.logger)
        await handler.run(
            resolveAuth: { [weak self] hello in
                await self?.authorize(hello: hello) ?? .error(code: "UNAVAILABLE", message: "bridge unavailable")
            },
            handlePair: { [weak self] request in
                await self?.pair(request: request) ?? .error(code: "UNAVAILABLE", message: "bridge unavailable")
            },
            onAuthenticated: { [weak self] node in
                await self?.registerConnection(handler: handler, node: node)
            },
            onDisconnected: { [weak self] nodeId in
                await self?.unregisterConnection(nodeId: nodeId)
            },
            onEvent: { [weak self] nodeId, evt in
                await self?.handleEvent(nodeId: nodeId, evt: evt)
            },
            onRequest: { [weak self] nodeId, req in
                await self?.handleRequest(nodeId: nodeId, req: req)
                    ?? BridgeRPCResponse(
                        id: req.id,
                        ok: false,
                        error: BridgeRPCError(code: "UNAVAILABLE", message: "bridge unavailable"))
            })
    }

    func invoke(nodeId: String, command: String, paramsJSON: String?) async throws -> BridgeInvokeResponse {
        guard let handler = self.connections[nodeId] else {
            throw NSError(domain: "Bridge", code: 10, userInfo: [
                NSLocalizedDescriptionKey: "UNAVAILABLE: node not connected",
            ])
        }
        return try await handler.invoke(command: command, paramsJSON: paramsJSON)
    }

    func connectedNodeIds() -> [String] {
        Array(self.connections.keys).sorted()
    }

    func connectedNodes() -> [BridgeNodeInfo] {
        self.nodeInfoById.values.sorted { a, b in
            (a.displayName ?? a.nodeId) < (b.displayName ?? b.nodeId)
        }
    }

    func pairedNodes() async -> [PairedNode] {
        guard let store = self.store else { return [] }
        return await store.all()
    }

    private func registerConnection(handler: BridgeConnectionHandler, node: BridgeNodeInfo) async {
        self.connections[node.nodeId] = handler
        self.nodeInfoById[node.nodeId] = node
        await self.beaconPresence(nodeId: node.nodeId, reason: "connect")
        self.startPresenceTask(nodeId: node.nodeId)
        self.ensureGatewayPushTask()
    }

    private func unregisterConnection(nodeId: String) async {
        await self.beaconPresence(nodeId: nodeId, reason: "disconnect")
        self.stopPresenceTask(nodeId: nodeId)
        self.connections.removeValue(forKey: nodeId)
        self.nodeInfoById.removeValue(forKey: nodeId)
        self.chatSubscriptions[nodeId] = nil
        self.stopGatewayPushTaskIfIdle()
    }

    private struct VoiceTranscriptPayload: Codable, Sendable {
        var text: String
        var sessionKey: String?
    }

    private func handleEvent(nodeId: String, evt: BridgeEventFrame) async {
        switch evt.event {
        case "chat.subscribe":
            guard let json = evt.payloadJSON, let data = json.data(using: .utf8) else { return }
            struct Subscribe: Codable { var sessionKey: String }
            guard let payload = try? JSONDecoder().decode(Subscribe.self, from: data) else { return }
            let key = payload.sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty else { return }
            var set = self.chatSubscriptions[nodeId] ?? Set<String>()
            set.insert(key)
            self.chatSubscriptions[nodeId] = set

        case "chat.unsubscribe":
            guard let json = evt.payloadJSON, let data = json.data(using: .utf8) else { return }
            struct Unsubscribe: Codable { var sessionKey: String }
            guard let payload = try? JSONDecoder().decode(Unsubscribe.self, from: data) else { return }
            let key = payload.sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty else { return }
            var set = self.chatSubscriptions[nodeId] ?? Set<String>()
            set.remove(key)
            self.chatSubscriptions[nodeId] = set.isEmpty ? nil : set

        case "voice.transcript":
            guard let json = evt.payloadJSON, let data = json.data(using: .utf8) else {
                return
            }
            guard let payload = try? JSONDecoder().decode(VoiceTranscriptPayload.self, from: data) else {
                return
            }
            let text = payload.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return }

            let sessionKey = payload.sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
                ?? "main"

            _ = await GatewayConnection.shared.sendAgent(GatewayAgentInvocation(
                message: text,
                sessionKey: sessionKey,
                thinking: "low",
                deliver: false,
                to: nil,
                channel: .last))

        case "agent.request":
            guard let json = evt.payloadJSON, let data = json.data(using: .utf8) else {
                return
            }
            guard let link = try? JSONDecoder().decode(AgentDeepLink.self, from: data) else {
                return
            }

            let message = link.message.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !message.isEmpty else { return }
            guard message.count <= 20000 else { return }

            let sessionKey = link.sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
                ?? "node-\(nodeId)"
            let thinking = link.thinking?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            let to = link.to?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            let channel = GatewayAgentChannel(raw: link.channel)

            _ = await GatewayConnection.shared.sendAgent(GatewayAgentInvocation(
                message: message,
                sessionKey: sessionKey,
                thinking: thinking,
                deliver: link.deliver,
                to: to,
                channel: channel))

        default:
            break
        }
    }

    private func handleRequest(nodeId: String, req: BridgeRPCRequest) async -> BridgeRPCResponse {
        let allowed: Set<String> = ["chat.history", "chat.send", "health"]
        guard allowed.contains(req.method) else {
            return BridgeRPCResponse(
                id: req.id,
                ok: false,
                error: BridgeRPCError(code: "FORBIDDEN", message: "Method not allowed"))
        }

        let params: [String: ClawdbotProtocol.AnyCodable]?
        if let json = req.paramsJSON?.trimmingCharacters(in: .whitespacesAndNewlines), !json.isEmpty {
            guard let data = json.data(using: .utf8) else {
                return BridgeRPCResponse(
                    id: req.id,
                    ok: false,
                    error: BridgeRPCError(code: "INVALID_REQUEST", message: "paramsJSON not UTF-8"))
            }
            do {
                params = try JSONDecoder().decode([String: ClawdbotProtocol.AnyCodable].self, from: data)
            } catch {
                return BridgeRPCResponse(
                    id: req.id,
                    ok: false,
                    error: BridgeRPCError(code: "INVALID_REQUEST", message: error.localizedDescription))
            }
        } else {
            params = nil
        }

        do {
            let data = try await GatewayConnection.shared.request(method: req.method, params: params, timeoutMs: 30000)
            guard let json = String(data: data, encoding: .utf8) else {
                return BridgeRPCResponse(
                    id: req.id,
                    ok: false,
                    error: BridgeRPCError(code: "UNAVAILABLE", message: "Response not UTF-8"))
            }
            return BridgeRPCResponse(id: req.id, ok: true, payloadJSON: json)
        } catch {
            return BridgeRPCResponse(
                id: req.id,
                ok: false,
                error: BridgeRPCError(code: "UNAVAILABLE", message: error.localizedDescription))
        }
    }

    private func ensureGatewayPushTask() {
        if self.gatewayPushTask != nil { return }
        self.gatewayPushTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await GatewayConnection.shared.refresh()
            } catch {
                // We'll still forward events once the gateway comes up.
            }
            let stream = await GatewayConnection.shared.subscribe()
            for await push in stream {
                if Task.isCancelled { return }
                await self.forwardGatewayPush(push)
            }
        }
    }

    private func stopGatewayPushTaskIfIdle() {
        guard self.connections.isEmpty else { return }
        self.gatewayPushTask?.cancel()
        self.gatewayPushTask = nil
    }

    private func forwardGatewayPush(_ push: GatewayPush) async {
        let subscribedNodes = self.chatSubscriptions.keys.filter { self.connections[$0] != nil }
        guard !subscribedNodes.isEmpty else { return }

        switch push {
        case let .snapshot(hello):
            let payloadJSON = (try? JSONEncoder().encode(hello.snapshot.health))
                .flatMap { String(data: $0, encoding: .utf8) }
            for nodeId in subscribedNodes {
                await self.connections[nodeId]?.sendServerEvent(event: "health", payloadJSON: payloadJSON)
            }
        case let .event(evt):
            switch evt.event {
            case "health":
                guard let payload = evt.payload else { return }
                let payloadJSON = (try? JSONEncoder().encode(payload))
                    .flatMap { String(data: $0, encoding: .utf8) }
                for nodeId in subscribedNodes {
                    await self.connections[nodeId]?.sendServerEvent(event: "health", payloadJSON: payloadJSON)
                }
            case "tick":
                for nodeId in subscribedNodes {
                    await self.connections[nodeId]?.sendServerEvent(event: "tick", payloadJSON: nil)
                }
            case "chat":
                guard let payload = evt.payload else { return }
                let payloadData = try? JSONEncoder().encode(payload)
                let payloadJSON = payloadData.flatMap { String(data: $0, encoding: .utf8) }

                struct MinimalChat: Codable { var sessionKey: String }
                let sessionKey = payloadData.flatMap { try? JSONDecoder().decode(MinimalChat.self, from: $0) }?
                    .sessionKey
                if let sessionKey {
                    for nodeId in subscribedNodes {
                        guard self.chatSubscriptions[nodeId]?.contains(sessionKey) == true else { continue }
                        await self.connections[nodeId]?.sendServerEvent(event: "chat", payloadJSON: payloadJSON)
                    }
                } else {
                    for nodeId in subscribedNodes {
                        await self.connections[nodeId]?.sendServerEvent(event: "chat", payloadJSON: payloadJSON)
                    }
                }
            default:
                break
            }
        case .seqGap:
            for nodeId in subscribedNodes {
                await self.connections[nodeId]?.sendServerEvent(event: "seqGap", payloadJSON: nil)
            }
        }
    }

    private func beaconPresence(nodeId: String, reason: String) async {
        let paired = await self.store?.find(nodeId: nodeId)
        let host = paired?.displayName?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            ?? nodeId
        let version = paired?.version?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        let platform = paired?.platform?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        let ip = await self.connections[nodeId]?.remoteAddress()

        var tags: [String] = ["node", "ios"]
        if let platform { tags.append(platform) }

        let summary = [
            "Node: \(host)\(ip.map { " (\($0))" } ?? "")",
            platform.map { "platform \($0)" },
            version.map { "app \($0)" },
            "mode node",
            "reason \(reason)",
        ].compactMap(\.self).joined(separator: " · ")

        var params: [String: ClawdbotProtocol.AnyCodable] = [
            "text": ClawdbotProtocol.AnyCodable(summary),
            "instanceId": ClawdbotProtocol.AnyCodable(nodeId),
            "host": ClawdbotProtocol.AnyCodable(host),
            "mode": ClawdbotProtocol.AnyCodable("node"),
            "reason": ClawdbotProtocol.AnyCodable(reason),
            "tags": ClawdbotProtocol.AnyCodable(tags),
        ]
        if let ip { params["ip"] = ClawdbotProtocol.AnyCodable(ip) }
        if let version { params["version"] = ClawdbotProtocol.AnyCodable(version) }
        await GatewayConnection.shared.sendSystemEvent(params)
    }

    private func startPresenceTask(nodeId: String) {
        self.presenceTasks[nodeId]?.cancel()
        self.presenceTasks[nodeId] = Task.detached { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 180 * 1_000_000_000)
                if Task.isCancelled { return }
                await self?.beaconPresence(nodeId: nodeId, reason: "periodic")
            }
        }
    }

    private func stopPresenceTask(nodeId: String) {
        self.presenceTasks[nodeId]?.cancel()
        self.presenceTasks.removeValue(forKey: nodeId)
    }

    private func authorize(hello: BridgeHello) async -> BridgeConnectionHandler.AuthResult {
        let nodeId = hello.nodeId.trimmingCharacters(in: .whitespacesAndNewlines)
        if nodeId.isEmpty {
            return .error(code: "INVALID_REQUEST", message: "nodeId required")
        }
        guard let store = self.store else {
            return .error(code: "UNAVAILABLE", message: "store unavailable")
        }
        guard let paired = await store.find(nodeId: nodeId) else {
            return .notPaired
        }
        guard let token = hello.token, token == paired.token else {
            return .unauthorized
        }

        do {
            var updated = paired
            let name = hello.displayName?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            let platform = hello.platform?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            let version = hello.version?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            let deviceFamily = hello.deviceFamily?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            let modelIdentifier = hello.modelIdentifier?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty

            if updated.displayName != name { updated.displayName = name }
            if updated.platform != platform { updated.platform = platform }
            if updated.version != version { updated.version = version }
            if updated.deviceFamily != deviceFamily { updated.deviceFamily = deviceFamily }
            if updated.modelIdentifier != modelIdentifier { updated.modelIdentifier = modelIdentifier }

            if updated != paired {
                try await store.upsert(updated)
            } else {
                try await store.touchSeen(nodeId: nodeId)
            }
        } catch {
            // ignore
        }
        return .ok
    }

    private func pair(request: BridgePairRequest) async -> BridgeConnectionHandler.PairResult {
        let nodeId = request.nodeId.trimmingCharacters(in: .whitespacesAndNewlines)
        if nodeId.isEmpty {
            return .error(code: "INVALID_REQUEST", message: "nodeId required")
        }
        guard let store = self.store else {
            return .error(code: "UNAVAILABLE", message: "store unavailable")
        }
        let existing = await store.find(nodeId: nodeId)

        let approved = await BridgePairingApprover.approve(request: request, isRepair: existing != nil)
        if !approved {
            return .rejected
        }

        let token = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let nowMs = Int(Date().timeIntervalSince1970 * 1000)
        let node = PairedNode(
            nodeId: nodeId,
            displayName: request.displayName,
            platform: request.platform,
            version: request.version,
            deviceFamily: request.deviceFamily,
            modelIdentifier: request.modelIdentifier,
            token: token,
            createdAtMs: nowMs,
            lastSeenAtMs: nowMs)
        do {
            try await store.upsert(node)
            return .ok(token: token)
        } catch {
            return .error(code: "UNAVAILABLE", message: "failed to persist pairing")
        }
    }

    private static func defaultStoreURL() throws -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        guard let base else {
            throw NSError(
                domain: "Bridge",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Application Support unavailable"])
        }
        return base
            .appendingPathComponent("Clawdbot", isDirectory: true)
            .appendingPathComponent("bridge", isDirectory: true)
            .appendingPathComponent("paired-nodes.json", isDirectory: false)
    }
}

@MainActor
enum BridgePairingApprover {
    static func approve(request: BridgePairRequest, isRepair: Bool) async -> Bool {
        await withCheckedContinuation { cont in
            let name = request.displayName ?? request.nodeId
            let remote = request.remoteAddress?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            let alert = NSAlert()
            alert.messageText = isRepair ? "Re-pair Clawdbot Node?" : "Pair Clawdbot Node?"
            alert.informativeText = """
            Node: \(name)
            IP: \(remote ?? "unknown")
            Platform: \(request.platform ?? "unknown")
            Version: \(request.version ?? "unknown")
            """
            alert.addButton(withTitle: "Approve")
            alert.addButton(withTitle: "Reject")
            if #available(macOS 11.0, *), alert.buttons.indices.contains(1) {
                alert.buttons[1].hasDestructiveAction = true
            }
            let resp = alert.runModal()
            cont.resume(returning: resp == .alertFirstButtonReturn)
        }
    }
}

#if DEBUG
extension BridgeServer {
    func exerciseForTesting() async {
        let conn = NWConnection(to: .hostPort(host: "127.0.0.1", port: 22), using: .tcp)
        let handler = BridgeConnectionHandler(connection: conn, logger: self.logger)
        self.connections["node-1"] = handler
        self.nodeInfoById["node-1"] = BridgeNodeInfo(
            nodeId: "node-1",
            displayName: "Node One",
            platform: "macOS",
            version: "1.0.0",
            deviceFamily: "Mac",
            modelIdentifier: "MacBookPro18,1",
            remoteAddress: "127.0.0.1",
            caps: ["chat", "voice"])

        _ = self.connectedNodeIds()
        _ = self.connectedNodes()

        self.handleListenerState(.ready)
        self.handleListenerState(.failed(NWError.posix(.ECONNREFUSED)))
        self.handleListenerState(.waiting(NWError.posix(.ETIMEDOUT)))
        self.handleListenerState(.cancelled)
        self.handleListenerState(.setup)

        let subscribe = BridgeEventFrame(event: "chat.subscribe", payloadJSON: "{\"sessionKey\":\"main\"}")
        await self.handleEvent(nodeId: "node-1", evt: subscribe)

        let unsubscribe = BridgeEventFrame(event: "chat.unsubscribe", payloadJSON: "{\"sessionKey\":\"main\"}")
        await self.handleEvent(nodeId: "node-1", evt: unsubscribe)

        let invalid = BridgeRPCRequest(id: "req-1", method: "invalid.method", paramsJSON: nil)
        _ = await self.handleRequest(nodeId: "node-1", req: invalid)
    }
}
#endif
