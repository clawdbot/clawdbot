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
            health: [String: OpenClawProtocol.AnyCodable](),
            stateversion: StateVersion(presence: 0, health: 0),
            uptimems: 0,
            configpath: nil,
            statedir: nil,
            sessiondefaults: nil,
            authmode: nil,
            updateavailable: nil),
        controluitabs: nil,
        pluginsurfaceurls: nil,
        auth: [:],
        policy: [:])
}

private func gatewayGenerationSnapshotVersion(_ push: GatewayPush?) -> String? {
    guard case let .snapshot(snapshot) = push else { return nil }
    return snapshot.server["version"]?.value as? String
}

private final class WebSocketMessageRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var messages: [URLSessionWebSocketTask.Message] = []

    func append(_ message: URLSessionWebSocketTask.Message) {
        self.lock.lock()
        defer { self.lock.unlock() }
        self.messages.append(message)
    }

    func snapshot() -> [URLSessionWebSocketTask.Message] {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.messages
    }
}

final class GatewayConnectionEndpointSource: @unchecked Sendable {
    private let lock = NSLock()
    private var endpoint: GatewayConnection.EndpointSnapshot

    init(endpoint: GatewayConnection.EndpointSnapshot) {
        self.endpoint = endpoint
    }

    convenience init(url: URL, token: String? = nil, password: String? = nil) {
        self.init(endpoint: GatewayConnection.EndpointSnapshot(
            config: (url: url, token: token, password: password),
            routeAuthority: nil))
    }

    func setEndpoint(_ endpoint: GatewayConnection.EndpointSnapshot) {
        self.lock.lock()
        self.endpoint = endpoint
        self.lock.unlock()
    }

    func snapshot() -> GatewayConnection.EndpointSnapshot {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.endpoint
    }

    func setURL(_ url: URL) {
        self.lock.lock()
        let config = self.endpoint.config
        self.endpoint = GatewayConnection.EndpointSnapshot(
            config: (url: url, token: config.token, password: config.password),
            routeAuthority: nil)
        self.lock.unlock()
    }
}

private actor GatewayConnectionSuspensionGate {
    private var didStart = false
    private var isOpen = false
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []

    func suspend() async {
        self.didStart = true
        self.startWaiters.forEach { $0.resume() }
        self.startWaiters.removeAll()
        if !self.isOpen {
            await withCheckedContinuation { continuation in
                self.releaseWaiters.append(continuation)
            }
        }
    }

    func waitUntilStarted() async {
        guard !self.didStart else { return }
        await withCheckedContinuation { continuation in
            self.startWaiters.append(continuation)
        }
    }

    func open() {
        self.isOpen = true
        self.releaseWaiters.forEach { $0.resume() }
        self.releaseWaiters.removeAll()
    }
}

private func makeTestGatewayConnection() -> (GatewayConnection, GatewayTestWebSocketSession) {
    let session = GatewayTestWebSocketSession(taskFactory: {
        GatewayTestWebSocketTask(receiveHook: { _, _ in
            throw URLError(.cannotConnectToHost)
        })
    })
    let connection = GatewayConnection(
        configProvider: {
            (url: URL(string: "ws://127.0.0.1:1")!, token: nil, password: nil)
        },
        sessionBox: WebSocketSessionBox(session: session))
    return (connection, session)
}

private func makeRecordingGatewayConnection(
    responseData: @escaping @Sendable (String) -> Data) -> (GatewayConnection, WebSocketMessageRecorder)
{
    let recorder = WebSocketMessageRecorder()
    let session = GatewayTestWebSocketSession(taskFactory: {
        GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
            recorder.append(message)
            guard sendIndex > 0,
                  let id = GatewayWebSocketTestSupport.requestID(from: message)
            else { return }
            task.emitReceiveSuccess(.data(responseData(id)))
        })
    })
    let connection = GatewayConnection(
        configProvider: {
            (url: URL(string: "ws://127.0.0.1:1")!, token: nil, password: nil)
        },
        sessionBox: WebSocketSessionBox(session: session))
    return (connection, recorder)
}

