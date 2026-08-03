import Darwin
import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct ExecApprovalsSocketPathGuardTests {
    private static func canonicalPath(_ url: URL) throws -> String {
        guard let resolved = realpath(url.path, nil) else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        defer { free(resolved) }
        return String(cString: resolved)
    }

    @Test
    func `ancestor safety requires root or current owner`() {
        #expect(ExecApprovalsSocketPathGuard.ancestorDirectoryIsSafe(
            owner: 0,
            permissions: 0o755,
            expectedOwner: 501))
        #expect(ExecApprovalsSocketPathGuard.ancestorDirectoryIsSafe(
            owner: 501,
            permissions: 0o700,
            expectedOwner: 501))
        #expect(!ExecApprovalsSocketPathGuard.ancestorDirectoryIsSafe(
            owner: 502,
            permissions: 0o755,
            expectedOwner: 501))
        #expect(ExecApprovalsSocketPathGuard.ancestorDirectoryIsSafe(
            owner: 0,
            permissions: 0o1777,
            expectedOwner: 501))
        #expect(!ExecApprovalsSocketPathGuard.ancestorDirectoryIsSafe(
            owner: 0,
            permissions: 0o777,
            expectedOwner: 501))
        #expect(ExecApprovalsSocketPathGuard.symlinkOwnerIsSafe(
            owner: 0,
            expectedOwner: 501))
        #expect(ExecApprovalsSocketPathGuard.symlinkOwnerIsSafe(
            owner: 501,
            expectedOwner: 501))
        #expect(!ExecApprovalsSocketPathGuard.symlinkOwnerIsSafe(
            owner: 502,
            expectedOwner: 501))
    }

    @Test
    func `harden parent rejects parent traversal before normalization`() throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-socket-traversal-\(UUID().uuidString)", isDirectory: true)
        let socketPath = "\(root.path)/missing/../escape/approvals.sock"

        do {
            try ExecApprovalsSocketPathGuard.hardenParentDirectory(for: socketPath)
            Issue.record("Expected dot path traversal rejection")
        } catch let error as ExecApprovalsSocketPathGuardError {
            guard case let .parentPathInvalid(path, kind) = error else {
                Issue.record("Unexpected error: \(error)")
                return
            }
            #expect(path == socketPath)
            #expect(kind == .other)
        }
        #expect(!FileManager().fileExists(atPath: root.path))
    }

    @Test
    func `harden parent accepts current directory components`() throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-socket-dot-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        try FileManager().createDirectory(at: root, withIntermediateDirectories: true)

        try ExecApprovalsSocketPathGuard.hardenParentDirectory(
            for: "\(root.path)/./approvals.sock")
    }

    @Test
    func `harden parent validates directories hidden behind nested symlinks`() throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-socket-nested-link-\(UUID().uuidString)", isDirectory: true)
        let victim = root.appendingPathComponent("victim", isDirectory: true)
        let unsafe = root.appendingPathComponent("unsafe", isDirectory: true)
        let redirect = unsafe.appendingPathComponent("redirect", isDirectory: true)
        let outer = root.appendingPathComponent("outer", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        try FileManager().createDirectory(at: victim, withIntermediateDirectories: true)
        try FileManager().createDirectory(at: unsafe, withIntermediateDirectories: true)
        try FileManager().setAttributes([.posixPermissions: 0o777], ofItemAtPath: unsafe.path)
        try FileManager().createSymbolicLink(at: redirect, withDestinationURL: victim)
        try FileManager().createSymbolicLink(at: outer, withDestinationURL: redirect)

        do {
            try ExecApprovalsSocketPathGuard.hardenParentDirectory(
                for: outer.appendingPathComponent("approvals.sock").path)
            Issue.record("Expected hidden unsafe directory rejection")
        } catch let error as ExecApprovalsSocketPathGuardError {
            guard case let .parentPermissionsUnsafe(path, _) = error else {
                Issue.record("Unexpected error: \(error)")
                return
            }
            let expectedPath = try Self.canonicalPath(unsafe)
            #expect(path == expectedPath)
        }
    }

    @Test
    func `harden parent rejects mutating extended ACL`() throws {
        let parent = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-socket-acl-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: parent) }
        try FileManager().createDirectory(at: parent, withIntermediateDirectories: true)
        try FileManager().setAttributes([.posixPermissions: 0o700], ofItemAtPath: parent.path)

        let chmod = Process()
        chmod.executableURL = URL(fileURLWithPath: "/bin/chmod")
        chmod.arguments = ["+a", "group:everyone allow add_file,delete_child", parent.path]
        try chmod.run()
        chmod.waitUntilExit()
        #expect(chmod.terminationStatus == 0)

        do {
            try ExecApprovalsSocketPathGuard.hardenParentDirectory(
                for: parent.appendingPathComponent("approvals.sock").path)
            Issue.record("Expected mutating ACL rejection")
        } catch let error as ExecApprovalsSocketPathGuardError {
            guard case let .parentACLUnsafe(path) = error else {
                Issue.record("Unexpected error: \(error)")
                return
            }
            let expectedPath = try Self.canonicalPath(parent)
            #expect(path == expectedPath)
        }
    }

    @Test
    func `harden parent accepts mutating ACL for current user`() throws {
        let parent = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-socket-owner-acl-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: parent) }
        try FileManager().createDirectory(at: parent, withIntermediateDirectories: true)
        try FileManager().setAttributes([.posixPermissions: 0o700], ofItemAtPath: parent.path)

        let chmod = Process()
        chmod.executableURL = URL(fileURLWithPath: "/bin/chmod")
        chmod.arguments = [
            "+a",
            "user:\(NSUserName()) allow add_file,delete_child",
            parent.path,
        ]
        try chmod.run()
        chmod.waitUntilExit()
        #expect(chmod.terminationStatus == 0)

        try ExecApprovalsSocketPathGuard.hardenParentDirectory(
            for: parent.appendingPathComponent("approvals.sock").path)
    }

    @Test
    func `socket path resolves under the configured state directory`() async throws {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-socket-guard-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: stateDir) }

        // String-level assertion only. The isolation lock serializes env
        // mutation but not env consumption: concurrent suites that resolve
        // OPENCLAW_STATE_DIR mid-window would create this directory and the
        // old filesystem assertions here flaked on their 0755 default
        // (#104019). Creation-with-0700 is covered by the explicit-path
        // tests in this suite.
        await TestIsolation.withEnvValues(["OPENCLAW_STATE_DIR": stateDir.path]) {
            let socketPath = ExecApprovalsStore.socketPath()
            #expect(socketPath == stateDir.appendingPathComponent("exec-approvals.sock").path)
        }
    }

    @Test
    func `harden canonical parent directory creates it with 0700 permissions`() throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-socket-guard-\(UUID().uuidString)", isDirectory: true)
        let stateDir = root.appendingPathComponent("state", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }

        try ExecApprovalsSocketPathGuard.hardenParentDirectory(
            for: stateDir.appendingPathComponent("exec-approvals.sock").path)

        let attrs = try FileManager().attributesOfItem(atPath: stateDir.path)
        let permissions = (attrs[.posixPermissions] as? NSNumber)?.intValue ?? -1
        #expect(permissions & 0o777 == 0o700)
    }

    @Test
    func `harden custom socket parent creates nested private directories`() throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-custom-socket-\(UUID().uuidString)", isDirectory: true)
        let parent = root.appendingPathComponent("nested/private", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }

        try ExecApprovalsSocketPathGuard.hardenParentDirectory(
            for: parent.appendingPathComponent("approvals.sock").path)

        let attrs = try FileManager().attributesOfItem(atPath: parent.path)
        let permissions = (attrs[.posixPermissions] as? NSNumber)?.intValue ?? -1
        #expect(permissions & 0o777 == 0o700)
    }

    @Test
    func `harden existing custom parent does not change permissions`() throws {
        let parent = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-existing-socket-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: parent) }
        try FileManager().createDirectory(at: parent, withIntermediateDirectories: true)
        try FileManager().setAttributes([.posixPermissions: 0o755], ofItemAtPath: parent.path)

        try ExecApprovalsSocketPathGuard.hardenParentDirectory(
            for: parent.appendingPathComponent("approvals.sock").path)

        let attrs = try FileManager().attributesOfItem(atPath: parent.path)
        let permissions = (attrs[.posixPermissions] as? NSNumber)?.intValue ?? -1
        #expect(permissions & 0o777 == 0o755)
    }

    @Test
    func `harden existing private parent rejects unsafe ancestor`() throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-unsafe-socket-\(UUID().uuidString)", isDirectory: true)
        let parent = root.appendingPathComponent("private", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        try FileManager().createDirectory(at: parent, withIntermediateDirectories: true)
        try FileManager().setAttributes([.posixPermissions: 0o777], ofItemAtPath: root.path)
        try FileManager().setAttributes([.posixPermissions: 0o700], ofItemAtPath: parent.path)

        do {
            try ExecApprovalsSocketPathGuard.hardenParentDirectory(
                for: parent.appendingPathComponent("approvals.sock").path)
            Issue.record("Expected unsafe ancestor rejection")
        } catch let error as ExecApprovalsSocketPathGuardError {
            guard case let .parentPermissionsUnsafe(path, _) = error else {
                Issue.record("Unexpected error: \(error)")
                return
            }
            let expectedPath = try Self.canonicalPath(root)
            #expect(path == expectedPath)
        }
    }

    @Test
    func `harden parent directory rejects shared tmp without chmod`() throws {
        let sharedTmp = "/private/tmp"
        let before = try FileManager().attributesOfItem(atPath: sharedTmp)
        let beforePermissions = (before[.posixPermissions] as? NSNumber)?.intValue ?? -1
        let socketPath = "\(sharedTmp)/openclaw-exec-approvals-\(UUID().uuidString).sock"

        do {
            try ExecApprovalsSocketPathGuard.hardenParentDirectory(for: socketPath)
            Issue.record("Expected shared tmp parent rejection")
        } catch let error as ExecApprovalsSocketPathGuardError {
            switch error {
            case .parentOwnerInvalid, .parentPermissionsUnsafe:
                break
            default:
                Issue.record("Unexpected error: \(error)")
            }
        }

        let after = try FileManager().attributesOfItem(atPath: sharedTmp)
        let afterPermissions = (after[.posixPermissions] as? NSNumber)?.intValue ?? -1
        #expect(afterPermissions == beforePermissions)
    }

    @Test
    func `socket lease blocks replacement until current owner releases`() async throws {
        let root = URL(fileURLWithPath: "/tmp", isDirectory: true)
            .appendingPathComponent("ocsl-\(UUID().uuidString.prefix(12))", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        try FileManager().createDirectory(
            at: root,
            withIntermediateDirectories: false,
            attributes: [.posixPermissions: 0o700])
        let socketPath = root.appendingPathComponent("exec-approvals.sock").path
        #expect(socketPath.utf8.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path))

        let result = await ExecApprovalsPromptServer._testSocketLeaseHandoff(socketPath: socketPath)

        #expect(result.replacementBlockedWhileOwned)
        #expect(result.replacementStartedAfterRelease)
        #expect(result.replacementHasDistinctIdentity)
        #expect(result.replacementPreserved)
    }

    @Test
    func `remove existing socket rejects symlink path`() throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-socket-guard-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        try FileManager().createDirectory(at: root, withIntermediateDirectories: true)

        let target = root.appendingPathComponent("target.txt")
        _ = FileManager().createFile(atPath: target.path, contents: Data("x".utf8))
        let symlink = root.appendingPathComponent("exec-approvals.sock")
        try FileManager().createSymbolicLink(at: symlink, withDestinationURL: target)

        do {
            try ExecApprovalsSocketPathGuard.removeExistingSocket(at: symlink.path)
            Issue.record("Expected symlink socket path rejection")
        } catch let error as ExecApprovalsSocketPathGuardError {
            switch error {
            case let .socketPathInvalid(path, kind):
                #expect(path == symlink.path)
                #expect(kind == .symlink)
            default:
                Issue.record("Unexpected error: \(error)")
            }
        }
    }

    @Test
    func `remove existing socket rejects regular file path`() throws {
        let root = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-socket-guard-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager().removeItem(at: root) }
        try FileManager().createDirectory(at: root, withIntermediateDirectories: true)

        let regularFile = root.appendingPathComponent("exec-approvals.sock")
        _ = FileManager().createFile(atPath: regularFile.path, contents: Data("x".utf8))

        do {
            try ExecApprovalsSocketPathGuard.removeExistingSocket(at: regularFile.path)
            Issue.record("Expected non-socket path rejection")
        } catch let error as ExecApprovalsSocketPathGuardError {
            switch error {
            case let .socketPathInvalid(path, kind):
                #expect(path == regularFile.path)
                #expect(kind == .other)
            default:
                Issue.record("Unexpected error: \(error)")
            }
        }
    }
}
