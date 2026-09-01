import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClawChatUI

struct ChatGatewayRequestTests {
    @Test(arguments: [[String]?.none, [], ["api.example.test"]])
    func `question host consent uses protocol field`(hosts: [String]?) throws {
        let request = OpenClawChatGatewayRequests.resolveQuestion(
            id: "ask_secret", answers: ["credential": ["  synthetic-value  "]], secretStoreAllowedHosts: hosts)
        let data = try JSONEncoder().encode(request.params)
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(object["secretStoreAllowedHosts"] as? [String] == hosts)
        let envelope = try #require(object["answers"] as? [String: [String: [String]]])
        #expect(envelope == ["answers": ["credential": ["  synthetic-value  "]]])
    }

    @Test func `question answer response decodes canonical marker`() throws {
        let data = Data(#"{"status":"answered","answers":{"answers":{"credential":["stored"]}}}"#.utf8)
        let answers = try OpenClawChatGatewayPayloadCodec.decodeQuestionAnswer(data)
        let encoded = try JSONEncoder().encode(answers)
        let object = try JSONSerialization.jsonObject(with: encoded) as? [String: [String: [String]]]
        #expect(object == ["answers": ["credential": ["stored"]]])
        for invalid in [
            #"{"status":"cancelled"}"#,
            #"{"status":"pending","answers":{"answers":{}}}"#,
            #"{"status":"answered"}"#,
        ] {
            #expect(throws: (any Error).self) {
                try OpenClawChatGatewayPayloadCodec.decodeQuestionAnswer(Data(invalid.utf8))
            }
        }
    }

    @Test func `models list scopes worker catalogs and preserves default scope`() {
        let worker = OpenClawChatGatewayRequests.modelsList(agentID: " worker ")
        let defaultAgent = OpenClawChatGatewayRequests.modelsList(agentID: nil)

        #expect(worker.method == "models.list")
        #expect(worker.params["agentId"]?.value as? String == "worker")
        #expect(defaultAgent.params.isEmpty)
    }

