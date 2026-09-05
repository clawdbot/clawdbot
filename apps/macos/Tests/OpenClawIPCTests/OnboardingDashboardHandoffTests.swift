import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

private actor OnboardingMethodRecorder {
    private var methods: [String] = []

    func record(_ method: String) {
        self.methods.append(method)
    }

    func snapshot() -> [String] {
        self.methods
    }
}

private actor OnboardingRequestGate {
    private var released = false
    private var continuation: CheckedContinuation<Void, Never>?

    func wait() async {
        if !self.released {
            await withCheckedContinuation { continuation in
                self.continuation = continuation
            }
        }
    }

    func release() {
        self.released = true
        self.continuation?.resume()
        self.continuation = nil
    }
}

private func onboardingRequestMethod(from message: URLSessionWebSocketTask.Message) -> String? {
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

private func respondToOnboardingHealth(
    task: GatewayTestWebSocketTask,
    id: String,
    method: String?) -> Bool
{
    guard method == "health" else { return false }
    task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
    return true
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
struct OnboardingDashboardHandoffTests {
    @Test func `fresh inference connection finishes onboarding once`() {
        let state = AppState(preview: true)
        state.connectionMode = .local
        var handoffs: [OnboardingDashboardHandoff] = []
        let view = OnboardingView(
            state: state,
            dashboardHandoffOpener: { handoffs.append($0) })

        view.prepareSystemAgentHandoff()
        view.aiSetup.onConnected?()

        #expect(view.finishState.didFinish)
        // Fresh connections own the remaining first-run steps via the custodian.
        #expect(handoffs == [.custodianOnboarding])
        #expect(!view.finish())
        #expect(handoffs == [.custodianOnboarding])
    }

    @Test(arguments: [false, true])
    func `first run effective model is live verified before handoff`(receiptDuringVerification: Bool) async throws {
        let suiteName = "OnboardingFirstRunEffectiveModelTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let methods = OnboardingMethodRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message),
                      let method = onboardingRequestMethod(from: message)
                else { return }
                await methods.record(method)
                if respondToOnboardingHealth(task: task, id: id, method: method) { return }
                switch method {
                case "agents.list":
                    task.emitReceiveSuccess(.data(configuredAgentsResponse(id: id)))
                case "openclaw.setup.verify":
                    if receiptDuringVerification {
                        let callbackDefaults = try #require(UserDefaults(suiteName: suiteName))
                        // An expired ownerless marker can arrive during an existing-model probe.
                        // Completing it does not turn that probe into a fresh activation.
                        OnboardingSystemAgentResumeStore.markPending(
                            routeIdentity: "local", activationTimeoutMs: 0,
                            defaults: callbackDefaults, now: Date(timeIntervalSinceNow: -10))
                    }
                    task.emitReceiveSuccess(.data(verifiedInferenceResponse(id: id)))
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
        var handoffs: [OnboardingDashboardHandoff] = []
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            systemAgentDefaults: defaults,
            aiSetupRouteIdentityProvider: { "local" },
            dashboardHandoffOpener: { handoffs.append($0) })

        let initialProbe = try #require(view.onboardingDidAppear())
        await initialProbe.value
        for _ in 0..<200 {
            if view.aiSetup.connected {
                break
            }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }

        #expect(view.aiSetup.connected)
        #expect(view.finishState.didFinish)
        // A live-verified pre-existing setup reopens the normal dashboard.
        #expect(handoffs == [.dashboard])
        #expect(OnboardingSystemAgentResumeStore.pendingState(for: "local", defaults: defaults) == .none)
        #expect(await methods.snapshot() == [
            "agents.list",
            "health",
            "openclaw.setup.verify",
        ])
    }

    @Test func `relaunch with pending inference resumes OpenClaw`() async throws {
        let suiteName = "OnboardingPendingInferenceResumeTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let methods = OnboardingMethodRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                let method = onboardingRequestMethod(from: message)
                if let method {
                    await methods.record(method)
                }
                if respondToOnboardingHealth(task: task, id: id, method: method) { return }
                switch method {
                case "openclaw.setup.verify":
                    task.emitReceiveSuccess(.data(verifiedInferenceResponse(id: id)))
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
        var handoffs: [OnboardingDashboardHandoff] = []
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            systemAgentDefaults: defaults,
            aiSetupRouteIdentityProvider: { "remote:direct:example.invalid" },
            dashboardHandoffOpener: { handoffs.append($0) })

        let task = view.resumePendingSystemAgent(modelRef: "openai/gpt-5.5")
        await task.value

        #expect(view.aiSetup.connected)
        #expect(view.aiSetup.selectedKind == "existing-model")
        #expect(view.finishState.didFinish)
        #expect(handoffs == [.dashboard])
        #expect(!view.finish())

        let repeatedResume = view.resumePendingSystemAgent(modelRef: "openai/gpt-5.5")
        await repeatedResume.value

        #expect(view.aiSetup.connected)
        #expect(view.aiSetup.selectedKind == "existing-model")
        #expect(handoffs == [.dashboard])
        #expect(await methods.snapshot() == [
            "health",
            "openclaw.setup.verify",
        ])
    }

    @Test func `pending verification retry schedules deadline and stays read only`() async throws {
        let suiteName = "OnboardingPendingVerificationRetryTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let methods = OnboardingMethodRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message),
                      let method = onboardingRequestMethod(from: message)
                else { return }
                await methods.record(method)
                if respondToOnboardingHealth(task: task, id: id, method: method) { return }
                switch method {
                case "openclaw.setup.verify":
                    let priorVerifications = await methods.snapshot().filter {
                        $0 == "openclaw.setup.verify"
                    }.count
                    let response = priorVerifications == 1
                        ? transientVerificationErrorResponse(id: id)
                        : verifiedInferenceResponse(id: id)
                    task.emitReceiveSuccess(.data(response))
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

        await view.resumePendingSystemAgent(modelRef: "openai/gpt-5.5").value

        var scheduledDeadlines: [(deadline: Date, routeIdentity: String)] = []
        view.aiSetup.onPendingActivationDeadline = { deadline, routeIdentity in
            scheduledDeadlines.append((deadline, routeIdentity))
        }
        view.aiSetup.retryFromScratch()
        // Verification publishes its receipt before the retry continuation schedules recovery.
        for _ in 0..<200 {
            if !scheduledDeadlines.isEmpty {
                break
            }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }

        #expect(!view.aiSetup.connected)
        #expect(view.aiSetup.waitingForPendingActivationDeadline)
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

    @Test func `superseded resume cannot finish a replacement route handoff`() async throws {
        let suiteName = "OnboardingSupersededResumeTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let gate = OnboardingRequestGate()
        let methods = OnboardingMethodRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message),
                      let method = onboardingRequestMethod(from: message)
                else { return }
                await methods.record(method)
                if respondToOnboardingHealth(task: task, id: id, method: method) { return }
                guard method == "openclaw.setup.verify" else { return }
                await gate.wait()
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
        var dashboardOpenCount = 0
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            systemAgentDefaults: defaults,
            aiSetupRouteIdentityProvider: { "remote:direct:example.invalid" },
            dashboardHandoffOpener: { _ in dashboardOpenCount += 1 })

        let staleResume = view.resumePendingSystemAgent(modelRef: "openai/gpt-5.5")
        for _ in 0..<200 {
            if await methods.snapshot() == ["health", "openclaw.setup.verify"] {
                break
            }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        view.resetGatewayBoundAIState()
        // Simulate a newer route reaching connected state without handing off.
        // The stale wrapper must not infer success from this state.
        view.aiSetup.onConnected = nil
        view.aiSetup.resumeConfiguredInference(modelRef: "openai/gpt-5.5")
        view.aiSetup.acceptVerifiedPendingInference(modelRef: "openai/gpt-5.5")
        await gate.release()
        await staleResume.value

        #expect(view.aiSetup.connected)
        #expect(!view.finishState.didFinish)
        #expect(dashboardOpenCount == 0)
        #expect(await methods.snapshot() == ["health", "openclaw.setup.verify"])
    }

    @Test func `cold launch resumes a completed activation immediately`() async throws {
        let suiteName = "OnboardingColdPendingHandoffTests-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let methods = OnboardingMethodRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message),
                      let method = onboardingRequestMethod(from: message)
                else { return }
                await methods.record(method)
                if respondToOnboardingHealth(task: task, id: id, method: method) { return }
                switch method {
                case "agents.list":
                    task.emitReceiveSuccess(.data(configuredAgentsResponse(id: id)))
                case "openclaw.setup.verify":
                    task.emitReceiveSuccess(.data(verifiedInferenceResponse(id: id)))
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
        var handoffs: [OnboardingDashboardHandoff] = []
        let view = OnboardingView(
            state: appState,
            aiSetupGateway: gateway,
            systemAgentDefaults: defaults,
            aiSetupRouteIdentityProvider: { routeIdentity },
            dashboardHandoffOpener: { handoffs.append($0) })
        let aiSetup = view.aiSetup

        let initialProbe = try #require(view.onboardingDidAppear())
        await initialProbe.value
        for _ in 0..<200 {
            if aiSetup.connected {
                break
            }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }

        #expect(aiSetup.connected)
        #expect(view.finishState.didFinish)
        #expect(handoffs == [.custodianOnboarding])
        #expect(OnboardingSystemAgentResumeStore.pendingState(
            for: routeIdentity,
            defaults: defaults) == .none)
        #expect(await methods.snapshot() == [
            "agents.list",
            "health",
            "openclaw.setup.verify",
        ])
    }
}
