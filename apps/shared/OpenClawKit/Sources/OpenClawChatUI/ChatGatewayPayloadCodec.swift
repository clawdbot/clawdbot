import Foundation
import OpenClawKit
import OpenClawProtocol

public enum OpenClawChatSessionKey {
    public static func agentID(from sessionKey: String?) -> String? {
        let parts = (sessionKey ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count >= 3, parts[0].lowercased() == "agent" else { return nil }
        let agentID = String(parts[1]).trimmingCharacters(in: .whitespacesAndNewlines)
        return agentID.isEmpty ? nil : agentID
    }
}

/// Canonical gateway payload mapping shared by the native Apple chat transports.
public enum OpenClawChatGatewayPayloadCodec {
    public static func decodeAgentsList(_ data: Data) throws -> OpenClawChatAgentsListResponse {
        let result = try JSONDecoder().decode(AgentsListResult.self, from: data)
        return OpenClawChatAgentsListResponse(
            defaultId: result.defaultid,
            agents: result.agents.filter(\.isSelectableAgent).map {
                OpenClawChatAgentChoice(
                    id: $0.id,
                    name: $0.name,
                    workspaceGit: $0.workspacegit)
            })
    }

    public static func decodeProgressCard(_ data: Data, agentID: String?) throws -> ProgressCard? {
        let result = try JSONDecoder().decode(ProgressCardGetResult.self, from: data)
        guard !(result.card.value is NSNull) else { return nil }
        let card = try GatewayPayloadDecoding.decode(result.card, as: ProgressCard.self)
        if let agentID,
           OpenClawChatSessionKey.agentID(from: card.sessionkey)?.lowercased() != agentID.lowercased()
        {
            throw NSError(domain: "OpenClawChatTransport", code: 0, userInfo: [
                NSLocalizedDescriptionKey: "Progress card response belongs to another agent.",
            ])
        }
        return card
    }

    public static func decodeQuestionAnswer(_ data: Data) throws -> QuestionAnswers {
        struct AnsweredQuestion: Decodable {
            enum Status: String, Decodable { case answered }
            let status: Status
            let answers: QuestionAnswers
        }
        return try JSONDecoder().decode(AnsweredQuestion.self, from: data).answers
    }

    private struct AgentWaitResponse: Decodable {
        var status: String?
        var endedAt: Double?
        var error: String?
        var stopReason: String?
        var livenessState: String?
        var yielded: Bool?
        var pendingError: Bool?
        var timeoutPhase: String?
        var providerStarted: Bool?
        var aborted: Bool?
    }

    public static func decodeAgentWaitObservation(_ data: Data) throws -> OpenClawChatRunObservation {
        let decoded = try JSONDecoder().decode(AgentWaitResponse.self, from: data)
        return OpenClawChatRunObservation.fromWaitResponse(
            status: decoded.status,
            endedAt: decoded.endedAt,
            error: decoded.error,
            stopReason: decoded.stopReason,
            livenessState: decoded.livenessState,
            yielded: decoded.yielded,
            pendingError: decoded.pendingError,
            timeoutPhase: decoded.timeoutPhase,
            providerStarted: decoded.providerStarted,
            aborted: decoded.aborted)
    }

    public static func decodeModelChoices(_ data: Data) throws -> [OpenClawChatModelChoice] {
        let decoded = try JSONDecoder().decode(ModelsListResult.self, from: data)
        return decoded.models.map(self.modelChoice)
    }

    public static func decodeChatMetadataModelChoices(_ data: Data) throws -> [OpenClawChatModelChoice] {
        struct ChatMetadataModels: Decodable {
            let models: [ModelChoice]?
        }
        let decoded = try JSONDecoder().decode(ChatMetadataModels.self, from: data)
        return (decoded.models ?? []).map(self.modelChoice)
    }

    public static func decodeSessionRoutingIdentity(_ data: Data) throws -> OpenClawChatSessionRoutingIdentity {
        let decoded = try JSONDecoder().decode(AgentsListResult.self, from: data)
        guard let identity = OpenClawChatSessionRoutingIdentity(
            scope: decoded.scope.value as? String,
            mainSessionKey: decoded.mainkey,
            defaultAgentID: decoded.defaultid)
        else { throw CancellationError() }
        return identity
    }

