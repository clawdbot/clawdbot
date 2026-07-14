import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawKit

struct SkillManagementTests {
    @Test func `detail review uses exact detail version and publisher`() throws {
        let data = Data(
            #"{"skill":{"displayName":"Weather","summary":"Forecasts"},"latestVersion":{"version":"2.0.0"},"owner":{"handle":"molly","displayName":"Molly"}}"#
                .utf8)
        let fallbackData = Data(
            #"{"slug":"weather","displayName":"Old Weather","summary":null,"version":"1.0.0"}"#.utf8)
        let detail = try JSONDecoder().decode(ClawHubSkillDetail.self, from: data)
        let fallback = try JSONDecoder().decode(ClawHubSkillSummary.self, from: fallbackData)
        let review = try #require(ClawHubSkillInstallReview(
            detail: detail,
            fallback: fallback))

        #expect(review.slug == "@molly/weather")
        #expect(review.displayName == "Weather")
        #expect(review.version == "2.0.0")
        #expect(review.author == "Molly")
    }

    @Test func `risk acknowledgement stays bound to reviewed version`() {
        let matching = GatewayResponseError(
            method: "skills.install",
            code: "UNAVAILABLE",
            message: "Review warning",
            details: [
                "clawhubTrustCode": AnyCodable("clawhub_risk_acknowledgement_required"),
                "version": AnyCodable("2.0.0"),
                "warning": AnyCodable("Automated analysis found risky behavior."),
            ])
        let accepted = SkillManagementContract.rejection(from: matching, attemptedVersion: "2.0.0")
        #expect(accepted.requiresAcknowledgement)
        #expect(accepted.acknowledgeVersion == "2.0.0")

        let stale = SkillManagementContract.rejection(from: matching, attemptedVersion: "1.0.0")
        #expect(!stale.requiresAcknowledgement)
        #expect(stale.acknowledgeVersion == nil)
        #expect(stale.message.contains("different ClawHub release"))
    }

    @Test func `missing requirements preserve alternatives and platforms`() throws {
        let data = Data(#"{"bins":[],"anyBins":["rg","grep"],"env":[],"config":[],"os":["darwin"]}"#.utf8)
        let missing = try JSONDecoder().decode(SkillMissing.self, from: data)

        #expect(missing.anyBins == ["rg", "grep"])
        #expect(missing.os == ["darwin"])
    }

    @Test func `legacy requirements default new fields to empty`() throws {
        let data = Data(#"{"bins":["rg"],"env":[],"config":[]}"#.utf8)
        let requirements = try JSONDecoder().decode(SkillRequirements.self, from: data)
        let missing = try JSONDecoder().decode(SkillMissing.self, from: data)

        #expect(requirements.anyBins.isEmpty)
        #expect(requirements.os.isEmpty)
        #expect(missing.anyBins.isEmpty)
        #expect(missing.os.isEmpty)
    }

    @Test func `qualified install remains busy for unqualified browse row`() {
        #expect(SkillManagementContract.sameClawHubSkill("@molly/weather", "weather"))
        #expect(!SkillManagementContract.sameClawHubSkill("@molly/weather", "@alice/weather"))
    }

    @Test func `installed readback requires valid provenance and exact version`() {
        let linked = Self.skill(
            clawhub: ClawHubInstalledSkillLink(
                status: "linked",
                valid: true,
                slug: "@molly/weather",
                ownerHandle: "molly",
                installedVersion: "2.0.0",
                reason: nil))
        #expect(SkillManagementContract.installed([linked], slug: "weather", version: "2.0.0"))
        #expect(!SkillManagementContract.installed([linked], slug: "weather", version: "2.0.1"))
        #expect(SkillManagementContract.installed([linked], slug: "weather"))
    }

    @Test func `owner qualified readback matches split provenance identity`() {
        let linked = Self.skill(
            clawhub: ClawHubInstalledSkillLink(
                status: "linked",
                valid: true,
                slug: "weather",
                ownerHandle: "molly",
                installedVersion: "2.0.0",
                reason: nil))
        #expect(SkillManagementContract.installed([linked], slug: "@molly/weather", version: "2.0.0"))
        #expect(!SkillManagementContract.installed([linked], slug: "@other/weather", version: "2.0.0"))
    }

    @Test func `agent filtered skills need setup instead of reporting ready`() {
        let blocked = Self.skill(clawhub: nil, blockedByAgentFilter: true)
        #expect(!SkillManagementContract.ready(blocked))
        #expect(SkillManagementContract.needsSetup(blocked))
    }

    @Test func `platform incompatible skills need setup instead of reporting ready`() {
        let blocked = Self.skill(clawhub: nil, platformIncompatible: true)
        #expect(!SkillManagementContract.ready(blocked))
        #expect(SkillManagementContract.needsSetup(blocked))
    }

    private static func skill(
        clawhub: ClawHubInstalledSkillLink?,
        blockedByAgentFilter: Bool? = nil,
        platformIncompatible: Bool? = nil) -> SkillStatus
    {
        SkillStatus(
            name: "Weather",
            description: "Forecasts",
            source: "openclaw-managed",
            filePath: "/tmp/weather/SKILL.md",
            baseDir: "/tmp/weather",
            skillKey: "weather",
            primaryEnv: nil,
            emoji: "☀️",
            homepage: nil,
            always: false,
            disabled: false,
            blockedByAgentFilter: blockedByAgentFilter,
            platformIncompatible: platformIncompatible,
            eligible: true,
            requirements: SkillRequirements(bins: [], env: [], config: []),
            missing: SkillMissing(bins: [], env: [], config: []),
            configChecks: [],
            install: [],
            clawhub: clawhub)
    }
}
