import Foundation
import Testing
@testable import OpenClawKit
import OpenClawProtocol

private extension NSLock {
    func withLock<T>(_ body: () -> T) -> T {
        self.lock()
        defer { self.unlock() }
        return body()
    }
}

private final class FakeGatewayWebSocketTask: WebSocketTasking, @unchecked Sendable {
    private let lock = NSLock()
    private let helloAuth: [String: Any]?
    private var _state: URLSessionTask.State = .suspended
    private var connectRequestId: String?
    private var connectAuth: [String: Any]?
    private var receivePhase = 0
    private var pendingReceiveHandler:
        (@Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)?

    init(helloAuth: [String: Any]? = nil) {
        self.helloAuth = helloAuth
    }

    var state: URLSessionTask.State {
        get { self.lock.withLock { self._state } }
        set { self.lock.withLock { self._state = newValue } }
    }

    func resume() {
        self.state = .running
    }

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        _ = (closeCode, reason)
        self.state = .canceling
        let handler = self.lock.withLock { () -> (@Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)? in
            defer { self.pendingReceiveHandler = nil }
            return self.pendingReceiveHandler
        }
        handler?(Result<URLSessionWebSocketTask.Message, Error>.failure(URLError(.cancelled)))
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        let data: Data? = switch message {
        case let .data(d): d
        case let .string(s): s.data(using: .utf8)
        @unknown default: nil
        }
        guard let data else { return }
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           obj["type"] as? String == "req",
           obj["method"] as? String == "connect",
           let id = obj["id"] as? String
        {
            let auth = ((obj["params"] as? [String: Any])?["auth"] as? [String: Any]) ?? [:]
            self.lock.withLock {
                self.connectRequestId = id
                self.connectAuth = auth
            }
        }
    }

    func latestConnectAuth() -> [String: Any]? {
        self.lock.withLock { self.connectAuth }
    }

    func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void) {
        pongReceiveHandler(nil)
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        let phase = self.lock.withLock { () -> Int in
            let current = self.receivePhase
            self.receivePhase += 1
            return current
        }
        if phase == 0 {
            return .data(Self.connectChallengeData(nonce: "nonce-1"))
        }
        for _ in 0..<50 {
            let id = self.lock.withLock { self.connectRequestId }
            if let id {
                return .data(Self.connectOkData(id: id, auth: self.helloAuth))
            }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        return .data(Self.connectOkData(id: "connect", auth: self.helloAuth))
    }

    func receive(
        completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
    {
        self.lock.withLock { self.pendingReceiveHandler = completionHandler }
    }

    func emitReceiveFailure() {
        let handler = self.lock.withLock { () -> (@Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)? in
            self._state = .canceling
            defer { self.pendingReceiveHandler = nil }
            return self.pendingReceiveHandler
        }
        handler?(Result<URLSessionWebSocketTask.Message, Error>.failure(URLError(.networkConnectionLost)))
    }

    private static func connectChallengeData(nonce: String) -> Data {
        let frame: [String: Any] = [
            "type": "event",
            "event": "connect.challenge",
            "payload": ["nonce": nonce],
        ]
        return (try? JSONSerialization.data(withJSONObject: frame)) ?? Data()
    }

    private static func connectOkData(id: String, auth: [String: Any]? = nil) -> Data {
        var payload: [String: Any] = [
            "type": "hello-ok",
            "protocol": 2,
            "server": [
                "version": "test",
                "connId": "test",
            ],
            "features": [
                "methods": [],
                "events": [],
            ],
            "snapshot": [
                "presence": [["ts": 1]],
                "health": [:],
                "stateVersion": [
                    "presence": 0,
                    "health": 0,
                ],
                "uptimeMs": 0,
            ],
            "policy": [
                "maxPayload": 1,
                "maxBufferedBytes": 1,
                "tickIntervalMs": 30_000,
            ],
            "auth": [:],
        ]
        if let auth {
            payload["auth"] = auth
        }
        let frame: [String: Any] = [
            "type": "res",
            "id": id,
            "ok": true,
            "payload": payload,
        ]
        return (try? JSONSerialization.data(withJSONObject: frame)) ?? Data()
    }
}

private final class FakeGatewayWebSocketSession: WebSocketSessioning, @unchecked Sendable {
    private let lock = NSLock()
    private let helloAuth: [String: Any]?
    private var tasks: [FakeGatewayWebSocketTask] = []
    private var makeCount = 0

    init(helloAuth: [String: Any]? = nil) {
        self.helloAuth = helloAuth
    }

    func snapshotMakeCount() -> Int {
        self.lock.withLock { self.makeCount }
    }

    func latestTask() -> FakeGatewayWebSocketTask? {
        self.lock.withLock { self.tasks.last }
    }

    func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
        _ = url
        return self.lock.withLock {
            self.makeCount += 1
            let task = FakeGatewayWebSocketTask(helloAuth: self.helloAuth)
            self.tasks.append(task)
            return WebSocketTaskBox(task: task)
        }
    }
}

private actor SeqGapProbe {
    private var saw = false
    func mark() { self.saw = true }
    func value() -> Bool { self.saw }
}

