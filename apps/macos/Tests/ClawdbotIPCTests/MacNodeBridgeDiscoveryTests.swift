import Darwin
import Foundation
import Network
import Testing
@testable import Clawdbot

@Suite struct MacNodeBridgeDiscoveryTests {
    @MainActor
    @Test func loopbackBridgePortDefaultsAndOverrides() {
        withEnv("CLAWDBOT_BRIDGE_PORT", value: nil) {
            #expect(MacNodeModeCoordinator.loopbackBridgePort() == 18790)
        }
        withEnv("CLAWDBOT_BRIDGE_PORT", value: "19991") {
            #expect(MacNodeModeCoordinator.loopbackBridgePort() == 19991)
        }
        withEnv("CLAWDBOT_BRIDGE_PORT", value: "not-a-port") {
            #expect(MacNodeModeCoordinator.loopbackBridgePort() == 18790)
        }
    }

    @MainActor
    @Test func probeEndpointSucceedsForOpenPort() async throws {
        let listener = try NWListener(using: .tcp, on: .any)
        listener.newConnectionHandler = { connection in
            connection.cancel()
        }
        listener.start(queue: DispatchQueue(label: "com.clawdbot.tests.bridge-listener"))
        try await waitForListenerReady(listener, timeoutSeconds: 1.0)

        guard let port = listener.port else {
            listener.cancel()
            throw TestError(message: "listener port missing")
        }

        let endpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: port)
        let ok = await MacNodeModeCoordinator.probeEndpoint(endpoint, timeoutSeconds: 0.6)
        listener.cancel()
        #expect(ok == true)
    }

    @MainActor
    @Test func probeEndpointFailsForClosedPort() async throws {
        let port = try reserveEphemeralPort()
        let endpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: port)
        let ok = await MacNodeModeCoordinator.probeEndpoint(endpoint, timeoutSeconds: 0.4)
        #expect(ok == false)
    }

    @MainActor
    @Test func remoteBridgePortUsesMatchingRemoteUrlPort() {
        let configPath = FileManager.default.temporaryDirectory
            .appendingPathComponent("clawdbot-config-\(UUID().uuidString)")
            .appendingPathComponent("clawdbot.json")
            .path

        let defaults = UserDefaults.standard
        let prevTarget = defaults.string(forKey: remoteTargetKey)
        defer {
            if let prevTarget {
                defaults.set(prevTarget, forKey: remoteTargetKey)
            } else {
                defaults.removeObject(forKey: remoteTargetKey)
            }
        }

        withEnv("CLAWDBOT_CONFIG_PATH", value: configPath) {
            withEnv("CLAWDBOT_GATEWAY_PORT", value: "20000") {
                defaults.set("user@bridge.ts.net", forKey: remoteTargetKey)
                ClawdbotConfigFile.saveDict([
                    "gateway": [
                        "remote": [
                            "url": "ws://bridge.ts.net:25000",
                        ],
                    ],
                ])
                #expect(MacNodeModeCoordinator.remoteBridgePort() == 25001)
            }
        }
    }

    @MainActor
    @Test func remoteBridgePortFallsBackWhenRemoteUrlHostMismatch() {
        let configPath = FileManager.default.temporaryDirectory
            .appendingPathComponent("clawdbot-config-\(UUID().uuidString)")
            .appendingPathComponent("clawdbot.json")
            .path

        let defaults = UserDefaults.standard
        let prevTarget = defaults.string(forKey: remoteTargetKey)
        defer {
            if let prevTarget {
                defaults.set(prevTarget, forKey: remoteTargetKey)
            } else {
                defaults.removeObject(forKey: remoteTargetKey)
            }
        }

        withEnv("CLAWDBOT_CONFIG_PATH", value: configPath) {
            withEnv("CLAWDBOT_GATEWAY_PORT", value: "20000") {
                defaults.set("user@other.ts.net", forKey: remoteTargetKey)
                ClawdbotConfigFile.saveDict([
                    "gateway": [
                        "remote": [
                            "url": "ws://bridge.ts.net:25000",
                        ],
                    ],
                ])
                #expect(MacNodeModeCoordinator.remoteBridgePort() == 20001)
            }
        }
    }
}

private struct TestError: Error {
    let message: String
}

private struct ListenerTimeoutError: Error {}

private func waitForListenerReady(_ listener: NWListener, timeoutSeconds: Double) async throws {
    try await withThrowingTaskGroup(of: Void.self) { group in
        group.addTask {
            try await withCheckedThrowingContinuation { cont in
                final class ListenerState: @unchecked Sendable {
                    let lock = NSLock()
                    var finished = false
                }
                let state = ListenerState()
                let finish: @Sendable (Result<Void, Error>) -> Void = { result in
                    state.lock.lock()
                    defer { state.lock.unlock() }
                    guard !state.finished else { return }
                    state.finished = true
                    cont.resume(with: result)
                }

                listener.stateUpdateHandler = { state in
                    switch state {
                    case .ready:
                        finish(.success(()))
                    case let .failed(err):
                        finish(.failure(err))
                    case .cancelled:
                        finish(.failure(ListenerTimeoutError()))
                    default:
                        break
                    }
                }
            }
        }
        group.addTask {
            try await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
            throw ListenerTimeoutError()
        }
        _ = try await group.next()
        group.cancelAll()
    }
}

private func withEnv(_ key: String, value: String?, _ body: () -> Void) {
    let existing = getenv(key).map { String(cString: $0) }
    if let value {
        setenv(key, value, 1)
    } else {
        unsetenv(key)
    }
    defer {
        if let existing {
            setenv(key, existing, 1)
        } else {
            unsetenv(key)
        }
    }
    body()
}

private func reserveEphemeralPort() throws -> NWEndpoint.Port {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    if fd < 0 {
        throw TestError(message: "socket failed")
    }
    defer { close(fd) }

    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = in_port_t(0)
    addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))

    let bindResult = withUnsafePointer(to: &addr) { pointer -> Int32 in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    if bindResult != 0 {
        throw TestError(message: "bind failed")
    }

    var resolved = sockaddr_in()
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    let nameResult = withUnsafeMutablePointer(to: &resolved) { pointer -> Int32 in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            getsockname(fd, $0, &length)
        }
    }
    if nameResult != 0 {
        throw TestError(message: "getsockname failed")
    }

    let port = UInt16(bigEndian: resolved.sin_port)
    guard let endpointPort = NWEndpoint.Port(rawValue: port), endpointPort.rawValue != 0 else {
        throw TestError(message: "ephemeral port missing")
    }
    return endpointPort
}
