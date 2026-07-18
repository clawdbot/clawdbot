import Foundation
import OpenClawChatUI
import OpenClawProtocol
import Testing
@testable import OpenClaw
@testable import OpenClawKit
@testable import OpenClawMacCLI

private func makeGatewayGenerationSnapshot(version: String) -> HelloOk {
    HelloOk(
        type: "hello-ok",
        _protocol: 3,
        server: ["version": OpenClawProtocol.AnyCodable(version)],
        features: [:],
        snapshot: Snapshot(
            presence: [],
            health: OpenClawProtocol.AnyCodable([String: OpenClawProtocol.AnyCodable]()),
            stateversion: StateVersion(presence: 0, health: 0),
            uptimems: 0,
            configpath: nil,
            statedir: nil,
            sessiondefaults: nil,
            authmode: nil,
            updateavailable: nil
        ),
        controluitabs: nil,
        pluginsurfaceurls: nil,
        auth: [:],
        policy: [:]
    )
}

private func gatewayGenerationSnapshotVersion(_ push: GatewayPush?) -> String? {
    guard case let .snapshot(snapshot) = push else { return nil }
    return snapshot.server["version"]?.value as? String
}

private final class FakeWebSocketTask: WebSocketTasking, @unchecked Sendable {
    var state: URLSessionTask.State = .running
    var autoRespond = false
    private(set) var sentMessages: [URLSessionWebSocketTask.Message] = []
    private var sentChallenge = false
    private var respondedRequestIds = Set<String>()

    func resume() {}

    func cancel(with _: URLSessionWebSocketTask.CloseCode, reason _: Data?) {
        state = .canceling
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        sentMessages.append(message)
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        if autoRespond {
            if !sentChallenge {
                sentChallenge = true
                return .string("""
                {"type":"event","event":"connect.challenge","payload":{"nonce":"test-nonce"}}
                """)
            }
            if let request = latestUnrespondedRequest() {
                respondedRequestIds.insert(request.id)
                if request.method == "connect" {
                    return .string("""
                    {"type":"res","id":"\(request
                        .id)","ok":true,"payload":{"type":"hello","protocol":3,"server":{},"features":{},"snapshot":{"presence":[],"health":{},"stateVersion":{"presence":0,"health":0},"uptimeMs":0},"auth":{},"policy":{}}}
                    """)
                }
                return .string("""
                {"type":"res","id":"\(request.id)","ok":true,"payload":{}}
                """)
            }
        }
        throw URLError(.cannotConnectToHost)
    }

    func receive(completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void) {
        completionHandler(.failure(URLError(.cannotConnectToHost)))
    }

    private func latestUnrespondedRequest() -> (id: String, method: String)? {
        for message in sentMessages.reversed() {
            let data: Data? = switch message {
            case let .string(text):
                Data(text.utf8)
            case let .data(raw):
                raw
            @unknown default:
                nil
            }
            guard let data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let id = json["id"] as? String,
                  let method = json["method"] as? String,
                  !self.respondedRequestIds.contains(id)
            else {
                continue
            }
            return (id, method)
        }
        return nil
    }
}

private final class FakeWebSocketSession: WebSocketSessioning, @unchecked Sendable {
    let task = FakeWebSocketTask()

    func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
        makeWebSocketTask(request: URLRequest(url: url))
    }

    func makeWebSocketTask(request _: URLRequest) -> WebSocketTaskBox {
        WebSocketTaskBox(task: task)
    }
}

private final class WebSocketMessageRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var messages: [URLSessionWebSocketTask.Message] = []

    func append(_ message: URLSessionWebSocketTask.Message) {
        lock.lock()
        defer { self.lock.unlock() }
        messages.append(message)
    }

    func snapshot() -> [URLSessionWebSocketTask.Message] {
        lock.lock()
        defer { self.lock.unlock() }
        return messages
    }
}

private final class GatewayConnectionRouteConfigSource: @unchecked Sendable {
    private let lock = NSLock()
    private var url: URL

    init(url: URL) {
        self.url = url
    }

    func setURL(_ url: URL) {
        lock.lock()
        self.url = url
        lock.unlock()
    }

    func snapshotURL() -> URL {
        lock.lock()
        defer { self.lock.unlock() }
        return url
    }
}