    @Test func `session observation requests encode global subscription and actual visibility`() {
        let subscribe = OpenClawChatGatewayRequests.subscribeSessions()
        let visible = OpenClawChatGatewayRequests.setSessionObserverVisibility(true)
        let hidden = OpenClawChatGatewayRequests.setSessionObserverVisibility(false)
        let longerSubscription = OpenClawChatGatewayRequests.subscribeSessions(timeoutMs: 12000)
        let longerVisibility = OpenClawChatGatewayRequests.setSessionObserverVisibility(
            true,
            timeoutMs: 12000)

        #expect(subscribe.method == "sessions.subscribe")
        #expect(subscribe.params.isEmpty)
        #expect(subscribe.timeoutMs == 10000)
        #expect(visible.method == "sessions.observer.visibility")
        #expect(visible.params["visible"]?.value as? Bool == true)
        #expect(visible.timeoutMs == 10000)
        #expect(hidden.method == "sessions.observer.visibility")
        #expect(hidden.params["visible"]?.value as? Bool == false)
        #expect(hidden.timeoutMs == 10000)
        #expect(longerSubscription.timeoutMs == 12000)
        #expect(longerVisibility.timeoutMs == 12000)
    }

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
            archived: true,
            agentID: " Reviewer ")

        #expect(request.method == "sessions.list")
        #expect(request.timeoutMs == 15000)
        #expect(request.params["includeGlobal"]?.value as? Bool == true)
        #expect(request.params["includeUnknown"]?.value as? Bool == false)
        #expect(request.params["limit"]?.value as? Int == 12)
        #expect(request.params["search"]?.value as? String == "incident")
        #expect(request.params["archived"]?.value as? Bool == true)
        #expect(request.params["agentId"]?.value as? String == "Reviewer")

        let unscoped = OpenClawChatGatewayRequests.sessionsList(
            limit: nil,
            search: nil,
            archived: false,
            agentID: "   ")
        #expect(unscoped.params["agentId"] == nil)
    }

    @Test func `child session request encodes focused pagination filters`() {
        let request = OpenClawChatGatewayRequests.sessionsList(
            limit: 10000,
            search: nil,
            archived: false,
            includeGlobal: false,
            spawnedBy: " agent:main:parent ",
            offset: 10000,
            configuredAgentsOnly: true)

        #expect(request.params["includeGlobal"]?.value as? Bool == false)
        #expect(request.params["spawnedBy"]?.value as? String == "agent:main:parent")
        #expect(request.params["offset"]?.value as? Int == 10000)
        #expect(request.params["configuredAgentsOnly"]?.value as? Bool == true)
    }

    @Test func `session patch request preserves explicit null clearing`() {
        let request = OpenClawChatGatewayRequests.patchSession(
            sessionKey: "global",
            agentID: "reviewer",
            label: .some(nil),
            category: .some(nil),
            color: .some(nil),
            pinned: true,
            archived: nil,
            unreadPatch: nil)

        #expect(request.method == "sessions.patch")
        #expect(request.params["key"]?.value as? String == "global")
        #expect(request.params["agentId"]?.value as? String == "reviewer")
        #expect(request.params["label"]?.value is NSNull)
        #expect(request.params["category"]?.value is NSNull)
        #expect(request.params["color"]?.value is NSNull)
        #expect(request.params["pinned"]?.value as? Bool == true)
        #expect(request.params["archived"] == nil)
    }

    @Test(arguments: ["blue", nil] as [String?])
    func `session color patch sets names without changing unrelated fields`(color: String?) throws {
        let request = OpenClawChatGatewayRequests.patchSession(
            sessionKey: "agent:main:work",
            agentID: "main",
            label: nil,
            category: nil,
            color: color.map { .some($0) },
            pinned: nil,
            archived: nil,
            unreadPatch: nil)
        let data = try JSONEncoder().encode(request.params)
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(object["color"] as? String == color)
        #expect(object.count == (color == nil ? 2 : 3))
    }

    @Test func `session read acknowledgement encodes an absent manual marker as null`() {
        let request = OpenClawChatGatewayRequests.patchSession(
            sessionKey: "main",
            agentID: nil,
            label: nil,
            category: nil,
            pinned: nil,
            archived: nil,
            unreadPatch: .automaticRead(expectedMarkedUnreadAt: nil))

        #expect(request.params["expectedMarkedUnreadAt"]?.value is NSNull)
    }

    @Test func `explicit session read uses the legacy-compatible payload`() {
        let request = OpenClawChatGatewayRequests.patchSession(
            sessionKey: "main",
            agentID: nil,
            label: nil,
            category: nil,
            pinned: nil,
            archived: nil,
            unreadPatch: .read)

        #expect(request.params["unread"]?.value as? Bool == false)
        #expect(request.params["readIntent"] == nil)
        #expect(request.params["expectedMarkedUnreadAt"] == nil)
    }

    @Test func `session read routing separates explicit automatic and legacy requests`() {
        #expect(OpenClawChatSessionUnreadPatch.routed(
            unread: false,
            expectedMarkedUnreadAt: nil,
            supportsReadContract: true) == .read)
        #expect(OpenClawChatSessionUnreadPatch.routed(
            unread: false,
            expectedMarkedUnreadAt: .some(nil),
            supportsReadContract: true) == .automaticRead(expectedMarkedUnreadAt: nil))
        #expect(OpenClawChatSessionUnreadPatch.routed(
            unread: false,
            expectedMarkedUnreadAt: .some(10),
            supportsReadContract: false) == .read)
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

    @Test func `settings patch request preserves permission and sparse tool overrides`() throws {
        let overrides = OpenClawChatSessionToolOverrides(
            webSearch: false,
            skills: ["release": false],
            mcpServers: ["github": true],
            mcpToolsDeny: ["github": ["create_issue", "delete_issue"]])
        let request = OpenClawChatGatewayRequests.patchSessionSettings(
            sessionKey: "global",
            agentID: "reviewer",
            expectedSessionID: "sess-global",
            expectedPermissionMode: .some(.guarded),
            expectedToolOverrides: .some(OpenClawChatSessionToolOverrides(webSearch: false)),
            permissionMode: .some(.workspace),
            toolOverrides: .some(overrides),
            supportsSessionSettingsContract: true,
            supportsSessionSettingsCAS: true)

        #expect(request.params["expectedSessionId"]?.value as? String == "sess-global")
        #expect(request.params["expectedPermissionMode"]?.value as? String == "guarded")
        #expect(request.params["permissionMode"]?.value as? String == "workspace")
        let encoded = try JSONEncoder().encode(request.params["toolOverrides"])
        let value = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let expectedEncoded = try JSONEncoder().encode(request.params["expectedToolOverrides"])
        let expectedValue = try #require(
            JSONSerialization.jsonObject(with: expectedEncoded) as? [String: Any])
        #expect(expectedValue["webSearch"] as? Bool == false)
        #expect(value["webSearch"] as? Bool == false)
        #expect((value["skills"] as? [String: Bool])?["release"] == false)
        #expect((value["mcpServers"] as? [String: Bool])?["github"] == true)
        #expect((value["mcpToolsDeny"] as? [String: [String]])?["github"] == [
            "create_issue",
            "delete_issue",
        ])

        let reset = OpenClawChatGatewayRequests.patchSessionSettings(
            sessionKey: "global",
            agentID: "reviewer",
            expectedPermissionMode: .some(.workspace),
            expectedToolOverrides: .some(nil),
            permissionMode: .some(nil),
            toolOverrides: .some(nil),
            supportsSessionSettingsContract: true,
            supportsSessionSettingsCAS: true)
        #expect(reset.params["permissionMode"]?.value is NSNull)
        #expect(reset.params["expectedPermissionMode"]?.value as? String == "workspace")
        #expect(reset.params["expectedToolOverrides"]?.value is NSNull)
        #expect(reset.params["toolOverrides"]?.value is NSNull)

        let releasedGateway = OpenClawChatGatewayRequests.patchSessionSettings(
            sessionKey: "global",
            agentID: "reviewer",
            expectedSessionID: "sess-global",
            expectedPermissionMode: .some(nil),
            expectedToolOverrides: .some(nil),
            permissionMode: .some(.workspace),
            toolOverrides: .some(overrides))
        #expect(releasedGateway.params["expectedSessionId"] == nil)
        #expect(releasedGateway.params["expectedPermissionMode"] == nil)
        #expect(releasedGateway.params["expectedToolOverrides"] == nil)
        #expect(releasedGateway.params["permissionMode"] == nil)
        #expect(releasedGateway.params["toolOverrides"] == nil)
    }

    @Test func `composer catalog requests preserve their owner scope`() {
        let skills = OpenClawChatGatewayRequests.composerSkillsStatus(agentID: "reviewer")
        let config = OpenClawChatGatewayRequests.composerConfigGet()
        let tools = OpenClawChatGatewayRequests.composerToolsEffective(
            sessionKey: "agent:reviewer:main",
            agentID: "reviewer")

        #expect(skills.method == "skills.status")
        #expect(skills.params["agentId"]?.value as? String == "reviewer")
        #expect(config.method == "config.get")
        #expect(config.params.isEmpty)
        #expect(tools.method == "tools.effective")
        #expect(tools.params["sessionKey"]?.value as? String == "agent:reviewer:main")
        #expect(tools.params["agentId"]?.value as? String == "reviewer")
    }

    @Test func `fork and create requests preserve routing identity`() {
        let fork = OpenClawChatGatewayRequests.forkSession(
            parentSessionKey: "agent:reviewer:telegram:group:1",
            agentID: "reviewer")
        #expect(fork.method == "sessions.create")
        #expect(fork.params["parentSessionKey"]?.value as? String == "agent:reviewer:telegram:group:1")
        #expect(fork.params["agentId"]?.value as? String == "reviewer")
        #expect(fork.params["fork"]?.value as? Bool == true)
        #expect(fork.params["forkFrom"] == nil)

        let activeFork = OpenClawChatGatewayRequests.forkSession(
            parentSessionKey: "agent:reviewer:telegram:group:1",
            agentID: "reviewer",
            fromLastCompleted: true)
        #expect(activeFork.params["forkFrom"]?.value as? String == "last-completed")

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

    @Test func `branch list and switch requests preserve routing identity`() {
        let list = OpenClawChatGatewayRequests.listSessionBranches(
            sessionKey: "agent:reviewer:telegram:group:1",
            agentID: " reviewer ")
        let switchBranch = OpenClawChatGatewayRequests.switchSessionBranch(
            sessionKey: "global",
            agentID: nil,
            leafEntryId: " leaf-42 ")

        #expect(list.method == "sessions.branches.list")
        #expect(list.timeoutMs == 15000)
        #expect(list.params["sessionKey"]?.value as? String == "agent:reviewer:telegram:group:1")
        #expect(list.params["agentId"]?.value as? String == "reviewer")
        #expect(list.params["key"] == nil)

        #expect(switchBranch.method == "sessions.branches.switch")
        #expect(switchBranch.timeoutMs == 15000)
        #expect(switchBranch.params["sessionKey"]?.value as? String == "global")
        #expect(switchBranch.params["agentId"] == nil)
        #expect(switchBranch.params["leafEntryId"]?.value as? String == "leaf-42")
        #expect(switchBranch.params["key"] == nil)
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

    @Test func `rename clear archive delete and fork use session mutation contracts`() {
        let rename = OpenClawChatGatewayRequests.patchSession(
            sessionKey: "agent:main:child",
            agentID: nil,
            label: .some(nil),
            category: nil,
            pinned: nil,
            archived: nil,
            unreadPatch: nil)
        let archive = OpenClawChatGatewayRequests.patchSession(
            sessionKey: "agent:main:child",
            agentID: nil,
            expectedSessionID: "session-child",
            label: nil,
            category: nil,
            pinned: nil,
            archived: true,
            unreadPatch: nil)
        let restore = OpenClawChatGatewayRequests.patchSession(
            sessionKey: "agent:main:child",
            agentID: nil,
            expectedSessionID: "session-child",
            label: nil,
            category: nil,
            pinned: nil,
            archived: false,
            unreadPatch: nil)
        let fork = OpenClawChatGatewayRequests.forkSession(
            parentSessionKey: "agent:main:child",
            agentID: nil)
        let delete = OpenClawChatGatewayRequests.deleteSession(
            sessionKey: "agent:main:child",
            agentID: nil)

        #expect(rename.params["label"]?.value is NSNull)
        #expect(archive.params["archived"]?.value as? Bool == true)
        #expect(archive.params["expectedSessionId"]?.value as? String == "session-child")
        #expect(archive.timeoutMs == 600_000)
        #expect(delete.method == "sessions.delete")
        #expect(delete.timeoutMs == 600_000)
        #expect(restore.params["expectedSessionId"]?.value as? String == "session-child")
        #expect(restore.timeoutMs == 15000)
        #expect(fork.method == "sessions.create")
        #expect(fork.params["parentSessionKey"]?.value as? String == "agent:main:child")
        #expect(fork.params["fork"]?.value as? Bool == true)
    }

    @Test func `chat metadata request selects session agent before fallback`() {
        let scoped = OpenClawChatGatewayRequests.chatMetadata(
            sessionKey: "agent:reviewer:main",
            fallbackAgentID: "fallback")
        #expect(scoped.method == "chat.metadata")
        #expect(scoped.params["agentId"]?.value as? String == "reviewer")

        let global = OpenClawChatGatewayRequests.chatMetadata(
            sessionKey: "global",
            fallbackAgentID: "reviewer")
        #expect(global.params["agentId"]?.value as? String == "reviewer")
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
            expectedSessionSettings: OpenClawChatSessionSettingsExpectation(
                permissionMode: .guarded,
                toolOverrides: OpenClawChatSessionToolOverrides(webSearch: false)),
            supportsSessionSettingsCAS: true,
            message: "hello",
            thinking: " low ",
            idempotencyKey: "send-1",
            attachments: [.init(type: "image", mimeType: "image/png", fileName: "a.png", content: "abc")])

        #expect(request.method == "chat.send")
        #expect(request.timeoutMs == 30000)
        #expect(request.params["agentId"]?.value as? String == "reviewer")
        #expect(request.params["expectedSessionRoutingContract"]?.value as? String == "per-sender|main|reviewer")
        #expect(request.params["expectedPermissionMode"]?.value as? String == "guarded")
        let expectedTools = try JSONEncoder().encode(request.params["expectedToolOverrides"])
        let expectedToolsValue = try #require(
            JSONSerialization.jsonObject(with: expectedTools) as? [String: Any])
        #expect(expectedToolsValue["webSearch"] as? Bool == false)
        #expect(request.params["thinking"]?.value as? String == "low")
        #expect(request.params["timeoutMs"] == nil)
        let encoded = try JSONEncoder().encode(request.params["attachments"])
        let json = try #require(String(bytes: encoded, encoding: .utf8))
        #expect(json.contains("a.png"))
    }

    @Test func `send request omits inherited thinking override`() {
        let inherited = OpenClawChatGatewayRequests.sendMessage(
            sessionKey: "global",
            agentID: nil,
            expectedSessionRoutingContract: nil,
            expectedSessionSettings: OpenClawChatSessionSettingsExpectation(
                permissionMode: nil,
                toolOverrides: nil),
            message: "inherit",
            thinking: nil,
            idempotencyKey: "send-inherit",
            attachments: [])
        #expect(inherited.params["thinking"] == nil)
        #expect(inherited.params["expectedPermissionMode"] == nil)
        #expect(inherited.params["expectedToolOverrides"] == nil)
    }

    @Test func `question resolve request uses the gateway answer envelope`() throws {
        let request = OpenClawChatGatewayRequests.resolveQuestion(
            id: "ask_123",
            answers: ["meal": ["Pizza", "Salad"]])

        #expect(request.method == "question.resolve")
        let data = try JSONEncoder().encode(request.params)
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let envelope = try #require(object["answers"] as? [String: Any])
        let answers = try #require(envelope["answers"] as? [String: [String]])
        #expect(answers == ["meal": ["Pizza", "Salad"]])
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
    @Test func `hello operator scopes preserve the exact advertised authorization`() {
        let snapshot = Snapshot(
            presence: [],
            health: [:],
            stateversion: StateVersion(presence: 0, health: 0),
            uptimems: 0)
        let hello = HelloOk(
            type: "hello-ok",
            _protocol: 3,
            server: [:],
            features: [:],
            snapshot: snapshot,
            auth: ["scopes": AnyCodable([
                AnyCodable("operator.read"),
                AnyCodable("operator.admin"),
            ])],
            policy: [:])
        let missing = HelloOk(
            type: "hello-ok",
            _protocol: 3,
            server: [:],
            features: [:],
            snapshot: snapshot,
            auth: [:],
            policy: [:])

        #expect(hello.advertisedOperatorScopes() == ["operator.read", "operator.admin"])
        #expect(missing.advertisedOperatorScopes() == nil)
    }

    @Test func `session row decodes permission and every tool override family`() throws {
        let row = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(#"""
        {
          "key":"main","permissionMode":"guarded","toolOverrides":{
            "webSearch":false,
            "skills":{"release":false},
            "mcpServers":{"github":true},
            "mcpToolsDeny":{"github":["create_issue"]}
          }
        }
        """#.utf8))

        #expect(row.permissionMode == .guarded)
        #expect(row.toolOverrides == OpenClawChatSessionToolOverrides(
            webSearch: false,
            skills: ["release": false],
            mcpServers: ["github": true],
            mcpToolsDeny: ["github": ["create_issue"]]))
    }

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

        let swarmNote = EventFrame(
            type: "event",
            event: "sessions.changed",
            payload: AnyCodable([
                "sessionKey": AnyCodable("agent:main:main"),
                "reason": AnyCodable("swarm-note"),
                "swarmGroupId": AnyCodable("swarm:agent:main:main:run-1"),
                "kind": AnyCodable("phase"),
                "text": AnyCodable("Research"),
            ]))
        guard case let .sessionsChanged(note) = OpenClawChatGatewayPayloadCodec.event(from: swarmNote)
        else {
            Issue.record("expected swarm sessionsChanged")
            return
        }
        #expect(note.swarmGroupId == "swarm:agent:main:main:run-1")
        #expect(note.kind == "phase")
        #expect(note.text == "Research")

        let lifecycleChanged = EventFrame(
            type: "event",
            event: "sessions.changed",
            payload: AnyCodable([
                "sessionKey": AnyCodable("agent:main:main"),
                "phase": AnyCodable("end"),
                "runId": AnyCodable("run-1"),
                "session": AnyCodable([
                    "key": AnyCodable("agent:main:main"),
                    "updatedAt": AnyCodable(30000),
                    "status": AnyCodable("done"),
                    "hasActiveRun": AnyCodable(false),
                    "runtimeMs": AnyCodable(30000),
                    "outputTokens": AnyCodable(42),
                    "activeRunIds": AnyCodable([]),
                ]),
            ]))
        guard case let .sessionsChanged(lifecycle) = OpenClawChatGatewayPayloadCodec.event(
            from: lifecycleChanged)
        else {
            Issue.record("expected lifecycle sessionsChanged")
            return
        }
        #expect(lifecycle.reason.isEmpty)
        #expect(lifecycle.phase == "end")
        #expect(lifecycle.runId == "run-1")
        #expect(lifecycle.session?.key == "agent:main:main")
        #expect(lifecycle.session?.status == "done")
        #expect(lifecycle.session?.runtimeMs == 30000)
        #expect(lifecycle.session?.outputTokens == 42)
        #expect(lifecycle.session?.activeRunIds == [])

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

        let observer = EventFrame(
            type: "event",
            event: "session.observer",
            payload: AnyCodable([
                "sessionKey": AnyCodable("main"),
                "runId": AnyCodable("run-1"),
                "revision": AnyCodable(2),
                "updatedAt": AnyCodable(300),
                "headline": AnyCodable("Wrapping up"),
                "health": AnyCodable("wrapping-up"),
            ]))
        guard case let .sessionObserver(digest) = OpenClawChatGatewayPayloadCodec.event(from: observer)
        else {
            Issue.record("expected sessionObserver")
            return
        }
        #expect(digest.sessionkey == "main")
        #expect(digest.runid == "run-1")
        #expect(digest.revision == 2)

        let task = EventFrame(
            type: "event",
            event: "task",
            payload: AnyCodable([
                "action": AnyCodable("upserted"),
                "task": AnyCodable([
                    "id": AnyCodable("task-1"),
                    "runtime": AnyCodable("subagent"),
                    "status": AnyCodable("running"),
                    "sessionKey": AnyCodable("agent:main:main"),
                    "lastActivity": AnyCodable("Editing ChatView.swift"),
                    "diffStat": AnyCodable([
                        "files": AnyCodable(1),
                        "added": AnyCodable(8),
                        "removed": AnyCodable(2),
                    ]),
                ]),
            ]))
        guard case let .task(.upserted(summary)) = OpenClawChatGatewayPayloadCodec.event(from: task)
        else {
            Issue.record("expected task upsert")
            return
        }
        #expect(summary.id == "task-1")
        #expect(summary.sessionkey == "agent:main:main")
        #expect(summary.lastactivity == "Editing ChatView.swift")
        #expect(summary.diffstat?["added"]?.intValue == 8)

        let progressCard = EventFrame(
            type: "event",
            event: "progressCard.changed",
            payload: AnyCodable([
                "sessionKey": AnyCodable("agent:main:main"),
                "revision": AnyCodable(7),
            ]))
        guard case let .progressCardChanged(event) = OpenClawChatGatewayPayloadCodec.event(
            from: progressCard)
        else {
            Issue.record("expected progressCardChanged")
            return
        }
        #expect(event.sessionkey == "agent:main:main")
        #expect(event.revision.value as? Int == 7)

        #expect(OpenClawChatGatewayPayloadCodec.event(from: EventFrame(
            type: "event",
            event: "unknown")) == nil)
    }

    @Test func `session change decoding distinguishes absent fields from explicit clears`() {
        func decode(_ fields: [String: AnyCodable]) throws -> OpenClawChatSessionsChangedEvent {
            let frame = EventFrame(
                type: "event",
                event: "sessions.changed",
                payload: AnyCodable(fields))
            guard case let .sessionsChanged(change) = OpenClawChatGatewayPayloadCodec.event(from: frame)
            else {
                throw CancellationError()
            }
            return change
        }

        let partial = try? decode([
            "sessionKey": AnyCodable("main"),
            "reason": AnyCodable("message"),
            "updatedAt": AnyCodable(200),
        ])
        #expect(partial?.colorPresent == false)
        #expect(partial?.agentStatusPresent == false)
        #expect(partial?.observerDigestPresent == false)
        #expect(partial?.statusPresent == false)
        #expect(partial?.lastRunErrorPresent == false)

        let cleared = try? decode([
            "sessionKey": AnyCodable("main"),
            "reason": AnyCodable("patch"),
            "color": AnyCodable(NSNull()),
            "agentStatus": AnyCodable(NSNull()),
            "observerDigest": AnyCodable(NSNull()),
            "status": AnyCodable(NSNull()),
            "lastRunError": AnyCodable(NSNull()),
        ])
        #expect(cleared?.colorPresent == true)
        #expect(cleared?.color == nil)
        #expect(cleared?.agentStatusPresent == true)
        #expect(cleared?.observerDigestPresent == true)
        #expect(cleared?.statusPresent == true)
        #expect(cleared?.lastRunErrorPresent == true)
    }

    @Test func `session change decodes nested fallback with outer null precedence and no reason`() throws {
        let data = Data("""
        {
          "sessionKey": null,
          "color": null,
          "status": null,
          "session": {
            "key": "agent:main:child",
            "color": "blue",
            "agentId": "main",
            "parentSessionKey": "agent:main:parent",
            "status": "running",
            "lastRunError": null,
            "hasActiveRun": true,
            "swarmGroupId": "swarm:agent:main:parent:turn-1"
          }
        }
        """.utf8)

        let event = try JSONDecoder().decode(OpenClawChatSessionsChangedEvent.self, from: data)
        #expect(event.reason.isEmpty)
        #expect(event.sessionKey == nil)
        #expect(event.color == nil)
        #expect(event.colorPresent)
        #expect(event.agentId == "main")
        #expect(event.parentSessionKey == "agent:main:parent")
        #expect(event.status == nil)
        #expect(event.statusPresent)
        #expect(event.lastRunError == nil)
        #expect(event.lastRunErrorPresent)
        #expect(event.hasActiveRun == true)
        #expect(event.swarmGroupId == "swarm:agent:main:parent:turn-1")
    }

    @Test func `session change remains codable without exposing presence flags`() throws {
        let event = OpenClawChatSessionsChangedEvent(
            sessionKey: "agent:main:work",
            agentId: "main",
            reason: "run-progress",
            updatedAt: 200,
            lastReadAt: 100,
            color: nil,
            agentStatus: .init(note: "Reviewing", expiresAt: 500, attention: "hand"),
            observerDigest: .init(
                runId: "run-1",
                revision: 2,
                updatedAt: 200,
                headline: "On track",
                health: "on-track"),
            status: "running",
            lastRunError: "Previous warning",
            hasActiveRun: true,
            activeRunIds: ["run-1"],
            startedAt: 50,
            endedAt: nil,
            colorPresent: true)

        let data = try JSONEncoder().encode(event)
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(object["colorPresent"] == nil)
        #expect(object["color"] is NSNull)
        #expect(object["agentStatusPresent"] == nil)
        #expect(object["observerDigestPresent"] == nil)
        #expect(object["statusPresent"] == nil)
        #expect(object["lastRunErrorPresent"] == nil)
        #expect(try JSONDecoder().decode(OpenClawChatSessionsChangedEvent.self, from: data) == event)
    }
}
