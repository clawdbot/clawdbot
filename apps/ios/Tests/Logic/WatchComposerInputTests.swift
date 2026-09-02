import Foundation
import Testing

struct WatchComposerInputTests {
    @Test func `dictation skips the suggestion picker`() {
        let kind = WatchComposerInputKind.dictation

        #expect(kind.suggestions == nil)
        #expect(!kind.allowsEmoji)
        #expect(kind.speaksReply)
    }

    @Test func `typed input keeps the suggestion picker`() {
        let kind = WatchComposerInputKind.typed

        #expect(kind.suggestions == [])
        #expect(kind.allowsEmoji)
        #expect(!kind.speaksReply)
    }

    @Test(arguments: [
        (role: "assistant", text: "Hello there", clears: false),
        (role: "user", text: "Something else", clears: false),
        (role: "user", text: "  Hello there \n", clears: true),
        (role: "User", text: "Hello there", clears: true),
    ])
    func `pending transcript clears only for a matching user item`(
        _ scenario: (role: String, text: String, clears: Bool))
    {
        var pending = WatchPendingTranscript()
        pending.begin("  Hello there  ")
        let item = WatchChatItem(id: "item", role: scenario.role, text: scenario.text)

        #expect(pending.resolve(items: [item]) == scenario.clears)
        #expect((pending.text == nil) == scenario.clears)
    }

    @Test func `begin ignores blank text and clear drops the pending copy`() {
        var pending = WatchPendingTranscript()
        pending.begin("  \n")
        #expect(pending.text == nil)

        pending.begin("Hi")
        #expect(pending.text == "Hi")
        pending.clear()
        #expect(pending.text == nil)
    }
}
