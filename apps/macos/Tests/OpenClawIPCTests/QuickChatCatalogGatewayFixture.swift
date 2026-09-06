import Foundation
import Observation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

actor QuickChatCatalogGatewayServer {
    enum CatalogFailure: String, CaseIterable, Sendable {
        case rpc
        case decode
    }

    struct Request: Decodable, Sendable {
        struct Params: Decodable, Sendable {
            let agentId: String?
            let sessionKey: String?
            let key: String?
            let search: String?
            let model: String?
        }

        let id: String
        let method: String
        let params: Params?
    }

    private struct HeldResponse {
        let request: Request
        let socket: GatewayTestWebSocketTask
        let data: Data
    }

    private var requests: [Request] = []
    private var frames: [Data] = []
    private var failure: CatalogFailure?
    private var modelIDs = ["choice-a", "choice-b"]
    private var agentIDs = ["a", "b"]
    private var selectedModels = ["a": "choice-a", "b": "choice-b"]
    private var holdMethod: String?
    private var holdTarget: String?
    private var holdStarted: AsyncTestGate?
    private var heldResponse: HeldResponse?
    let scope: String

    init(scope: String = "per-agent") {
        self.scope = scope
    }

    func setFailure(_ failure: CatalogFailure?) {
        self.failure = failure
    }

    func setModels(_ modelIDs: [String]) {
        self.modelIDs = modelIDs
    }

    func setAgents(_ agentIDs: [String]) {
        self.agentIDs = agentIDs
    }

    func holdNext(method: String, target: String? = nil, started: AsyncTestGate) {
        self.holdMethod = method
        self.holdTarget = target
        self.holdStarted = started
    }

    func requestSnapshot() -> [Request] {
        self.requests
    }

    func model(for agentID: String) -> String? {
        self.selectedModels[agentID]
    }

    func releaseHeldResponse() {
        guard let held = self.heldResponse else { return }
        self.heldResponse = nil
        self.applyPatch(held.request)
        self.frames.append(held.data)
        held.socket.emitReceiveSuccess(.data(held.data))
    }

    func respond(to data: Data, socket: GatewayTestWebSocketTask) throws {
        let request = try JSONDecoder().decode(Request.self, from: data)
        self.requests.append(request)
        self.frames.append(data)
        let response = try self.response(to: request)
        let target = request.params?.search ?? request.params?.key ?? request.params?.sessionKey
        if self.holdMethod == request.method, self.holdTarget == nil || self.holdTarget == target {
            self.holdMethod = nil
            self.heldResponse = HeldResponse(request: request, socket: socket, data: response)
            self.holdStarted?.open()
            self.holdStarted = nil
            return
        }
        self.applyPatch(request)
        self.frames.append(response)
        socket.emitReceiveSuccess(.data(response))
    }

    func recordEvent(_ data: Data) {
        self.frames.append(data)
    }

    func rawFrames() -> [Data] {
        self.frames
    }

    private func applyPatch(_ request: Request) {
        guard request.method == "sessions.patch", let selection = request.params?.model else { return }
        let owner = self.owner(of: request)
        self.selectedModels[owner] = selection.replacingOccurrences(of: "fixture/", with: "")
    }

    private func owner(of request: Request) -> String {
        let key = request.params?.sessionKey ?? request.params?.key ?? request.params?.search
        return OpenClawChatSessionKey.agentID(from: key) ?? request.params?.agentId ?? self.agentIDs[0]
    }

    private func choice(_ modelID: String) -> [String: Any] {
        ["id": modelID, "name": modelID, "provider": "fixture", "available": true]
    }

    private func response(to request: Request) throws -> Data {
        let isCatalog = request.method == "models.list" || request.method == "chat.metadata"
        if isCatalog, self.failure == .rpc {
            return try JSONSerialization.data(withJSONObject: [
                "type": "res", "id": request.id, "ok": false,
                "error": ["code": "UNAVAILABLE", "message": "Synthetic catalog publication failed"],
            ])
        }
        let payload: [String: Any]
        if isCatalog, self.failure == .decode {
            payload = ["models": "invalid synthetic catalog shape"]
        } else {
            let owner = self.owner(of: request)
            switch request.method {
            case "health":
                payload = ["ok": true]
            case "models.list":
                payload = ["models": self.modelIDs.map(self.choice)]
            case "chat.metadata":
                let modelID = request.params?.sessionKey?.hasSuffix(":saved") == true
                    ? "saved-\(owner)" : "scoped-\(owner)"
                payload = ["models": [self.choice(modelID)]]
            case "agents.list":
                payload = [
                    "defaultId": self.agentIDs[0], "mainKey": "main", "scope": self.scope,
                    "agents": self.agentIDs.map { ["id": $0, "name": $0.uppercased()] },
                ]
            case "sessions.list":
                let key = request.params?.search ?? "agent:\(owner):main"
                payload = [
                    "defaults": ["modelProvider": "fixture", "model": "choice-a"],
                    "sessions": [[
                        "key": key, "modelProvider": "fixture", "model": self.selectedModels[owner]!,
                        "thinkingLevel": "low",
                    ]],
                ]
            case "sessions.patch":
                let model = try #require(request.params?.model)
                payload = [
                    "key": request.params?.key ?? "global",
                    "entry": ["modelProvider": "fixture", "model": model],
                ]
            default:
                throw NSError(domain: "QuickChatCatalogGatewayFixture", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "Unexpected fixture method \(request.method)",
                ])
            }
        }
        return try JSONSerialization.data(withJSONObject: [
            "type": "res", "id": request.id, "ok": true, "payload": payload,
        ])
    }
}

