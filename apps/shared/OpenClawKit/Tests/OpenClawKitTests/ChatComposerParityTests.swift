import Foundation
import Testing
@testable import OpenClawChatUI

private final class ComposerParityTransport: @unchecked Sendable, OpenClawChatTransport {
    private let lock = NSLock()
    private var sentMessagesStorage: [String] = []

    var sentMessages: [String] {
        self.lock.withLock { self.sentMessagesStorage }
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        OpenClawChatHistoryPayload(
            sessionKey: sessionKey,
            sessionId: nil,
            messages: [],
            thinkingLevel: "off")
    }

    func sendMessage(
        sessionKey _: String,
        message: String,
        thinking _: String,
        idempotencyKey: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        self.lock.withLock { self.sentMessagesStorage.append(message) }
        return OpenClawChatSendResponse(runId: idempotencyKey, status: "started")
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { $0.finish() }
    }
}

struct ChatReplyQuoteTests {
    @Test func `single line quote matches web fixture and escapes attribution`() {
        let target = OpenClawChatReplyTarget(
            messageID: UUID(),
            text: "quoted body",
            senderLabel: "A *B* [C]")

        #expect(ChatReplyQuote.prepend(message: "continue", replyTarget: target) ==
            "> **A \\*B\\* \\[C\\]:** quoted body\n\ncontinue")
    }

    @Test func `multiline quote prefixes every line including blanks`() {
        let target = OpenClawChatReplyTarget(
            messageID: UUID(),
            text: "first\n\nthird",
            senderLabel: "Assistant")

        #expect(ChatReplyQuote.prepend(message: "continue", replyTarget: target) ==
            "> **Assistant:**\n> first\n> \n> third\n\ncontinue")
    }

    @Test func `reply capture and preview truncate without splitting surrogate pair`() {
        #expect(ChatReplyQuote.targetText(String(repeating: "x", count: 499) + "🧠tail") ==
            String(repeating: "x", count: 499))
        let preview = ChatReplyQuote.previewText(String(repeating: "x", count: 119) + "🧠tail")
        #expect(preview.text == String(repeating: "x", count: 119))
        #expect(preview.isTruncated)
    }

    @Test func `attachment only reply matches web empty prompt suffix`() {
        let target = OpenClawChatReplyTarget(
            messageID: UUID(),
            text: "quoted body",
            senderLabel: "User")

        #expect(ChatReplyQuote.prepend(message: "", replyTarget: target) ==
            "> **User:** quoted body\n\n")
    }
}

@MainActor
struct ChatComposerStateTests {
    @Test func `late send does not consume newer reply selection for same message`() {
        let vm = OpenClawChatViewModel(sessionKey: "main", transport: ComposerParityTransport())
        let messageID = UUID()
        vm.setReplyTarget(messageID: messageID, text: "first", senderLabel: "Assistant")
        let firstSelection = vm.replyTarget
        vm.setReplyTarget(messageID: messageID, text: "second", senderLabel: "Assistant")
        let secondSelection = vm.replyTarget

        vm.consumeReplyTarget(firstSelection)

        #expect(vm.replyTarget == secondSelection)
        #expect(firstSelection?.selectionID != secondSelection?.selectionID)
    }

    @Test func `session switch stashes and restores drafts`() {
        let vm = OpenClawChatViewModel(sessionKey: "main", transport: ComposerParityTransport())
        vm.input = "main draft"

        vm.switchSession(to: "other")
        #expect(vm.input == "")
        vm.input = "other draft"

        vm.switchSession(to: "main")
        #expect(vm.input == "main draft")
        vm.switchSession(to: "other")
        #expect(vm.input == "other draft")
    }

    @Test func `session switch preserves draft beneath recall and resets recall mode`() {
        let vm = OpenClawChatViewModel(sessionKey: "main", transport: ComposerParityTransport())
        vm.recordSuccessfulInput("older input", sessionKey: "main")
        vm.input = "working draft"
        #expect(vm.recallPreviousInput(caretOnFirstLine: true))
        #expect(vm.input == "older input")

        vm.switchSession(to: "other")
        vm.switchSession(to: "main")

        #expect(vm.input == "working draft")
        #expect(!vm.recallNextInput())
    }

