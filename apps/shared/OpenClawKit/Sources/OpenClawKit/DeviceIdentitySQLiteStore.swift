import CryptoKit
import Darwin
import Foundation
import OpenClawNativeState
import SQLite3

enum DeviceIdentitySQLiteStore {
    private static let busyTimeoutMilliseconds: Int32 = 5000
    private static let maximumLegacyIdentityBytes = 64 * 1024
    private static let maximumLegacyAuthBytes = 4 * 1024 * 1024
    private static let doctorClaimSuffix = ".doctor-importing"
    private static let nativeClaimSuffix = ".native-importing"

    private struct LegacyClaim {
        let source: DeviceIdentityPaths.LegacyIdentitySource
        let identityURL: URL
        let data: Data
        let snapshot: LegacyFileSnapshot
        let material: DeviceIdentityMaterial
    }

    private struct LegacyFileSnapshot: Equatable {
        let device: UInt64
        let inode: UInt64
        let size: UInt64
        let modifiedAt: Date?
    }

    private struct LegacyAuthCandidate {
        let data: Data
        let store: DeviceAuthStoreFile
    }

    private final class IdentityCoordinator {
        private var database: OpaquePointer?

        init(database: OpaquePointer) {
            self.database = database
        }

        func release() throws {
            guard let database else { return }
            self.database = nil
            var releaseError: NSError?
            if sqlite3_exec(database, "ROLLBACK", nil, nil, nil) != SQLITE_OK {
                releaseError = DeviceIdentityStore.storageError(
                    "Could not release device identity coordinator: \(String(cString: sqlite3_errmsg(database)))")
            }
            if sqlite3_close(database) != SQLITE_OK, releaseError == nil {
                releaseError = DeviceIdentityStore.storageError("Could not close device identity coordinator")
            }
            if let releaseError { throw releaseError }
        }
    }

    static func loadOrCreate(
        databaseURL: URL,
        destinationStateDirURL: URL,
        profile: GatewayDeviceIdentityProfile,
        legacySources: [DeviceIdentityPaths.LegacyIdentitySource] = [],
        beforeLegacyClaim: ((DeviceIdentityPaths.LegacyIdentitySource) throws -> Void)? = nil,
        afterLegacyCommit: (() throws -> Void)? = nil) throws
        -> DeviceIdentity
    {
        let coordinator = try self.acquireIdentityCoordinator(databaseURL: databaseURL)
        do {
            let identity = try self.loadOrCreateOwned(
                databaseURL: databaseURL,
                destinationStateDirURL: destinationStateDirURL,
                profile: profile,
                legacySources: legacySources,
                beforeLegacyClaim: beforeLegacyClaim,
                afterLegacyCommit: afterLegacyCommit)
            try coordinator.release()
            return identity
        } catch {
            do {
                try coordinator.release()
            } catch let releaseError {
                throw DeviceIdentityStore.storageError(
                    "Device identity operation failed: \(error.localizedDescription); " +
                        "coordinator release failed: \(releaseError.localizedDescription)")
            }
            throw error
        }
    }

    private static func loadOrCreateOwned(
        databaseURL: URL,
        destinationStateDirURL: URL,
        profile: GatewayDeviceIdentityProfile,
        legacySources: [DeviceIdentityPaths.LegacyIdentitySource],
        beforeLegacyClaim: ((DeviceIdentityPaths.LegacyIdentitySource) throws -> Void)?,
        afterLegacyCommit: (() throws -> Void)?) throws -> DeviceIdentity
    {
        do {
            return try self.loadOrCreateNativeState(
                databaseURL: databaseURL,
                destinationStateDirURL: destinationStateDirURL,
                profile: profile,
                legacySources: legacySources,
                beforeLegacyClaim: beforeLegacyClaim,
                afterLegacyCommit: afterLegacyCommit)
        } catch let error as OpenClawNativeStateError {
            throw DeviceIdentityStore.storageError(error.message)
        }
    }

