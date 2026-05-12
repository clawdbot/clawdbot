import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct GatewayChannelConnectTests {
    private final class ConnectParamsRecorder: @unchecked Sendable {
        private let lock = NSLock()
        private var params: [String: Any]?

        func record(_ message: URLSessionWebSocketTask.Message) {
            guard let params = GatewayWebSocketTestSupport.connectRequestParams(from: message) else {
                return
            }
            self.lock.lock()
            self.params = params
            self.lock.unlock()
        }

        func snapshot() -> [String: Any]? {
            self.lock.lock()
            defer { self.lock.unlock() }
            return self.params
        }
    }

    private final class ScopeCapture: @unchecked Sendable {
        private let lock = NSLock()
        private var scopes: [String]?

        func set(_ scopes: [String]?) {
            self.lock.lock()
            self.scopes = scopes
            self.lock.unlock()
        }

        func snapshot() -> [String]? {
            self.lock.lock()
            defer { self.lock.unlock() }
            return self.scopes
        }
    }

    private final class TLSFailureSession: WebSocketSessioning, GatewayTLSFailureProviding, @unchecked Sendable {
        private var failure: GatewayTLSValidationFailure?

        init(failure: GatewayTLSValidationFailure) {
            self.failure = failure
        }

        func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
            _ = url
            let task = GatewayTestWebSocketTask(receiveHook: { _, receiveIndex in
                if receiveIndex == 0 {
                    return .data(GatewayWebSocketTestSupport.connectChallengeData())
                }
                throw URLError(.userCancelledAuthentication)
            })
            return WebSocketTaskBox(task: task)
        }

        func consumeLastTLSFailure() -> GatewayTLSValidationFailure? {
            defer { self.failure = nil }
            return self.failure
        }
    }

    private enum FakeResponse {
        case helloOk(delayMs: Int)
        case invalid(delayMs: Int)
        case authFailed(
            delayMs: Int,
            detailCode: String,
            canRetryWithDeviceToken: Bool,
            recommendedNextStep: String?)
    }

    private func makeSession(response: FakeResponse) -> GatewayTestWebSocketSession {
        GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(
                    receiveHook: { task, receiveIndex in
                        if receiveIndex == 0 {
                            return .data(GatewayWebSocketTestSupport.connectChallengeData())
                        }
                        let delayMs: Int
                        let message: URLSessionWebSocketTask.Message
                        switch response {
                        case let .helloOk(ms):
                            delayMs = ms
                            let id = task.snapshotConnectRequestID() ?? "connect"
                            message = .data(GatewayWebSocketTestSupport.connectOkData(id: id))
                        case let .invalid(ms):
                            delayMs = ms
                            message = .string("not json")
                        case let .authFailed(ms, detailCode, canRetryWithDeviceToken, recommendedNextStep):
                            delayMs = ms
                            let id = task.snapshotConnectRequestID() ?? "connect"
                            message = .data(GatewayWebSocketTestSupport.connectAuthFailureData(
                                id: id,
                                detailCode: detailCode,
                                canRetryWithDeviceToken: canRetryWithDeviceToken,
                                recommendedNextStep: recommendedNextStep))
                        }
                        try await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
                        return message
                    })
            })
    }

    private func withTemporaryStateDir<T>(_ operation: () async throws -> T) async throws -> T {
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
        return try await operation()
    }

    @Test func `concurrent connect is single flight on success`() async throws {
        let session = self.makeSession(response: .helloOk(delayMs: 200))
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session))

        let t1 = Task { try await channel.connect() }
        let t2 = Task { try await channel.connect() }

        _ = try await t1.value
        _ = try await t2.value

        #expect(session.snapshotMakeCount() == 1)
    }

    @Test func `connect advertises compatible protocol range`() async throws {
        let recorder = ConnectParamsRecorder()
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(
                    sendHook: { _, message, sendIndex in
                        guard sendIndex == 0 else { return }
                        recorder.record(message)
                    })
            })
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session))

        try await channel.connect()

        let params = try #require(recorder.snapshot())
        #expect(params["minProtocol"] as? Int == GATEWAY_MIN_PROTOCOL_VERSION)
        #expect(params["maxProtocol"] as? Int == GATEWAY_PROTOCOL_VERSION)
    }

    @Test func `concurrent connect shares failure`() async throws {
        let session = self.makeSession(response: .invalid(delayMs: 200))
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session))

        let t1 = Task { try await channel.connect() }
        let t2 = Task { try await channel.connect() }

        let r1 = await t1.result
        let r2 = await t2.result

        #expect({
            if case .failure = r1 { true } else { false }
        }())
        #expect({
            if case .failure = r2 { true } else { false }
        }())
        #expect(session.snapshotMakeCount() == 1)
    }

    @Test func `default operator connect scopes preserve pairing and admin`() async throws {
        try await self.withTemporaryStateDir {
            let capture = ScopeCapture()
            let session = GatewayTestWebSocketSession(
                taskFactory: {
                    GatewayTestWebSocketTask(sendHook: { _, message, sendIndex in
                        if sendIndex == 0 {
                            capture.set(GatewayWebSocketTestSupport.connectScopes(from: message))
                        }
                    })
                })
            let channel = try GatewayChannelActor(
                url: #require(URL(string: "ws://example.invalid")),
                token: nil,
                session: WebSocketSessionBox(session: session))

            try await channel.connect()

            #expect(capture.snapshot() == [
                "operator.admin",
                "operator.read",
                "operator.write",
                "operator.approvals",
                "operator.pairing",
            ])
        }
    }

    @Test func `bootstrap token connect scopes are bootstrap-compatible`() async throws {
        let capture = ScopeCapture()
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(sendHook: { _, message, sendIndex in
                    if sendIndex == 0 {
                        capture.set(GatewayWebSocketTestSupport.connectScopes(from: message))
                    }
                })
            })
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            bootstrapToken: "setup-bootstrap-token",
            session: WebSocketSessionBox(session: session))

        try await channel.connect()

        #expect(capture.snapshot() == [
            "operator.approvals",
            "operator.read",
            "operator.write",
        ])
    }

    @Test func `stored device token connect scopes reuse cached scopes`() async throws {
        try await self.withTemporaryStateDir {
            let identity = DeviceIdentityStore.loadOrCreate()
            let storedEntry = DeviceAuthStore.storeToken(
                deviceId: identity.deviceId,
                role: "operator",
                token: "bootstrap-device-token",
                scopes: ["operator.read", "operator.write", "operator.approvals"])
            let capture = ScopeCapture()
            let session = GatewayTestWebSocketSession(
                taskFactory: {
                    GatewayTestWebSocketTask(sendHook: { _, message, sendIndex in
                        if sendIndex == 0 {
                            capture.set(GatewayWebSocketTestSupport.connectScopes(from: message))
                        }
                    })
                })
            let channel = try GatewayChannelActor(
                url: #require(URL(string: "ws://example.invalid")),
                token: nil,
                session: WebSocketSessionBox(session: session))

            try await channel.connect()

            #expect(capture.snapshot() == storedEntry.scopes)
        }
    }

    @Test func `explicit device token connect scopes preserve requested scopes`() async throws {
        try await self.withTemporaryStateDir {
            let identity = DeviceIdentityStore.loadOrCreate()
            _ = DeviceAuthStore.storeToken(
                deviceId: identity.deviceId,
                role: "operator",
                token: "bootstrap-device-token",
                scopes: ["operator.read", "operator.write", "operator.approvals"])
            let requestedScopes = ["operator.admin", "operator.pairing"]
            let capture = ScopeCapture()
            let session = GatewayTestWebSocketSession(
                taskFactory: {
                    GatewayTestWebSocketTask(sendHook: { _, message, sendIndex in
                        if sendIndex == 0 {
                            capture.set(GatewayWebSocketTestSupport.connectScopes(from: message))
                        }
                    })
                })
            let channel = try GatewayChannelActor(
                url: #require(URL(string: "ws://example.invalid")),
                token: nil,
                session: WebSocketSessionBox(session: session),
                connectOptions: GatewayConnectOptions(
                    role: "operator",
                    scopes: requestedScopes,
                    scopesAreExplicit: true,
                    caps: [],
                    commands: [],
                    permissions: [:],
                    clientId: "openclaw-macos",
                    clientMode: "ui",
                    clientDisplayName: "OpenClaw macOS Debug CLI"))

            try await channel.connect()

            #expect(capture.snapshot() == requestedScopes)
        }
    }

    @Test func `connect surfaces structured auth failure`() async throws {
        let session = self.makeSession(response: .authFailed(
            delayMs: 0,
            detailCode: GatewayConnectAuthDetailCode.authTokenMissing.rawValue,
            canRetryWithDeviceToken: true,
            recommendedNextStep: GatewayConnectRecoveryNextStep.updateAuthConfiguration.rawValue))
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session))

        do {
            try await channel.connect()
            Issue.record("expected GatewayConnectAuthError")
        } catch let error as GatewayConnectAuthError {
            #expect(error.detail == .authTokenMissing)
            #expect(error.detailCode == GatewayConnectAuthDetailCode.authTokenMissing.rawValue)
            #expect(error.canRetryWithDeviceToken)
            #expect(error.recommendedNextStep == .updateAuthConfiguration)
            #expect(error.recommendedNextStepCode == GatewayConnectRecoveryNextStep.updateAuthConfiguration.rawValue)
        } catch {
            Issue.record("unexpected error: \(error)")
        }
    }

    @Test func `connect maps user cancelled authentication with cached TLS failure`() async throws {
        let failure = GatewayTLSValidationFailure(
            kind: .pinMismatch,
            host: "gateway.example.ts.net",
            storeKey: "gateway.example.ts.net:443",
            expectedFingerprint: "old",
            observedFingerprint: "new",
            systemTrustOk: true)
        let session = TLSFailureSession(failure: failure)
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "wss://gateway.example.ts.net")),
            token: nil,
            session: WebSocketSessionBox(session: session))

        do {
            try await channel.connect()
            Issue.record("expected GatewayTLSValidationError")
        } catch let error as GatewayTLSValidationError {
            #expect(error.failure == failure)
        } catch {
            Issue.record("unexpected error: \(error)")
        }
    }
}
