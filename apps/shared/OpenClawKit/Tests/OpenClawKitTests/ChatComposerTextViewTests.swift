#if os(macOS)
import AppKit
import Testing
@testable import OpenClawChatUI

@Suite
@MainActor
struct ChatComposerTextViewTests {
    @Test func configuredComposerTextViewEnablesUndo() {
        let textView = ChatComposerTextViewFactory.makeConfiguredTextView()

        #expect(textView.allowsUndo)
    }
}

@Suite
struct ChatComposerKeyRoutingTests {
    @Test func mapsInterceptableNavigationKeys() {
        #expect(ChatComposerKeyRouting.command(keyCode: 126, modifierFlags: [], hasMarkedText: false) == .moveUp)
        #expect(ChatComposerKeyRouting.command(keyCode: 125, modifierFlags: [], hasMarkedText: false) == .moveDown)
        #expect(ChatComposerKeyRouting.command(keyCode: 48, modifierFlags: [], hasMarkedText: false) == .tab)
        #expect(ChatComposerKeyRouting.command(keyCode: 53, modifierFlags: [], hasMarkedText: false) == .escape)
        #expect(ChatComposerKeyRouting.command(keyCode: 36, modifierFlags: [], hasMarkedText: false) == .returnKey)
    }

    @Test func ignoresModifiedKeysAndIMEComposition() {
        // Shift-Return must stay a newline and Cmd-arrows must stay text
        // navigation; IME composition owns Return while marked text exists.
        #expect(ChatComposerKeyRouting.command(keyCode: 36, modifierFlags: [.shift], hasMarkedText: false) == nil)
        #expect(ChatComposerKeyRouting.command(keyCode: 126, modifierFlags: [.command], hasMarkedText: false) == nil)
        #expect(ChatComposerKeyRouting.command(keyCode: 36, modifierFlags: [], hasMarkedText: true) == nil)
        #expect(ChatComposerKeyRouting.command(keyCode: 0, modifierFlags: [], hasMarkedText: false) == nil)
    }
}
#endif
