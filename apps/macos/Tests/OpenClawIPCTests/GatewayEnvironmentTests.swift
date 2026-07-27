import Foundation
import Testing
@testable import OpenClaw

struct GatewayEnvironmentTests {
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
