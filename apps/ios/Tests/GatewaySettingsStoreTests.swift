import Foundation
import OpenClawKit
import Security
import Testing
@testable import OpenClaw

private struct KeychainEntry: Hashable {
    let service: String
    let account: String
}

private let gatewayService = GatewaySettingsStore._testGatewayService
private let nodeService = "ai.openclawfoundation.app.node"
private let instanceIdEntry = KeychainEntry(service: nodeService, account: "instanceId")
private let preferredGatewayEntry = KeychainEntry(service: gatewayService, account: "preferredStableID")
private let lastGatewayEntry = KeychainEntry(service: gatewayService, account: "lastDiscoveredStableID")
private let bootstrapDefaultsKeys = [
    "node.instanceId",
    "gateway.preferredStableID",
    "gateway.lastDiscoveredStableID",
]
private let bootstrapKeychainEntries = [instanceIdEntry, preferredGatewayEntry, lastGatewayEntry]
private let lastGatewayDefaultsKeys = [
    "gateway.last.kind",
    "gateway.last.host",
    "gateway.last.port",
    "gateway.last.tls",
    "gateway.last.stableID",
]
private let lastGatewayKeychainEntry = KeychainEntry(service: gatewayService, account: "lastConnection")
private let gatewayRegistryKeychainEntry = KeychainEntry(service: gatewayService, account: "gateway-registry")

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

private func withBootstrapSnapshots(_ body: () -> Void) {
    gatewayPersistenceTestSemaphore.wait()
    let defaultsSnapshot = snapshotDefaults(bootstrapDefaultsKeys + lastGatewayDefaultsKeys)
    let keychainSnapshot = snapshotKeychain(
        bootstrapKeychainEntries + [lastGatewayKeychainEntry, gatewayRegistryKeychainEntry])
    defer {
        restoreDefaults(defaultsSnapshot)
        restoreKeychain(keychainSnapshot)
        gatewayPersistenceTestSemaphore.signal()
    }
    body()
}

private func withLastGatewaySnapshot(_ body: () -> Void) {
    gatewayPersistenceTestSemaphore.wait()
    let defaultsSnapshot = snapshotDefaults(lastGatewayDefaultsKeys)
    let keychainSnapshot = snapshotKeychain([lastGatewayKeychainEntry, gatewayRegistryKeychainEntry])
    defer {
        restoreDefaults(defaultsSnapshot)
        restoreKeychain(keychainSnapshot)
        gatewayPersistenceTestSemaphore.signal()
    }
    body()
}

@Suite(.serialized) struct GatewaySettingsStoreTests {
    @Test func `opaque identifier validation preserves protocol-valid edge bytes`() {
        #expect(ExecApprovalIdentifier.exact("") == nil)
        #expect(ExecApprovalIdentifier.key(".") == nil)
        #expect(ExecApprovalIdentifier.key("..") == nil)
        #expect(ExecApprovalIdentifier.exact(" approval ") == " approval ")
        #expect(ExecApprovalIdentifier.exact("\u{0085}approval") == "\u{0085}approval")
        #expect(GatewayStableIdentifier.exact(" gateway ") == " gateway ")
        #expect(GatewayStableIdentifier.exact("\u{0085}gateway") == "\u{0085}gateway")
    }

