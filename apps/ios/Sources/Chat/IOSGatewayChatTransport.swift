import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import OSLog

struct IOSGatewayChatTransport: OpenClawChatTransport {
    static let logger = Logger(subsystem: "ai.openclawfoundation.app", category: "ios.chat.transport")
    static let defaultChatSendTimeoutMs = 30000
    static let compactionRequestTimeoutSeconds = 0
    private let gateway: GatewayNodeSession
    private let globalAgentId: String?
    private let outboxGatewayID: String?

    var outboxRequiresSessionRoutingContract: Bool {
        true
    }

    private struct CreateSessionParams: Codable {
        var key: String
        var agentId: String?
        var label: String?
        var parentSessionKey: String?
        var worktree: Bool?
    }

    private struct RunParams: Codable {
        var sessionKey: String
        var agentId: String?
        var runId: String
    }

    private struct ListSessionsParams: Codable {
        var includeGlobal: Bool
        var includeUnknown: Bool
        var limit: Int?
        var search: String?
        var archived: Bool?
    }

    private struct DeleteSessionParams: Codable {
        var key: String
        var deleteTranscript: Bool
        var agentId: String?
    }

    private struct ForkSessionParams: Codable {
        var parentSessionKey: String
        var fork: Bool
        var agentId: String?
    }

    private struct SessionKeyParams: Codable {
        var key: String
        var agentId: String?
    }

    private struct SessionPatchModelParams: Encodable {
        var key: String
        var agentId: String?
        var model: String?

        enum CodingKeys: String, CodingKey {
            case key
            case agentId
            case model
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(self.key, forKey: .key)
            try container.encodeIfPresent(self.agentId, forKey: .agentId)
            if let model {
                try container.encode(model, forKey: .model)
            } else {
                try container.encodeNil(forKey: .model)
            }
        }
    }

    private struct ModelsListResponse: Decodable {
        var models: [Model]

        struct Model: Decodable {
            var id: String
            var name: String
            var provider: String
            var contextWindow: Int?
            var reasoning: Bool?
        }
    }

    private struct ChatSendParams: Codable {
        var sessionKey: String
        var agentId: String?
        var expectedSessionRoutingContract: String?
        var message: String
        var thinking: String
        var attachments: [OpenClawChatAttachmentPayload]?
        var timeoutMs: Int
        var idempotencyKey: String
    }

    private struct CommandsListRequestParams: Codable {
        var scope: String
        var includeArgs: Bool
        var agentId: String?
    }

    private struct AgentWaitParams: Codable {
        var runId: String
        var timeoutMs: Int
    }

    private struct AgentWaitResponse: Codable {
        var runId: String?
        var status: String?
        var error: String?
    }

    struct AgentWaitCompletion: Equatable {
        var runId: String
        var status: String
        var completed: Bool
    }