private actor GatewayConnectionClientShutdownGate {
    private var didStart = false
    private var isOpen = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func run(_ client: GatewayChannelActor) async {
        didStart = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        if !isOpen {
            await withCheckedContinuation { continuation in
                self.releaseWaiters.append(continuation)
            }
        }
        await client.shutdown()
    }

    func waitUntilStarted() async {
        guard !didStart else { return }
        await withCheckedContinuation { continuation in
            self.startWaiters.append(continuation)
        }
    }

    func open() {
        isOpen = true
        releaseWaiters.forEach { $0.resume() }
        releaseWaiters.removeAll()
    }
}

private actor GatewayConnectionConfigProviderGate {
    private let config: GatewayConnection.Config
    private var didStart = false
    private var isOpen = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    init(config: GatewayConnection.Config) {
        self.config = config
    }

    func provide() async -> GatewayConnection.Config {
        didStart = true
        startWaiters.forEach { $0.resume() }
        startWaiters.removeAll()
        if !isOpen {
            await withCheckedContinuation { continuation in
                self.releaseWaiters.append(continuation)
            }
        }
        return config
    }

    func waitUntilStarted() async {
        guard !didStart else { return }
        await withCheckedContinuation { continuation in
            self.startWaiters.append(continuation)
        }
    }

    func open() {
        isOpen = true
        releaseWaiters.forEach { $0.resume() }
        releaseWaiters.removeAll()
    }
}

private func makeTestGatewayConnection() -> (GatewayConnection, FakeWebSocketSession) {
    let session = FakeWebSocketSession()
    let connection = GatewayConnection(
        configProvider: {
            (url: URL(string: "ws://127.0.0.1:1")!, token: nil, password: nil)
        },
        sessionBox: WebSocketSessionBox(session: session)
    )
    return (connection, session)
}

