import Foundation
import Testing
@testable import OpenClawNativeState
#if canImport(Darwin)
import Darwin
import Darwin.membership
#endif

struct OpenClawNativeStateSQLiteTests {
    @Test
    func `version zero composes exact canonical tables`() throws {
        try self.withDatabase { database in
            try database.withImmediateTransaction {
                try database.ensureCanonicalTable(.macosPortGuardianRecords)
                try database.execute("""
                INSERT INTO macos_port_guardian_records (pid, port, command, mode, timestamp)
                VALUES (4242, 18789, '/usr/bin/ssh', 'remote', 42.5)
                """)
                try database.ensureCanonicalTable(.deviceIdentities)
            }

            #expect(try database.scalarInt64("PRAGMA user_version") == 0)
            #expect(try database.scalarInt64(
                "SELECT COUNT(*) FROM macos_port_guardian_records WHERE pid = 4242") == 1)
            #expect(try database.scalarInt64(
                "SELECT COUNT(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'") == 4)
        }
    }

    @Test
    func `version zero rejects incomplete known sibling schema`() throws {
        try self.withDatabase { database in
            try database.execute("""
            CREATE TABLE macos_port_guardian_records (
              pid INTEGER NOT NULL PRIMARY KEY,
              port INTEGER NOT NULL,
              command TEXT NOT NULL,
              mode TEXT NOT NULL,
              timestamp REAL NOT NULL
            ) STRICT
            """)

            #expect(throws: OpenClawNativeStateError.self) {
                try database.ensureCanonicalTable(.deviceIdentities)
            }
        }
    }

    @Test
    func `versioned database never synthesizes a missing canonical table`() throws {
        try self.withDatabase { database in
            try database.execute("""
            CREATE TABLE schema_meta (
              meta_key TEXT NOT NULL PRIMARY KEY,
              role TEXT NOT NULL,
              schema_version INTEGER NOT NULL
            ) STRICT;
            INSERT INTO schema_meta (meta_key, role, schema_version)
            VALUES ('primary', 'global', 3);
            PRAGMA user_version = 3;
            """)

            #expect(throws: OpenClawNativeStateError.self) {
                try database.ensureCanonicalTable(.deviceIdentities)
            }
            #expect(try database.schemaObjectExists(type: "table", name: "device_identities") == false)
        }
    }

    @Test
    func `immediate transaction rolls back all writes`() throws {
        try self.withDatabase { database in
            try database.withImmediateTransaction {
                try database.ensureCanonicalTable(.macosPortGuardianRecords)
            }

            #expect(throws: TestError.self) {
                try database.withImmediateTransaction {
                    try database.execute("""
                    INSERT INTO macos_port_guardian_records (pid, port, command, mode, timestamp)
                    VALUES (4242, 18789, '/usr/bin/ssh', 'remote', 42.5)
                    """)
                    throw TestError.expected
                }
            }
            #expect(try database.scalarInt64("SELECT COUNT(*) FROM macos_port_guardian_records") == 0)
        }
    }

    @Test
    func `concurrent version zero stores compose different tables`() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let databaseURL = directory.appendingPathComponent("openclaw.sqlite", isDirectory: false)

        try await withThrowingTaskGroup(of: Void.self) { group in
            for table in [
                OpenClawNativeStateCanonicalTable.deviceIdentities,
                .macosPortGuardianRecords,
            ] {
                group.addTask {
                    let database = try OpenClawNativeStateSQLite(databaseURL: databaseURL)
                    try database.withImmediateTransaction {
                        try database.ensureCanonicalTable(table)
                    }
                }
            }
            try await group.waitForAll()
        }

        let database = try OpenClawNativeStateSQLite(databaseURL: databaseURL)
        #expect(try database.scalarInt64(
            "SELECT COUNT(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'") == 4)
    }

    @Test(arguments: [
        NSError(domain: NSCocoaErrorDomain, code: NSFileNoSuchFileError),
        NSError(domain: NSPOSIXErrorDomain, code: Int(POSIXErrorCode.ENOENT.rawValue)),
    ])
    func `vanished transient sidecar does not fail committed write cleanup`(missing: NSError) throws {
        let databaseURL = URL(fileURLWithPath: "/tmp/openclaw-native-state.sqlite")
        var attemptedPaths: [String] = []

        try OpenClawNativeStateSQLite.secureDatabaseFiles(
            databaseURL,
            fileExists: { _ in true },
            setAttributes: { _, path in
                attemptedPaths.append(path)
                if path.hasSuffix("-wal") {
                    throw missing
                }
            })

        #expect(attemptedPaths == [
            databaseURL.path,
            databaseURL.path + "-wal",
            databaseURL.path + "-shm",
            databaseURL.path + "-journal",
        ])
    }

    #if canImport(Darwin)
    @Test
    func `new private state removes inherited grants without changing ancestors`() throws {
        let ancestor = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: ancestor, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: ancestor) }
        try self.installACL(at: ancestor)
        let ancestorACL = try self.aclText(at: ancestor)
        let sibling = ancestor.appendingPathComponent("unrelated")
        try Data("unchanged".utf8).write(to: sibling)
        let siblingACL = try self.aclText(at: sibling)

        let parent = ancestor.appendingPathComponent("state")
        let databaseURL = parent.appendingPathComponent("openclaw.sqlite")
        let database = try OpenClawNativeStateSQLite(databaseURL: databaseURL)
        try database.execute("PRAGMA journal_mode=WAL")
        try database.withImmediateTransaction {
            try database.ensureCanonicalTable(.deviceIdentities)
        }

        try self.expectPrivateMetadata(at: parent, mode: 0o700)
        for suffix in ["", "-wal", "-shm"] {
            try self.expectPrivateMetadata(at: URL(fileURLWithPath: databaseURL.path + suffix), mode: 0o600)
        }
        #expect(try self.aclText(at: ancestor) == ancestorACL)
        #expect(try self.aclText(at: sibling) == siblingACL)
    }

    @Test(arguments: [false, true], ["WAL", "PERSIST"])
    func `existing state removes explicit grants and preserves contents`(
        createIfMissing: Bool,
        journalMode: String) throws
    {
        let parent = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: parent) }
        let databaseURL = parent.appendingPathComponent("openclaw.sqlite")
        do {
            let database = try OpenClawNativeStateSQLite(databaseURL: databaseURL)
            try database.withImmediateTransaction {
                try database.ensureCanonicalTable(.deviceIdentities)
                try database.ensureCanonicalTable(.deviceAuthTokens)
                try database.execute("""
                INSERT INTO device_identities VALUES ('profile', 'device', 'public', 'private', 10, 20);
                INSERT INTO device_auth_tokens VALUES ('device', 'operator', 'token', '["read"]', 30);
                """)
            }
        }
        try self.installACL(at: parent)
        try self.installACL(at: databaseURL)
        try FileManager.default.setAttributes([.posixPermissions: 0o750], ofItemAtPath: parent.path)
        let parentACL = try self.aclText(at: parent)

        let database = try OpenClawNativeStateSQLite(databaseURL: databaseURL, createIfMissing: createIfMissing)
        try self.expectPrivateMetadata(at: databaseURL, mode: 0o600)
        try database.execute("PRAGMA journal_mode=\(journalMode)")
        try database.withImmediateTransaction {
            try database.execute("UPDATE device_identities SET updated_at_ms = 20")
        }
        let suffixes = journalMode == "WAL" ? ["", "-wal", "-shm"] : ["", "-journal"]
        for suffix in suffixes {
            try self.installACL(at: URL(fileURLWithPath: databaseURL.path + suffix))
        }
        try database.withImmediateTransaction {
            try database.execute("UPDATE device_auth_tokens SET updated_at_ms = 30")
        }
        for suffix in suffixes {
            try self.expectPrivateMetadata(at: URL(fileURLWithPath: databaseURL.path + suffix), mode: 0o600)
        }
        #expect(try database.scalarInt64("""
        SELECT COUNT(*) FROM device_identities
        WHERE identity_key = 'profile' AND device_id = 'device' AND public_key_pem = 'public'
          AND private_key_pem = 'private' AND created_at_ms = 10 AND updated_at_ms = 20
        """) == 1)
        #expect(try database.scalarInt64("""
        SELECT COUNT(*) FROM device_auth_tokens
        WHERE device_id = 'device' AND role = 'operator' AND token = 'token'
          AND scopes_json = '["read"]' AND updated_at_ms = 30
        """) == 1)
        #expect(try database.scalarInt64("PRAGMA user_version") == 0)
        if createIfMissing {
            try self.expectPrivateMetadata(at: parent, mode: 0o700)
        } else {
            #expect(try self.aclText(at: parent) == parentACL)
            #expect(try FileManager.default.attributesOfItem(atPath: parent.path)[.posixPermissions] as? Int == 0o750)
        }
    }

    @Test(arguments: [GrantPrincipal.owner, .group, .everyone])
    func `mixed ACL preserves ordering and owner access`(principal: GrantPrincipal) throws {
        try self.withDatabaseURL { database, databaseURL in
            try database.withImmediateTransaction {
                try database.ensureCanonicalTable(.deviceIdentities)
            }
            try self.installACL(
                at: databaseURL,
                tags: [ACL_EXTENDED_ALLOW, ACL_EXTENDED_DENY],
                principal: principal)
            let originalACL = try self.aclText(at: databaseURL)
            let originalBytes = try Data(contentsOf: databaseURL)

            try OpenClawNativeStateSQLite.secureDatabaseFiles(databaseURL)

            #expect(try self.aclText(at: databaseURL) == originalACL)
            #expect(try Data(contentsOf: databaseURL) == originalBytes)
            try database.withImmediateTransaction {
                try database.execute("""
                INSERT INTO device_identities VALUES ('profile', 'device', 'public', 'private', 10, 20)
                """)
            }
            #expect(try database.scalarInt64("SELECT COUNT(*) FROM device_identities") == 1)
            #expect(try self.aclText(at: databaseURL) == originalACL)
        }
    }

    @Test(arguments: [ACL_FLAG_NO_INHERIT, ACL_FLAG_DEFER_INHERIT])
    func `flagged ACL remains unchanged`(flag: acl_flag_t) throws {
        try self.withDatabaseURL { _, databaseURL in
            try self.installACL(at: databaseURL, flag: flag)
            let originalACL = try self.aclText(at: databaseURL)

            try OpenClawNativeStateSQLite.secureDatabaseFiles(databaseURL)

            #expect(try self.aclText(at: databaseURL) == originalACL)
            guard let acl = acl_get_file(databaseURL.path, ACL_TYPE_EXTENDED) else { throw self.aclError() }
            defer { acl_free(UnsafeMutableRawPointer(acl)) }
            var flags: acl_flagset_t?
            guard acl_get_flagset_np(UnsafeMutableRawPointer(acl), &flags) == 0 else { throw self.aclError() }
            #expect(acl_get_flag_np(flags, flag) == 1)
        }
    }

    enum GrantPrincipal: UInt8, Sendable {
        case owner = 0x0A
        case everyone = 0x0C
        case group = 0x10
    }

    private func installACL(
        at url: URL,
        tags: [acl_tag_t] = [ACL_EXTENDED_ALLOW, ACL_EXTENDED_ALLOW],
        principal: GrantPrincipal = .everyone,
        flag: acl_flag_t? = nil) throws
    {
        var acl = acl_init(Int32(tags.count))
        guard acl != nil else { throw self.aclError() }
        defer { acl_free(UnsafeMutableRawPointer(acl!)) }
        if let flag {
            var flags: acl_flagset_t?
            guard acl_get_flagset_np(UnsafeMutableRawPointer(acl!), &flags) == 0,
                  acl_add_flag_np(flags, flag) == 0
            else { throw self.aclError() }
        }
        for tag in tags {
            // Darwin's well-known principals keep the fixture independent of local accounts.
            var qualifier: uuid_t = (
                0xAB, 0xCD, 0xEF, 0xAB, 0xCD, 0xEF, 0xAB, 0xCD,
                0xEF, 0xAB, 0xCD, 0xEF, 0, 0, 0,
                tag == ACL_EXTENDED_ALLOW ? principal.rawValue : GrantPrincipal.everyone.rawValue)
            if tag == ACL_EXTENDED_ALLOW, principal == .owner || principal == .group {
                let result = principal == .owner
                    ? mbr_uid_to_uuid(geteuid(), &qualifier)
                    : mbr_gid_to_uuid(getegid(), &qualifier)
                guard result == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(result)) }
            }
            var entry: acl_entry_t?
            guard acl_create_entry(&acl, &entry) == 0,
                  acl_set_tag_type(entry, tag) == 0,
                  acl_set_qualifier(entry, &qualifier) == 0
            else { throw self.aclError() }
            var permissions: acl_permset_t?
            guard acl_get_permset(entry, &permissions) == 0 else { throw self.aclError() }
            for permission in tag == ACL_EXTENDED_ALLOW
                ? [ACL_READ_DATA, ACL_WRITE_DATA, ACL_APPEND_DATA, ACL_EXECUTE, ACL_READ_ATTRIBUTES,
                   ACL_WRITE_ATTRIBUTES, ACL_READ_EXTATTRIBUTES, ACL_WRITE_EXTATTRIBUTES, ACL_READ_SECURITY,
                   ACL_WRITE_SECURITY]
                : [ACL_READ_DATA]
            {
                guard acl_add_perm(permissions, permission) == 0 else { throw self.aclError() }
            }
            var flags: acl_flagset_t?
            guard acl_get_flagset_np(UnsafeMutableRawPointer(entry), &flags) == 0,
                  acl_add_flag_np(flags, ACL_ENTRY_FILE_INHERIT) == 0,
                  acl_add_flag_np(flags, ACL_ENTRY_DIRECTORY_INHERIT) == 0
            else { throw self.aclError() }
        }
        guard acl_set_file(url.path, ACL_TYPE_EXTENDED, acl) == 0 else { throw self.aclError() }
    }

    private func aclText(at url: URL) throws -> String {
        guard let acl = acl_get_file(url.path, ACL_TYPE_EXTENDED) else { throw self.aclError() }
        defer { acl_free(UnsafeMutableRawPointer(acl)) }
        guard let text = acl_to_text(acl, nil) else { throw self.aclError() }
        defer { acl_free(text) }
        return String(cString: text)
    }

    private func expectPrivateMetadata(at url: URL, mode: Int) throws {
        #expect(try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? Int == mode)
        guard let acl = acl_get_file(url.path, ACL_TYPE_EXTENDED) else {
            let code = errno
            _ = try FileManager.default.attributesOfItem(atPath: url.path)
            #expect(code == ENOENT)
            return
        }
        defer { acl_free(UnsafeMutableRawPointer(acl)) }
        var index: Int32 = 0
        var entry: acl_entry_t?
        while acl_get_entry(acl, index, &entry) == 0 {
            var tag = ACL_UNDEFINED_TAG
            guard acl_get_tag_type(entry, &tag) == 0 else { throw self.aclError() }
            #expect(tag != ACL_EXTENDED_ALLOW)
            index += 1
        }
        guard errno == EINVAL else { throw self.aclError() }
        #expect(index == 0)
    }

    private func aclError() -> NSError {
        NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
    }
    #endif

    @Test
    func `missing database or nonmissing sidecar failure remains fatal`() {
        let databaseURL = URL(fileURLWithPath: "/tmp/openclaw-native-state.sqlite")
        let missing = NSError(domain: NSPOSIXErrorDomain, code: Int(POSIXErrorCode.ENOENT.rawValue))
        let denied = NSError(domain: NSPOSIXErrorDomain, code: Int(POSIXErrorCode.EACCES.rawValue))

        #expect(throws: NSError.self) {
            try OpenClawNativeStateSQLite.secureDatabaseFiles(
                databaseURL,
                fileExists: { _ in true },
                setAttributes: { _, path in
                    if path == databaseURL.path { throw missing }
                })
        }
        #expect(throws: NSError.self) {
            try OpenClawNativeStateSQLite.secureDatabaseFiles(
                databaseURL,
                fileExists: { _ in true },
                setAttributes: { _, path in
                    if path.hasSuffix("-wal") { throw denied }
                })
        }
    }

    private enum TestError: Error {
        case expected
    }

    private func withDatabase(
        body: (OpenClawNativeStateSQLite) throws -> Void) throws
    {
        try self.withDatabaseURL { database, _ in try body(database) }
    }

    private func withDatabaseURL(
        body: (OpenClawNativeStateSQLite, URL) throws -> Void) throws
    {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let databaseURL = directory.appendingPathComponent("openclaw.sqlite", isDirectory: false)
        let database = try OpenClawNativeStateSQLite(databaseURL: databaseURL)
        try body(database, databaseURL)
    }
}
