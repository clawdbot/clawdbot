import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

struct ChatGatewayTransportTests {
    @Test(arguments: [OpenClawChatSessionTargetPolicy.preserveBareKeys, .scopeBareKeysToSelectedAgent])
    func `shared operations preserve platform targeting through the transport protocol`(
        policy: OpenClawChatSessionTargetPolicy) async throws
    {
        let recorder = RequestRecorder()
        let transport: any OpenClawChatTransport = Transport(policy: policy, request: { request in
            await recorder.append(request)
            return Data(#"{"ok":true}"#.utf8)
        })
        try await transport.deleteSession(key: " main ")
        try await transport.resetSession(sessionKey: "global")
        try await transport.abortRun(sessionKey: "agent:other:main", runId: "run-1")

        let requests = await recorder.requests
        #expect(requests.map(\.method) == ["sessions.delete", "sessions.reset", "chat.abort"])
        let bareKey = switch policy {
        case .preserveBareKeys: "main"
        case .scopeBareKeysToSelectedAgent: "agent:reviewer:main"
        }
        #expect(requests[0].params["key"]?.value as? String == bareKey)
        #expect(requests[0].params["deleteTranscript"]?.value as? Bool == true)
        #expect(requests[1].params["key"]?.value as? String == "global")
        #expect(requests[1].params["agentId"]?.value as? String == "reviewer")
        #expect(requests[2].params["sessionKey"]?.value as? String == "agent:other:main")
        #expect(requests[2].params["agentId"] == nil)
        #expect(requests[2].params["runId"]?.value as? String == "run-1")
    }

    @Test func `branch operations use the platform authority hook and propagate its rejection`() async throws {
        let recorder = RequestRecorder()
        let transport: any OpenClawChatTransport = Transport(
            request: { _ in throw Failure.unexpectedRequest },
            actionRequest: { request in
                await recorder.append(request)
                if request.method == "sessions.rewind" {
                    return Data(#"{"editorText":"restored draft"}"#.utf8)
                }
                throw Failure.retiredRoute
            })

        let response = try await transport.rewindSession(sessionKey: "global", entryId: "message-1")
        #expect(response.editorText == "restored draft")
        await #expect(throws: Failure.retiredRoute) {
            try await transport.switchSessionBranch(sessionKey: "global", agentID: "other", leafEntryId: "leaf-1")
        }
        let requests = await recorder.requests
        #expect(requests.map(\.method) == ["sessions.rewind", "sessions.branches.switch"])
        #expect(requests[0].params["agentId"]?.value as? String == "reviewer")
        #expect(requests[1].params["agentId"]?.value as? String == "other")
    }

    private enum Failure: Error { case unexpectedRequest, retiredRoute }

    private actor RequestRecorder {
        var requests: [OpenClawChatGatewayRequest] = []

        func append(_ request: OpenClawChatGatewayRequest) {
            self.requests.append(request)
        }
    }

    private struct Transport: OpenClawChatGatewayTransport {
        var policy: OpenClawChatSessionTargetPolicy = .preserveBareKeys
        var request: @Sendable (OpenClawChatGatewayRequest) async throws -> Data
        var actionRequest: (@Sendable (OpenClawChatGatewayRequest) async throws -> Data)?
        let chatGatewayAgentID: String? = "reviewer"

        func sessionTarget(for sessionKey: String, overrideAgentID: String?) -> OpenClawChatSessionTarget {
            OpenClawChatSessionTarget.resolve(
                sessionKey, selectedAgentID: self.chatGatewayAgentID, overrideAgentID: overrideAgentID,
                policy: self.policy)
        }

        func requestChatGateway(_ request: OpenClawChatGatewayRequest) async throws -> Data {
            try await self.request(request)
        }

        func requestChatSessionAction(_ request: OpenClawChatGatewayRequest) async throws -> Data {
            try await (self.actionRequest ?? self.request)(request)
        }

        func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
            throw Failure.unexpectedRequest
        }

        func sendMessage(
            sessionKey: String, message: String, thinking: String, idempotencyKey: String,
            attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
        {
            throw Failure.unexpectedRequest
        }

        func requestHealth(timeoutMs: Int) async throws -> Bool {
            throw Failure.unexpectedRequest
        }

        func events() -> AsyncStream<OpenClawChatTransportEvent> {
            AsyncStream { $0.finish() }
        }
    }
}
