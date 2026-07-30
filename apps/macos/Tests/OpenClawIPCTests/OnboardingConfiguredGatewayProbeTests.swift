import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

private actor OnboardingProbeGatewayConfig {
    private var token = "route-a"

    func snapshotToken() -> String {
        self.token
    }

    func setToken(_ token: String) {
        self.token = token
    }
}

private actor OnboardingProbeEndpoint {
    private let url: URL
    private var generation: UInt64 = 1

    init(url: URL) {
        self.url = url
    }

    func snapshot() -> GatewayConnection.EndpointSnapshot {
        GatewayConnection.EndpointSnapshot(
            config: (
                url: self.url,
                token: "route-\(self.generation)",
                password: nil),
            routeAuthority: self.generation,
            revision: self.generation)
    }

    func advance() {
        self.generation &+= 1
    }
}

private actor OnboardingProbeRequestGate {
    private var started = false
    private var released = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        self.started = true
        self.startWaiters.forEach { $0.resume() }
        self.startWaiters.removeAll()
        guard !self.released else { return }
        await withCheckedContinuation { continuation in
            self.releaseWaiters.append(continuation)
        }
    }

    func waitUntilStarted() async {
        guard !self.started else { return }
        await withCheckedContinuation { continuation in
            self.startWaiters.append(continuation)
        }
    }

    func release() {
        self.released = true
        self.releaseWaiters.forEach { $0.resume() }
        self.releaseWaiters.removeAll()
    }
}

private actor OnboardingProbeConfigReadGate {
    private let blockedRead: Int
    private var readCount = 0
    private var blocked = false
    private var released = false
    private var blockedWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    init(blockedRead: Int) {
        self.blockedRead = blockedRead
    }

    func snapshotToken() async -> String {
        self.readCount += 1
        if self.readCount == self.blockedRead {
            self.blocked = true
            self.blockedWaiters.forEach { $0.resume() }
            self.blockedWaiters.removeAll()
            if !self.released {
                await withCheckedContinuation { continuation in
                    self.releaseWaiters.append(continuation)
                }
            }
        }
        return "route-a"
    }

    func waitUntilBlocked() async {
        guard !self.blocked else { return }
        await withCheckedContinuation { continuation in
            self.blockedWaiters.append(continuation)
        }
    }

    func release() {
        self.released = true
        self.releaseWaiters.forEach { $0.resume() }
        self.releaseWaiters.removeAll()
    }
}

private actor OnboardingEndpointRevisionGate {
    private let stale: GatewayConnection.EndpointSnapshot
    private let current: GatewayConnection.EndpointSnapshot
    private var reads = 0
    private var staleReadStarted = false
    private var released = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    init(staleURL: URL, currentURL: URL) {
        self.stale = GatewayConnection.EndpointSnapshot(
            config: (staleURL, "stale-token", nil),
            routeAuthority: 1,
            revision: 1)
        self.current = GatewayConnection.EndpointSnapshot(
            config: (currentURL, "current-token", nil),
            routeAuthority: 2,
            revision: 2)
    }

    func snapshot() async -> GatewayConnection.EndpointSnapshot {
        self.reads += 1
        guard self.reads == 1 else { return self.current }
        self.staleReadStarted = true
        self.startWaiters.forEach { $0.resume() }
        self.startWaiters.removeAll()
        if !self.released {
            await withCheckedContinuation { continuation in
                self.releaseWaiters.append(continuation)
            }
        }
        return self.stale
    }

    func waitUntilStaleReadStarted() async {
        guard !self.staleReadStarted else { return }
        await withCheckedContinuation { continuation in
            self.startWaiters.append(continuation)
        }
    }

    func releaseStaleRead() {
        self.released = true
        self.releaseWaiters.forEach { $0.resume() }
        self.releaseWaiters.removeAll()
    }
}