private func makeRouteLifecycleConnection(
    url: URL,
    token: String? = nil,
    password: String? = nil) -> (GatewayConnectionEndpointSource, GatewayConnectionSuspensionGate, GatewayConnection)
{
    let source = GatewayConnectionEndpointSource(url: url, token: token, password: password)
    let gate = GatewayConnectionSuspensionGate()
    let connection = GatewayConnection(
        configProvider: { source.snapshot().config },
        sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession()),
        clientShutdown: { client in
            await gate.suspend()
            await client.shutdown()
        })
    return (source, gate, connection)
}

private enum SuspendedConfigOperation {
    case request
    case refresh
    case captureRoute
}

private func assertConfigLookupCannotRecreateRoute(
    url: URL,
    operation: SuspendedConfigOperation) async
{
    let gate = GatewayConnectionSuspensionGate()
    let config: GatewayConnection.Config = (url: url, token: nil, password: nil)
    let connection = GatewayConnection(
        configProvider: {
            await gate.suspend()
            return config
        },
        sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession()))
    let operationTask = Task {
        switch operation {
        case .request:
            do {
                _ = try await connection.request(
                    method: "status",
                    params: nil,
                    retryTransportFailures: false)
                Issue.record("expected stale request cancellation")
            } catch is CancellationError {} catch {
                Issue.record("unexpected stale request error: \(error)")
            }
        case .refresh:
            do {
                try await connection.refresh()
                Issue.record("expected stale refresh cancellation")
            } catch is CancellationError {} catch {
                Issue.record("unexpected stale refresh error: \(error)")
            }
        case .captureRoute:
            #expect(await connection.captureRoute() == nil)
        }
    }
    await gate.waitUntilStarted()
    await connection.shutdown()
    await gate.open()
    await operationTask.value
    #expect(await connection._test_configuredURL() == nil)
}

