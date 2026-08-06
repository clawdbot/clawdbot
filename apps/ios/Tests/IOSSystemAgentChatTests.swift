import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@MainActor
struct IOSSystemAgentChatTests {
    private struct RecordedRequest: @unchecked Sendable {
        let method: String
        let params: [String: AnyCodable]
        let timeoutMs: Double
    }

    private enum HarnessError: Error {
        case failed
    }

    private actor RequestRecorder {
        private var requests: [RecordedRequest] = []
        private var responses: [Result<Data, HarnessError>]

        init(responses: [Result<Data, HarnessError>]) {
            self.responses = responses
        }

        func perform(
            method: String,
            params: [String: AnyCodable],
            timeoutMs: Double) throws -> Data
        {
            self.requests.append(RecordedRequest(method: method, params: params, timeoutMs: timeoutMs))
            guard !self.responses.isEmpty else { throw HarnessError.failed }
            return try self.responses.removeFirst().get()
        }

        func allRequests() -> [RecordedRequest] {
            self.requests
        }
    }

    private actor RouteState {
        private var current = true

        func setCurrent(_ current: Bool) {
            self.current = current
        }

        func isCurrent() -> Bool {
            self.current
        }
    }

    private actor SuspendedRequest {
        private var continuation: CheckedContinuation<Data, Never>?
        private var request: RecordedRequest?

        func perform(method: String, params: [String: AnyCodable], timeoutMs: Double) async -> Data {
            self.request = RecordedRequest(method: method, params: params, timeoutMs: timeoutMs)
            return await withCheckedContinuation { continuation in
                self.continuation = continuation
            }
        }

        func hasRequest() -> Bool {
            self.request != nil
        }

        func resolve(_ data: Data) {
            self.continuation?.resume(returning: data)
            self.continuation = nil
        }
    }

    @Test func `RPC is gated by connected operator admin and omits onboarding params`() async throws {
        let recorder = RequestRecorder(responses: [.success(Self.reply("Ready"))])
        let model = self.makeModel(
            accessState: .disconnected,
            recorder: recorder)

        await Self.start(model)
        #expect(await recorder.allRequests().isEmpty)

        model.updateAccess(connected: true, hasAdminScope: false, routeIdentity: "gateway-a")
        await Self.start(model)
        #expect(await recorder.allRequests().isEmpty)

        model.updateAccess(connected: true, hasAdminScope: true, routeIdentity: "gateway-a")
        await Self.start(model)

        let request = try #require(await recorder.allRequests().first)
        #expect(request.method == "openclaw.chat")
        #expect(request.timeoutMs == 190_000)
        #expect((request.params["sessionId"]?.value as? String)?.hasPrefix("ios-settings-openclaw-") == true)
        #expect(request.params["sessionId"]?.value as? String != "main")
        #expect(request.params["message"] == nil)
        #expect(request.params["welcomeVariant"] == nil)
        #expect(request.params["delegation"] == nil)
    }