    static func isAgentWaitCompletionStatus(_ status: String) -> Bool {
        switch status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "ok", "completed", "success", "succeeded":
            true
        default:
            false
        }
    }

    init(
        gateway: GatewayNodeSession,
        globalAgentId: String? = nil,
        outboxGatewayID: String? = nil)
    {
        self.gateway = gateway
        let normalized = globalAgentId?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        self.globalAgentId = normalized?.isEmpty == false ? normalized : nil
        let normalizedGatewayID = outboxGatewayID?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.outboxGatewayID = normalizedGatewayID?.isEmpty == false ? normalizedGatewayID : nil
    }

    func acquireOutboxRouteLease() async -> OpenClawChatTransportRouteLeaseResult {
        guard let outboxGatewayID,
              let route = await gateway.currentRoute(ifGatewayID: outboxGatewayID)
        else { return .unavailable(reason: nil) }
        guard let supportsRoutingContract = await gateway.supportsServerCapability(
            .chatSendRoutingContract,
            ifCurrentRoute: route)
        else { return .unavailable(reason: nil) }
        guard supportsRoutingContract else {
            return .unavailable(reason: OpenClawChatTransportUpgradeMessage.routingContract)
        }
        let transport = self
        guard let routingContract = try? await transport.sessionRoutingContract(ifCurrentRoute: route)
        else { return .unavailable(reason: nil) }
        return .available(OpenClawChatTransportRouteLease(
            sendTargetedMessage: { sessionKey, agentID, message, thinking, idempotencyKey, attachments in
                try await transport.sendMessage(
                    sessionKey: sessionKey,
                    agentID: agentID,
                    expectedSessionRoutingContract: routingContract,
                    message: message,
                    thinking: thinking,
                    idempotencyKey: idempotencyKey,
                    attachments: attachments,
                    ifCurrentRoute: route,
                    distinguishPreDispatchRouteChange: true)
            },
            requestTargetedHistory: { sessionKey, agentID in
                try await transport.requestHistory(
                    sessionKey: sessionKey,
                    agentID: agentID,
                    ifCurrentRoute: route)
            },
            sessionRoutingContract: routingContract))
    }

    private func sessionRoutingContract(
        ifCurrentRoute route: GatewayNodeSessionRoute) async throws -> String
    {
        let data = try await gateway.request(
            method: "agents.list",
            paramsJSON: "{}",
            timeoutSeconds: 15,
            ifCurrentRoute: route)
        return try Self.decodeSessionRoutingContract(data)
    }

    static func decodeSessionRoutingContract(_ data: Data) throws -> String {
        let result = try JSONDecoder().decode(AgentsListResult.self, from: data)
        guard let contract = OpenClawChatSessionRoutingContract.make(
            scope: result.scope.value as? String,
            mainKey: result.mainkey,
            defaultAgentID: result.defaultid)
        else { throw CancellationError() }
        return contract
    }

    static func agentWaitRequestTimeoutSeconds(timeoutMs: Int) -> Int {
        max(1, Int(ceil(Double(timeoutMs) / 1000.0)) + 5)
    }

    static func makeListSessionsParamsJSON(
        limit: Int?,
        search: String? = nil,
        archived: Bool = false) throws -> String
    {
        let normalizedSearch = search?.trimmingCharacters(in: .whitespacesAndNewlines)
        return try self.encodeParams(ListSessionsParams(
            includeGlobal: true,
            includeUnknown: false,
            limit: limit,
            search: normalizedSearch?.isEmpty == false ? normalizedSearch : nil,
            archived: archived ? true : nil))
    }

    static func makePatchSessionParamsJSON(
        key: String,
        agentId: String? = nil,
        label: String?? = nil,
        category: String?? = nil,
        pinned: Bool? = nil,
        archived: Bool? = nil,
        unread: Bool? = nil) throws -> String
    {
        var params: [String: Any] = ["key": key]
        if let agentId {
            params["agentId"] = agentId
        }
        if let label {
            params["label"] = label ?? NSNull()
        }
        if let category {
            params["category"] = category ?? NSNull()
        }
        if let pinned {
            params["pinned"] = pinned
        }
        if let archived {
            params["archived"] = archived
        }
        if let unread {
            params["unread"] = unread
        }
        return try self.encodeJSONObject(params)
    }

    static func makeForkSessionParamsJSON(parentKey: String, agentId: String? = nil) throws -> String {
        try self.encodeParams(ForkSessionParams(
            parentSessionKey: parentKey,
            fork: true,
            agentId: agentId))
    }

    static func makeChatSendParamsJSON(
        sessionKey: String,
        agentId: String? = nil,
        expectedSessionRoutingContract: String? = nil,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) throws -> String
    {
        let params = ChatSendParams(
            sessionKey: sessionKey,
            agentId: agentId,
            expectedSessionRoutingContract: expectedSessionRoutingContract,
            message: message,
            thinking: thinking,
            attachments: attachments.isEmpty ? nil : attachments,
            timeoutMs: self.defaultChatSendTimeoutMs,
            idempotencyKey: idempotencyKey)
        return try self.encodeParams(params)
    }

    static func makeCommandsListParamsJSON(
        sessionKey: String? = nil,
        agentId: String? = nil) throws -> String
    {
        try self.encodeParams(CommandsListRequestParams(
            scope: "text",
            includeArgs: true,
            agentId: self.agentID(fromSessionKey: sessionKey) ?? agentId))
    }

    static func agentID(fromSessionKey sessionKey: String?) -> String? {
        let parts = (sessionKey ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count >= 3, parts[0].lowercased() == "agent" else { return nil }
        let agentID = String(parts[1]).trimmingCharacters(in: .whitespacesAndNewlines)
        return agentID.isEmpty ? nil : agentID
    }

    static func decodeAgentWaitCompletion(_ data: Data, fallbackRunId: String) throws -> AgentWaitCompletion {
        let decoded = try JSONDecoder().decode(AgentWaitResponse.self, from: data)
        let status = (decoded.status ?? "unknown").lowercased()
        return AgentWaitCompletion(
            runId: decoded.runId ?? fallbackRunId,
            status: status,
            completed: self.isAgentWaitCompletionStatus(status))
    }

    static func decodeModelChoices(_ data: Data) throws -> [OpenClawChatModelChoice] {
        let decoded = try JSONDecoder().decode(ModelsListResponse.self, from: data)
        return decoded.models.map { model in
            let name = model.name.trimmingCharacters(in: .whitespacesAndNewlines)
            return OpenClawChatModelChoice(
                modelID: model.id,
                name: name.isEmpty ? model.id : model.name,
                provider: model.provider,
                contextWindow: model.contextWindow,
                reasoning: model.reasoning)
        }
    }

    static func makeCreateSessionParamsJSON(
        key: String,
        agentId: String? = nil,
        label: String?,
        parentSessionKey: String?,
        worktree: Bool?) throws -> String
    {
        let params = CreateSessionParams(
            key: key,
            agentId: agentId,
            label: label,
            parentSessionKey: parentSessionKey,
            worktree: worktree)
        return try self.encodeParams(params)
    }

    private static func makeRunParamsJSON(
        sessionKey: String,
        agentId: String?,
        runId: String) throws -> String
    {
        try self.encodeParams(RunParams(sessionKey: sessionKey, agentId: agentId, runId: runId))
    }

    private static func makeSessionKeyParamsJSON(_ sessionKey: String, agentId: String?) throws -> String {
        try self.encodeParams(SessionKeyParams(key: sessionKey, agentId: agentId))
    }

    static func makeSessionPatchModelParamsJSON(
        sessionKey: String,
        agentId: String? = nil,
        model: String?) throws -> String
    {
        try self.encodeParams(SessionPatchModelParams(key: sessionKey, agentId: agentId, model: model))
    }

    private static func makeHistoryParamsJSON(sessionKey: String, agentId: String?) throws -> String {
        struct Params: Codable {
            var sessionKey: String
            var agentId: String?
        }
        return try self.encodeParams(Params(sessionKey: sessionKey, agentId: agentId))
    }

    private static func makeAgentWaitParamsJSON(runId: String, timeoutMs: Int) throws -> String {
        try self.encodeParams(AgentWaitParams(runId: runId, timeoutMs: timeoutMs))
    }

    private static func encodeParams(_ params: some Encodable) throws -> String {
        let data = try JSONEncoder().encode(params)
        guard let json = String(bytes: data, encoding: .utf8) else {
            throw EncodingError.invalidValue(
                params,
                EncodingError.Context(codingPath: [], debugDescription: "Encoded gateway params were not UTF-8"))
        }
        return json
    }

    private static func encodeJSONObject(_ value: Any) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        guard let json = String(bytes: data, encoding: .utf8) else {
            throw EncodingError.invalidValue(
                value,
                EncodingError.Context(codingPath: [], debugDescription: "Encoded gateway params were not UTF-8"))
        }
        return json
    }

    private func selectedGlobalAgentId(for sessionKey: String) -> String? {
        sessionKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "global"
            ? self.globalAgentId
            : nil
    }

    struct SessionTarget: Equatable {
        var sessionKey: String
        var agentID: String?
    }

    static func sessionTarget(
        for rawSessionKey: String,
        selectedAgentID: String?,
        overrideAgentID: String? = nil) -> SessionTarget
    {
        let sessionKey = rawSessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let selected = selectedAgentID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let override = overrideAgentID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if self.agentID(fromSessionKey: sessionKey) != nil {
            return SessionTarget(sessionKey: sessionKey, agentID: override)
        }
        if sessionKey.lowercased().hasPrefix("agent:") {
            return SessionTarget(sessionKey: sessionKey, agentID: nil)
        }
        if sessionKey.lowercased() == "unknown" {
            return SessionTarget(sessionKey: sessionKey, agentID: nil)
        }
        let targetAgentID = override ?? (selected?.isEmpty == false ? selected : nil)
        if sessionKey.lowercased() == "global" {
            return SessionTarget(sessionKey: sessionKey, agentID: targetAgentID)
        }
        if let targetAgentID {
            return SessionTarget(sessionKey: "agent:\(targetAgentID):\(sessionKey)", agentID: nil)
        }
        return SessionTarget(sessionKey: sessionKey, agentID: nil)
    }

    private func sessionTarget(
        for sessionKey: String,
        overrideAgentID: String? = nil) -> SessionTarget
    {
        Self.sessionTarget(
            for: sessionKey,
            selectedAgentID: self.globalAgentId,
            overrideAgentID: overrideAgentID)
    }

    func createSession(
        key: String,
        label: String?,
        parentSessionKey: String?,
        worktree: Bool?) async throws -> OpenClawChatCreateSessionResponse
    {
        let target = self.sessionTarget(for: key)
        let parentTarget = parentSessionKey.map { self.sessionTarget(for: $0) }
        let json = try Self.makeCreateSessionParamsJSON(
            key: target.sessionKey,
            agentId: target.agentID ?? parentTarget?.agentID,
            label: label,
            parentSessionKey: parentTarget?.sessionKey,
            worktree: worktree)
        let res = try await self.gateway.request(method: "sessions.create", paramsJSON: json, timeoutSeconds: 15)
        return try JSONDecoder().decode(OpenClawChatCreateSessionResponse.self, from: res)
    }

    func abortRun(sessionKey: String, runId: String) async throws {
        let target = self.sessionTarget(for: sessionKey)
        let json = try Self.makeRunParamsJSON(
            sessionKey: target.sessionKey,
            agentId: target.agentID,
            runId: runId)
        _ = try await self.gateway.request(method: "chat.abort", paramsJSON: json, timeoutSeconds: 10)
    }

    func listSessions(
        limit: Int?,
        search: String?,
        archived: Bool) async throws -> OpenClawChatSessionsListResponse
    {
        let json = try Self.makeListSessionsParamsJSON(limit: limit, search: search, archived: archived)
        let res = try await self.gateway.request(method: "sessions.list", paramsJSON: json, timeoutSeconds: 15)
        return try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: res)
    }

    func listModels() async throws -> [OpenClawChatModelChoice] {
        let response = try await self.gateway.request(
            method: "models.list",
            paramsJSON: nil,
            timeoutSeconds: 15)
        return try Self.decodeModelChoices(response)
    }

    func setSessionModel(sessionKey: String, model: String?) async throws {
        let target = self.sessionTarget(for: sessionKey)
        let json = try Self.makeSessionPatchModelParamsJSON(
            sessionKey: target.sessionKey,
            agentId: target.agentID,
            model: model)
        _ = try await self.gateway.request(method: "sessions.patch", paramsJSON: json, timeoutSeconds: 15)
    }

    func patchSession(
        key: String,
        label: String?? = nil,
        category: String?? = nil,
        pinned: Bool? = nil,
        archived: Bool? = nil,
        unread: Bool? = nil) async throws
    {
        let json = try Self.makePatchSessionParamsJSON(
            key: key,
            agentId: self.selectedGlobalAgentId(for: key),
            label: label,
            category: category,
            pinned: pinned,
            archived: archived,
            unread: unread)
        _ = try await self.gateway.request(method: "sessions.patch", paramsJSON: json, timeoutSeconds: 15)
    }

    func deleteSession(key: String) async throws {
        let json = try Self.encodeParams(DeleteSessionParams(
            key: key,
            deleteTranscript: true,
            agentId: self.selectedGlobalAgentId(for: key)))
        _ = try await self.gateway.request(method: "sessions.delete", paramsJSON: json, timeoutSeconds: 15)
    }

    func forkSession(parentKey: String) async throws -> String {
        let json = try Self.makeForkSessionParamsJSON(
            parentKey: parentKey,
            agentId: Self.agentID(fromSessionKey: parentKey) ?? self.selectedGlobalAgentId(for: parentKey))
        let response = try await self.gateway.request(method: "sessions.create", paramsJSON: json, timeoutSeconds: 15)
        return try JSONDecoder().decode(OpenClawChatCreateSessionResponse.self, from: response).key
    }

    func setActiveSessionKey(_ sessionKey: String) async throws {
        struct Params: Codable {
            var key: String
            var agentId: String?
        }
        let target = self.sessionTarget(for: sessionKey)
        let data = try JSONEncoder().encode(Params(key: target.sessionKey, agentId: target.agentID))
        let json = String(data: data, encoding: .utf8)
        _ = try await self.gateway.request(
            method: "sessions.messages.subscribe",
            paramsJSON: json,
            timeoutSeconds: 10)
    }

    func resetSession(sessionKey: String) async throws {
        let target = self.sessionTarget(for: sessionKey)
        let json = try Self.makeSessionKeyParamsJSON(target.sessionKey, agentId: target.agentID)
        _ = try await self.gateway.request(method: "sessions.reset", paramsJSON: json, timeoutSeconds: 10)
    }

    func compactSession(sessionKey: String) async throws {
        let target = self.sessionTarget(for: sessionKey)
        let json = try Self.makeSessionKeyParamsJSON(target.sessionKey, agentId: target.agentID)
        let response = try await gateway.request(
            method: "sessions.compact",
            paramsJSON: json,
            timeoutSeconds: Self.compactionRequestTimeoutSeconds)
        try OpenClawSessionsCompactResponse.requireSuccess(from: response)
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        try await self.requestHistory(sessionKey: sessionKey, agentID: nil, ifCurrentRoute: nil)
    }

    func requestHistory(
        sessionKey: String,
        agentID: String? = nil,
        ifCurrentRoute expectedRoute: GatewayNodeSessionRoute?) async throws -> OpenClawChatHistoryPayload
    {
        let target = self.sessionTarget(for: sessionKey, overrideAgentID: agentID)
        let json = try Self.makeHistoryParamsJSON(
            sessionKey: target.sessionKey,
            agentId: target.agentID)
        let res = try await gateway.request(
            method: "chat.history",
            paramsJSON: json,
            timeoutSeconds: 15,
            ifCurrentRoute: expectedRoute)
        return try JSONDecoder().decode(OpenClawChatHistoryPayload.self, from: res)
    }

    var supportsSlashCommandCatalog: Bool {
        true
    }

    func listCommands(sessionKey: String) async throws -> [OpenClawChatCommandChoice] {
        let json = try Self.makeCommandsListParamsJSON(
            sessionKey: sessionKey,
            agentId: Self.agentID(fromSessionKey: sessionKey) ?? self.globalAgentId)
        let res = try await gateway.request(method: "commands.list", paramsJSON: json, timeoutSeconds: 15)
        let decoded = try JSONDecoder().decode(CommandsListResult.self, from: res)
        return decoded.commands.map(Self.mapCommandChoice)
    }

    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        try await self.sendMessage(
            sessionKey: sessionKey,
            agentID: nil,
            message: message,
            thinking: thinking,
            idempotencyKey: idempotencyKey,
            attachments: attachments,
            ifCurrentRoute: nil)
    }

    func sendMessage(
        sessionKey: String,
        agentID: String?,
        expectedSessionRoutingContract: String?,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        let route: GatewayNodeSessionRoute? = if let outboxGatewayID {
            await self.gateway.currentRoute(ifGatewayID: outboxGatewayID)
        } else {
            await self.gateway.currentRoute()
        }
        guard let route,
              let supportsRoutingContract = await gateway.supportsServerCapability(
                  .chatSendRoutingContract,
                  ifCurrentRoute: route)
        else { throw OpenClawChatTransportSendError.notDispatched }
        // Durable replay requires the atomic server guard and is blocked in
        // acquireOutboxRouteLease. Keep ordinary live chat compatible with
        // older gateways by retaining the captured route but omitting the
        // unsupported request field.
        let guardedContract = OpenClawChatSessionRoutingContract.expectedValue(
            expectedSessionRoutingContract,
            serverSupportsGuard: supportsRoutingContract)
        return try await self.sendMessage(
            sessionKey: sessionKey,
            agentID: agentID,
            expectedSessionRoutingContract: guardedContract,
            message: message,
            thinking: thinking,
            idempotencyKey: idempotencyKey,
            attachments: attachments,
            ifCurrentRoute: route,
            distinguishPreDispatchRouteChange: true)
    }

    func sendMessage(
        sessionKey: String,
        agentID: String? = nil,
        expectedSessionRoutingContract: String? = nil,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload],
        ifCurrentRoute expectedRoute: GatewayNodeSessionRoute?,
        distinguishPreDispatchRouteChange: Bool = false) async throws -> OpenClawChatSendResponse
    {
        let target = self.sessionTarget(for: sessionKey, overrideAgentID: agentID)
        let startLogMessage =
            "chat.send start sessionKey=\(target.sessionKey) "
                + "len=\(message.count) attachments=\(attachments.count)"
        Self.logger.info(
            "\(startLogMessage, privacy: .public)")
        GatewayDiagnostics.log(startLogMessage)
        let json = try Self.makeChatSendParamsJSON(
            sessionKey: target.sessionKey,
            agentId: target.agentID,
            expectedSessionRoutingContract: expectedSessionRoutingContract,
            message: message,
            thinking: thinking,
            idempotencyKey: idempotencyKey,
            attachments: attachments)
        do {
            let res = try await gateway.request(
                method: "chat.send",
                paramsJSON: json,
                timeoutSeconds: 35,
                ifCurrentRoute: expectedRoute,
                distinguishPreDispatchRouteChange: distinguishPreDispatchRouteChange)
            let decoded = try JSONDecoder().decode(OpenClawChatSendResponse.self, from: res)
            Self.logger.info("chat.send ok runId=\(decoded.runId, privacy: .public)")
            GatewayDiagnostics.log("chat.send ok runId=\(decoded.runId) status=\(decoded.status)")
            return decoded
        } catch is GatewayNodeSessionRequestError {
            Self.logger.info("chat.send skipped because the captured route changed before dispatch")
            GatewayDiagnostics.log("chat.send skipped before dispatch: route changed")
            throw OpenClawChatTransportSendError.notDispatched
        } catch {
            Self.logger.error("chat.send failed \(error.localizedDescription, privacy: .public)")
            GatewayDiagnostics.log("chat.send failed error=\(error.localizedDescription)")
            throw error
        }
    }

    private static func mapCommandChoice(_ entry: CommandEntry) -> OpenClawChatCommandChoice {
        let sourceValue = (entry.source.value as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let source: OpenClawChatCommandChoice.Source = switch sourceValue {
        case "native":
            .command
        case "skill":
            .skill
        case "plugin":
            .plugin
        default:
            .unknown
        }
        let aliases = (entry.textaliases ?? [])
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        let id = [
            source.rawValue,
            entry.name.trimmingCharacters(in: .whitespacesAndNewlines),
            aliases.first ?? "",
        ].joined(separator: ":")
        return OpenClawChatCommandChoice(
            id: id,
            name: entry.name,
            textAliases: aliases,
            description: entry.description,
            source: source,
            acceptsArgs: entry.acceptsargs)
    }

    func waitForRunCompletion(runId rawRunId: String, timeoutMs: Int) async -> Bool {
        await self.waitForRunCompletion(
            runId: rawRunId,
            timeoutMs: timeoutMs,
            ifCurrentRoute: nil)
    }

    func waitForRunCompletion(
        runId rawRunId: String,
        timeoutMs: Int,
        ifCurrentRoute expectedRoute: GatewayNodeSessionRoute?) async -> Bool
    {
        let runId = rawRunId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !runId.isEmpty else { return false }

        do {
            let json = try Self.makeAgentWaitParamsJSON(runId: runId, timeoutMs: timeoutMs)
            let requestTimeoutSeconds = Self.agentWaitRequestTimeoutSeconds(timeoutMs: timeoutMs)
            GatewayDiagnostics.log("agent.wait start runId=\(runId)")
            let res = try await gateway.request(
                method: "agent.wait",
                paramsJSON: json,
                timeoutSeconds: requestTimeoutSeconds,
                ifCurrentRoute: expectedRoute)
            let completion = try Self.decodeAgentWaitCompletion(res, fallbackRunId: runId)
            GatewayDiagnostics.log("agent.wait completed runId=\(completion.runId) status=\(completion.status)")
            if !completion.completed {
                Self.logger.warning(
                    "agent.wait status \(completion.status, privacy: .public) runId=\(runId, privacy: .public)")
            }
            return completion.completed
        } catch {
            Self.logger.warning("agent.wait failed \(error.localizedDescription, privacy: .public)")
            GatewayDiagnostics.log("agent.wait failed runId=\(runId) error=\(error.localizedDescription)")
            return false
        }
    }

    func requestHealth(timeoutMs: Int) async throws -> Bool {
        let seconds = max(1, Int(ceil(Double(timeoutMs) / 1000.0)))
        let res = try await gateway.request(method: "health", paramsJSON: nil, timeoutSeconds: seconds)
        return (try? JSONDecoder().decode(OpenClawGatewayHealthOK.self, from: res))?.ok ?? true
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { continuation in
            let task = Task {
                let stream = await self.gateway.subscribeServerEvents()
                for await evt in stream {
                    if Task.isCancelled {
                        return
                    }
                    if let mapped = Self.mapEventFrame(evt) {
                        continuation.yield(mapped)
                    }
                }
            }

            continuation.onTermination = { @Sendable _ in
                task.cancel()
            }
        }
    }

    static func mapEventFrame(_ evt: EventFrame) -> OpenClawChatTransportEvent? {
        switch evt.event {
        case "tick":
            return .tick
        case "seqGap":
            return .seqGap
        case "health":
            guard let payload = evt.payload else { return nil }
            let ok = (try? GatewayPayloadDecoding.decode(
                payload,
                as: OpenClawGatewayHealthOK.self))?.ok ?? true
            return .health(ok: ok)
        case "chat":
            guard let payload = evt.payload else { return nil }
            guard let chatPayload = try? GatewayPayloadDecoding.decode(
                payload,
                as: OpenClawChatEventPayload.self)
            else {
                return nil
            }
            return .chat(chatPayload)
        case "session.message":
            guard let payload = evt.payload else { return nil }
            guard let message = try? GatewayPayloadDecoding.decode(
                payload,
                as: OpenClawSessionMessageEventPayload.self)
            else {
                return nil
            }
            return .sessionMessage(message)
        case "agent":
            guard let payload = evt.payload else { return nil }
            guard let agentPayload = try? GatewayPayloadDecoding.decode(
                payload,
                as: OpenClawAgentEventPayload.self)
            else {
                return nil
            }
            return .agent(agentPayload)
        default:
            return nil
        }
    }
}
