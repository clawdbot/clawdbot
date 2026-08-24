import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

private func makeSkillStatus(
    name: String,
    description: String,
    source: String,
    filePath: String,
    skillKey: String,
    primaryEnv: String? = nil,
    emoji: String,
    homepage: String? = nil,
    disabled: Bool = false,
    eligible: Bool,
    requirements: SkillRequirements = SkillRequirements(bins: [], env: [], config: []),
    missing: SkillMissing = SkillMissing(bins: [], env: [], config: []),
    install: [SkillInstallOption] = [])
    -> SkillStatus
{
    SkillStatus(
        name: name,
        description: description,
        source: source,
        filePath: filePath,
        baseDir: "/tmp/skills",
        skillKey: skillKey,
        primaryEnv: primaryEnv,
        emoji: emoji,
        homepage: homepage,
        always: false,
        disabled: disabled,
        eligible: eligible,
        requirements: requirements,
        missing: missing,
        configChecks: [],
        install: install)
}

private func makeSkillsStatusReport(_ skills: [SkillStatus]) -> SkillsStatusReport {
    SkillsStatusReport(
        workspaceDir: "/tmp/workspace",
        managedSkillsDir: "/tmp/skills",
        skills: skills)
}

private func makeSkillsChangedPush() -> GatewayPush {
    .event(EventFrame(type: "event", event: "skills.changed"))
}

private enum SkillsStatusLoadError: Error {
    case unavailable
}