    @Test func `missing advertised system-agent method blocks the chat`() {
        #expect(
            IOSSystemAgentChatModel.accessState(
                connected: true,
                hasAdminScope: true,
                supportsSystemAgent: false) == .missingSystemAgentMethod)
    }

    @Test func `pending method support check blocks the chat without losing secure state`() async {
        let recorder = RequestRecorder(responses: [.success(Self.reply("Enter a secret", sensitive: true))])
        let model = self.makeModel(recorder: recorder)

        await Self.start(model)
        #expect(model.expectsSensitiveReply)
        model.updateAccess(
            connected: true,
            hasAdminScope: true,
            supportsSystemAgent: nil,
            routeIdentity: "gateway-a")
        await Self.start(model)

        #expect(model.accessState == .checkingSystemAgentMethod)
        #expect(model.expectsSensitiveReply)
        #expect(await recorder.allRequests().count == 1)
    }

    @Test func `route change invalidates suspended generation and ignores its reply`() async {
        let suspended = SuspendedRequest()
        let model = IOSSystemAgentChatModel(
            accessState: .ready,
            routeIdentity: "gateway-a",
            captureRoute: { _ in
                IOSSystemAgentChatRouteLease(
                    route: nil,
                    request: { method, params, timeoutMs in
                        await suspended.perform(method: method, params: params, timeoutMs: timeoutMs)
                    },
                    isCurrent: { true })
            })

        let start = model.startIfNeeded()
        await Self.waitUntil { await suspended.hasRequest() }
        let originalSessionID = model.sessionID
        model.input = "unsent-secret"
        model.updateAccess(connected: true, hasAdminScope: true, routeIdentity: "gateway-b")
        await suspended.resolve(Self.reply("stale reply"))
        await start?.value

        #expect(model.messages.isEmpty)
        #expect(model.sessionID != originalSessionID)
        #expect(model.input.isEmpty)
        #expect(model.errorMessage == nil)
    }

    @Test func `gateway identity changes rotate the retained conversation`() async {
        let recorder = RequestRecorder(responses: [.success(Self.questionReply())])
        let model = self.makeModel(recorder: recorder)

        await Self.start(model)
        let originalSessionID = model.sessionID
        #expect(!model.messages.isEmpty)

        model.updateAccess(connected: true, hasAdminScope: true, routeIdentity: "gateway-b")

        #expect(model.sessionID != originalSessionID)
        #expect(model.messages.isEmpty)
        #expect(model.dismissedQuestionMessageIDs.isEmpty)
        #expect(model.retiredQuestionMessageIDs.isEmpty)
        #expect(model.pendingHandoff == nil)
        #expect(model.errorMessage == nil)
    }

    @Test func `stale route after RPC is rejected`() async {
        let recorder = RequestRecorder(responses: [.success(Self.reply("stale reply"))])
        let routeState = RouteState()
        await routeState.setCurrent(false)
        let model = self.makeModel(recorder: recorder, routeState: routeState)

        await Self.start(model)

        #expect(model.messages.isEmpty)
        #expect(model.errorMessage == "The Gateway connection changed. Restart OpenClaw to reconnect.")
    }

    @Test func `sensitive answer stays redacted locally and is sent verbatim`() async throws {
        let recorder = RequestRecorder(responses: [
            .success(Self.reply("Enter the token", sensitive: true)),
            .success(Self.reply("Saved", sensitive: false)),
        ])
        let model = self.makeModel(recorder: recorder)

        await Self.start(model)
        #expect(model.expectsSensitiveReply)
        model.input = " super-secret-value "
        let send = try #require(model.send())
        await send.value

        let requests = await recorder.allRequests()
        #expect(requests.count == 2)
        #expect(requests[1].params["message"]?.value as? String == " super-secret-value ")
        #expect(model.messages.contains { $0.role == .user && $0.text == "<redacted secret>" })
        #expect(!model.messages.contains { $0.text.contains("super-secret-value") })
    }

    @Test func `option reply uses canonical value while transcript keeps label`() async throws {
        let recorder = RequestRecorder(responses: [
            .success(Self.questionReply()),
            .success(Self.reply("Applied")),
        ])
        let model = self.makeModel(recorder: recorder)

        await Self.start(model)
        let questionMessage = try #require(model.messages.first)
        let answer = try #require(model.answerQuestion(messageID: questionMessage.id, optionLabel: "Use Tailscale"))
        await answer.value

        let requests = await recorder.allRequests()
        #expect(requests[1].params["message"]?.value as? String == "tailscale")
        #expect(model.messages.contains { $0.role == .user && $0.text == "Use Tailscale" })
        #expect(model.retiredQuestionMessageIDs.contains(questionMessage.id))
    }

    @Test func `skip for now sends explicit reply and dismisses card`() async throws {
        let recorder = RequestRecorder(responses: [
            .success(Self.questionReply()),
            .success(Self.reply("Skipped")),
        ])
        let model = self.makeModel(recorder: recorder)

        await Self.start(model)
        let questionMessage = try #require(model.messages.first)
        let skip = try #require(model.skipQuestion(messageID: questionMessage.id))
        await skip.value

        let requests = await recorder.allRequests()
        #expect(requests[1].params["message"]?.value as? String == "Skip for now")
        #expect(model.dismissedQuestionMessageIDs.contains(questionMessage.id))
        #expect(!model.isQuestionVisible(questionMessage))
    }

    @Test func `ordinary gateway errors remain visible instead of becoming route change`() async {
        let recorder = RequestRecorder(responses: [.failure(.failed)])
        let model = self.makeModel(recorder: recorder)

        await Self.start(model)

        #expect(model.errorMessage != nil)
        #expect(model.errorMessage != "The Gateway connection changed. Restart OpenClaw to reconnect.")
    }

    @Test func `pre-dispatch route change asks for restart`() async {
        let model = IOSSystemAgentChatModel(
            accessState: .ready,
            routeIdentity: "gateway-a",
            captureRoute: { _ in
                IOSSystemAgentChatRouteLease(
                    route: nil,
                    request: { _, _, _ in
                        throw GatewayNodeSessionRequestError.routeChangedBeforeDispatch
                    },
                    isCurrent: { true })
            })

        await Self.start(model)

        #expect(model.errorMessage == "The Gateway connection changed. Restart OpenClaw to reconnect.")
    }

    @Test func `leaving settings clears input without canceling an in-flight turn`() async {
        let suspended = SuspendedRequest()
        let model = IOSSystemAgentChatModel(
            accessState: .ready,
            routeIdentity: "gateway-a",
            captureRoute: { _ in
                IOSSystemAgentChatRouteLease(
                    route: nil,
                    request: { method, params, timeoutMs in
                        await suspended.perform(method: method, params: params, timeoutMs: timeoutMs)
                    },
                    isCurrent: { true })
            })

        let start = model.startIfNeeded()
        await Self.waitUntil { await suspended.hasRequest() }
        model.input = "discard-me"
        model.clearInputForBackground()
        await suspended.resolve(Self.reply("Welcome"))
        await start?.value

        #expect(model.input.isEmpty)
        #expect(model.messages.map(\.text) == ["Welcome"])
        #expect(model.errorMessage == nil)
    }

    @Test func `returning to settings continues the existing conversation`() async throws {
        let recorder = RequestRecorder(responses: [
            .success(Self.reply("Welcome")),
            .success(Self.reply("Still here")),
        ])
        let model = self.makeModel(recorder: recorder)

        await Self.start(model)
        let sessionID = model.sessionID
        model.clearInputForBackground()
        model.input = "Continue"
        let send = try #require(model.send())
        await send.value

        let requests = await recorder.allRequests()
        #expect(requests.count == 2)
        #expect(requests[1].params["sessionId"]?.value as? String == sessionID)
        #expect(requests[1].params["message"]?.value as? String == "Continue")
        #expect(model.messages.map(\.text) == ["Welcome", "Continue", "Still here"])
    }

    @Test func `restart creates a fresh system session`() async throws {
        let recorder = RequestRecorder(responses: [
            .failure(.failed),
            .success(Self.reply("Recovered")),
        ])
        let model = self.makeModel(recorder: recorder)
        let originalSessionID = model.sessionID

        await Self.start(model)
        #expect(model.errorMessage != nil)
        let restart = try #require(model.restartAfterError())
        await restart.value

        #expect(model.sessionID != originalSessionID)
        #expect(model.messages.map(\.text) == ["Recovered"])
        let requests = await recorder.allRequests()
        #expect(requests.count == 2)
        #expect(requests[0].params["sessionId"]?.value as? String == originalSessionID)
        #expect(requests[1].params["sessionId"]?.value as? String == model.sessionID)
    }

    @Test func `open agent handoff waits for explicit action and carries agent`() async {
        let recorder = RequestRecorder(responses: [
            .success(Self.reply("Continue in chat", action: "open-agent", agentID: " reviewer ")),
        ])
        let model = self.makeModel(recorder: recorder)
        var openedAgentID: String?
        var openCount = 0
        model.onOpenAgent = { agentID in
            openCount += 1
            openedAgentID = agentID
        }

        await Self.start(model)
        #expect(model.pendingHandoff?.agentID == " reviewer ")
        #expect(openCount == 0)

        model.openAgent()
        #expect(openCount == 1)
        #expect(openedAgentID == " reviewer ")
        #expect(model.pendingHandoff == nil)
    }

    @Test func `live handoff selects returned agent and opens ordinary chat`() {
        let appModel = NodeAppModel()
        let model = IOSSystemAgentChatModel(appModel: appModel)
        let previousOpenRequest = appModel.openChatRequestID

        model.onOpenAgent?(" reviewer ")

        #expect(appModel.selectedAgentId == "reviewer")
        #expect(appModel.openChatRequestID == previousOpenRequest + 1)
    }

    @Test func `settings chat model is retained by the settings store`() {
        let appModel = NodeAppModel()
        let store = IOSSystemAgentChatStore()

        #expect(store.model(for: appModel) === store.model(for: appModel))
    }

    @Test func `screenshot settings chat localizes display copy but preserves option replies`() throws {
        let data = try IOSSystemAgentChatModel.screenshotFixtureReply(params: [:])
        let object = try #require(
            JSONSerialization.jsonObject(with: data) as? [String: Any])
        let question = try #require(object["question"] as? [String: Any])
        let options = try #require(question["options"] as? [[String: Any]])

        #expect(object["reply"] as? String ==
            String(localized: "I can check Gateway status, repair configuration, change models, or connect channels."))
        #expect(question["question"] as? String == String(localized: "What should we look at first?"))
        #expect(options.first?["label"] as? String == String(localized: "Check status"))
        #expect(options.first?["reply"] as? String == "Check Gateway status")
        #expect(options.last?["label"] as? String == String(localized: "Review setup"))
        #expect(options.last?["reply"] as? String == "Review setup")
    }

    @Test func `settings chat uses branded and accessible secure input typography`() throws {
        let iosRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let source = try String(
            contentsOf: iosRoot.appendingPathComponent("Sources/Design/SettingsSystemAgentChat.swift"),
            encoding: .utf8)

        #expect(source.contains(".font(OpenClawType.title3SemiBold)"))
        #expect(source.contains(".font(OpenClawType.body)"))
        #expect(source.contains(".font(OpenClawType.subheadSemiBold)"))
        #expect(source.contains(".font(OpenClawType.caption)"))
        #expect(source.contains("SecureField(\"\", text: self.$model.input)"))
        #expect(source.contains(".onChange(of: self.scenePhase)"))
        #expect(source.contains("guard phase == .active else"))
        #expect(source.contains("self.cancelSystemAgentSupportRetry()"))
        #expect(source.contains(".accessibilityLabel(\"Enter secret\")"))
        #expect(source.contains("currentRoute(ifGatewayID: gatewayID)"))
        #expect(source.contains("supportsServerMethod(\n            \"openclaw.chat\""))
        #expect(source.contains("matchesGatewayIdentity(gatewayID)"))
        #expect(source.contains("cachedSystemAgentMethodSupport(gatewayID: gatewayID, route: route)"))
        #expect(source.contains("isCurrentSystemAgentSupportCheck(checkID, gatewayID: gatewayID)"))
        #expect(source.contains("currentRoute == route"))
        #expect(source.contains("retrySystemAgentSupportCheck(checkID, gatewayID: gatewayID)"))
        #expect(source.contains("cancelSystemAgentSupportRetry()"))
        #expect(source.contains("enterCheckingSystemAgentSupport(gatewayID: gatewayID)"))
        #expect(source.contains("self.isScreenActive"))
        #expect(source.contains("guard let support else"))
        #expect(source.contains("String(localized: \"Gateway Update Required\")"))
        #expect(source.contains("String(localized: \"Skip for now\")"))
        #expect(source.contains("String(localized: \"<redacted secret>\")"))
        #expect(source.contains("String(localized: \"Gateway is not connected\")"))
        #expect(!source.contains("SecureField(\"Enter secret"))
    }

    @Test func `settings route launch argument opens OpenClaw directly`() {
        let arguments = ["OpenClaw", "--openclaw-settings-route", "openclaw"]

        #expect(RootTabs.requestedInitialSettingsRoute(arguments: arguments) == .systemAgent)
        #expect(RootTabs.initialDestination(arguments: arguments) == .settings)
    }

    @Test func `settings route is visible and handoff uses root chat navigation`() throws {
        #expect(SettingsProTab().title(for: .systemAgent) == "OpenClaw")

        let iosRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let settings = try String(
            contentsOf: iosRoot.appendingPathComponent("Sources/Design/SettingsProTabSections.swift"),
            encoding: .utf8)
        let rootTabs = try String(
            contentsOf: iosRoot.appendingPathComponent("Sources/RootTabs.swift"),
            encoding: .utf8)
        #expect(settings.contains("route: .systemAgent"))
        #expect(settings
            .contains("SettingsSystemAgentChatScreen(model: self.systemAgentChatStore.model(for: self.appModel))"))
        #expect(rootTabs.contains(".onChange(of: self.appModel.openChatRequestID)"))
    }

    private func makeModel(
        accessState: IOSSystemAgentChatModel.AccessState = .ready,
        recorder: RequestRecorder,
        routeState: RouteState = RouteState()) -> IOSSystemAgentChatModel
    {
        IOSSystemAgentChatModel(
            accessState: accessState,
            routeIdentity: "gateway-a",
            captureRoute: { _ in
                IOSSystemAgentChatRouteLease(
                    route: nil,
                    request: { method, params, timeoutMs in
                        try await recorder.perform(method: method, params: params, timeoutMs: timeoutMs)
                    },
                    isCurrent: { await routeState.isCurrent() })
            })
    }

    private static func start(_ model: IOSSystemAgentChatModel) async {
        await model.startIfNeeded()?.value
    }

    private static func waitUntil(_ condition: @escaping () async -> Bool) async {
        for _ in 0..<100 {
            if await condition() { return }
            await Task.yield()
        }
        Issue.record("Timed out waiting for asynchronous condition")
    }

    private static func reply(
        _ reply: String,
        action: String = "reply",
        sensitive: Bool? = nil,
        agentID: String? = nil) -> Data
    {
        var result: [String: Any] = [
            "sessionId": "system-session",
            "reply": reply,
            "action": action,
        ]
        if let sensitive {
            result["sensitive"] = sensitive
        }
        if let agentID {
            result["agentId"] = agentID
        }
        guard let data = try? JSONSerialization.data(withJSONObject: result) else {
            preconditionFailure("System-agent reply fixture must encode")
        }
        return data
    }

    private static func questionReply() -> Data {
        let value: [String: Any] = [
            "sessionId": "system-session",
            "reply": "Choose a connection",
            "action": "reply",
            "question": [
                "id": "connection",
                "header": "Connection",
                "question": "How should OpenClaw connect?",
                "options": [
                    [
                        "label": "Use Tailscale",
                        "description": "Private network",
                        "recommended": true,
                        "reply": "tailscale",
                    ],
                    [
                        "label": "Use LAN",
                        "description": "Local network",
                        "recommended": false,
                        "reply": "lan",
                    ],
                ],
                "isOther": false,
            ],
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: value) else {
            preconditionFailure("System-agent question fixture must encode")
        }
        return data
    }
}
