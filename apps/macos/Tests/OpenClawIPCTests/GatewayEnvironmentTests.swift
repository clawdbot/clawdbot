import Foundation
import Testing
@testable import OpenClaw

struct GatewayEnvironmentTests {
    private final class LockedCounter: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0

        func increment() {
            self.lock.withLock {
                self.count += 1
            }
        }

        func value() -> Int {
            self.lock.withLock { self.count }
        }
    }

    @Test func `semver parses common forms`() {
        #expect(Semver.parse("1.2.3") == Semver(major: 1, minor: 2, patch: 3))
        #expect(Semver.parse("  v1.2.3  \n") == Semver(major: 1, minor: 2, patch: 3))
        #expect(Semver.parse("v2.0.0") == Semver(major: 2, minor: 0, patch: 0))
        #expect(Semver.parse("3.4.5-beta.1") == Semver(major: 3, minor: 4, patch: 5)) // prerelease suffix stripped
        #expect(Semver.parse("2026.1.11-4") == Semver(major: 2026, minor: 1, patch: 11)) // build suffix stripped
        #expect(Semver.parse("1.0.5+build.123") == Semver(major: 1, minor: 0, patch: 5)) // metadata suffix stripped
        #expect(Semver.parse("v1.2.3+build.9") == Semver(major: 1, minor: 2, patch: 3))
        #expect(Semver.parse("1.2.3+build.123") == Semver(major: 1, minor: 2, patch: 3))
        #expect(Semver.parse("1.2.3-rc.1+build.7") == Semver(major: 1, minor: 2, patch: 3))
        #expect(Semver.parse("v1.2.3-rc.1") == Semver(major: 1, minor: 2, patch: 3))
        #expect(Semver.parse("1.2.0") == Semver(major: 1, minor: 2, patch: 0))
        #expect(Semver.parse(nil) == nil)
        #expect(Semver.parse("invalid") == nil)
        #expect(Semver.parse("1.2") == nil)
        #expect(Semver.parse("1.2.x") == nil)
        // Product-prefixed output from `openclaw --version` should NOT parse as semver
        // (the prefix must be stripped by the caller, not the parser).
        #expect(Semver.parse("OpenClaw 2026.3.23-1") == nil)
    }

    @Test func `gateway version output strips product prefix before parsing`() {
        let normalized = GatewayEnvironment.normalizeGatewayVersionOutput("  OpenClaw 2026.3.23-1 \n")
        #expect(normalized == "2026.3.23-1")
        #expect(Semver.parse(normalized) == Semver(major: 2026, minor: 3, patch: 23))
    }

    @Test func `gateway version output strips trailing commit hash`() {
        let normalized = GatewayEnvironment.normalizeGatewayVersionOutput("OpenClaw 2026.4.2 (d74a122)")
        #expect(normalized == "2026.4.2")
        #expect(Semver.parse(normalized) == Semver(major: 2026, minor: 4, patch: 2))

        // Pre-release suffix + commit hash combined
        let normalized2 = GatewayEnvironment.normalizeGatewayVersionOutput("OpenClaw 2026.4.2-1 (d74a122)")
        #expect(normalized2 == "2026.4.2-1")
        #expect(Semver.parse(normalized2) == Semver(major: 2026, minor: 4, patch: 2))
    }

    @Test func `failed global version probe falls back to local package`() async throws {
        let projectRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-gateway-environment-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: projectRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: projectRoot) }
        try Data(#"{"version":"2026.7.29"}"#.utf8)
            .write(to: projectRoot.appendingPathComponent("package.json"))

        let version = await GatewayEnvironment.installedGatewayVersion(
            gatewayBin: "/usr/bin/false",
            projectRoot: projectRoot,
            searchPaths: ["/usr/bin"])

        #expect(version == "2026.7.29")
    }

    @Test func `gateway launch resolution scans preferred paths once`() async throws {
        let root = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let bin = root.appendingPathComponent("bin", isDirectory: true)
        let node = bin.appendingPathComponent("node")
        let gateway = bin.appendingPathComponent("openclaw")
        try makeExecutableForTests(at: node)
        try makeExecutableForTests(at: gateway)
        try "#!/bin/sh\necho v24.15.0\n".write(to: node, atomically: true, encoding: .utf8)
        let expectedVersion = GatewayEnvironment.expectedGatewayVersionString()
        let gatewayVersion = expectedVersion.flatMap { Semver.parse($0) == nil ? nil : $0 } ?? "2026.7.30"
        try "#!/bin/sh\necho OpenClaw \(gatewayVersion)\n"
            .write(to: gateway, atomically: true, encoding: .utf8)

        let scans = LockedCounter()
        let resolution = await GatewayEnvironment.resolveGatewayCommand(searchPathsProvider: {
            scans.increment()
            return [bin.path]
        })

        #expect(scans.value() == 1)
        #expect(resolution.status.kind == .ok)
        #expect(resolution.status.gatewayVersion == gatewayVersion)
        #expect(resolution.command?.first == gateway.path)
    }

    @Test func `failed gateway launch resolution scans preferred paths once`() async {
        let scans = LockedCounter()
        let resolution = await GatewayEnvironment.resolveGatewayCommand(searchPathsProvider: {
            scans.increment()
            return ["/missing/\(UUID().uuidString)"]
        })

        #expect(scans.value() == 1)
        #expect(resolution.status.kind == .missingNode)
        #expect(resolution.command == nil)
    }

    @Test func `semver compatibility requires same major and not older`() {
        let required = Semver(major: 2, minor: 1, patch: 0)
        #expect(Semver(major: 2, minor: 1, patch: 0).compatible(with: required))
        #expect(Semver(major: 2, minor: 2, patch: 0).compatible(with: required))
        #expect(Semver(major: 2, minor: 1, patch: 1).compatible(with: required))
        #expect(Semver(major: 2, minor: 0, patch: 9).compatible(with: required) == false)
        #expect(Semver(major: 3, minor: 0, patch: 0).compatible(with: required) == false)
        #expect(Semver(major: 1, minor: 9, patch: 9).compatible(with: required) == false)
    }

    @Test func `gateway port defaults and respects override`() async {
        let configPath = TestIsolation.tempConfigPath()
        await TestIsolation.withIsolatedState(
            env: ["OPENCLAW_CONFIG_PATH": configPath],
            defaults: ["gatewayPort": nil])
        {
            let defaultPort = GatewayEnvironment.gatewayPort()
            #expect(defaultPort == 18789)

            UserDefaults.standard.set(19999, forKey: "gatewayPort")
            defer { UserDefaults.standard.removeObject(forKey: "gatewayPort") }
            #expect(GatewayEnvironment.gatewayPort() == 19999)
        }
    }

    @Test func `expected gateway version from string uses parser`() {
        #expect(GatewayEnvironment.expectedGatewayVersion(from: "v9.1.2") == Semver(major: 9, minor: 1, patch: 2))
        #expect(GatewayEnvironment.expectedGatewayVersion(from: "2026.1.11-4") == Semver(
            major: 2026,
            minor: 1,
            patch: 11))
        #expect(GatewayEnvironment.expectedGatewayVersion(from: nil) == nil)
    }
}
