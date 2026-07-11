import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct BrowserProfileImportPrompterTests {
    @Test func `automatic prompt requires importable cookies and no prior outcome`() {
        let profile = BrowserSystemProfile(
            browser: "chrome",
            id: "Default",
            name: "Personal",
            hasCookies: true)
        let fresh = BrowserProfileImportStatus(
            enabled: true,
            systemProfiles: [profile],
            state: nil,
            suggestedTarget: "imported")
        #expect(BrowserProfileImportPrompter.shouldOfferPrompt(status: fresh, force: false))

        let dismissed = BrowserProfileImportStatus(
            enabled: true,
            systemProfiles: [profile],
            state: BrowserProfileImportOutcome(status: .dismissed),
            suggestedTarget: "imported")
        #expect(!BrowserProfileImportPrompter.shouldOfferPrompt(status: dismissed, force: false))
        #expect(BrowserProfileImportPrompter.shouldOfferPrompt(status: dismissed, force: true))
    }

    @Test func `profiles without cookies do not trigger import`() {
        let status = BrowserProfileImportStatus(
            enabled: true,
            systemProfiles: [
                BrowserSystemProfile(
                    browser: "brave",
                    id: "Default",
                    name: "Default",
                    hasCookies: false),
            ],
            state: nil,
            suggestedTarget: "imported")
        #expect(!BrowserProfileImportPrompter.shouldOfferPrompt(status: status, force: true))
    }

    @Test func `disabled import never offers the prompt`() {
        let status = BrowserProfileImportStatus(
            enabled: false,
            systemProfiles: [
                BrowserSystemProfile(
                    browser: "chrome",
                    id: "Default",
                    name: "Personal",
                    hasCookies: true),
            ],
            state: nil,
            suggestedTarget: "imported")
        #expect(!BrowserProfileImportPrompter.shouldOfferPrompt(status: status, force: true))
    }
}
