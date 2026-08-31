import SwiftUI
import Testing
@testable import OpenClawChatUI

struct ChatUserAccentInkTests {
    @Test func lightAccentGetsBlackInk() {
        // #fbbf24: the Control UI contract example of a light accent needing black ink.
        let amber = Color(red: 0xFB / 255.0, green: 0xBF / 255.0, blue: 0x24 / 255.0)
        #expect(OpenClawChatTheme.relativeLuminance(of: amber) > 0.179)
        #expect(OpenClawChatTheme.userText(on: amber) == .black)
    }

    @Test func darkAccentKeepsWhiteInk() {
        let crimson = Color(red: 0x8B / 255.0, green: 0x00 / 255.0, blue: 0x00 / 255.0)
        #expect(OpenClawChatTheme.relativeLuminance(of: crimson) <= 0.179)
        #expect(OpenClawChatTheme.userText(on: crimson) == .white)
    }

    @Test func missingAccentKeepsDefaultUserText() {
        #expect(OpenClawChatTheme.userText(on: nil) == OpenClawChatTheme.userText)
    }

    @Test func luminanceMatchesWcagAnchors() {
        #expect(abs(OpenClawChatTheme.relativeLuminance(of: .white) - 1.0) < 0.001)
        #expect(abs(OpenClawChatTheme.relativeLuminance(of: .black) - 0.0) < 0.001)
    }
}
