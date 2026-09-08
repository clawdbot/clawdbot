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
    }

    @Test func registeredReturnCommandsSendOnlyForBareAndCommandModifiers() throws {
        let textView = ChatComposerTextViewIOSFactory.makeConfiguredTextView()
        var sendCalls = 0
        textView.onSend = { sendCalls += 1 }

        let sendAction = #selector(ChatComposerUITextView.handleSendKeyCommand(_:))
        let commands = try #require(textView.keyCommands)
        let sendCommands = commands.filter { $0.action == sendAction }
        #expect(sendCommands.count == 4)
        #expect(sendCommands.compactMap(\.input) == ["\r", "\r", "\r", "\r"])
        #expect(
            sendCommands.map(\.modifierFlags) == [
                [],
                .command,
                .numericPad,
                [.command, .numericPad],
            ])
        for command in sendCommands {
            #expect(command.wantsPriorityOverSystemBehavior)
            textView.handleSendKeyCommand(command)
        }
        #expect(sendCalls == 4)
    }

    @Test func physicalReturnPreservesMarkedTextUntilCompositionCompletes() throws {
        let textView = ChatComposerTextViewIOSFactory.makeConfiguredTextView()
        var sendCalls = 0
        textView.onSend = { sendCalls += 1 }
        textView.setMarkedText("draft", selectedRange: NSRange(location: 5, length: 0))

        #expect(textView.markedTextRange != nil)
        let sendAction = #selector(ChatComposerUITextView.handleSendKeyCommand(_:))
        #expect(textView.keyCommands?.contains { $0.action == sendAction } == false)
        #expect(
            !textView.canPerformAction(
                sendAction,
                withSender: nil))
        textView.handleSendKeyCommand(
            UIKeyCommand(
                input: "\r",
                modifierFlags: [],
                action: #selector(ChatComposerUITextView.handleSendKeyCommand(_:))))
        #expect(sendCalls == 0)
        #expect(textView.text == "draft")

        textView.unmarkText()
        let commands = try #require(textView.keyCommands)
        let sendCommand = try #require(commands.first { $0.action == sendAction })
        #expect(commands.filter { $0.action == sendAction }.count == 4)
        #expect(textView.canPerformAction(sendAction, withSender: nil))
        textView.handleSendKeyCommand(sendCommand)
        #expect(sendCalls == 1)
    }
}
#endif
