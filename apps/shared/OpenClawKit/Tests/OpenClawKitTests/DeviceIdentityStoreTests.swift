import CryptoKit
import Foundation
import SQLite3
import Testing
@testable import OpenClawKit

@Suite(.serialized)
struct DeviceIdentityStoreTests {
    @Test
    func `task scoped state directories isolate concurrent identity stores`() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let stateDirectories = [
            root.appendingPathComponent("a", isDirectory: true),
            root.appendingPathComponent("b", isDirectory: true),
        ]
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let observed = await withTaskGroup(of: String.self) { group in
            for stateDirectory in stateDirectories {
                group.addTask {
                    await DeviceIdentityStore.withStateDirectory(stateDirectory) {
                        let identity = DeviceIdentityStore.loadOrCreate()
                        await Task.yield()
                        #expect(DeviceIdentityStore.loadOrCreate().deviceId == identity.deviceId)
                        return identity.deviceId
                    }
                }
            }
            return await group.reduce(into: Set<String>()) { result, deviceId in
                result.insert(deviceId)
            }
        }

        #expect(observed.count == stateDirectories.count)
        for stateDirectory in stateDirectories {
            #expect(FileManager.default.fileExists(
                atPath: stateDirectory.appendingPathComponent("state/openclaw.sqlite").path))
        }
    }

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
        let databaseURL = tempDir.appendingPathComponent("openclaw.sqlite", isDirectory: false)
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let identity = try DeviceIdentitySQLiteStore.loadOrCreate(
            databaseURL: databaseURL,
            destinationStateDirURL: tempDir,
            profile: .primary,
            legacySources: [])
        let reloaded = try DeviceIdentitySQLiteStore.loadOrCreate(
            databaseURL: databaseURL,
            destinationStateDirURL: tempDir,
            profile: .primary)

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
    func `device auth owners preserve exact unicode bytes`() throws {
        let deviceID = "exact-owner-device"
        let composedOwner = "gateway-\u{00E9}"
        let decomposedOwner = "gateway-e\u{0301}"
        let nextLineOwner = "\u{0085}gateway"
        #expect(composedOwner == decomposedOwner)
        #expect(!DeviceAuthStore.storeTokenPersisted(
            deviceId: deviceID,
            role: "node",
            token: "must-not-become-unscoped",
            gatewayID: ""))
        #expect(DeviceAuthStore.loadToken(deviceId: deviceID, role: "node") == nil)

        for (owner, token) in [
            (composedOwner, "composed-token"),
            (decomposedOwner, "decomposed-token"),
            (nextLineOwner, "next-line-token"),
        ] {
            #expect(DeviceAuthStore.storeTokenPersisted(
                deviceId: deviceID,
                role: "node",
                token: token,
                gatewayID: owner))
        }

        #expect(DeviceAuthStore.loadToken(
            deviceId: deviceID,
            role: "node",
            gatewayID: composedOwner)?.token == "composed-token")
        #expect(DeviceAuthStore.loadToken(
            deviceId: deviceID,
            role: "node",
            gatewayID: decomposedOwner)?.token == "decomposed-token")
        #expect(DeviceAuthStore.loadToken(
            deviceId: deviceID,
            role: "node",
            gatewayID: nextLineOwner)?.token == "next-line-token")

        let stateDirPath = try #require(getenv("OPENCLAW_STATE_DIR").map { String(cString: $0) })
        let authURL = URL(fileURLWithPath: stateDirPath, isDirectory: true)
            .appendingPathComponent("identity", isDirectory: true)
            .appendingPathComponent("device-auth.json", isDirectory: false)
        let raw = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: authURL)) as? [String: Any])
        let tokens = try #require(raw["tokens"] as? [String: Any])
        #expect(tokens.count == 3)

        DeviceAuthStore.clearToken(deviceId: deviceID, role: "node", gatewayID: decomposedOwner)
        #expect(DeviceAuthStore.loadToken(
            deviceId: deviceID,
            role: "node",
            gatewayID: composedOwner)?.token == "composed-token")
        #expect(DeviceAuthStore.loadToken(
            deviceId: deviceID,
            role: "node",
            gatewayID: decomposedOwner) == nil)
    }

    @Test(.stateDirectoryIsolated)
    func `legacy raw owner keys migrate without canonical aliasing`() throws {
        let deviceID = "legacy-exact-owner-device"
        let composedOwner = "gateway-\u{00E9}"
        let decomposedOwner = "gateway-e\u{0301}"
        let stateDirPath = try #require(getenv("OPENCLAW_STATE_DIR").map { String(cString: $0) })
        let identityURL = URL(fileURLWithPath: stateDirPath, isDirectory: true)
            .appendingPathComponent("identity", isDirectory: true)
        let authURL = identityURL.appendingPathComponent("device-auth.json", isDirectory: false)
        try FileManager.default.createDirectory(at: identityURL, withIntermediateDirectories: true)
        let legacy: [String: Any] = [
            "version": 1,
            "deviceId": deviceID,
            "tokens": [
                "\(composedOwner)\u{1F}node": [
                    "token": "legacy-composed-token",
                    "role": "node",
                    "scopes": [],
                    "updatedAtMs": 1,
                    "gatewayID": composedOwner,
                ],
            ],
        ]
        try JSONSerialization.data(withJSONObject: legacy).write(to: authURL, options: [.atomic])

        #expect(DeviceAuthStore.loadToken(
            deviceId: deviceID,
            role: "node",
            gatewayID: composedOwner)?.token == "legacy-composed-token")
        #expect(DeviceAuthStore.storeTokenPersisted(
            deviceId: deviceID,
            role: "node",
            token: "new-decomposed-token",
            gatewayID: decomposedOwner))
        #expect(DeviceAuthStore.loadToken(
            deviceId: deviceID,
            role: "node",
            gatewayID: composedOwner)?.token == "legacy-composed-token")
        #expect(DeviceAuthStore.loadToken(
            deviceId: deviceID,
            role: "node",
            gatewayID: decomposedOwner)?.token == "new-decomposed-token")
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

    @Test
    func `task scoped state directory never probes machine legacy roots`() async {
        let scopedURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)

        await DeviceIdentityStore.withStateDirectory(scopedURL) {
            let sources = DeviceIdentityPaths.legacyIdentitySources(profile: .primary)
            #expect(sources.map(\.stateDirURL) == [scopedURL.standardizedFileURL])
        }
    }

    @Test(.stateDirectoryIsolated)
    func `secondary profiles use separate identity rows and auth files`() throws {
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
        let stateDir = URL(fileURLWithPath: stateDirPath, isDirectory: true)
        let identityDir = stateDir.appendingPathComponent("identity", isDirectory: true)
        #expect(primaryIdentity.deviceId != nodeIdentity.deviceId)
        #expect(primaryIdentity.deviceId != shareIdentity.deviceId)
        #expect(try Self.scalarInt(
            stateDir.appendingPathComponent("state/openclaw.sqlite"),
            "SELECT COUNT(*) FROM device_identities") == 3)
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
    func `fresh database creates only canonical identity schema and leaves user version zero`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let databaseURL = tempDir.appendingPathComponent("openclaw.sqlite", isDirectory: false)

        _ = try DeviceIdentitySQLiteStore.loadOrCreate(
            databaseURL: databaseURL,
            destinationStateDirURL: tempDir,
            profile: .primary)

        #expect(try Self.scalarInt(databaseURL, "PRAGMA user_version") == 0)
        #expect(try Self.scalarText(
            databaseURL,
            """
            SELECT group_concat(type || ':' || name, ',')
            FROM (SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name)
            """) == "index:idx_device_identities_device,table:device_identities")
        let directoryMode = try #require(
            FileManager.default.attributesOfItem(atPath: tempDir.path)[.posixPermissions] as? NSNumber)
        let databaseMode = try #require(
            FileManager.default.attributesOfItem(atPath: databaseURL.path)[.posixPermissions] as? NSNumber)
        #expect(directoryMode.intValue & 0o777 == 0o700)
        #expect(databaseMode.intValue & 0o777 == 0o600)
    }

    @Test
    func `Node PEM fixture repairs a stale device id and remains signing compatible`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let sourceRoot = tempDir.appendingPathComponent("Application Support/OpenClaw", isDirectory: true)
        let source = try Self.writeLegacyIdentity(
            stateDirURL: sourceRoot,
            profile: .primary,
            contents: Self.nodePEMIdentityJSON(deviceId: "stale-device-id"))
        let databaseURL = tempDir.appendingPathComponent("destination/openclaw.sqlite", isDirectory: false)
        let destination = databaseURL.deletingLastPathComponent()

        let identity = try DeviceIdentitySQLiteStore.loadOrCreate(
            databaseURL: databaseURL,
            destinationStateDirURL: destination,
            profile: .primary,
            legacySources: [source])

        #expect(identity.deviceId == Self.fixtureDeviceID)
        #expect(identity.publicKey == Self.fixturePublicKeyRaw)
        #expect(identity.privateKey == Self.fixturePrivateKeyRaw)
        #expect(identity.createdAtMs == 1_800_000_000_000)
        #expect(!FileManager.default.fileExists(atPath: source.identityURL.path))
        #expect(try Self.scalarText(
            databaseURL,
            "SELECT public_key_pem FROM device_identities WHERE identity_key = 'primary'") == Self.fixturePublicKeyPEM)
        #expect(try Self.scalarText(
            databaseURL,
            "SELECT private_key_pem FROM device_identities WHERE identity_key = 'primary'") == Self
            .fixturePrivateKeyPEM)
        #expect(DeviceIdentityStore.publicKeyBase64Url(identity) == "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg")
        let signature = try #require(DeviceIdentityStore.signPayload("hello", identity: identity))
        let publicKey = try Curve25519.Signing.PublicKey(
            rawRepresentation: #require(Data(base64Encoded: identity.publicKey)))
        #expect(try publicKey.isValidSignature(
            #require(Self.base64UrlDecode(signature)),
            for: Data("hello".utf8)))
    }

    @Test
    func `reads a canonical Node SQLite row without rewriting it`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let databaseURL = tempDir.appendingPathComponent("openclaw.sqlite", isDirectory: false)
        try Self.seedCanonicalSchema(databaseURL, nodeOwned: true)
        try Self.execute(databaseURL, """
        INSERT INTO device_identities (
          identity_key, device_id, public_key_pem, private_key_pem, created_at_ms, updated_at_ms
        ) VALUES (
          'node', '\(Self.fixtureDeviceID)', '\(Self.sql(Self.fixturePublicKeyPEM))',
          '\(Self.sql(Self.fixturePrivateKeyPEM))', 1800000000000, 1800000000123
        )
        """)

        let identity = try DeviceIdentitySQLiteStore.loadOrCreate(
            databaseURL: databaseURL,
            destinationStateDirURL: tempDir,
            profile: .node)

        #expect(identity.deviceId == Self.fixtureDeviceID)
        #expect(identity.createdAtMs == 1_800_000_000_000)
        #expect(try Self.scalarInt(
            databaseURL,
            "SELECT updated_at_ms FROM device_identities WHERE identity_key = 'node'") == 1_800_000_000_123)
    }

    @Test
    func `same key migration preserves the authoritative SQLite timestamp`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let databaseURL = tempDir.appendingPathComponent("openclaw.sqlite", isDirectory: false)
        try Self.seedCanonicalSchema(databaseURL, nodeOwned: true)
        try Self.execute(databaseURL, """
        INSERT INTO device_identities (
          identity_key, device_id, public_key_pem, private_key_pem, created_at_ms, updated_at_ms
        ) VALUES (
          'primary', '\(Self.fixtureDeviceID)', '\(Self.sql(Self.fixturePublicKeyPEM))',
          '\(Self.sql(Self.fixturePrivateKeyPEM))', 1700000000000, 1700000000123
        )
        """)
        let source = try Self.writeLegacyIdentity(
            stateDirURL: tempDir.appendingPathComponent("legacy", isDirectory: true),
            profile: .primary,
            contents: Self.nodePEMIdentityJSON())

        let identity = try DeviceIdentitySQLiteStore.loadOrCreate(
            databaseURL: databaseURL,
            destinationStateDirURL: tempDir,
            profile: .primary,
            legacySources: [source])

        #expect(identity.deviceId == Self.fixtureDeviceID)
        #expect(identity.createdAtMs == 1_700_000_000_000)
        #expect(try Self.scalarInt(
            databaseURL,
            "SELECT updated_at_ms FROM device_identities WHERE identity_key = 'primary'") == 1_700_000_000_123)
        #expect(!FileManager.default.fileExists(atPath: source.identityURL.path))
    }

    @Test
    func `strict legacy validation preserves invalid source and creates no row`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let invalidJSON = try Self.nodePEMIdentityJSON(privateKeyPem: "not-a-private-key")
        let source = try Self.writeLegacyIdentity(
            stateDirURL: tempDir.appendingPathComponent("shared", isDirectory: true),
            profile: .primary,
            contents: invalidJSON)
        let databaseURL = tempDir.appendingPathComponent("destination/openclaw.sqlite")

        #expect(throws: NSError.self) {
            try DeviceIdentitySQLiteStore.loadOrCreate(
                databaseURL: databaseURL,
                destinationStateDirURL: databaseURL.deletingLastPathComponent(),
                profile: .primary,
                legacySources: [source])
        }
        #expect(FileManager.default.fileExists(atPath: source.identityURL.path))
        #expect(!FileManager.default.fileExists(atPath: databaseURL.path))
    }

    @Test
    func `pending Doctor claim blocks identity generation`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let sourceRoot = tempDir.appendingPathComponent("legacy", isDirectory: true)
        let source = try Self.writeLegacyIdentity(
            stateDirURL: sourceRoot,
            profile: .primary,
            contents: Self.nodePEMIdentityJSON())
        let claimURL = URL(
            fileURLWithPath: source.identityURL.path + ".doctor-importing",
            isDirectory: false)
        try FileManager.default.moveItem(at: source.identityURL, to: claimURL)
        let destination = tempDir.appendingPathComponent("destination", isDirectory: true)
        let databaseURL = destination.appendingPathComponent("openclaw.sqlite", isDirectory: false)

        #expect(throws: NSError.self) {
            try DeviceIdentitySQLiteStore.loadOrCreate(
                databaseURL: databaseURL,
                destinationStateDirURL: destination,
                profile: .primary,
                legacySources: [source])
        }

        #expect(FileManager.default.fileExists(atPath: claimURL.path))
        #expect(!FileManager.default.fileExists(atPath: databaseURL.path))
    }

    @Test
    func `Doctor rename winning native claim race blocks identity generation`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let source = try Self.writeLegacyIdentity(
            stateDirURL: tempDir.appendingPathComponent("legacy", isDirectory: true),
            profile: .primary,
            contents: Self.nodePEMIdentityJSON())
        let claimURL = URL(
            fileURLWithPath: source.identityURL.path + ".doctor-importing",
            isDirectory: false)
        let destination = tempDir.appendingPathComponent("destination", isDirectory: true)
        let databaseURL = destination.appendingPathComponent("openclaw.sqlite", isDirectory: false)

        #expect(throws: NSError.self) {
            try DeviceIdentitySQLiteStore.loadOrCreate(
                databaseURL: databaseURL,
                destinationStateDirURL: destination,
                profile: .primary,
                legacySources: [source],
                beforeLegacyClaim: { _ in
                    try FileManager.default.moveItem(at: source.identityURL, to: claimURL)
                })
        }

        #expect(FileManager.default.fileExists(atPath: claimURL.path))
        #expect(!FileManager.default.fileExists(atPath: databaseURL.path))
    }

    @Test
    func `interrupted native claim resumes without rotating identity`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let source = try Self.writeLegacyIdentity(
            stateDirURL: tempDir.appendingPathComponent("legacy", isDirectory: true),
            profile: .primary,
            contents: Self.nodePEMIdentityJSON())
        let claimURL = URL(
            fileURLWithPath: source.identityURL.path + ".native-importing",
            isDirectory: false)
        try FileManager.default.moveItem(at: source.identityURL, to: claimURL)
        let destination = tempDir.appendingPathComponent("destination", isDirectory: true)
        let databaseURL = destination.appendingPathComponent("openclaw.sqlite", isDirectory: false)

        let identity = try DeviceIdentitySQLiteStore.loadOrCreate(
            databaseURL: databaseURL,
            destinationStateDirURL: destination,
            profile: .primary,
            legacySources: [source])

        #expect(identity.deviceId == Self.fixtureDeviceID)
        #expect(!FileManager.default.fileExists(atPath: source.identityURL.path))
        #expect(!FileManager.default.fileExists(atPath: claimURL.path))
    }

    @Test
    func `source reappearance preserves both native claim and recreated source`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let legacyData = try Self.nodePEMIdentityJSON()
        let source = try Self.writeLegacyIdentity(
            stateDirURL: tempDir.appendingPathComponent("legacy", isDirectory: true),
            profile: .primary,
            contents: legacyData)
        let claimURL = URL(
            fileURLWithPath: source.identityURL.path + ".native-importing",
            isDirectory: false)
        let destination = tempDir.appendingPathComponent("destination", isDirectory: true)
        let databaseURL = destination.appendingPathComponent("openclaw.sqlite", isDirectory: false)

        #expect(throws: NSError.self) {
            try DeviceIdentitySQLiteStore.loadOrCreate(
                databaseURL: databaseURL,
                destinationStateDirURL: destination,
                profile: .primary,
                legacySources: [source],
                afterLegacyCommit: {
                    try legacyData.write(to: source.identityURL, atomically: true, encoding: .utf8)
                })
        }

        #expect(FileManager.default.fileExists(atPath: source.identityURL.path))
        #expect(FileManager.default.fileExists(atPath: claimURL.path))
        #expect(try Self.scalarText(
            databaseURL,
            "SELECT device_id FROM device_identities WHERE identity_key = 'primary'") == Self.fixtureDeviceID)
    }

    @Test
    func `multi source rollback restores every independent native claim`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let legacyData = try Self.nodePEMIdentityJSON()
        let first = try Self.writeLegacyIdentity(
            stateDirURL: tempDir.appendingPathComponent("first", isDirectory: true),
            profile: .primary,
            contents: legacyData)
        let second = try Self.writeLegacyIdentity(
            stateDirURL: tempDir.appendingPathComponent("second", isDirectory: true),
            profile: .primary,
            contents: legacyData)
        let firstClaimURL = URL(
            fileURLWithPath: first.identityURL.path + ".native-importing",
            isDirectory: false)
        let secondClaimURL = URL(
            fileURLWithPath: second.identityURL.path + ".native-importing",
            isDirectory: false)
        let destination = tempDir.appendingPathComponent("destination", isDirectory: true)
        let databaseURL = destination.appendingPathComponent("openclaw.sqlite", isDirectory: false)

        #expect(throws: NSError.self) {
            try DeviceIdentitySQLiteStore.loadOrCreate(
                databaseURL: databaseURL,
                destinationStateDirURL: destination,
                profile: .primary,
                legacySources: [first, second],
                afterLegacyCommit: {
                    try legacyData.write(to: second.identityURL, atomically: true, encoding: .utf8)
                })
        }

        #expect(FileManager.default.fileExists(atPath: first.identityURL.path))
        #expect(!FileManager.default.fileExists(atPath: firstClaimURL.path))
        #expect(FileManager.default.fileExists(atPath: second.identityURL.path))
        #expect(FileManager.default.fileExists(atPath: secondClaimURL.path))
    }

    @Test
    func `post commit identity change restores native claim before cleanup`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let source = try Self.writeLegacyIdentity(
            stateDirURL: tempDir.appendingPathComponent("legacy", isDirectory: true),
            profile: .primary,
            contents: Self.nodePEMIdentityJSON())
        let claimURL = URL(
            fileURLWithPath: source.identityURL.path + ".native-importing",
            isDirectory: false)
        let destination = tempDir.appendingPathComponent("destination", isDirectory: true)
        let databaseURL = destination.appendingPathComponent("openclaw.sqlite", isDirectory: false)

        #expect(throws: NSError.self) {
            try DeviceIdentitySQLiteStore.loadOrCreate(
                databaseURL: databaseURL,
                destinationStateDirURL: destination,
                profile: .primary,
                legacySources: [source],
                afterLegacyCommit: {
                    try Self.execute(
                        databaseURL,
                        "UPDATE device_identities SET device_id = 'tampered' WHERE identity_key = 'primary'")
                })
        }

        #expect(FileManager.default.fileExists(atPath: source.identityURL.path))
        #expect(!FileManager.default.fileExists(atPath: claimURL.path))
        #expect(try Self.scalarText(
            databaseURL,
            "SELECT device_id FROM device_identities WHERE identity_key = 'primary'") == "tampered")
    }

    @Test
    func `legacy claim rejects symbolic traversal and hard linked sources`() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let realRoot = root.appendingPathComponent("real", isDirectory: true)
        let real = try Self.writeLegacyIdentity(
            stateDirURL: realRoot,
            profile: .primary,
            contents: Self.nodePEMIdentityJSON())
        let symbolicRoot = root.appendingPathComponent("symbolic", isDirectory: true)
        let symbolic = Self.legacyIdentitySource(stateDirURL: symbolicRoot, profile: .primary)
        try FileManager.default.createDirectory(
            at: symbolic.identityURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: symbolic.identityURL, withDestinationURL: real.identityURL)
        #expect(throws: NSError.self) {
            try DeviceIdentitySQLiteStore.loadOrCreate(
                databaseURL: root.appendingPathComponent("symbolic.sqlite"),
                destinationStateDirURL: root,
                profile: .primary,
                legacySources: [symbolic])
        }

        let traversingRoot = root.appendingPathComponent("traversing", isDirectory: true)
        let traversing = Self.legacyIdentitySource(stateDirURL: traversingRoot, profile: .primary)
        try FileManager.default.createDirectory(at: traversingRoot, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(
            at: traversing.identityURL.deletingLastPathComponent(),
            withDestinationURL: real.identityURL.deletingLastPathComponent())
        #expect(throws: NSError.self) {
            try DeviceIdentitySQLiteStore.loadOrCreate(
                databaseURL: root.appendingPathComponent("traversing.sqlite"),
                destinationStateDirURL: root,
                profile: .primary,
                legacySources: [traversing])
        }

        let hardRoot = root.appendingPathComponent("hard", isDirectory: true)
        let hard = Self.legacyIdentitySource(stateDirURL: hardRoot, profile: .primary)
        try FileManager.default.createDirectory(
            at: hard.identityURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try FileManager.default.linkItem(at: real.identityURL, to: hard.identityURL)
        #expect(throws: NSError.self) {
            try DeviceIdentitySQLiteStore.loadOrCreate(
                databaseURL: root.appendingPathComponent("hard.sqlite"),
                destinationStateDirURL: root,
                profile: .primary,
                legacySources: [hard])
        }
        #expect(FileManager.default.fileExists(atPath: real.identityURL.path))
        #expect(FileManager.default.fileExists(atPath: hard.identityURL.path))
    }

    @Test
    func `conflicting SQLite identity preserves the legacy source`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let destination = tempDir.appendingPathComponent("destination", isDirectory: true)
        let databaseURL = destination.appendingPathComponent("openclaw.sqlite")
        let existing = try DeviceIdentitySQLiteStore.loadOrCreate(
            databaseURL: databaseURL,
            destinationStateDirURL: destination,
            profile: .primary)
        let source = try Self.writeLegacyIdentity(
            stateDirURL: tempDir.appendingPathComponent("shared", isDirectory: true),
            profile: .primary,
            contents: Self.nodePEMIdentityJSON())

        #expect(throws: NSError.self) {
            try DeviceIdentitySQLiteStore.loadOrCreate(
                databaseURL: databaseURL,
                destinationStateDirURL: destination,
                profile: .primary,
                legacySources: [source])
        }
        #expect(FileManager.default.fileExists(atPath: source.identityURL.path))
        #expect(try DeviceIdentitySQLiteStore.loadOrCreate(
            databaseURL: databaseURL,
            destinationStateDirURL: destination,
            profile: .primary).deviceId == existing.deviceId)
    }

    @Test
    func `migration copies auth without clobbering or removing its source`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let sourceRoot = tempDir.appendingPathComponent("shared", isDirectory: true)
        let source = try Self.writeLegacyIdentity(
            stateDirURL: sourceRoot,
            profile: .primary,
            contents: Self.nodePEMIdentityJSON())
        let auth = "{\"version\":1,\"deviceId\":\"\(Self.fixtureDeviceID)\",\"tokens\":{}}"
        try auth.write(to: source.authURL, atomically: true, encoding: .utf8)
        let destination = tempDir.appendingPathComponent("legacy", isDirectory: true)
        let destinationAuthURL = destination.appendingPathComponent("identity/device-auth.json")

        _ = try DeviceIdentitySQLiteStore.loadOrCreate(
            databaseURL: destination.appendingPathComponent("openclaw.sqlite"),
            destinationStateDirURL: destination,
            profile: .primary,
            legacySources: [source])

        #expect(!FileManager.default.fileExists(atPath: source.identityURL.path))
        #expect(try String(contentsOf: source.authURL, encoding: .utf8) == auth)
        #expect(try String(contentsOf: destinationAuthURL, encoding: .utf8) == auth)
    }

    @Test
    func `migration rejects destination auth owned by another device`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let sourceRoot = tempDir.appendingPathComponent("shared", isDirectory: true)
        let source = try Self.writeLegacyIdentity(
            stateDirURL: sourceRoot,
            profile: .primary,
            contents: Self.nodePEMIdentityJSON())
        let sourceAuth = "{\"version\":1,\"deviceId\":\"\(Self.fixtureDeviceID)\",\"tokens\":{}}"
        try sourceAuth.write(to: source.authURL, atomically: true, encoding: .utf8)
        let destination = tempDir.appendingPathComponent("legacy", isDirectory: true)
        let destinationAuthURL = destination.appendingPathComponent("identity/device-auth.json")
        try FileManager.default.createDirectory(
            at: destinationAuthURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        let destinationAuth = #"{"version":1,"deviceId":"another-device","tokens":{}}"#
        try destinationAuth.write(to: destinationAuthURL, atomically: true, encoding: .utf8)

        #expect(throws: NSError.self) {
            try DeviceIdentitySQLiteStore.loadOrCreate(
                databaseURL: destination.appendingPathComponent("openclaw.sqlite"),
                destinationStateDirURL: destination,
                profile: .primary,
                legacySources: [source])
        }

        #expect(FileManager.default.fileExists(atPath: source.identityURL.path))
        #expect(try String(contentsOf: source.authURL, encoding: .utf8) == sourceAuth)
        #expect(try String(contentsOf: destinationAuthURL, encoding: .utf8) == destinationAuth)
    }

    // swiftlint:disable line_length
    @Test
    func `migration rejects stale destination auth for the same device`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let sourceRoot = tempDir.appendingPathComponent("shared", isDirectory: true)
        let source = try Self.writeLegacyIdentity(
            stateDirURL: sourceRoot,
            profile: .primary,
            contents: Self.nodePEMIdentityJSON())
        let sourceAuth = """
        {"version":1,"deviceId":"\(Self
            .fixtureDeviceID)","tokens":{"node":{"token":"source-token","role":"node","scopes":[],"updatedAtMs":100}}}
        """
        try sourceAuth.write(to: source.authURL, atomically: true, encoding: .utf8)
        let destination = tempDir.appendingPathComponent("legacy", isDirectory: true)
        let destinationAuthURL = destination.appendingPathComponent("identity/device-auth.json")
        try FileManager.default.createDirectory(
            at: destinationAuthURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        let destinationAuth = "{\"version\":1,\"deviceId\":\"\(Self.fixtureDeviceID)\",\"tokens\":{}}"
        try destinationAuth.write(to: destinationAuthURL, atomically: true, encoding: .utf8)

        #expect(throws: NSError.self) {
            try DeviceIdentitySQLiteStore.loadOrCreate(
                databaseURL: destination.appendingPathComponent("openclaw.sqlite"),
                destinationStateDirURL: destination,
                profile: .primary,
                legacySources: [source])
        }

        #expect(FileManager.default.fileExists(atPath: source.identityURL.path))
        #expect(try String(contentsOf: source.authURL, encoding: .utf8) == sourceAuth)
        #expect(try String(contentsOf: destinationAuthURL, encoding: .utf8) == destinationAuth)
    }

    @Test
    func `migration accepts equivalent auth with reordered scopes`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let sourceRoot = tempDir.appendingPathComponent("shared", isDirectory: true)
        let source = try Self.writeLegacyIdentity(
            stateDirURL: sourceRoot,
            profile: .primary,
            contents: Self.nodePEMIdentityJSON())
        let sourceAuth = """
        {"version":1,"deviceId":"\(Self
            .fixtureDeviceID)","tokens":{"legacy":{"token":"source-token","role":"node","scopes":["write","read"],"updatedAtMs":100}}}
        """
        try sourceAuth.write(to: source.authURL, atomically: true, encoding: .utf8)
        let destination = tempDir.appendingPathComponent("legacy", isDirectory: true)
        let destinationAuthURL = destination.appendingPathComponent("identity/device-auth.json")
        try FileManager.default.createDirectory(
            at: destinationAuthURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        let destinationAuth = """
        {"version":1,"deviceId":"\(Self
            .fixtureDeviceID)","tokens":{"node":{"token":"source-token","role":"node","scopes":["read","write"],"updatedAtMs":100}}}
        """
        try destinationAuth.write(to: destinationAuthURL, atomically: true, encoding: .utf8)

        _ = try DeviceIdentitySQLiteStore.loadOrCreate(
            databaseURL: destination.appendingPathComponent("openclaw.sqlite"),
            destinationStateDirURL: destination,
            profile: .primary,
            legacySources: [source])

        #expect(!FileManager.default.fileExists(atPath: source.identityURL.path))
        #expect(try String(contentsOf: destinationAuthURL, encoding: .utf8) == destinationAuth)
    }

    // swiftlint:enable line_length

    @Test
    func `preserves WAL journal mode`() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tempDir) }
        let databaseURL = tempDir.appendingPathComponent("openclaw.sqlite")
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        try Self.seedCanonicalSchema(databaseURL)
        #expect(try Self.scalarText(databaseURL, "PRAGMA journal_mode = WAL")?.lowercased() == "wal")

        _ = try DeviceIdentitySQLiteStore.loadOrCreate(
            databaseURL: databaseURL,
            destinationStateDirURL: tempDir,
            profile: .primary)

        #expect(try Self.scalarText(databaseURL, "PRAGMA journal_mode")?.lowercased() == "wal")
    }

    @Test
    func `fails closed for nonempty missing wrong and newer schemas`() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

        let missing = root.appendingPathComponent("missing.sqlite")
        try Self.execute(missing, "CREATE TABLE unrelated (id INTEGER PRIMARY KEY) STRICT")
        #expect(throws: NSError.self) {
            try DeviceIdentitySQLiteStore.loadOrCreate(
                databaseURL: missing,
                destinationStateDirURL: root,
                profile: .primary)
        }

        let wrong = root.appendingPathComponent("wrong.sqlite")
        try Self.execute(wrong, """
        CREATE TABLE device_identities (
          identity_key TEXT NOT NULL PRIMARY KEY,
          device_id TEXT NOT NULL
        ) STRICT;
        CREATE INDEX idx_device_identities_device ON device_identities(device_id);
        """)
        #expect(throws: NSError.self) {
            try DeviceIdentitySQLiteStore.loadOrCreate(
                databaseURL: wrong,
                destinationStateDirURL: root,
                profile: .primary)
        }

        let newer = root.appendingPathComponent("newer.sqlite")
        try Self.execute(newer, "PRAGMA user_version = 4")
        #expect(throws: NSError.self) {
            try DeviceIdentitySQLiteStore.loadOrCreate(
                databaseURL: newer,
                destinationStateDirURL: root,
                profile: .primary)
        }
    }
}

