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

private actor OnboardingProbeGate {
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
    private let gate = OnboardingProbeGate()

    init(blockedRead: Int) {
        self.blockedRead = blockedRead
    }

    func snapshotToken() async -> String {
        self.readCount += 1
        if self.readCount == self.blockedRead {
            await self.gate.wait()
        }
        return "route-a"
    }

    func waitUntilBlocked() async {
        await self.gate.waitUntilStarted()
    }

    func release() async {
        await self.gate.release()
    }
}

private actor OnboardingEndpointRevisionGate {
    private let stale: GatewayConnection.EndpointSnapshot
    private let current: GatewayConnection.EndpointSnapshot
    private var reads = 0
    private let gate = OnboardingProbeGate()

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
        await self.gate.wait()
        return self.stale
    }

    func waitUntilStaleReadStarted() async {
        await self.gate.waitUntilStarted()
    }

    func releaseStaleRead() async {
        await self.gate.release()
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
        #"{"type":"res","id":"\#(id)","ok":true,"payload":{"defaultId":"\#(defaultAgentID)","mainKey":"main","scope":"per-sender","agents":[\#(agentsJSON)]}}"#
            .utf8)
}

private func onboardingProbeErrorResponse(id: String) -> Data {
    Data(#"{"type":"res","id":"\#(id)","ok":false,"error":{"code":"UNAVAILABLE","message":"temporary failure"}}"#.utf8)
}

private enum OnboardingProbeReply: Sendable {
    case agents(defaultAgentID: String, model: String?)
    case error
    case failure
    case none

    static let configured = Self.agents(defaultAgentID: "main", model: "openai/gpt-5.5")
}

private func onboardingProbeTaskFactory(
    reply: OnboardingProbeReply = .configured,
    beforeReply: (@Sendable () async -> Void)? = nil) -> GatewayTestWebSocketSession.TaskFactory
{
    {
        GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
            guard sendIndex > 0 else { return }
            switch reply {
            case let .agents(defaultAgentID, model):
                guard let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                await beforeReply?()
                task.emitReceiveSuccess(.data(onboardingAgentsResponse(
                    id: id,
                    defaultAgentID: defaultAgentID,
                    model: model)))
            case .error:
                guard let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                await beforeReply?()
                task.emitReceiveSuccess(.data(onboardingProbeErrorResponse(id: id)))
            case .failure:
                await beforeReply?()
                task.emitReceiveFailure()
            case .none:
                break
            }
        })
    }
}

private func onboardingProbeAuthFailureTaskFactory() -> GatewayTestWebSocketSession.TaskFactory {
    {
        GatewayTestWebSocketTask(receiveHook: { task, receiveIndex in
            if receiveIndex == 0 {
                return .data(GatewayWebSocketTestSupport.connectChallengeData())
            }
            return .data(GatewayWebSocketTestSupport.connectAuthFailureData(
                id: task.snapshotConnectRequestID() ?? "connect",
                detailCode: GatewayConnectAuthDetailCode.authTokenMissing.rawValue))
        })
    }
}

@MainActor
private struct OnboardingProbeFixture {
    let session: GatewayTestWebSocketSession
    let probe: OnboardingConfiguredGatewayProbe
}

@MainActor
private func onboardingProbeFixture(
    url: URL,
    timeoutMs: Double = 15000,
    tokenProvider: @escaping @Sendable () async -> String? = { nil },
    reply: OnboardingProbeReply = .configured,
    beforeReply: (@Sendable () async -> Void)? = nil,
    taskFactory: GatewayTestWebSocketSession.TaskFactory? = nil) -> OnboardingProbeFixture
{
    let session = GatewayTestWebSocketSession(
        taskFactory: taskFactory ?? onboardingProbeTaskFactory(reply: reply, beforeReply: beforeReply))
    let gateway = GatewayConnection(
        configProvider: {
            await (url: url, token: tokenProvider(), password: nil)
        },
        sessionBox: WebSocketSessionBox(session: session))
    return OnboardingProbeFixture(
        session: session,
        probe: OnboardingConfiguredGatewayProbe(gateway: gateway, timeoutMs: timeoutMs))
}

