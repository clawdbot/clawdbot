import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

struct IOSGatewayChatTransportTests {
    private actor RequestRecorder {
        struct Request: Sendable {
            var method: String
            var paramsJSON: String
            var timeoutSeconds: Int
        }

        private var requests: [Request] = []

        func record(method: String, paramsJSON: String, timeoutSeconds: Int) -> Data {
            self.requests.append(Request(
                method: method,
                paramsJSON: paramsJSON,
                timeoutSeconds: timeoutSeconds))
            return Data(#"{"key":"forked"}"#.utf8)
        }

        func all() -> [Request] {
            self.requests
        }
    }

    private func object(from json: String) throws -> [String: Any] {
        let data = try #require(json.data(using: .utf8))
        let value = try JSONSerialization.jsonObject(with: data)
        return try #require(value as? [String: Any])
    }

    @Test func `agent wait timeout adds gateway margin`() {
        #expect(IOSGatewayChatTransport.agentWaitRequestTimeoutSeconds(timeoutMs: 1) == 6)
        #expect(IOSGatewayChatTransport.agentWaitRequestTimeoutSeconds(timeoutMs: 1000) == 6)
        #expect(IOSGatewayChatTransport.agentWaitRequestTimeoutSeconds(timeoutMs: 30000) == 35)
    }

    @Test func `compaction leaves terminal timeout to gateway`() {
        #expect(IOSGatewayChatTransport.compactionRequestTimeoutSeconds == 0)
    }

    @Test func `agent wait distinguishes terminal and retryable timeouts`() throws {
        let data = Data(#"{"status":"completed"}"#.utf8)
        #expect(try IOSGatewayChatTransport.decodeAgentWaitObservation(data) == .terminal(.completed))

        let pending = Data(#"{"status":"pending"}"#.utf8)
        #expect(try IOSGatewayChatTransport.decodeAgentWaitObservation(pending) == .checkAgain)

        let queued = Data(#"{"status":"timeout","timeoutPhase":"queue","providerStarted":false}"#.utf8)
        #expect(try IOSGatewayChatTransport.decodeAgentWaitObservation(queued) == .checkAgain)

        let providerTimeout = Data(
            #"{"status":"timeout","timeoutPhase":"provider","providerStarted":true}"#.utf8)
        #expect(
            try IOSGatewayChatTransport.decodeAgentWaitObservation(providerTimeout) ==
                .terminal(.failed(message: "Run timed out")))

        let stopped = Data(#"{"status":"timeout","stopReason":"stop"}"#.utf8)
        #expect(
            try IOSGatewayChatTransport.decodeAgentWaitObservation(stopped) ==
                .terminal(.failed(message: "Run cancelled")))
    }

    @Test func `model patch result decodes authoritative Luna thinking state`() throws {
        let data = Data(
            #"{"entry":{"thinkingLevel":"ultra"},"resolved":{"modelProvider":"openai","model":"gpt-5.6-luna","thinkingLevel":"max","thinkingLevels":[{"id":"off","label":"off"},{"id":"max","label":"max"}]}}"#
                .utf8)

        let result = try IOSGatewayChatTransport.decodeModelPatchResult(data)

        #expect(result.modelProvider == "openai")
        #expect(result.model == "gpt-5.6-luna")
        #expect(result.thinkingLevel == "max")
        #expect(result.thinkingLevels?.map(\.id) == ["off", "max"])
    }

    @Test func `routing contract decodes gateway main semantics`() throws {
        let data = Data(#"{"defaultId":"Ops","mainKey":"Work","scope":"global","agents":[]}"#.utf8)
        #expect(try IOSGatewayChatTransport.decodeSessionRoutingContract(data) == "global|work|ops")
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
            #"{"type":"hello-ok","protocol":4,"server":{"version":"test","connId":"test"},"features":{"methods":[],"events":[],"capabilities":["chat-send-routing-contract"]},"snapshot":{"presence":[],"health":{},"stateVersion":{"presence":0,"health":0},"uptimeMs":0},"auth":{},"policy":{}}"#
                .utf8)
        let hello = try JSONDecoder().decode(HelloOk.self, from: data)
        #expect(hello.supportsServerCapability(.chatSendRoutingContract))
    }

    @Test func `list sessions params include global sessions but not unknown`() throws {
        let params = try object(from: IOSGatewayChatTransport.makeListSessionsParamsJSON(limit: 12))
        #expect(params["includeGlobal"] as? Bool == true)
        #expect(params["includeUnknown"] as? Bool == false)
        #expect(params["limit"] as? Int == 12)
        #expect(params["archived"] == nil)
    }

    @Test func `list sessions params request archived sessions explicitly`() throws {
        let params = try object(
            from: IOSGatewayChatTransport.makeListSessionsParamsJSON(limit: 12, archived: true))
        #expect(params["archived"] as? Bool == true)
    }

    @Test func `patch session params preserve explicit null clearing`() throws {
        let params = try object(
            from: IOSGatewayChatTransport.makePatchSessionParamsJSON(
                key: "session-1",
                label: .some(nil),
                category: .some(nil),
                pinned: true,
                unread: false))
        #expect(params["key"] as? String == "session-1")
        #expect(params["label"] is NSNull)
        #expect(params["category"] is NSNull)
        #expect(params["pinned"] as? Bool == true)
        #expect(params["unread"] as? Bool == false)
        #expect(params["archived"] == nil)
    }

    @Test func `patch session params include selected global agent`() throws {
        let params = try object(
            from: IOSGatewayChatTransport.makePatchSessionParamsJSON(
                key: "global",
                agentId: "reviewer",
                unread: false))
        #expect(params["key"] as? String == "global")
        #expect(params["agentId"] as? String == "reviewer")
        #expect(params["unread"] as? Bool == false)
    }

    @Test func `fork session params preserve parent agent`() throws {
        let params = try object(
            from: IOSGatewayChatTransport.makeForkSessionParamsJSON(
                parentKey: "agent:reviewer:telegram:group:1",
                agentId: "reviewer"))
        #expect(params["parentSessionKey"] as? String == "agent:reviewer:telegram:group:1")
        #expect(params["fork"] as? Bool == true)
        #expect(params["agentId"] as? String == "reviewer")
    }

    @Test func `session model patch params include model and selected agent`() throws {
        let params = try object(
            from: IOSGatewayChatTransport.makeSessionPatchModelParamsJSON(
                sessionKey: "global",
                agentId: "reviewer",
                model: "anthropic/claude-opus-4"))
        #expect(params["key"] as? String == "global")
        #expect(params["agentId"] as? String == "reviewer")
        #expect(params["model"] as? String == "anthropic/claude-opus-4")
    }

    @Test func `session model patch params encode default model as null`() throws {
        let params = try object(
            from: IOSGatewayChatTransport.makeSessionPatchModelParamsJSON(
                sessionKey: "agent:main:main",
                model: nil))
        #expect(params["key"] as? String == "agent:main:main")
        #expect(params["agentId"] == nil)
        #expect(params["model"] is NSNull)
    }

    @Test func `models list response decodes choices reasoning and blank names`() throws {
        let data = Data(
            #"""
            {"models":[
              {"id":"claude-opus-4","name":"Claude Opus 4","provider":"anthropic","contextWindow":200000,"reasoning":true},
              {"id":"gpt-5","name":"  ","provider":"openai","extra":"ignored"}
            ]}
            """#.utf8)
        let choices = try IOSGatewayChatTransport.decodeModelChoices(data)

        #expect(choices.count == 2)
        #expect(choices[0].modelID == "claude-opus-4")
        #expect(choices[0].name == "Claude Opus 4")
        #expect(choices[0].provider == "anthropic")
        #expect(choices[0].contextWindow == 200_000)
        #expect(choices[0].reasoning == true)
        #expect(choices[1].modelID == "gpt-5")
        #expect(choices[1].name == "gpt-5")
        #expect(choices[1].provider == "openai")
        #expect(choices[1].contextWindow == nil)
        #expect(choices[1].reasoning == nil)
    }

    @Test func `commands list params request text scope with args`() throws {
        let params = try object(from: IOSGatewayChatTransport.makeCommandsListParamsJSON())
        #expect(params["scope"] as? String == "text")
        #expect(params["includeArgs"] as? Bool == true)
        #expect(params["agentId"] == nil)
    }

    @Test func `commands list params include agent for agent scoped session`() throws {
        let params = try object(
            from: IOSGatewayChatTransport.makeCommandsListParamsJSON(sessionKey: "agent:reviewer:ios-main"))
        #expect(params["scope"] as? String == "text")
        #expect(params["includeArgs"] as? Bool == true)
        #expect(params["agentId"] as? String == "reviewer")
    }

    @Test func `commands list params use explicit agent for selected global session`() throws {
        let params = try object(
            from: IOSGatewayChatTransport.makeCommandsListParamsJSON(
                sessionKey: "global",
                agentId: "reviewer"))
        #expect(params["agentId"] as? String == "reviewer")
    }

    @Test func `create session params include selected global agent`() throws {
        let params = try object(
            from: IOSGatewayChatTransport.makeCreateSessionParamsJSON(
                key: "agent:reviewer:ios-new",
                agentId: "reviewer",
                label: nil,
                parentSessionKey: "global",
                worktree: true))
        #expect(params["key"] as? String == "agent:reviewer:ios-new")
        #expect(params["agentId"] as? String == "reviewer")
        #expect(params["parentSessionKey"] as? String == "global")
        #expect(params["worktree"] as? Bool == true)
    }

    @Test func `chat send params omit empty attachments and keep session fields`() throws {
        let params = try object(
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
        #expect(params["timeoutMs"] == nil)
        #expect(params["attachments"] == nil)
    }

    @Test func `chat send params include selected global agent`() throws {
        let params = try object(
            from: IOSGatewayChatTransport.makeChatSendParamsJSON(
                sessionKey: "global",
                agentId: "reviewer",
                expectedSessionRoutingContract: "per-sender|main|reviewer",
                message: "hello",
                thinking: "low",
                idempotencyKey: "send-1",
                attachments: []))
        #expect(params["sessionKey"] as? String == "global")
        #expect(params["agentId"] as? String == "reviewer")
        #expect(params["expectedSessionRoutingContract"] as? String == "per-sender|main|reviewer")
    }

    @Test func `unscoped live routes use the selected agent`() {
        #expect(IOSGatewayChatTransport.sessionTarget(
            for: "Matrix:Channel:!MixedRoom:example.org",
            selectedAgentID: " Reviewer ") == .init(
            sessionKey: "agent:reviewer:Matrix:Channel:!MixedRoom:example.org",
            agentID: nil))
        #expect(IOSGatewayChatTransport.sessionTarget(
            for: "main",
            selectedAgentID: "main") == .init(sessionKey: "agent:main:main", agentID: nil))
        #expect(IOSGatewayChatTransport.sessionTarget(
            for: "agent:ops:main",
            selectedAgentID: "reviewer") == .init(sessionKey: "agent:ops:main", agentID: nil))
        #expect(IOSGatewayChatTransport.sessionTarget(
            for: "global",
            selectedAgentID: "reviewer") == .init(sessionKey: "global", agentID: "reviewer"))
        #expect(IOSGatewayChatTransport.sessionTarget(
            for: "unknown",
            selectedAgentID: "reviewer") == .init(sessionKey: "unknown", agentID: nil))
        #expect(IOSGatewayChatTransport.sessionTarget(
            for: "agent::main",
            selectedAgentID: "reviewer") == .init(sessionKey: "agent::main", agentID: nil))
    }

    @Test func `session mutations dispatch normalized selected agent targets`() async throws {
        let recorder = RequestRecorder()
        let transport = IOSGatewayChatTransport(
            gateway: GatewayNodeSession(),
            globalAgentId: " Reviewer ",
            sessionMutationRequest: { method, paramsJSON, timeoutSeconds in
                await recorder.record(
                    method: method,
                    paramsJSON: paramsJSON,
                    timeoutSeconds: timeoutSeconds)
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
        #expect(requests.map(\.timeoutSeconds) == Array(repeating: 15, count: 9))

        for (offset, expectedKey, expectedMutationAgentID, expectedForkAgentID) in [
            (0, "agent:reviewer:Matrix:Channel:Room", nil, "reviewer"),
            (3, "global", "reviewer", "reviewer"),
            (6, "agent:ops:main", nil, "ops"),
        ] as [(Int, String, String?, String?)] {
            let patch = try object(from: requests[offset].paramsJSON)
            #expect(patch["key"] as? String == expectedKey)
            #expect(patch["agentId"] as? String == expectedMutationAgentID)
            #expect(patch["pinned"] as? Bool == true)

            let delete = try object(from: requests[offset + 1].paramsJSON)
            #expect(delete["key"] as? String == expectedKey)
            #expect(delete["agentId"] as? String == expectedMutationAgentID)
            #expect(delete["deleteTranscript"] as? Bool == true)

            let fork = try object(from: requests[offset + 2].paramsJSON)
            #expect(fork["parentSessionKey"] as? String == expectedKey)
            #expect(fork["agentId"] as? String == expectedForkAgentID)
            #expect(fork["fork"] as? Bool == true)
        }
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

        let mapped = IOSGatewayChatTransport.mapEventFrame(frame)
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

    @Test func `maps unknown event to nil`() {
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
