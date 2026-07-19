import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

struct ChatGatewayRequestTests {
    @Test func `session targets share normalization while preserving platform routing policy`() {
        #expect(OpenClawChatSessionTarget.resolve(
            " Matrix:Channel:Room ",
            selectedAgentID: " Reviewer ",
            policy: .scopeBareKeysToSelectedAgent) == .init(
            sessionKey: "agent:reviewer:Matrix:Channel:Room",
            agentID: nil))
        #expect(OpenClawChatSessionTarget.resolve(
            " main ",
            selectedAgentID: " Reviewer ",
            policy: .preserveBareKeys) == .init(sessionKey: "main", agentID: nil))
        #expect(OpenClawChatSessionTarget.resolve(
            " GLOBAL ",
            selectedAgentID: " Reviewer ",
            policy: .preserveBareKeys) == .init(sessionKey: "GLOBAL", agentID: "reviewer"))
        #expect(OpenClawChatSessionTarget.resolve(
            "agent:ops:main",
            selectedAgentID: "reviewer",
            policy: .scopeBareKeysToSelectedAgent) == .init(
            sessionKey: "agent:ops:main",
            agentID: nil))
        #expect(OpenClawChatSessionTarget.resolve(
            "agent::main",
            selectedAgentID: "reviewer",
            policy: .scopeBareKeysToSelectedAgent) == .init(
            sessionKey: "agent::main",
            agentID: nil))
    }

    @Test func `list sessions request normalizes optional filters`() {
        let request = OpenClawChatGatewayRequests.sessionsList(
            limit: 12,
            search: "  incident  ",
            archived: true)

        #expect(request.method == "sessions.list")
        #expect(request.timeoutMs == 15000)
        #expect(request.params["includeGlobal"]?.value as? Bool == true)
        #expect(request.params["includeUnknown"]?.value as? Bool == false)
        #expect(request.params["limit"]?.value as? Int == 12)
        #expect(request.params["search"]?.value as? String == "incident")
        #expect(request.params["archived"]?.value as? Bool == true)
    }

    @Test func `session patch request preserves explicit null clearing`() {
        let request = OpenClawChatGatewayRequests.patchSession(
            sessionKey: "global",
            agentID: "reviewer",
            label: .some(nil),
            category: .some(nil),
            pinned: true,
            archived: nil,
            unread: false)

        #expect(request.method == "sessions.patch")
        #expect(request.params["key"]?.value as? String == "global")
        #expect(request.params["agentId"]?.value as? String == "reviewer")
        #expect(request.params["label"]?.value is NSNull)
        #expect(request.params["category"]?.value is NSNull)
        #expect(request.params["pinned"]?.value as? Bool == true)
        #expect(request.params["unread"]?.value as? Bool == false)
        #expect(request.params["archived"] == nil)
    }

    @Test func `settings patch request encodes default model as null`() {
        let request = OpenClawChatGatewayRequests.patchSessionSettings(
            sessionKey: "agent:main:main",
            agentID: nil,
            model: .some(nil))

        #expect(request.params["model"]?.value is NSNull)
        #expect(request.params["agentId"] == nil)
    }

    @Test func `settings patch request encodes model thinking and verbosity atomically`() {
        let request = OpenClawChatGatewayRequests.patchSessionSettings(
            sessionKey: "global",
            agentID: "reviewer",
            model: .some("openai/gpt-5.6-sol"),
            thinkingLevel: .some("ultra"),
            verboseLevel: .some("full"))

        #expect(request.method == "sessions.patch")
        #expect(request.params["key"]?.value as? String == "global")
        #expect(request.params["agentId"]?.value as? String == "reviewer")
        #expect(request.params["model"]?.value as? String == "openai/gpt-5.6-sol")
        #expect(request.params["thinkingLevel"]?.value as? String == "ultra")
        #expect(request.params["verboseLevel"]?.value as? String == "full")
    }

    @Test func `settings patch request encodes fast values and explicit resets`() {
        let reset = OpenClawChatGatewayRequests.patchSessionSettings(
            sessionKey: "main",
            agentID: nil,
            thinkingLevel: .some(nil),
            fastMode: .some(nil),
            verboseLevel: .some(nil))
        let automatic = OpenClawChatGatewayRequests.patchSessionSettings(
            sessionKey: "main",
            agentID: nil,
            fastMode: .some(.automatic))

        #expect(reset.params["thinkingLevel"]?.value is NSNull)
        #expect(reset.params["fastMode"]?.value is NSNull)
        #expect(reset.params["verboseLevel"]?.value is NSNull)
        #expect(automatic.params["fastMode"]?.value as? String == "auto")
    }

    @Test func `fork and create requests preserve routing identity`() {
        let fork = OpenClawChatGatewayRequests.forkSession(
            parentSessionKey: "agent:reviewer:telegram:group:1",
            agentID: "reviewer")
        #expect(fork.method == "sessions.create")
        #expect(fork.params["parentSessionKey"]?.value as? String == "agent:reviewer:telegram:group:1")
        #expect(fork.params["agentId"]?.value as? String == "reviewer")
        #expect(fork.params["fork"]?.value as? Bool == true)

        let create = OpenClawChatGatewayRequests.createSession(
            key: "agent:reviewer:new",
            agentID: "reviewer",
            label: nil,
            parentSessionKey: "global",
            worktree: true,
            worktreeBaseRef: " origin/release ")
        #expect(create.params["key"]?.value as? String == "agent:reviewer:new")
        #expect(create.params["agentId"]?.value as? String == "reviewer")
        #expect(create.params["parentSessionKey"]?.value as? String == "global")
        #expect(create.params["worktree"]?.value as? Bool == true)
        #expect(create.params["worktreeBaseRef"]?.value as? String == "origin/release")
    }

    @Test func `message rewind and fork requests preserve routing identity`() {
        let rewind = OpenClawChatGatewayRequests.rewindSession(
            sessionKey: "agent:reviewer:telegram:group:1",
            agentID: " reviewer ",
            entryId: " message-42 ")
        let fork = OpenClawChatGatewayRequests.forkAtMessage(
            sessionKey: "global",
            agentID: nil,
            entryId: "message-43")

        #expect(rewind.method == "sessions.rewind")
        #expect(rewind.timeoutMs == 15000)
        #expect(rewind.params["sessionKey"]?.value as? String == "agent:reviewer:telegram:group:1")
        #expect(rewind.params["agentId"]?.value as? String == "reviewer")
        #expect(rewind.params["entryId"]?.value as? String == "message-42")
        #expect(rewind.params["key"] == nil)

        #expect(fork.method == "sessions.fork")
        #expect(fork.timeoutMs == 15000)
        #expect(fork.params["sessionKey"]?.value as? String == "global")
        #expect(fork.params["agentId"] == nil)
        #expect(fork.params["entryId"]?.value as? String == "message-43")
        #expect(fork.params["key"] == nil)
    }

    @Test func `session group requests encode exact gateway contracts`() {
        let list = OpenClawChatGatewayRequests.sessionGroupsList()
        let put = OpenClawChatGatewayRequests.sessionGroupsPut(names: ["Work", "Personal"])
        let rename = OpenClawChatGatewayRequests.sessionGroupsRename(name: "Work", to: "Projects")
        let delete = OpenClawChatGatewayRequests.sessionGroupsDelete(name: "Personal")

        #expect(list.method == "sessions.groups.list")
        #expect(list.params.isEmpty)
        #expect(put.method == "sessions.groups.put")
        #expect(put.params["names"]?.value as? [String] == ["Work", "Personal"])
        #expect(rename.method == "sessions.groups.rename")
        #expect(rename.params["name"]?.value as? String == "Work")
        #expect(rename.params["to"]?.value as? String == "Projects")
        #expect(delete.method == "sessions.groups.delete")
        #expect(delete.params["name"]?.value as? String == "Personal")
    }

    @Test func `rename clear archive and fork use session mutation contracts`() {
        let rename = OpenClawChatGatewayRequests.patchSession(
            sessionKey: "agent:main:child",
            agentID: nil,
            label: .some(nil),
            category: nil,
            pinned: nil,
            archived: nil,
            unread: nil)
        let archive = OpenClawChatGatewayRequests.patchSession(
            sessionKey: "agent:main:child",
            agentID: nil,
            label: nil,
            category: nil,
            pinned: nil,
            archived: true,
            unread: nil)
        let fork = OpenClawChatGatewayRequests.forkSession(
            parentSessionKey: "agent:main:child",
            agentID: nil)

        #expect(rename.params["label"]?.value is NSNull)
        #expect(archive.params["archived"]?.value as? Bool == true)
        #expect(fork.method == "sessions.create")
        #expect(fork.params["parentSessionKey"]?.value as? String == "agent:main:child")
        #expect(fork.params["fork"]?.value as? Bool == true)
    }

    @Test func `commands request selects session agent before fallback`() {
        let scoped = OpenClawChatGatewayRequests.commandsList(
            sessionKey: "agent:reviewer:main",
            fallbackAgentID: "fallback")
        #expect(scoped.params["scope"]?.value as? String == "text")
        #expect(scoped.params["includeArgs"]?.value as? Bool == true)
        #expect(scoped.params["agentId"]?.value as? String == "reviewer")

        let global = OpenClawChatGatewayRequests.commandsList(
            sessionKey: "global",
            fallbackAgentID: "reviewer")
        #expect(global.params["agentId"]?.value as? String == "reviewer")
    }

    @Test func `send request shares attachment encoding and timeout policy`() throws {
        let request = OpenClawChatGatewayRequests.sendMessage(
            sessionKey: "global",
            agentID: " reviewer ",
            expectedSessionRoutingContract: " per-sender|main|reviewer ",
            message: "hello",
            thinking: " low ",
            idempotencyKey: "send-1",
            attachments: [.init(type: "image", mimeType: "image/png", fileName: "a.png", content: "abc")])

        #expect(request.method == "chat.send")
        #expect(request.timeoutMs == 30000)
        #expect(request.params["agentId"]?.value as? String == "reviewer")
        #expect(request.params["expectedSessionRoutingContract"]?.value as? String == "per-sender|main|reviewer")
        #expect(request.params["thinking"]?.value as? String == "low")
        #expect(request.params["timeoutMs"] == nil)
        let encoded = try JSONEncoder().encode(request.params["attachments"])
        #expect(String(decoding: encoded, as: UTF8.self).contains("a.png"))
    }

    @Test func `question resolve request preserves answer arrays`() throws {
        let request = OpenClawChatGatewayRequests.resolveQuestion(
            id: "ask_123",
            answers: ["meal": ["Pizza", "Salad"]])

        #expect(request.method == "question.resolve")
        let data = try JSONEncoder().encode(request.params)
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let answers = try #require(object["answers"] as? [String: Any])
        #expect(answers["meal"] as? [String] == ["Pizza", "Salad"])
    }

    @Test func `question get request carries id`() {
        let request = OpenClawChatGatewayRequests.questionGet(id: "ask_123")

        #expect(request.method == "question.get")
        #expect(request.params["id"]?.value as? String == "ask_123")
    }

    @Test func `question cancel request uses resolve cancel contract`() {
        let request = OpenClawChatGatewayRequests.cancelQuestion(id: "ask_123")

        #expect(request.method == "question.resolve")
        #expect(request.params["id"]?.value as? String == "ask_123")
        #expect(request.params["cancel"]?.value as? Bool == true)
        #expect(request.params["answers"] == nil)
    }

    @Test func `long running requests share exact gateway timeout margins`() {
        #expect(OpenClawChatGatewayRequests.agentWait(runID: "run-1", timeoutMs: 1).timeoutMs == 5001)
        #expect(OpenClawChatGatewayRequests.agentWait(runID: "run-1", timeoutMs: 30000).timeoutMs == 35000)
        #expect(OpenClawChatGatewayRequests.compactSession(
            sessionKey: "main",
            agentID: nil).timeoutMs == 0)
    }
}

