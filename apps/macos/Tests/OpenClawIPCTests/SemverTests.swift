import Testing
@testable import OpenClaw

struct SemverTests {
    @Test func `comparison orders by major minor patch`() {
        let a = Semver(major: 1, minor: 0, patch: 0)
        let b = Semver(major: 1, minor: 1, patch: 0)
        let c = Semver(major: 1, minor: 1, patch: 1)
        let d = Semver(major: 2, minor: 0, patch: 0)

        #expect(a < b)
        #expect(b < c)
        #expect(c < d)
        #expect(d > a)
    }

    @Test func `description matches parts`() {
        let v = Semver(major: 3, minor: 2, patch: 1)
        #expect(v.description == "3.2.1")
    }

    @Test func `expected prerelease pins require exact raw version`() {
        #expect(Semver.satisfiesExpectedGatewayVersion(
            installed: "2026.7.2-beta.1",
            expected: "2026.7.2-beta.1"))
        #expect(!Semver.satisfiesExpectedGatewayVersion(
            installed: "2026.7.2",
            expected: "2026.7.2-beta.1"))
        #expect(!Semver.satisfiesExpectedGatewayVersion(
            installed: "2026.7.2-beta.1",
            expected: "2026.7.2"))
        #expect(Semver.satisfiesExpectedGatewayVersion(
            installed: "2026.7.3",
            expected: "2026.7.2"))
        #expect(!Semver.satisfiesExpectedGatewayVersion(
            installed: "2026.7.2-rc.1",
            expected: "2026.7.2"))
        #expect(Semver.satisfiesExpectedGatewayVersion(
            installed: "2026.7.2+build-foo",
            expected: "2026.7.2"))
    }
}
