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
            return .sessionMessage(message)
        case "agent":
            guard let payload = frame.payload,
                  let agent = try? GatewayPayloadDecoding.decode(
                      payload,
                      as: OpenClawAgentEventPayload.self)
            else { return nil }
            return .agent(agent)
        case "question.requested":
            guard let payload = frame.payload,
                  let question = try? GatewayPayloadDecoding.decode(payload, as: QuestionRecord.self)
            else { return nil }
            return .questionRequested(question)
        case "question.resolved":
            guard let payload = frame.payload,
                  let resolved = try? GatewayPayloadDecoding.decode(
                      payload,
                      as: OpenClawQuestionResolvedEvent.self)
            else { return nil }
            return .questionResolved(resolved)
        default:
            return nil
        }
    }
}
