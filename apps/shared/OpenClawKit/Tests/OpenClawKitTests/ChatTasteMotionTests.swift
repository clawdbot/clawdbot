import Testing
@testable import OpenClawChatUI

struct ChatTasteMotionTests {
    @Test func `macOS clean chrome and Quick Chat never receive taste insertion`() {
        let desktop = chatTasteRowInsertion(
            tasteMotionEnabled: false,
            composerChromeIsClean: true,
            reduceMotion: false,
            transcriptHasSettled: true)
        let quickChat = chatTasteWorkingAppear(tasteMotionEnabled: false, reduceMotion: false)

        #expect(desktop == .none)
        #expect(quickChat == .none)
        #expect(!chatTasteAllowsSymbolReplace(tasteMotionEnabled: false, reduceMotion: false))
        #expect(!chatTasteAllowsHeightAnimation(tasteMotionEnabled: false, reduceMotion: false))
        #expect(chatTasteRowAnimation(.none) == nil)
    }

    @Test func `iOS clean chrome inserts new rows only after the transcript has settled`() {
        #expect(chatTasteRowInsertion(
            tasteMotionEnabled: true,
            composerChromeIsClean: true,
            reduceMotion: false,
            transcriptHasSettled: false) == .none)
        #expect(chatTasteRowInsertion(
            tasteMotionEnabled: true,
            composerChromeIsClean: true,
            reduceMotion: false,
            transcriptHasSettled: true) == .scaleAndOpacity)
    }

    @Test func `clean chrome on a non-iOS host is not enough to enable taste motion`() {
        #expect(chatTasteRowInsertion(
            tasteMotionEnabled: false,
            composerChromeIsClean: true,
            reduceMotion: false,
            transcriptHasSettled: true) == .none)
    }

    @Test func `iOS full chrome does not get bubble insertion`() {
        #expect(chatTasteRowInsertion(
            tasteMotionEnabled: true,
            composerChromeIsClean: false,
            reduceMotion: false,
            transcriptHasSettled: true) == .none)
    }

    @Test func `reduce motion keeps opacity only and disables symbol and height motion`() {
        #expect(chatTasteRowInsertion(
            tasteMotionEnabled: true,
            composerChromeIsClean: true,
            reduceMotion: true,
            transcriptHasSettled: true) == .opacity)
        #expect(chatTasteWorkingAppear(tasteMotionEnabled: true, reduceMotion: true) == .opacity)
        #expect(!chatTasteAllowsSymbolReplace(tasteMotionEnabled: true, reduceMotion: true))
        #expect(!chatTasteAllowsHeightAnimation(tasteMotionEnabled: true, reduceMotion: true))
        #expect(chatTasteRowAnimation(.opacity) != nil)
    }

    @Test func `iOS host can replace send symbols and grow the composer`() {
        #expect(chatTasteAllowsSymbolReplace(tasteMotionEnabled: true, reduceMotion: false))
        #expect(chatTasteAllowsHeightAnimation(tasteMotionEnabled: true, reduceMotion: false))
        #expect(chatTasteWorkingAppear(tasteMotionEnabled: true, reduceMotion: false) == .scaleAndOpacity)
    }

    @Test func `quick chat empty surface stays composer-off without intro chips or taste motion`() {
        let decision = chatSurfaceDecision(
            ChatSurfaceState(
                hasSession: true,
                isLoading: false,
                hasVisibleTranscript: false,
                isEmptyThread: true,
                errorText: nil,
                composerChromeIsClean: true,
                hasEmptyAssistantIntro: true,
                isComposerEnabled: false,
                hostConnection: .unmanaged))

        #expect(decision.presentation == .emptyUnavailable)
        #expect(decision.presentation != .emptyIntro)
        #expect(decision.mountsComposer)
        #expect(chatTasteRowInsertion(
            tasteMotionEnabled: false,
            composerChromeIsClean: true,
            reduceMotion: false,
            transcriptHasSettled: true) == .none)
        #expect(chatTasteWorkingAppear(tasteMotionEnabled: false, reduceMotion: false) == .none)
        #expect(!chatTasteAllowsHeightAnimation(tasteMotionEnabled: false, reduceMotion: false))
    }
}
