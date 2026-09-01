import Foundation

struct WatchVoiceTurnTracker: Codable, Equatable {
    private(set) var commandId: String?
    private(set) var isAwaitingReply = false

    mutating func begin(commandId: String) {
        self.commandId = commandId
        self.isAwaitingReply = true
    }

    mutating func takeReply(completedCommandId: String?, text: String?) -> String? {
        guard self.isAwaitingReply,
              let completedCommandId,
              completedCommandId == commandId,
              let text = text?.trimmingCharacters(in: .whitespacesAndNewlines),
              !text.isEmpty
        else {
            return nil
        }

        self.commandId = nil
        self.isAwaitingReply = false
        return text
    }

    mutating func cancel() {
        self.commandId = nil
        self.isAwaitingReply = false
    }
}

struct WatchVoiceTurnState: Codable, Equatable {
    static let timeoutMs: Int64 = 90000

    private(set) var tracker = WatchVoiceTurnTracker()
    private(set) var completion: WatchChatCompletionMessage?
    private(set) var startedAtMs: Int64?

    var isAwaitingReply: Bool {
        self.tracker.isAwaitingReply
    }

    mutating func begin(commandId: String, nowMs: Int64) {
        self.tracker.begin(commandId: commandId)
        self.completion = nil
        self.startedAtMs = nowMs
    }

    mutating func receive(_ message: WatchChatCompletionMessage, nowMs: Int64) {
        self.expireIfNeeded(nowMs: nowMs)
        guard self.tracker.isAwaitingReply,
              message.commandId == self.tracker.commandId
        else {
            return
        }
        if let current = completion {
            switch (current.sentAtMs, message.sentAtMs) {
            case let (currentSentAtMs?, incomingSentAtMs?) where incomingSentAtMs < currentSentAtMs:
                return
            case (_?, nil):
                return
            default:
                break
            }
        }
        self.completion = message
    }

    mutating func takeReply(nowMs: Int64) -> String? {
        self.expireIfNeeded(nowMs: nowMs)
        guard let completion,
              let reply = tracker.takeReply(
                  completedCommandId: completion.commandId,
                  text: completion.replyText)
        else {
            return nil
        }
        self.completion = nil
        self.startedAtMs = nil
        return reply
    }

    mutating func cancel() {
        self.tracker.cancel()
        self.completion = nil
        self.startedAtMs = nil
    }

    mutating func expireIfNeeded(nowMs: Int64) {
        guard self.tracker.isAwaitingReply,
              let startedAtMs,
              nowMs >= startedAtMs,
              nowMs - startedAtMs >= Self.timeoutMs
        else {
            return
        }
        self.cancel()
    }

    func remainingTimeoutMs(nowMs: Int64) -> Int64? {
        guard self.tracker.isAwaitingReply, let startedAtMs else { return nil }
        let elapsedMs = max(0, nowMs - startedAtMs)
        return max(0, Self.timeoutMs - elapsedMs)
    }

    static func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }
}

#if os(watchOS)
extension WatchInboxStore {
    var chatCompletion: WatchChatCompletionMessage? {
        self.voiceTurnState.completion
    }

    var isAwaitingVoiceReply: Bool {
        self.voiceTurnState.isAwaitingReply
    }

    func consume(chatCompletion message: WatchChatCompletionMessage) {
        let previousState = self.voiceTurnState
        self.voiceTurnState.receive(message, nowMs: WatchVoiceTurnState.nowMs())
        guard self.voiceTurnState != previousState else { return }
        self.persistVoiceTurnState()
    }

    func beginVoiceTurn(commandId: String) {
        self.voiceTurnState.begin(commandId: commandId, nowMs: WatchVoiceTurnState.nowMs())
        self.persistVoiceTurnState()
    }

    func takeVoiceReply() -> String? {
        let previousState = self.voiceTurnState
        let reply = self.voiceTurnState.takeReply(nowMs: WatchVoiceTurnState.nowMs())
        if self.voiceTurnState != previousState {
            self.persistVoiceTurnState()
        }
        return reply
    }

    func cancelVoiceTurn() {
        guard self.voiceTurnState.isAwaitingReply || self.voiceTurnState.completion != nil else { return }
        self.voiceTurnState.cancel()
        self.persistVoiceTurnState()
    }

    func voiceReplyTimeoutNanoseconds() -> UInt64? {
        let previousState = self.voiceTurnState
        let nowMs = WatchVoiceTurnState.nowMs()
        self.voiceTurnState.expireIfNeeded(nowMs: nowMs)
        if self.voiceTurnState != previousState {
            self.persistVoiceTurnState()
        }
        guard let remainingMs = self.voiceTurnState.remainingTimeoutMs(nowMs: nowMs) else {
            return nil
        }
        return UInt64(remainingMs) * 1_000_000
    }
}
#endif
