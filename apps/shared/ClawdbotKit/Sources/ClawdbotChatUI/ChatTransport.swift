import Foundation

public enum MoltbotChatTransportEvent: Sendable {
    case health(ok: Bool)
    case tick
    case chat(MoltbotChatEventPayload)
    case agent(MoltbotAgentEventPayload)
    case seqGap
}

public protocol MoltbotChatTransport: Sendable {
    func requestHistory(sessionKey: String) async throws -> MoltbotChatHistoryPayload
    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [MoltbotChatAttachmentPayload]) async throws -> MoltbotChatSendResponse

    func abortRun(sessionKey: String, runId: String) async throws
    func listSessions(limit: Int?) async throws -> MoltbotChatSessionsListResponse

    func requestHealth(timeoutMs: Int) async throws -> Bool
    func events() -> AsyncStream<MoltbotChatTransportEvent>

    func setActiveSessionKey(_ sessionKey: String) async throws
}

extension MoltbotChatTransport {
    public func setActiveSessionKey(_: String) async throws {}

    public func abortRun(sessionKey _: String, runId _: String) async throws {
        throw NSError(
            domain: "MoltbotChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "chat.abort not supported by this transport"])
    }

    public func listSessions(limit _: Int?) async throws -> MoltbotChatSessionsListResponse {
        throw NSError(
            domain: "MoltbotChatTransport",
            code: 0,
            userInfo: [NSLocalizedDescriptionKey: "sessions.list not supported by this transport"])
    }
}
