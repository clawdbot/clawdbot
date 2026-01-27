import Testing
@testable import Moltbot

@Suite struct VoicePushToTalkTests {
    @Test func deltaTrimsCommittedPrefix() {
        let delta = VoicePushToTalk._testDelta(committed: "hello ", current: "hello world again")
        #expect(delta == "world again")
    }

    @Test func deltaFallsBackWhenPrefixDiffers() {
        let delta = VoicePushToTalk._testDelta(committed: "goodbye", current: "hello world")
        #expect(delta == "hello world")
    }

    @Test func attributedColorsDifferWhenNotFinal() {
        let colors = VoicePushToTalk._testAttributedColors(isFinal: false)
        #expect(colors.0 != colors.1)
    }

    @Test func attributedColorsMatchWhenFinal() {
        let colors = VoicePushToTalk._testAttributedColors(isFinal: true)
        #expect(colors.0 == colors.1)
    }
}