@Suite(.serialized) struct GatewayConnectionControlTests {
    @Test @MainActor
    func `cancelled pending request never activates local gateway recovery`() async throws {
        try await self.withIsolatedRecoveryFixture { _, _, _ in } operation: { connection, session in
            let request = Task {
                try await connection.request(method: "status", params: nil)
            }
            try #require(await self.waitForRequest(on: session))

            request.cancel()

            do {
                _ = try await request.value
                Issue.record("expected the cancelled caller to throw CancellationError")
            } catch is CancellationError {} catch {
                Issue.record("unexpected cancellation error: \(error)")
            }

            #expect(GatewayProcessManager.shared.status == .stopped)
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot().isEmpty)
            #expect(session.snapshotMakeCount() == 1)
            #expect(session.latestTask()?.snapshotSendCount() == 2)
        }
    }

    @Test @MainActor
    func `genuine transport failure still activates and retries local gateway recovery`() async throws {
        try await self.assertUncancelledFailureRecovers(URLError(.networkConnectionLost))
    }

    @Test @MainActor
    func `send-side cancellation without caller cancellation still activates gateway recovery`() async throws {
        try await self.assertUncancelledFailureRecovers(CancellationError())
    }

    @Test(arguments: [false, true], [false, true]) @MainActor
    func `Talk phase notifications preserve their payload without activating recovery`(
        enabled: Bool,
        failTransport: Bool) async throws
    {
        let requests = WebSocketMessageRecorder()
        try await self.withIsolatedRecoveryFixture { socket, message, sendIndex in
            guard sendIndex > 0,
                  let id = GatewayWebSocketTestSupport.requestID(from: message),
                  let data = Self.messageData(message),
                  let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return }
            if frame["method"] as? String == "talk.mode" {
                requests.append(message)
                if failTransport, requests.snapshot().count == 1 {
                    throw URLError(.networkConnectionLost)
                }
            }
            socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
        } operation: { connection, _ in
            let phase = enabled ? "speaking" : "idle"
            await connection.talkMode(enabled: enabled, phase: phase)

            #expect(GatewayProcessManager.shared.status == .stopped)
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot().isEmpty)
            #expect(requests.snapshot().count == 1)
            let message = try #require(requests.snapshot().first)
            let data = try #require(Self.messageData(message))
            let frame = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let params = try #require(frame["params"] as? [String: Any])
            #expect(params["enabled"] as? Bool == enabled)
            #expect(params["phase"] as? String == phase)
        }
    }

    @Test @MainActor
    func `gateway response errors never activate transport recovery`() async throws {
        try await self.withIsolatedRecoveryFixture { socket, message, sendIndex in
            guard sendIndex > 0,
                  let id = GatewayWebSocketTestSupport.requestID(from: message)
            else { return }
            let response = #"{"type":"res","id":"\#(id)","ok":false,"# +
                #""error":{"code":"INVALID_REQUEST","message":"response rejected"}}"#
            socket.emitReceiveSuccess(.data(Data(response.utf8)))
        } operation: { connection, session in
            do {
                _ = try await connection.request(method: "status", params: nil)
                Issue.record("expected the Gateway response error")
            } catch is GatewayResponseError {} catch {
                Issue.record("unexpected response error: \(error)")
            }

            #expect(GatewayProcessManager.shared.status == .stopped)
            #expect(GatewayLaunchAgentManager.testingDaemonCommandCallsSnapshot().isEmpty)
            #expect(session.snapshotMakeCount() == 1)
            #expect(session.latestTask()?.snapshotSendCount() == 2)
        }
    }

    @Test(.gatewayTLSStoreIsolated)
    func `uncancelled trusted TLS mismatch still repairs its stored pin`() async throws {
        let url = try #require(URL(string: "wss://gateway.example.ts.net"))
        let storeKey = "autoqa-185-tls-recovery"
        GatewayTLSStore.saveFingerprint("old", stableID: storeKey)
        let route = try #require(GatewayTLSRoute.resolve(
            url: url,
            connectionMode: .remote,
            configuredFingerprint: nil,
            storedFingerprint: "old",
            storeKey: storeKey))
        let failure = GatewayTLSValidationFailure(
            kind: .pinMismatch,
            host: "gateway.example.ts.net",
            storeKey: storeKey,
            expectedFingerprint: "old",
            observedFingerprint: "new",
            systemTrustOk: true,
            port: 443)
        let requests = WebSocketMessageRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0 else { return }
                requests.append(message)
                if requests.snapshot().count == 1 {
                    throw GatewayTLSValidationError(failure: failure, context: "isolated TLS test")
                }
                guard let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
            })
        })
        let connection = GatewayConnection(
            testEndpointProvider: {
                GatewayConnection.EndpointSnapshot(
                    config: (url: url, token: nil, password: nil),
                    tls: route,
                    routeAuthority: nil)
            },
            sessionBox: WebSocketSessionBox(session: session))

        do {
            _ = try await connection.request(method: "status", params: nil)

            #expect(GatewayTLSStore.loadFingerprint(stableID: storeKey) == "new")
            #expect(requests.snapshot().count == 2)
        } catch {
            await connection.shutdown()
            throw error
        }
        await connection.shutdown()
    }

    @Test func `realtime talk transport pins requests to its server lease`() async throws {
        let recorder = WebSocketMessageRecorder()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(
                sendHook: { task, message, sendIndex in
                    recorder.append(message)
                    guard sendIndex > 0,
                          let data = Self.messageData(message),
                          let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let id = frame["id"] as? String
                    else { return }
                    task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                },
                receiveHook: { task, receiveIndex in
                    if receiveIndex == 0 {
                        return .data(GatewayWebSocketTestSupport.connectChallengeData())
                    }
                    let id = task.snapshotConnectRequestID() ?? "connect"
                    return .data(GatewayWebSocketTestSupport.connectOkData(id: id))
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
        let transport = try await connection.acquireRealtimeTalkTransport()
        #expect(await transport.isCurrent())

        let events = await transport.subscribeServerEvents(10)
        let nextEvent = Task {
            var iterator = events.makeAsyncIterator()
            return await iterator.next()
        }

        _ = try await transport.request(
            "talk.session.close",
            ["sessionId": AnyCodable("talk-session-1")],
            4321)

        let talkRequest = try #require(recorder.snapshot().first { message in
            guard let data = Self.messageData(message),
                  let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return false }
            return frame["method"] as? String == "talk.session.close"
        })
        let talkRequestData = try #require(Self.messageData(talkRequest))
        let talkRequestFrame = try #require(
            JSONSerialization.jsonObject(with: talkRequestData) as? [String: Any])
        let params = try #require(talkRequestFrame["params"] as? [String: Any])
        #expect(params["sessionId"] as? String == "talk-session-1")

        let socketGeneration = try #require(await connection._test_activeSocketGeneration())
        await connection._test_handleDisconnect(socketGeneration: socketGeneration)
        let eventAfterDisconnect = try await AsyncTimeout.withTimeout(
            seconds: 1,
            onTimeout: { CancellationError() },
            operation: { await nextEvent.value })
        #expect(eventAfterDisconnect == nil)

        await connection.shutdown()
        try await connection.refresh()
        let successor = try await connection.acquireRealtimeTalkTransport()
        #expect(await !(transport.isCurrent()))
        #expect(await successor.isCurrent())
        await #expect(throws: (any Error).self) {
            _ = try await transport.request("talk.session.close", nil, 4321)
        }
        _ = try await successor.request("talk.session.close", nil, 4321)
        #expect(await successor.isCurrent())
        await connection.shutdown()
    }

    @Test func `realtime bootstrap never moves config onto a replacement route`() async throws {
        let recorder = WebSocketMessageRecorder()
        let configRequestEntered = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        let releaseConfig = AsyncTestGate()
        let source = try GatewayConnectionEndpointSource(
            url: #require(URL(string: "wss://route-a.example.invalid:9443")))
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(
                sendHook: { task, message, sendIndex in
                    recorder.append(message)
                    guard sendIndex > 0,
                          let data = Self.messageData(message),
                          let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let id = frame["id"] as? String
                    else { return }
                    let method = frame["method"] as? String
                    let configRequestCount = recorder.snapshot().filter { recorded in
                        guard let data = Self.messageData(recorded),
                              let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                        else { return false }
                        return frame["method"] as? String == "talk.config"
                    }.count
                    if method == "talk.config", configRequestCount == 1 {
                        configRequestEntered.continuation.yield()
                        configRequestEntered.continuation.finish()
                        await releaseConfig.wait()
                    }
                    let sessionKey = configRequestCount > 1 ? "route-b" : "route-a"
                    let response = Data(
                        """
                        {"type":"res","id":"\(id)","ok":true,"payload":{"config":{
                          "session":{"mainKey":"\(sessionKey)"},
                          "talk":{"realtime":{"provider":"openai","mode":"realtime",
                            "transport":"gateway-relay","brain":"agent-consult"}}
                        }}}
                        """.utf8)
                    task.emitReceiveSuccess(.data(response))
                },
                receiveHook: { task, receiveIndex in
                    if receiveIndex == 0 {
                        return .data(GatewayWebSocketTestSupport.connectChallengeData())
                    }
                    let id = task.snapshotConnectRequestID() ?? "connect"
                    return .data(GatewayWebSocketTestSupport.connectOkData(id: id))
                })
        })
        let connection = GatewayConnection(
            testEndpointProvider: { source.snapshot() },
            sessionBox: WebSocketSessionBox(session: session))
        let entryTask = Task {
            var iterator = configRequestEntered.stream.makeAsyncIterator()
            return await iterator.next()
        }
        let staleBootstrap = Task {
            try await connection.acquireRealtimeTalkBootstrap()
        }
        do {
            _ = try await AsyncTimeout.withTimeout(
                seconds: 1,
                onTimeout: { CancellationError() },
                operation: { await entryTask.value })
            try source.setURL(#require(URL(string: "wss://route-b.example.invalid:9443")))
            try await connection.refresh()
            releaseConfig.open()
            await #expect(throws: (any Error).self) {
                _ = try await staleBootstrap.value
            }
            let preReplacementConfigCount = recorder.snapshot().filter { recorded in
                guard let data = Self.messageData(recorded),
                      let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                else { return false }
                return frame["method"] as? String == "talk.config"
            }.count
            #expect(preReplacementConfigCount == 1)

            let replacement = try await connection.acquireRealtimeTalkBootstrap()
            #expect(replacement.sessionKey == "route-b")
            #expect(await replacement.transport.isCurrent())
            let configRequests = recorder.snapshot().compactMap { message -> [String: Any]? in
                guard let data = Self.messageData(message),
                      let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      frame["method"] as? String == "talk.config"
                else { return nil }
                return frame
            }
            #expect(configRequests.count == 2)
            for request in configRequests {
                let params = try #require(request["params"] as? [String: Any])
                #expect(params["includeSecrets"] == nil)
            }
        } catch {
            releaseConfig.open()
            entryTask.cancel()
            staleBootstrap.cancel()
            _ = await entryTask.value
            _ = try? await staleBootstrap.value
            await connection.shutdown()
            throw error
        }
        releaseConfig.open()
        entryTask.cancel()
        staleBootstrap.cancel()
        _ = await entryTask.value
        _ = try? await staleBootstrap.value
        await connection.shutdown()
    }

    @Test func `realtime talk event overflow terminates its bounded subscription`() async throws {
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(
                sendHook: { task, message, sendIndex in
                    guard sendIndex > 0,
                          let data = Self.messageData(message),
                          let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                          let id = frame["id"] as? String
                    else { return }
                    task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                },
                receiveHook: { task, receiveIndex in
                    if receiveIndex == 0 {
                        return .data(GatewayWebSocketTestSupport.connectChallengeData())
                    }
                    let id = task.snapshotConnectRequestID() ?? "connect"
                    return .data(GatewayWebSocketTestSupport.connectOkData(id: id))
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
        let transport = try await connection.acquireRealtimeTalkTransport()
        let events = await transport.subscribeServerEvents(1)
        let socketGeneration = try #require(await connection._test_activeSocketGeneration())

        for seq in 1...20 {
            await connection._test_handlePush(
                .event(EventFrame(
                    type: "event",
                    event: "talk.event",
                    payload: AnyCodable(["seq": seq]),
                    seq: seq,
                    stateversion: nil)),
                socketGeneration: socketGeneration)
        }

        let terminalRead = Task {
            var iterator = events.makeAsyncIterator()
            var received: [EventFrame] = []
            while let event = await iterator.next() {
                received.append(event)
            }
            return received
        }
        let received = try await AsyncTimeout.withTimeout(
            seconds: 1,
            onTimeout: { CancellationError() },
            operation: { await terminalRead.value })
        #expect(!received.isEmpty)
        #expect(received.count <= 2)
        await connection.shutdown()
    }

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
            details: nil)
        let locked = GatewayResponseError(
            method: "wizard.cancel",
            code: "INVALID_REQUEST",
            message: "wizard cancellation is locked",
            details: nil)

        #expect(GatewayConnection.wizardCancellationOutcome(after: notFound) == .absent)
        #expect(GatewayConnection.wizardCancellationOutcome(after: locked) == .unresolved)
        #expect(GatewayConnection.wizardCancellationOutcome(after: URLError(.timedOut)) == .unresolved)
    }

    @Test func `operator connection rebuilds when direct TLS pin changes`() async throws {
        let url = try #require(URL(string: "wss://gateway.example.invalid"))
        let firstFingerprint = String(repeating: "a", count: 64)
        let secondFingerprint = String(repeating: "b", count: 64)
        let firstTLS = try #require(GatewayTLSRoute.resolve(
            url: url,
            connectionMode: .remote,
            configuredFingerprint: firstFingerprint,
            storedFingerprint: nil))
        let secondTLS = try #require(GatewayTLSRoute.resolve(
            url: url,
            connectionMode: .remote,
            configuredFingerprint: secondFingerprint,
            storedFingerprint: nil))
        let source = GatewayConnectionEndpointSource(endpoint: GatewayConnection.EndpointSnapshot(
            config: (url: url, token: "token", password: nil),
            tls: firstTLS,
            routeAuthority: nil,
            revision: 1))
        let connection = GatewayConnection(testEndpointProvider: { source.snapshot() })

        try await connection.refresh()
        let firstGeneration = await connection._test_routeGeneration()
        #expect(await connection.configuredTLSFingerprintSHA256() == firstFingerprint)

        source.setEndpoint(GatewayConnection.EndpointSnapshot(
            config: (url: url, token: "token", password: nil),
            tls: secondTLS,
            routeAuthority: nil,
            revision: 2))
        try await connection.refresh()

        #expect(await connection._test_routeGeneration() > firstGeneration)
        #expect(await connection.configuredTLSFingerprintSHA256() == secondFingerprint)
        await connection.shutdown()
    }

    @Test func `direct endpoint never receives another route device token`() async throws {
        let urlA = try #require(URL(string: "wss://gateway-a.example"))
        let urlB = try #require(URL(string: "wss://gateway-b.example"))
        let ownerA = try #require(GatewayDiscoveryPreferences.deviceAuthGatewayID(
            connectionMode: .remote,
            remoteTransport: .direct,
            remoteURL: urlA.absoluteString,
            remoteTarget: ""))
        let ownerB = try #require(GatewayDiscoveryPreferences.deviceAuthGatewayID(
            connectionMode: .remote,
            remoteTransport: .direct,
            remoteURL: urlB.absoluteString,
            remoteTarget: ""))

        try await self.assertDeviceTokenIsolation(
            routeA: (urlA, ownerA),
            routeB: (urlB, ownerB))
    }

    @Test func `SSH endpoint never receives another route device token`() async throws {
        let tunnelURL = try #require(URL(string: "ws://127.0.0.1:18789"))
        let ownerA = try #require(GatewayDiscoveryPreferences.deviceAuthGatewayID(
            connectionMode: .remote,
            remoteTransport: .ssh,
            remoteURL: "",
            remoteTarget: "operator@gateway-a.example"))
        let ownerB = try #require(GatewayDiscoveryPreferences.deviceAuthGatewayID(
            connectionMode: .remote,
            remoteTransport: .ssh,
            remoteURL: "",
            remoteTarget: "operator@gateway-b.example"))

        try await self.assertDeviceTokenIsolation(
            routeA: (tunnelURL, ownerA),
            routeB: (tunnelURL, ownerB))
    }

    @Test func `retired socket callbacks cannot mutate cache or subscribers`() async {
        let (connection, _) = makeTestGatewayConnection()
        let routeGeneration = await connection._test_routeGeneration()
        let stream = await connection.subscribe(bufferingNewest: 10)
        var iterator = stream.makeAsyncIterator()

        await connection._test_handlePush(
            .snapshot(makeGatewayGenerationSnapshot(version: "socket-1")),
            routeGeneration: routeGeneration,
            socketGeneration: 1)
        await connection._test_handleDisconnect(
            routeGeneration: routeGeneration,
            socketGeneration: 1)
        #expect(await connection.cachedGatewayVersion() == nil)

        await connection._test_handlePush(
            .snapshot(makeGatewayGenerationSnapshot(version: "stale-socket-1")),
            routeGeneration: routeGeneration,
            socketGeneration: 1)
        await connection._test_handlePush(
            .snapshot(makeGatewayGenerationSnapshot(version: "socket-2")),
            routeGeneration: routeGeneration,
            socketGeneration: 2)
        await connection._test_handlePush(
            .snapshot(makeGatewayGenerationSnapshot(version: "late-socket-1")),
            routeGeneration: routeGeneration,
            socketGeneration: 1)

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
            socketGeneration: 1)
        await connection._test_handlePush(
            .snapshot(makeGatewayGenerationSnapshot(version: "current-route")),
            routeGeneration: currentRouteGeneration,
            socketGeneration: 1)

        let push = await iterator.next()
        #expect(gatewayGenerationSnapshotVersion(push) == "current-route")
        #expect(await connection.cachedGatewayVersion() == "current-route")
        await connection.shutdown()
    }

    @Test func `older reconfigure cannot install after newer route`() async throws {
        let initialURL = try #require(URL(string: "ws://route-a.invalid"))
        let (source, gate, connection) = makeRouteLifecycleConnection(url: initialURL)
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
        let (source, gate, connection) = makeRouteLifecycleConnection(
            url: initialURL,
            token: "same-token",
            password: "same-password")
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
        let (source, gate, connection) = makeRouteLifecycleConnection(
            url: initialURL,
            token: "same-token",
            password: "same-password")
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
        await assertConfigLookupCannotRecreateRoute(url: url, operation: .request)
    }

    @Test func `refresh suspended in config lookup cannot recreate route after shutdown`() async throws {
        let url = try #require(URL(string: "ws://stale-refresh.invalid"))
        await assertConfigLookupCannotRecreateRoute(url: url, operation: .refresh)
    }

    @Test func `capture route suspended in config lookup cannot recreate route after shutdown`() async throws {
        let url = try #require(URL(string: "ws://stale-capture.invalid"))
        await assertConfigLookupCannotRecreateRoute(url: url, operation: .captureRoute)
    }

    @Test func `older shutdown cannot clear newer route`() async throws {
        let initialURL = try #require(URL(string: "ws://route-a.invalid"))
        let (source, gate, connection) = makeRouteLifecycleConnection(url: initialURL)
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
        let result = await connection.sendAgent(GatewayAgentInvocation(
            message: "",
            sessionKey: "main",
            thinking: nil,
            deliver: false,
            to: nil,
            channel: .last))
        #expect(result.ok == false)
    }

    @Test func `send agent keeps empty voice wake trigger field`() async throws {
        let (connection, recorder) = makeRecordingGatewayConnection {
            GatewayWebSocketTestSupport.okResponseData(id: $0)
        }
        let result = await connection.sendAgent(GatewayAgentInvocation(
            message: "test",
            sessionKey: "main",
            thinking: nil,
            deliver: false,
            to: nil,
            channel: .last,
            timeoutSeconds: nil,
            idempotencyKey: "idem-1",
            voiceWakeTrigger: "   "))
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
        let (connection, recorder) = makeRecordingGatewayConnection {
            Self.chatSendOkResponseData(id: $0)
        }

        _ = try await connection.chatSend(
            sessionKey: "main",
            expectedSessionRoutingContract: "per-sender|main|main",
            message: "hello",
            thinking: nil,
            idempotencyKey: "chat-1",
            attachments: [])
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
            "openai/gpt-5.5"),
        (
            #"{"defaultId":"work","mainKey":"main","scope":"per-sender","agents":[{"id":"main","model":{"primary":"openai/gpt-5.5"}},{"id":"work","model":{"primary":"anthropic/claude-opus-4-8"}}]}"#,
            "anthropic/claude-opus-4-8"),
        (
            #"{"defaultId":"main","mainKey":"main","scope":"per-sender","agents":[{"id":"main"},{"id":"work","model":{"primary":"openai/gpt-5.5"}}]}"#,
            nil),
        (
            #"{"defaultId":"main","mainKey":"main","scope":"per-sender","agents":[{"id":"main","model":{"primary":"   "}}]}"#,
            nil),
    ])
    func `configured inference model follows the default agent`(
        json: String,
        expected: String?) throws
    {
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

    @MainActor
    private func withIsolatedRecoveryFixture<T>(
        _ sendHook: @escaping GatewayTestWebSocketTask.SendHook,
        operation: (GatewayConnection, GatewayTestWebSocketSession) async throws -> T) async throws -> T
    {
        let isolatedState = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-gateway-recovery-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: isolatedState, withIntermediateDirectories: true)
        let configURL = isolatedState.appendingPathComponent("openclaw.json")
        let port = Int.random(in: 30000...59999)
        try Data(#"{"gateway":{"mode":"local","port":\#(port)}}"#.utf8).write(to: configURL)
        defer { try? FileManager.default.removeItem(at: isolatedState) }

        // Profiles and their reserved ports live for the process; a temporary
        // profile here would permanently change later tests' ownership checks.
        return try await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": configURL.path,
            "OPENCLAW_STATE_DIR": isolatedState.path,
        ]) {
            try await DeviceIdentityStore.withStateDirectory(isolatedState) {
                let session = GatewayTestWebSocketSession(taskFactory: {
                    GatewayTestWebSocketTask(sendHook: sendHook)
                })
                let connection = GatewayConnection(
                    endpointProvider: {
                        GatewayConnection.EndpointSnapshot(
                            config: (url: URL(string: "ws://127.0.0.1:\(port)")!, token: nil, password: nil),
                            routeAuthority: nil)
                    },
                    supportsSharedEndpointRecovery: true,
                    activationBindingKeyProvider: { nil },
                    sessionBox: WebSocketSessionBox(session: session))
                let manager = GatewayProcessManager.shared
                let priorMode = AppStateStore.shared.connectionMode
                AppStateStore.shared.connectionMode = .local
                manager._testResetGatewayStartTask()
                manager.setTestingStatus(.stopped)
                manager.setTestingConnection(connection)
                manager.setTestingSkipControlChannelRefresh(true)
                GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(
                    isolatedState.appendingPathComponent("disable-launch-agent"))
                GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(true)
                GatewayLaunchAgentManager.setTestingDaemonStatusPayload(
                    #"{"ok":true,"service":{"loaded":false}}"#)
                GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
                defer {
                    manager._testResetGatewayStartTask()
                    manager.setTestingStatus(.stopped)
                    manager.setTestingConnection(nil)
                    manager.setTestingSkipControlChannelRefresh(false)
                    manager.setTestingDesiredActive(false)
                    GatewayLaunchAgentManager.setTestingDisableLaunchAgentMarkerURL(nil)
                    GatewayLaunchAgentManager.setTestingInterceptDaemonCommands(false)
                    GatewayLaunchAgentManager.setTestingDaemonStatusPayload(nil)
                    GatewayLaunchAgentManager.clearTestingDaemonCommandCalls()
                    AppStateStore.shared.connectionMode = priorMode
                }

                do {
                    let result = try await operation(connection, session)
                    await connection.shutdown()
                    return result
                } catch {
                    await connection.shutdown()
                    throw error
                }
            }
        }
    }

    @MainActor
    private func assertUncancelledFailureRecovers(_ failure: any Error & Sendable) async throws {
        let requests = WebSocketMessageRecorder()
        try await self.withIsolatedRecoveryFixture { socket, message, sendIndex in
            guard sendIndex > 0,
                  let id = GatewayWebSocketTestSupport.requestID(from: message),
                  let data = Self.messageData(message),
                  let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return }
            if frame["method"] as? String == "status" {
                requests.append(message)
                if requests.snapshot().count == 1 {
                    throw failure
                }
            }
            socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
        } operation: { connection, session in
            _ = try await connection.request(method: "status", params: nil)

            #expect(GatewayProcessManager.shared.status != .stopped)
            #expect(requests.snapshot().count == 2)
            #expect(session.snapshotMakeCount() >= 1)
        }
    }

    private func waitForRequest(on session: GatewayTestWebSocketSession) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(2)
        while ContinuousClock.now < deadline {
            if session.latestTask()?.snapshotSendCount() ?? 0 >= 2 {
                return true
            }
            try? await Task.sleep(for: .milliseconds(2))
        }
        return false
    }

    private func assertDeviceTokenIsolation(
        routeA: (url: URL, owner: String),
        routeB: (url: URL, owner: String)) async throws
    {
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
                unscopedToken: unscopedToken)
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
        unscopedToken: String? = nil) async throws -> [String: Any]?
    {
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
                        token: unscopedToken),
                        DeviceAuthStore.storeTokenPersisted(
                            deviceId: identity.deviceId,
                            role: "operator",
                            token: storedDeviceToken,
                            gatewayID: route.owner)
                    else {
                        throw NSError(
                            domain: "GatewayConnectionControlTests",
                            code: 1,
                            userInfo: [NSLocalizedDescriptionKey: "failed to persist device auth fixture"])
                    }
                }
                return GatewayConnection.EndpointSnapshot(
                    config: (url: route.url, token: nil, password: nil),
                    routeAuthority: nil,
                    deviceAuthGatewayID: route.owner)
            },
            supportsSharedEndpointRecovery: false,
            activationBindingKeyProvider: { nil },
            sessionBox: WebSocketSessionBox(session: session))
        _ = try await connection.request(
            method: "health",
            params: nil,
            retryTransportFailures: false)
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
