import Testing
@testable import OpenClawChatUI

struct ChatSurfacePresentationTests {
    @Test func `preparing is the only surface without a composer`() {
        let decision = chatSurfaceDecision(Self.state(hasSession: false))

        #expect(decision.presentation == .preparing)
        #expect(!decision.mountsComposer)
        #expect(!decision.showsInlineLoadingCapsule)
        #expect(!decision.showsErrorBanner)
    }

    @Test func `refreshing keeps the last good transcript instead of flashing empty or loading chrome`() {
        let loading = chatSurfaceDecision(Self.state(
            isLoading: true,
            hasVisibleTranscript: true,
            isEmptyThread: false,
            composerChromeIsClean: false))
        let cleanLoading = chatSurfaceDecision(Self.state(
            isLoading: true,
            hasVisibleTranscript: true,
            isEmptyThread: false,
            composerChromeIsClean: true,
            hasEmptyAssistantIntro: true))

        #expect(loading.presentation == .transcript)
        #expect(loading.mountsComposer)
        #expect(!loading.showsInlineLoadingCapsule)
        #expect(!loading.showsErrorBanner)
        #expect(cleanLoading.presentation == .transcript)
        #expect(!cleanLoading.showsInlineLoadingCapsule)
    }

    @Test func `a non-empty thread never becomes ContentUnavailable or an error overlay`() {
        let emptyFlash = chatSurfaceDecision(Self.state(
            hasVisibleTranscript: true,
            isEmptyThread: true,
            composerChromeIsClean: true,
            hasEmptyAssistantIntro: true))
        let errorFlash = chatSurfaceDecision(Self.state(
            hasVisibleTranscript: true,
            isEmptyThread: false,
            errorText: "Something went wrong"))

        #expect(emptyFlash.presentation == .transcript)
        #expect(errorFlash.presentation == .transcript)
        #expect(errorFlash.showsErrorBanner)
    }

    @Test func `clean empty loading uses one capsule instead of intro or unavailable`() {
        let decision = chatSurfaceDecision(Self.state(
            isLoading: true,
            isEmptyThread: true,
            composerChromeIsClean: true,
            hasEmptyAssistantIntro: true,
            isComposerEnabled: true))

        #expect(decision.presentation == .loading)
        #expect(decision.showsInlineLoadingCapsule)
        #expect(decision.mountsComposer)
        #expect(decision.presentation != .emptyIntro)
        #expect(decision.presentation != .emptyUnavailable)
        #expect(decision.presentation != .preparing)
    }

    @Test func `full chrome empty loading covers the canvas without a competing intro`() {
        let decision = chatSurfaceDecision(Self.state(
            isLoading: true,
            isEmptyThread: true,
            composerChromeIsClean: false,
            hasEmptyAssistantIntro: true))

        #expect(decision.presentation == .loading)
        #expect(!decision.showsInlineLoadingCapsule)
    }

    @Test func `iOS connecting status does not also show a disconnected banner over a transcript`() {
        let decision = chatSurfaceDecision(Self.state(
            hasVisibleTranscript: true,
            isEmptyThread: false,
            errorText: "not connected",
            hostConnection: .connecting))

        #expect(decision.presentation == .transcript)
        #expect(!decision.showsErrorBanner)
        #expect(decision.mountsComposer)
    }

    @Test func `iOS connecting with no transcript stays loading instead of flashing disconnected`() {
        let decision = chatSurfaceDecision(Self.state(
            isEmptyThread: true,
            errorText: "Gateway not connected. Check Tailscale and retry.",
            composerChromeIsClean: true,
            hasEmptyAssistantIntro: true,
            isComposerEnabled: true,
            hostConnection: .connecting))

        #expect(decision.presentation == .loading)
        #expect(decision.showsInlineLoadingCapsule)
        #expect(!decision.showsErrorBanner)
        #expect(decision.presentation != .error)
        #expect(decision.presentation != .emptyUnavailable)
    }

