import CryptoKit
import Darwin
import Foundation
import SQLite3
import Testing
@testable import OpenClawKit

private final class DeviceIdentityMigrationFixture {
    let root: URL
    let destination: URL
    let databaseURL: URL

    init(destinationName: String = "destination", databasePath: String = "openclaw.sqlite") {
        self.root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        self.destination = self.root.appendingPathComponent(destinationName, isDirectory: true)
        self.databaseURL = self.destination.appendingPathComponent(databasePath, isDirectory: false)
    }

    deinit {
        try? FileManager.default.removeItem(at: self.root)
    }

    func url(_ path: String, isDirectory: Bool = true) -> URL {
        self.root.appendingPathComponent(path, isDirectory: isDirectory)
    }

    func source(
        _ name: String = "legacy",
        profile: GatewayDeviceIdentityProfile = .primary,
        contents: String? = nil) throws -> DeviceIdentityPaths.LegacyIdentitySource
    {
        try DeviceIdentityStoreTests.writeLegacyIdentity(
            stateDirURL: self.url(name),
            profile: profile,
            contents: contents ?? DeviceIdentityStoreTests.nodePEMIdentityJSON())
    }

    func claimURL(
        for source: DeviceIdentityPaths.LegacyIdentitySource,
        suffix: String = ".native-importing") -> URL
    {
        URL(fileURLWithPath: source.identityURL.path + suffix, isDirectory: false)
    }

    func load(
        profile: GatewayDeviceIdentityProfile = .primary,
        sources: [DeviceIdentityPaths.LegacyIdentitySource] = [],
        beforeLegacyClaim: ((DeviceIdentityPaths.LegacyIdentitySource) throws -> Void)? = nil,
        afterLegacyCommit: (() throws -> Void)? = nil) throws -> DeviceIdentity
    {
        try DeviceIdentitySQLiteStore.loadOrCreate(
            databaseURL: self.databaseURL,
            destinationStateDirURL: self.destination,
            profile: profile,
            legacySources: sources,
            beforeLegacyClaim: beforeLegacyClaim,
            afterLegacyCommit: afterLegacyCommit)
    }
}

private func deviceAuthEntry(
    _ deviceID: String,
    role: String = "node",
    owner: String? = nil,
    profile: GatewayDeviceIdentityProfile = .primary) -> DeviceAuthEntry?
{
    DeviceAuthStore.loadToken(
        deviceId: deviceID,
        role: role,
        gatewayID: owner,
        profile: profile)
}

@Suite(.serialized)
struct DeviceIdentityStoreTests {
    @Test
    func `task scoped state directories isolate concurrent identity stores`() async throws {
        let fixture = DeviceIdentityMigrationFixture()
        let root = fixture.root
        let stateDirectories = [
            root.appendingPathComponent("a", isDirectory: true),
            root.appendingPathComponent("b", isDirectory: true),
        ]
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

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
        let fixture = DeviceIdentityMigrationFixture()
        let tempDir = fixture.root
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let blocker = tempDir.appendingPathComponent("not-a-directory", isDirectory: false)
        try Data().write(to: blocker)
        // Repoint the pinned state dir at a plain file to force write failures;
        // the isolation trait restores the env var after the test.
        setenv("OPENCLAW_STATE_DIR", blocker.path, 1)

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
        #expect(deviceAuthEntry("unwritable-device") == nil)
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
        let fixture = DeviceIdentityMigrationFixture()
        let identity = try fixture.load()
        let reloaded = try fixture.load()

        #expect(reloaded.deviceId == identity.deviceId)
        #expect(reloaded.publicKey == identity.publicKey)
        #expect(reloaded.privateKey == identity.privateKey)
    }

