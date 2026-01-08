import Foundation
import Testing
@testable import Clawdbot

@Suite struct NodeManagerPathsTests {
    private func makeTempDir() throws -> URL {
        let base = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        let dir = base.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private func makeExec(at path: URL) throws {
        try FileManager.default.createDirectory(
            at: path.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: path.path, contents: Data("echo ok\n".utf8))
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path.path)
    }

    @Test func fnmNodeBinsPreferNewestInstalledVersion() throws {
        let home = try self.makeTempDir()

        let v20Bin = home
            .appendingPathComponent(".local/share/fnm/node-versions/v20.19.5/installation/bin/node")
        let v25Bin = home
            .appendingPathComponent(".local/share/fnm/node-versions/v25.1.0/installation/bin/node")
        try self.makeExec(at: v20Bin)
        try self.makeExec(at: v25Bin)

        let bins = CommandResolver._testNodeManagerBinPaths(home: home)
        #expect(bins.first == v25Bin.deletingLastPathComponent().path)
        #expect(bins.contains(v20Bin.deletingLastPathComponent().path))
    }

    @Test func ignoresEntriesWithoutNodeExecutable() throws {
        let home = try self.makeTempDir()
        let missingNodeBin = home
            .appendingPathComponent(".local/share/fnm/node-versions/v99.0.0/installation/bin")
        try FileManager.default.createDirectory(at: missingNodeBin, withIntermediateDirectories: true)

        let bins = CommandResolver._testNodeManagerBinPaths(home: home)
        #expect(!bins.contains(missingNodeBin.path))
    }
}
