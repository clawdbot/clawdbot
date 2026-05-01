import Foundation
import OpenClawKit
import Testing

private extension NSLock {
    func withDeviceRetryLock<T>(_ body: () -> T) -> T {
        self.lock()
        defer { self.unlock() }
        return body()
    }
}

private final class ConnectAuthRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var auths: [[String: Any]] = []

    func append(from message: URLSessionWebSocketTask.Message) {
        guard let auth = Self.connectAuth(from: message) else { return }
        self.lock.withDeviceRetryLock {
            self.auths.append(auth)
        }
    }

    func auth(at index: Int) -> [String: Any]? {
        self.lock.withDeviceRetryLock {
            guard self.auths.indices.contains(index) else { return nil }
            return self.auths[index]
        }
    }

    private static func connectAuth(from message: URLSessionWebSocketTask.Message) -> [String: Any]? {
        let data: Data? = switch message {
        case let .data(raw):
            raw
        case let .string(text):
            Data(text.utf8)
        @unknown default:
            nil
        }
        guard let data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              json["type"] as? String == "req",
              json["method"] as? String == "connect",
              let params = json["params"] as? [String: Any],
              let auth = params["auth"] as? [String: Any]
        else {
            return nil
        }
        return auth
    }
}

private final class TrustedDeviceRetryGatewaySession: WebSocketSessioning, GatewayDeviceTokenRetryTrustProviding, @unchecked Sendable {
    let allowsDeviceTokenRetryAuth: Bool

    private let lock = NSLock()
    private let recorder: ConnectAuthRecorder
    private var makeCount = 0

    init(recorder: ConnectAuthRecorder, allowsDeviceTokenRetryAuth: Bool) {
        self.recorder = recorder
        self.allowsDeviceTokenRetryAuth = allowsDeviceTokenRetryAuth
    }

    func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
        _ = url
        let attemptIndex = self.lock.withDeviceRetryLock { () -> Int in
            let current = self.makeCount
            self.makeCount += 1
            return current
        }
        let recorder = self.recorder
        let task = GatewayTestWebSocketTask(
            sendHook: { _, message, sendIndex in
                if sendIndex == 0 {
                    recorder.append(from: message)
                }
            },
            receiveHook: { task, receiveIndex in
                if receiveIndex == 0 {
                    return .data(GatewayWebSocketTestSupport.connectChallengeData())
                }
                let id = task.snapshotConnectRequestID() ?? "connect"
                if attemptIndex == 0 {
                    return .data(GatewayWebSocketTestSupport.connectAuthFailureData(
                        id: id,
                        detailCode: GatewayConnectAuthDetailCode.authTokenMismatch.rawValue,
                        canRetryWithDeviceToken: true,
                        recommendedNextStep: GatewayConnectRecoveryNextStep.retryWithDeviceToken.rawValue))
                }
                return .data(GatewayWebSocketTestSupport.connectOkData(id: id))
            })
        return WebSocketTaskBox(task: task)
    }
}

@Suite(.serialized)
struct GatewayChannelDeviceTokenRetryTests {
    @Test func `remote pinned TLS retries stale shared token with stored device token`() async throws {
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

        let recorder = ConnectAuthRecorder()
        let session = TrustedDeviceRetryGatewaySession(
            recorder: recorder,
            allowsDeviceTokenRetryAuth: true)
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
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "wss://gateway.example.com")),
            token: "stale-shared-token",
            session: WebSocketSessionBox(session: session),
            connectOptions: options)

        do {
            try await channel.connect()
            Issue.record("expected stale shared-token connect to fail before device-token retry")
        } catch let error as GatewayConnectAuthError {
            #expect(error.detail == .authTokenMismatch)
        }

        try await channel.connect()

        let firstAuth = try #require(recorder.auth(at: 0))
        #expect(firstAuth["token"] as? String == "stale-shared-token")
        #expect(firstAuth["deviceToken"] == nil)

        let retryAuth = try #require(recorder.auth(at: 1))
        #expect(retryAuth["token"] as? String == "stale-shared-token")
        #expect(retryAuth["deviceToken"] as? String == "stored-device-token")

        await channel.shutdown()
    }
}
