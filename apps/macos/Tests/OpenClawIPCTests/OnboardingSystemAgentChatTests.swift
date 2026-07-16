import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

private actor SystemAgentGatewayConfig {
    private var token = "a"

    func snapshotToken() -> String {
        self.token
    }

    func setToken(_ token: String) {
        self.token = token
    }
}

private actor SystemAgentSessionRecorder {
    private var sessionIDs: [String] = []

    func record(_ sessionID: String) {
        self.sessionIDs.append(sessionID)
    }

    func snapshot() -> [String] {
        self.sessionIDs
    }
}

private actor SystemAgentMethodRecorder {
    private var methods: [String] = []

    func record(_ method: String) {
        self.methods.append(method)
    }

    func snapshot() -> [String] {
        self.methods
    }
}

private actor SystemAgentRequestGate {
    private var consumed = false
    private var released = false
    private var continuation: CheckedContinuation<Void, Never>?

    func waitIfFirst() async -> Bool {
        guard !self.consumed else { return false }
        self.consumed = true
        if !self.released {
            await withCheckedContinuation { continuation in
                self.continuation = continuation
            }
        }
        return true
    }

    func release() {
        self.released = true
        self.continuation?.resume()
        self.continuation = nil
    }
}

private func systemAgentSessionID(from message: URLSessionWebSocketTask.Message) -> String? {
    let data: Data? = switch message {
    case let .data(data): data
    case let .string(string): string.data(using: .utf8)
    @unknown default: nil
    }
    guard let data,
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          object["method"] as? String == "openclaw.chat",
          let params = object["params"] as? [String: Any]
    else { return nil }
    return params["sessionId"] as? String
}

private func systemAgentRequestMethod(from message: URLSessionWebSocketTask.Message) -> String? {
    let data: Data? = switch message {
    case let .data(data): data
    case let .string(string): string.data(using: .utf8)
    @unknown default: nil
    }
    guard let data,
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    return object["method"] as? String
}

private func respondToSystemAgentHealth(
    task: GatewayTestWebSocketTask,
    id: String,
    method: String?) -> Bool
{
    guard method == "health" else { return false }
    task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
    return true
}

private func systemAgentResponse(id: String, action: String = "none") -> Data {
    Data(
        """
        {
          "type": "res",
          "id": "\(id)",
          "ok": true,
          "payload": {
            "sessionId": "test-session",
            "reply": "ready",
            "action": "\(action)",
            "sensitive": false
          }
        }
        """.utf8)
}

private func verifiedInferenceResponse(id: String) -> Data {
    Data(
        """
        {
          "type": "res",
          "id": "\(id)",
          "ok": true,
          "payload": {
            "ok": true,
            "modelRef": "openai/gpt-5.5",
            "latencyMs": 42
          }
        }
        """.utf8)
}

private func configuredAgentsResponse(id: String) -> Data {
    Data(
        """
        {
          "type": "res",
          "id": "\(id)",
          "ok": true,
          "payload": {
            "defaultId": "main",
            "mainKey": "main",
            "scope": "per-sender",
            "agents": [{
              "id": "main",
              "model": { "primary": "openai/gpt-5.5" }
            }]
          }
        }
        """.utf8)
}

private func transientVerificationErrorResponse(id: String) -> Data {
    Data(
        """
        {
          "type": "res",
          "id": "\(id)",
          "ok": false,
          "error": { "code": "UNAVAILABLE", "message": "temporary disconnect" }
        }
        """.utf8)
}

@Suite(.serialized)
@MainActor
struct OnboardingSystemAgentChatTests {
    @Test func `onboarding wires OpenClaw agent handoff`() {
        let state = AppState(preview: true)
        state.connectionMode = .local
        let view = OnboardingView(state: state)

        view.prepareSystemAgentHandoff()

        #expect(view.systemAgentState.chat.onAgentHandoff != nil)
    }

    @Test func `relaunch with pending inference resumes OpenClaw`() async throws {
        let suiteName = "OnboardingPendingInferenceResumeTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let methods = SystemAgentMethodRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                let method = systemAgentRequestMethod(from: message)
                if let method {
                    await methods.record(method)
                }
                if respondToSystemAgentHealth(task: task, id: id, method: method) { return }
                switch method {
                case "openclaw.setup.verify":
                    task.emitReceiveSuccess(.data(verifiedInferenceResponse(id: id)))
                case "openclaw.chat":
                    task.emitReceiveSuccess(.data(systemAgentResponse(id: id)))
                default:
                    break
                }
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let appState = AppState(preview: true)
        appState.connectionMode = .remote
        appState.remoteTransport = .direct
        appState.remoteUrl = "ws://example.invalid"
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            systemAgentDefaults: defaults,
            aiSetupRouteIdentityProvider: { "remote:direct:example.invalid" })
        view.systemAgentState.chat = SystemAgentOnboardingChatModel(gateway: gateway)