    @Test func `active recall walks past multiline item regardless of caret line`() {
        let vm = OpenClawChatViewModel(sessionKey: "main", transport: ComposerParityTransport())
        vm.recordSuccessfulInput("older", sessionKey: "main")
        vm.recordSuccessfulInput("newer\nmultiline", sessionKey: "main")

        #expect(vm.recallPreviousInput(caretOnFirstLine: true))
        #expect(vm.input == "newer\nmultiline")
        #expect(vm.recallPreviousInput(caretOnFirstLine: false))
        #expect(vm.input == "older")
    }

    @Test func `user recall advances composer revision`() {
        let vm = OpenClawChatViewModel(sessionKey: "main", transport: ComposerParityTransport())
        vm.recordSuccessfulInput("sent", sessionKey: "main")
        vm.input = "draft"
        let revision = vm.composerRevision(for: "main")

        #expect(vm.recallPreviousInput(caretOnFirstLine: true))

        #expect(vm.composerRevision(for: "main") != revision)
    }

    @Test func `session switch clears reply target and history navigation is session scoped`() {
        let vm = OpenClawChatViewModel(sessionKey: "main", transport: ComposerParityTransport())
        vm.recordSuccessfulInput("main history", sessionKey: "main")
        vm.setReplyTarget(messageID: UUID(), text: "reply", senderLabel: "Assistant")

        vm.switchSession(to: "other")

        #expect(vm.replyTarget == nil)
        #expect(!vm.recallPreviousInput(caretOnFirstLine: true))
        vm.switchSession(to: "main")
        #expect(vm.recallPreviousInput(caretOnFirstLine: true))
        #expect(vm.input == "main history")
    }

    @Test func `accepted normal send quotes and clears reply and stored draft`() async throws {
        let transport = ComposerParityTransport()
        let vm = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        vm.healthOK = true
        vm.input = "continue"
        vm.setReplyTarget(messageID: UUID(), text: "quoted body", senderLabel: "Assistant")

        vm.send()
        try await waitUntil("quoted send accepted") { transport.sentMessages.count == 1 }
        try await waitUntil("reply consumed") { await MainActor.run { vm.replyTarget == nil && vm.input.isEmpty } }

        #expect(transport.sentMessages == ["> **Assistant:** quoted body\n\ncontinue"])
        vm.switchSession(to: "other")
        vm.switchSession(to: "main")
        #expect(vm.input.isEmpty)
    }

    @Test func `attachment staging blocks UI and programmatic sends`() async throws {
        let transport = ComposerParityTransport()
        let vm = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        vm.healthOK = true
        vm.input = "send with selected image"
        vm.beginAttachmentStaging()

        #expect(!vm.canSend)
        vm.send()
        await Task.yield()
        #expect(transport.sentMessages.isEmpty)

        vm.endAttachmentStaging()
        #expect(vm.canSend)
        vm.send()
        try await waitUntil("post-staging send accepted") { transport.sentMessages.count == 1 }
    }

    @Test func `slash send ignores and preserves reply target`() async throws {
        let transport = ComposerParityTransport()
        let vm = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        vm.healthOK = true
        let targetID = UUID()
        vm.input = "/remote-command"
        vm.setReplyTarget(messageID: targetID, text: "quoted body", senderLabel: "Assistant")

        vm.send()
        try await waitUntil("slash send accepted") { transport.sentMessages.count == 1 }

        #expect(transport.sentMessages == ["/remote-command"])
        #expect(vm.replyTarget?.messageID == targetID)
    }

    @Test func `accepted attachment only send quotes and clears reply`() async throws {
        let transport = ComposerParityTransport()
        let vm = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        vm.healthOK = true
        vm.attachments = [OpenClawPendingAttachment(
            url: nil,
            data: Data([1, 2, 3]),
            fileName: "image.png",
            mimeType: "image/png",
            preview: nil)]
        vm.setReplyTarget(messageID: UUID(), text: "quoted body", senderLabel: "User")

        vm.send()
        try await waitUntil("attachment reply accepted") { transport.sentMessages.count == 1 }
        try await waitUntil("attachment reply consumed") { await MainActor.run { vm.replyTarget == nil } }

        #expect(transport.sentMessages == ["> **User:** quoted body\n\n"])
    }
}
