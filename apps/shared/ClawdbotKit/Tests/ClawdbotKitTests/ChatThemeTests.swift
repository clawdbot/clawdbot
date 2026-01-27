import Foundation
import Testing
@testable import MoltbotChatUI

#if os(macOS)
import AppKit
#endif

#if os(macOS)
private func luminance(_ color: NSColor) throws -> CGFloat {
    let rgb = try #require(color.usingColorSpace(.deviceRGB))
    return 0.2126 * rgb.redComponent + 0.7152 * rgb.greenComponent + 0.0722 * rgb.blueComponent
}
#endif

@Suite struct ChatThemeTests {
    @Test func assistantBubbleResolvesForLightAndDark() throws {
        #if os(macOS)
        let lightAppearance = try #require(NSAppearance(named: .aqua))
        let darkAppearance = try #require(NSAppearance(named: .darkAqua))

        let lightResolved = MoltbotChatTheme.resolvedAssistantBubbleColor(for: lightAppearance)
        let darkResolved = MoltbotChatTheme.resolvedAssistantBubbleColor(for: darkAppearance)
        #expect(try luminance(lightResolved) > luminance(darkResolved))
        #else
        #expect(Bool(true))
        #endif
    }
}
