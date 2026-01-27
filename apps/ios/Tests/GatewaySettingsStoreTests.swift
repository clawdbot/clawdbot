import Foundation
import Testing
@testable import Moltbot

private struct KeychainEntry: Hashable {
    let service: String
    let account: String
}

private let gatewayService = "com.clawdbot.gateway"
private let nodeService = "com.clawdbot.node"
private let instanceIdEntry = KeychainEntry(service: nodeService, account: "instanceId")
private let preferredGatewayEntry = KeychainEntry(service: gatewayService, account: "preferredStableID")
private let lastGatewayEntry = KeychainEntry(service: gatewayService, account: "lastDiscoveredStableID")

private func snapshotDefaults(_ keys: [String]) -> [String: Any?] {
    let defaults = UserDefaults.standard
    var snapshot: [String: Any?] = [:]
    for key in keys {
        snapshot[key] = defaults.object(forKey: key)
    }
    return snapshot
}

private func applyDefaults(_ values: [String: Any?]) {
    let defaults = UserDefaults.standard
    for (key, value) in values {
        if let value {
            defaults.set(value, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }
}

private func restoreDefaults(_ snapshot: [String: Any?]) {
    applyDefaults(snapshot)
}

private func snapshotKeychain(_ entries: [KeychainEntry]) -> [KeychainEntry: String?] {
    var snapshot: [KeychainEntry: String?] = [:]
    for entry in entries {
        snapshot[entry] = KeychainStore.loadString(service: entry.service, account: entry.account)
    }
    return snapshot
}

private func applyKeychain(_ values: [KeychainEntry: String?]) {
    for (entry, value) in values {
        if let value {
            _ = KeychainStore.saveString(value, service: entry.service, account: entry.account)
        } else {
            _ = KeychainStore.delete(service: entry.service, account: entry.account)
        }
    }
}

private func restoreKeychain(_ snapshot: [KeychainEntry: String?]) {
    applyKeychain(snapshot)
}

@Suite(.serialized) struct GatewaySettingsStoreTests {
    @Test func bootstrapCopiesDefaultsToKeychainWhenMissing() {
        let defaultsKeys = [
            "node.instanceId",
            "gateway.preferredStableID",
            "gateway.lastDiscoveredStableID",
        ]
        let entries = [instanceIdEntry, preferredGatewayEntry, lastGatewayEntry]
        let defaultsSnapshot = snapshotDefaults(defaultsKeys)
        let keychainSnapshot = snapshotKeychain(entries)
        defer {
            restoreDefaults(defaultsSnapshot)
            restoreKeychain(keychainSnapshot)
        }

        applyDefaults([
            "node.instanceId": "node-test",
            "gateway.preferredStableID": "preferred-test",
            "gateway.lastDiscoveredStableID": "last-test",
        ])
        applyKeychain([
            instanceIdEntry: nil,
            preferredGatewayEntry: nil,
            lastGatewayEntry: nil,
        ])

        GatewaySettingsStore.bootstrapPersistence()

        #expect(KeychainStore.loadString(service: nodeService, account: "instanceId") == "node-test")
        #expect(KeychainStore.loadString(service: gatewayService, account: "preferredStableID") == "preferred-test")
        #expect(KeychainStore.loadString(service: gatewayService, account: "lastDiscoveredStableID") == "last-test")
    }

    @Test func bootstrapCopiesKeychainToDefaultsWhenMissing() {
        let defaultsKeys = [
            "node.instanceId",
            "gateway.preferredStableID",
            "gateway.lastDiscoveredStableID",
        ]
        let entries = [instanceIdEntry, preferredGatewayEntry, lastGatewayEntry]
        let defaultsSnapshot = snapshotDefaults(defaultsKeys)
        let keychainSnapshot = snapshotKeychain(entries)
        defer {
            restoreDefaults(defaultsSnapshot)
            restoreKeychain(keychainSnapshot)
        }

        applyDefaults([
            "node.instanceId": nil,
            "gateway.preferredStableID": nil,
            "gateway.lastDiscoveredStableID": nil,
        ])
        applyKeychain([
            instanceIdEntry: "node-from-keychain",
            preferredGatewayEntry: "preferred-from-keychain",
            lastGatewayEntry: "last-from-keychain",
        ])

        GatewaySettingsStore.bootstrapPersistence()

        let defaults = UserDefaults.standard
        #expect(defaults.string(forKey: "node.instanceId") == "node-from-keychain")
        #expect(defaults.string(forKey: "gateway.preferredStableID") == "preferred-from-keychain")
        #expect(defaults.string(forKey: "gateway.lastDiscoveredStableID") == "last-from-keychain")
    }
}
