import Foundation
import Testing
@testable import OpenClawKit

struct ArtifactBuildInfoTests {
    @Test func `preserves full provenance and formats compact UTC values`() {
        let commit = "ABCDEF0123456789ABCDEF0123456789ABCDEF01"
        let info = ArtifactBuildInfo(
            infoDictionary: [
                "OpenClawCanonicalVersion": "2026.7.10",
                "CFBundleShortVersionString": "2026.7.9",
                "CFBundleVersion": "42",
                "OpenClawGitCommit": commit,
                "OpenClawBuildTimestamp": "2026-01-01T00:30:00.123Z",
            ],
            versionKeys: ["OpenClawCanonicalVersion", "CFBundleShortVersionString"])

        #expect(info.versionDisplay == "2026.7.10 (42)")
        #expect(info.gitCommit == commit.lowercased())
        #expect(info.shortCommit == "abcdef012345")
        #expect(info.localizedBuildDate(locale: Locale(identifier: "en_US_POSIX")) == "Jan 1, 2026")
        #expect(info.copyText.contains(commit.lowercased()))
        #expect(info.copyText.contains("2026-01-01T00:30:00.123Z"))
        #expect(info.spokenCommit == commit.lowercased().map(String.init).joined(separator: " "))
    }

    @Test func `reports missing or malformed optional provenance`() {
        let info = ArtifactBuildInfo(infoDictionary: [
            "CFBundleShortVersionString": "1.2.3",
            "CFBundleVersion": "1.2.3",
            "OpenClawGitCommit": "abc123",
            "OpenClawBuildTimestamp": "not-a-date",
        ])

        #expect(info.versionDisplay == "1.2.3")
        #expect(info.gitCommit == nil)
        #expect(info.shortCommit == nil)
        #expect(info.buildTimestamp == nil)
        #expect(info.localizedBuildDate() == nil)
        #expect(info.copyText.contains("Commit Unavailable"))
        #expect(info.copyText.contains("Built Unavailable"))
        #expect(info.spokenCommit == nil)
    }

    @Test func `rejects non UTC timestamps and non ASCII commit digits`() {
        let info = ArtifactBuildInfo(infoDictionary: [
            "CFBundleShortVersionString": "1.2.3",
            "OpenClawGitCommit": String(repeating: "Ａ", count: 40),
            "OpenClawBuildTimestamp": "2026-07-10T12:34:56+00:00",
        ])

        #expect(info.gitCommit == nil)
        #expect(info.buildTimestamp == nil)
    }

    @Test func `rejects impossible calendar dates and accepts short fractions`() {
        let invalid = ArtifactBuildInfo(infoDictionary: [
            "CFBundleShortVersionString": "1.2.3",
            "OpenClawBuildTimestamp": "2026-02-30T12:34:56Z",
        ])
        let valid = ArtifactBuildInfo(infoDictionary: [
            "CFBundleShortVersionString": "1.2.3",
            "OpenClawBuildTimestamp": "2026-07-10T12:34:56.7Z",
        ])

        #expect(invalid.buildTimestamp == nil)
        #expect(valid.buildTimestamp == "2026-07-10T12:34:56.7Z")
        #expect(valid.builtAt != nil)
    }

    @Test func `retains commit independently when timestamp is absent`() {
        let commit = "abcdef0123456789abcdef0123456789abcdef01"
        let info = ArtifactBuildInfo(infoDictionary: [
            "CFBundleShortVersionString": "2026.7.10",
            "OpenClawGitCommit": commit,
        ])

        #expect(info.shortCommit == "abcdef012345")
        #expect(info.localizedBuildDate() == nil)
        #expect(info.copyText.contains(commit))
        #expect(info.copyText.contains("Built Unavailable"))
    }
}
