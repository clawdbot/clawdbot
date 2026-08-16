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

    @Test func `same-slug results keep separate publisher references`() throws {
        let data = Data(
            #"{"results":[{"slug":"email","installRef":"@alice/email","displayName":"Email"},{"slug":"email","installRef":"@bob/email","displayName":"Email"},{"slug":"orphan","displayName":"Orphan"}]}"#
                .utf8)
        let search = try JSONDecoder().decode(ClawHubSkillSearchResult.self, from: data)

        #expect(search.results.map(\.reference) == ["@alice/email", "@bob/email", "orphan"])
        #expect(search.results.map(\.id) == ["@alice/email", "@bob/email", "orphan"])
    }

    @Test func `install-only results keep their source and expose no detail action`() throws {
        let data = Data(
            #"{"results":[{"slug":"pdf","installRef":"skills-sh:openai/skills/pdf","installOnly":true,"trustState":"not-scanned-by-clawhub","displayName":"Pdf"},{"slug":"pdf","installRef":"@awspace/pdf","displayName":"Pdf"}]}"#
                .utf8)
        let search = try JSONDecoder().decode(ClawHubSkillSearchResult.self, from: data)
        let external = try #require(search.results.first)
        let native = try #require(search.results.last)

        // Rewriting the external reference to @openai/pdf would install a different skill.
        #expect(external.reference == "skills-sh:openai/skills/pdf")
        #expect(!external.canReadDetails)
        #expect(external.isUnscannedSource)
        #expect(native.canReadDetails)

        let review = ClawHubSkillInstallReview(directInstall: external)
        #expect(review.slug == "skills-sh:openai/skills/pdf")
        // The Gateway pins external sources to a commit and rejects a version selector.
        #expect(review.version == nil)
        #expect(review.requestedReference == "skills-sh:openai/skills/pdf")
    }

    @Test func `results without the install-only flag keep the review flow`() throws {
        // A Gateway released before the flag existed omits it from every row.
        let data = Data(#"{"results":[{"slug":"email","installRef":"@alice/email","displayName":"Email"}]}"#.utf8)
        let search = try JSONDecoder().decode(ClawHubSkillSearchResult.self, from: data)
        let legacy = try #require(search.results.first)

        // Treating omission as install-only would bypass the reviewed-version step those
        // Gateways still expect.
        #expect(legacy.canReadDetails)
        #expect(!legacy.isUnscannedSource)
        #expect(legacy.reference == "@alice/email")
    }

    @Test func `install-only readback matches the recorded reference`() throws {
        let data = Data(
            #"{"name":"pdf","description":"","source":"clawhub","filePath":"/s/pdf/SKILL.md","baseDir":"/s/pdf","skillKey":"pdf","primaryEnv":null,"emoji":null,"homepage":null,"always":false,"disabled":false,"eligible":true,"requirements":{"bins":[],"env":[],"config":[]},"missing":{"bins":[],"env":[],"config":[]},"configChecks":[],"install":[],"clawhub":{"status":"linked","valid":true,"slug":"pdf","requestedReference":"skills-sh:openai/skills/pdf","installedVersion":"0.0.0"}}"#
                .utf8)
        let installed = [try JSONDecoder().decode(SkillStatus.self, from: data)]

        // The canonical slug is "pdf", so matching by the sent reference is the only readback that
        // identifies this install without colliding with a registry skill of the same slug.
        #expect(SkillManagementContract.installed(
            installed,
            requestedReference: "skills-sh:openai/skills/pdf"))
        let external = try JSONDecoder().decode(
            ClawHubSkillSummary.self,
            from: Data(
                #"{"slug":"pdf","installRef":"skills-sh:openai/skills/pdf","installOnly":true,"displayName":"Pdf"}"#.utf8))
        #expect(SkillManagementContract.installed(installed, searchResult: external))
        #expect(!SkillManagementContract.installed(
            installed,
            requestedReference: "skills-sh:someone-else/skills/pdf"))
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
                requestedReference: nil,
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
                requestedReference: nil,
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