    @Test(.stateDirectoryIsolated)
    func `device auth tokens are isolated by gateway owner`() {
        let deviceID = "test-device"
        _ = DeviceAuthStore.storeToken(deviceId: deviceID, role: "node", token: "legacy-token")
        #expect(deviceAuthEntry(deviceID, owner: "gateway-a") == nil)

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

        #expect(deviceAuthEntry(deviceID)?.token == "legacy-token")
        #expect(deviceAuthEntry(deviceID, owner: "gateway-a")?.token == "gateway-a-token")
        #expect(deviceAuthEntry(deviceID, owner: "gateway-b")?.token == "gateway-b-token")

        DeviceAuthStore.clearToken(deviceId: deviceID, role: "node", gatewayID: "gateway-b")
        #expect(deviceAuthEntry(deviceID, owner: "gateway-a")?.token == "gateway-a-token")
        #expect(deviceAuthEntry(deviceID, owner: "gateway-b") == nil)

        DeviceAuthStore.clearToken(deviceId: deviceID, role: "node")
        #expect(deviceAuthEntry(deviceID) == nil)
        #expect(deviceAuthEntry(deviceID, owner: "gateway-a") == nil)
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
        #expect(deviceAuthEntry(deviceID) == nil)

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

        #expect(deviceAuthEntry(deviceID, owner: composedOwner)?.token == "composed-token")
        #expect(deviceAuthEntry(deviceID, owner: decomposedOwner)?.token == "decomposed-token")
        #expect(deviceAuthEntry(deviceID, owner: nextLineOwner)?.token == "next-line-token")

        let stateDirPath = try #require(getenv("OPENCLAW_STATE_DIR").map { String(cString: $0) })
        let stateDirURL = URL(fileURLWithPath: stateDirPath, isDirectory: true)
        #expect(try Self.scalarInt(
            stateDirURL.appendingPathComponent("state/openclaw.sqlite"),
            "SELECT COUNT(*) FROM device_auth_tokens WHERE device_id = '\(deviceID)'") == 3)
        #expect(!FileManager.default.fileExists(
            atPath: stateDirURL.appendingPathComponent("identity/device-auth.json").path))

        DeviceAuthStore.clearToken(deviceId: deviceID, role: "node", gatewayID: decomposedOwner)
        #expect(deviceAuthEntry(deviceID, owner: composedOwner)?.token == "composed-token")
        #expect(deviceAuthEntry(deviceID, owner: decomposedOwner) == nil)
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

        #expect(deviceAuthEntry(deviceID, owner: composedOwner)?.token == "legacy-composed-token")
        #expect(DeviceAuthStore.storeTokenPersisted(
            deviceId: deviceID,
            role: "node",
            token: "new-decomposed-token",
            gatewayID: decomposedOwner))
        #expect(deviceAuthEntry(deviceID, owner: composedOwner)?.token == "legacy-composed-token")
        #expect(deviceAuthEntry(deviceID, owner: decomposedOwner)?.token == "new-decomposed-token")
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
        #expect(deviceAuthEntry(deviceID) == nil)
        #expect(deviceAuthEntry(deviceID, owner: "trusted-gateway")?.token == "legacy-node-token")
        #expect(deviceAuthEntry(deviceID, role: "operator", owner: "trusted-gateway") == nil)
        #expect(deviceAuthEntry(deviceID, role: "operator")?.token == "legacy-operator-token")
        #expect(deviceAuthEntry(deviceID, owner: "other-gateway") == nil)
        #expect(!DeviceAuthStore.migrateUnscopedToken(
            deviceId: deviceID,
            role: "node",
            toGatewayID: "other-gateway"))

        _ = DeviceAuthStore.storeToken(
            deviceId: deviceID,
            role: "node",
            token: "ambiguous-legacy-token")
        #expect(DeviceAuthStore.discardUnscopedTokens(deviceId: deviceID) == 2)
        #expect(deviceAuthEntry(deviceID) == nil)
        #expect(deviceAuthEntry(deviceID, owner: "trusted-gateway")?.token == "legacy-node-token")
    }

    @Test
    func `state directory override wins over shared app group storage`() {
        let fixture = DeviceIdentityMigrationFixture()
        let overrideURL = fixture.url("override")
        let legacyURL = fixture.url("legacy")
        let sharedURL = fixture.url("shared")

        let selected = DeviceIdentityPaths.stateDirURL(
            overrideURL: overrideURL,
            legacyStateDirURL: legacyURL,
            appGroupStateDirURL: sharedURL,
            temporaryDirectory: fixture.root)

        #expect(selected == overrideURL)
        #expect(!FileManager.default.fileExists(atPath: sharedURL.path))
    }

    @Test
    func `shared app group storage wins over legacy app support storage`() throws {
        let fixture = DeviceIdentityMigrationFixture()
        let legacyURL = fixture.url("legacy")
        let sharedURL = fixture.url("shared")
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
            temporaryDirectory: fixture.root)

        #expect(selected == sharedURL)
        #expect(!FileManager.default.fileExists(atPath: sharedDeviceURL.path))
    }

    @Test
    func `legacy app support storage wins when app group storage is not available`() {
        let fixture = DeviceIdentityMigrationFixture()
        let legacyURL = fixture.url("legacy")
        let sharedURL = fixture.url("shared")

        let selected = DeviceIdentityPaths.stateDirURL(
            overrideURL: nil,
            legacyStateDirURL: legacyURL,
            appGroupStateDirURL: sharedURL,
            appGroupStateDirAvailable: false,
            temporaryDirectory: fixture.root)

        #expect(selected == legacyURL)
    }

    @Test
    func `task scoped state directory never probes machine legacy roots`() async {
        let fixture = DeviceIdentityMigrationFixture()
        let scopedURL = fixture.url("scoped")

        await DeviceIdentityStore.withStateDirectory(scopedURL) {
            let sources = DeviceIdentityPaths.legacyIdentitySources(profile: .primary)
            #expect(sources.map(\.stateDirURL) == [scopedURL.standardizedFileURL])
        }
    }

    @Test(.stateDirectoryIsolated)
    func `secondary profiles use separate identity and auth rows`() throws {
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
        #expect(try Self.scalarInt(
            stateDir.appendingPathComponent("state/openclaw.sqlite"),
            "SELECT COUNT(*) FROM device_auth_tokens") == 3)
        #expect(!FileManager.default.fileExists(atPath: identityDir.appendingPathComponent("device-auth.json").path))
        #expect(!FileManager.default
            .fileExists(atPath: identityDir.appendingPathComponent("node-device-auth.json").path))
        #expect(!FileManager.default
            .fileExists(atPath: identityDir.appendingPathComponent("share-device-auth.json").path))
        #expect(deviceAuthEntry(primaryIdentity.deviceId)?.token == "primary-token")
        #expect(deviceAuthEntry(nodeIdentity.deviceId, profile: .node)?.token == "node-token")
        #expect(
            deviceAuthEntry(shareIdentity.deviceId, profile: .shareExtension)?.token ==
                "share-token")

        DeviceAuthStore.clearAll(profile: .shareExtension)

        #expect(deviceAuthEntry(primaryIdentity.deviceId)?.token == "primary-token")
        #expect(deviceAuthEntry(nodeIdentity.deviceId, profile: .node)?.token == "node-token")
        #expect(deviceAuthEntry(shareIdentity.deviceId, profile: .shareExtension) == nil)
    }

    @Test
    func `fresh database creates only canonical identity schema and leaves user version zero`() throws {
        let fixture = DeviceIdentityMigrationFixture()
        _ = try fixture.load()

        #expect(try Self.scalarInt(fixture.databaseURL, "PRAGMA user_version") == 0)
        #expect(try Self.scalarText(
            fixture.databaseURL,
            """
            SELECT group_concat(type || ':' || name, ',')
            FROM (SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name)
            """) == "index:idx_device_identities_device,table:device_identities")
        let directoryMode = try #require(
            FileManager.default.attributesOfItem(atPath: fixture.destination.path)[.posixPermissions] as? NSNumber)
        let databaseMode = try #require(
            FileManager.default.attributesOfItem(atPath: fixture.databaseURL.path)[.posixPermissions] as? NSNumber)
        #expect(directoryMode.intValue & 0o777 == 0o700)
        #expect(databaseMode.intValue & 0o777 == 0o600)

        let coordinatorURLs = DeviceIdentitySQLiteStore.resolveDeviceIdentityCoordinatorURLs(
            databaseURL: fixture.databaseURL,
            destinationStateDirURL: fixture.destination,
            temporaryDirectory: FileManager.default.temporaryDirectory,
            uid: getuid())
        #expect(coordinatorURLs.count == 2)
        for coordinatorURL in coordinatorURLs {
            let coordinatorDirectoryMode = try #require(
                FileManager.default.attributesOfItem(
                    atPath: coordinatorURL.deletingLastPathComponent().path)[.posixPermissions] as? NSNumber)
            let coordinatorFileMode = try #require(
                FileManager.default.attributesOfItem(atPath: coordinatorURL.path)[.posixPermissions] as? NSNumber)
            #expect(coordinatorDirectoryMode.intValue & 0o777 == 0o700)
            #expect(coordinatorFileMode.intValue & 0o777 == 0o600)
        }
    }

    @Test
    func `Node PEM fixture repairs a stale device id and remains signing compatible`() throws {
        let fixture = DeviceIdentityMigrationFixture()
        let source = try fixture.source(
            "Application Support/OpenClaw",
            contents: Self.nodePEMIdentityJSON(deviceId: "stale-device-id"))
        let identity = try fixture.load(sources: [source])

        #expect(identity.deviceId == Self.fixtureDeviceID)
        #expect(identity.publicKey == Self.fixturePublicKeyRaw)
        #expect(identity.privateKey == Self.fixturePrivateKeyRaw)
        #expect(identity.createdAtMs == 1_800_000_000_000)
        #expect(!FileManager.default.fileExists(atPath: source.identityURL.path))
        #expect(try Self.scalarText(
            fixture.databaseURL,
            "SELECT public_key_pem FROM device_identities WHERE identity_key = 'primary'") == Self.fixturePublicKeyPEM)
        #expect(try Self.scalarText(
            fixture.databaseURL,
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
        let fixture = DeviceIdentityMigrationFixture()
        try Self.seedCanonicalSchema(fixture.databaseURL, nodeOwned: true)
        try Self.execute(fixture.databaseURL, """
        INSERT INTO device_identities (
          identity_key, device_id, public_key_pem, private_key_pem, created_at_ms, updated_at_ms
        ) VALUES (
          'node', '\(Self.fixtureDeviceID)', '\(Self.sql(Self.fixturePublicKeyPEM))',
          '\(Self.sql(Self.fixturePrivateKeyPEM))', 1800000000000, 1800000000123
        )
        """)

        let identity = try fixture.load(profile: .node)

        #expect(identity.deviceId == Self.fixtureDeviceID)
        #expect(identity.createdAtMs == 1_800_000_000_000)
        #expect(try Self.scalarInt(
            fixture.databaseURL,
            "SELECT updated_at_ms FROM device_identities WHERE identity_key = 'node'") == 1_800_000_000_123)
    }

    @Test
    func `same key migration preserves the authoritative SQLite timestamp`() throws {
        let fixture = DeviceIdentityMigrationFixture()
        let source = try fixture.source()
        let identity = try fixture.load(
            sources: [source],
            beforeLegacyClaim: { _ in
                try Self.seedCanonicalSchema(fixture.databaseURL, nodeOwned: true)
                try Self.execute(fixture.databaseURL, """
                INSERT INTO device_identities (
                  identity_key, device_id, public_key_pem, private_key_pem, created_at_ms, updated_at_ms
                ) VALUES (
                  'primary', '\(Self.fixtureDeviceID)', '\(Self.sql(Self.fixturePublicKeyPEM))',
                  '\(Self.sql(Self.fixturePrivateKeyPEM))', 1700000000000, 1700000000123
                )
                """)
            })

        #expect(identity.deviceId == Self.fixtureDeviceID)
        #expect(identity.createdAtMs == 1_700_000_000_000)
        #expect(try Self.scalarInt(
            fixture.databaseURL,
            "SELECT updated_at_ms FROM device_identities WHERE identity_key = 'primary'") == 1_700_000_000_123)
        #expect(!FileManager.default.fileExists(atPath: source.identityURL.path))
    }

    @Test(arguments: [GatewayDeviceIdentityProfile.primary, .node])
    func `canonical SQLite identity ignores a recreated retired file`(
        profile: GatewayDeviceIdentityProfile) throws
    {
        let fixture = DeviceIdentityMigrationFixture()
        let canonical = try fixture.load(profile: profile)
        let createdAt = try Self.scalarInt(
            fixture.databaseURL,
            "SELECT created_at_ms FROM device_identities WHERE identity_key = '\(profile.rawValue)'")
        let updatedAt = try Self.scalarInt(
            fixture.databaseURL,
            "SELECT updated_at_ms FROM device_identities WHERE identity_key = '\(profile.rawValue)'")
        let source = try fixture.source(profile: profile)
        let legacyBytes = try Data(contentsOf: source.identityURL)

        let loaded = try fixture.load(
            profile: profile,
            sources: [source],
            beforeLegacyClaim: { _ in Issue.record("canonical identity inspected a retired source") })

        #expect(loaded == canonical)
        #expect(canonical.deviceId != Self.fixtureDeviceID)
        #expect(try Self.scalarInt(
            fixture.databaseURL,
            "SELECT created_at_ms FROM device_identities WHERE identity_key = '\(profile.rawValue)'") == createdAt)
        #expect(try Self.scalarInt(
            fixture.databaseURL,
            "SELECT updated_at_ms FROM device_identities WHERE identity_key = '\(profile.rawValue)'") == updatedAt)
        #expect(try Data(contentsOf: source.identityURL) == legacyBytes)
        #expect(!FileManager.default.fileExists(atPath: fixture.claimURL(for: source).path))
    }

    @Test
    func `strict legacy validation preserves invalid source and creates no row`() throws {
        let fixture = DeviceIdentityMigrationFixture()
        let invalidJSON = try Self.nodePEMIdentityJSON(privateKeyPem: "not-a-private-key")
        let source = try fixture.source("shared", contents: invalidJSON)

        #expect(throws: NSError.self) {
            try fixture.load(sources: [source])
        }
        #expect(FileManager.default.fileExists(atPath: source.identityURL.path))
        #expect(!FileManager.default.fileExists(atPath: fixture.databaseURL.path))
    }

    @Test
    func `pending Doctor claim blocks identity generation`() throws {
        let fixture = DeviceIdentityMigrationFixture()
        let source = try fixture.source()
        let claimURL = fixture.claimURL(for: source, suffix: ".doctor-importing")
        try FileManager.default.moveItem(at: source.identityURL, to: claimURL)

        #expect(throws: NSError.self) {
            try fixture.load(sources: [source])
        }

        #expect(FileManager.default.fileExists(atPath: claimURL.path))
        #expect(!FileManager.default.fileExists(atPath: fixture.databaseURL.path))
    }

    @Test
    func `Doctor rename winning native claim race blocks identity generation`() throws {
        let fixture = DeviceIdentityMigrationFixture()
        let source = try fixture.source()
        let claimURL = fixture.claimURL(for: source, suffix: ".doctor-importing")

        #expect(throws: NSError.self) {
            try fixture.load(
                sources: [source],
                beforeLegacyClaim: { _ in
                    try FileManager.default.moveItem(at: source.identityURL, to: claimURL)
                })
        }

        #expect(FileManager.default.fileExists(atPath: claimURL.path))
        #expect(!FileManager.default.fileExists(atPath: fixture.databaseURL.path))
    }

    @Test
    func `interrupted native claim resumes without rotating identity`() throws {
        let fixture = DeviceIdentityMigrationFixture()
        let source = try fixture.source()
        let claimURL = fixture.claimURL(for: source)
        try FileManager.default.moveItem(at: source.identityURL, to: claimURL)
        let identity = try fixture.load(sources: [source])

        #expect(identity.deviceId == Self.fixtureDeviceID)
        #expect(!FileManager.default.fileExists(atPath: source.identityURL.path))
        #expect(!FileManager.default.fileExists(atPath: claimURL.path))
    }

    @Test
    func `matching recreated source parks stale native claim`() throws {
        let fixture = DeviceIdentityMigrationFixture()
        let source = try fixture.source(
            contents: Self.nodePEMIdentityJSON(deviceId: "recreated-source"))
        let claimURL = fixture.claimURL(for: source)
        try Self.nodePEMIdentityJSON(deviceId: "interrupted-claim")
            .write(to: claimURL, atomically: true, encoding: .utf8)
        let identity = try fixture.load(sources: [source])

        #expect(identity.deviceId == Self.fixtureDeviceID)
        #expect(!FileManager.default.fileExists(atPath: source.identityURL.path))
        #expect(!FileManager.default.fileExists(atPath: claimURL.path))
        let parkedClaims = try FileManager.default.contentsOfDirectory(
            at: source.identityURL.deletingLastPathComponent(),
            includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasPrefix("device.json.native-importing.stale-") }
        #expect(parkedClaims.count == 1)
    }

    @Test
    func `conflicting recreated source preserves native claim`() throws {
        let fixture = DeviceIdentityMigrationFixture()
        let source = try fixture.source()
        let claimURL = fixture.claimURL(for: source)
        try JSONEncoder().encode(DeviceIdentityStore.generateMaterial().identity).write(to: claimURL)

        do {
            _ = try fixture.load(sources: [source])
            Issue.record("Expected conflicting source and claim to throw")
        } catch let error as NSError {
            #expect(error.localizedDescription ==
                "Legacy device identity source and interrupted native claim both exist")
        }

        #expect(FileManager.default.fileExists(atPath: source.identityURL.path))
        #expect(FileManager.default.fileExists(atPath: claimURL.path))
    }

    @Test
    func `unparseable native claim is preserved with recreated source`() throws {
        let fixture = DeviceIdentityMigrationFixture()
        let source = try fixture.source()
        let claimURL = fixture.claimURL(for: source)
        try Data("not-json".utf8).write(to: claimURL)

        do {
            _ = try fixture.load(sources: [source])
            Issue.record("Expected unparseable claim to throw")
        } catch let error as NSError {
            #expect(error.localizedDescription ==
                "Legacy device identity source and interrupted native claim both exist")
        }

        #expect(FileManager.default.fileExists(atPath: source.identityURL.path))
        #expect(FileManager.default.fileExists(atPath: claimURL.path))
    }

    @Test
    func `source reappearance preserves both native claim and recreated source`() throws {
        let fixture = DeviceIdentityMigrationFixture()
        let legacyData = try Self.nodePEMIdentityJSON()
        let source = try fixture.source(contents: legacyData)
        let claimURL = fixture.claimURL(for: source)

        #expect(throws: NSError.self) {
            try fixture.load(
                sources: [source],
                afterLegacyCommit: {
                    try legacyData.write(to: source.identityURL, atomically: true, encoding: .utf8)
                })
        }

        #expect(FileManager.default.fileExists(atPath: source.identityURL.path))
        #expect(FileManager.default.fileExists(atPath: claimURL.path))
        #expect(try Self.scalarText(
            fixture.databaseURL,
            "SELECT device_id FROM device_identities WHERE identity_key = 'primary'") == Self.fixtureDeviceID)
    }

    @Test
    func `multi source rollback restores every independent native claim`() throws {
        let fixture = DeviceIdentityMigrationFixture()
        let legacyData = try Self.nodePEMIdentityJSON()
        let first = try fixture.source("first", contents: legacyData)
        let second = try fixture.source("second", contents: legacyData)
        let firstClaimURL = fixture.claimURL(for: first)
        let secondClaimURL = fixture.claimURL(for: second)

        #expect(throws: NSError.self) {
            try fixture.load(
                sources: [first, second],
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
        let fixture = DeviceIdentityMigrationFixture()
        let source = try fixture.source()
        let claimURL = fixture.claimURL(for: source)

        #expect(throws: NSError.self) {
            try fixture.load(
                sources: [source],
                afterLegacyCommit: {
                    try Self.execute(
                        fixture.databaseURL,
                        "UPDATE device_identities SET device_id = 'tampered' WHERE identity_key = 'primary'")
                })
        }

        #expect(FileManager.default.fileExists(atPath: source.identityURL.path))
        #expect(!FileManager.default.fileExists(atPath: claimURL.path))
        #expect(try Self.scalarText(
            fixture.databaseURL,
            "SELECT device_id FROM device_identities WHERE identity_key = 'primary'") == "tampered")
    }

    @Test
    func `legacy claim rejects symbolic traversal and hard linked sources`() throws {
        let fixture = DeviceIdentityMigrationFixture()
        let root = fixture.root
        let realRoot = fixture.url("real")
        let real = try Self.writeLegacyIdentity(
            stateDirURL: realRoot,
            profile: .primary,
            contents: Self.nodePEMIdentityJSON())
        let symbolicRoot = fixture.url("symbolic")
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

        let traversingRoot = fixture.url("traversing")
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

        let hardRoot = fixture.url("hard")
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
    func `migration imports auth rows without removing its source`() throws {
        let fixture = DeviceIdentityMigrationFixture(
            destinationName: "legacy",
            databasePath: "state/openclaw.sqlite")
        let source = try fixture.source("shared")
        let auth = """
        {"version":1,"deviceId":"\(Self
            .fixtureDeviceID)","tokens":{"node":{"token":"source-token","role":"node","scopes":["write"],"updatedAtMs":100}}}
        """
        try auth.write(to: source.authURL, atomically: true, encoding: .utf8)
        let destinationAuthURL = fixture.destination.appendingPathComponent("identity/device-auth.json")

        _ = try fixture.load(sources: [source])

        #expect(!FileManager.default.fileExists(atPath: source.identityURL.path))
        #expect(try String(contentsOf: source.authURL, encoding: .utf8) == auth)
        #expect(!FileManager.default.fileExists(atPath: destinationAuthURL.path))
        #expect(try Self.scalarText(
            fixture.databaseURL,
            "SELECT token FROM device_auth_tokens WHERE device_id = '\(Self.fixtureDeviceID)' AND role = 'node'") ==
            "source-token")
    }

    @Test
    func `migration preserves canonical destination auth rows`() throws {
        let fixture = DeviceIdentityMigrationFixture(
            destinationName: "legacy",
            databasePath: "state/openclaw.sqlite")
        let source = try fixture.source("shared")
        let sourceAuth = """
        {"version":1,"deviceId":"\(Self
            .fixtureDeviceID)","tokens":{"node":{"token":"source-token","role":"node","scopes":[],"updatedAtMs":100}}}
        """
        try sourceAuth.write(to: source.authURL, atomically: true, encoding: .utf8)
        try FileManager.default.createDirectory(
            at: fixture.databaseURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        try Self.execute(fixture.databaseURL, """
        CREATE TABLE device_auth_tokens (
          device_id TEXT NOT NULL,
          role TEXT NOT NULL,
          token TEXT NOT NULL,
          scopes_json TEXT NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (device_id, role)
        ) STRICT;
        CREATE INDEX idx_device_auth_tokens_updated
          ON device_auth_tokens(updated_at_ms DESC, device_id, role);
        INSERT INTO device_auth_tokens (device_id, role, token, scopes_json, updated_at_ms)
        VALUES ('\(Self.fixtureDeviceID)', 'node', 'destination-token', '[]', 200);
        """)

        _ = try fixture.load(sources: [source])

        #expect(!FileManager.default.fileExists(atPath: source.identityURL.path))
        #expect(try String(contentsOf: source.authURL, encoding: .utf8) == sourceAuth)
        #expect(try Self.scalarText(
            fixture.databaseURL,
            "SELECT token FROM device_auth_tokens WHERE device_id = '\(Self.fixtureDeviceID)' AND role = 'node'") ==
            "destination-token")
    }

    @Test
    func `migration imports destination legacy auth before source auth`() throws {
        let fixture = DeviceIdentityMigrationFixture(databasePath: "state/openclaw.sqlite")
        let source = try fixture.source("source")
        let sourceAuth = """
        {"version":1,"deviceId":"\(Self
            .fixtureDeviceID)","tokens":{"node":{"token":"source-token","role":"node","scopes":[],"updatedAtMs":100}}}
        """
        try sourceAuth.write(to: source.authURL, atomically: true, encoding: .utf8)
        let destinationAuthURL = fixture.destination.appendingPathComponent("identity/device-auth.json")
        try FileManager.default.createDirectory(
            at: destinationAuthURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        let destinationAuth = sourceAuth.replacingOccurrences(of: "source-token", with: "destination-token")
        try destinationAuth.write(to: destinationAuthURL, atomically: true, encoding: .utf8)

        _ = try fixture.load(sources: [source])

        #expect(!FileManager.default.fileExists(atPath: source.identityURL.path))
        #expect(try String(contentsOf: source.authURL, encoding: .utf8) == sourceAuth)
        #expect(!FileManager.default.fileExists(atPath: destinationAuthURL.path))
        #expect(try Self.scalarText(
            fixture.databaseURL,
            "SELECT token FROM device_auth_tokens WHERE device_id = '\(Self.fixtureDeviceID)' AND role = 'node'") ==
            "destination-token")
    }

    @Test
    func `source auth access failure preserves the identity claim for retry`() throws {
        let fixture = DeviceIdentityMigrationFixture(databasePath: "state/openclaw.sqlite")
        let source = try fixture.source("source")
        let sourceAuth = """
        {"version":1,"deviceId":"\(Self.fixtureDeviceID)","tokens":{}}
        """
        try sourceAuth.write(to: source.authURL, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: source.authURL.path)
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: source.authURL.path)
        }

        #expect(throws: NSError.self) {
            try fixture.load(sources: [source])
        }

        #expect(FileManager.default.fileExists(atPath: source.identityURL.path))
        #expect(FileManager.default.fileExists(atPath: source.authURL.path))
    }

    @Test
    func `migration rejects conflicting source auth stores`() throws {
        let fixture = DeviceIdentityMigrationFixture(databasePath: "state/openclaw.sqlite")
        let identityJSON = try Self.nodePEMIdentityJSON()
        let first = try fixture.source("first", contents: identityJSON)
        let second = try fixture.source("second", contents: identityJSON)
        let firstAuth = """
        {"version":1,"deviceId":"\(Self
            .fixtureDeviceID)","tokens":{"node":{"token":"first-token","role":"node","scopes":[],"updatedAtMs":100}}}
        """
        let secondAuth = firstAuth.replacingOccurrences(of: "first-token", with: "second-token")
        try firstAuth.write(to: first.authURL, atomically: true, encoding: .utf8)
        try secondAuth.write(to: second.authURL, atomically: true, encoding: .utf8)

        #expect(throws: NSError.self) {
            try fixture.load(sources: [first, second])
        }

        #expect(FileManager.default.fileExists(atPath: first.identityURL.path))
        #expect(FileManager.default.fileExists(atPath: second.identityURL.path))
        #expect(try String(contentsOf: first.authURL, encoding: .utf8) == firstAuth)
        #expect(try String(contentsOf: second.authURL, encoding: .utf8) == secondAuth)
    }

    @Test
    func `migration normalizes imported auth scopes`() throws {
        let fixture = DeviceIdentityMigrationFixture(
            destinationName: "legacy",
            databasePath: "state/openclaw.sqlite")
        let source = try fixture.source("shared")
        let sourceAuth = """
        {"version":1,"deviceId":"\(Self
            .fixtureDeviceID)","tokens":{"legacy":{"token":"source-token","role":"node","scopes":["write","read"],"updatedAtMs":100}}}
        """
        try sourceAuth.write(to: source.authURL, atomically: true, encoding: .utf8)

        _ = try fixture.load(sources: [source])

        #expect(!FileManager.default.fileExists(atPath: source.identityURL.path))
        #expect(try String(contentsOf: source.authURL, encoding: .utf8) == sourceAuth)
        #expect(try Self.scalarText(
            fixture.databaseURL,
            "SELECT scopes_json FROM device_auth_tokens WHERE device_id = '\(Self.fixtureDeviceID)' AND role = 'node'") ==
            "[\"read\",\"write\"]")
    }

    @Test
    func `preserves WAL journal mode`() throws {
        let fixture = DeviceIdentityMigrationFixture()
        try Self.seedCanonicalSchema(fixture.databaseURL)
        #expect(try Self.scalarText(fixture.databaseURL, "PRAGMA journal_mode = WAL")?.lowercased() == "wal")

        _ = try fixture.load()

        #expect(try Self.scalarText(fixture.databaseURL, "PRAGMA journal_mode")?.lowercased() == "wal")
    }

    @Test
    func `fails closed for nonempty missing wrong and newer schemas`() throws {
        let fixture = DeviceIdentityMigrationFixture()
        let root = fixture.root
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
