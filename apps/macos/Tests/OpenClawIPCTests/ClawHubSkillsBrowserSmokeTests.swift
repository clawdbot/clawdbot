import Testing
@testable import OpenClaw

@MainActor
struct ClawHubSkillsBrowserSmokeTests {
    @Test func `ClawHub browser builds guarded review flow`() {
        let view = ClawHubSkillsBrowser(installedSkills: [], onInstalled: { _ in })
        _ = view.body
    }
}