extension DeviceIdentityStoreTests {
    fileprivate static func base64UrlDecode(_ value: String) -> Data? {
        let normalized = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padded = normalized + String(repeating: "=", count: (4 - normalized.count % 4) % 4)
        return Data(base64Encoded: padded)
    }

    fileprivate static let fixtureDeviceID = "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c"
    fileprivate static let fixturePublicKeyRaw = "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg="
    fileprivate static let fixturePublicKeyData = Data(base64Encoded: Self.fixturePublicKeyRaw)!
    fileprivate static let fixturePrivateKeyData = Data((0..<32).map { UInt8($0) })
    fileprivate static let fixturePrivateKeyRaw = Self.fixturePrivateKeyData.base64EncodedString()
    fileprivate static let fixturePublicKeyPEM = Self.fixturePEM(
        label: "PUBLIC KEY",
        der: Data([
            0x30, 0x2A, 0x30, 0x05, 0x06, 0x03, 0x2B, 0x65,
            0x70, 0x03, 0x21, 0x00,
        ]) + Self.fixturePublicKeyData)
    fileprivate static let fixturePrivateKeyPEM = Self.fixturePEM(
        label: "PRIVATE KEY",
        der: Data([
            0x30, 0x2E, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
            0x03, 0x2B, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
        ]) + Self.fixturePrivateKeyData)