private func onboardingAgentsResponse(
    id: String,
    defaultAgentID: String = "main",
    model: String? = "openai/gpt-5.5") -> Data
{
    let modelJSON = model.map { #", "model": { "primary": "\#($0)" }"# } ?? ""
    let agentsJSON = if defaultAgentID == "main" {
        #"{ "id": "main"\#(modelJSON) }"#
    } else {
        """
        { "id": "main", "model": { "primary": "anthropic/claude-opus-4-8" } },
        { "id": "\(defaultAgentID)"\(modelJSON) }
        """
    }
    return Data(
        """
        {
          "type": "res",
          "id": "\(id)",
          "ok": true,
          "payload": {
            "defaultId": "\(defaultAgentID)",
            "mainKey": "main",
            "scope": "per-sender",
            "agents": [
              \(agentsJSON)
            ]
          }
        }
        """.utf8)
}

private func onboardingProbeErrorResponse(id: String) -> Data {
    Data(
        """
        {
          "type": "res",
          "id": "\(id)",
          "ok": false,
          "error": { "code": "UNAVAILABLE", "message": "temporary failure" }
        }
        """.utf8)
}

@MainActor
private func runOnboardingProbe(
    _ probe: OnboardingConfiguredGatewayProbe,
    connectionMode: AppState.ConnectionMode) async -> OnboardingConfiguredGatewayProbe.Outcome
{
    let attempt = probe.beginProbe()
    return await probe.probe(connectionMode: connectionMode, attempt: attempt)
}

private func configuredModel(
    _ outcome: OnboardingConfiguredGatewayProbe.Outcome) -> String?
{
    guard case let .configured(modelRef, _) = outcome else { return nil }
    return modelRef
}

private func isMissing(_ outcome: OnboardingConfiguredGatewayProbe.Outcome) -> Bool {
    if case .missing = outcome {
        return true
    }
    return false
}

@Suite(.serialized)
@MainActor
struct OnboardingConfiguredGatewayProbeTests {
    @Test func `reachable gateway uses its configured default agent model`() async throws {
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                task.emitReceiveSuccess(.data(onboardingAgentsResponse(
                    id: id,
                    defaultAgentID: "work",
                    model: "openai/gpt-5.5")))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let probe = OnboardingConfiguredGatewayProbe(gateway: gateway)

        #expect(await configuredModel(runOnboardingProbe(probe, connectionMode: .remote)) == "openai/gpt-5.5")
        #expect(session.snapshotMakeCount() == 1)
        #expect(session.latestTask()?.snapshotSendCount() == 2)
    }

    @Test func `gateway without a default agent model stays in onboarding`() async throws {
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                task.emitReceiveSuccess(.data(onboardingAgentsResponse(id: id, model: nil)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let probe = OnboardingConfiguredGatewayProbe(gateway: gateway)

        #expect(await isMissing(runOnboardingProbe(probe, connectionMode: .local)))
    }

    @Test func `gateway with a blank default agent model stays in onboarding`() async throws {
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                task.emitReceiveSuccess(.data(onboardingAgentsResponse(id: id, model: "   ")))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let probe = OnboardingConfiguredGatewayProbe(gateway: gateway)

        #expect(await isMissing(runOnboardingProbe(probe, connectionMode: .local)))
    }

    @Test func `current route read failure is unavailable rather than missing`() async throws {
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, _, sendIndex in
                guard sendIndex > 0 else { return }
                task.emitReceiveFailure(URLError(.networkConnectionLost))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let probe = OnboardingConfiguredGatewayProbe(gateway: gateway)

        let outcome = await runOnboardingProbe(probe, connectionMode: .remote)
        #expect({
            if case .unavailable = outcome {
                return true
            }
            return false
        }())
    }

    @Test func `current route timeout is unavailable rather than missing`() async throws {
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { _, _, _ in })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let probe = OnboardingConfiguredGatewayProbe(gateway: gateway, timeoutMs: 1)

        let outcome = await runOnboardingProbe(probe, connectionMode: .remote)
        #expect({
            if case .unavailable = outcome {
                return true
            }
            return false
        }())
    }

    @Test func `route replacement supersedes an in-flight configured model result`() async throws {
        let config = OnboardingProbeGatewayConfig()
        let gate = OnboardingProbeRequestGate()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                await gate.wait()
                task.emitReceiveSuccess(.data(onboardingAgentsResponse(id: id)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: {
                let token = await config.snapshotToken()
                return (url: url, token: token, password: nil)
            },
            sessionBox: WebSocketSessionBox(session: session))
        let probe = OnboardingConfiguredGatewayProbe(gateway: gateway)

        let attempt = probe.beginProbe()
        let result = Task { await probe.probe(connectionMode: .remote, attempt: attempt) }
        await gate.waitUntilStarted()
        await config.setToken("route-b")
        await gate.release()

        #expect(await result.value == .superseded)
    }

    @Test func `configured result remains bound to its captured effective route`() async throws {
        let config = OnboardingProbeGatewayConfig()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                task.emitReceiveSuccess(.data(onboardingAgentsResponse(id: id)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: {
                let token = await config.snapshotToken()
                return (url: url, token: token, password: nil)
            },
            sessionBox: WebSocketSessionBox(session: session))
        let probe = OnboardingConfiguredGatewayProbe(gateway: gateway)
        let attempt = probe.beginProbe()
        let outcome = await probe.probe(
            connectionMode: .remote,
            attempt: attempt,
            routeIdentity: "remote:id:gateway-a")
        guard case let .configured(_, route) = outcome else {
            Issue.record("expected configured route")
            return
        }

        #expect(route.identity == "remote:id:gateway-a")
        #expect(await probe.isCurrent(route))
        await config.setToken("route-b")
        let staleRouteIsCurrent = await probe.isCurrent(route)
        #expect(!staleRouteIsCurrent)
    }

    @Test func `ssh gateway replacement cannot reuse same loopback websocket`() async throws {
        let url = try #require(URL(string: "ws://127.0.0.1:18789"))
        let endpoint = OnboardingProbeEndpoint(url: url)
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                task.emitReceiveSuccess(.data(onboardingAgentsResponse(id: id)))
            })
        })
        let gateway = GatewayConnection(
            endpointProvider: { await endpoint.snapshot() },
            sessionBox: WebSocketSessionBox(session: session))
        let probe = OnboardingConfiguredGatewayProbe(gateway: gateway)

        let firstAttempt = probe.beginProbe()
        let first = await probe.probe(
            connectionMode: .remote,
            attempt: firstAttempt,
            routeIdentity: "remote:id:gateway-a")
        guard case let .configured(_, firstRoute) = first else {
            Issue.record("expected first configured route")
            return
        }

        await endpoint.advance()
        let secondAttempt = probe.beginProbe()
        let second = await probe.probe(
            connectionMode: .remote,
            attempt: secondAttempt,
            routeIdentity: "remote:id:gateway-b")
        guard case let .configured(_, secondRoute) = second else {
            Issue.record("expected replacement configured route")
            return
        }

        let firstRouteIsCurrent = await probe.isCurrent(firstRoute)
        #expect(session.snapshotMakeCount() == 2)
        #expect(session.snapshotCancelCount() == 1)
        #expect(!firstRouteIsCurrent)
        #expect(await probe.isCurrent(secondRoute))
        #expect(secondRoute.identity == "remote:id:gateway-b")
    }

    @Test func `delayed endpoint snapshot cannot replace a newer revision`() async throws {
        let staleURL = try #require(URL(string: "ws://stale.example.invalid"))
        let currentURL = try #require(URL(string: "ws://current.example.invalid"))
        let endpoints = OnboardingEndpointRevisionGate(staleURL: staleURL, currentURL: currentURL)
        let gateway = GatewayConnection(
            endpointProvider: { await endpoints.snapshot() },
            sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask()
            })))

        let staleCapture = Task { await gateway.captureRoute() }
        await endpoints.waitUntilStaleReadStarted()
        let currentRoute = await gateway.captureRoute()
        await endpoints.releaseStaleRead()
        let staleRoute = await staleCapture.value

        #expect(currentRoute != nil)
        #expect(staleRoute == nil)
        #expect(await gateway._test_configuredURL() == currentURL)
    }

    @Test func `invalidation during final success route validation supersedes result`() async throws {
        let configGate = OnboardingProbeConfigReadGate(blockedRead: 4)
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                task.emitReceiveSuccess(.data(onboardingAgentsResponse(id: id)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: {
                let token = await configGate.snapshotToken()
                return (url: url, token: token, password: nil)
            },
            sessionBox: WebSocketSessionBox(session: session))
        let probe = OnboardingConfiguredGatewayProbe(gateway: gateway)

        let attempt = probe.beginProbe()
        let result = Task { await probe.probe(connectionMode: .remote, attempt: attempt) }
        await configGate.waitUntilBlocked()
        probe.invalidate()
        await configGate.release()

        #expect(await result.value == .superseded)
        #expect(session.latestTask()?.snapshotSendCount() == 2)
    }

    @Test func `invalidation during final error route validation supersedes result`() async throws {
        let configGate = OnboardingProbeConfigReadGate(blockedRead: 3)
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                task.emitReceiveSuccess(.data(onboardingProbeErrorResponse(id: id)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: {
                let token = await configGate.snapshotToken()
                return (url: url, token: token, password: nil)
            },
            sessionBox: WebSocketSessionBox(session: session))
        let probe = OnboardingConfiguredGatewayProbe(gateway: gateway)

        let attempt = probe.beginProbe()
        let result = Task { await probe.probe(connectionMode: .remote, attempt: attempt) }
        await configGate.waitUntilBlocked()
        probe.invalidate()
        await configGate.release()

        #expect(await result.value == .superseded)
        #expect(session.latestTask()?.snapshotSendCount() == 2)
    }

    @Test func `route replacement supersedes an in-flight probe failure`() async throws {
        let config = OnboardingProbeGatewayConfig()
        let gate = OnboardingProbeRequestGate()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, _, sendIndex in
                guard sendIndex > 0 else { return }
                await gate.wait()
                task.emitReceiveFailure()
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: {
                let token = await config.snapshotToken()
                return (url: url, token: token, password: nil)
            },
            sessionBox: WebSocketSessionBox(session: session))
        let probe = OnboardingConfiguredGatewayProbe(gateway: gateway)

        let attempt = probe.beginProbe()
        let result = Task { await probe.probe(connectionMode: .remote, attempt: attempt) }
        await gate.waitUntilStarted()
        await config.setToken("route-b")
        await gate.release()

        #expect(await result.value == .superseded)
    }

    @Test func `snapshot during active probe is delivered after probe completion`() async throws {
        let gate = OnboardingProbeRequestGate()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                await gate.wait()
                task.emitReceiveSuccess(.data(onboardingAgentsResponse(id: id)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let probe = OnboardingConfiguredGatewayProbe(gateway: gateway)
        var reconnectCount = 0
        let reconnectConsumer = Task {
            await probe.consumeReconnects { reconnectCount += 1 }
        }
        defer { reconnectConsumer.cancel() }
        for _ in 0..<20 {
            await Task.yield()
        }

        let attempt = probe.beginProbe()
        let result = Task { await probe.probe(connectionMode: .remote, attempt: attempt) }
        await gate.waitUntilStarted()
        #expect(reconnectCount == 0)
        await gate.release()
        #expect(await configuredModel(result.value) == "openai/gpt-5.5")
        for _ in 0..<100 {
            if reconnectCount > 0 {
                break
            }
            await Task.yield()
        }

        #expect(reconnectCount == 1)
    }

    @Test func `invalidated onboarding probe cannot complete the replacement selection`() async throws {
        let gate = OnboardingProbeRequestGate()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                await gate.wait()
                task.emitReceiveSuccess(.data(onboardingAgentsResponse(id: id)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let probe = OnboardingConfiguredGatewayProbe(gateway: gateway)

        let attempt = probe.beginProbe()
        let result = Task { await probe.probe(connectionMode: .remote, attempt: attempt) }
        await gate.waitUntilStarted()
        probe.invalidate()
        await gate.release()

        #expect(await result.value == .superseded)
    }

    @Test func `newer queued probe stays current when older task starts last`() async throws {
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                task.emitReceiveSuccess(.data(onboardingAgentsResponse(id: id)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let probe = OnboardingConfiguredGatewayProbe(gateway: gateway)

        let older = probe.beginProbe()
        let newer = probe.beginProbe()

        #expect(await probe.probe(connectionMode: .remote, attempt: older) == .superseded)
        #expect(await configuredModel(probe.probe(
            connectionMode: .remote,
            attempt: newer)) == "openai/gpt-5.5")
    }

    @Test func `invalidation before queued probe starts supersedes it`() async throws {
        let url = try #require(URL(string: "ws://example.invalid"))
        let gateway = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession()))
        let probe = OnboardingConfiguredGatewayProbe(gateway: gateway)
        let attempt = probe.beginProbe()

        probe.invalidate()

        #expect(await probe.probe(connectionMode: .remote, attempt: attempt) == .superseded)
    }
}