@Suite(.serialized)
@MainActor
struct SkillsSettingsSmokeTests {
    @Test func `alternative binaries and OS blockers remain visible requirements`() {
        let alternatives = SkillMissing(
            bins: [],
            anyBins: ["rg", "grep"],
            env: [],
            config: [])
        let platforms = SkillMissing(
            bins: [],
            env: [],
            config: [],
            os: ["linux"])

        #expect(!SkillRequirementPresentation.requirementsMet(alternatives))
        #expect(SkillRequirementPresentation.shouldShowSummary(alternatives, showMissingBins: false))
        #expect(SkillRequirementPresentation.installOptions(
            missing: alternatives,
            options: [
                SkillInstallOption(id: "brew", kind: "brew", label: "brew install ripgrep", bins: ["rg"]),
            ]).map(\.id) == ["brew"])
        #expect(!SkillRequirementPresentation.requirementsMet(platforms))
        #expect(SkillRequirementPresentation.shouldShowSummary(platforms, showMissingBins: false))
    }

    @Test func `skills changed event forces a loaded status refresh`() async {
        var reports = [
            makeSkillsStatusReport([
                makeSkillStatus(
                    name: "Paprika",
                    description: "Missing local binary",
                    source: "openclaw-workspace",
                    filePath: "/tmp/skills/paprika",
                    skillKey: "paprika",
                    emoji: "P",
                    eligible: false,
                    requirements: SkillRequirements(bins: ["paprika"], env: [], config: []),
                    missing: SkillMissing(bins: ["paprika"], env: [], config: [])),
            ]),
            makeSkillsStatusReport([
                makeSkillStatus(
                    name: "Paprika",
                    description: "Ready after node reconnect",
                    source: "openclaw-workspace",
                    filePath: "/tmp/skills/paprika",
                    skillKey: "paprika",
                    emoji: "P",
                    eligible: true,
                    requirements: SkillRequirements(bins: ["paprika"], env: [], config: []),
                    missing: SkillMissing(bins: [], env: [], config: [])),
            ]),
        ]
        var loadCount = 0
        let model = SkillsSettingsModel {
            loadCount += 1
            return reports.removeFirst()
        }

        await model.refreshIfNeeded()
        #expect(loadCount == 1)
        #expect(model.skills.first?.eligible == false)

        model.handleGatewayPush(makeSkillsChangedPush())
        while loadCount < 2 || model.isLoading {
            await Task.yield()
        }

        #expect(loadCount == 2)
        #expect(model.skills.first?.eligible == true)
        #expect(model.skills.first?.missing.bins == [])
    }

    @Test func `skills changed event queues refresh under one loading lease`() async {
        var pendingLoads: [CheckedContinuation<SkillsStatusReport, Never>] = []
        let model = SkillsSettingsModel {
            await withCheckedContinuation { continuation in
                pendingLoads.append(continuation)
            }
        }

        let initialRefresh = Task { await model.refreshIfNeeded() }
        while pendingLoads.count < 1 {
            await Task.yield()
        }

        model.handleGatewayPush(makeSkillsChangedPush())

        #expect(pendingLoads.count == 1)
        #expect(model.isLoading)

        pendingLoads.removeFirst().resume(returning: makeSkillsStatusReport([
            makeSkillStatus(
                name: "Paprika",
                description: "Missing local binary",
                source: "openclaw-workspace",
                filePath: "/tmp/skills/paprika",
                skillKey: "paprika",
                emoji: "P",
                eligible: false,
                requirements: SkillRequirements(bins: ["paprika"], env: [], config: []),
                missing: SkillMissing(bins: ["paprika"], env: [], config: [])),
        ]))
        while pendingLoads.count < 1 {
            await Task.yield()
        }

        #expect(model.isLoading)
        pendingLoads.removeFirst().resume(returning: makeSkillsStatusReport([
            makeSkillStatus(
                name: "Paprika",
                description: "Ready after node reconnect",
                source: "openclaw-workspace",
                filePath: "/tmp/skills/paprika",
                skillKey: "paprika",
                emoji: "P",
                eligible: true,
                requirements: SkillRequirements(bins: ["paprika"], env: [], config: []),
                missing: SkillMissing(bins: [], env: [], config: [])),
        ]))
        await initialRefresh.value

        #expect(!model.isLoading)
        #expect(model.skills.first?.eligible == true)
        #expect(model.skills.first?.missing.bins == [])
    }

    @Test func `unrelated gateway event does not load skills`() {
        var loadCount = 0
        let model = SkillsSettingsModel {
            loadCount += 1
            return makeSkillsStatusReport([])
        }

        model.handleGatewayPush(.event(EventFrame(type: "event", event: "health")))

        #expect(loadCount == 0)
        #expect(model.skills.isEmpty)
    }

    @Test func `skills changed before initial load does not duplicate it`() async {
        var loadCount = 0
        let model = SkillsSettingsModel {
            loadCount += 1
            return makeSkillsStatusReport([])
        }

        model.handleGatewayPush(makeSkillsChangedPush())
        #expect(loadCount == 0)

        await model.refreshIfNeeded()
        #expect(loadCount == 1)
    }

    @Test func `skills changed retries a failed initial load`() async {
        var loadCount = 0
        let model = SkillsSettingsModel {
            loadCount += 1
            if loadCount == 1 {
                throw SkillsStatusLoadError.unavailable
            }
            return makeSkillsStatusReport([])
        }

        await model.refreshIfNeeded()
        #expect(model.error != nil)

        model.handleGatewayPush(makeSkillsChangedPush())
        while loadCount < 2 || model.isLoading {
            await Task.yield()
        }

        #expect(loadCount == 2)
        #expect(model.error == nil)
    }

    @Test func `queued success clears the failed refresh error`() async {
        var firstLoad: CheckedContinuation<SkillsStatusReport, Error>?
        var loadCount = 0
        let model = SkillsSettingsModel {
            loadCount += 1
            if loadCount == 1 {
                return try await withCheckedThrowingContinuation { continuation in
                    firstLoad = continuation
                }
            }
            return makeSkillsStatusReport([])
        }

        let initialRefresh = Task { await model.refreshIfNeeded() }
        while firstLoad == nil {
            await Task.yield()
        }
        model.handleGatewayPush(makeSkillsChangedPush())
        firstLoad?.resume(throwing: SkillsStatusLoadError.unavailable)
        await initialRefresh.value

        #expect(loadCount == 2)
        #expect(!model.isLoading)
        #expect(model.error == nil)
    }

    @Test func `gateway sequence gap refreshes loaded skills`() async {
        var loadCount = 0
        let model = SkillsSettingsModel {
            loadCount += 1
            return makeSkillsStatusReport([])
        }
        await model.refreshIfNeeded()

        model.handleGatewayPush(.seqGap(expected: 2, received: 3))
        while loadCount < 2 || model.isLoading {
            await Task.yield()
        }

        #expect(loadCount == 2)
    }

}
