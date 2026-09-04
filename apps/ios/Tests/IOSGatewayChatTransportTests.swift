import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw
@testable import OpenClawChatUI

struct IOSGatewayChatTransportTests {
    private actor RequestRecorder {
        private var requests: [OpenClawChatGatewayRequest] = []

        func record(_ request: OpenClawChatGatewayRequest) -> Data {
            self.requests.append(request)
            if request.method == "sessions.create" {
                return Data(#"{"key":"forked"}"#.utf8)
            }
            return Data(#"{"entry":{}}"#.utf8)
        }

        func record(_ request: OpenClawChatGatewayRequest, response: Data) -> Data {
            self.requests.append(request)
            return response
        }

        func all() -> [OpenClawChatGatewayRequest] {
            self.requests
        }
    }

    @Test(arguments: [
        ("gateway-a", "gateway-b"),
        (" gateway-a ", "gateway-a"),
        ("gateway-e\u{301}", "gateway-\u{E9}"),
    ])
    func `chat outbox route keeps the exact gateway owner`(owner: String, otherOwner: String) async throws {
        let gateway = GatewayNodeSession()
        var options = GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions
        options.deviceAuthGatewayID = owner
        options.allowStoredDeviceAuth = false
        do {
            try await gateway.connect(
                url: #require(URL(string: "ws://chat-transport-test.invalid")),
                credentials: .init(),
                connectOptions: options,
                sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession()),
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
            let matching = IOSGatewayChatTransport(gateway: gateway, outboxGatewayID: owner)
            let foreign = IOSGatewayChatTransport(gateway: gateway, outboxGatewayID: otherOwner)

            #expect(await matching.currentSessionMutationRoute() != nil)
            #expect(await foreign.currentSessionMutationRoute() == nil)
        } catch {
            await gateway.disconnect()
            throw error
        }
        await gateway.disconnect()
    }

    @Test func `history compatibility rejects only the old unsupported input run field`() {
        let unsupportedField = "invalid chat.history params: at root: unexpected property 'inputRunIds'"
        let cases: [(String, String, String, Bool)] = [
            ("chat.history", "INVALID_REQUEST", unsupportedField, true),
            ("chat.send", "INVALID_REQUEST", unsupportedField, false),
            ("chat.history", "FORBIDDEN", unsupportedField, false),
            (
                "chat.history",
                "INVALID_REQUEST",
                "invalid chat.history params: at root: unexpected property 'cursor'",
                false),
            ("chat.history", "INVALID_REQUEST", "invalid chat.history params: missing sessionKey", false),
            ("chat.history", "INVALID_REQUEST", "\(unsupportedField); missing sessionKey", false),
        ]
        for (method, code, message, expected) in cases {
            let error = GatewayResponseError(method: method, code: code, message: message, details: nil)
            #expect(IOSGatewayChatTransport.isUnsupportedHistoryInputRunIDsError(error) == expected)
        }
        #expect(!IOSGatewayChatTransport.isUnsupportedHistoryInputRunIDsError(URLError(.timedOut)))
    }

    @Test func `composer mutation compatibility preserves legacy controls only for unknown catalogs`() {
        #expect(IOSGatewayChatTransport.composerMutationAvailable(
            methodSupport: nil,
            allowedByScope: false))
        #expect(IOSGatewayChatTransport.composerMutationAvailable(
            methodSupport: true,
            allowedByScope: true))
        #expect(!IOSGatewayChatTransport.composerMutationAvailable(
            methodSupport: true,
            allowedByScope: false))
        #expect(!IOSGatewayChatTransport.composerMutationAvailable(
            methodSupport: false,
            allowedByScope: true))
    }

    @Test func `composer skill owner follows canonical session agent`() {
        let selected = IOSGatewayChatTransport.sessionTarget(
            for: "main",
            selectedAgentID: "reviewer")
        let canonical = IOSGatewayChatTransport.sessionTarget(
            for: "agent:ops:main",
            selectedAgentID: "reviewer")

        #expect(IOSGatewayChatTransport.composerAgentID(for: selected) == "reviewer")
        #expect(IOSGatewayChatTransport.composerAgentID(for: canonical) == "ops")
    }

    @Test func `composer skill projection keeps agent filtering session enableable`() {
        let skill = SkillStatus(
            name: "Weather",
            description: "Forecasts",
            source: "openclaw-managed",
            filePath: "/tmp/weather/SKILL.md",
            baseDir: "/tmp/weather",
            skillKey: "weather",
            primaryEnv: nil,
            emoji: nil,
            homepage: nil,
            always: false,
            disabled: false,
            blockedByAgentFilter: true,
            eligible: false,
            requirements: SkillRequirements(bins: [], env: [], config: []),
            missing: SkillMissing(bins: [], env: [], config: []),
            configChecks: [],
            install: [])

        let projected = IOSGatewayChatTransport.composerSkill(skill)

        #expect(projected.baseEnabled)
        #expect(projected.agentFiltered)
        #expect(!projected.blocked)
    }

    @Test func `composer tool projection accepts only MCP tools and preserves inherited denial`() throws {
        let result = ToolsEffectiveResult(
            agentid: "main",
            profile: "default",
            groups: [ToolsEffectiveGroup(
                id: AnyCodable("tools"),
                label: "Tools",
                source: AnyCodable("mixed"),
                tools: [
                    ToolsEffectiveEntry(
                        id: "mcp-github-create-issue",
                        label: "Create issue",
                        description: "",
                        rawdescription: "",
                        source: AnyCodable("mcp"),
                        mcpserver: "github",
                        mcptoolname: "create_issue",
                        deniedbysession: true),
                    ToolsEffectiveEntry(
                        id: "core-spoof",
                        label: "Spoof",
                        description: "",
                        rawdescription: "",
                        source: AnyCodable("core"),
                        mcpserver: "github",
                        mcptoolname: "spoof"),
                ])])

        let tools = try #require(IOSGatewayChatTransport.composerToolsByServer(result)["github"])
        #expect(tools.map(\.name) == ["create_issue"])
        #expect(tools.first?.baseEnabled == true)
        #expect(tools.first?.sessionDenied == true)
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
              "features":{"methods":[],"events":[],"capabilities":["chat-send-routing-contract","session-scoped-chat-metadata","session-unread-ack-contract"]},
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
        #expect(hello.supportsServerCapability(.sessionScopedChatMetadata))
        #expect(hello.supportsServerCapability(.sessionUnreadAckContract))
        #expect(!hello.supportsServerCapability(.sessionSettingsContract))
        #expect(!hello.supportsServerCapability(.sessionSettingsCAS))

        let currentData = Data(
            String(decoding: data, as: UTF8.self)
                .replacingOccurrences(
                    of: "session-unread-ack-contract\"]",
                    with: "session-unread-ack-contract\",\"session-settings-contract\",\"session-settings-cas-v1\"]")
                .utf8)
        let current = try JSONDecoder().decode(HelloOk.self, from: currentData)
        #expect(current.supportsServerCapability(.sessionSettingsContract))
        #expect(current.supportsServerCapability(.sessionSettingsCAS))
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
            _ = try await transport.forkSession(parentKey: key, fromLastCompleted: false)
        }

        let requests = await recorder.all()
        #expect(requests.map(\.method) == Array(
            repeating: ["sessions.patch", "sessions.delete", "sessions.create"],
            count: 3).flatMap(\.self))
        #expect(requests.map(\.timeoutMs) == Array(
            repeating: [15000, 600_000, 15000],
            count: 3).flatMap(\.self))

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

    @Test func `archive and restore carry the observed session identity`() async throws {
        let recorder = RequestRecorder()
        let transport = IOSGatewayChatTransport(
            gateway: GatewayNodeSession(),
            globalAgentId: " Reviewer ",
            sessionMutationRequest: { request in
                await recorder.record(request)
            })

        try await transport.patchSession(
            key: "global",
            expectedSessionID: " session-a ",
            archived: true)
        try await transport.patchSession(
            key: "global",
            expectedSessionID: "session-a",
            archived: false)

        let requests = await recorder.all()
        #expect(requests.map(\.method) == ["sessions.patch", "sessions.patch"])
        #expect(requests.map(\.timeoutMs) == [600_000, 15000])
        #expect(requests.allSatisfy { $0.params["key"]?.value as? String == "global" })
        #expect(requests.allSatisfy { $0.params["agentId"]?.value as? String == "reviewer" })
        #expect(requests.allSatisfy { $0.params["expectedSessionId"]?.value as? String == "session-a" })
        #expect(requests[0].params["archived"]?.value as? Bool == true)
        #expect(requests[1].params["archived"]?.value as? Bool == false)
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

    @Test func `advanced session creation forwards agent worktree and base ref`() async throws {
        let recorder = RequestRecorder()
        let transport = IOSGatewayChatTransport(
            gateway: GatewayNodeSession(),
            globalAgentId: " Reviewer ",
            sessionMutationRequest: { request in
                await recorder.record(request)
            })

        let created = try await transport.createSession(
            key: "agent:builder:ios-new",
            label: "Build",
            agentID: " Builder ",
            parentSessionKey: "agent:builder:main",
            worktree: true,
            worktreeBaseRef: " origin/release ")

        #expect(created.key == "forked")
        let request = try #require(await recorder.all().first)
        #expect(request.method == "sessions.create")
        #expect(request.params["key"]?.value as? String == "agent:builder:ios-new")
        #expect(request.params["label"]?.value as? String == "Build")
        #expect(request.params["agentId"]?.value as? String == "builder")
        #expect(request.params["parentSessionKey"]?.value as? String == "agent:builder:main")
        #expect(request.params["worktree"]?.value as? Bool == true)
        #expect(request.params["worktreeBaseRef"]?.value as? String == "origin/release")
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

    @Test func `fast mode patches preserve boolean and explicit null`() async throws {
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
            patch: OpenClawChatSessionSettingsPatch(fastMode: .some(.on)))
        _ = try await transport.patchSessionSettings(
            sessionKey: "global",
            agentID: nil,
            patch: OpenClawChatSessionSettingsPatch(fastMode: .some(nil)))

        let requests = await recorder.all()
        #expect(requests.count == 2)
        #expect(requests[0].params["fastMode"]?.value as? Bool == true)
        #expect(requests[1].params["fastMode"]?.value is NSNull)
        #expect(requests.allSatisfy { $0.params["verboseLevel"] == nil })
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
            #expect(message.message?.transcriptMessageID == "msg-1")
        default:
            Issue.record("expected .sessionMessage from session.message event, got \(String(describing: mapped))")
        }
    }

    @Test @MainActor func `canonical transcript identity deduplicates replayed assistant messages`() {
        let original = Self.canonicalAssistantMessage(timestamp: 1234.5)
        let replay = Self.canonicalAssistantMessage(timestamp: 5678.5)

        let messages = OpenClawChatViewModel.dedupeMessages([original, replay])

        #expect(messages.count == 1)
        #expect(messages.first?.transcriptMessageID == "canonical-assistant-1")
    }

    @Test @MainActor func `distinct transcript identities preserve identical assistant replies`() {
        let first = Self.canonicalAssistantMessage(timestamp: 1234.5)
        let second = Self.canonicalAssistantMessage(
            timestamp: 1234.5,
            transcriptMessageID: "canonical-assistant-2")

        let messages = OpenClawChatViewModel.dedupeMessages([first, second])

        #expect(messages.count == 2)
        #expect(messages.map(\.transcriptMessageID) == ["canonical-assistant-1", "canonical-assistant-2"])
    }

    @Test @MainActor func `history reconciles a replay by its canonical transcript identity`() {
        let original = Self.canonicalAssistantMessage(timestamp: 1234.5)
        let replay = Self.canonicalAssistantMessage(timestamp: 5678.5)

        let messages = OpenClawChatViewModel.reconcileMessageIDs(
            previous: [original],
            incoming: [replay])

        #expect(messages.count == 1)
        #expect(messages.first?.id == original.id)
        #expect(messages.first?.timestamp == replay.timestamp)
        #expect(messages.first?.transcriptMessageID == "canonical-assistant-1")
    }

    @Test @MainActor func `canonical adoption keeps the durable transcript identity`() {
        let existing = OpenClawChatMessage(
            role: "assistant",
            content: [Self.assistantText],
            timestamp: 1234.5)
        let incoming = Self.canonicalAssistantMessage(timestamp: 5678.5)

        let adopted = OpenClawChatViewModel.adoptingCanonicalMessage(incoming, over: existing)

        #expect(adopted.id == existing.id)
        #expect(adopted.timestamp == incoming.timestamp)
        #expect(adopted.transcriptMessageID == "canonical-assistant-1")
    }

    @Test @MainActor func `user idempotency still reconciles an optimistic canonical echo`() {
        let original = OpenClawChatMessage(
            role: "user",
            content: [Self.assistantText],
            timestamp: 1234.5,
            idempotencyKey: "run-1:user")
        let echo = OpenClawChatMessage(
            role: "user",
            content: [Self.assistantText],
            timestamp: 5678.5,
            transcriptMessageID: "canonical-user-1",
            idempotencyKey: "run-1:user")

        let messages = OpenClawChatViewModel.reconcileMessageIDs(
            previous: [original],
            incoming: [echo])

        #expect(messages.count == 1)
        #expect(messages.first?.id == original.id)
        #expect(messages.first?.transcriptMessageID == "canonical-user-1")
    }

    private static var assistantText: OpenClawChatMessageContent {
        OpenClawChatMessageContent(
            type: "text",
            text: "agent reply",
            mimeType: nil,
            fileName: nil,
            content: nil)
    }

    private static func canonicalAssistantMessage(
        timestamp: Double,
        transcriptMessageID: String = "canonical-assistant-1") -> OpenClawChatMessage
    {
        OpenClawChatMessage(
            role: "assistant",
            content: [self.assistantText],
            timestamp: timestamp,
            transcriptMessageID: transcriptMessageID)
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
    @Test(arguments: [
        (LocalChatFixture.appleReviewDemo, ["main"]),
        (LocalChatFixture.appScreenshots, ["main", "research", "automation"]),
    ])
    func `new session options expose fixture agents and create the selected session`(
        fixture: LocalChatFixture,
        expectedAgentIDs: [String]) async throws
    {
        let transport = LocalFixtureChatTransport(fixture: fixture)
        let route = try #require(await transport.acquireNewSessionRouteLease())
        let catalog = try #require(try await route.listAgents())

        #expect(catalog.defaultId == fixture.defaultAgentID)
        #expect(catalog.agents.map(\.id) == expectedAgentIDs)
        #expect(catalog.agents.allSatisfy { $0.workspaceGit == false })
        let selectedAgentID = try #require(catalog.agents.last?.id)
        let created = try await route.createSession(
            key: "fixture-selected-agent",
            label: nil,
            agentID: selectedAgentID,
            parentSessionKey: nil,
            worktree: nil,
            worktreeBaseRef: nil)
        #expect(created.key == "fixture-selected-agent")
    }

    @Test func `new session options reject unavailable agents and worktrees`() async throws {
        let transport = LocalFixtureChatTransport(fixture: .appScreenshots)
        let route = try #require(await transport.acquireNewSessionRouteLease())

        await #expect(throws: NSError.self) {
            try await route.createSession(
                key: "unknown-agent",
                label: nil,
                agentID: "missing",
                parentSessionKey: nil,
                worktree: nil,
                worktreeBaseRef: nil)
        }
        await #expect(throws: NSError.self) {
            try await route.createSession(
                key: "unsupported-worktree",
                label: nil,
                agentID: "main",
                parentSessionKey: nil,
                worktree: true,
                worktreeBaseRef: "main")
        }
    }

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

    @Test func `Apple Review fixture persists capability mutations into session readback`() async throws {
        let transport = LocalFixtureChatTransport(fixture: .appleReviewDemo)
        #expect(transport.supportsComposerCapabilities)
        let catalog = await transport.loadComposerCapabilityCatalog(sessionKey: "main", agentID: "main")
        #expect(catalog.permissionMutationAvailable)
        #expect(catalog.toolOverrideMutationAvailable)
        let overrides = OpenClawChatSessionToolOverrides(
            webSearch: false,
            skills: ["autoreview": false],
            mcpServers: ["GitHub": false])

        _ = try await transport.patchSessionSettings(
            sessionKey: "main",
            agentID: "main",
            patch: OpenClawChatSessionSettingsPatch(
                expectedSessionID: "apple-review-demo-main",
                permissionMode: .some(.workspace),
                toolOverrides: .some(overrides)))

        let session = try #require(
            try await transport.listSessions(limit: nil, search: nil, archived: false).sessions.first)
        #expect(session.permissionMode == .workspace)
        #expect(session.toolOverrides == overrides)
    }
}
