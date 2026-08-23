import Foundation
import OpenClawChatUI
import OpenClawProtocol
import Testing
@testable import OpenClaw

extension QuickChatModelControlSnapshot {
    static let testFixture = QuickChatModelControlSnapshot(
        models: [],
        currentModelSelectionID: nil,
        currentThinkingLevel: nil,
        thinkingOptions: QuickChatModelControlLogic.baseThinkingOptions,
        defaultProvider: nil)
}

@MainActor
struct QuickChatPowerFeaturesTests {
    @Test func `dictation inserts at a UTF16 caret and replaces each partial`() {
        let text = "Hello"
        let session = QuickChatDictationTextSession(
            baseText: text,
            replacementRange: NSRange(location: text.utf16.count, length: 0))

        #expect(session.update(transcript: "swift").text == "Hello swift")
        let final = session.update(transcript: "swift world")
        #expect(final.text == "Hello swift world")
        #expect(final.selection == NSRange(location: final.text.utf16.count, length: 0))
    }

    @Test func `dictation replaces the selected composer span`() {
        let text = "Use old model"
        let range = (text as NSString).range(of: "old")
        let update = QuickChatDictationTextSession(
            baseText: text,
            replacementRange: range)
            .update(transcript: "new")

        #expect(update.text == "Use new model")
        #expect(update.selection == NSRange(location: range.location + 3, length: 0))
    }

    @Test func `dictation caret respects extended grapheme UTF16 offsets`() {
        let prefix = "Hi 🦞"
        let text = "\(prefix)!"
        let update = QuickChatDictationTextSession(
            baseText: text,
            replacementRange: NSRange(location: prefix.utf16.count, length: 0))
            .update(transcript: "there")

        #expect(update.text == "Hi 🦞 there!")
    }