    @Test func `iOS disconnected empty thread keeps intro or unavailable instead of a second disconnected overlay`() {
        let intro = chatSurfaceDecision(Self.state(
            isEmptyThread: true,
            errorText: "not connected",
            composerChromeIsClean: true,
            hasEmptyAssistantIntro: true,
            isComposerEnabled: true,
            hostConnection: .disconnected))
        let unavailable = chatSurfaceDecision(Self.state(
            isEmptyThread: true,
            errorText: "not connected",
            composerChromeIsClean: false,
            hostConnection: .disconnected))

        #expect(intro.presentation == .emptyIntro)
        #expect(!intro.showsErrorBanner)
        #expect(unavailable.presentation == .emptyUnavailable)
        #expect(!unavailable.showsErrorBanner)
        #expect(intro.presentation != .error)
        #expect(unavailable.presentation != .error)
    }

    @Test func `macOS unmanaged hosts still show connection errors themselves`() {
        let transcript = chatSurfaceDecision(Self.state(
            hasVisibleTranscript: true,
            isEmptyThread: false,
            errorText: "not connected"))
        let empty = chatSurfaceDecision(Self.state(
            isEmptyThread: true,
            errorText: "not connected",
            composerChromeIsClean: true,
            hasEmptyAssistantIntro: true,
            isComposerEnabled: false))

        #expect(transcript.presentation == .transcript)
        #expect(transcript.showsErrorBanner)
        #expect(empty.presentation == .error)
        #expect(!empty.showsErrorBanner)
    }

    @Test func `quick chat stays composer-off and does not force intro chips`() {
        let decision = chatSurfaceDecision(Self.state(
            isEmptyThread: true,
            composerChromeIsClean: true,
            hasEmptyAssistantIntro: true,
            isComposerEnabled: false))

        #expect(decision.presentation == .emptyUnavailable)
        #expect(decision.mountsComposer)
        #expect(decision.presentation != .emptyIntro)
    }

    @Test func `enabled clean chrome can show the intro once the thread is idle and empty`() {
        let decision = chatSurfaceDecision(Self.state(
            isEmptyThread: true,
            composerChromeIsClean: true,
            hasEmptyAssistantIntro: true,
            isComposerEnabled: true))

        #expect(decision.presentation == .emptyIntro)
        #expect(decision.mountsComposer)
    }

    @Test func `non-connection errors still overlay an empty canvas`() {
        let decision = chatSurfaceDecision(Self.state(
            isEmptyThread: true,
            errorText: "The gateway took too long to respond."))

        #expect(decision.presentation == .error)
        #expect(decision.mountsComposer)
        #expect(!decision.showsErrorBanner)
    }

    @Test func `connection failure detection matches the existing notice copy`() {
        #expect(chatSurfaceErrorIsConnectionFailure("not connected"))
        #expect(chatSurfaceErrorIsConnectionFailure("Gateway socket closed"))
        #expect(!chatSurfaceErrorIsConnectionFailure("The gateway took too long to respond."))
        #expect(chatSurfaceNormalizedErrorText("  ") == nil)
        #expect(chatSurfaceNormalizedErrorText("not connected") == "not connected")
    }

    private static func state(
        hasSession: Bool = true,
        isLoading: Bool = false,
        hasVisibleTranscript: Bool = false,
        isEmptyThread: Bool = true,
        errorText: String? = nil,
        composerChromeIsClean: Bool = false,
        hasEmptyAssistantIntro: Bool = false,
        isComposerEnabled: Bool = true,
        hostConnection: ChatHostConnectionStatus = .unmanaged) -> ChatSurfaceState
    {
        ChatSurfaceState(
            hasSession: hasSession,
            isLoading: isLoading,
            hasVisibleTranscript: hasVisibleTranscript,
            isEmptyThread: isEmptyThread,
            errorText: errorText,
            composerChromeIsClean: composerChromeIsClean,
            hasEmptyAssistantIntro: hasEmptyAssistantIntro,
            isComposerEnabled: isComposerEnabled,
            hostConnection: hostConnection)
    }
}
