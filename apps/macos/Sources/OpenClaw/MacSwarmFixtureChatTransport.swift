#if DEBUG
import Foundation
import OpenClawChatUI
import OpenClawProtocol

struct MacSwarmFixtureChatTransport: OpenClawChatTransport {
    let sessionKey = "agent:main:swarm-fixture"

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        OpenClawChatHistoryPayload(
            sessionKey: sessionKey,
            sessionId: "mac-swarm-fixture",
            messages: [
                AnyCodable([
                    "role": "assistant",
                    "content": [["type": "text", "text": "Coordinating five independent research threads."]],
                    "timestamp": 1,
                ]),
            ],
            thinkingLevel: "medium")
    }

    func listModels() async throws -> [OpenClawChatModelChoice] {
        [OpenClawChatModelChoice(
            modelID: "gpt-5.6-sol",
            name: "GPT-5.6 Sol",
            provider: "openai",
            contextWindow: 400_000)]
    }

    func isSwarmEnabled(sessionKey _: String) async throws -> Bool {
        true
    }

    func sendMessage(
        sessionKey _: String,
        message _: String,
        thinking _: String,
        idempotencyKey: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        try JSONDecoder().decode(
            OpenClawChatSendResponse.self,
            from: Data("{\"runId\":\"\(idempotencyKey)\",\"status\":\"ok\"}".utf8))
    }

    func listSessions(
        limit _: Int?,
        search _: String?,
        archived _: Bool) async throws -> OpenClawChatSessionsListResponse
    {
        OpenClawChatSessionsListResponse(
            ts: 1,
            path: nil,
            count: 1,
            defaults: OpenClawChatSessionsDefaults(
                modelProvider: "openai",
                model: "gpt-5.6-sol",
                contextTokens: 400_000,
                mainSessionKey: self.sessionKey),
            sessions: [self.session(
                key: self.sessionKey,
                label: "Swarm research",
                status: "running",
                groupID: nil)])
    }

    func listChildSessions(parentKey: String) async throws -> [OpenClawChatSessionEntry] {
        let groupID = "swarm:\(parentKey):research"
        return [
            self.session(
                key: "polling",
                label: "National polling",
                status: "done",
                groupID: groupID,
                parentKey: parentKey),
            self.session(
                key: "work",
                label: "Work and labor",
                status: "running",
                groupID: groupID,
                parentKey: parentKey),
            self.session(key: "health", label: "Health", status: "running", groupID: groupID, parentKey: parentKey),
            self.session(
                key: "trust",
                label: "Governance and trust",
                status: nil,
                groupID: groupID,
                parentKey: parentKey,
                queued: true),
            self.session(
                key: "media",
                label: "Media signals",
                status: "failed",
                groupID: groupID,
                parentKey: parentKey),
        ]
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { continuation in continuation.finish() }
    }

    func setActiveSessionKey(_: String) async throws {}

    private func session(
        key: String,
        label: String,
        status: String?,
        groupID: String?,
        parentKey: String? = nil,
        queued: Bool = false) -> OpenClawChatSessionEntry
    {
        OpenClawChatSessionEntry(
            key: key,
            kind: "direct",
            displayName: label,
            surface: nil,
            subject: nil,
            room: nil,
            space: nil,
            updatedAt: 1,
            sessionId: nil,
            systemSent: nil,
            abortedLastRun: nil,
            thinkingLevel: nil,
            verboseLevel: nil,
            inputTokens: nil,
            outputTokens: nil,
            totalTokens: nil,
            modelProvider: "openai",
            model: "gpt-5.6-sol",
            contextTokens: 400_000,
            parentSessionKey: parentKey,
            spawnedBy: parentKey,
            status: status,
            hasActiveRun: status == "running",
            subagentRunState: queued ? "active" : nil,
            swarmGroupId: groupID,
            swarmPhase: groupID == nil ? nil : "Research",
            swarmPhaseRank: groupID == nil ? nil : 0,
            swarmLog: groupID == nil ? nil : "Comparing labor, education, health, trust, and media signals.")
    }
}
#endif
