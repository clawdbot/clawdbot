#if os(iOS)
import Testing
import UIKit
@testable import OpenClawChatUI

@Suite
@MainActor
struct ChatComposerTextViewIOSTests {
    @Test func configuredComposerUsesNativeMultilineInput() {
        let textView = ChatComposerTextViewIOSFactory.makeConfiguredTextView()

        #expect(textView.isEditable)
        #expect(textView.isSelectable)
        #expect(!textView.allowsEditingTextAttributes)
        #expect(textView.returnKeyType == .default)
        #expect(textView.textContainerInset == .zero)
        #expect(textView.textContainer.lineFragmentPadding == 0)
        #expect(textView.accessibilityIdentifier == "chat-message-input")
    }

    @Test func returnInsertionRespectsCaretAndSelection() {
        let textView = ChatComposerTextViewIOSFactory.makeConfiguredTextView()
        textView.text = "firstsecond"
        textView.selectedRange = NSRange(location: 5, length: 0)

        textView.insertText("\n")

        #expect(textView.text == "first\nsecond")
        #expect(textView.selectedRange == NSRange(location: 6, length: 0))

        textView.selectedRange = NSRange(location: 0, length: 5)
        textView.insertText("\n")

        #expect(textView.text == "\n\nsecond")
        #expect(textView.selectedRange == NSRange(location: 1, length: 0))
    }

    @Test func physicalArrowKeysRouteThroughTheFocusedEditor() {
        let textView = ChatComposerTextViewIOSFactory.makeConfiguredTextView()
        var upContexts: [Bool] = []
        var downCalls = 0
        textView.onHistoryUp = { caretOnFirstLine in
            upContexts.append(caretOnFirstLine)
            return true
        }
        textView.onHistoryDown = {
            downCalls += 1
            return true
        }
        textView.text = "first\nsecond"

        textView.selectedRange = NSRange(location: 2, length: 0)
        #expect(textView.handleHardwareKey(.keyboardUpArrow, modifierFlags: []))

        textView.selectedRange = NSRange(location: 8, length: 0)
        #expect(textView.handleHardwareKey(.keyboardUpArrow, modifierFlags: []))
        #expect(textView.handleHardwareKey(.keyboardDownArrow, modifierFlags: []))

        #expect(upContexts == [true, false])
        #expect(downCalls == 1)
        #expect(!textView.handleHardwareKey(.keyboardUpArrow, modifierFlags: .shift))
        #expect(textView.handleHardwareKey(.keyboardUpArrow, modifierFlags: .alphaShift))
        #expect(!textView.handleHardwareKey(.keyboardReturnOrEnter, modifierFlags: []))
    }
}
#endif