@Suite(.serialized)
struct GatewayNodeSessionTests {
    @Test
    func scannedSetupCodePrefersBootstrapAuthOverStoredDeviceToken() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let previousStateDir = ProcessInfo.processInfo.environment["OPENCLAW_STATE_DIR"]
        setenv("OPENCLAW_STATE_DIR", tempDir.path, 1)
        defer {
            if let previousStateDir {
                setenv("OPENCLAW_STATE_DIR", previousStateDir, 1)
            } else {
                unsetenv("OPENCLAW_STATE_DIR")
            }
            try? FileManager.default.removeItem(at: tempDir)
        }

        let identity = DeviceIdentityStore.loadOrCreate()
        _ = DeviceAuthStore.storeToken(
            deviceId: identity.deviceId,
            role: "operator",
            token: "stored-device-token")

        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "operator",
            scopes: ["operator.read"],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "ui",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: true)

        try await gateway.connect(
            url: URL(string: "ws://example.invalid")!,
            token: nil,
            bootstrapToken: "fresh-bootstrap-token",
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        let auth = try #require(session.latestTask()?.latestConnectAuth())
        #expect(auth["bootstrapToken"] as? String == "fresh-bootstrap-token")
        #expect(auth["token"] == nil)
        #expect(auth["deviceToken"] == nil)

        await gateway.disconnect()
    }

    @Test
    func passwordTakesPrecedenceOverBootstrapToken() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "operator",
            scopes: ["operator.read"],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "ui",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: URL(string: "ws://example.invalid")!,
            token: nil,
            bootstrapToken: "stale-bootstrap-token",
            password: "shared-password",
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        let auth = try #require(session.latestTask()?.latestConnectAuth())
        #expect(auth["password"] as? String == "shared-password")
        #expect(auth["bootstrapToken"] == nil)
        #expect(auth["token"] == nil)

        await gateway.disconnect()
    }

    @Test
    func changedSessionBoxRebuildsExistingGatewayChannel() async throws {
        let firstSession = FakeGatewayWebSocketSession()
        let secondSession = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: URL(string: "wss://example.invalid")!,
            token: "shared-token",
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: firstSession),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        try await gateway.connect(
            url: URL(string: "wss://example.invalid")!,
            token: "shared-token",
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: secondSession),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        #expect(firstSession.snapshotMakeCount() == 1)
        #expect(secondSession.snapshotMakeCount() == 1)

        await gateway.disconnect()
    }

    @Test
    func bootstrapHelloStoresAdditionalDeviceTokens() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let previousStateDir = ProcessInfo.processInfo.environment["OPENCLAW_STATE_DIR"]
        setenv("OPENCLAW_STATE_DIR", tempDir.path, 1)
        defer {
            if let previousStateDir {
                setenv("OPENCLAW_STATE_DIR", previousStateDir, 1)
            } else {
                unsetenv("OPENCLAW_STATE_DIR")
            }
            try? FileManager.default.removeItem(at: tempDir)
        }

        let identity = DeviceIdentityStore.loadOrCreate()
        let session = FakeGatewayWebSocketSession(helloAuth: [
            "deviceToken": "node-device-token",
            "role": "node",
            "scopes": [],
            "issuedAtMs": 1000,
            "deviceTokens": [
                [
                    "deviceToken": "operator-device-token",
                    "role": "operator",
                    "scopes": [
                        "node.exec",
                        "operator.admin",
                        "operator.approvals",
                        "operator.pairing",
                        "operator.read",
                        "operator.talk.secrets",
                        "operator.write",
                    ],
                    "issuedAtMs": 1001,
                ],
            ],
        ])
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: true)

        try await gateway.connect(
            url: URL(string: "wss://example.invalid")!,
            token: nil,
            bootstrapToken: "fresh-bootstrap-token",
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        let nodeEntry = try #require(DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "node"))
        let operatorEntry = try #require(DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "operator"))
        #expect(nodeEntry.token == "node-device-token")
        #expect(nodeEntry.scopes == [])
        #expect(operatorEntry.token == "operator-device-token")
        #expect(operatorEntry.scopes == [
            "operator.approvals",
            "operator.read",
            "operator.talk.secrets",
            "operator.write",
        ])

        await gateway.disconnect()
    }

    @Test
    func nonBootstrapHelloStoresPrimaryDeviceTokenButNotAdditionalBootstrapTokens() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let previousStateDir = ProcessInfo.processInfo.environment["OPENCLAW_STATE_DIR"]
        setenv("OPENCLAW_STATE_DIR", tempDir.path, 1)
        defer {
            if let previousStateDir {
                setenv("OPENCLAW_STATE_DIR", previousStateDir, 1)
            } else {
                unsetenv("OPENCLAW_STATE_DIR")
            }
            try? FileManager.default.removeItem(at: tempDir)
        }

        let identity = DeviceIdentityStore.loadOrCreate()
        let session = FakeGatewayWebSocketSession(helloAuth: [
            "deviceToken": "server-node-token",
            "role": "node",
            "scopes": [],
            "deviceTokens": [
                [
                    "deviceToken": "server-operator-token",
                    "role": "operator",
                    "scopes": ["operator.admin"],
                ],
            ],
        ])
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: true)

        try await gateway.connect(
            url: URL(string: "wss://example.invalid")!,
            token: "shared-token",
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        let nodeEntry = try #require(DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "node"))
        #expect(nodeEntry.token == "server-node-token")
        #expect(nodeEntry.scopes == [])
        #expect(DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "operator") == nil)

        await gateway.disconnect()
    }

    @Test
    func untrustedBootstrapHelloDoesNotPersistBootstrapHandoffTokens() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let previousStateDir = ProcessInfo.processInfo.environment["OPENCLAW_STATE_DIR"]
        setenv("OPENCLAW_STATE_DIR", tempDir.path, 1)
        defer {
            if let previousStateDir {
                setenv("OPENCLAW_STATE_DIR", previousStateDir, 1)
            } else {
                unsetenv("OPENCLAW_STATE_DIR")
            }
            try? FileManager.default.removeItem(at: tempDir)
        }

        let identity = DeviceIdentityStore.loadOrCreate()
        let session = FakeGatewayWebSocketSession(helloAuth: [
            "deviceToken": "untrusted-node-token",
            "role": "node",
            "scopes": [],
            "deviceTokens": [
                [
                    "deviceToken": "untrusted-operator-token",
                    "role": "operator",
                    "scopes": [
                        "operator.approvals",
                        "operator.read",
                    ],
                ],
            ],
        ])
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: true)

        try await gateway.connect(
            url: URL(string: "ws://example.invalid")!,
            token: nil,
            bootstrapToken: "fresh-bootstrap-token",
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        #expect(DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "node") == nil)
        #expect(DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "operator") == nil)

        await gateway.disconnect()
    }

    @Test
    func normalizeCanvasHostUrlPreservesExplicitSecureCanvasPort() {
        let normalized = canonicalizeCanvasHostUrl(
            raw: "https://canvas.example.com:9443/__openclaw__/cap/token",
            activeURL: URL(string: "wss://gateway.example.com")!)

        #expect(normalized == "https://canvas.example.com:9443/__openclaw__/cap/token")
    }

    @Test
    func normalizeCanvasHostUrlBackfillsGatewayHostForLoopbackCanvas() {
        let normalized = canonicalizeCanvasHostUrl(
            raw: "http://127.0.0.1:18789/__openclaw__/cap/token",
            activeURL: URL(string: "wss://gateway.example.com:7443")!)

        #expect(normalized == "https://gateway.example.com:7443/__openclaw__/cap/token")
    }

    @Test
    func invokeWithTimeoutReturnsUnderlyingResponseBeforeTimeout() async {
        let request = BridgeInvokeRequest(id: "1", command: "x", paramsJSON: nil)
        let response = await GatewayNodeSession.invokeWithTimeout(
            request: request,
            timeoutMs: 50,
            onInvoke: { req in
                #expect(req.id == "1")
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: "{}", error: nil)
            }
        )

        #expect(response.ok == true)
        #expect(response.error == nil)
        #expect(response.payloadJSON == "{}")
    }

    @Test
    func invokeWithTimeoutReturnsTimeoutError() async {
        let request = BridgeInvokeRequest(id: "abc", command: "x", paramsJSON: nil)
        let response = await GatewayNodeSession.invokeWithTimeout(
            request: request,
            timeoutMs: 10,
            onInvoke: { _ in
                try? await Task.sleep(nanoseconds: 200_000_000) // 200ms
                return BridgeInvokeResponse(id: "abc", ok: true, payloadJSON: "{}", error: nil)
            }
        )

        #expect(response.ok == false)
        #expect(response.error?.code == .unavailable)
        #expect(response.error?.message.contains("timed out") == true)
    }

    @Test
    func invokeWithTimeoutZeroDisablesTimeout() async {
        let request = BridgeInvokeRequest(id: "1", command: "x", paramsJSON: nil)
        let response = await GatewayNodeSession.invokeWithTimeout(
            request: request,
            timeoutMs: 0,
            onInvoke: { req in
                try? await Task.sleep(nanoseconds: 5_000_000)
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            }
        )

        #expect(response.ok == true)
        #expect(response.error == nil)
    }

    @Test
    func emitsSyntheticSeqGapAfterReconnectSnapshot() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "operator",
            scopes: ["operator.read"],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "ui",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: false)

        let stream = await gateway.subscribeServerEvents(bufferingNewest: 32)
        let probe = SeqGapProbe()
        let listenTask = Task {
            for await evt in stream {
                if evt.event == "seqGap" {
                    await probe.mark()
                    return
                }
            }
        }

        try await gateway.connect(
            url: URL(string: "ws://example.invalid")!,
            token: nil,
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        let firstTask = try #require(session.latestTask())
        firstTask.emitReceiveFailure()

        try await waitUntil("reconnect socket created") {
            session.snapshotMakeCount() >= 2
        }
        try await waitUntil("synthetic seqGap broadcast") {
            await probe.value()
        }

        listenTask.cancel()
        await gateway.disconnect()
    }
}
