import Darwin
import Foundation
import Testing
@testable import OpenClaw

struct ExecHostCwdTests {
    @Test(.execApprovalsStateIsolated, arguments: ["/tmp", "/private/tmp"])
    func `native full execution uses the physical temporary directory`(cwd: String) async throws {
        var snapshot = ExecApprovalsStore.readSnapshot()
        snapshot.file.defaults = ExecApprovalsDefaults(security: .full, ask: .off)
        guard case .saved = ExecApprovalsStore.saveFile(snapshot.file, ifBaseHash: snapshot.hash) else {
            Issue.record("Could not seed the test-owned exec policy")
            return
        }
        let response = await ExecHostExecutor.handle(ExecHostRequest(
            command: ["/bin/pwd", "-P"],
            cwd: cwd,
            timeoutMs: 2000))
        #expect(response.ok)
        #expect(response.payload?.success == true)
        #expect(response.payload?.stdout == "/private/tmp\n")

        let cwdSnapshot = try #require(ExecCommandResolution.captureApprovalCwdSnapshot(cwd))
        #expect(cwdSnapshot.path == "/private/tmp")
        #expect(ExecCommandResolution.revalidateApprovalCwdSnapshot(cwdSnapshot))
        let patterns = ExecCommandResolution.resolveAllowAlwaysPatterns(
            command: ["/bin/pwd", "-P"], cwd: cwd, env: nil)
        let resolution = try #require(ExecCommandResolution.resolve(
            command: ["/bin/pwd", "-P"], cwd: cwdSnapshot.path, env: nil))
        let pattern = try #require(patterns.first)
        #expect(ExecAllowlistMatcher.match(
            entries: [ExecAllowlistEntry(pattern: pattern.pattern, argPattern: pattern.argPattern)],
            resolution: resolution) != nil)
    }

    @Test(.execApprovalsStateIsolated) func `native missing cwd reports a directory error without requesting approval`() async {
        let cwd = "/tmp/openclaw-missing-cwd-\(UUID().uuidString)"
        let response = await ExecHostExecutor.handle(ExecHostRequest(
            command: ["/bin/pwd"], cwd: cwd, timeoutMs: 2000))
        #expect(!response.ok)
        #expect(response.error?.reason == "cwd-unavailable")
        #expect(response.error?.message == "Working directory does not exist, is inaccessible, or is not a directory.")
        #expect(ExecCommandResolution.captureApprovalCwdSnapshot(cwd) == nil)
    }

    @Test func `cwd snapshot refuses files symlink loops and inaccessible paths`() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("openclaw-cwd-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let file = root.appendingPathComponent("file")
        try Data().write(to: file)
        #expect(ExecCommandResolution.captureApprovalCwdSnapshot(file.path) == nil)
        let loop = root.appendingPathComponent("loop")
        try FileManager.default.createSymbolicLink(atPath: loop.path, withDestinationPath: loop.path)
        #expect(ExecCommandResolution.captureApprovalCwdSnapshot(loop.path) == nil)
        #expect(ExecCommandResolution.captureApprovalCwdSnapshot("/tmp\0/ignored") == nil)
        let inaccessible = root.appendingPathComponent("locked")
        let child = inaccessible.appendingPathComponent("child")
        try FileManager.default.createDirectory(at: child, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: inaccessible.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: inaccessible.path) }
        #expect(ExecCommandResolution.captureApprovalCwdSnapshot(child.path) == nil)
    }
}