@MainActor
final class QuickChatCatalogGatewayFixture {
    let server: QuickChatCatalogGatewayServer
    let session: GatewayTestWebSocketSession
    let gateway: GatewayConnection
    private var controllers: [QuickChatController] = []

    init(sessionScoped: Bool? = true, scope: String = "per-agent") {
        let server = QuickChatCatalogGatewayServer(scope: scope)
        self.server = server
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0 else { return }
                let data: Data = switch message {
                case let .data(value): value
                case let .string(value): Data(value.utf8)
                @unknown default: throw URLError(.cannotParseResponse)
                }
                try await server.respond(to: data, socket: socket)
            }, receiveHook: { socket, receiveIndex in
                if receiveIndex == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
                let hello = GatewayWebSocketTestSupport.connectOkData(
                    id: socket.snapshotConnectRequestID() ?? "connect",
                    mainSessionKey: "agent:a:main",
                    methods: ["health", "models.list", "chat.metadata", "agents.list", "sessions.list", "sessions.patch"],
                    capabilities: sessionScoped == true ? ["session-scoped-chat-metadata"] : [])
                guard sessionScoped == nil else { return .data(hello) }
                var frame = try #require(JSONSerialization.jsonObject(with: hello) as? [String: Any])
                var payload = try #require(frame["payload"] as? [String: Any])
                var features = try #require(payload["features"] as? [String: Any])
                features.removeValue(forKey: "capabilities")
                payload["features"] = features
                frame["payload"] = payload
                return try .data(JSONSerialization.data(withJSONObject: frame))
            })
        })
        self.session = session
        self.gateway = GatewayConnection(
            configProvider: { (url: URL(string: "ws://127.0.0.1:1")!, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
    }

    func makeController() -> QuickChatController {
        let gateway = self.gateway
        let model = QuickChatModel(
            sessionKeyProvider: { await gateway.mainSessionKey() },
            agentsProvider: { try await gateway.agentsList() },
            agentIdentityProvider: { _ in .placeholder },
            sendProvider: { _, _, _, _, _, _ in
                Issue.record("Unsent fixture draft must not be dispatched")
                return "error"
            },
            permissionStatusProvider: { _ in [:] },
            permissionGrantProvider: { _ in [:] },
            connectionGateProvider: { .available },
            frontmostAppNameProvider: { "Synthetic editor" },
            modelControlsProvider: { target in
                let transport = MacGatewayChatTransport(connection: gateway, defaultGlobalAgentID: target.agentID)
                async let models = transport.listModels(agentID: target.agentID)
                async let sessions = transport.listSessions(limit: 200, search: target.sessionKey, archived: false)
                async let agents = gateway.agentsList()
                return try await QuickChatModelControlLogic.snapshot(
                    target: target, models: models, sessions: sessions, agents: agents)
            },
            modelPatchProvider: { target, model in
                try await MacGatewayChatTransport(connection: gateway, defaultGlobalAgentID: target.agentID)
                    .patchSessionModel(sessionKey: target.sessionKey, agentID: target.agentID, model: model)
            })
        let controller = QuickChatController(enableUI: false, model: model, monitoringEnabled: false)
        self.controllers.append(controller)
        return controller
    }

    func publish(event: String, sequence: Int) async throws {
        let socket = try #require(self.session.latestTask())
        let data = GatewayWebSocketTestSupport.eventData(event: event, seq: sequence)
        await self.server.recordEvent(data)
        socket.emitReceiveSuccess(.data(data))
    }

    func close() async {
        for controller in self.controllers { controller.stop() }
        await self.server.releaseHeldResponse()
        await self.gateway.shutdown()
        for frame in await self.server.rawFrames() {
            print("QUICK_CHAT_CATALOG_FRAME \(String(decoding: frame, as: UTF8.self))")
        }
    }

    static func waitForModel(_ condition: @MainActor () -> Bool) async throws {
        while !condition() {
            try Task.checkCancellation()
            let changed = AsyncTestGate()
            let satisfied = withObservationTracking {
                condition()
            } onChange: {
                changed.open()
            }
            if satisfied { return }
            await changed.wait()
        }
    }
}
