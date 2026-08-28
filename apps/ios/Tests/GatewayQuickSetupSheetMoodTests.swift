import OpenClawChatUI
import Testing
@testable import OpenClaw

@MainActor
struct GatewayQuickSetupSheetMoodTests {
    @Test func `connecting works`() {
        #expect(GatewayQuickSetupSheet.headerMood(
            connecting: true,
            hasError: false,
            hasCandidate: false) == .working)
    }

    @Test func `error is sad`() {
        #expect(GatewayQuickSetupSheet.headerMood(
            connecting: false,
            hasError: true,
            hasCandidate: true) == .sad)
    }

    @Test func `candidate is curious`() {
        #expect(GatewayQuickSetupSheet.headerMood(
            connecting: false,
            hasError: false,
            hasCandidate: true) == .curious)
    }

    @Test func `empty state idles`() {
        #expect(GatewayQuickSetupSheet.headerMood(
            connecting: false,
            hasError: false,
            hasCandidate: false) == .idle)
    }

    @Test func `connecting beats error`() {
        #expect(GatewayQuickSetupSheet.headerMood(
            connecting: true,
            hasError: true,
            hasCandidate: true) == .working)
    }
}