    private static func loadOrCreateNativeState(
        databaseURL: URL,
        destinationStateDirURL: URL,
        profile: GatewayDeviceIdentityProfile,
        legacySources: [DeviceIdentityPaths.LegacyIdentitySource],
        beforeLegacyClaim: ((DeviceIdentityPaths.LegacyIdentitySource) throws -> Void)?,
        afterLegacyCommit: (() throws -> Void)?) throws -> DeviceIdentity
    {
        try self.secureDirectory(destinationStateDirURL)
        try self.secureDirectory(databaseURL.deletingLastPathComponent())
        var claims: [LegacyClaim] = []
        do {
            for source in legacySources {
                if let claim = try self.claimLegacyIdentity(source, beforeClaim: beforeLegacyClaim) {
                    claims.append(claim)
                }
            }
            return try self.loadOrCreate(
                databaseURL: databaseURL,
                destinationStateDirURL: destinationStateDirURL,
                profile: profile,
                claims: claims,
                afterLegacyCommit: afterLegacyCommit)
        } catch {
            do {
                try self.restoreClaimedLegacyIdentities(claims)
            } catch let restoreError {
                throw DeviceIdentityStore.storageError(
                    "Device identity migration failed: \(error.localizedDescription); " +
                        "native claim restoration failed: \(restoreError.localizedDescription)")
            }
            throw error
        }
    }

    private static func loadOrCreate(
        databaseURL: URL,
        destinationStateDirURL: URL,
        profile: GatewayDeviceIdentityProfile,
        claims: [LegacyClaim],
        afterLegacyCommit: (() throws -> Void)?) throws -> DeviceIdentity
    {
        try self.requireConsistentClaims(claims)
        let generatedMaterial = claims.isEmpty ? DeviceIdentityStore.generateMaterial() : nil
        let writeTimestampMs = Int64(Date().timeIntervalSince1970 * 1000)

        let database = try OpenClawNativeStateSQLite(databaseURL: databaseURL)
        let authoritative = try database.withImmediateTransaction {
            try database.ensureCanonicalTable(.deviceIdentities)
            let existing = try self.readIdentity(database, key: profile.rawValue)
            let selected: DeviceIdentityMaterial
            if let existing {
                if let migrated = claims.first?.material,
                   !self.hasSameKeyMaterial(migrated, existing)
                {
                    throw DeviceIdentityStore.storageError(
                        "Legacy device identity conflicts with SQLite identity key " +
                            "\(profile.rawValue); source preserved")
                }
                selected = existing
            } else {
                guard let candidate = claims.first?.material ?? generatedMaterial else {
                    throw DeviceIdentityStore.storageError("Device identity candidate is unavailable")
                }
                selected = candidate
                try self.insertIdentity(
                    database,
                    key: profile.rawValue,
                    material: selected,
                    updatedAtMs: writeTimestampMs)
            }

            // The row reread under the write transaction is authoritative. Never return generated
            // or migrated key material unless SQLite reports the exact canonical receipt.
            guard let authoritative = try self.readIdentity(database, key: profile.rawValue),
                  authoritative == selected
            else {
                throw DeviceIdentityStore.storageError("SQLite did not preserve the authoritative device identity")
            }
            try database.ensureCanonicalTable(.deviceIdentities, allowVersionZeroCreation: false)
            return authoritative
        }

        if !claims.isEmpty {
            try afterLegacyCommit?()
            // The committed reread is the destructive-cleanup receipt. Doctor cannot alter the
            // row while the native claim remains visible to every Node identity entry point.
            guard let committedIdentity = try self.readIdentity(database, key: profile.rawValue),
                  committedIdentity == authoritative
            else {
                throw DeviceIdentityStore.storageError(
                    "Committed SQLite identity changed before legacy cleanup; native claim preserved")
            }
            try self.relocateLegacyAuthIfNeeded(
                claims: claims,
                destinationStateDirURL: destinationStateDirURL,
                profile: profile,
                deviceId: authoritative.identity.deviceId)
            try self.removeClaimedLegacyIdentities(claims)
        }
        return authoritative.identity
    }

