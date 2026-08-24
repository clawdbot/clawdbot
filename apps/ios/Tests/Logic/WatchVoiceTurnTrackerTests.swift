import Foundation
import Testing

struct WatchVoiceTurnTrackerTests {
    @Test func `waits for matching completed voice command`() {
        var tracker = WatchVoiceTurnTracker()
        tracker.begin(commandId: "voice-command")

        #expect(tracker.takeReply(completedCommandId: "other-command", text: "Other reply") == nil)
        #expect(tracker.isAwaitingReply)
        #expect(tracker.takeReply(completedCommandId: "voice-command", text: "New reply") == "New reply")
        #expect(!tracker.isAwaitingReply)
    }

    @Test func `ignores empty assistant messages until readable reply arrives`() {
        var tracker = WatchVoiceTurnTracker()
        tracker.begin(commandId: "voice-command")

        #expect(tracker.takeReply(completedCommandId: "voice-command", text: "  \n") == nil)
        #expect(tracker.isAwaitingReply)
        #expect(tracker.takeReply(completedCommandId: "voice-command", text: "  Ready.  ") == "Ready.")
    }

    @Test func `canceled turn does not speak later assistant message`() {
        var tracker = WatchVoiceTurnTracker()
        tracker.begin(commandId: "voice-command")
        tracker.cancel()

        #expect(tracker.takeReply(completedCommandId: "voice-command", text: "Later reply") == nil)
    }

    @Test func `restored turn accepts its matching completion`() throws {
        var state = WatchVoiceTurnState()
        state.begin(commandId: "voice-command", nowMs: 1000)

        let restored = try JSONDecoder().decode(
            WatchVoiceTurnState.self,
            from: JSONEncoder().encode(state))
        var resumed = restored
        resumed.receive(
            WatchChatCompletionMessage(
                commandId: "voice-command",
                replyText: "Restored reply",
                sentAtMs: 2000),
            nowMs: 2000)

        #expect(resumed.takeReply(nowMs: 2000) == "Restored reply")
        #expect(!resumed.isAwaitingReply)
    }

    @Test func `unrelated and older completions cannot replace current reply`() {
        var state = WatchVoiceTurnState()
        state.begin(commandId: "voice-command", nowMs: 1000)
        state.receive(
            WatchChatCompletionMessage(
                commandId: "other-command",
                replyText: "Wrong reply",
                sentAtMs: 3000),
            nowMs: 3000)
        state.receive(
            WatchChatCompletionMessage(
                commandId: "voice-command",
                replyText: "Current reply",
                sentAtMs: 2000),
            nowMs: 3000)
        state.receive(
            WatchChatCompletionMessage(
                commandId: "voice-command",
                replyText: "Older reply",
                sentAtMs: 1500),
            nowMs: 3000)

        #expect(state.takeReply(nowMs: 3000) == "Current reply")
    }

    @Test func `restored turn keeps its original timeout deadline`() throws {
        var state = WatchVoiceTurnState()
        state.begin(commandId: "voice-command", nowMs: 1000)

        var restored = try JSONDecoder().decode(
            WatchVoiceTurnState.self,
            from: JSONEncoder().encode(state))

        #expect(restored.remainingTimeoutMs(nowMs: 80000) == 11000)
        restored.expireIfNeeded(nowMs: 91000)
        #expect(!restored.isAwaitingReply)
        #expect(restored.remainingTimeoutMs(nowMs: 91000) == nil)
    }
}
