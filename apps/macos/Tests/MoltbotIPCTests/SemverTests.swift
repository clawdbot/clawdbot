import Testing
@testable import Moltbot

@Suite struct SemverTests {
    @Test func comparisonOrdersByMajorMinorPatch() {
        let a = Semver(major: 1, minor: 0, patch: 0)
        let b = Semver(major: 1, minor: 1, patch: 0)
        let c = Semver(major: 1, minor: 1, patch: 1)
        let d = Semver(major: 2, minor: 0, patch: 0)

        #expect(a < b)
        #expect(b < c)
        #expect(c < d)
        #expect(d > a)
    }

    @Test func descriptionMatchesParts() {
        let v = Semver(major: 3, minor: 2, patch: 1)
        #expect(v.description == "3.2.1")
    }
}