    private static func acquireIdentityCoordinator(databaseURL: URL) throws -> IdentityCoordinator {
        let canonicalPath = self.canonicalDatabasePath(databaseURL)
        let digest = SHA256.hash(data: Data(canonicalPath.utf8))
        let pathHash = digest.prefix(4).map { String(format: "%02x", $0) }.joined()
        let lockDirectoryURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-\(getuid())", isDirectory: true)
        try self.secureCoordinatorDirectory(lockDirectoryURL)
        let coordinatorURL = lockDirectoryURL.appendingPathComponent(
            "device-identity.\(pathHash).lock.sqlite",
            isDirectory: false)

        var database: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        let openResult = sqlite3_open_v2(coordinatorURL.path, &database, flags, nil)
        guard openResult == SQLITE_OK, let database else {
            let message = database.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown SQLite error"
            if let database { sqlite3_close(database) }
            throw DeviceIdentityStore.storageError("Could not open device identity coordinator: \(message)")
        }
        do {
            guard sqlite3_busy_timeout(database, self.busyTimeoutMilliseconds) == SQLITE_OK else {
                throw DeviceIdentityStore.storageError(
                    "Could not configure device identity coordinator timeout: " +
                        String(cString: sqlite3_errmsg(database)))
            }
            var errorMessage: UnsafeMutablePointer<CChar>?
            guard sqlite3_exec(database, "BEGIN EXCLUSIVE", nil, nil, &errorMessage) == SQLITE_OK else {
                let detail = errorMessage.map { String(cString: $0) }
                    ?? String(cString: sqlite3_errmsg(database))
                sqlite3_free(errorMessage)
                throw DeviceIdentityStore.storageError("Could not acquire device identity coordinator: \(detail)")
            }
            try self.secureFile(coordinatorURL)
            return IdentityCoordinator(database: database)
        } catch {
            sqlite3_close(database)
            throw error
        }
    }

