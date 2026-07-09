import CryptoKit
import Foundation
import Testing
@testable import OpenClawKit

@Suite(.serialized)
struct DeviceIdentityStoreTests {
    @Test(.stateDirectoryIsolated)
    func `device auth store reports failed durable writes`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let blocker = tempDir.appendingPathComponent("not-a-directory", isDirectory: false)
        try Data().write(to: blocker)
        // Repoint the pinned state dir at a plain file to force write failures;
        // the isolation trait restores the env var after the test.
        setenv("OPENCLAW_STATE_DIR", blocker.path, 1)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let compatibleEntry: DeviceAuthEntry = DeviceAuthStore.storeToken(
            deviceId: "unwritable-device",
            role: "node",
            token: "must-not-be-acknowledged")
        let stored = DeviceAuthStore.storeTokenResult(
            deviceId: "unwritable-device",
            role: "node",
            token: "must-not-be-acknowledged")
        let publicWritePersisted = DeviceAuthStore.storeTokenPersisted(
            deviceId: "unwritable-device",
            role: "node",
            token: "also-must-not-be-acknowledged")
        let durableIdentity = DeviceIdentityStore.loadOrCreatePersisted(profile: .primary)

        #expect(compatibleEntry.token == "must-not-be-acknowledged")
        #expect(!stored.persisted)
        #expect(!publicWritePersisted)
        #expect(durableIdentity == nil)
        #expect(DeviceAuthStore.loadToken(deviceId: "unwritable-device", role: "node") == nil)
    }

    @Test
    func `device auth entry round-trips epoch milliseconds beyond Int32`() throws {
        let epochMilliseconds: Int64 = 1_800_000_000_000
        let entry = DeviceAuthEntry(
            token: "device-token",
            role: "node",
            scopes: [],
            updatedAtMs: epochMilliseconds)

        let data = try JSONEncoder().encode(entry)
        let decoded = try JSONDecoder().decode(DeviceAuthEntry.self, from: data)

        #expect(decoded.updatedAtMs == epochMilliseconds)
    }

    @Test
    func `durable identity creation verifies persisted key material`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let identityURL = tempDir.appendingPathComponent("device.json", isDirectory: false)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let identity = try #require(DeviceIdentityStore.loadOrCreatePersisted(fileURL: identityURL))
        let reloaded = DeviceIdentityStore.loadOrCreate(fileURL: identityURL)

        #expect(reloaded.deviceId == identity.deviceId)
        #expect(reloaded.publicKey == identity.publicKey)
        #expect(reloaded.privateKey == identity.privateKey)
    }

    @Test(.stateDirectoryIsolated)
    func `device auth tokens are isolated by gateway owner`() {
        let deviceID = "test-device"
        _ = DeviceAuthStore.storeToken(deviceId: deviceID, role: "node", token: "legacy-token")
        #expect(DeviceAuthStore.loadToken(deviceId: deviceID, role: "node", gatewayID: "gateway-a") == nil)

        _ = DeviceAuthStore.storeToken(
            deviceId: deviceID,
            role: "node",
            token: "gateway-a-token",
            gatewayID: "gateway-a")
        _ = DeviceAuthStore.storeToken(
            deviceId: deviceID,
            role: "node",
            token: "gateway-b-token",
            gatewayID: "gateway-b")

        #expect(DeviceAuthStore.loadToken(deviceId: deviceID, role: "node")?.token == "legacy-token")
        #expect(DeviceAuthStore.loadToken(
            deviceId: deviceID,
            role: "node",
            gatewayID: "gateway-a")?.token == "gateway-a-token")
        #expect(DeviceAuthStore.loadToken(
            deviceId: deviceID,
            role: "node",
            gatewayID: "gateway-b")?.token == "gateway-b-token")

        DeviceAuthStore.clearToken(deviceId: deviceID, role: "node", gatewayID: "gateway-b")
        #expect(DeviceAuthStore.loadToken(
            deviceId: deviceID,
            role: "node",
            gatewayID: "gateway-a")?.token == "gateway-a-token")
        #expect(DeviceAuthStore.loadToken(deviceId: deviceID, role: "node", gatewayID: "gateway-b") == nil)

        DeviceAuthStore.clearToken(deviceId: deviceID, role: "node")
        #expect(DeviceAuthStore.loadToken(deviceId: deviceID, role: "node") == nil)
        #expect(DeviceAuthStore.loadToken(deviceId: deviceID, role: "node", gatewayID: "gateway-a") == nil)
    }

    @Test(.stateDirectoryIsolated)
    func `legacy device auth migration claims only the proven role`() {
        let deviceID = "legacy-device"
        _ = DeviceAuthStore.storeToken(
            deviceId: deviceID,
            role: "node",
            token: "legacy-node-token")
        _ = DeviceAuthStore.storeToken(
            deviceId: deviceID,
            role: "operator",
            token: "legacy-operator-token")

        #expect(DeviceAuthStore.migrateUnscopedToken(
            deviceId: deviceID,
            role: "node",
            toGatewayID: "trusted-gateway"))
        #expect(DeviceAuthStore.loadToken(deviceId: deviceID, role: "node") == nil)
        #expect(DeviceAuthStore.loadToken(
            deviceId: deviceID,
            role: "node",
            gatewayID: "trusted-gateway")?.token == "legacy-node-token")
        #expect(DeviceAuthStore.loadToken(
            deviceId: deviceID,
            role: "operator",
            gatewayID: "trusted-gateway") == nil)
        #expect(DeviceAuthStore.loadToken(
            deviceId: deviceID,
            role: "operator")?.token == "legacy-operator-token")
        #expect(DeviceAuthStore.loadToken(
            deviceId: deviceID,
            role: "node",
            gatewayID: "other-gateway") == nil)
        #expect(!DeviceAuthStore.migrateUnscopedToken(
            deviceId: deviceID,
            role: "node",
            toGatewayID: "other-gateway"))

        _ = DeviceAuthStore.storeToken(
            deviceId: deviceID,
            role: "node",
            token: "ambiguous-legacy-token")
        #expect(DeviceAuthStore.discardUnscopedTokens(deviceId: deviceID) == 2)
        #expect(DeviceAuthStore.loadToken(deviceId: deviceID, role: "node") == nil)
        #expect(DeviceAuthStore.loadToken(
            deviceId: deviceID,
            role: "node",
            gatewayID: "trusted-gateway")?.token == "legacy-node-token")
    }

    @Test
    func `state directory override wins over shared app group storage`() {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let overrideURL = tempDir.appendingPathComponent("override", isDirectory: true)
        let legacyURL = tempDir.appendingPathComponent("legacy", isDirectory: true)
        let sharedURL = tempDir.appendingPathComponent("shared", isDirectory: true)

        let selected = DeviceIdentityPaths.stateDirURL(
            overrideURL: overrideURL,
            legacyStateDirURL: legacyURL,
            appGroupStateDirURL: sharedURL,
            temporaryDirectory: tempDir)

        #expect(selected == overrideURL)
        #expect(!FileManager.default.fileExists(atPath: sharedURL.path))
    }

    @Test
    func `shared app group storage wins over legacy app support storage`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let legacyURL = tempDir.appendingPathComponent("legacy", isDirectory: true)
        let sharedURL = tempDir.appendingPathComponent("shared", isDirectory: true)
        let legacyIdentityURL = legacyURL.appendingPathComponent("identity", isDirectory: true)
        let legacyDeviceURL = legacyIdentityURL.appendingPathComponent("device.json", isDirectory: false)
        let sharedIdentityURL = sharedURL.appendingPathComponent("identity", isDirectory: true)
        let sharedDeviceURL = sharedIdentityURL.appendingPathComponent("device.json", isDirectory: false)
        try FileManager.default.createDirectory(at: legacyIdentityURL, withIntermediateDirectories: true)
        try "legacy-device\n".write(to: legacyDeviceURL, atomically: true, encoding: .utf8)

        let selected = DeviceIdentityPaths.stateDirURL(
            overrideURL: nil,
            legacyStateDirURL: legacyURL,
            appGroupStateDirURL: sharedURL,
            temporaryDirectory: tempDir)

        #expect(selected == sharedURL)
        #expect(!FileManager.default.fileExists(atPath: sharedDeviceURL.path))
    }

    @Test
    func `legacy app support storage wins when app group storage is not available`() {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let legacyURL = tempDir.appendingPathComponent("legacy", isDirectory: true)
        let sharedURL = tempDir.appendingPathComponent("shared", isDirectory: true)

        let selected = DeviceIdentityPaths.stateDirURL(
            overrideURL: nil,
            legacyStateDirURL: legacyURL,
            appGroupStateDirURL: sharedURL,
            appGroupStateDirAvailable: false,
            temporaryDirectory: tempDir)

        #expect(selected == legacyURL)
    }

    @Test(.stateDirectoryIsolated)
    func `secondary profiles use separate identity and auth files`() throws {
        let primaryIdentity = DeviceIdentityStore.loadOrCreate()
        let nodeIdentity = DeviceIdentityStore.loadOrCreate(profile: .node)
        let shareIdentity = DeviceIdentityStore.loadOrCreate(profile: .shareExtension)
        _ = DeviceAuthStore.storeToken(
            deviceId: primaryIdentity.deviceId,
            role: "node",
            token: "primary-token")
        _ = DeviceAuthStore.storeToken(
            deviceId: nodeIdentity.deviceId,
            role: "node",
            token: "node-token",
            profile: .node)
        _ = DeviceAuthStore.storeToken(
            deviceId: shareIdentity.deviceId,
            role: "node",
            token: "share-token",
            profile: .shareExtension)

        // getenv, not ProcessInfo: the trait pins OPENCLAW_STATE_DIR via setenv and
        // ProcessInfo.environment can serve a stale snapshot on Darwin.
        let stateDirPath = try #require(getenv("OPENCLAW_STATE_DIR").map { String(cString: $0) })
        let identityDir = URL(fileURLWithPath: stateDirPath, isDirectory: true)
            .appendingPathComponent("identity", isDirectory: true)
        #expect(primaryIdentity.deviceId != nodeIdentity.deviceId)
        #expect(primaryIdentity.deviceId != shareIdentity.deviceId)
        #expect(FileManager.default.fileExists(atPath: identityDir.appendingPathComponent("device.json").path))
        #expect(FileManager.default.fileExists(atPath: identityDir.appendingPathComponent("node-device.json").path))
        #expect(FileManager.default.fileExists(atPath: identityDir.appendingPathComponent("share-device.json").path))
        #expect(FileManager.default.fileExists(atPath: identityDir.appendingPathComponent("device-auth.json").path))
        #expect(FileManager.default
            .fileExists(atPath: identityDir.appendingPathComponent("node-device-auth.json").path))
        #expect(FileManager.default
            .fileExists(atPath: identityDir.appendingPathComponent("share-device-auth.json").path))
        #expect(DeviceAuthStore.loadToken(deviceId: primaryIdentity.deviceId, role: "node")?.token == "primary-token")
        #expect(DeviceAuthStore.loadToken(
            deviceId: nodeIdentity.deviceId,
            role: "node",
            profile: .node)?.token == "node-token")
        #expect(
            DeviceAuthStore
                .loadToken(deviceId: shareIdentity.deviceId, role: "node", profile: .shareExtension)?.token ==
                "share-token")

        DeviceAuthStore.clearAll(profile: .shareExtension)

        #expect(DeviceAuthStore.loadToken(deviceId: primaryIdentity.deviceId, role: "node")?.token == "primary-token")
        #expect(DeviceAuthStore.loadToken(
            deviceId: nodeIdentity.deviceId,
            role: "node",
            profile: .node)?.token == "node-token")
        #expect(DeviceAuthStore
            .loadToken(deviceId: shareIdentity.deviceId, role: "node", profile: .shareExtension) == nil)
    }

    @Test
    func `loads TypeScript PEM identity schema without rewriting or regenerating`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let identityURL = tempDir
            .appendingPathComponent("identity", isDirectory: true)
            .appendingPathComponent("device.json", isDirectory: false)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        try FileManager.default.createDirectory(
            at: identityURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        let stored = try Self.identityJSON(
            publicKeyPem: Self.pem(
                label: "PUBLIC KEY",
                body: "MCowBQYDK2VwAyEAA6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg="),
            privateKeyPem: Self.pem(
                label: "PRIVATE KEY",
                body: "MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f"))
        try stored.write(to: identityURL, atomically: true, encoding: .utf8)
        let before = try String(contentsOf: identityURL, encoding: .utf8)

        let identity = DeviceIdentityStore.loadOrCreate(fileURL: identityURL)

        #expect(identity.deviceId == "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c")
        #expect(identity.publicKey == "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=")
        #expect(identity.privateKey == "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=")
        #expect(identity.createdAtMs == 1_800_000_000_000)
        #expect(DeviceIdentityStore.publicKeyBase64Url(identity) == "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg")
        let signature = try #require(DeviceIdentityStore.signPayload("hello", identity: identity))
        let publicKeyData = try #require(Data(base64Encoded: identity.publicKey))
        let signatureData = try #require(Self.base64UrlDecode(signature))
        let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: publicKeyData)
        #expect(publicKey.isValidSignature(signatureData, for: Data("hello".utf8)))
        #expect(try String(contentsOf: identityURL, encoding: .utf8) == before)
    }

    @Test
    func `does not overwrite a recognized invalid TypeScript identity schema`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let identityURL = tempDir
            .appendingPathComponent("identity", isDirectory: true)
            .appendingPathComponent("device.json", isDirectory: false)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        try FileManager.default.createDirectory(
            at: identityURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        let stored = """
        {
          "version": 1,
          "deviceId": "stale-device-id",
          "publicKeyPem": "not-a-valid-public-key",
          "privateKeyPem": "not-a-valid-private-key",
          "createdAtMs": 1700000000000
        }
        """
        try stored.write(to: identityURL, atomically: true, encoding: .utf8)
        let before = try String(contentsOf: identityURL, encoding: .utf8)

        let identity = DeviceIdentityStore.loadOrCreate(fileURL: identityURL)

        #expect(identity.deviceId != "stale-device-id")
        #expect(try String(contentsOf: identityURL, encoding: .utf8) == before)
    }

    @Test
    func `does not overwrite an existing unrecognized identity file`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let identityURL = tempDir
            .appendingPathComponent("identity", isDirectory: true)
            .appendingPathComponent("device.json", isDirectory: false)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        try FileManager.default.createDirectory(
            at: identityURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        let stored = """
        {
          "schema": "future-openclaw-device-identity",
          "stableDeviceId": "app-group-device-id"
        }
        """
        try stored.write(to: identityURL, atomically: true, encoding: .utf8)
        let before = try String(contentsOf: identityURL, encoding: .utf8)

        let identity = DeviceIdentityStore.loadOrCreate(fileURL: identityURL)

        #expect(identity.deviceId != "app-group-device-id")
        #expect(try String(contentsOf: identityURL, encoding: .utf8) == before)
    }

    @Test
    func `migrates an existing app group identity and auth store when falling back to legacy storage`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let appGroupURL = tempDir.appendingPathComponent("shared", isDirectory: true)
        let appGroupIdentityURL = appGroupURL
            .appendingPathComponent("identity", isDirectory: true)
            .appendingPathComponent("device.json", isDirectory: false)
        let appGroupAuthURL = appGroupIdentityURL
            .deletingLastPathComponent()
            .appendingPathComponent("device-auth.json", isDirectory: false)
        let legacyIdentityURL = tempDir
            .appendingPathComponent("legacy", isDirectory: true)
            .appendingPathComponent("identity", isDirectory: true)
            .appendingPathComponent("device.json", isDirectory: false)
        let legacyAuthURL = legacyIdentityURL
            .deletingLastPathComponent()
            .appendingPathComponent("device-auth.json", isDirectory: false)
        try FileManager.default.createDirectory(
            at: appGroupIdentityURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        let stored = try Self.identityJSON(
            publicKeyPem: Self.pem(
                label: "PUBLIC KEY",
                body: "MCowBQYDK2VwAyEAA6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg="),
            privateKeyPem: Self.pem(
                label: "PRIVATE KEY",
                body: "MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f"))
        try stored.write(to: appGroupIdentityURL, atomically: true, encoding: .utf8)
        let storedAuth = #"{"version":1,"deviceId":"app-group-device-id","tokens":{}}"#
        try storedAuth.write(to: appGroupAuthURL, atomically: true, encoding: .utf8)
        let appGroupBefore = try String(contentsOf: appGroupIdentityURL, encoding: .utf8)

        let migrationSource = DeviceIdentityPaths.appGroupMigrationSource(
            appGroupStateDirURL: appGroupURL,
            appGroupStateDirAvailable: false,
            stateDirOverridden: false,
            profile: .primary)
        let identity = DeviceIdentityStore.loadOrCreate(
            fileURL: legacyIdentityURL,
            migrationSource: migrationSource)

        #expect(identity.deviceId == "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c")
        #expect(FileManager.default.fileExists(atPath: legacyIdentityURL.path))
        let reloaded = DeviceIdentityStore.loadOrCreate(fileURL: legacyIdentityURL)
        #expect(reloaded.deviceId == identity.deviceId)
        #expect(try String(contentsOf: appGroupIdentityURL, encoding: .utf8) == appGroupBefore)
        #expect(try String(contentsOf: legacyAuthURL, encoding: .utf8) == storedAuth)
        #expect(try String(contentsOf: appGroupAuthURL, encoding: .utf8) == storedAuth)
    }

    @Test
    func `does not clobber an existing auth store when migrating an app group identity`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let appGroupIdentityDirURL = tempDir
            .appendingPathComponent("shared", isDirectory: true)
            .appendingPathComponent("identity", isDirectory: true)
        let legacyIdentityDirURL = tempDir
            .appendingPathComponent("legacy", isDirectory: true)
            .appendingPathComponent("identity", isDirectory: true)
        try FileManager.default.createDirectory(at: appGroupIdentityDirURL, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: legacyIdentityDirURL, withIntermediateDirectories: true)
        let stored = try Self.identityJSON(
            publicKeyPem: Self.pem(
                label: "PUBLIC KEY",
                body: "MCowBQYDK2VwAyEAA6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg="),
            privateKeyPem: Self.pem(
                label: "PRIVATE KEY",
                body: "MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f"))
        try stored.write(
            to: appGroupIdentityDirURL.appendingPathComponent("device.json", isDirectory: false),
            atomically: true,
            encoding: .utf8)
        try #"{"version":1,"deviceId":"app-group-device-id","tokens":{}}"#.write(
            to: appGroupIdentityDirURL.appendingPathComponent("device-auth.json", isDirectory: false),
            atomically: true,
            encoding: .utf8)
        let legacyAuthURL = legacyIdentityDirURL.appendingPathComponent("device-auth.json", isDirectory: false)
        let existingLegacyAuth = #"{"version":1,"deviceId":"legacy-device-id","tokens":{}}"#
        try existingLegacyAuth.write(to: legacyAuthURL, atomically: true, encoding: .utf8)

        let identity = DeviceIdentityStore.loadOrCreate(
            fileURL: legacyIdentityDirURL.appendingPathComponent("device.json", isDirectory: false),
            migrationSource: DeviceIdentityPaths.appGroupMigrationSource(
                appGroupStateDirURL: tempDir.appendingPathComponent("shared", isDirectory: true),
                appGroupStateDirAvailable: false,
                stateDirOverridden: false,
                profile: .primary))

        #expect(identity.deviceId == "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c")
        #expect(try String(contentsOf: legacyAuthURL, encoding: .utf8) == existingLegacyAuth)
    }

    @Test
    func `keeps an existing legacy identity instead of migrating the app group copy`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let appGroupURL = tempDir.appendingPathComponent("shared", isDirectory: true)
        let appGroupIdentityURL = appGroupURL
            .appendingPathComponent("identity", isDirectory: true)
            .appendingPathComponent("device.json", isDirectory: false)
        let legacyIdentityURL = tempDir
            .appendingPathComponent("legacy", isDirectory: true)
            .appendingPathComponent("identity", isDirectory: true)
            .appendingPathComponent("device.json", isDirectory: false)
        try FileManager.default.createDirectory(
            at: appGroupIdentityURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        let stored = try Self.identityJSON(
            publicKeyPem: Self.pem(
                label: "PUBLIC KEY",
                body: "MCowBQYDK2VwAyEAA6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg="),
            privateKeyPem: Self.pem(
                label: "PRIVATE KEY",
                body: "MC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f"))
        try stored.write(to: appGroupIdentityURL, atomically: true, encoding: .utf8)

        let existingLegacy = DeviceIdentityStore.loadOrCreate(fileURL: legacyIdentityURL)
        let migrationSource = DeviceIdentityPaths.appGroupMigrationSource(
            appGroupStateDirURL: appGroupURL,
            appGroupStateDirAvailable: false,
            stateDirOverridden: false,
            profile: .primary)
        let identity = DeviceIdentityStore.loadOrCreate(
            fileURL: legacyIdentityURL,
            migrationSource: migrationSource)

        #expect(identity.deviceId == existingLegacy.deviceId)
        #expect(identity.deviceId != "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c")
    }

    @Test
    func `provides no app group migration source when the entitlement is present`() {
        let appGroupURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        #expect(DeviceIdentityPaths.appGroupMigrationSource(
            appGroupStateDirURL: appGroupURL,
            appGroupStateDirAvailable: true,
            stateDirOverridden: false,
            profile: .primary) == nil)
    }

    // Regression: an explicit OPENCLAW_STATE_DIR override must never import the
    // machine's app-group identity/tokens; developer-Mac pairing state leaked
    // into isolated test state dirs through this migration path.
    @Test
    func `provides no app group migration source when the state dir is overridden`() {
        let appGroupURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        #expect(DeviceIdentityPaths.appGroupMigrationSource(
            appGroupStateDirURL: appGroupURL,
            appGroupStateDirAvailable: false,
            stateDirOverridden: true,
            profile: .primary) == nil)
    }

    private static func base64UrlDecode(_ value: String) -> Data? {
        let normalized = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padded = normalized + String(repeating: "=", count: (4 - normalized.count % 4) % 4)
        return Data(base64Encoded: padded)
    }

    private static func identityJSON(publicKeyPem: String, privateKeyPem: String) throws -> String {
        let object: [String: Any] = [
            "version": 1,
            "deviceId": "stale-device-id",
            "publicKeyPem": publicKeyPem,
            "privateKeyPem": privateKeyPem,
            "createdAtMs": Int64(1_800_000_000_000),
        ]
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        return String(decoding: data, as: UTF8.self) + "\n"
    }

    private static func pem(label: String, body: String) -> String {
        "-----BEGIN \(label)-----\n\(body)\n-----END \(label)-----\n"
    }
}