@MainActor
private func onboardingProbeFixture(
    endpointProvider: @escaping GatewayConnection.EndpointProvider,
    reply: OnboardingProbeReply = .configured) -> OnboardingProbeFixture
{
    let session = GatewayTestWebSocketSession(taskFactory: onboardingProbeTaskFactory(reply: reply))
    // The production endpointProvider init reads the process-global persisted
    // identity store; mocked routes must stay off the operator's real state.
    let gateway = GatewayConnection(
        testEndpointProvider: endpointProvider,
        sessionBox: WebSocketSessionBox(session: session))
    return OnboardingProbeFixture(
        session: session,
        probe: OnboardingConfiguredGatewayProbe(gateway: gateway))
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
        let url = try #require(URL(string: "ws://example.invalid"))
        let fixture = onboardingProbeFixture(
            url: url,
            reply: .agents(defaultAgentID: "work", model: "openai/gpt-5.5"))
        let session = fixture.session
        let probe = fixture.probe

        #expect(await configuredModel(runOnboardingProbe(probe, connectionMode: .remote)) == "openai/gpt-5.5")
        #expect(session.snapshotMakeCount() == 1)
        #expect(session.latestTask()?.snapshotSendCount() == 2)
    }

    @Test func `gateway without a default agent model stays in onboarding`() async throws {
        let url = try #require(URL(string: "ws://example.invalid"))
        let probe = onboardingProbeFixture(
            url: url,
            reply: .agents(defaultAgentID: "main", model: nil)).probe

        #expect(await isMissing(runOnboardingProbe(probe, connectionMode: .local)))
    }

    @Test func `gateway with a blank default agent model stays in onboarding`() async throws {
        let url = try #require(URL(string: "ws://example.invalid"))
        let probe = onboardingProbeFixture(
            url: url,
            reply: .agents(defaultAgentID: "main", model: "   ")).probe

        #expect(await isMissing(runOnboardingProbe(probe, connectionMode: .local)))
    }

    @Test func `remote gateway auth failure stays classified`() async throws {
        let url = try #require(URL(string: "ws://example.invalid"))
        let fixture = onboardingProbeFixture(
            url: url,
            taskFactory: onboardingProbeAuthFailureTaskFactory())
        let session = fixture.session
        let probe = fixture.probe

        let outcome = await runOnboardingProbe(probe, connectionMode: .remote)

        #expect(outcome == .authIssue(.tokenRequired))
        #expect(session.latestTask()?.snapshotSendCount() == 1)
    }

    @Test func `current route read failure is unavailable rather than missing`() async throws {
        let url = try #require(URL(string: "ws://example.invalid"))
        let probe = onboardingProbeFixture(url: url, reply: .failure).probe

        let outcome = await runOnboardingProbe(probe, connectionMode: .remote)
        #expect({
            if case .unavailable = outcome {
                return true
            }
            return false
        }())
    }

    @Test func `current route timeout is unavailable rather than missing`() async throws {
        let url = try #require(URL(string: "ws://example.invalid"))
        let probe = onboardingProbeFixture(url: url, timeoutMs: 1, reply: .none).probe

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
        let gate = OnboardingProbeGate()
        let url = try #require(URL(string: "ws://example.invalid"))
        let probe = onboardingProbeFixture(
            url: url,
            tokenProvider: { await config.snapshotToken() },
            beforeReply: { await gate.wait() }).probe

        let attempt = probe.beginProbe()
        let result = Task { await probe.probe(connectionMode: .remote, attempt: attempt) }
        await gate.waitUntilStarted()
        await config.setToken("route-b")
        await gate.release()

        #expect(await result.value == .superseded)
    }

    @Test func `configured result remains bound to its captured effective route`() async throws {
        let config = OnboardingProbeGatewayConfig()
        let url = try #require(URL(string: "ws://example.invalid"))
        let probe = onboardingProbeFixture(
            url: url,
            tokenProvider: { await config.snapshotToken() }).probe
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
        let fixture = onboardingProbeFixture(endpointProvider: { await endpoint.snapshot() })
        let session = fixture.session
        let probe = fixture.probe

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
            testEndpointProvider: { await endpoints.snapshot() },
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
        let url = try #require(URL(string: "ws://example.invalid"))
        let fixture = onboardingProbeFixture(
            url: url,
            tokenProvider: { await configGate.snapshotToken() })
        let session = fixture.session
        let probe = fixture.probe

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
        let url = try #require(URL(string: "ws://example.invalid"))
        let fixture = onboardingProbeFixture(
            url: url,
            tokenProvider: { await configGate.snapshotToken() },
            reply: .error)
        let session = fixture.session
        let probe = fixture.probe

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
        let gate = OnboardingProbeGate()
        let url = try #require(URL(string: "ws://example.invalid"))
        let probe = onboardingProbeFixture(
            url: url,
            tokenProvider: { await config.snapshotToken() },
            reply: .failure,
            beforeReply: { await gate.wait() }).probe

        let attempt = probe.beginProbe()
        let result = Task { await probe.probe(connectionMode: .remote, attempt: attempt) }
        await gate.waitUntilStarted()
        await config.setToken("route-b")
        await gate.release()

        #expect(await result.value == .superseded)
    }

    @Test func `snapshot during active probe is delivered after probe completion`() async throws {
        let gate = OnboardingProbeGate()
        let url = try #require(URL(string: "ws://example.invalid"))
        let fixture = onboardingProbeFixture(url: url, beforeReply: { await gate.wait() })
        let probe = fixture.probe
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
        let gate = OnboardingProbeGate()
        let url = try #require(URL(string: "ws://example.invalid"))
        let probe = onboardingProbeFixture(url: url, beforeReply: { await gate.wait() }).probe

        let attempt = probe.beginProbe()
        let result = Task { await probe.probe(connectionMode: .remote, attempt: attempt) }
        await gate.waitUntilStarted()
        probe.invalidate()
        await gate.release()

        #expect(await result.value == .superseded)
    }

    @Test func `newer queued probe stays current when older task starts last`() async throws {
        let url = try #require(URL(string: "ws://example.invalid"))
        let probe = onboardingProbeFixture(url: url).probe

        let older = probe.beginProbe()
        let newer = probe.beginProbe()

        #expect(await probe.probe(connectionMode: .remote, attempt: older) == .superseded)
        #expect(await configuredModel(probe.probe(
            connectionMode: .remote,
            attempt: newer)) == "openai/gpt-5.5")
    }

    @Test func `invalidation before queued probe starts supersedes it`() async throws {
        let url = try #require(URL(string: "ws://example.invalid"))
        let probe = onboardingProbeFixture(url: url).probe
        let attempt = probe.beginProbe()

        probe.invalidate()

        #expect(await probe.probe(connectionMode: .remote, attempt: attempt) == .superseded)
    }
}