    private static func secureCoordinatorDirectory(_ url: URL) throws {
        var info = stat()
        if lstat(url.path, &info) != 0 {
            let inspectError = errno
            guard inspectError == ENOENT else {
                throw POSIXError(POSIXErrorCode(rawValue: inspectError) ?? .EIO)
            }
            if mkdir(url.path, mode_t(0o700)) != 0, errno != EEXIST {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
            guard lstat(url.path, &info) == 0 else {
                throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            }
        }
        guard info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
              info.st_uid == geteuid()
        else {
            throw DeviceIdentityStore.storageError(
                "Device identity coordinator directory must be a user-owned real directory")
        }
        guard chmod(url.path, mode_t(0o700)) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        guard lstat(url.path, &info) == 0,
              info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
              info.st_uid == geteuid(),
              info.st_mode & mode_t(0o077) == 0
        else {
            throw DeviceIdentityStore.storageError(
                "Device identity coordinator directory permissions are not private")
        }
    }

    private static func canonicalDatabasePath(_ databaseURL: URL) -> String {
        let fileManager = FileManager.default
        let resolved = databaseURL.standardizedFileURL
        var current = resolved
        var missingSegments: [String] = []
        while !fileManager.fileExists(atPath: current.path) {
            let parent = current.deletingLastPathComponent()
            guard parent.path != current.path else { return resolved.path }
            missingSegments.insert(current.lastPathComponent, at: 0)
            current = parent
        }
        var canonical = current.resolvingSymlinksInPath().standardizedFileURL
        for segment in missingSegments {
            canonical.appendPathComponent(segment)
        }
        return canonical.standardizedFileURL.path
    }

    private static func readIdentity(
        _ database: OpenClawNativeStateSQLite,
        key: String) throws -> DeviceIdentityMaterial?
    {
        let statement = try database.prepare("""
        SELECT device_id, public_key_pem, private_key_pem, created_at_ms, updated_at_ms
        FROM device_identities
        WHERE identity_key = ?
        """)
        try statement.bindText(key, at: 1)
        let result = try statement.step()
        if result == .done { return nil }
        guard statement.valueType(at: 3) == .integer,
              statement.valueType(at: 4) == .integer,
              statement.int64(at: 4) >= 0
        else {
            throw DeviceIdentityStore.storageError("SQLite device identity timestamps must be integers")
        }
        let material = try DeviceIdentityStore.material(
            deviceId: statement.requiredText(at: 0, field: "device_id"),
            publicKeyPEM: statement.requiredText(at: 1, field: "public_key_pem"),
            privateKeyPEM: statement.requiredText(at: 2, field: "private_key_pem"),
            createdAtMs: statement.int64(at: 3))
        guard try statement.step() == .done else {
            throw DeviceIdentityStore.storageError("SQLite returned duplicate device identity keys")
        }
        return material
    }

    private static func insertIdentity(
        _ database: OpenClawNativeStateSQLite,
        key: String,
        material: DeviceIdentityMaterial,
        updatedAtMs: Int64) throws
    {
        let statement = try database.prepare("""
        INSERT INTO device_identities (
          identity_key, device_id, public_key_pem, private_key_pem, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?)
        """)
        try statement.bindText(key, at: 1)
        try statement.bindText(material.identity.deviceId, at: 2)
        try statement.bindText(material.publicKeyPEM, at: 3)
        try statement.bindText(material.privateKeyPEM, at: 4)
        try statement.bindInt64(material.identity.createdAtMs, at: 5)
        try statement.bindInt64(updatedAtMs, at: 6)
        guard try statement.step() == .done, database.changes == 1 else {
            throw DeviceIdentityStore.storageError("SQLite did not insert the device identity")
        }
    }

    private static func claimLegacyIdentity(
        _ source: DeviceIdentityPaths.LegacyIdentitySource,
        beforeClaim: ((DeviceIdentityPaths.LegacyIdentitySource) throws -> Void)?) throws -> LegacyClaim?
    {
        let doctorClaimURL = self.claimURL(source.identityURL, suffix: self.doctorClaimSuffix)
        let nativeClaimURL = self.claimURL(source.identityURL, suffix: self.nativeClaimSuffix)
        try beforeClaim?(source)

        // Doctor and native startup atomically rename the same source to distinct claims.
        // The loser observes a durable winner instead of treating an in-flight identity as absent.
        var ownsNativeClaim = false
        for _ in 0..<3 {
            if self.pathMayExist(doctorClaimURL) {
                throw DeviceIdentityStore.storageError(
                    "Device identity Doctor import is pending; run openclaw doctor --fix before starting the app")
            }
            if self.pathMayExist(nativeClaimURL) {
                guard !self.pathMayExist(source.identityURL) else {
                    throw DeviceIdentityStore.storageError(
                        "Legacy device identity source and interrupted native claim both exist")
                }
                ownsNativeClaim = true
                break
            }
            // Claims first, source last: a Doctor restore moves claim -> source atomically.
            guard self.pathMayExist(source.identityURL) else { return nil }

            let renameResult = source.identityURL.path.withCString { sourcePath in
                nativeClaimURL.path.withCString { destinationPath in
                    renamex_np(sourcePath, destinationPath, UInt32(RENAME_EXCL))
                }
            }
            if renameResult == 0 {
                ownsNativeClaim = true
                break
            }

            let renameError = errno
            guard renameError == ENOENT || renameError == EEXIST else {
                throw DeviceIdentityStore.storageError(
                    "Could not claim legacy device identity: \(String(cString: strerror(renameError)))")
            }
        }
        guard ownsNativeClaim else {
            throw DeviceIdentityStore.storageError("Legacy device identity changed while being claimed")
        }

        do {
            let before = try self.legacyFileSnapshot(
                nativeClaimURL,
                beneath: source.stateDirURL,
                maximumBytes: self.maximumLegacyIdentityBytes)
            let data = try Data(contentsOf: nativeClaimURL, options: [.mappedIfSafe])
            guard data.count <= self.maximumLegacyIdentityBytes else {
                throw DeviceIdentityStore.storageError("Legacy device identity exceeds the maximum supported size")
            }
            let after = try self.legacyFileSnapshot(
                nativeClaimURL,
                beneath: source.stateDirURL,
                maximumBytes: self.maximumLegacyIdentityBytes)
            guard before == after, UInt64(data.count) == before.size else {
                throw DeviceIdentityStore.storageError("Legacy device identity changed while being claimed")
            }
            let material = try DeviceIdentityStore.material(fromLegacyData: data)
            return LegacyClaim(
                source: source,
                identityURL: nativeClaimURL,
                data: data,
                snapshot: before,
                material: material)
        } catch {
            do {
                try self.restoreClaimedLegacyIdentity(
                    identityURL: nativeClaimURL,
                    sourceURL: source.identityURL)
            } catch let restoreError {
                throw DeviceIdentityStore.storageError(
                    "Legacy device identity validation failed: \(error.localizedDescription); " +
                        "native claim restoration failed: \(restoreError.localizedDescription)")
            }
            throw error
        }
    }

    private static func claimURL(_ sourceURL: URL, suffix: String) -> URL {
        URL(
            fileURLWithPath: sourceURL.path + suffix,
            isDirectory: false)
    }

    private static func pathMayExist(_ url: URL) -> Bool {
        let fileManager = FileManager.default
        return fileManager.fileExists(atPath: url.path)
            || (try? fileManager.destinationOfSymbolicLink(atPath: url.path)) != nil
    }

    private static func legacyFileSnapshot(
        _ url: URL,
        beneath rootURL: URL,
        maximumBytes: Int) throws -> LegacyFileSnapshot
    {
        try self.requireNoSymlinkTraversal(url, beneath: rootURL)
        let resourceValues = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey])
        guard resourceValues.isSymbolicLink != true, resourceValues.isRegularFile == true else {
            throw DeviceIdentityStore.storageError("Legacy device identity source must be a regular non-symbolic file")
        }
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular,
              let linkCount = attributes[.referenceCount] as? NSNumber,
              linkCount.uint64Value == 1,
              let device = attributes[.systemNumber] as? NSNumber,
              let inode = attributes[.systemFileNumber] as? NSNumber,
              let size = attributes[.size] as? NSNumber,
              size.uint64Value <= UInt64(maximumBytes)
        else {
            throw DeviceIdentityStore.storageError(
                "Legacy device identity source must be a bounded regular file with exactly one link")
        }
        return LegacyFileSnapshot(
            device: device.uint64Value,
            inode: inode.uint64Value,
            size: size.uint64Value,
            modifiedAt: attributes[.modificationDate] as? Date)
    }

    private static func requireNoSymlinkTraversal(_ url: URL, beneath rootURL: URL) throws {
        let root = rootURL.standardizedFileURL
        let candidate = url.standardizedFileURL
        let rootPrefix = root.path.hasSuffix("/") ? root.path : root.path + "/"
        guard candidate.path.hasPrefix(rootPrefix) else {
            throw DeviceIdentityStore.storageError("Legacy device identity path escaped its state directory")
        }
        let relativePath = String(candidate.path.dropFirst(rootPrefix.count))
        let expected = root.resolvingSymlinksInPath()
            .appendingPathComponent(relativePath, isDirectory: false)
            .standardizedFileURL
        guard candidate.resolvingSymlinksInPath().standardizedFileURL == expected else {
            throw DeviceIdentityStore.storageError("Legacy device identity path must not traverse symbolic links")
        }
    }

    private static func requireConsistentClaims(_ claims: [LegacyClaim]) throws {
        guard let first = claims.first else { return }
        guard claims.dropFirst().allSatisfy({ self.hasSameKeyMaterial($0.material, first.material) }) else {
            throw DeviceIdentityStore.storageError("Legacy device identity sources conflict; all sources preserved")
        }
    }

    private static func hasSameKeyMaterial(
        _ lhs: DeviceIdentityMaterial,
        _ rhs: DeviceIdentityMaterial) -> Bool
    {
        lhs.identity.deviceId == rhs.identity.deviceId
            && lhs.identity.publicKey == rhs.identity.publicKey
            && lhs.identity.privateKey == rhs.identity.privateKey
    }

    private static func relocateLegacyAuthIfNeeded(
        claims: [LegacyClaim],
        destinationStateDirURL: URL,
        profile: GatewayDeviceIdentityProfile,
        deviceId: String) throws
    {
        let fileManager = FileManager.default
        let destinationIdentityDirURL = destinationStateDirURL
            .appendingPathComponent("identity", isDirectory: true)
        let destinationAuthURL = destinationIdentityDirURL
            .appendingPathComponent(profile.authFileName, isDirectory: false)
        let sourceAuth = try claims.compactMap { claim -> LegacyAuthCandidate? in
            let source = claim.source
            guard source.stateDirURL.standardizedFileURL != destinationStateDirURL.standardizedFileURL,
                  fileManager.fileExists(atPath: source.authURL.path)
            else { return nil }
            return try self.readDeviceAuth(
                source.authURL,
                beneath: source.stateDirURL,
                deviceId: deviceId)
        }
        if let firstSourceAuth = sourceAuth.first,
           !sourceAuth.dropFirst().allSatisfy({ $0.store == firstSourceAuth.store })
        {
            throw DeviceIdentityStore.storageError(
                "Legacy device auth sources conflict; all identity sources preserved")
        }
        if fileManager.fileExists(atPath: destinationAuthURL.path) {
            let destinationAuth = try self.readDeviceAuth(
                destinationAuthURL,
                beneath: destinationStateDirURL,
                deviceId: deviceId)
            guard sourceAuth.allSatisfy({ $0.store == destinationAuth.store }) else {
                throw DeviceIdentityStore.storageError(
                    "Destination device auth differs from legacy auth; identity source preserved")
            }
            return
        }
        guard let selectedAuth = sourceAuth.first else { return }

        // DeviceAuthStore remains file-backed. Copy it when identity ownership moves between
        // Apple containers, but never delete or rewrite the source auth file.
        try self.secureDirectory(destinationIdentityDirURL)
        let temporaryAuthURL = destinationIdentityDirURL.appendingPathComponent(
            ".\(profile.authFileName).identity-migrating-\(UUID().uuidString)",
            isDirectory: false)
        defer { try? fileManager.removeItem(at: temporaryAuthURL) }
        try selectedAuth.data.write(to: temporaryAuthURL, options: [.atomic])
        try self.secureFile(temporaryAuthURL)

        // Publish only complete bytes, and never replace a token another process won first.
        // Foundation rejects atomic + withoutOverwriting, so use Darwin's exclusive rename.
        let renameResult = temporaryAuthURL.path.withCString { sourcePath in
            destinationAuthURL.path.withCString { destinationPath in
                renamex_np(sourcePath, destinationPath, UInt32(RENAME_EXCL))
            }
        }
        if renameResult != 0 {
            let renameError = errno
            guard renameError == EEXIST else {
                throw DeviceIdentityStore.storageError(
                    "Could not publish migrated device auth: \(String(cString: strerror(renameError)))")
            }
            let destinationAuth = try self.readDeviceAuth(
                destinationAuthURL,
                beneath: destinationStateDirURL,
                deviceId: deviceId)
            guard destinationAuth.store == selectedAuth.store else {
                throw DeviceIdentityStore.storageError(
                    "Concurrently created device auth differs from legacy auth; identity source preserved")
            }
            return
        }
        try self.secureFile(destinationAuthURL)
    }

    private static func readDeviceAuth(
        _ url: URL,
        beneath stateDirURL: URL,
        deviceId: String) throws -> LegacyAuthCandidate
    {
        let before = try self.legacyFileSnapshot(
            url,
            beneath: stateDirURL,
            maximumBytes: self.maximumLegacyAuthBytes)
        let data = try Data(contentsOf: url, options: [.mappedIfSafe])
        let after = try self.legacyFileSnapshot(
            url,
            beneath: stateDirURL,
            maximumBytes: self.maximumLegacyAuthBytes)
        guard before == after, UInt64(data.count) == before.size else {
            throw DeviceIdentityStore.storageError("Device auth changed during identity migration")
        }
        guard let decoded = try? JSONDecoder().decode(DeviceAuthStoreFile.self, from: data),
              let normalized = DeviceAuthStore.normalizedStore(decoded),
              normalized.deviceId == deviceId
        else {
            throw DeviceIdentityStore.storageError(
                "Device auth does not belong to the migrated device identity; source preserved")
        }
        return LegacyAuthCandidate(data: data, store: normalized)
    }

    private static func removeClaimedLegacyIdentities(_ claims: [LegacyClaim]) throws {
        let fileManager = FileManager.default
        for claim in claims {
            guard !self.pathMayExist(claim.source.identityURL) else {
                throw DeviceIdentityStore.storageError(
                    "Legacy device identity source reappeared during migration; native claim preserved")
            }
            guard fileManager.fileExists(atPath: claim.identityURL.path) else {
                if (try? fileManager.destinationOfSymbolicLink(atPath: claim.identityURL.path)) != nil {
                    throw DeviceIdentityStore.storageError(
                        "Legacy device identity changed to a symbolic link; source preserved")
                }
                continue
            }
            let snapshot = try self.legacyFileSnapshot(
                claim.identityURL,
                beneath: claim.source.stateDirURL,
                maximumBytes: self.maximumLegacyIdentityBytes)
            let current = try Data(contentsOf: claim.identityURL, options: [.mappedIfSafe])
            guard snapshot == claim.snapshot, current == claim.data else {
                throw DeviceIdentityStore
                    .storageError("Legacy device identity changed during migration; source preserved")
            }
        }
        for claim in claims where fileManager.fileExists(atPath: claim.identityURL.path) {
            try fileManager.removeItem(at: claim.identityURL)
        }
    }

    private static func restoreClaimedLegacyIdentities(_ claims: [LegacyClaim]) throws {
        var restorationErrors: [String] = []
        for claim in claims.reversed() {
            do {
                try self.restoreClaimedLegacyIdentity(
                    identityURL: claim.identityURL,
                    sourceURL: claim.source.identityURL)
            } catch {
                restorationErrors.append("\(claim.source.identityURL.path): \(error.localizedDescription)")
            }
        }
        if !restorationErrors.isEmpty {
            throw DeviceIdentityStore.storageError(
                "Could not restore every native device identity claim: " +
                    restorationErrors.joined(separator: "; "))
        }
    }

    private static func restoreClaimedLegacyIdentity(identityURL: URL, sourceURL: URL) throws {
        guard self.pathMayExist(identityURL) else { return }
        let renameResult = identityURL.path.withCString { claimedPath in
            sourceURL.path.withCString { destinationPath in
                renamex_np(claimedPath, destinationPath, UInt32(RENAME_EXCL))
            }
        }
        guard renameResult == 0 else {
            let renameError = errno
            if renameError == ENOENT, !self.pathMayExist(identityURL) {
                return
            }
            throw DeviceIdentityStore.storageError(
                "Could not restore legacy device identity: \(String(cString: strerror(renameError)))")
        }
    }
}

extension DeviceIdentitySQLiteStore {
    private static func secureDirectory(_ url: URL) throws {
        let fileManager = FileManager.default
        try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
        var attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o700]
        #if os(iOS) || os(watchOS)
        attributes[.protectionKey] = FileProtectionType.completeUntilFirstUserAuthentication
        #endif
        try fileManager.setAttributes(attributes, ofItemAtPath: url.path)
    }

    private static func secureFile(_ url: URL) throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        var attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o600]
        #if os(iOS) || os(watchOS)
        attributes[.protectionKey] = FileProtectionType.completeUntilFirstUserAuthentication
        #endif
        try FileManager.default.setAttributes(attributes, ofItemAtPath: url.path)
    }
}
