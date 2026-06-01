import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

@Suite struct IOSGatewayChatTransportTests {
    private func object(from json: String) throws -> [String: Any] {
        let data = try #require(json.data(using: .utf8))
        let value = try JSONSerialization.jsonObject(with: data)
        return try #require(value as? [String: Any])
    }

    @Test func agentWaitTreatsSuccessAsCompletion() {
        #expect(IOSGatewayChatTransport.isAgentWaitCompletionStatus("success"))
        #expect(IOSGatewayChatTransport.isAgentWaitCompletionStatus(" ok "))
        #expect(IOSGatewayChatTransport.isAgentWaitCompletionStatus("completed"))
        #expect(IOSGatewayChatTransport.isAgentWaitCompletionStatus("succeeded"))
        #expect(!IOSGatewayChatTransport.isAgentWaitCompletionStatus("timeout"))
        #expect(!IOSGatewayChatTransport.isAgentWaitCompletionStatus("failed"))
    }

    @Test func agentWaitTimeoutAddsGatewayMargin() {
        #expect(IOSGatewayChatTransport.agentWaitRequestTimeoutSeconds(timeoutMs: 1) == 6)
        #expect(IOSGatewayChatTransport.agentWaitRequestTimeoutSeconds(timeoutMs: 1000) == 6)
        #expect(IOSGatewayChatTransport.agentWaitRequestTimeoutSeconds(timeoutMs: 30000) == 35)
    }

    @Test func agentWaitCompletionDecodesFallbackRunId() throws {
        let data = Data(#"{"status":"completed"}"#.utf8)
        let completion = try IOSGatewayChatTransport.decodeAgentWaitCompletion(data, fallbackRunId: "run-local")
        #expect(completion.runId == "run-local")
        #expect(completion.status == "completed")
        #expect(completion.completed)
    }

    @Test func listSessionsParamsIncludeGlobalSessionsButNotUnknown() throws {
        let params = try self.object(from: IOSGatewayChatTransport.makeListSessionsParamsJSON(limit: 12))
        #expect(params["includeGlobal"] as? Bool == true)
        #expect(params["includeUnknown"] as? Bool == false)
        #expect(params["limit"] as? Int == 12)
    }

    @Test func chatSendParamsOmitEmptyAttachmentsAndKeepSessionFields() throws {
        let params = try self.object(
            from: IOSGatewayChatTransport.makeChatSendParamsJSON(
                sessionKey: "agent:main",
                message: "hello",
                thinking: "low",
                idempotencyKey: "send-1",
                attachments: []))
        #expect(params["sessionKey"] as? String == "agent:main")
        #expect(params["message"] as? String == "hello")
        #expect(params["thinking"] as? String == "low")
        #expect(params["idempotencyKey"] as? String == "send-1")
        #expect(params["timeoutMs"] as? Int == IOSGatewayChatTransport.defaultChatSendTimeoutMs)
        #expect(params["attachments"] == nil)
    }

    @Test func requestsFailFastWhenGatewayNotConnected() async {
        let gateway = GatewayNodeSession()
        let transport = IOSGatewayChatTransport(gateway: gateway)

        do {
            _ = try await transport.requestHistory(sessionKey: "node-test")
            Issue.record("Expected requestHistory to throw when gateway not connected")
        } catch {}

        do {
            _ = try await transport.sendMessage(
                sessionKey: "node-test",
                message: "hello",
                thinking: "low",
                idempotencyKey: "idempotency",
                attachments: [])
            Issue.record("Expected sendMessage to throw when gateway not connected")
        } catch {}

        do {
            _ = try await transport.requestHealth(timeoutMs: 250)
            Issue.record("Expected requestHealth to throw when gateway not connected")
        } catch {}

        do {
            try await transport.resetSession(sessionKey: "node-test")
            Issue.record("Expected resetSession to throw when gateway not connected")
        } catch {}

        do {
            try await transport.setActiveSessionKey("node-test")
            Issue.record("Expected setActiveSessionKey to throw when gateway not connected")
        } catch {}
    }

    @Test func mapsSessionMessageEventToSessionMessage() {
        let payload = AnyCodable([
            "sessionKey": AnyCodable("agent:main:main"),
            "agentId": AnyCodable("main"),
            "messageId": AnyCodable("msg-1"),
            "messageSeq": AnyCodable(7),
            "message": AnyCodable([
                "role": AnyCodable("assistant"),
                "content": AnyCodable([
                    AnyCodable([
                        "type": AnyCodable("text"),
                        "text": AnyCodable("agent reply"),
                    ]),
                ]),
                "timestamp": AnyCodable(1234.5),
            ]),
        ])
        let frame = EventFrame(
            type: "event",
            event: "session.message",
            payload: payload,
            seq: 1,
            stateversion: nil)
        let mapped = IOSGatewayChatTransport.mapEventFrame(frame)

        switch mapped {
        case let .sessionMessage(message):
            #expect(message.sessionKey == "agent:main:main")
            #expect(message.agentId == "main")
            #expect(message.messageId == "msg-1")
            #expect(message.messageSeq == 7)
            #expect(message.message?.role == "assistant")
            #expect(message.message?.content.first?.text == "agent reply")
        default:
            Issue.record("expected .sessionMessage from session.message event, got \(String(describing: mapped))")
        }
    }

    @Test func mapsChatEventToChat() {
        let payload = AnyCodable([
            "runId": AnyCodable("run-1"),
            "sessionKey": AnyCodable("main"),
            "state": AnyCodable("final"),
        ])
        let frame = EventFrame(type: "event", event: "chat", payload: payload, seq: 1, stateversion: nil)
        let mapped = IOSGatewayChatTransport.mapEventFrame(frame)

        switch mapped {
        case let .chat(chat):
            #expect(chat.runId == "run-1")
            #expect(chat.sessionKey == "main")
            #expect(chat.state == "final")
        default:
            Issue.record("expected .chat from chat event, got \(String(describing: mapped))")
        }
    }

    @Test func mapsUnknownEventToNil() {
        let frame = EventFrame(
            type: "event",
            event: "unknown",
            payload: AnyCodable(["a": AnyCodable(1)]),
            seq: 1,
            stateversion: nil)
        let mapped = IOSGatewayChatTransport.mapEventFrame(frame)
        #expect(mapped == nil)
    }
}