    public static func modelChoice(_ model: ModelChoice) -> OpenClawChatModelChoice {
        let name = model.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return OpenClawChatModelChoice(
            modelID: model.id,
            name: name.isEmpty ? model.id : model.name,
            provider: model.provider,
            available: model.available,
            unavailableReason: model.unavailablereason?.value as? String,
            unavailableUntil: model.unavailableuntil,
            contextWindow: model.contextwindow,
            reasoning: model.reasoning)
    }

    public static func commandChoice(_ entry: CommandEntry) -> OpenClawChatCommandChoice {
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

    public static func event(from frame: EventFrame) -> OpenClawChatTransportEvent? {
        switch frame.event {
        case "tick":
            return .tick
        case "chat.metadata.changed":
            return .chatMetadataChanged
        case "sessions.changed":
            guard let payload = frame.payload,
                  let change = try? GatewayPayloadDecoding.decode(
                      payload,
                      as: OpenClawChatSessionsChangedEvent.self)
            else { return nil }
            return .sessionsChanged(change)
        case "session.observer":
            guard let payload = frame.payload,
                  let digest = try? GatewayPayloadDecoding.decode(
                      payload,
                      as: SessionObserverDigest.self)
            else { return nil }
            return .sessionObserver(digest)
        case "seqGap":
            return .seqGap
        case "health":
            guard let payload = frame.payload else { return nil }
            let ok = (try? GatewayPayloadDecoding.decode(
                payload,
                as: OpenClawGatewayHealthOK.self))?.ok ?? true
            return .health(ok: ok)
        case "chat":
            guard let payload = frame.payload,
                  let chat = try? GatewayPayloadDecoding.decode(
                      payload,
                      as: OpenClawChatEventPayload.self)
            else { return nil }
            return .chat(chat)
        case "session.message":
            guard let payload = frame.payload,
                  let message = try? GatewayPayloadDecoding.decode(
                      payload,
                      as: OpenClawSessionMessageEventPayload.self)
            else { return nil }
            if var canonicalMessage = message.message,
               canonicalMessage.transcriptMessageID?
                   .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false,
                   let messageID = message.messageId?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !messageID.isEmpty
            {
                // Live events carry durable transcript identity on their envelope.
                // Preserve it on the row so history cannot replay the same message.
                canonicalMessage.transcriptMessageID = messageID
                return .sessionMessage(OpenClawSessionMessageEventPayload(
                    sessionKey: message.sessionKey,
                    agentId: message.agentId,
                    message: canonicalMessage,
                    messageId: message.messageId,
                    messageSeq: message.messageSeq,
                    hasActiveRun: message.hasActiveRun,
                    activeRunIds: message.activeRunIds,
                    activeRunIdsPresent: message.activeRunIdsPresent))
            }
            return .sessionMessage(message)
        case "agent":
            guard let payload = frame.payload,
                  let agent = try? GatewayPayloadDecoding.decode(
                      payload,
                      as: OpenClawAgentEventPayload.self)
            else { return nil }
            return .agent(agent)
        case "progressCard.changed":
            guard let payload = frame.payload,
                  let event = try? GatewayPayloadDecoding.decode(
                      payload,
                      as: ProgressCardChangedEvent.self)
            else { return nil }
            return .progressCardChanged(event)
        default:
            return self.secondaryEvent(from: frame)
        }
    }

    private static func secondaryEvent(from frame: EventFrame) -> OpenClawChatTransportEvent? {
        guard let payload = frame.payload else { return nil }
        switch frame.event {
        case "task":
            return (try? GatewayPayloadDecoding.decode(payload, as: OpenClawChatTaskEvent.self))
                .map(OpenClawChatTransportEvent.task)
        case "question.requested":
            return (try? GatewayPayloadDecoding.decode(payload, as: QuestionRecord.self))
                .map(OpenClawChatTransportEvent.questionRequested)
        case "question.resolved":
            return (try? GatewayPayloadDecoding.decode(payload, as: OpenClawQuestionResolvedEvent.self))
                .map(OpenClawChatTransportEvent.questionResolved)
        default:
            return nil
        }
    }
}