    @Test func `custom headers round trip per gateway`() {
        let service = "\(gatewayService).custom-headers-test.\(UUID().uuidString)"
        let gatewayID = "manual|headers.example.com|443|\(UUID().uuidString)"
        let otherGatewayID = "manual|other.example.com|443|\(UUID().uuidString)"
        defer { GatewaySettingsStore.clearGatewayCustomHeaders(service: service) }

        #expect(GatewaySettingsStore.loadGatewayCustomHeaders(gatewayStableID: gatewayID, service: service).isEmpty)
        #expect(GatewaySettingsStore.saveGatewayCustomHeaders(
            ["CF-Access-Client-Id": "client-id", "CF-Access-Client-Secret": "client-secret"],
            gatewayStableID: gatewayID,
            service: service))
        #expect(GatewaySettingsStore.loadGatewayCustomHeaders(gatewayStableID: gatewayID, service: service) == [
            "CF-Access-Client-Id": "client-id",
            "CF-Access-Client-Secret": "client-secret",
        ])
        #expect(GatewaySettingsStore.loadGatewayCustomHeaders(
            gatewayStableID: otherGatewayID,
            service: service).isEmpty)
        #expect(GatewaySettingsStore.saveGatewayCustomHeaders(
            ["X-Other": "other-value"],
            gatewayStableID: otherGatewayID,
            service: service))

        #expect(GatewaySettingsStore.saveGatewayCustomHeaders(
            [:],
            gatewayStableID: gatewayID,
            service: service))
        #expect(GatewaySettingsStore.loadGatewayCustomHeaders(
            gatewayStableID: gatewayID,
            service: service).isEmpty)
        #expect(GatewaySettingsStore.loadGatewayCustomHeaders(
            gatewayStableID: otherGatewayID,
            service: service) == ["X-Other": "other-value"])
    }

    @Test func `custom headers keep canonically equivalent owners isolated`() {
        let service = "\(gatewayService).custom-headers-exact-test.\(UUID().uuidString)"
        let composedOwner = "gateway-\u{00E9}"
        let decomposedOwner = "gateway-e\u{0301}"
        let nextLineOwner = "\u{0085}gateway"
        defer { GatewaySettingsStore.clearGatewayCustomHeaders(service: service) }

        #expect(GatewaySettingsStore.saveGatewayCustomHeaders(
            ["X-Owner": "composed"],
            gatewayStableID: composedOwner,
            service: service))
        #expect(GatewaySettingsStore.saveGatewayCustomHeaders(
            ["X-Owner": "decomposed"],
            gatewayStableID: decomposedOwner,
            service: service))
        #expect(GatewaySettingsStore.saveGatewayCustomHeaders(
            ["X-Owner": "next-line"],
            gatewayStableID: nextLineOwner,
            service: service))

        #expect(GatewaySettingsStore.loadGatewayCustomHeaders(
            gatewayStableID: composedOwner,
            service: service)["X-Owner"] == "composed")
        #expect(GatewaySettingsStore.loadGatewayCustomHeaders(
            gatewayStableID: decomposedOwner,
            service: service)["X-Owner"] == "decomposed")
        #expect(GatewaySettingsStore.loadGatewayCustomHeaders(
            gatewayStableID: nextLineOwner,
            service: service)["X-Owner"] == "next-line")
    }

    @Test func `legacy custom header account cannot alias encoded owner account`() {
        let service = "\(gatewayService).custom-headers-prefix-test.\(UUID().uuidString)"
        let exactOwner = "gateway-\(UUID().uuidString)"
        let component = Data(exactOwner.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let collidingLegacyOwner = "v2.\(component)"
        defer { GatewaySettingsStore.clearGatewayCustomHeaders(service: service) }

        #expect(GatewaySettingsStore.saveGatewayCustomHeaders(
            ["X-Owner": "exact"],
            gatewayStableID: exactOwner,
            service: service))

        #expect(GatewaySettingsStore.loadGatewayCustomHeaders(
            gatewayStableID: collidingLegacyOwner,
            service: service).isEmpty)
        #expect(GatewaySettingsStore.clearGatewayCustomHeaders(
            gatewayStableID: collidingLegacyOwner,
            service: service))
        #expect(GatewaySettingsStore.loadGatewayCustomHeaders(
            gatewayStableID: exactOwner,
            service: service)["X-Owner"] == "exact")
    }

    @Test func `legacy gateway defaults cannot alias encoded owner keys`() {
        let exactOwner = "gateway-\(UUID().uuidString)"
        let component = Data(exactOwner.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let collidingLegacyOwner = "v2.\(component)"
        defer {
            GatewaySettingsStore.saveGatewayClientIdOverride(stableID: exactOwner, clientId: nil)
            GatewaySettingsStore.saveGatewayClientIdOverride(stableID: collidingLegacyOwner, clientId: nil)
            GatewaySettingsStore.saveGatewaySelectedAgentId(stableID: exactOwner, agentId: nil)
            GatewaySettingsStore.saveGatewaySelectedAgentId(stableID: collidingLegacyOwner, agentId: nil)
        }

        GatewaySettingsStore.saveGatewayClientIdOverride(stableID: exactOwner, clientId: "exact-client")
        GatewaySettingsStore.saveGatewaySelectedAgentId(stableID: exactOwner, agentId: "exact-agent")

        #expect(GatewaySettingsStore.loadGatewayClientIdOverride(stableID: collidingLegacyOwner) == nil)
        #expect(GatewaySettingsStore.loadGatewaySelectedAgentId(stableID: collidingLegacyOwner) == nil)
        GatewaySettingsStore.saveGatewayClientIdOverride(stableID: collidingLegacyOwner, clientId: nil)
        GatewaySettingsStore.saveGatewaySelectedAgentId(stableID: collidingLegacyOwner, agentId: nil)
        #expect(GatewaySettingsStore.loadGatewayClientIdOverride(stableID: exactOwner) == "exact-client")
        #expect(GatewaySettingsStore.loadGatewaySelectedAgentId(stableID: exactOwner) == "exact-agent")
    }

    @Test func `custom header storage drops reserved names`() {
        let service = "\(gatewayService).custom-headers-test.\(UUID().uuidString)"
        let gatewayID = "manual|reserved.example.com|443|\(UUID().uuidString)"
        defer { GatewaySettingsStore.clearGatewayCustomHeaders(service: service) }

        #expect(GatewaySettingsStore.saveGatewayCustomHeaders(
            ["Host": "smuggled.example", "X-Allowed": "yes"],
            gatewayStableID: gatewayID,
            service: service))
        #expect(GatewaySettingsStore.loadGatewayCustomHeaders(gatewayStableID: gatewayID, service: service)
            == ["X-Allowed": "yes"])
    }

    @Test func `custom header reset clears every gateway but preserves unrelated credentials`() {
        let service = "\(gatewayService).custom-headers-test.\(UUID().uuidString)"
        let firstGatewayID = "manual|first-reset.example.com|443|\(UUID().uuidString)"
        let secondGatewayID = "manual|second-reset.example.com|443|\(UUID().uuidString)"
        let unrelatedAccount = "unrelated-reset-secret.\(UUID().uuidString)"
        defer { _ = KeychainStore.delete(service: gatewayService, account: unrelatedAccount) }

        #expect(GatewaySettingsStore.saveGatewayCustomHeaders(
            ["X-Proxy-Token": "first"],
            gatewayStableID: firstGatewayID,
            service: service))
        #expect(GatewaySettingsStore.saveGatewayCustomHeaders(
            ["X-Proxy-Token": "second"],
            gatewayStableID: secondGatewayID,
            service: service))
        #expect(KeychainStore.saveString("keep", service: gatewayService, account: unrelatedAccount))

        #expect(GatewaySettingsStore.clearGatewayCustomHeaders(service: service))

        #expect(GatewaySettingsStore.loadGatewayCustomHeaders(
            gatewayStableID: firstGatewayID,
            service: service).isEmpty)
        #expect(GatewaySettingsStore.loadGatewayCustomHeaders(
            gatewayStableID: secondGatewayID,
            service: service).isEmpty)
        #expect(KeychainStore.loadString(service: gatewayService, account: unrelatedAccount) == "keep")
    }

    @Test func `custom header forget clears only one gateway`() {
        let service = "\(gatewayService).custom-headers-test.\(UUID().uuidString)"
        let forgottenGatewayID = "manual|forgotten.example.com|443|\(UUID().uuidString)"
        let keptGatewayID = "manual|kept.example.com|443|\(UUID().uuidString)"
        defer { GatewaySettingsStore.clearGatewayCustomHeaders(service: service) }

        for gatewayID in [forgottenGatewayID, keptGatewayID] {
            #expect(GatewaySettingsStore.saveGatewayCustomHeaders(
                ["X-Proxy-Token": gatewayID],
                gatewayStableID: gatewayID,
                service: service))
        }

        #expect(GatewaySettingsStore.clearGatewayCustomHeaders(
            gatewayStableID: forgottenGatewayID,
            service: service))
        #expect(GatewaySettingsStore.loadGatewayCustomHeaders(
            gatewayStableID: forgottenGatewayID,
            service: service).isEmpty)
        #expect(GatewaySettingsStore.loadGatewayCustomHeaders(
            gatewayStableID: keptGatewayID,
            service: service) == ["X-Proxy-Token": keptGatewayID])
    }

    @Test func `credentials stay bound to their gateway`() {
        let instanceID = "credential-owner-\(UUID().uuidString)"
        defer { GatewaySettingsStore.deleteAllGatewayCredentials(instanceId: instanceID) }
        let firstGatewayID = "manual|first.example.com|443"
        let secondGatewayID = "manual|second.example.com|443"

        GatewaySettingsStore.saveGatewayCredentials(
            token: "first-token",
            bootstrapToken: nil,
            password: "first-password",
            gatewayStableID: firstGatewayID,
            suppressStoredDeviceAuth: true,
            instanceId: instanceID)

        let first = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: firstGatewayID)
        #expect(first.token == "first-token")
        #expect(first.password == "first-password")
        #expect(first.suppressStoredDeviceAuth)
        #expect(GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: secondGatewayID) == .empty)

        GatewaySettingsStore.discardUnscopedGatewayCredentials(instanceId: instanceID)
        #expect(GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: secondGatewayID) == .empty)
    }

    @Test func `credentials preserve exact unicode gateway owners`() {
        let instanceID = "credential-exact-owner-\(UUID().uuidString)"
        let composedOwner = "gateway-\u{00E9}"
        let decomposedOwner = "gateway-e\u{0301}"
        let nextLineOwner = "\u{0085}gateway"
        defer { GatewaySettingsStore.deleteAllGatewayCredentials(instanceId: instanceID) }

        for (owner, token) in [
            (composedOwner, "composed-token"),
            (decomposedOwner, "decomposed-token"),
            (nextLineOwner, "next-line-token"),
        ] {
            #expect(GatewaySettingsStore.saveGatewayCredentials(
                token: token,
                bootstrapToken: nil,
                password: nil,
                gatewayStableID: owner,
                suppressStoredDeviceAuth: false,
                instanceId: instanceID))
        }

        #expect(GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: composedOwner).token == "composed-token")
        #expect(GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: decomposedOwner).token == "decomposed-token")
        #expect(GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: nextLineOwner).token == "next-line-token")

        GatewaySettingsStore.deleteGatewayCredentials(instanceId: instanceID, stableID: decomposedOwner)
        #expect(GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: composedOwner).token == "composed-token")
        #expect(GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: decomposedOwner) == .empty)
    }

    @Test func `shared tls certificate does not alias distinct routes`() {
        let instanceID = "tls-owner-\(UUID().uuidString)"
        let discoveredID = "bonjour|_openclaw._tcp|local|gateway-\(UUID().uuidString)"
        let manualID = "manual|gateway-\(UUID().uuidString).local|443"
        let fingerprint = "AA:BB:CC:DD"
        defer {
            GatewaySettingsStore.deleteAllGatewayCredentials(instanceId: instanceID)
            GatewayTLSStore.clearFingerprint(stableID: discoveredID)
            GatewayTLSStore.clearFingerprint(stableID: manualID)
        }

        GatewaySettingsStore.saveGatewayCredentials(
            token: "shared-token",
            bootstrapToken: nil,
            password: "shared-password",
            gatewayStableID: discoveredID,
            suppressStoredDeviceAuth: false,
            instanceId: instanceID)
        GatewayTLSStore.saveFingerprint(fingerprint, stableID: discoveredID)
        GatewayTLSStore.saveFingerprint(fingerprint, stableID: manualID)

        let manualCredentials = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: manualID)
        #expect(manualCredentials == .empty)
        #expect(GatewaySettingsStore.authenticationOwnerID(routeStableID: discoveredID) == discoveredID)
        #expect(GatewaySettingsStore.authenticationOwnerID(routeStableID: manualID) == manualID)
        #expect(GatewaySettingsStore.loadGatewayCredentialMetadata(
            instanceId: instanceID,
            gatewayStableID: discoveredID)?.gatewayStableID == discoveredID)
    }

    @Test func `ambiguous legacy credentials are discarded`() {
        let instanceID = "legacy-credential-owner-\(UUID().uuidString)"
        defer { GatewaySettingsStore.deleteAllGatewayCredentials(instanceId: instanceID) }
        let firstGatewayID = "manual|first.example.com|443"
        let secondGatewayID = "manual|second.example.com|443"
        GatewaySettingsStore.saveLegacyGatewayTokenForMigrationTest("legacy-token", instanceId: instanceID)

        GatewaySettingsStore.discardUnscopedGatewayCredentials(instanceId: instanceID)

        #expect(GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: firstGatewayID) == .empty)
        #expect(GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: secondGatewayID) == .empty)
        #expect(KeychainStore.loadString(
            service: gatewayService,
            account: "gateway-token.\(instanceID)") == nil)
        #expect(KeychainStore.loadString(
            service: gatewayService,
            account: "gateway-credentials.\(instanceID)") == nil)
    }

    @Test func `proven relay migration does not overwrite a canonical credential bundle`() {
        let instanceID = "relay-migration-owner-\(UUID().uuidString)"
        defer { GatewaySettingsStore.deleteAllGatewayCredentials(instanceId: instanceID) }
        let gatewayID = "manual|gateway.example.com|443"
        GatewaySettingsStore.saveGatewayCredentials(
            token: "current-token",
            bootstrapToken: "current-bootstrap",
            password: "current-password",
            gatewayStableID: gatewayID,
            suppressStoredDeviceAuth: true,
            instanceId: instanceID)
        GatewaySettingsStore.saveLegacyGatewayTokenForMigrationTest(
            "obsolete-token",
            instanceId: instanceID)

        #expect(GatewaySettingsStore.migrateProvenRelayCredentials(
            instanceId: instanceID,
            gatewayStableID: gatewayID,
            token: "stale-relay-token",
            password: "stale-relay-password"))
        let credentials = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: gatewayID)
        #expect(credentials.token == "current-token")
        #expect(credentials.bootstrapToken == "current-bootstrap")
        #expect(credentials.password == "current-password")
        #expect(credentials.suppressStoredDeviceAuth)
        #expect(KeychainStore.loadString(
            service: gatewayService,
            account: "gateway-token.\(instanceID)") == nil)
    }

    @Test func `proven relay credentials are not reimported after legacy cleanup`() {
        let instanceID = "completed-relay-migration-\(UUID().uuidString)"
        defer { GatewaySettingsStore.deleteAllGatewayCredentials(instanceId: instanceID) }
        let gatewayID = "manual|gateway.example.com|443"

        #expect(GatewaySettingsStore.migrateProvenRelayCredentials(
            instanceId: instanceID,
            gatewayStableID: gatewayID,
            token: "stale-relay-token",
            password: "stale-relay-password"))
        #expect(GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: gatewayID) == .empty)
    }

    @Test func `credentialless setup suppresses stored auth until handoff completes`() throws {
        let instanceID = "credentialless-owner-\(UUID().uuidString)"
        defer { GatewaySettingsStore.deleteAllGatewayCredentials(instanceId: instanceID) }
        let gatewayID = "manual|gateway.example.com|443"

        GatewaySettingsStore.saveGatewayCredentials(
            token: nil,
            bootstrapToken: nil,
            password: nil,
            gatewayStableID: gatewayID,
            suppressStoredDeviceAuth: true,
            instanceId: instanceID)

        let pending = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: gatewayID)
        #expect(!pending.hasCredentials)
        #expect(pending.suppressStoredDeviceAuth)

        try GatewaySettingsStore.completeGatewayCredentialHandoff(
            instanceId: instanceID,
            gatewayStableID: gatewayID)
        #expect(GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: gatewayID) == .empty)
        #expect(GatewaySettingsStore.loadGatewayCredentialMetadata(
            instanceId: instanceID,
            gatewayStableID: gatewayID) == nil)
    }

    @Test func `bootstrap handoff clears bootstrap while enabling stored auth`() throws {
        let instanceID = "bootstrap-handoff-\(UUID().uuidString)"
        defer { GatewaySettingsStore.deleteAllGatewayCredentials(instanceId: instanceID) }
        let gatewayID = "manual|gateway.example.com|443"

        GatewaySettingsStore.saveGatewayCredentials(
            token: "shared-token",
            bootstrapToken: "one-time-bootstrap",
            password: nil,
            gatewayStableID: gatewayID,
            suppressStoredDeviceAuth: true,
            instanceId: instanceID)

        #expect(try GatewaySettingsStore.completeGatewayCredentialHandoff(
            instanceId: instanceID,
            gatewayStableID: gatewayID))
        let completed = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: gatewayID)
        #expect(completed.token == "shared-token")
        #expect(completed.bootstrapToken == nil)
        #expect(!completed.suppressStoredDeviceAuth)
    }

    @Test func `credentialless handoff survives deferred keychain deletion after redaction`() throws {
        let instanceID = "deferred-handoff-cleanup-\(UUID().uuidString)"
        defer { GatewaySettingsStore.deleteAllGatewayCredentials(instanceId: instanceID) }
        let gatewayID = "manual|gateway.example.com|443"
        let bootstrapToken = "one-time-bootstrap"

        #expect(GatewaySettingsStore.saveGatewayCredentials(
            token: nil,
            bootstrapToken: bootstrapToken,
            password: nil,
            gatewayStableID: gatewayID,
            suppressStoredDeviceAuth: true,
            instanceId: instanceID))

        #expect(try GatewaySettingsStore.completeGatewayCredentialHandoff(
            instanceId: instanceID,
            gatewayStableID: gatewayID,
            deleteCredentialBundle: { _, _ in
                .failure(.init(operation: .delete, status: errSecInteractionNotAllowed))
            }))

        let completed = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: gatewayID)
        #expect(completed == .empty)
        #expect(GatewaySettingsStore.loadGatewayCredentialMetadata(
            instanceId: instanceID,
            gatewayStableID: gatewayID)?.suppressStoredDeviceAuth == false)
        let storageComponent = try #require(GatewayStableIdentifier.storageComponent(gatewayID))
        let account = "gateway-credentials.\(instanceID).v2.\(storageComponent)"
        let retainedJSON = KeychainStore.loadString(service: gatewayService, account: account)
        #expect(retainedJSON?.contains(bootstrapToken) == false)
    }

    @Test func `field edits preserve pending bootstrap handoff for the same gateway`() {
        let instanceID = "edited-credential-owner-\(UUID().uuidString)"
        defer { GatewaySettingsStore.deleteAllGatewayCredentials(instanceId: instanceID) }
        let gatewayID = "manual|gateway.example.com|443"

        GatewaySettingsStore.saveGatewayCredentials(
            token: nil,
            bootstrapToken: "bootstrap-token",
            password: nil,
            gatewayStableID: gatewayID,
            suppressStoredDeviceAuth: true,
            instanceId: instanceID)
        GatewaySettingsStore.updateGatewayCredentials(
            token: "edited-token",
            password: "edited-password",
            gatewayStableID: gatewayID,
            instanceId: instanceID)

        let credentials = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: gatewayID)
        #expect(credentials.token == "edited-token")
        #expect(credentials.bootstrapToken == "bootstrap-token")
        #expect(credentials.password == "edited-password")
        #expect(credentials.suppressStoredDeviceAuth)
    }

    @Test func `field edits do not carry pending handoff to another gateway`() {
        let instanceID = "switched-credential-owner-\(UUID().uuidString)"
        defer { GatewaySettingsStore.deleteAllGatewayCredentials(instanceId: instanceID) }
        let firstGatewayID = "manual|first.example.com|443"
        let secondGatewayID = "manual|second.example.com|443"

        GatewaySettingsStore.saveGatewayCredentials(
            token: "first-token",
            bootstrapToken: "first-bootstrap-token",
            password: "first-password",
            gatewayStableID: firstGatewayID,
            suppressStoredDeviceAuth: true,
            instanceId: instanceID)
        GatewaySettingsStore.updateGatewayCredentials(
            token: "second-token",
            password: nil,
            gatewayStableID: secondGatewayID,
            instanceId: instanceID)

        let first = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: firstGatewayID)
        #expect(first.token == "first-token")
        #expect(first.bootstrapToken == "first-bootstrap-token")
        #expect(first.password == "first-password")
        #expect(first.suppressStoredDeviceAuth)
        let second = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: secondGatewayID)
        #expect(second.token == "second-token")
        #expect(second.bootstrapToken == nil)
        #expect(second.password == nil)
        #expect(!second.suppressStoredDeviceAuth)
    }

    @Test func `clearing ordinary credentials removes their owner metadata`() {
        let instanceID = "cleared-credential-owner-\(UUID().uuidString)"
        defer { GatewaySettingsStore.deleteAllGatewayCredentials(instanceId: instanceID) }
        let gatewayID = "manual|gateway.example.com|443"

        GatewaySettingsStore.saveGatewayCredentials(
            token: "one-time-token",
            bootstrapToken: nil,
            password: nil,
            gatewayStableID: gatewayID,
            suppressStoredDeviceAuth: false,
            instanceId: instanceID)
        GatewaySettingsStore.updateGatewayCredentials(
            token: nil,
            password: nil,
            gatewayStableID: gatewayID,
            instanceId: instanceID)

        #expect(GatewaySettingsStore.loadGatewayCredentialMetadata(
            instanceId: instanceID,
            gatewayStableID: gatewayID) == nil)
        #expect(GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: gatewayID) == .empty)
    }

    @Test func `bootstrap copies defaults to keychain when missing`() {
        withBootstrapSnapshots {
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
    }

    @Test func `bootstrap copies keychain to defaults when missing`() {
        withBootstrapSnapshots {
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

    @Test func `registry CRUD round trip persists deterministic ordering`() {
        withLastGatewaySnapshot {
            applyKeychain([gatewayRegistryKeychainEntry: nil, lastGatewayKeychainEntry: nil])
            let gatewayB = GatewaySettingsStore.GatewayRegistryEntry(
                stableID: "manual|z.example.com|443",
                kind: .manual,
                name: "Zulu",
                host: "z.example.com",
                port: 443,
                useTLS: true,
                lastConnectedAtMs: nil)
            let gatewayA = GatewaySettingsStore.GatewayRegistryEntry(
                stableID: "bonjour|alpha",
                kind: .discovered,
                name: "Alpha",
                host: nil,
                port: nil,
                useTLS: true,
                lastConnectedAtMs: nil)

            #expect(GatewaySettingsStore.upsertGatewayRegistryEntry(gatewayB, activate: true))
            #expect(GatewaySettingsStore.upsertGatewayRegistryEntry(gatewayA))
            #expect(GatewaySettingsStore.markGatewayConnected(stableID: gatewayB.stableID, atMs: 1234))
            let firstJSON = KeychainStore.loadString(service: gatewayService, account: "gateway-registry")
            let registry = GatewaySettingsStore.loadGatewayRegistry()
            #expect(registry.entries.map(\.stableID) == [gatewayA.stableID, gatewayB.stableID])
            #expect(registry.activeStableID == gatewayB.stableID)
            #expect(registry.entries.last?.lastConnectedAtMs == 1234)

            #expect(GatewaySettingsStore.upsertGatewayRegistryEntry(gatewayA))
            #expect(KeychainStore.loadString(service: gatewayService, account: "gateway-registry") == firstJSON)
            #expect(GatewaySettingsStore.removeGatewayRegistryEntry(stableID: gatewayB.stableID))
            #expect(GatewaySettingsStore.loadGatewayRegistry().entries == [gatewayA])
            #expect(GatewaySettingsStore.activeGatewayEntry() == nil)
        }
    }

    @Test func `registry preserves byte-distinct unicode gateway owners`() {
        withLastGatewaySnapshot {
            applyKeychain([gatewayRegistryKeychainEntry: nil, lastGatewayKeychainEntry: nil])
            let composedOwner = "gateway-\u{00E9}"
            let decomposedOwner = "gateway-e\u{0301}"
            let nextLineOwner = "\u{0085}gateway"
            for owner in [composedOwner, decomposedOwner, nextLineOwner] {
                #expect(GatewaySettingsStore.upsertGatewayRegistryEntry(.init(
                    stableID: owner,
                    kind: .discovered,
                    name: "Gateway",
                    host: nil,
                    port: nil,
                    useTLS: true,
                    lastConnectedAtMs: nil)))
            }

            let registry = GatewaySettingsStore.loadGatewayRegistry()
            #expect(Set(registry.entries.compactMap { GatewayStableIdentifier.key($0.stableID) }).count == 3)
            #expect(GatewaySettingsStore.setActiveGateway(stableID: decomposedOwner))
            #expect(GatewaySettingsStore.activeGatewayEntry().map { Array($0.stableID.utf8) } ==
                Array(decomposedOwner.utf8))
            #expect(GatewaySettingsStore.removeGatewayRegistryEntry(stableID: composedOwner))
            let remaining = GatewaySettingsStore.loadGatewayRegistry().entries
            #expect(remaining.contains(where: {
                GatewayStableIdentifier.matches($0.stableID, decomposedOwner)
            }))
        }
    }

    @Test func `legacy manual last connection migrates once into active registry`() {
        withLastGatewaySnapshot {
            applyKeychain([
                gatewayRegistryKeychainEntry: nil,
                lastGatewayKeychainEntry:
                    #"{"kind":"manual","stableID":"manual|example.org|18789","useTLS":false,"host":"example.org","port":18789}"#,
            ])

            GatewaySettingsStore.bootstrapPersistence()
            let firstJSON = KeychainStore.loadString(service: gatewayService, account: "gateway-registry")
            GatewaySettingsStore.bootstrapPersistence()

            let active = GatewaySettingsStore.activeGatewayEntry()
            #expect(active?.stableID == "manual|example.org|18789")
            #expect(active?.host == "example.org")
            #expect(active?.port == 18789)
            #expect(active?.useTLS == false)
            #expect(KeychainStore.loadString(service: gatewayService, account: "lastConnection") == nil)
            #expect(KeychainStore.loadString(service: gatewayService, account: "gateway-registry") == firstJSON)
        }
    }

    @Test func `legacy discovered last connection migrates into active registry`() {
        withLastGatewaySnapshot {
            applyKeychain([
                gatewayRegistryKeychainEntry: nil,
                lastGatewayKeychainEntry:
                    #"{"kind":"discovered","stableID":"bonjour|gateway-a","useTLS":true}"#,
            ])
            applyDefaults([
                "gateway.last.kind": "manual",
                "gateway.last.host": "stale.example.org",
                "gateway.last.port": 18789,
                "gateway.last.tls": false,
                "gateway.last.stableID": "manual|stale.example.org|18789",
            ])

            GatewaySettingsStore.bootstrapPersistence()

            let active = GatewaySettingsStore.activeGatewayEntry()
            #expect(active?.stableID == "bonjour|gateway-a")
            #expect(active?.kind == .discovered)
            #expect(active?.name == "bonjour|gateway-a")
            let defaults = UserDefaults.standard
            #expect(defaults.object(forKey: "gateway.last.stableID") == nil)
            #expect(defaults.object(forKey: "gateway.last.host") == nil)
        }
    }

    @Test func `legacy defaults migrate directly into active registry`() {
        withLastGatewaySnapshot {
            applyKeychain([
                gatewayRegistryKeychainEntry: nil,
                lastGatewayKeychainEntry: nil,
            ])
            applyDefaults([
                "gateway.last.kind": "manual",
                "gateway.last.host": "defaults.example.org",
                "gateway.last.port": 443,
                "gateway.last.tls": true,
                "gateway.last.stableID": "manual|defaults.example.org|443",
            ])

            GatewaySettingsStore.bootstrapPersistence()

            let active = GatewaySettingsStore.activeGatewayEntry()
            #expect(active?.stableID == "manual|defaults.example.org|443")
            #expect(active?.host == "defaults.example.org")
            #expect(active?.port == 443)
            #expect(active?.useTLS == true)
            for key in lastGatewayDefaultsKeys {
                #expect(UserDefaults.standard.object(forKey: key) == nil)
            }
        }
    }

    @Test func `legacy unscoped credential bundle migrates to its gateway account`() {
        withBootstrapSnapshots {
            let instanceID = "legacy-bundle-\(UUID().uuidString)"
            defer { GatewaySettingsStore.deleteAllGatewayCredentials(instanceId: instanceID) }
            let gatewayID = "manual|credentials.example.com|443"
            let legacyAccount = "gateway-credentials.\(instanceID)"
            let scopedAccount = "\(legacyAccount).\(gatewayID)"
            let entries = [
                KeychainEntry(service: gatewayService, account: legacyAccount),
                KeychainEntry(service: gatewayService, account: scopedAccount),
            ]
            let credentialSnapshot = snapshotKeychain(entries)
            defer { restoreKeychain(credentialSnapshot) }
            applyKeychain([
                instanceIdEntry: nil,
                gatewayRegistryKeychainEntry: nil,
                KeychainEntry(service: gatewayService, account: legacyAccount):
                    #"{"gatewayStableID":"manual|credentials.example.com|443","suppressStoredDeviceAuth":true,"token":"legacy-token","bootstrapToken":"legacy-bootstrap","password":"legacy-password"}"#,
                KeychainEntry(service: gatewayService, account: scopedAccount): nil,
            ])
            applyDefaults(["node.instanceId": instanceID])

            GatewaySettingsStore.bootstrapPersistence()
            GatewaySettingsStore.bootstrapPersistence()

            let credentials = GatewaySettingsStore.loadGatewayCredentials(
                instanceId: instanceID,
                gatewayStableID: gatewayID)
            #expect(credentials.token == "legacy-token")
            #expect(credentials.bootstrapToken == "legacy-bootstrap")
            #expect(credentials.password == "legacy-password")
            #expect(credentials.suppressStoredDeviceAuth)
            #expect(KeychainStore.loadString(service: gatewayService, account: legacyAccount) == nil)
            #expect(KeychainStore.loadString(service: gatewayService, account: scopedAccount) == nil)
        }
    }

    @Test func `deleting one gateway credentials leaves the other gateway intact`() {
        let instanceID = "credential-forget-\(UUID().uuidString)"
        let gatewayA = "manual|a.example.com|443"
        let gatewayB = "manual|b.example.com|443"
        defer { GatewaySettingsStore.deleteAllGatewayCredentials(instanceId: instanceID) }
        for (gatewayID, token) in [(gatewayA, "token-a"), (gatewayB, "token-b")] {
            GatewaySettingsStore.saveGatewayCredentials(
                token: token,
                bootstrapToken: nil,
                password: nil,
                gatewayStableID: gatewayID,
                suppressStoredDeviceAuth: false,
                instanceId: instanceID)
        }

        GatewaySettingsStore.deleteGatewayCredentials(instanceId: instanceID, stableID: gatewayB)

        #expect(GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: gatewayA).token == "token-a")
        #expect(GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: gatewayB) == .empty)
    }

    @Test func `deleting all credentials includes owners not yet in registry`() {
        let instanceID = "credential-reset-\(UUID().uuidString)"
        let gatewayA = "manual|pending-a.example.com|443"
        let gatewayB = "manual|pending-b.example.com|443"
        defer { GatewaySettingsStore.deleteAllGatewayCredentials(instanceId: instanceID) }
        for gatewayID in [gatewayA, gatewayB] {
            GatewaySettingsStore.saveGatewayCredentials(
                token: "token-\(gatewayID)",
                bootstrapToken: nil,
                password: nil,
                gatewayStableID: gatewayID,
                suppressStoredDeviceAuth: false,
                instanceId: instanceID)
        }

        GatewaySettingsStore.deleteAllGatewayCredentials(instanceId: instanceID)

        #expect(GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: gatewayA) == .empty)
        #expect(GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: gatewayB) == .empty)
    }
}
