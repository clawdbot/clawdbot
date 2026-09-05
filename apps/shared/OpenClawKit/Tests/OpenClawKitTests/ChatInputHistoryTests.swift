import Foundation
import Testing
@testable import OpenClawChatUI
#if os(macOS)
import AppKit
#endif

struct ChatInputHistoryTests {
    @Test func `up walks newest to oldest and down restores draft`() {
        var history = ChatInputHistory()
        history.record("first")
        history.record("second")

        #expect(history.previous(draft: "working draft") == "second")
        #expect(history.previous(draft: "ignored while recalling") == "first")
        #expect(history.previous(draft: "ignored") == nil)
        #expect(history.next() == "second")
        #expect(history.next() == "working draft")
        #expect(history.next() == nil)
        #expect(!history.isRecalling)
    }

    @Test func `escape restores draft and boundaries do not move`() {
        var history = ChatInputHistory()
        #expect(history.previous(draft: "draft") == nil)
        history.record("sent")
        #expect(history.next() == nil)
        #expect(history.previous(draft: "draft") == "sent")
        #expect(history.previous(draft: "draft") == nil)
        #expect(history.cancel() == "draft")
        #expect(history.cancel() == nil)
    }

    @Test func `consecutive duplicates collapse but separated duplicates remain`() {
        var history = ChatInputHistory()
        history.record("same")
        history.record(" same \n")
        history.record("different")
        history.record("same")

        #expect(history.entries == ["same", "different", "same"])
    }

    @Test func `history is capped at one hundred entries`() {
        var history = ChatInputHistory()
        for index in 0...100 {
            history.record("entry-\(index)")
        }

        #expect(history.entries.count == 100)
        #expect(history.entries.first == "entry-100")
        #expect(history.entries.last == "entry-1")
    }

    @Test func `transcript seed retains non transcript command capture`() {
        var history = ChatInputHistory()
        history.seed(transcriptInputs: ["hello", "answer this"])
        history.record("/compact")
        history.seed(transcriptInputs: ["hello", "answer this"])

        #expect(history.entries == ["/compact", "answer this", "hello"])
    }

    @Test func `transcript refresh preserves recall draft and cursor`() {
        var history = ChatInputHistory()
        history.seed(transcriptInputs: ["older"])
        #expect(history.previous(draft: "working draft") == "older")

        history.seed(transcriptInputs: ["older", "new from elsewhere"])

        #expect(history.cancel() == "working draft")
    }

    @Test func `late successful input preserves active recall draft`() {
        var history = ChatInputHistory()
        history.record("older")
        #expect(history.previous(draft: "working draft") == "older")

        history.record("newly accepted")

        #expect(history.cancel() == "working draft")
        #expect(history.entries == ["newly accepted", "older"])
    }

    @Test func `transcript echoes do not displace local command chronology`() {
        var history = ChatInputHistory()
        history.seed(transcriptInputs: ["older"])
        history.record("/compact")
        history.record("hello", transcriptEcho: "hello")

        history.seed(transcriptInputs: ["older", "hello"])

        #expect(history.entries == ["hello", "/compact", "older"])
    }

    @Test func `generated transport text stays out of history`() {
        var history = ChatInputHistory()
        history.seed(transcriptInputs: ["older"])
        history.record("continue", transcriptEcho: "> **Assistant:** quote\n\ncontinue")
        history.record("", transcriptEcho: "See attached.")

        history.seed(transcriptInputs: [
            "older",
            "> **Assistant:** quote\n\ncontinue",
            "See attached.",
        ])

        #expect(history.entries == ["continue", "older"])
    }

    @Test func `generated transcript echo arriving before acceptance is reconciled`() {
        var history = ChatInputHistory()
        let generated = "> **Assistant:** quote\n\ncontinue"
        history.seed(transcriptInputs: ["older", generated])

        history.record("continue", transcriptEcho: generated)

        #expect(history.entries == ["continue", "older"])
    }

    @Test func `transcript rollback and prepend do not duplicate entries`() {
        var history = ChatInputHistory()
        history.seed(transcriptInputs: ["one", "two"])
        history.seed(transcriptInputs: ["one"])
        #expect(history.entries == ["two", "one"])

        history.seed(transcriptInputs: ["zero", "one"])
        #expect(history.entries == ["two", "one", "zero"])
    }

    @Test func `rollback restore after local command does not duplicate entries`() {
        var history = ChatInputHistory()
        history.seed(transcriptInputs: ["one", "two"])
        history.record("/compact")
        history.seed(transcriptInputs: ["one"])
        history.seed(transcriptInputs: ["one", "two"])

        #expect(history.entries == ["two", "/compact", "one"])
    }

    @Test func `late acceptance retires a stash holding the sent text`() {
        var history = ChatInputHistory()
        history.record("older")
        #expect(history.previous(draft: "sent me") == "older")

        history.record("sent me")

        #expect(history.cancel() == "")
    }

    @Test func `late acceptance keeps a genuinely newer stashed draft`() {
        var history = ChatInputHistory()
        history.record("older")
        #expect(history.previous(draft: "newer unsent draft") == "older")

        history.record("sent me")

        #expect(history.cancel() == "newer unsent draft")
    }

    @Test func `recall marker stays on the same duplicate after an identical prepend`() {
        var history = ChatInputHistory()
        history.record("dup")
        history.record("x")
        #expect(history.previous(draft: "") == "x")
        #expect(history.previous(draft: "") == "dup")

        history.record("dup")

        #expect(history.entries == ["dup", "x", "dup"])
        // Cursor still points at the oldest "dup": one step newer is "x".
        #expect(history.next() == "x")
    }

    @Test func `manual edit exits recall without overwriting stashed draft`() {
        var history = ChatInputHistory()
        history.record("sent")
        #expect(history.previous(draft: "draft") == "sent")

        history.draftChanged(to: "edited recalled value")

        #expect(!history.isRecalling)
        #expect(history.stashedDraft == nil)
    }
}

#if os(macOS)
struct ChatInputHistoryKeyContextTests {
    @Test func `first line requires insertion caret before newline`() {
        #expect(ChatComposerKeyCommandContext.resolve(
            text: "first\nsecond",
            selectedRange: NSRange(location: 3, length: 0)).caretOnFirstLine)
        #expect(!ChatComposerKeyCommandContext.resolve(
            text: "first\nsecond",
            selectedRange: NSRange(location: 8, length: 0)).caretOnFirstLine)
        #expect(!ChatComposerKeyCommandContext.resolve(
            text: "first",
            selectedRange: NSRange(location: 0, length: 2)).caretOnFirstLine)
    }

    @Test func `shift up remains native text selection`() {
        #expect(ChatComposerKeyRouting.command(
            keyCode: 126,
            modifierFlags: [.shift],
            hasMarkedText: false) == nil)
    }
}
#endif
