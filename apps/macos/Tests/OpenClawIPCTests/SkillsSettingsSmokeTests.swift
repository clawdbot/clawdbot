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
    configChecks: [SkillStatusConfigCheck] = [],
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
        configChecks: configChecks,
        install: install)
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

    @Test func `skills settings builds body with skills remote`() {
        let model = SkillsSettingsModel()
        model.statusMessage = "Loaded"
        model.skills = [
            makeSkillStatus(
                name: "Needs Setup",
                description: "Missing bins and env",
                source: "openclaw-managed",
                filePath: "/tmp/skills/needs-setup",
                skillKey: "needs-setup",
                primaryEnv: "API_KEY",
                emoji: "🧰",
                homepage: "https://example.com/needs-setup",
                eligible: false,
                requirements: SkillRequirements(
                    bins: ["python3"],
                    env: ["API_KEY"],
                    config: ["skills.needs-setup"]),
                missing: SkillMissing(
                    bins: ["python3"],
                    env: ["API_KEY"],
                    config: ["skills.needs-setup"]),
                configChecks: [
                    SkillStatusConfigCheck(path: "skills.needs-setup", value: AnyCodable(false), satisfied: false),
                ],
                install: [
                    SkillInstallOption(id: "brew", kind: "brew", label: "brew install python", bins: ["python3"]),
                ]),
            makeSkillStatus(
                name: "Ready Skill",
                description: "All set",
                source: "openclaw-bundled",
                filePath: "/tmp/skills/ready",
                skillKey: "ready",
                emoji: "✅",
                homepage: "https://example.com/ready",
                eligible: true,
                configChecks: [
                    SkillStatusConfigCheck(path: "skills.ready", value: AnyCodable(true), satisfied: true),
                    SkillStatusConfigCheck(path: "skills.limit", value: AnyCodable(5), satisfied: true),
                ],
                install: []),
            makeSkillStatus(
                name: "Disabled Skill",
                description: "Disabled in config",
                source: "openclaw-extra",
                filePath: "/tmp/skills/disabled",
                skillKey: "disabled",
                emoji: "🚫",
                disabled: true,
                eligible: false),
        ]

        let state = AppState(preview: true)
        state.connectionMode = .remote
        var view = SkillsSettings(state: state, model: model)
        view.setFilterForTesting("all")
        _ = view.body
        view.setFilterForTesting("needsSetup")
        _ = view.body
    }

    @Test func `skills settings builds body with local mode`() {
        let model = SkillsSettingsModel()
        model.skills = [
            makeSkillStatus(
                name: "Local Skill",
                description: "Local ready",
                source: "openclaw-workspace",
                filePath: "/tmp/skills/local",
                skillKey: "local",
                emoji: "🏠",
                eligible: true),
        ]

        let state = AppState(preview: true)
        state.connectionMode = .local
        var view = SkillsSettings(state: state, model: model)
        view.setFilterForTesting("ready")
        _ = view.body
    }

    @Test func `skills settings exercises private views`() {
        SkillsSettings.exerciseForTesting()
    }
}
