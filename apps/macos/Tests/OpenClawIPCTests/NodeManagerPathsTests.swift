import Foundation
import Testing
@testable import OpenClaw

struct NodeManagerPathsTests {
    @Test func `fnm node bins prefer the newest supported installed version`() throws {
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }

        let v24Node = home
            .appendingPathComponent(".local/share/fnm/node-versions/v24.16.0/installation/bin/node")
        let v26Node = home
            .appendingPathComponent(".local/share/fnm/node-versions/v26.1.0/installation/bin/node")
        try makeExecutableForTests(at: v24Node)
        try makeExecutableForTests(at: v26Node)

        let paths = CommandResolver.preferredPaths(home: home, current: [], projectRoot: home)
        let newestIndex = try #require(paths.firstIndex(of: v26Node.deletingLastPathComponent().path))
        let olderIndex = try #require(paths.firstIndex(of: v24Node.deletingLastPathComponent().path))

        #expect(newestIndex < olderIndex)
    }

    @Test(arguments: [
        (".local/share/fnm/node-versions", "installation/bin"),
        (".nvm/versions/node", "bin"),
    ])
    func `unsupported newer manager runtimes cannot hide a supported installed Node`(
        managerRoot: String,
        binarySuffix: String) async throws
    {
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let versions = ["v26.0.0", "v24.16.0", "v25.9.0", "v22.23.2"]

        for version in versions {
            let node = home
                .appendingPathComponent(managerRoot)
                .appendingPathComponent(version)
                .appendingPathComponent(binarySuffix)
                .appendingPathComponent("node")
            try makeExecutableForTests(at: node)
            try "#!/bin/sh\necho \(version)\n".write(to: node, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
        }

        let unsupported = home
            .appendingPathComponent(managerRoot)
            .appendingPathComponent("v26.0.0")
            .appendingPathComponent(binarySuffix)
        let expectedNode = home
            .appendingPathComponent(managerRoot)
            .appendingPathComponent("v24.16.0")
            .appendingPathComponent(binarySuffix)
            .appendingPathComponent("node")
        let searchPaths = CommandResolver.preferredPaths(
            home: home,
            current: [unsupported.path],
            projectRoot: home)

        let result = await RuntimeLocator.resolve(searchPaths: searchPaths)

        guard case let .success(runtime) = result else {
            Issue.record("A newer unsupported manager runtime hid an installed supported Node: \(result)")
            return
        }
        #expect(runtime.path == expectedNode.path)
        #expect(runtime.version == RuntimeVersion(major: 24, minor: 16, patch: 0))
    }

    @Test func `ignores entries without node executable`() throws {
        let home = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: home) }
        let missingNodeBin = home
            .appendingPathComponent(".local/share/fnm/node-versions/v99.0.0/installation/bin")
        try FileManager().createDirectory(at: missingNodeBin, withIntermediateDirectories: true)

        let paths = CommandResolver.preferredPaths(home: home, current: [], projectRoot: home)
        #expect(!paths.contains(missingNodeBin.path))
    }
}
