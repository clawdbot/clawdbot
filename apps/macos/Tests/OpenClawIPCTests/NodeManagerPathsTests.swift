import Foundation
import Testing
@testable import OpenClaw

struct NodeManagerPathsTests {
    @Test func `fnm node bins prefer newest installed version`() throws {
        let home = try makeTempDirForTests()

        let v20Bin = home
            .appendingPathComponent(".local/share/fnm/node-versions/v20.19.5/installation/bin/node")
        let v25Bin = home
            .appendingPathComponent(".local/share/fnm/node-versions/v25.1.0/installation/bin/node")
        try makeExecutableForTests(at: v20Bin)
        try makeExecutableForTests(at: v25Bin)

        let bins = CommandResolver._testNodeManagerBinPaths(home: home)
        #expect(bins.first == v25Bin.deletingLastPathComponent().path)
        #expect(bins.contains(v20Bin.deletingLastPathComponent().path))
    }

    @Test func `ignores entries without node executable`() throws {
        let home = try makeTempDirForTests()
        let missingNodeBin = home
            .appendingPathComponent(".local/share/fnm/node-versions/v99.0.0/installation/bin")
        try FileManager().createDirectory(at: missingNodeBin, withIntermediateDirectories: true)

        let bins = CommandResolver._testNodeManagerBinPaths(home: home)
        #expect(!bins.contains(missingNodeBin.path))
    }
}
