import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

struct IOSGatewayChatTransportTests {
    private actor RequestRecorder {
        private var requests: [OpenClawChatGatewayRequest] = []

        func record(_ request: OpenClawChatGatewayRequest) -> Data {
            self.requests.append(request)
            return Data(#"{"key":"forked","entry":{}}"#.utf8)
        }

        func all() -> [OpenClawChatGatewayRequest] {
            self.requests
        }
    }

    @Test func `model patch result decodes authoritative Luna thinking state`() throws {
        let data = Data(
            #"""
            {
              "entry":{"thinkingLevel":"ultra"},
              "resolved":{
                "modelProvider":"openai",
                "model":"gpt-5.6-luna",
                "thinkingLevel":"max",
                "thinkingLevels":[{"id":"off","label":"off"},{"id":"max","label":"max"}]
              }
            }
            """#.utf8)

        let result = try IOSGatewayChatTransport.decodeModelPatchResult(data)

        #expect(result.modelProvider == "openai")
        #expect(result.model == "gpt-5.6-luna")
        #expect(result.thinkingLevel == "max")
        #expect(result.thinkingLevels?.map(\.id) == ["off", "max"])
    }

    @Test func `live routing guard permits an identity still loading`() {
        #expect(OpenClawChatSessionRoutingContract.expectedValue(
            nil,
            serverSupportsGuard: true) == nil)
        #expect(OpenClawChatSessionRoutingContract.expectedValue(
            " per-sender|main|reviewer ",
            serverSupportsGuard: true) == "per-sender|main|reviewer")
        #expect(OpenClawChatSessionRoutingContract.expectedValue(
            "per-sender|main|reviewer",
            serverSupportsGuard: false) == nil)
    }

    @Test func `routing contract round trips a delimited legacy main key`() throws {
        let contract = try #require(OpenClawChatSessionRoutingContract.make(
            scope: "per-sender",
            mainKey: "team|primary",
            defaultAgentID: "main"))
        let components = try #require(OpenClawChatSessionRoutingContract.parse(contract))
        #expect(components.scope == "per-sender")
        #expect(components.mainKey == "team|primary")
        #expect(components.defaultAgentID == "main")
    }

    @Test func `hello advertises guarded chat send capability`() throws {
        let data = Data(
            #"""
            {
              "type":"hello-ok",
              "protocol":4,
              "server":{"version":"test","connId":"test"},
              "features":{"methods":[],"events":[],"capabilities":["chat-send-routing-contract"]},
              "snapshot":{
                "presence":[],
                "health":{},
                "stateVersion":{"presence":0,"health":0},
                "uptimeMs":0
              },
              "auth":{},
              "policy":{}
            }
            """#.utf8)
        let hello = try JSONDecoder().decode(HelloOk.self, from: data)
        #expect(hello.supportsServerCapability(.chatSendRoutingContract))
    }

    @Test func `session mutations dispatch normalized selected agent targets`() async throws {
        let recorder = RequestRecorder()
        let transport = IOSGatewayChatTransport(
            gateway: GatewayNodeSession(),
            globalAgentId: " Reviewer ",
            sessionMutationRequest: { request in
                await recorder.record(request)
            })

        for key in ["Matrix:Channel:Room", "global", "agent:ops:main"] {
            try await transport.patchSession(key: key, pinned: true)
            try await transport.deleteSession(key: key)
            _ = try await transport.forkSession(parentKey: key)
        }

        let requests = await recorder.all()
        #expect(requests.map(\.method) == Array(
            repeating: ["sessions.patch", "sessions.delete", "sessions.create"],
            count: 3).flatMap(\.self))
        #expect(requests.map(\.timeoutMs) == Array(repeating: 15000, count: 9))

        for (offset, expectedKey, expectedMutationAgentID, expectedForkAgentID) in [
            (0, "agent:reviewer:Matrix:Channel:Room", nil, "reviewer"),
            (3, "global", "reviewer", "reviewer"),
            (6, "agent:ops:main", nil, "ops"),
        ] as [(Int, String, String?, String?)] {
            let patch = requests[offset].params
            #expect(patch["key"]?.value as? String == expectedKey)
            #expect(patch["agentId"]?.value as? String == expectedMutationAgentID)
            #expect(patch["pinned"]?.value as? Bool == true)

            let delete = requests[offset + 1].params
            #expect(delete["key"]?.value as? String == expectedKey)
            #expect(delete["agentId"]?.value as? String == expectedMutationAgentID)
            #expect(delete["deleteTranscript"]?.value as? Bool == true)

            let fork = requests[offset + 2].params
            #expect(fork["parentSessionKey"]?.value as? String == expectedKey)
            #expect(fork["agentId"]?.value as? String == expectedForkAgentID)
            #expect(fork["fork"]?.value as? Bool == true)
        }
    }

    @Test func `thinking changes dispatch through selected agent session target`() async throws {
        let recorder = RequestRecorder()
        let transport = IOSGatewayChatTransport(
            gateway: GatewayNodeSession(),
            globalAgentId: " Reviewer ",
            sessionMutationRequest: { request in
                await recorder.record(request)
            })

        try await transport.setSessionThinking(sessionKey: "global", thinkingLevel: "high")

        let request = try #require(await recorder.all().first)
        #expect(request.method == "sessions.patch")
        #expect(request.params["key"]?.value as? String == "global")
        #expect(request.params["agentId"]?.value as? String == "reviewer")
        #expect(request.params["thinkingLevel"]?.value as? String == "high")
    }

    @Test func `verbosity patches preserve set and clear values`() async throws {
        let recorder = RequestRecorder()
        let transport = IOSGatewayChatTransport(
            gateway: GatewayNodeSession(),
            globalAgentId: " Reviewer ",
            sessionMutationRequest: { request in
                await recorder.record(request)
            })

        _ = try await transport.patchSessionSettings(
            sessionKey: "global",
            agentID: nil,
            patch: OpenClawChatSessionSettingsPatch(verboseLevel: .some("full")))
        _ = try await transport.patchSessionSettings(
            sessionKey: "global",
            agentID: nil,
            patch: OpenClawChatSessionSettingsPatch(verboseLevel: .some(nil)))

        let requests = await recorder.all()
        #expect(requests.count == 2)
        #expect(requests.allSatisfy { $0.method == "sessions.patch" })
        #expect(requests.allSatisfy { $0.params["key"]?.value as? String == "global" })
        #expect(requests.allSatisfy { $0.params["agentId"]?.value as? String == "reviewer" })
        #expect(requests[0].params["verboseLevel"]?.value as? String == "full")
        #expect(requests[1].params["verboseLevel"]?.value is NSNull)
        #expect(requests.allSatisfy { $0.params["model"] == nil })
        #expect(requests.allSatisfy { $0.params["thinkingLevel"] == nil })
    }

    @Test func `requests fail fast when gateway not connected`() async {
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
            _ = try await transport.sendMessage(
                sessionKey: "node-test",
                agentID: "main",
                expectedSessionRoutingContract: "per-sender|main|main",
                message: "hello",
                thinking: "low",
                idempotencyKey: "guarded-idempotency",
                attachments: [])
            Issue.record("Expected guarded sendMessage to fail before dispatch")
        } catch is OpenClawChatTransportSendError {
            // Expected: a missing route never reached chat.send.
        } catch {
            Issue.record("Expected a typed pre-dispatch failure, got \(error)")
        }

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

    @Test func `maps session message event to session message`() {
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
        let mapped = OpenClawChatGatewayPayloadCodec.event(from: frame)

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

    @Test func `maps sessions changed event to authoritative refresh signal`() {
        let payload = AnyCodable([
            "sessionKey": AnyCodable("agent:main:main"),
            "agentId": AnyCodable("main"),
            "reason": AnyCodable("command-metadata"),
        ])
        let frame = EventFrame(
            type: "event",
            event: "sessions.changed",
            payload: payload,
            seq: 1,
            stateversion: nil)

        let mapped = OpenClawChatGatewayPayloadCodec.event(from: frame)
        guard case let .sessionsChanged(change) = mapped else {
            Issue.record("expected .sessionsChanged, got \(String(describing: mapped))")
            return
        }
        #expect(change == .init(
            sessionKey: "agent:main:main",
            agentId: "main",
            reason: "command-metadata"))
    }

    @Test func `maps chat event to chat`() {
        let payload = AnyCodable([
            "runId": AnyCodable("run-1"),
            "sessionKey": AnyCodable("main"),
            "state": AnyCodable("final"),
        ])
        let frame = EventFrame(type: "event", event: "chat", payload: payload, seq: 1, stateversion: nil)
        let mapped = OpenClawChatGatewayPayloadCodec.event(from: frame)

        switch mapped {
        case let .chat(chat):
            #expect(chat.runId == "run-1")
            #expect(chat.sessionKey == "main")
            #expect(chat.state == "final")
        default:
            Issue.record("expected .chat from chat event, got \(String(describing: mapped))")
        }
    }

    @Test func `maps unknown event to nil`() {
        let frame = EventFrame(
            type: "event",
            event: "unknown",
            payload: AnyCodable(["a": AnyCodable(1)]),
            seq: 1,
            stateversion: nil)
        let mapped = OpenClawChatGatewayPayloadCodec.event(from: frame)
        #expect(mapped == nil)
    }
}

struct LocalFixtureChatTransportTests {
    @Test func `sent user turn carries gateway idempotency metadata`() async throws {
        let transport = LocalFixtureChatTransport(fixture: .appleReviewDemo)

        _ = try await transport.sendMessage(
            sessionKey: "main",
            message: "hello",
            thinking: "auto",
            idempotencyKey: "fixture-run",
            attachments: [])
        let history = try await transport.requestHistory(sessionKey: "main")
        let decoded = try #require(history.messages).compactMap { payload -> OpenClawChatMessage? in
            guard let data = try? JSONEncoder().encode(payload) else { return nil }
            return try? JSONDecoder().decode(OpenClawChatMessage.self, from: data)
        }

        #expect(decoded.last(where: { $0.role == "user" })?.idempotencyKey == "fixture-run:user")
    }
}