        let task = view.resumePendingSystemAgent(modelRef: "openai/gpt-5.5")
        await task.value

        #expect(view.aiSetup.connectedModelRef == "openai/gpt-5.5")
        #expect(view.systemAgentState.isPresented)
        #expect(view.systemAgentState.chat.messages.map(\.text) == ["ready"])

        let repeatedResume = view.resumePendingSystemAgent(modelRef: "openai/gpt-5.5")
        await repeatedResume.value

        #expect(view.aiSetup.connectedModelRef == "openai/gpt-5.5")
        #expect(await methods.snapshot() == [
            "health",
            "openclaw.setup.verify",
            "openclaw.chat",
        ])
    }

    @Test func `pending verification retry schedules deadline and stays read only`() async throws {
        let suiteName = "OnboardingPendingVerificationRetryTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let methods = SystemAgentMethodRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message),
                      let method = systemAgentRequestMethod(from: message)
                else { return }
                await methods.record(method)
                if respondToSystemAgentHealth(task: task, id: id, method: method) { return }
                switch method {
                case "openclaw.setup.verify":
                    let priorVerifications = await methods.snapshot().filter {
                        $0 == "openclaw.setup.verify"
                    }.count
                    let response = priorVerifications == 1
                        ? transientVerificationErrorResponse(id: id)
                        : verifiedInferenceResponse(id: id)
                    task.emitReceiveSuccess(.data(response))
                case "openclaw.chat":
                    task.emitReceiveSuccess(.data(systemAgentResponse(id: id)))
                default:
                    break
                }
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: "local",
            defaults: defaults)
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            systemAgentDefaults: defaults,
            aiSetupRouteIdentityProvider: { "local" })
        view.systemAgentState.chat = SystemAgentOnboardingChatModel(gateway: gateway)

        await view.resumePendingSystemAgent(modelRef: "openai/gpt-5.5").value
        #expect(!view.systemAgentState.isPresented)

        var scheduledDeadlines: [(deadline: Date, routeIdentity: String)] = []
        view.aiSetup.onPendingActivationDeadline = { deadline, routeIdentity in
            scheduledDeadlines.append((deadline, routeIdentity))
        }
        view.aiSetup.retryFromScratch()
        for _ in 0..<200 {
            if case .verified = OnboardingSystemAgentResumeStore.pendingState(
                for: "local",
                defaults: defaults)
            {
                break
            }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }

        #expect(!view.aiSetup.connected)
        #expect(view.aiSetup.waitingForPendingActivationDeadline)
        #expect(!view.systemAgentState.isPresented)
        #expect(view.systemAgentState.chat.messages.isEmpty)
        #expect(scheduledDeadlines.count == 1)
        #expect(scheduledDeadlines.first?.routeIdentity == "local")
        if case let .verified(deadline) = OnboardingSystemAgentResumeStore.pendingState(
            for: "local",
            defaults: defaults)
        {
            #expect(scheduledDeadlines.first?.deadline == deadline)
        } else {
            Issue.record("expected verified activation lease")
        }
        view.aiSetup.retryFromScratch()
        #expect(scheduledDeadlines.count == 1)
        #expect(await methods.snapshot() == [
            "health",
            "openclaw.setup.verify",
            "health",
            "openclaw.setup.verify",
        ])
    }

    @Test func `superseded resume cannot present a replacement route chat`() async throws {
        let suiteName = "OnboardingSupersededResumeTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let gate = SystemAgentRequestGate()
        let methods = SystemAgentMethodRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message),
                      let method = systemAgentRequestMethod(from: message)
                else { return }
                await methods.record(method)
                if respondToSystemAgentHealth(task: task, id: id, method: method) { return }
                guard method == "openclaw.setup.verify" else { return }
                _ = await gate.waitIfFirst()
                task.emitReceiveSuccess(.data(verifiedInferenceResponse(id: id)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let appState = AppState(preview: true)
        appState.connectionMode = .remote
        appState.remoteTransport = .direct
        appState.remoteUrl = "ws://example.invalid"
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            systemAgentDefaults: defaults,
            aiSetupRouteIdentityProvider: { "remote:direct:example.invalid" })
        view.systemAgentState.chat = SystemAgentOnboardingChatModel(gateway: gateway)

        let staleResume = view.resumePendingSystemAgent(modelRef: "openai/gpt-5.5")
        for _ in 0..<200 {
            if await methods.snapshot() == ["health", "openclaw.setup.verify"] {
                break
            }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        view.resetGatewayBoundAIState()
        // Simulate a newer route reaching connected state without presenting
        // its chat. The stale wrapper must not infer success from this state.
        view.aiSetup.onConnected = nil
        view.aiSetup.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        view.aiSetup.acceptVerifiedPendingInference(modelRef: "openai/gpt-5.5")
        await gate.release()
        await staleResume.value

        #expect(view.aiSetup.connected)
        #expect(!view.systemAgentState.isPresented)
        #expect(view.systemAgentState.chat.messages.isEmpty)
    }

    @Test func `cold launch resumes a completed activation immediately`() async throws {
        let suiteName = "OnboardingColdPendingHandoffTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let methods = SystemAgentMethodRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message),
                      let method = systemAgentRequestMethod(from: message)
                else { return }
                await methods.record(method)
                if respondToSystemAgentHealth(task: task, id: id, method: method) { return }
                switch method {
                case "agents.list":
                    task.emitReceiveSuccess(.data(configuredAgentsResponse(id: id)))
                case "openclaw.setup.verify":
                    task.emitReceiveSuccess(.data(verifiedInferenceResponse(id: id)))
                case "openclaw.chat":
                    task.emitReceiveSuccess(.data(systemAgentResponse(id: id)))
                default:
                    break
                }
            })
        })
        let url = try #require(URL(string: "ws://localhost:18789"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let appState = AppState(preview: true)
        appState.connectionMode = .local
        let routeIdentity = OnboardingSystemAgentResumeStore.selectedRouteIdentity(state: appState)
        let route = try #require(await gateway.captureRoute())
        let activationOwner = try OnboardingSystemAgentResumeStore.ActivationOwner(
            id: "completed-before-relaunch",
            routeFingerprint: #require(route.activationOwnershipFingerprint))
        OnboardingSystemAgentResumeStore.markPending(
            routeIdentity: routeIdentity,
            activationOwner: activationOwner,
            defaults: defaults)
        OnboardingSystemAgentResumeStore.markCompleted(
            ifOwnedBy: routeIdentity,
            activationOwner: activationOwner,
            defaults: defaults)
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            systemAgentDefaults: defaults,
            aiSetupRouteIdentityProvider: { routeIdentity })
        view.systemAgentState.chat = SystemAgentOnboardingChatModel(gateway: gateway)
        let aiSetup = view.aiSetup
        let systemAgentState = view.systemAgentState

        let initialProbe = try #require(view.onboardingDidAppear())
        await initialProbe.value
        for _ in 0..<200 {
            if systemAgentState.chat.messages.map(\.text) == ["ready"] {
                break
            }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }

        #expect(aiSetup.connected)
        #expect(systemAgentState.isPresented)
        #expect(systemAgentState.chat.messages.map(\.text) == ["ready"])
        #expect(OnboardingSystemAgentResumeStore.pendingState(
            for: routeIdentity,
            defaults: defaults) == .completed)
        #expect(await methods.snapshot() == [
            "agents.list",
            "health",
            "openclaw.setup.verify",
            "openclaw.chat",
        ])
    }

    @Test func `fresh inference presents and starts OpenClaw immediately`() async throws {
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                task.emitReceiveSuccess(.data(systemAgentResponse(id: id)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let state = OnboardingSystemAgentChatState()
        state.chat = SystemAgentOnboardingChatModel(gateway: gateway)

        let task = state.presentAndStart()
        await task.value

        #expect(state.isPresented)
        #expect(state.chat.messages.map(\.text) == ["ready"])
        #expect(session.snapshotMakeCount() == 1)
        #expect(session.latestTask()?.snapshotSendCount() == 2)
    }

    @Test func `settings callback refreshes inference after assistant reply`() async throws {
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                task.emitReceiveSuccess(.data(systemAgentResponse(id: id)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let chat = SystemAgentOnboardingChatModel(gateway: gateway)
        var refreshCount = 0
        SystemAgentSettings.configureChatCallbacks(
            for: chat,
            onReplyReceived: { refreshCount += 1 })

        await chat.startIfNeeded()

        #expect(chat.messages.map(\.text) == ["ready"])
        #expect(refreshCount == 1)
    }

    @Test func `gateway reset invalidates queued send and restart tasks`() async throws {
        let session = GatewayTestWebSocketSession()
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let chat = SystemAgentOnboardingChatModel(gateway: gateway)
        let state = OnboardingSystemAgentChatState()
        state.chat = chat
        var replyCount = 0
        var handoffCount = 0
        chat.onReplyReceived = { replyCount += 1 }
        chat.onAgentHandoff = { handoffCount += 1 }
        chat.input = "route-bound secret"
        state.isPresented = true

        let sendTask = try #require(chat.send())
        let restartTask = try #require(chat.restartAfterError())
        state.resetForGatewayChange()
        await sendTask.value
        await restartTask.value

        #expect(session.snapshotMakeCount() == 0)
        #expect(chat.messages.isEmpty)
        #expect(replyCount == 0)
        #expect(handoffCount == 0)
        #expect(!state.isPresented)
        #expect(state.chat !== chat)
        #expect(chat.send() == nil)
        #expect(chat.restartAfterError() == nil)
    }

    @Test func `chat session stays bound to its original gateway route`() async throws {
        let config = SystemAgentGatewayConfig()
        let recorder = SystemAgentSessionRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                if let sessionID = systemAgentSessionID(from: message) {
                    await recorder.record(sessionID)
                }
                task.emitReceiveSuccess(.data(systemAgentResponse(id: id)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: {
                let token = await config.snapshotToken()
                return (url: url, token: token, password: nil)
            },
            sessionBox: WebSocketSessionBox(session: session))
        let chat = SystemAgentOnboardingChatModel(gateway: gateway)

        await chat.startIfNeeded()
        #expect(chat.messages.map(\.text) == ["ready"])
        #expect(session.snapshotMakeCount() == 1)
        #expect(session.latestTask()?.snapshotSendCount() == 2)
        let routeASessionIDs = await recorder.snapshot()
        #expect(routeASessionIDs.count == 1)
        let routeASessionID = try #require(routeASessionIDs.first)

        await config.setToken("b")
        chat.input = "must stay on route a"
        let sendTask = try #require(chat.send())
        await sendTask.value

        #expect(session.snapshotMakeCount() == 1)
        #expect(session.latestTask()?.snapshotSendCount() == 2)
        #expect(chat.messages.map(\.text) == ["ready", "must stay on route a"])
        #expect(chat.errorMessage == "The Gateway connection changed. Restart OpenClaw to reconnect.")
        #expect(await recorder.snapshot() == [routeASessionID])

        let restartTask = try #require(chat.restartAfterError())
        await restartTask.value

        #expect(session.snapshotMakeCount() == 2)
        #expect(session.latestTask()?.snapshotSendCount() == 2)
        #expect(chat.messages.map(\.text) == ["ready"])
        #expect(chat.errorMessage == nil)
        let sessionIDs = await recorder.snapshot()
        #expect(sessionIDs.count == 2)
        #expect(sessionIDs.first == routeASessionID)
        #expect(sessionIDs.last != routeASessionID)
    }

    @Test func `route change while reply is in flight discards reply and action`() async throws {
        let config = SystemAgentGatewayConfig()
        let requestGate = SystemAgentRequestGate()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                _ = await requestGate.waitIfFirst()
                task.emitReceiveSuccess(.data(systemAgentResponse(id: id, action: "open-agent")))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: {
                let token = await config.snapshotToken()
                return (url: url, token: token, password: nil)
            },
            sessionBox: WebSocketSessionBox(session: session))
        let chat = SystemAgentOnboardingChatModel(gateway: gateway)
        var replyCount = 0
        var handoffCount = 0
        chat.onReplyReceived = { replyCount += 1 }
        chat.onAgentHandoff = { handoffCount += 1 }

        let startTask = Task { await chat.startIfNeeded() }
        var requestStarted = false
        for _ in 0..<1000 {
            if session.latestTask()?.snapshotSendCount() == 2 {
                requestStarted = true
                break
            }
            await Task.yield()
        }
        try #require(requestStarted)
        await config.setToken("b")
        await requestGate.release()
        await startTask.value

        #expect(chat.messages.isEmpty)
        #expect(replyCount == 0)
        #expect(handoffCount == 0)
        #expect(chat.errorMessage == "The Gateway connection changed. Restart OpenClaw to reconnect.")
    }

    @Test func `cancelled initial request exposes restart and recovers`() async throws {
        let requestGate = SystemAgentRequestGate()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                if sendIndex == 1, await requestGate.waitIfFirst() {
                    throw CancellationError()
                }
                task.emitReceiveSuccess(.data(systemAgentResponse(id: id)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let chat = SystemAgentOnboardingChatModel(gateway: gateway)

        let startTask = Task { await chat.startIfNeeded() }
        var requestStarted = false
        for _ in 0..<1000 {
            if session.latestTask()?.snapshotSendCount() == 2 {
                requestStarted = true
                break
            }
            await Task.yield()
        }
        try #require(requestStarted)
        startTask.cancel()
        await requestGate.release()
        await startTask.value

        #expect(chat.errorMessage == "OpenClaw was interrupted. Restart to try again.")
        #expect(!chat.isSending)
        #expect(chat.messages.isEmpty)

        let restartTask = try #require(chat.restartAfterError())
        await restartTask.value

        #expect(chat.errorMessage == nil)
        #expect(chat.messages.map(\.text) == ["ready"])
        #expect(session.snapshotMakeCount() == 1)
        #expect(session.latestTask()?.snapshotSendCount() == 3)
    }
}