    fileprivate static func fixturePEM(label: String, der: Data) -> String {
        let fence = String(repeating: "-", count: 5)
        return "\(fence)BEGIN \(label)\(fence)\n\(der.base64EncodedString())\n\(fence)END \(label)\(fence)\n"
    }

    fileprivate static func nodePEMIdentityJSON(
        deviceId: String = Self.fixtureDeviceID,
        privateKeyPem: String = Self.fixturePrivateKeyPEM) throws -> String
    {
        let object: [String: Any] = [
            "version": 1,
            "deviceId": deviceId,
            "publicKeyPem": self.fixturePublicKeyPEM,
            "privateKeyPem": privateKeyPem,
            "createdAtMs": Int64(1_800_000_000_000),
        ]
        let data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        guard let json = String(bytes: data, encoding: .utf8) else {
            throw DeviceIdentityStore.storageError("Could not encode fixture identity JSON")
        }
        return json + "\n"
    }

    fileprivate static func writeLegacyIdentity(
        stateDirURL: URL,
        profile: GatewayDeviceIdentityProfile,
        contents: String) throws -> DeviceIdentityPaths.LegacyIdentitySource
    {
        let source = self.legacyIdentitySource(stateDirURL: stateDirURL, profile: profile)
        try FileManager.default.createDirectory(
            at: source.identityURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try contents.write(to: source.identityURL, atomically: true, encoding: .utf8)
        return source
    }

    fileprivate static func legacyIdentitySource(
        stateDirURL: URL,
        profile: GatewayDeviceIdentityProfile) -> DeviceIdentityPaths.LegacyIdentitySource
    {
        let stateDirURL = stateDirURL.standardizedFileURL
        let identityDirURL = stateDirURL.appendingPathComponent("identity", isDirectory: true)
        return DeviceIdentityPaths.LegacyIdentitySource(
            stateDirURL: stateDirURL,
            identityURL: identityDirURL.appendingPathComponent(profile.identityFileName, isDirectory: false),
            authURL: identityDirURL.appendingPathComponent(profile.authFileName, isDirectory: false))
    }

    fileprivate static func seedCanonicalSchema(_ databaseURL: URL, nodeOwned: Bool = false) throws {
        try FileManager.default.createDirectory(
            at: databaseURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        let metadataSQL = nodeOwned
            ? """
            CREATE TABLE schema_meta (
              meta_key TEXT NOT NULL PRIMARY KEY,
              role TEXT NOT NULL,
              schema_version INTEGER NOT NULL,
              agent_id TEXT,
              app_version TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            ) STRICT;
            INSERT INTO schema_meta (
              meta_key, role, schema_version, agent_id, app_version, created_at, updated_at
            ) VALUES ('primary', 'global', 4, NULL, NULL, 1800000000000, 1800000000000);
            PRAGMA user_version = 4;
            """
            : ""
        try self.execute(databaseURL, """
        CREATE TABLE device_identities (
          identity_key TEXT NOT NULL PRIMARY KEY,
          device_id TEXT NOT NULL,
          public_key_pem TEXT NOT NULL,
          private_key_pem TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX idx_device_identities_device
          ON device_identities(device_id, updated_at_ms DESC);
        \(metadataSQL)
        """)
    }

    fileprivate static func execute(_ databaseURL: URL, _ sql: String) throws {
        var database: OpaquePointer?
        guard sqlite3_open(databaseURL.path, &database) == SQLITE_OK, let database else {
            throw DeviceIdentityStore.storageError("Could not open test database")
        }
        defer { sqlite3_close(database) }
        guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else {
            throw DeviceIdentityStore.storageError(String(cString: sqlite3_errmsg(database)))
        }
    }

    fileprivate static func scalarInt(_ databaseURL: URL, _ sql: String) throws -> Int64 {
        try self.scalar(databaseURL, sql) { sqlite3_column_int64($0, 0) }
    }

    fileprivate static func scalarText(_ databaseURL: URL, _ sql: String) throws -> String? {
        try self.scalar(databaseURL, sql) { statement in
            sqlite3_column_text(statement, 0).map { String(cString: $0) }
        }
    }

    fileprivate static func scalar<T>(
        _ databaseURL: URL,
        _ sql: String,
        transform: (OpaquePointer) -> T) throws -> T
    {
        var database: OpaquePointer?
        guard sqlite3_open(databaseURL.path, &database) == SQLITE_OK, let database else {
            throw DeviceIdentityStore.storageError("Could not open test database")
        }
        defer { sqlite3_close(database) }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw DeviceIdentityStore.storageError(String(cString: sqlite3_errmsg(database)))
        }
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW else {
            throw DeviceIdentityStore.storageError(String(cString: sqlite3_errmsg(database)))
        }
        return transform(statement)
    }

    fileprivate static func sql(_ value: String) -> String {
        value.replacingOccurrences(of: "'", with: "''")
    }
}