    @Test func `paste extracts only a completed assistant reply after the accepted send`() {
        let messages = [
            Self.message(role: "user", text: "Question", idempotencyKey: "send-1"),
            Self.message(role: "assistant", text: "<think>hidden</think>\nVisible **answer**"),
        ]

        #expect(QuickChatPasteLogic.finalAssistantText(
            messages: messages,
            afterUserIdempotencyKey: "send-1",
            streamingAssistantText: nil,
            pendingRunCount: 0) == "Visible **answer**")
        #expect(QuickChatPasteLogic.finalAssistantText(
            messages: messages,
            afterUserIdempotencyKey: "send-1",
            streamingAssistantText: "Visible",
            pendingRunCount: 0) == nil)
        #expect(QuickChatPasteLogic.finalAssistantText(
            messages: messages,
            afterUserIdempotencyKey: "send-1",
            streamingAssistantText: nil,
            pendingRunCount: 1) == nil)
    }

    @Test func `paste rejects a stale assistant and the OpenClaw process`() {
        let messages = [
            Self.message(role: "user", text: "Question", idempotencyKey: "send-1"),
            Self.message(role: "assistant", text: "Answer"),
            Self.message(role: "user", text: "Follow-up", idempotencyKey: "send-2"),
            Self.message(role: "assistant", text: "Different answer"),
        ]
        #expect(QuickChatPasteLogic.finalAssistantText(
            messages: messages,
            afterUserIdempotencyKey: "send-1",
            streamingAssistantText: nil,
            pendingRunCount: 0) == nil)
        #expect(!QuickChatPasteLogic.canPaste(frontmostProcessIdentifier: 42, ownProcessIdentifier: 42))
        #expect(QuickChatPasteLogic.canPaste(frontmostProcessIdentifier: 43, ownProcessIdentifier: 42))
        #expect(!QuickChatPasteLogic.canPaste(frontmostProcessIdentifier: nil, ownProcessIdentifier: 42))
        #expect(QuickChatPasteLogic.isExpectedTarget(
            frontmostProcessIdentifier: 43,
            targetProcessIdentifier: 43))
        #expect(!QuickChatPasteLogic.isExpectedTarget(
            frontmostProcessIdentifier: 44,
            targetProcessIdentifier: 43))
    }

    @Test func `models list fixture builds current state and provider menu sections`() throws {
        let models = [
            OpenClawChatModelChoice(
                modelID: "claude-sonnet-4-6",
                name: "Sonnet",
                provider: "anthropic",
                contextWindow: 200_000,
                reasoning: true),
            OpenClawChatModelChoice(
                modelID: "gpt-5.6-sol",
                name: "Sol",
                provider: "openai",
                contextWindow: 400_000,
                reasoning: true),
        ]
        let sessions = try JSONDecoder().decode(
            OpenClawChatSessionsListResponse.self,
            from: Data(Self.sessionsFixture.utf8))
        let agents = try JSONDecoder().decode(
            AgentsListResult.self,
            from: Data(Self.agentsFixture.utf8))
        let snapshot = QuickChatModelControlLogic.snapshot(
            target: QuickChatRoutingTarget(sessionKey: "agent:main:main", agentID: nil),
            models: models,
            sessions: sessions,
            agents: agents)
        let sections = ChatModelPickerStore.sections(
            choices: snapshot.models,
            favorites: [],
            recents: [],
            defaultProvider: snapshot.defaultProvider)

        #expect(snapshot.currentModelSelectionID == "openai/gpt-5.6-sol")
        #expect(snapshot.currentThinkingLevel == "medium")
        #expect(snapshot.thinkingOptions.map(\.id) == ["off", "medium", "high"])
        #expect(sections.providers.map(\.id) == ["openai", "anthropic"])
        #expect(sections.providers.first?.isDefaultProvider == true)
    }

    @Test func `model controls use target agent defaults when no session row exists`() throws {
        let sessions = try JSONDecoder().decode(
            OpenClawChatSessionsListResponse.self,
            from: Data(Self.sessionsFixture.utf8))
        let agents = try JSONDecoder().decode(
            AgentsListResult.self,
            from: Data(Self.agentsFixture.utf8))
        let snapshot = QuickChatModelControlLogic.snapshot(
            target: QuickChatRoutingTarget(sessionKey: "agent:work:main", agentID: nil),
            models: [],
            sessions: sessions,
            agents: agents)

        #expect(snapshot.currentModelSelectionID == "deepseek/deepseek-v4")
        #expect(snapshot.currentThinkingLevel == "high")
        #expect(snapshot.thinkingOptions.map(\.id) == ["off", "high"])
        #expect(snapshot.defaultProvider == "deepseek")
    }

    @Test func `model patch decision only patches an explicit unapplied selection`() {
        #expect(QuickChatModelControlLogic.modelPatchDecision(
            selectionID: nil,
            appliedSelectionID: nil) == .none)
        #expect(QuickChatModelControlLogic.modelPatchDecision(
            selectionID: "openai/gpt-5.6-sol",
            appliedSelectionID: "openai/gpt-5.6-sol") == .none)
        #expect(QuickChatModelControlLogic.modelPatchDecision(
            selectionID: "openai/gpt-5.6-sol",
            appliedSelectionID: "openai/gpt-5.6-sol",
            currentSessionSelectionID: "anthropic/claude-sonnet-4-6") == .patch("openai/gpt-5.6-sol"))
        #expect(QuickChatModelControlLogic.modelPatchDecision(
            selectionID: "openai/gpt-5.6-sol",
            appliedSelectionID: nil,
            currentSessionSelectionID: "openai/gpt-5.6-sol") == .none)
        #expect(QuickChatModelControlLogic.modelPatchDecision(
            selectionID: "openai/gpt-5.6-sol",
            appliedSelectionID: nil) == .patch("openai/gpt-5.6-sol"))
        #expect(QuickChatModelControlLogic.modelPatchDecision(
            selectionID: OpenClawChatViewModel.defaultModelSelectionID,
            appliedSelectionID: nil) == .patch(nil))
    }

    @Test func `model thinking options reject an unsupported explicit override`() {
        let options = [OpenClawChatThinkingLevelOption(id: "off", label: "Off")]

        #expect(QuickChatModelControlLogic.validatedThinkingSelection("off", options: options) == "off")
        #expect(QuickChatModelControlLogic.validatedThinkingSelection("high", options: options) == nil)
        #expect(QuickChatModelControlLogic.validatedThinkingSelection(nil, options: options) == nil)
    }

    @Test func `reasoning override threads into chat send per message`() async throws {
        var sentThinking: String?
        let model = QuickChatModel(
            sessionKeyProvider: { "main" },
            agentsProvider: {
                AgentsListResult(
                    defaultid: "main",
                    mainkey: "main",
                    scope: AnyCodable("per-agent"),
                    agents: [AgentSummary(id: "main", name: "Main")])
            },
            agentIdentityProvider: { _ in .placeholder },
            sendProvider: { _, _, _, thinking, _, _ in
                sentThinking = thinking
                return "ok"
            },
            permissionStatusProvider: { capabilities in
                Dictionary(uniqueKeysWithValues: capabilities.map { ($0, true) })
            },
            permissionGrantProvider: { capabilities in
                Dictionary(uniqueKeysWithValues: capabilities.map { ($0, true) })
            },
            connectionGateProvider: { .available },
            modelControlsProvider: { _ in
                QuickChatModelControlSnapshot(
                    models: [],
                    currentModelSelectionID: nil,
                    currentThinkingLevel: "low",
                    thinkingOptions: QuickChatModelControlLogic.baseThinkingOptions,
                    defaultProvider: nil)
            },
            modelPatchProvider: { _, _ in nil })
        let presentationID = model.beginPresentation()
        await model.refreshForPresentation(id: presentationID)
        try await Self.waitForModelControls(model)
        model.selectThinkingLevel("high")
        model.text = "Hello"

        #expect(await model.send())
        #expect(sentThinking == "high")
    }

    @Test func `session model patch settles and send aborts after dismissal`() async throws {
        let latch = QuickChatModelPatchLatch()
        var sendCount = 0
        let choice = OpenClawChatModelChoice(
            modelID: "gpt-5.6-sol",
            name: "Sol",
            provider: "openai",
            contextWindow: 400_000,
            reasoning: true)
        let model = Self.model(
            sendProvider: { _, _, _, _, _, _ in
                sendCount += 1
                return "ok"
            },
            controlsProvider: { _ in
                QuickChatModelControlSnapshot(
                    models: [choice],
                    currentModelSelectionID: nil,
                    currentThinkingLevel: nil,
                    thinkingOptions: QuickChatModelControlLogic.baseThinkingOptions,
                    defaultProvider: nil)
            },
            patchProvider: { _, _ in try await latch.wait() })
        let presentationID = model.beginPresentation()
        await model.refreshForPresentation(id: presentationID)
        try await Self.waitForModelControls(model)

        model.selectModel(choice.selectionID)
        model.text = "Hello"
        let send = Task { await model.send() }
        model.endPresentation()
        try await latch.waitUntilStarted()
        latch.finish(with: OpenClawChatModelPatchResult(
            modelProvider: choice.provider,
            model: choice.modelID,
            thinkingLevel: nil,
            thinkingLevels: QuickChatModelControlLogic.baseThinkingOptions))
        try await Self.waitForModelPatch(model)

        #expect(latch.completed)
        #expect(!(await send.value))
        #expect(sendCount == 0)
    }

    @Test func `failed post-patch refresh preserves and blocks explicit reasoning`() async throws {
        let choice = OpenClawChatModelChoice(
            modelID: "gpt-5.6-sol",
            name: "Sol",
            provider: "openai",
            contextWindow: 400_000,
            reasoning: true)
        var controlsCallCount = 0
        let model = Self.model(
            controlsProvider: { _ in
                controlsCallCount += 1
                if controlsCallCount > 1 { throw QuickChatModelControlsTestError.refreshFailed }
                return QuickChatModelControlSnapshot(
                    models: [choice],
                    currentModelSelectionID: nil,
                    currentThinkingLevel: nil,
                    thinkingOptions: QuickChatModelControlLogic.baseThinkingOptions,
                    defaultProvider: nil)
            },
            patchProvider: { _, _ in
                OpenClawChatModelPatchResult(
                    modelProvider: choice.provider,
                    model: choice.modelID,
                    thinkingLevel: nil)
            })
        let presentationID = model.beginPresentation()
        await model.refreshForPresentation(id: presentationID)
        try await Self.waitForModelControls(model)
        model.selectThinkingLevel("high")
        model.selectModel(choice.selectionID)
        let refreshClock = ContinuousClock()
        let refreshDeadline = refreshClock.now.advanced(by: .seconds(1))
        while controlsCallCount < 2 {
            guard refreshClock.now < refreshDeadline else {
                throw QuickChatModelControlsTestError.timeout
            }
            await Task.yield()
        }
        try await Self.waitForModelPatch(model)
        model.text = "Hello"

        #expect(model.selectedThinkingLevel == "high")
        #expect(model.thinkingOptions.isEmpty)
        #expect(!model.isSelectedThinkingLevelSupported)
        #expect(!model.canSend)
    }

    private static func model(
        sendProvider: @escaping QuickChatModel.SendProvider = { _, _, _, _, _, _ in "ok" },
        controlsProvider: @escaping QuickChatModel.ModelControlsProvider,
        patchProvider: @escaping QuickChatModel.ModelPatchProvider) -> QuickChatModel
    {
        QuickChatModel(
            sessionKeyProvider: { "agent:main:main" },
            agentsProvider: {
                AgentsListResult(
                    defaultid: "main",
                    mainkey: "main",
                    scope: AnyCodable("per-agent"),
                    agents: [AgentSummary(id: "main", name: "Main")])
            },
            agentIdentityProvider: { _ in .placeholder },
            sendProvider: sendProvider,
            permissionStatusProvider: { capabilities in
                Dictionary(uniqueKeysWithValues: capabilities.map { ($0, true) })
            },
            permissionGrantProvider: { capabilities in
                Dictionary(uniqueKeysWithValues: capabilities.map { ($0, true) })
            },
            connectionGateProvider: { .available },
            modelControlsProvider: controlsProvider,
            modelPatchProvider: patchProvider)
    }

    private static func waitForModelControls(_ model: QuickChatModel) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(1))
        while model.isLoadingModelControls {
            guard clock.now < deadline else { throw QuickChatModelControlsTestError.timeout }
            await Task.yield()
        }
    }

    private static func waitForModelPatch(_ model: QuickChatModel) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(1))
        while model.isUpdatingModel {
            guard clock.now < deadline else { throw QuickChatModelControlsTestError.timeout }
            await Task.yield()
        }
    }

    private static func message(
        role: String,
        text: String,
        idempotencyKey: String? = nil) -> OpenClawChatMessage
    {
        OpenClawChatMessage(
            role: role,
            content: [OpenClawChatMessageContent(
                type: "text",
                text: text,
                mimeType: nil,
                fileName: nil,
                content: nil)],
            timestamp: 1,
            idempotencyKey: idempotencyKey)
    }

    private static let sessionsFixture = """
    {
      "defaults": {
        "modelProvider": "anthropic",
        "model": "claude-sonnet-4-6",
        "contextTokens": 200000,
        "thinkingLevels": [
          {"id": "off", "label": "off"},
          {"id": "medium", "label": "medium"},
          {"id": "high", "label": "high"}
        ],
        "thinkingDefault": "low",
        "mainSessionKey": "agent:main:main"
      },
      "sessions": [
        {
          "key": "agent:main:main",
          "modelProvider": "openai",
          "model": "gpt-5.6-sol",
          "thinkingLevel": "medium"
        }
      ]
    }
    """

    private static let agentsFixture = """
    {
      "defaultId": "main",
      "mainKey": "main",
      "scope": "per-sender",
      "agents": [
        {
          "id": "main",
          "model": {"primary": "anthropic/claude-sonnet-4-6"},
          "thinkingDefault": "low"
        },
        {
          "id": "work",
          "model": {"primary": "deepseek/deepseek-v4"},
          "thinkingDefault": "high",
          "thinkingLevels": [
            {"id": "off", "label": "Off"},
            {"id": "high", "label": "High"}
          ]
        }
      ]
    }
    """
}

private enum QuickChatModelControlsTestError: Error {
    case refreshFailed
    case timeout
}

@MainActor
private final class QuickChatModelPatchLatch {
    private var continuation: CheckedContinuation<OpenClawChatModelPatchResult, Never>?
    private(set) var completed = false

    var started: Bool {
        self.continuation != nil
    }

    func wait() async throws -> OpenClawChatModelPatchResult {
        try Task.checkCancellation()
        let result = await withCheckedContinuation { continuation in
            self.continuation = continuation
        }
        try Task.checkCancellation()
        self.completed = true
        return result
    }

    func waitUntilStarted() async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(1))
        while !self.started {
            guard clock.now < deadline else { throw QuickChatModelControlsTestError.timeout }
            await Task.yield()
        }
    }

    func finish(with result: OpenClawChatModelPatchResult) {
        self.continuation?.resume(returning: result)
        self.continuation = nil
    }
}
