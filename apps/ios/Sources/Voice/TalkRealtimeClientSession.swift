import Foundation

struct TalkRealtimeClientCreateParams: Encodable {
    var sessionKey: String?
    var voiceSessionId: String?
    var mode = "realtime"
    var provider: String?
    var transport = "webrtc"
    var brain = "agent-consult"
    var model: String?
    var voice: String?
    var capabilities: [String]
}

struct TalkRealtimeClientSession: Decodable {
    let provider: String
    let transport: String
    let voiceSessionId: String?
    let clientSecret: String
    let offerUrl: String?
    let offerHeaders: [String: String]?
    let model: String?
    let voice: String?
    let expiresAt: Double?

    var isWebRTC: Bool {
        self.transport.caseInsensitiveCompare("webrtc") == .orderedSame
    }
}

enum TalkRealtimeTranscriptRole: String, Encodable {
    case user
    case assistant
}

struct TalkRealtimeTranscriptParams: Encodable {
    let sessionKey: String
    let voiceSessionId: String
    let entryId: String
    let role: TalkRealtimeTranscriptRole
    let text: String
    let timestamp: Double?
}

struct TalkRealtimeClientCloseParams: Encodable {
    let sessionKey: String
    let voiceSessionId: String
}

struct TalkRealtimeToolCallResponse: Decodable {
    let runId: String?
    let idempotencyKey: String?
    let agentId: String?
    let agentSessionKey: String?

    func resolvedRunIdentity(fallbackSessionKey: String) -> TalkRealtimeRunIdentity? {
        guard let runId = Self.nonEmpty(self.runId) ?? Self.nonEmpty(self.idempotencyKey) else {
            return nil
        }
        let returnedAgentId = Self.nonEmpty(self.agentId)
        let returnedSessionKey = Self.nonEmpty(self.agentSessionKey)
        guard (returnedAgentId == nil) == (returnedSessionKey == nil) else { return nil }

        // Protocol-v4 Gateways originally omitted both target fields. Accept only
        // that complete legacy shape; a partial pair is an invalid acknowledgement.
        let usesLegacyTarget = returnedAgentId == nil
        guard let agentSessionKey = returnedSessionKey ?? Self.nonEmpty(fallbackSessionKey) else {
            return nil
        }
        return TalkRealtimeRunIdentity(
            runId: runId,
            agentSessionKey: agentSessionKey,
            agentId: returnedAgentId,
            acceptsLegacyMainAlias: usesLegacyTarget)
    }

    private static func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

struct TalkRealtimeAgentWaitResponse: Decodable {
    struct TerminalReply: Decodable {
        let disposition: String
        let text: String?

        var resultText: String? {
            switch self.disposition.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
            case "visible":
                let trimmed = self.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                return trimmed.isEmpty ? nil : trimmed
            case "silent", "empty":
                return "OpenClaw finished with no text."
            default:
                return nil
            }
        }
    }

    let runId: String?
    let status: String?
    let startedAt: Double?
    let error: String?
    let stopReason: String?
    let timeoutPhase: String?
    let providerStarted: Bool?
    let terminalReply: TerminalReply?

    var authoritativeResultText: String? {
        self.terminalReply?.resultText
    }
}

enum TalkRealtimeAgentWaitResultError: LocalizedError {
    case finalReplyUnavailable

    var errorDescription: String? {
        switch self {
        case .finalReplyUnavailable:
            """
            OpenClaw completed the request, but the Gateway did not return its authoritative final reply. \
            Update OpenClaw and try again.
            """
        }
    }
}

enum TalkRealtimeToolCallAcknowledgement {
    static func waitForResponse(
        _ request: @escaping @Sendable () async throws -> Data) async throws -> Data
    {
        // GatewayNodeSession.request is cancellation-aware. The acknowledgement
        // owns the run identity, so it must survive cancellation of its caller long
        // enough for the caller to issue an exact chat.abort.
        let acknowledgement = Task { try await request() }
        return try await acknowledgement.value
    }
}

struct TalkRealtimeRunIdentity: Hashable, Sendable {
    let runId: String
    let agentSessionKey: String
    let agentId: String?
    private let acceptsLegacyMainAlias: Bool

    init(
        runId: String,
        agentSessionKey: String,
        agentId: String?,
        acceptsLegacyMainAlias: Bool)
    {
        self.runId = runId
        self.agentSessionKey = agentSessionKey
        self.agentId = agentId
        self.acceptsLegacyMainAlias = acceptsLegacyMainAlias
    }

    func matches(sessionKey: String?) -> Bool {
        guard let incoming = sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !incoming.isEmpty
        else { return true }
        let expected = self.agentSessionKey
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        if incoming == expected { return true }
        guard self.acceptsLegacyMainAlias else { return false }
        return (incoming == "agent:main:main" && expected == "main") ||
            (incoming == "main" && expected == "agent:main:main")
    }
}

struct TalkRealtimeServerEvent: Decodable {
    let type: String
    let error: TalkRealtimeServerError?
    let itemId: String?
    let item: TalkRealtimeServerItem?
    let turn: TalkRealtimeServerTurn?
    let callId: String?
    let name: String?
    let delta: String?
    let arguments: String?
    let transcript: String?
    let text: String?

    enum CodingKeys: String, CodingKey {
        case type
        case error
        case itemId = "item_id"
        case item
        case turn
        case callId = "call_id"
        case name
        case delta
        case arguments
        case transcript
        case text
    }

    var resolvedItemId: String? {
        self.itemId ?? self.item?.id
    }

    var resolvedCallId: String? {
        self.callId ?? self.item?.callId
    }

    var resolvedName: String? {
        self.name ?? self.item?.name
    }

    var resolvedArguments: String? {
        self.arguments ?? self.item?.arguments
    }

    var isMaximumDurationError: Bool {
        guard self.type == "error", let message = self.error?.message?.lowercased() else { return false }
        return message.contains("session") && message.contains("maximum duration")
    }
}

struct TalkRealtimeServerError: Decodable {
    let message: String?
}

struct TalkRealtimeServerTurn: Decodable {
    let id: String?
    let role: String?
    let transcript: String?
}

struct TalkRealtimeServerItem: Decodable {
    let id: String?
    let type: String?
    let text: String?
    let callId: String?
    let name: String?
    let arguments: String?

    enum CodingKeys: String, CodingKey {
        case id
        case type
        case text
        case callId = "call_id"
        case name
        case arguments
    }
}