@Suite(.serialized) struct GatewayConnectionControlTests {
    @Test func `operator widget capability refresh is shared and retained`() async throws {
        let rawOldSurface = "http://127.0.0.1:18789/__openclaw__/cap/old-token"
        let rawNewSurface = "http://127.0.0.1:18789/__openclaw__/cap/new-token"
        let oldSurface = "https://gateway.example.invalid:9443/__openclaw__/cap/old-token"
        let newSurface = "https://gateway.example.invalid:9443/__openclaw__/cap/new-token"
        let recorder = WebSocketMessageRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(
                sendHook: { task, message, sendIndex in
                    recorder.append(message)
                    guard sendIndex > 0,
                          let data = Self.messageData(message),
                          let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let method = frame["method"] as? String,
                          let id = frame["id"] as? String
                    else { return }
                    if method == "plugin.surface.refresh" {
                        let response = """
                        {
                          "type": "res",
                          "id": "\(id)",
                          "ok": true,
                          "payload": {
                            "surface": "canvas",
                            "pluginSurfaceUrls": { "canvas": "\(rawNewSurface)" }
                          }
                        }
                        """
                        task.emitReceiveSuccess(.data(Data(response.utf8)))
                    } else {
                        task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                    }
                },
                receiveHook: { task, receiveIndex in
                    if receiveIndex == 0 {
                        return .data(GatewayWebSocketTestSupport.connectChallengeData())
                    }
                    let id = task.snapshotConnectRequestID() ?? "connect"
                    return .data(GatewayWebSocketTestSupport.connectOkData(
                        id: id,
                        canvasPluginSurfaceURL: rawOldSurface))
                })
        })
        let connection = GatewayConnection(
            configProvider: {
                (
                    url: URL(string: "wss://gateway.example.invalid:9443")!,
                    token: "test-token-placeholder",
                    password: nil)
            },
            sessionBox: WebSocketSessionBox(session: session))

        try await connection.refresh()
        _ = try await connection.acquireServerLease()
        #expect(await connection.canvasPluginSurfaceUrl() == oldSurface)
        async let first = connection.refreshCanvasPluginSurfaceRoute(replacing: oldSurface)
        async let second = connection.refreshCanvasPluginSurfaceRoute(replacing: oldSurface)
        let routes = await (first, second)

        #expect(routes.0?.url == newSurface)
        #expect(routes.1?.url == newSurface)
        #expect(await connection.canvasPluginSurfaceUrl() == newSurface)
        let refreshCount = recorder.snapshot().count { message in
            guard let data = Self.messageData(message),
                  let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return false }
            return frame["method"] as? String == "plugin.surface.refresh"
        }
        #expect(refreshCount == 1)
        await connection.shutdown()
    }

    @Test func `wizard not found means cancellation already reached a terminal session`() {
        let notFound = GatewayResponseError(
            method: "wizard.cancel",
            code: "INVALID_REQUEST",
            message: "wizard not found",
            details: nil
        )
        let locked = GatewayResponseError(
            method: "wizard.cancel",
            code: "INVALID_REQUEST",
            message: "wizard cancellation is locked",
            details: nil
        )

        #expect(GatewayConnection.wizardCancellationOutcome(after: notFound) == .absent)
        #expect(GatewayConnection.wizardCancellationOutcome(after: locked) == .unresolved)
        #expect(GatewayConnection.wizardCancellationOutcome(after: URLError(.timedOut)) == .unresolved)
    }

    @Test func `direct endpoint never receives another route device token`() async throws {
        let urlA = try #require(URL(string: "wss://gateway-a.example"))
        let urlB = try #require(URL(string: "wss://gateway-b.example"))
        let ownerA = try #require(GatewayDiscoveryPreferences.deviceAuthGatewayID(
            connectionMode: .remote,
            remoteTransport: .direct,
            remoteURL: urlA.absoluteString,
            remoteTarget: ""
        ))
        let ownerB = try #require(GatewayDiscoveryPreferences.deviceAuthGatewayID(
            connectionMode: .remote,
            remoteTransport: .direct,
            remoteURL: urlB.absoluteString,
            remoteTarget: ""
        ))

        try await assertDeviceTokenIsolation(
            routeA: (urlA, ownerA),
            routeB: (urlB, ownerB)
        )
    }

    @Test func `SSH endpoint never receives another route device token`() async throws {
        let tunnelURL = try #require(URL(string: "ws://127.0.0.1:18789"))
        let ownerA = try #require(GatewayDiscoveryPreferences.deviceAuthGatewayID(
            connectionMode: .remote,
            remoteTransport: .ssh,
            remoteURL: "",
            remoteTarget: "operator@gateway-a.example"
        ))
        let ownerB = try #require(GatewayDiscoveryPreferences.deviceAuthGatewayID(
            connectionMode: .remote,
            remoteTransport: .ssh,
            remoteURL: "",
            remoteTarget: "operator@gateway-b.example"
        ))

        try await assertDeviceTokenIsolation(
            routeA: (tunnelURL, ownerA),
            routeB: (tunnelURL, ownerB)
        )
    }

    @Test func `retired socket callbacks cannot mutate cache or subscribers`() async {
        let (connection, _) = makeTestGatewayConnection()
        let routeGeneration = await connection._test_routeGeneration()
        let stream = await connection.subscribe(bufferingNewest: 10)
        var iterator = stream.makeAsyncIterator()

        await connection._test_handlePush(
            .snapshot(makeGatewayGenerationSnapshot(version: "socket-1")),
            routeGeneration: routeGeneration,
            socketGeneration: 1
        )
        await connection._test_handleDisconnect(
            routeGeneration: routeGeneration,
            socketGeneration: 1
        )
        #expect(await connection.cachedGatewayVersion() == nil)

        await connection._test_handlePush(
            .snapshot(makeGatewayGenerationSnapshot(version: "stale-socket-1")),
            routeGeneration: routeGeneration,
            socketGeneration: 1
        )
        await connection._test_handlePush(
            .snapshot(makeGatewayGenerationSnapshot(version: "socket-2")),
            routeGeneration: routeGeneration,
            socketGeneration: 2
        )
        await connection._test_handlePush(
            .snapshot(makeGatewayGenerationSnapshot(version: "late-socket-1")),
            routeGeneration: routeGeneration,
            socketGeneration: 1
        )

        let firstPush = await iterator.next()
        let secondPush = await iterator.next()
        #expect(gatewayGenerationSnapshotVersion(firstPush) == "socket-1")
        #expect(gatewayGenerationSnapshotVersion(secondPush) == "socket-2")
        #expect(await connection.cachedGatewayVersion() == "socket-2")
        await connection.shutdown()
    }

    @Test func `replaced route rejects callbacks from previous client`() async {
        let (connection, _) = makeTestGatewayConnection()
        let replacedRouteGeneration = await connection._test_routeGeneration()
        await connection.shutdown()
        let currentRouteGeneration = await connection._test_routeGeneration()
        let stream = await connection.subscribe(bufferingNewest: 10)
        var iterator = stream.makeAsyncIterator()

        await connection._test_handlePush(
            .snapshot(makeGatewayGenerationSnapshot(version: "replaced-route")),
            routeGeneration: replacedRouteGeneration,
            socketGeneration: 1
        )
        await connection._test_handlePush(
            .snapshot(makeGatewayGenerationSnapshot(version: "current-route")),
            routeGeneration: currentRouteGeneration,
            socketGeneration: 1
        )

        let push = await iterator.next()
        #expect(gatewayGenerationSnapshotVersion(push) == "current-route")
        #expect(await connection.cachedGatewayVersion() == "current-route")
        await connection.shutdown()
    }

    @Test func `older reconfigure cannot install after newer route`() async throws {
        let initialURL = try #require(URL(string: "ws://route-a.invalid"))
        let source = GatewayConnectionRouteConfigSource(url: initialURL)
        let gate = GatewayConnectionClientShutdownGate()
        let connection = GatewayConnection(
            configProvider: {
                (url: source.snapshotURL(), token: nil, password: nil)
            },
            sessionBox: WebSocketSessionBox(session: FakeWebSocketSession()),
            clientShutdown: { client in
                await gate.run(client)
            }
        )
        try await connection.refresh()

        let intermediateURL = try #require(URL(string: "ws://route-b.invalid"))
        source.setURL(intermediateURL)
        let olderRefresh = Task { try await connection.refresh() }
        await gate.waitUntilStarted()

        let newestURL = try #require(URL(string: "ws://route-c.invalid"))
        source.setURL(newestURL)
        try await connection.refresh()
        #expect(await connection._test_configuredURL() == newestURL)

        await gate.open()
        do {
            try await olderRefresh.value
            Issue.record("expected superseded route cancellation")
        } catch is CancellationError {}
        #expect(await connection._test_configuredURL() == newestURL)
        await connection.shutdown()
    }

    @Test func `same route reconfigure joins newer client`() async throws {
        let initialURL = try #require(URL(string: "ws://route-a.invalid"))
        let source = GatewayConnectionRouteConfigSource(url: initialURL)
        let gate = GatewayConnectionClientShutdownGate()
        let connection = GatewayConnection(
            configProvider: {
                (url: source.snapshotURL(), token: "same-token", password: "same-password")
            },
            sessionBox: WebSocketSessionBox(session: FakeWebSocketSession()),
            clientShutdown: { client in
                await gate.run(client)
            }
        )
        try await connection.refresh()

        let replacementURL = try #require(URL(string: "ws://route-b.invalid"))
        source.setURL(replacementURL)
        let olderRefresh = Task { try await connection.refresh() }
        await gate.waitUntilStarted()

        try await connection.refresh()
        let installedRouteGeneration = await connection._test_routeGeneration()
        #expect(await connection._test_configuredURL() == replacementURL)

        await gate.open()
        try await olderRefresh.value
        #expect(await connection._test_routeGeneration() == installedRouteGeneration)
        #expect(await connection._test_configuredURL() == replacementURL)
        await connection.shutdown()
    }

    @Test func `reconfigure cannot join same route installed after shutdown`() async throws {
        let initialURL = try #require(URL(string: "ws://route-a.invalid"))
        let source = GatewayConnectionRouteConfigSource(url: initialURL)
        let gate = GatewayConnectionClientShutdownGate()
        let connection = GatewayConnection(
            configProvider: {
                (url: source.snapshotURL(), token: "same-token", password: "same-password")
            },
            sessionBox: WebSocketSessionBox(session: FakeWebSocketSession()),
            clientShutdown: { client in
                await gate.run(client)
            }
        )
        try await connection.refresh()

        let replacementURL = try #require(URL(string: "ws://route-b.invalid"))
        source.setURL(replacementURL)
        let staleRefresh = Task { try await connection.refresh() }
        await gate.waitUntilStarted()

        await connection.shutdown()
        try await connection.refresh()
        #expect(await connection._test_configuredURL() == replacementURL)

        await gate.open()
        do {
            try await staleRefresh.value
            Issue.record("expected pre-shutdown reconfigure cancellation")
        } catch is CancellationError {} catch {
            Issue.record("unexpected stale reconfigure error: \(error)")
        }
        #expect(await connection._test_configuredURL() == replacementURL)
        await connection.shutdown()
    }

    @Test func `request suspended in config lookup cannot recreate route after shutdown`() async throws {
        let url = try #require(URL(string: "ws://stale-request.invalid"))
        let gate = GatewayConnectionConfigProviderGate(config: (url: url, token: nil, password: nil))
        let connection = GatewayConnection(
            configProvider: { await gate.provide() },
            sessionBox: WebSocketSessionBox(session: FakeWebSocketSession())
        )

        let request = Task {
            try await connection.request(
                method: "status",
                params: nil,
                retryTransportFailures: false
            )
        }
        await gate.waitUntilStarted()
        await connection.shutdown()
        await gate.open()

        do {
            _ = try await request.value
            Issue.record("expected stale request cancellation")
        } catch is CancellationError {} catch {
            Issue.record("unexpected stale request error: \(error)")
        }
        #expect(await connection._test_configuredURL() == nil)
    }

    @Test func `refresh suspended in config lookup cannot recreate route after shutdown`() async throws {
        let url = try #require(URL(string: "ws://stale-refresh.invalid"))
        let gate = GatewayConnectionConfigProviderGate(config: (url: url, token: nil, password: nil))
        let connection = GatewayConnection(
            configProvider: { await gate.provide() },
            sessionBox: WebSocketSessionBox(session: FakeWebSocketSession())
        )

        let refresh = Task { try await connection.refresh() }
        await gate.waitUntilStarted()
        await connection.shutdown()
        await gate.open()

        do {
            try await refresh.value
            Issue.record("expected stale refresh cancellation")
        } catch is CancellationError {} catch {
            Issue.record("unexpected stale refresh error: \(error)")
        }
        #expect(await connection._test_configuredURL() == nil)
    }

    @Test func `capture route suspended in config lookup cannot recreate route after shutdown`() async throws {
        let url = try #require(URL(string: "ws://stale-capture.invalid"))
        let gate = GatewayConnectionConfigProviderGate(config: (url: url, token: nil, password: nil))
        let connection = GatewayConnection(
            configProvider: { await gate.provide() },
            sessionBox: WebSocketSessionBox(session: FakeWebSocketSession())
        )

        let capture = Task { await connection.captureRoute() }
        await gate.waitUntilStarted()
        await connection.shutdown()
        await gate.open()

        #expect(await capture.value == nil)
        #expect(await connection._test_configuredURL() == nil)
    }

    @Test func `older shutdown cannot clear newer route`() async throws {
        let initialURL = try #require(URL(string: "ws://route-a.invalid"))
        let source = GatewayConnectionRouteConfigSource(url: initialURL)
        let gate = GatewayConnectionClientShutdownGate()
        let connection = GatewayConnection(
            configProvider: {
                (url: source.snapshotURL(), token: nil, password: nil)
            },
            sessionBox: WebSocketSessionBox(session: FakeWebSocketSession()),
            clientShutdown: { client in
                await gate.run(client)
            }
        )
        try await connection.refresh()

        let olderShutdown = Task { await connection.shutdown() }
        await gate.waitUntilStarted()

        let newestURL = try #require(URL(string: "ws://route-b.invalid"))
        source.setURL(newestURL)
        try await connection.refresh()
        #expect(await connection._test_configuredURL() == newestURL)

        await gate.open()
        await olderShutdown.value
        #expect(await connection._test_configuredURL() == newestURL)
        await connection.shutdown()
    }

    @Test func `status fails when process missing`() async {
        let (connection, _) = makeTestGatewayConnection()
        let result = await connection.status()
        await connection.shutdown()
        #expect(result.ok == false)
        #expect(result.error != nil)
    }

    @Test func `reject empty message`() async {
        let (connection, _) = makeTestGatewayConnection()
        let result = await connection.sendAgent(
            message: "",
            thinking: nil,
            sessionKey: "main",
            deliver: false,
            to: nil
        )
        #expect(result.ok == false)
    }

    @Test func `send agent keeps empty voice wake trigger field`() async throws {
        let recorder = WebSocketMessageRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                recorder.append(message)
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
            })
        })
        let connection = GatewayConnection(
            configProvider: {
                (url: URL(string: "ws://127.0.0.1:1")!, token: nil, password: nil)
            },
            sessionBox: WebSocketSessionBox(session: session)
        )
        let result = await connection.sendAgent(GatewayAgentInvocation(
            message: "test",
            sessionKey: "main",
            thinking: nil,
            deliver: false,
            to: nil,
            channel: .last,
            timeoutSeconds: nil,
            idempotencyKey: "idem-1",
            voiceWakeTrigger: "   "
        ))
        await connection.shutdown()
        #expect(result.ok == true)

        guard let agentMessage = recorder.snapshot().reversed().first(where: { message in
            guard let data = Self.messageData(message),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return false }
            return json["method"] as? String == "agent"
        }) else {
            Issue.record("expected agent websocket send payload")
            return
        }

        guard let payloadData = Self.messageData(agentMessage) else {
            Issue.record("unexpected agent websocket message type")
            return
        }

        let json = try JSONSerialization.jsonObject(with: payloadData) as? [String: Any]
        let params = json?["params"] as? [String: Any]
        #expect(params?["thinking"] == nil)
        #expect(params?["voiceWakeTrigger"] as? String == "")
    }

    @Test func `chat send carries routing precondition and omits inherited thinking`() async throws {
        let recorder = WebSocketMessageRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                recorder.append(message)
                guard sendIndex > 0,
                      let data = Self.messageData(message),
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let id = json["id"] as? String
                else { return }
                task.emitReceiveSuccess(.data(Self.chatSendOkResponseData(id: id)))
            })
        })
        let connection = GatewayConnection(
            configProvider: {
                (url: URL(string: "ws://127.0.0.1:1")!, token: nil, password: nil)
            },
            sessionBox: WebSocketSessionBox(session: session)
        )

        _ = try await connection.chatSend(
            sessionKey: "main",
            expectedSessionRoutingContract: "per-sender|main|main",
            message: "hello",
            thinking: nil,
            idempotencyKey: "chat-1",
            attachments: []
        )
        await connection.shutdown()

        guard let chatMessage = recorder.snapshot().reversed().first(where: { message in
            guard let data = Self.messageData(message),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return false }
            return json["method"] as? String == "chat.send"
        }) else {
            Issue.record("expected chat.send websocket payload")
            return
        }

        guard let payloadData = Self.messageData(chatMessage) else {
            Issue.record("unexpected chat.send websocket message type")
            return
        }

        let json = try JSONSerialization.jsonObject(with: payloadData) as? [String: Any]
        let params = json?["params"] as? [String: Any]
        #expect(params?["thinking"] == nil)
        #expect(params?["expectedSessionRoutingContract"] as? String == "per-sender|main|main")
        #expect(params?["timeoutMs"] == nil)
    }

    @Test func `routing identity decodes agent and contract from one response`() throws {
        let data = Data(#"{"defaultId":"Work","mainKey":"Primary","scope":"global","agents":[]}"#.utf8)
        let identity = try OpenClawChatGatewayPayloadCodec.decodeSessionRoutingIdentity(data)

        #expect(identity.defaultAgentID == "work")
        #expect(identity.contract == "global|primary|work")
    }

    @Test(arguments: [
        (
            #"{"defaultId":"main","mainKey":"main","scope":"per-sender","agents":[{"id":"main","model":{"primary":"openai/gpt-5.5"}}]}"#,
            "openai/gpt-5.5"
        ),
        (
            #"{"defaultId":"work","mainKey":"main","scope":"per-sender","agents":[{"id":"main","model":{"primary":"openai/gpt-5.5"}},{"id":"work","model":{"primary":"anthropic/claude-opus-4-8"}}]}"#,
            "anthropic/claude-opus-4-8"
        ),
        (
            #"{"defaultId":"main","mainKey":"main","scope":"per-sender","agents":[{"id":"main"},{"id":"work","model":{"primary":"openai/gpt-5.5"}}]}"#,
            nil
        ),
        (
            #"{"defaultId":"main","mainKey":"main","scope":"per-sender","agents":[{"id":"main","model":{"primary":"   "}}]}"#,
            nil
        ),
    ])
    func `configured inference model follows the default agent`(
        json: String,
        expected: String?
    ) throws {
        #expect(try GatewayConnection.decodeConfiguredInferenceModel(Data(json.utf8)) == expected)
    }

    private static func messageData(_ message: URLSessionWebSocketTask.Message) -> Data? {
        switch message {
        case let .string(text):
            Data(text.utf8)
        case let .data(data):
            data
        @unknown default:
            nil
        }
    }

    private func assertDeviceTokenIsolation(
        routeA: (url: URL, owner: String),
        routeB: (url: URL, owner: String)
    ) async throws {
        #expect(routeA.owner != routeB.owner)
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        try await DeviceIdentityStore.withStateDirectory(tempDir) {
            let unscopedToken = "legacy-unscoped-token"
            let routeAToken = "route-a-device-token"
            let routeAAuth = try await self.connectAuth(
                route: routeA,
                storedDeviceToken: routeAToken,
                unscopedToken: unscopedToken
            )
            #expect(routeAAuth?["token"] as? String == routeAToken)
            #expect(routeAAuth?["token"] as? String != unscopedToken)

            let routeBAuth = try await self.connectAuth(route: routeB)
            #expect(routeBAuth?["token"] == nil)
            #expect(routeBAuth?["deviceToken"] == nil)
        }
    }

    private func connectAuth(
        route: (url: URL, owner: String),
        storedDeviceToken: String? = nil,
        unscopedToken: String? = nil
    ) async throws -> [String: Any]? {
        let recorder = WebSocketMessageRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                recorder.append(message)
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
            })
        })
        let connection = GatewayConnection(
            endpointProvider: {
                if let storedDeviceToken, let unscopedToken {
                    let identity = DeviceIdentityStore.loadOrCreate()
                    guard DeviceAuthStore.storeTokenPersisted(
                        deviceId: identity.deviceId,
                        role: "operator",
                        token: unscopedToken
                    ),
                        DeviceAuthStore.storeTokenPersisted(
                            deviceId: identity.deviceId,
                            role: "operator",
                            token: storedDeviceToken,
                            gatewayID: route.owner
                        )
                    else {
                        throw NSError(
                            domain: "GatewayConnectionControlTests",
                            code: 1,
                            userInfo: [NSLocalizedDescriptionKey: "failed to persist device auth fixture"]
                        )
                    }
                }
                return GatewayConnection.EndpointSnapshot(
                    config: (url: route.url, token: nil, password: nil),
                    routeAuthority: nil,
                    deviceAuthGatewayID: route.owner
                )
            },
            sessionBox: WebSocketSessionBox(session: session)
        )
        _ = try await connection.request(
            method: "health",
            params: nil,
            retryTransportFailures: false
        )
        await connection.shutdown()

        for message in recorder.snapshot() {
            guard let data = Self.messageData(message),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  json["method"] as? String == "connect",
                  let params = json["params"] as? [String: Any]
            else { continue }
            return params["auth"] as? [String: Any]
        }
        Issue.record("expected connect request")
        return nil
    }

    private static func chatSendOkResponseData(id: String) -> Data {
        Data("""
        {
          "type": "res",
          "id": "\(id)",
          "ok": true,
          "payload": { "runId": "chat-1", "status": "ok" }
        }
        """.utf8)
    }
}

@Suite(.serialized) struct ConnectSnapshotStoreGenerationTests {
    @Test func `retired generation cannot repopulate CLI snapshot store`() async {
        let store = SnapshotStore()

        await store.set(makeGatewayGenerationSnapshot(version: "socket-1"), generation: 1)
        await store.retire(generation: 1)
        await store.set(makeGatewayGenerationSnapshot(version: "stale-socket-1"), generation: 1)
        #expect(await store.get() == nil)

        await store.set(makeGatewayGenerationSnapshot(version: "socket-2"), generation: 2)
        await store.set(makeGatewayGenerationSnapshot(version: "late-socket-1"), generation: 1)

        let snapshot = await store.get()
        #expect(snapshot?.server["version"]?.value as? String == "socket-2")
    }
}
