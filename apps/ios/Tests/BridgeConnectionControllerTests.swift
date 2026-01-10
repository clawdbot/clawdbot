import ClawdbotKit
import Foundation
import Network
import Testing
import UIKit
@testable import Clawdbot

private struct KeychainEntry: Hashable {
    let service: String
    let account: String
}

private let bridgeService = "com.clawdbot.bridge"
private let nodeService = "com.clawdbot.node"
private let instanceIdEntry = KeychainEntry(service: nodeService, account: "instanceId")
private let preferredBridgeEntry = KeychainEntry(service: bridgeService, account: "preferredStableID")
private let lastBridgeEntry = KeychainEntry(service: bridgeService, account: "lastDiscoveredStableID")

private actor MockBridgePairingClient: BridgePairingClient {
    private(set) var lastToken: String?
    private let resultToken: String

    init(resultToken: String) {
        self.resultToken = resultToken
    }

    func pairAndHello(
        endpoint: NWEndpoint,
        hello: BridgeHello,
        onStatus: (@Sendable (String) -> Void)?) async throws -> String
    {
        self.lastToken = hello.token
        onStatus?("Testing…")
        return self.resultToken
    }
}

private func withUserDefaults<T>(_ updates: [String: Any?], _ body: () throws -> T) rethrows -> T {
    let defaults = UserDefaults.standard
    var snapshot: [String: Any?] = [:]
    for key in updates.keys {
        snapshot[key] = defaults.object(forKey: key)
    }
    for (key, value) in updates {
        if let value {
            defaults.set(value, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }
    defer {
        for (key, value) in snapshot {
            if let value {
                defaults.set(value, forKey: key)
            } else {
                defaults.removeObject(forKey: key)
            }
        }
    }
    return try body()
}

@MainActor
private func withUserDefaults<T>(
    _ updates: [String: Any?],
    _ body: () async throws -> T) async rethrows -> T
{
    let defaults = UserDefaults.standard
    var snapshot: [String: Any?] = [:]
    for key in updates.keys {
        snapshot[key] = defaults.object(forKey: key)
    }
    for (key, value) in updates {
        if let value {
            defaults.set(value, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }
    defer {
        for (key, value) in snapshot {
            if let value {
                defaults.set(value, forKey: key)
            } else {
                defaults.removeObject(forKey: key)
            }
        }
    }
    return try await body()
}

private func withKeychainValues<T>(_ updates: [KeychainEntry: String?], _ body: () throws -> T) rethrows -> T {
    var snapshot: [KeychainEntry: String?] = [:]
    for entry in updates.keys {
        snapshot[entry] = KeychainStore.loadString(service: entry.service, account: entry.account)
    }
    for (entry, value) in updates {
        if let value {
            _ = KeychainStore.saveString(value, service: entry.service, account: entry.account)
        } else {
            _ = KeychainStore.delete(service: entry.service, account: entry.account)
        }
    }
    defer {
        for (entry, value) in snapshot {
            if let value {
                _ = KeychainStore.saveString(value, service: entry.service, account: entry.account)
            } else {
                _ = KeychainStore.delete(service: entry.service, account: entry.account)
            }
        }
    }
    return try body()
}

@MainActor
private func withKeychainValues<T>(
    _ updates: [KeychainEntry: String?],
    _ body: () async throws -> T) async rethrows -> T
{
    var snapshot: [KeychainEntry: String?] = [:]
    for entry in updates.keys {
        snapshot[entry] = KeychainStore.loadString(service: entry.service, account: entry.account)
    }
    for (entry, value) in updates {
        if let value {
            _ = KeychainStore.saveString(value, service: entry.service, account: entry.account)
        } else {
            _ = KeychainStore.delete(service: entry.service, account: entry.account)
        }
    }
    defer {
        for (entry, value) in snapshot {
            if let value {
                _ = KeychainStore.saveString(value, service: entry.service, account: entry.account)
            } else {
                _ = KeychainStore.delete(service: entry.service, account: entry.account)
            }
        }
    }
    return try await body()
}

@Suite(.serialized) struct BridgeConnectionControllerTests {
    @Test @MainActor func resolvedDisplayNameSetsDefaultWhenMissing() {
        let defaults = UserDefaults.standard
        let displayKey = "node.displayName"

        withKeychainValues([instanceIdEntry: nil, preferredBridgeEntry: nil, lastBridgeEntry: nil]) {
            withUserDefaults([displayKey: nil, "node.instanceId": "ios-test"]) {
                let appModel = NodeAppModel()
                let controller = BridgeConnectionController(appModel: appModel, startDiscovery: false)

                let resolved = controller._test_resolvedDisplayName(defaults: defaults)
                #expect(!resolved.isEmpty)
                #expect(defaults.string(forKey: displayKey) == resolved)
            }
        }
    }

    @Test @MainActor func resolvedDisplayNamePreservesCustomValue() {
        let defaults = UserDefaults.standard
        let displayKey = "node.displayName"

        withKeychainValues([instanceIdEntry: nil, preferredBridgeEntry: nil, lastBridgeEntry: nil]) {
            withUserDefaults([displayKey: "My iOS Node", "node.instanceId": "ios-test"]) {
                let appModel = NodeAppModel()
                let controller = BridgeConnectionController(appModel: appModel, startDiscovery: false)

                let resolved = controller._test_resolvedDisplayName(defaults: defaults)
                #expect(resolved == "My iOS Node")
                #expect(defaults.string(forKey: displayKey) == "My iOS Node")
            }
        }
    }

    @Test @MainActor func makeHelloBuildsCapsAndCommands() {
        let voiceWakeKey = VoiceWakePreferences.enabledKey

        withKeychainValues([instanceIdEntry: nil, preferredBridgeEntry: nil, lastBridgeEntry: nil]) {
            withUserDefaults([
                "node.instanceId": "ios-test",
                "node.displayName": "Test Node",
                "camera.enabled": false,
                voiceWakeKey: true,
            ]) {
                let appModel = NodeAppModel()
                let controller = BridgeConnectionController(appModel: appModel, startDiscovery: false)
                let hello = controller._test_makeHello(token: "token-123")

                #expect(hello.nodeId == "ios-test")
                #expect(hello.displayName == "Test Node")
                #expect(hello.token == "token-123")

                let caps = Set(hello.caps ?? [])
                #expect(caps.contains(ClawdbotCapability.canvas.rawValue))
                #expect(caps.contains(ClawdbotCapability.screen.rawValue))
                #expect(caps.contains(ClawdbotCapability.voiceWake.rawValue))
                #expect(!caps.contains(ClawdbotCapability.camera.rawValue))

                let commands = Set(hello.commands ?? [])
                #expect(commands.contains(ClawdbotCanvasCommand.present.rawValue))
                #expect(commands.contains(ClawdbotScreenCommand.record.rawValue))
                #expect(!commands.contains(ClawdbotCameraCommand.snap.rawValue))

                #expect(!(hello.platform ?? "").isEmpty)
                #expect(!(hello.deviceFamily ?? "").isEmpty)
                #expect(!(hello.modelIdentifier ?? "").isEmpty)
                #expect(!(hello.version ?? "").isEmpty)
            }
        }
    }

    @Test @MainActor func makeHelloIncludesCameraCommandsWhenEnabled() {
        withKeychainValues([instanceIdEntry: nil, preferredBridgeEntry: nil, lastBridgeEntry: nil]) {
            withUserDefaults([
                "node.instanceId": "ios-test",
                "node.displayName": "Test Node",
                "camera.enabled": true,
                VoiceWakePreferences.enabledKey: false,
            ]) {
                let appModel = NodeAppModel()
                let controller = BridgeConnectionController(appModel: appModel, startDiscovery: false)
                let hello = controller._test_makeHello(token: "token-456")

                let caps = Set(hello.caps ?? [])
                #expect(caps.contains(ClawdbotCapability.camera.rawValue))

                let commands = Set(hello.commands ?? [])
                #expect(commands.contains(ClawdbotCameraCommand.snap.rawValue))
                #expect(commands.contains(ClawdbotCameraCommand.clip.rawValue))
            }
        }
    }

    @Test @MainActor func autoConnectRefreshesTokenOnUnauthorized() async {
        let bridge = BridgeDiscoveryModel.DiscoveredBridge(
            name: "Gateway",
            endpoint: .hostPort(host: NWEndpoint.Host("127.0.0.1"), port: 18790),
            stableID: "bridge-1",
            debugID: "bridge-debug",
            lanHost: "Mac.local",
            tailnetDns: nil,
            gatewayPort: 18789,
            bridgePort: 18790,
            canvasPort: 18793,
            cliPath: nil)
        let mock = MockBridgePairingClient(resultToken: "new-token")
        let account = "bridge-token.ios-test"

        await withKeychainValues([
            instanceIdEntry: nil,
            preferredBridgeEntry: nil,
            lastBridgeEntry: nil,
            KeychainEntry(service: bridgeService, account: account): "old-token",
        ]) {
            await withUserDefaults([
                "node.instanceId": "ios-test",
                "bridge.lastDiscoveredStableID": "bridge-1",
                "bridge.manual.enabled": false,
            ]) {
                let appModel = NodeAppModel()
                let controller = BridgeConnectionController(
                    appModel: appModel,
                    startDiscovery: false,
                    bridgeClientFactory: { mock })
                controller._test_setBridges([bridge])
                controller._test_triggerAutoConnect()

                for _ in 0..<20 {
                    if appModel.connectedBridgeID == bridge.stableID { break }
                    try? await Task.sleep(nanoseconds: 50_000_000)
                }

                #expect(appModel.connectedBridgeID == bridge.stableID)
                let stored = KeychainStore.loadString(service: bridgeService, account: account)
                #expect(stored == "new-token")
                let lastToken = await mock.lastToken
                #expect(lastToken == "old-token")
            }
        }
    }

    @Test @MainActor func autoConnectPrefersPreferredBridgeOverLastDiscovered() async {
        let bridgeA = BridgeDiscoveryModel.DiscoveredBridge(
            name: "Gateway A",
            endpoint: .hostPort(host: NWEndpoint.Host("127.0.0.1"), port: 18790),
            stableID: "bridge-1",
            debugID: "bridge-a",
            lanHost: "MacA.local",
            tailnetDns: nil,
            gatewayPort: 18789,
            bridgePort: 18790,
            canvasPort: 18793,
            cliPath: nil)
        let bridgeB = BridgeDiscoveryModel.DiscoveredBridge(
            name: "Gateway B",
            endpoint: .hostPort(host: NWEndpoint.Host("127.0.0.1"), port: 28790),
            stableID: "bridge-2",
            debugID: "bridge-b",
            lanHost: "MacB.local",
            tailnetDns: nil,
            gatewayPort: 28789,
            bridgePort: 28790,
            canvasPort: 28793,
            cliPath: nil)

        let mock = MockBridgePairingClient(resultToken: "token-ok")
        let account = "bridge-token.ios-test"

        await withKeychainValues([
            instanceIdEntry: nil,
            preferredBridgeEntry: nil,
            lastBridgeEntry: nil,
            KeychainEntry(service: bridgeService, account: account): "old-token",
        ]) {
            await withUserDefaults([
                "node.instanceId": "ios-test",
                "bridge.preferredStableID": "bridge-2",
                "bridge.lastDiscoveredStableID": "bridge-1",
                "bridge.manual.enabled": false,
            ]) {
                let appModel = NodeAppModel()
                let controller = BridgeConnectionController(
                    appModel: appModel,
                    startDiscovery: false,
                    bridgeClientFactory: { mock })
                controller._test_setBridges([bridgeA, bridgeB])
                controller._test_triggerAutoConnect()

                for _ in 0..<20 {
                    if appModel.connectedBridgeID == bridgeB.stableID { break }
                    try? await Task.sleep(nanoseconds: 50_000_000)
                }

                #expect(appModel.connectedBridgeID == bridgeB.stableID)
            }
        }
    }
}
