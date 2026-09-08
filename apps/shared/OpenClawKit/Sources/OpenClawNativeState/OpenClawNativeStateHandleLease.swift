import CryptoKit
import Darwin
import Foundation
import SQLite3
#if canImport(Security)
import Security
#endif

/// Same data-free shared lock as the Node state owner. No source file is opened here.
final class OpenClawNativeStateHandleLease {
    private let database: OpaquePointer

    static func runtimeDirectory(for databaseURL: URL) -> URL {
        #if os(macOS) && canImport(Security)
        let sandboxed: Bool = if let task = SecTaskCreateFromSelf(nil) {
            (SecTaskCopyValueForEntitlement(task, "com.apple.security.app-sandbox" as CFString, nil)
                as? Bool) == true
        } else {
            ProcessInfo.processInfo.environment["APP_SANDBOX_CONTAINER_ID"] != nil
        }
        if !sandboxed {
            return URL(fileURLWithPath: "/tmp", isDirectory: true)
        }
        #endif
        // Sandboxed profiles cannot share CLI state. Match the existing native
        // identity owner's profile-local runtime directory for canonical state.
        var stateRoot = databaseURL.deletingLastPathComponent()
        if stateRoot.lastPathComponent == "state" {
            stateRoot.deleteLastPathComponent()
        }
        return stateRoot.appendingPathComponent("tmp", isDirectory: true)
    }

    static func coordinatorURL(databaseURL: URL, runtimeDirectory: URL, uid: uid_t) throws -> URL {
        let canonicalDatabase = try self.canonicalExistingAncestorPath(databaseURL)
        let digest = SHA256.hash(data: Data(canonicalDatabase.utf8))
        let hash = digest.prefix(4).map { String(format: "%02x", $0) }.joined()
        return try URL(fileURLWithPath: self.canonicalExistingAncestorPath(runtimeDirectory), isDirectory: true)
            .appendingPathComponent("openclaw-state-locks-\(uid)", isDirectory: true)
            .appendingPathComponent("state-handles.\(hash).lock.sqlite", isDirectory: false)
    }

    init(databaseURL: URL) throws {
        let coordinator = try Self.coordinatorURL(
            databaseURL: databaseURL,
            runtimeDirectory: Self.runtimeDirectory(for: databaseURL),
            uid: getuid())
        try Self.secureCoordinatorDirectory(coordinator.deletingLastPathComponent())
        var opened: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        let result = sqlite3_open_v2(coordinator.path, &opened, flags, nil)
        guard result == SQLITE_OK, let opened else {
            if let opened { sqlite3_close(opened) }
            throw OpenClawNativeStateError("Could not open state-handles coordinator")
        }
        var acquired = false
        defer {
            if !acquired {
                sqlite3_exec(opened, "ROLLBACK", nil, nil, nil)
                sqlite3_close(opened)
            }
        }
        // Read ownership allows multiple native/Node handles, but excludes file
        // publication. Never wait while another lifecycle owner is held.
        guard sqlite3_exec(
            opened,
            "PRAGMA busy_timeout=0; PRAGMA journal_mode=MEMORY; BEGIN; SELECT rootpage FROM sqlite_schema LIMIT 1;",
            nil,
            nil,
            nil) == SQLITE_OK
        else {
            throw OpenClawNativeStateError(
                "Could not acquire state-handles coordinator: \(String(cString: sqlite3_errmsg(opened)))")
        }
        self.database = opened
        acquired = true
    }

    deinit {
        sqlite3_exec(self.database, "ROLLBACK", nil, nil, nil)
        sqlite3_close(self.database)
    }

    private static func canonicalExistingAncestorPath(_ url: URL) throws -> String {
        var current = url.standardizedFileURL
        var missing: [String] = []
        while !FileManager.default.fileExists(atPath: current.path) {
            let parent = current.deletingLastPathComponent()
            if parent.path == current.path { break }
            missing.append(current.lastPathComponent)
            current = parent
        }
        // Foundation standardization can hide /private on macOS. The lock key
        // must match Node realpath, including when the source does not exist yet.
        guard let resolved = realpath(current.path, nil) else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        defer { free(resolved) }
        var canonical = String(cString: resolved)
        for component in missing.reversed() {
            canonical += canonical == "/" ? component : "/" + component
        }
        return canonical
    }

    private static func secureCoordinatorDirectory(_ url: URL) throws {
        var info = stat()
        if lstat(url.path, &info) != 0 {
            guard errno == ENOENT else { throw POSIXError(.EIO) }
            try FileManager.default.createDirectory(
                at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            guard lstat(url.path, &info) == 0 else { throw POSIXError(.EIO) }
        }
        guard info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR), info.st_uid == geteuid() else {
            throw OpenClawNativeStateError("State-handle coordinator directory must be a user-owned real directory")
        }
        if info.st_mode & mode_t(0o7777) != mode_t(0o700) {
            guard chmod(url.path, mode_t(0o700)) == 0 else { throw POSIXError(.EACCES) }
        }
        guard lstat(url.path, &info) == 0,
              info.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
              info.st_uid == geteuid(), info.st_mode & mode_t(0o077) == 0
        else {
            throw OpenClawNativeStateError("State-handle coordinator directory permissions are not private")
        }
    }
}
