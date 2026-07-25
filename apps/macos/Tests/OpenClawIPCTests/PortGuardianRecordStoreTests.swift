import ConcurrencyExtras
import Foundation
import SQLite3
import Testing
@testable import OpenClaw

struct PortGuardianRecordStoreTests {
    @Test
    func `storage marker distinguishes older OpenClaw writers from aligned copies`() {
        #expect(!PortGuardian.usesLegacyPortGuardianStorage(
            bundleIdentifier: "com.example.unrelated",
            storageVersion: nil))
        #expect(PortGuardian.usesLegacyPortGuardianStorage(
            bundleIdentifier: "ai.openclaw.mac",
            storageVersion: nil))
        #expect(PortGuardian.usesLegacyPortGuardianStorage(
            bundleIdentifier: "ai.openclaw.mac.debug",
            storageVersion: 1))
        #expect(!PortGuardian.usesLegacyPortGuardianStorage(
            bundleIdentifier: "ai.openclaw.mac",
            storageVersion: 2))
        #expect(!PortGuardian.usesLegacyPortGuardianStorage(
            bundleIdentifier: "ai.openclaw.mac.debug",
            storageVersion: 3))
    }

    @Test
    func `storage marker in app bundle matches runtime capability`() throws {
        let macOSRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let infoURL = macOSRoot.appendingPathComponent("Sources/OpenClaw/Resources/Info.plist")
        let data = try Data(contentsOf: infoURL)
        let values = try #require(
            PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
        let version = try #require(values["OpenClawPortGuardianStorageVersion"] as? NSNumber)

        #expect(version.intValue == PortGuardian.portGuardianStorageVersion)
    }

    @Test
    func `storage marker requires the running code directory hash`() {
        let running = Data(repeating: 0x11, count: 20)
        let replacement = Data(repeating: 0x22, count: 20)

        #expect(PortGuardian.codeDirectoryHashesMatch(running: running, signed: running))
        #expect(!PortGuardian.codeDirectoryHashesMatch(running: running, signed: replacement))
        #expect(!PortGuardian.codeDirectoryHashesMatch(running: nil, signed: running))
        #expect(!PortGuardian.codeDirectoryHashesMatch(running: Data(), signed: Data()))
    }

    @Test
    func `guardian rechecks compatibility after a successful open`() async throws {
        let fixture = try Self.fixture()
        defer { fixture.cleanup() }
        let legacyWriterRunning = LockIsolated(false)
        let attempts = LockIsolated(0)
        let guardian = PortGuardian(
            recordStoreFactory: {
                attempts.withValue { $0 += 1 }
                return try PortGuardianRecordStore(databaseURL: fixture.databaseURL)
            },
            postSpawnCompatibilityCheck: {
                guard !legacyWriterRunning.withValue({ $0 }) else {
                    throw PortGuardianStoreError("legacy writer running")
                }
            })

        let firstPreparation = try await guardian.prepareForTunnelSpawn()
        _ = try await guardian.record(
            port: 18789,
            pid: 4242,
            command: "/usr/bin/ssh",
            mode: .remote,
            preparation: firstPreparation)
        let threatenedPreparation = try await guardian.prepareForTunnelSpawn()
        legacyWriterRunning.withValue { $0 = true }
        await #expect(throws: PortGuardianStoreError.self) {
            try await guardian.record(
                port: 18790,
                pid: 4243,
                command: "/usr/bin/ssh",
                mode: .remote,
                preparation: threatenedPreparation)
        }
        await #expect(throws: PortGuardianStoreError.self) {
            try await guardian.prepareForTunnelSpawn()
        }
        await guardian.cancelTunnelSpawn(threatenedPreparation)
        legacyWriterRunning.withValue { $0 = false }
        let finalPreparation = try await guardian.prepareForTunnelSpawn()
        _ = try await guardian.record(
            port: 18791,
            pid: 4244,
            command: "/usr/bin/ssh",
            mode: .remote,
            preparation: finalPreparation)

        #expect(attempts.withValue { $0 } == 3)
    }

    @Test
    func `relinquished receipt remains durable but becomes reap eligible`() async throws {
        let fixture = try Self.fixture()
        defer { fixture.cleanup() }
        let store = try PortGuardianRecordStore(databaseURL: fixture.databaseURL)
        let guardian = PortGuardian(recordStoreFactory: {
            try PortGuardianRecordStore(databaseURL: fixture.databaseURL)
        })
        let receipt = try await Self.record(
            guardian: guardian,
            port: 18789,
            pid: 2_000_000_000,
            command: "/usr/bin/ssh",
            mode: .remote)

        await guardian.relinquishRecord(receipt)
        #expect(try store.records() == [receipt])
        await guardian.reapOrphanedTunnels()

        #expect(try store.records().isEmpty)
    }

    @Test
    func `failed receipt deletion relinquishes ownership for sweep retry`() async throws {
        let fixture = try Self.fixture()
        defer { fixture.cleanup() }
        let store = try PortGuardianRecordStore(databaseURL: fixture.databaseURL)
        let attempts = LockIsolated(0)
        let guardian = PortGuardian(recordStoreFactory: {
            let attempt = attempts.withValue {
                $0 += 1
                return $0
            }
            guard attempt != 2 else {
                throw PortGuardianStoreError("injected delete failure")
            }
            return try PortGuardianRecordStore(databaseURL: fixture.databaseURL)
        })
        let receipt = try await Self.record(
            guardian: guardian,
            port: 18789,
            pid: 2_000_000_000,
            command: "/usr/bin/ssh",
            mode: .remote)

        await guardian.removeRecord(receipt)
        #expect(try store.records() == [receipt])
        await guardian.reapOrphanedTunnels()

        #expect(attempts.withValue { $0 } == 3)
        #expect(try store.records().isEmpty)
    }

    @Test
    func `guardian retries store creation after a transient failure`() async throws {
        let fixture = try Self.fixture()
        defer { fixture.cleanup() }
        let attempts = LockIsolated(0)
        let guardian = PortGuardian(recordStoreFactory: {
            let attempt = attempts.withValue {
                $0 += 1
                return $0
            }
            guard attempt > 1 else { throw PortGuardianStoreError("transient store failure") }
            return try PortGuardianRecordStore(databaseURL: fixture.databaseURL)
        })

        await #expect(throws: PortGuardianStoreError.self) {
            try await Self.record(
                guardian: guardian,
                port: 18789,
                pid: 4242,
                command: "/usr/bin/ssh",
                mode: .remote)
        }
        let receipt = try await Self.record(
            guardian: guardian,
            port: 18789,
            pid: 4242,
            command: "/usr/bin/ssh",
            mode: .remote)

        #expect(receipt.pid == 4242)
        #expect(attempts.withValue { $0 } == 2)
    }

    @Test
    func `spawn preparation excludes migration until receipt or cancellation`() async throws {
        let fixture = try Self.fixture()
        defer { fixture.cleanup() }
        let guardian = PortGuardian(recordStoreFactory: {
            try PortGuardianRecordStore(databaseURL: fixture.databaseURL)
        })

        let first = try await guardian.prepareForTunnelSpawn()
        await #expect(throws: PortGuardianStoreError.self) {
            try await guardian.prepareForTunnelSpawn()
        }

        await guardian.cancelTunnelSpawn(first)
        let second = try await guardian.prepareForTunnelSpawn()
        await guardian.cancelTunnelSpawn(second)
    }

    @Test
    func `round trips orders replaces and content guards records`() throws {
        let fixture = try Self.fixture()
        defer { fixture.cleanup() }
        let store = try PortGuardianRecordStore(databaseURL: fixture.databaseURL)
        #expect(!FileManager.default.fileExists(atPath: fixture.lockURL.path))
        let later = Self.record(pid: 22, port: 18790, timestamp: 20)
        let earlier = Self.record(pid: 11, port: 18789, timestamp: 10)
        try store.upsert(later)
        try store.upsert(earlier)

        #expect(try store.records() == [earlier, later])

        let replacement = Self.record(pid: earlier.pid, port: 19000, timestamp: 30)
        try store.upsert(replacement)
        #expect(try store.deleteIfMatches(earlier) == false)
        #expect(try store.records() == [later, replacement])
        #expect(try store.deleteIfMatches(replacement))
        #expect(try store.records() == [later])
    }

    @Test
    func `independent concurrent connections preserve their union`() async throws {
        let fixture = try Self.fixture()
        defer { fixture.cleanup() }
        let databaseURL = fixture.databaseURL

        try await withThrowingTaskGroup(of: Void.self) { group in
            for index in 1...12 {
                group.addTask {
                    let store = try PortGuardianRecordStore(databaseURL: databaseURL)
                    try store.upsert(Self.record(
                        pid: Int32(1000 + index),
                        port: 20000 + index,
                        timestamp: Double(index)))
                }
            }
            try await group.waitForAll()
        }

        let store = try PortGuardianRecordStore(databaseURL: databaseURL)
        #expect(try store.records().map(\.pid) == (1...12).map { Int32(1000 + $0) })
    }

    @Test
    func `identity first version zero database composes without losing identity`() throws {
        let fixture = try Self.fixture()
        defer { fixture.cleanup() }
        try Self.execute(fixture.databaseURL, """
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
        INSERT INTO device_identities VALUES ('primary', 'device-1', 'public', 'private', 10, 20);
        """)

        let store = try PortGuardianRecordStore(
            databaseURL: fixture.databaseURL,
            legacyLockURL: fixture.lockURL)
        try store.upsert(Self.record(pid: 4242, port: 18789, timestamp: 42))

        #expect(try Self.scalarInt(fixture.databaseURL, "PRAGMA user_version") == 0)
        #expect(try Self.scalarInt(
            fixture.databaseURL,
            "SELECT COUNT(*) FROM device_identities WHERE identity_key = 'primary'") == 1)
        #expect(try store.records().map(\.pid) == [4242])
    }

    @Test
    func `legacy migration merges verifies and retires source`() throws {
        let fixture = try Self.fixture()
        defer { fixture.cleanup() }
        let store = try PortGuardianRecordStore(
            databaseURL: fixture.databaseURL,
            legacyLockURL: fixture.lockURL)
        let existing = Self.record(pid: 10, port: 18789, timestamp: 20)
        let imported = Self.record(pid: 20, port: 18790, timestamp: 30)
        try store.upsert(existing)
        // The lock must not strand a shipped app after it has spawned SSH but
        // before it records JSON. A later aligned startup can still import it.
        try Self.writeLegacyRecords(
            [existing, imported],
            recordURL: fixture.legacyURL,
            lockURL: fixture.lockURL)

        #expect(try store.migrateLegacyRecords(recordURL: fixture.legacyURL) == 2)
        #expect(try store.records() == [existing, imported])
        #expect(!FileManager.default.fileExists(atPath: fixture.legacyURL.path))
        #expect(FileManager.default.fileExists(atPath: fixture.lockURL.path))
    }

    @Test
    func `legacy migration rejects every divergent same pid receipt`() throws {
        let fixture = try Self.fixture()
        defer { fixture.cleanup() }
        let store = try PortGuardianRecordStore(
            databaseURL: fixture.databaseURL,
            legacyLockURL: fixture.lockURL)
        let canonical = Self.record(pid: 30, port: 18789, timestamp: 20)
        try store.upsert(canonical)
        let older = Self.record(pid: 30, port: 19000, timestamp: 10)
        try JSONEncoder().encode([older]).write(to: fixture.legacyURL, options: [.atomic])

        #expect(throws: PortGuardianStoreError.self) {
            try store.migrateLegacyRecords(recordURL: fixture.legacyURL)
        }
        #expect(FileManager.default.fileExists(atPath: fixture.legacyURL.path))
        #expect(try store.records() == [canonical])

        try FileManager.default.removeItem(at: fixture.legacyURL)
        let newer = Self.record(pid: 30, port: 19001, timestamp: 30)
        try JSONEncoder().encode([newer]).write(to: fixture.legacyURL, options: [.atomic])
        #expect(throws: PortGuardianStoreError.self) {
            try store.migrateLegacyRecords(recordURL: fixture.legacyURL)
        }
        #expect(FileManager.default.fileExists(atPath: fixture.legacyURL.path))
        #expect(try store.records() == [canonical])
    }

    @Test
    func `legacy migration applies preplanned replacement and retirement decisions`() throws {
        let fixture = try Self.fixture()
        defer { fixture.cleanup() }
        let store = try PortGuardianRecordStore(
            databaseURL: fixture.databaseURL,
            legacyLockURL: fixture.lockURL)
        let existing = Self.record(pid: 50, port: 18789, timestamp: 10)
        let legacy = Self.record(pid: 50, port: 18790, timestamp: 20)
        try store.upsert(existing)
        try JSONEncoder().encode([legacy]).write(to: fixture.legacyURL, options: [.atomic])

        _ = try store.migrateLegacyRecords(recordURL: fixture.legacyURL) { _, legacy in legacy }
        #expect(try store.records() == [legacy])
        #expect(!FileManager.default.fileExists(atPath: fixture.legacyURL.path))

        let staleLegacy = Self.record(pid: 50, port: 18791, timestamp: 30)
        try JSONEncoder().encode([staleLegacy]).write(to: fixture.legacyURL, options: [.atomic])
        _ = try store.migrateLegacyRecords(recordURL: fixture.legacyURL) { _, _ in nil }
        #expect(try store.records().isEmpty)
        #expect(!FileManager.default.fileExists(atPath: fixture.legacyURL.path))
    }

    @Test
    func `live process generation resolves divergent legacy receipts`() throws {
        let existing = Self.record(pid: 60, port: 18789, timestamp: 90)
        let legacy = Self.record(pid: 60, port: 18790, timestamp: 101)
        let legacyProcess = PortGuardian.TunnelProcessInfo(
            parentPid: 1,
            startedAt: 100,
            fullCommand: "/usr/bin/ssh -N -L 18790:127.0.0.1:18789 host")
        #expect(try PortGuardian.resolveLegacyReceipt(
            existing: existing,
            legacy: legacy,
            process: legacyProcess) == legacy)
        #expect(try PortGuardian.resolveLegacyReceipt(
            existing: nil,
            legacy: legacy,
            process: legacyProcess) == legacy)

        let existingProcess = PortGuardian.TunnelProcessInfo(
            parentPid: 1,
            startedAt: 89,
            fullCommand: "/usr/bin/ssh -N -L 18789:127.0.0.1:18789 host")
        #expect(try PortGuardian.resolveLegacyReceipt(
            existing: existing,
            legacy: legacy,
            process: existingProcess) == existing)

        let unrelated = PortGuardian.TunnelProcessInfo(
            parentPid: 1,
            startedAt: 100,
            fullCommand: "node server.js")
        #expect(try PortGuardian.resolveLegacyReceipt(
            existing: existing,
            legacy: legacy,
            process: unrelated) == nil)
        #expect(try PortGuardian.resolveLegacyReceipt(
            existing: existing,
            legacy: legacy,
            process: nil) == nil)
        #expect(try PortGuardian.resolveLegacyReceipt(
            existing: nil,
            legacy: legacy,
            process: nil) == nil)

        let unreadable = PortGuardian.TunnelProcessInfo(parentPid: 1, startedAt: 100, fullCommand: nil)
        #expect(throws: PortGuardianStoreError.self) {
            try PortGuardian.resolveLegacyReceipt(
                existing: existing,
                legacy: legacy,
                process: unreadable)
        }

        let sameForward = Self.record(pid: 60, port: 18789, timestamp: 89.25)
        #expect(try PortGuardian.resolveLegacyReceipt(
            existing: existing,
            legacy: sameForward,
            process: existingProcess) == sameForward)
    }

    @Test
    func `retired legacy receipt stays retired after source removal retry`() throws {
        let fixture = try Self.fixture()
        defer { fixture.cleanup() }
        let removalAttempts = LockIsolated(0)
        let store = try PortGuardianRecordStore(
            databaseURL: fixture.databaseURL,
            legacyLockURL: fixture.lockURL,
            removeLegacySource: { url in
                let attempt = removalAttempts.withValue {
                    $0 += 1
                    return $0
                }
                guard attempt > 1 else { throw PortGuardianStoreError("injected removal failure") }
                try FileManager.default.removeItem(at: url)
            })
        let canonical = Self.record(pid: 70, port: 18789, timestamp: 10)
        let legacy = Self.record(pid: 70, port: 18790, timestamp: 20)
        try store.upsert(canonical)
        try JSONEncoder().encode([legacy]).write(to: fixture.legacyURL, options: [.atomic])
        var observedExisting: [PortGuardian.Record?] = []

        #expect(throws: PortGuardianStoreError.self) {
            try store.migrateLegacyRecords(recordURL: fixture.legacyURL) { existing, _ in
                observedExisting.append(existing)
                return nil
            }
        }
        #expect(try store.records().isEmpty)
        #expect(FileManager.default.fileExists(atPath: fixture.legacyURL.path))

        _ = try store.migrateLegacyRecords(recordURL: fixture.legacyURL) { existing, _ in
            observedExisting.append(existing)
            return nil
        }
        #expect(observedExisting.count == 2)
        #expect(observedExisting[0] == canonical)
        #expect(observedExisting[1] == nil)
        #expect(try store.records().isEmpty)
        #expect(!FileManager.default.fileExists(atPath: fixture.legacyURL.path))
    }

    @Test
    func `legacy planning releases the writer lock and tolerates peer completion`() async throws {
        let fixture = try Self.fixture()
        defer { fixture.cleanup() }
        let store = try PortGuardianRecordStore(
            databaseURL: fixture.databaseURL,
            legacyLockURL: fixture.lockURL)
        let peerStore = try PortGuardianRecordStore(
            databaseURL: fixture.databaseURL,
            legacyLockURL: fixture.lockURL)
        let legacy = Self.record(pid: 80, port: 18789, timestamp: 20)
        try JSONEncoder().encode([legacy]).write(to: fixture.legacyURL, options: [.atomic])
        let planningStarted = DispatchSemaphore(value: 0)
        let finishPlanning = DispatchSemaphore(value: 0)
        let migration = Task.detached {
            try store.migrateLegacyRecords(recordURL: fixture.legacyURL) { _, legacy in
                planningStarted.signal()
                _ = finishPlanning.wait(timeout: .now() + 5)
                return legacy
            }
        }

        let started = await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(returning: planningStarted.wait(timeout: .now() + 2) == .success)
            }
        }
        #expect(started)
        let descriptor = open(fixture.lockURL.path, O_RDWR | O_CLOEXEC | O_NOFOLLOW)
        #expect(descriptor >= 0)
        if descriptor >= 0 {
            #expect(flock(descriptor, LOCK_EX | LOCK_NB) == 0)
            _ = flock(descriptor, LOCK_UN)
            close(descriptor)
        }
        #expect(try peerStore.migrateLegacyRecords(recordURL: fixture.legacyURL) == 1)
        #expect(!FileManager.default.fileExists(atPath: fixture.legacyURL.path))
        finishPlanning.signal()

        #expect(try await migration.value == 0)
        #expect(try store.records() == [legacy])
    }

    @Test
    func `invalid duplicate and linked legacy sources fail closed`() throws {
        let fixture = try Self.fixture()
        defer { fixture.cleanup() }
        let store = try PortGuardianRecordStore(
            databaseURL: fixture.databaseURL,
            legacyLockURL: fixture.lockURL)
        try Data("not-json".utf8).write(to: fixture.legacyURL)
        #expect(throws: PortGuardianStoreError.self) {
            try store.migrateLegacyRecords(recordURL: fixture.legacyURL)
        }
        #expect(FileManager.default.fileExists(atPath: fixture.legacyURL.path))
        #expect(try store.records().isEmpty)

        let duplicate = Self.record(pid: 40, port: 18789, timestamp: 10)
        try JSONEncoder().encode([duplicate, duplicate]).write(to: fixture.legacyURL, options: [.atomic])
        #expect(throws: PortGuardianStoreError.self) {
            try store.migrateLegacyRecords(recordURL: fixture.legacyURL)
        }
        #expect(try store.records().isEmpty)

        try FileManager.default.removeItem(at: fixture.legacyURL)
        let target = fixture.root.appendingPathComponent("legacy-target.json")
        try JSONEncoder().encode([duplicate]).write(to: target)
        try FileManager.default.createSymbolicLink(at: fixture.legacyURL, withDestinationURL: target)
        #expect(throws: PortGuardianStoreError.self) {
            try store.migrateLegacyRecords(recordURL: fixture.legacyURL)
        }
        #expect(FileManager.default.fileExists(atPath: target.path))
        #expect(try store.records().isEmpty)
    }

    @Test
    func `supported and newer Node schema versions open or fail closed`() throws {
        let fixture = try Self.fixture()
        defer { fixture.cleanup() }

        for version in [4, 5] {
            let databaseURL = fixture.root.appendingPathComponent("supported-v\(version).sqlite")
            try Self.seedVersionedPortGuardianDatabase(databaseURL, schemaVersion: version)
            let store = try PortGuardianRecordStore(databaseURL: databaseURL)
            let record = Self.record(
                pid: Int32(4200 + version),
                port: 18780 + version,
                timestamp: Double(version))
            try store.upsert(record)
            #expect(try store.records() == [record])
        }

        for version in [6, 99] {
            let databaseURL = fixture.root.appendingPathComponent("newer-v\(version).sqlite")
            try Self.seedVersionedPortGuardianDatabase(databaseURL, schemaVersion: version)
            #expect(throws: PortGuardianStoreError.self) {
                try PortGuardianRecordStore(databaseURL: databaseURL)
            }
        }
    }

    @Test
    func `foreign and incompatible databases fail closed`() throws {
        let fixture = try Self.fixture()
        defer { fixture.cleanup() }

        let foreignURL = fixture.root.appendingPathComponent("foreign.sqlite")
        try Self.execute(foreignURL, "CREATE TABLE unrelated (id INTEGER PRIMARY KEY) STRICT")
        #expect(throws: PortGuardianStoreError.self) {
            try PortGuardianRecordStore(databaseURL: foreignURL)
        }

        let uniqueIndexURL = fixture.root.appendingPathComponent("unique-index.sqlite")
        try Self.execute(uniqueIndexURL, """
        CREATE TABLE macos_port_guardian_records (
          pid INTEGER NOT NULL PRIMARY KEY,
          port INTEGER NOT NULL,
          command TEXT NOT NULL,
          mode TEXT NOT NULL,
          timestamp REAL NOT NULL
        ) STRICT;
        CREATE UNIQUE INDEX idx_macos_port_guardian_records_port
          ON macos_port_guardian_records(port, timestamp DESC);
        """)
        #expect(throws: PortGuardianStoreError.self) {
            try PortGuardianRecordStore(databaseURL: uniqueIndexURL)
        }
    }

    @Test
    func `retained store rejects mutations after schema advances`() throws {
        let fixture = try Self.fixture()
        defer { fixture.cleanup() }
        let store = try PortGuardianRecordStore(
            databaseURL: fixture.databaseURL,
            legacyLockURL: fixture.lockURL)
        let existing = Self.record(pid: 4242, port: 18789, timestamp: 42)
        try store.upsert(existing)
        try JSONEncoder().encode([existing]).write(to: fixture.legacyURL, options: [.atomic])

        try Self.execute(fixture.databaseURL, "PRAGMA user_version = 6")

        #expect(throws: PortGuardianStoreError.self) {
            try store.upsert(Self.record(pid: 4243, port: 18790, timestamp: 43))
        }
        #expect(throws: PortGuardianStoreError.self) {
            try store.deleteIfMatches(existing)
        }
        #expect(throws: PortGuardianStoreError.self) {
            try store.migrateLegacyRecords(recordURL: fixture.legacyURL)
        }
        #expect(FileManager.default.fileExists(atPath: fixture.legacyURL.path))
        #expect(try Self.scalarInt(
            fixture.databaseURL,
            "SELECT COUNT(*) FROM macos_port_guardian_records") == 1)
    }

    @Test
    func `legacy compatibility lock rejects symbolic links`() throws {
        let fixture = try Self.fixture()
        defer { fixture.cleanup() }
        let target = fixture.root.appendingPathComponent("lock-target")
        try Data().write(to: target)
        try FileManager.default.createSymbolicLink(at: fixture.lockURL, withDestinationURL: target)

        #expect(throws: PortGuardianStoreError.self) {
            try PortGuardianRecordStore(
                databaseURL: fixture.databaseURL,
                legacyLockURL: fixture.lockURL)
        }
    }

    private struct Fixture: @unchecked Sendable {
        let root: URL
        let databaseURL: URL
        let legacyURL: URL
        let lockURL: URL

        func cleanup() {
            try? FileManager.default.removeItem(at: self.root)
        }
    }

    private static func fixture() throws -> Fixture {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("port-guardian-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return Fixture(
            root: root,
            databaseURL: root.appendingPathComponent("state/openclaw.sqlite"),
            legacyURL: root.appendingPathComponent("port-guard.json"),
            lockURL: root.appendingPathComponent("port-guard.lock"))
    }

    private static func record(pid: Int32, port: Int, timestamp: TimeInterval) -> PortGuardian.Record {
        PortGuardian.Record(
            port: port,
            pid: pid,
            command: "/usr/bin/ssh",
            mode: "remote",
            timestamp: timestamp)
    }

    private static func execute(_ databaseURL: URL, _ sql: String) throws {
        try FileManager.default.createDirectory(
            at: databaseURL.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        var database: OpaquePointer?
        guard sqlite3_open(databaseURL.path, &database) == SQLITE_OK, let database else {
            throw PortGuardianStoreError("Could not open test database")
        }
        defer { sqlite3_close(database) }
        guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else {
            throw PortGuardianStoreError(String(cString: sqlite3_errmsg(database)))
        }
    }

    private static func seedVersionedPortGuardianDatabase(
        _ databaseURL: URL,
        schemaVersion: Int) throws
    {
        try self.execute(databaseURL, """
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
        ) VALUES ('primary', 'global', \(schemaVersion), NULL, NULL, 1, 1);
        CREATE TABLE macos_port_guardian_records (
          pid INTEGER NOT NULL PRIMARY KEY,
          port INTEGER NOT NULL,
          command TEXT NOT NULL,
          mode TEXT NOT NULL,
          timestamp REAL NOT NULL
        ) STRICT;
        CREATE INDEX idx_macos_port_guardian_records_port
          ON macos_port_guardian_records(port, timestamp DESC);
        PRAGMA user_version = \(schemaVersion);
        """)
    }

    private static func scalarInt(_ databaseURL: URL, _ sql: String) throws -> Int64 {
        var database: OpaquePointer?
        guard sqlite3_open(databaseURL.path, &database) == SQLITE_OK, let database else {
            throw PortGuardianStoreError("Could not open test database")
        }
        defer { sqlite3_close(database) }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw PortGuardianStoreError(String(cString: sqlite3_errmsg(database)))
        }
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW else {
            throw PortGuardianStoreError(String(cString: sqlite3_errmsg(database)))
        }
        return sqlite3_column_int64(statement, 0)
    }

    private static func writeLegacyRecords(
        _ records: [PortGuardian.Record],
        recordURL: URL,
        lockURL: URL) throws
    {
        let descriptor = open(lockURL.path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { throw PortGuardianStoreError("Could not open test legacy lock") }
        defer { close(descriptor) }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            throw PortGuardianStoreError("New store blocked the shipped PortGuardian writer")
        }
        defer { _ = flock(descriptor, LOCK_UN) }
        try JSONEncoder().encode(records).write(to: recordURL, options: [.atomic])
    }

    private static func record(
        guardian: PortGuardian,
        port: Int,
        pid: Int32,
        command: String,
        mode: AppState.ConnectionMode) async throws -> PortGuardian.Record
    {
        let preparation = try await guardian.prepareForTunnelSpawn()
        return try await guardian.record(
            port: port,
            pid: pid,
            command: command,
            mode: mode,
            preparation: preparation)
    }
}
