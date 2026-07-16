import Foundation
import Testing
@testable import OpenClaw

struct RuntimeLocatorTests {
    private func makeTempExecutable(contents: String) throws -> URL {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager().createDirectory(at: dir, withIntermediateDirectories: true)
        let path = dir.appendingPathComponent("node")
        try contents.write(to: path, atomically: true, encoding: .utf8)
        try FileManager().setAttributes([.posixPermissions: 0o755], ofItemAtPath: path.path)
        return path
    }

    @Test func `resolve succeeds with valid node`() throws {
        let script = """
        #!/bin/sh
        echo v22.22.3
        """
        let node = try self.makeTempExecutable(contents: script)
        let result = RuntimeLocator.resolve(searchPaths: [node.deletingLastPathComponent().path])
        guard case let .success(res) = result else {
            Issue.record("Expected success, got \(result)")
            return
        }
        #expect(res.path == node.path)
        #expect(res.version == RuntimeVersion(major: 22, minor: 22, patch: 3))
    }

    @Test func `resolve fails on boundary below minimum`() throws {
        let script = """
        #!/bin/sh
        echo v22.22.2
        """
        let node = try self.makeTempExecutable(contents: script)
        let result = RuntimeLocator.resolve(searchPaths: [node.deletingLastPathComponent().path])
        guard case let .failure(.unsupported(_, found, path, _)) = result else {
            Issue.record("Expected unsupported error, got \(result)")
            return
        }
        #expect(found == RuntimeVersion(major: 22, minor: 22, patch: 2))
        #expect(path == node.path)
    }

    @Test func `resolve rejects node 23`() throws {
        let script = """
        #!/bin/sh
        echo v23.11.0
        """
        let node = try self.makeTempExecutable(contents: script)
        let result = RuntimeLocator.resolve(searchPaths: [node.deletingLastPathComponent().path])
        guard case let .failure(.unsupported(_, found, path, _)) = result else {
            Issue.record("Expected unsupported error, got \(result)")
            return
        }
        #expect(found == RuntimeVersion(major: 23, minor: 11, patch: 0))
        #expect(path == node.path)
    }

    @Test(arguments: [
        ("22.22.2", false),
        ("22.22.3", true),
        ("23.11.0", false),
        ("24.14.1", false),
        ("24.15.0", true),
        ("25.8.1", false),
        ("25.9.0", true),
        ("26.0.0", true),
    ])
    func `node support matches the core runtime contract`(version: String, supported: Bool) throws {
        let parsed = try #require(RuntimeVersion.from(string: version))
        #expect(RuntimeLocator.isSupportedNodeVersion(parsed) == supported)
    }

    @Test func `resolve fails when too old`() throws {
        let script = """
        #!/bin/sh
        echo v18.2.0
        """
        let node = try self.makeTempExecutable(contents: script)
        let result = RuntimeLocator.resolve(searchPaths: [node.deletingLastPathComponent().path])
        guard case let .failure(.unsupported(_, found, path, _)) = result else {
            Issue.record("Expected unsupported error, got \(result)")
            return
        }
        #expect(found == RuntimeVersion(major: 18, minor: 2, patch: 0))
        #expect(path == node.path)
    }

    @Test func `resolve fails when version unparsable`() throws {
        let script = """
        #!/bin/sh
        echo node-version:unknown
        """
        let node = try self.makeTempExecutable(contents: script)
        let result = RuntimeLocator.resolve(searchPaths: [node.deletingLastPathComponent().path])
        guard case let .failure(.versionParse(_, raw, path, _)) = result else {
            Issue.record("Expected versionParse error, got \(result)")
            return
        }
        #expect(raw.contains("unknown"))
        #expect(path == node.path)
    }

    @Test func `describe failure includes paths`() {
        let msg = RuntimeLocator.describeFailure(.notFound(searchPaths: ["/tmp/a", "/tmp/b"]))
        #expect(msg.contains("Node >=22.22.3 <23, >=24.15.0 <25, or >=25.9.0"))
        #expect(msg.contains("PATH searched: /tmp/a:/tmp/b"))

        let parseMsg = RuntimeLocator.describeFailure(
            .versionParse(
                kind: .node,
                raw: "garbage",
                path: "/usr/local/bin/node",
                searchPaths: ["/usr/local/bin"]))
        #expect(parseMsg.contains("Node >=22.22.3 <23, >=24.15.0 <25, or >=25.9.0"))
    }

    @Test func `runtime version parses with leading V and metadata`() {
        #expect(RuntimeVersion.from(string: "v22.1.3") == RuntimeVersion(major: 22, minor: 1, patch: 3))
        #expect(RuntimeVersion.from(string: "node 22.3.0-alpha.1") == RuntimeVersion(major: 22, minor: 3, patch: 0))
        #expect(RuntimeVersion.from(string: "bogus") == nil)
    }
}