struct ChatGatewayPayloadCodecTests {
    @Test func `session key extracts canonical agent identity`() {
        #expect(OpenClawChatSessionKey.agentID(from: " agent:Reviewer:main ") == "Reviewer")
        #expect(OpenClawChatSessionKey.agentID(from: "agent::main") == nil)
        #expect(OpenClawChatSessionKey.agentID(from: "global") == nil)
    }

    @Test func `agent wait distinguishes terminal and retryable timeouts`() throws {
        #expect(try OpenClawChatGatewayPayloadCodec.decodeAgentWaitObservation(
            Data(#"{"status":"completed"}"#.utf8)) == .terminal(.completed))
        #expect(try OpenClawChatGatewayPayloadCodec.decodeAgentWaitObservation(
            Data(#"{"status":"pending"}"#.utf8)) == .checkAgain)
        #expect(try OpenClawChatGatewayPayloadCodec.decodeAgentWaitObservation(
            Data(#"{"status":"timeout","timeoutPhase":"queue"}"#.utf8)) == .checkAgain)
        #expect(try OpenClawChatGatewayPayloadCodec.decodeAgentWaitObservation(
            Data(#"{"status":"timeout","timeoutPhase":"provider"}"#.utf8)) ==
            .terminal(.failed(message: "Run timed out")))
    }

    @Test func `routing identity decodes agent and canonical contract`() throws {
        let identity = try OpenClawChatGatewayPayloadCodec.decodeSessionRoutingIdentity(
            Data(#"{"defaultId":"Work","mainKey":"Primary","scope":"global","agents":[]}"#.utf8))

        #expect(identity.defaultAgentID == "work")
        #expect(identity.contract == "global|primary|work")
    }

    @Test func `model choices preserve metadata and replace blank names`() throws {
        let choices = try OpenClawChatGatewayPayloadCodec.decodeModelChoices(Data(
            #"{"models":[{"id":"gpt-5","name":"  ","provider":"openai","contextWindow":200000,"reasoning":true}]}"#
                .utf8))

        #expect(choices == [OpenClawChatModelChoice(
            modelID: "gpt-5",
            name: "gpt-5",
            provider: "openai",
            contextWindow: 200_000,
            reasoning: true)])
    }

    @Test func `command choice normalizes source aliases and identity`() {
        let choice = OpenClawChatGatewayPayloadCodec.commandChoice(CommandEntry(
            name: "review",
            textaliases: [" /review ", ""],
            description: "Review changes",
            source: AnyCodable("plugin"),
            scope: AnyCodable("text"),
            acceptsargs: true))

        #expect(choice.id == "plugin:review:/review")
        #expect(choice.textAliases == ["/review"])
        #expect(choice.source == .plugin)
        #expect(choice.acceptsArgs)
    }

    @Test func `event frames map to shared chat transport events`() {
        let sessionsChanged = EventFrame(
            type: "event",
            event: "sessions.changed",
            payload: AnyCodable([
                "sessionKey": AnyCodable("agent:main:main"),
                "agentId": AnyCodable("main"),
                "reason": AnyCodable("command-metadata"),
            ]))
        guard case let .sessionsChanged(change) = OpenClawChatGatewayPayloadCodec.event(from: sessionsChanged)
        else {
            Issue.record("expected sessionsChanged")
            return
        }
        #expect(change == .init(
            sessionKey: "agent:main:main",
            agentId: "main",
            reason: "command-metadata"))

        let chat = EventFrame(
            type: "event",
            event: "chat",
            payload: AnyCodable([
                "runId": AnyCodable("run-1"),
                "sessionKey": AnyCodable("main"),
                "state": AnyCodable("final"),
            ]))
        guard case let .chat(payload) = OpenClawChatGatewayPayloadCodec.event(from: chat) else {
            Issue.record("expected chat")
            return
        }
        #expect(payload.runId == "run-1")
        #expect(payload.sessionKey == "main")
        #expect(payload.state == "final")
        #expect(OpenClawChatGatewayPayloadCodec.event(from: EventFrame(
            type: "event",
            event: "unknown")) == nil)
    }
}
