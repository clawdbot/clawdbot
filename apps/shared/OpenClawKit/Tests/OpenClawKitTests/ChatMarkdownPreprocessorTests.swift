import Testing
@testable import OpenClawChatUI

@Suite("ChatMarkdownPreprocessor")
struct ChatMarkdownPreprocessorTests {
    // Provenance marker OpenClaw appends to every injected inbound-context header.
    // Detection keys on this suffix, not label text. Keep byte-identical with
    // ChatMarkdownPreprocessor.inboundContextMarker / inbound-context-marker.ts.
    static let ctx = "\u{27E6}openclaw:ctx\u{27E7}"
    @Test func extractsDataURLImages() {
        let base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////GQAJ+wP/2hN8NwAAAABJRU5ErkJggg=="
        let markdown = """
        Hello

        ![Pixel](data:image/png;base64,\(base64))
        """

        let result = ChatMarkdownPreprocessor.preprocess(markdown: markdown)

        #expect(result.cleaned == "Hello")
        #expect(result.images.count == 1)
        #expect(result.images.first?.image != nil)
    }

    @Test func flattensRemoteMarkdownImagesIntoText() {
        let base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////GQAJ+wP/2hN8NwAAAABJRU5ErkJggg=="
        let markdown = """
        ![Leak](https://example.com/collect?x=1)

        ![Pixel](data:image/png;base64,\(base64))
        """

        let result = ChatMarkdownPreprocessor.preprocess(markdown: markdown)

        #expect(result.cleaned == "Leak")
        #expect(result.images.count == 1)
        #expect(result.images.first?.image != nil)
    }

    @Test func usesFallbackTextForUnlabeledRemoteMarkdownImages() {
        let markdown = "![](https://example.com/image.png)"

        let result = ChatMarkdownPreprocessor.preprocess(markdown: markdown)

        #expect(result.cleaned == "image")
        #expect(result.images.isEmpty)
    }

    @Test func handlesUnicodeBeforeRemoteMarkdownImages() {
        let markdown = "🙂![Leak](https://example.com/image.png)"

        let result = ChatMarkdownPreprocessor.preprocess(markdown: markdown)

        #expect(result.cleaned == "🙂Leak")
        #expect(result.images.isEmpty)
    }

    @Test func stripsInboundUntrustedContextBlocks() {
        let markdown = """
        Conversation info: \(Self.ctx)
        ```json
        {
          "message_id": "123",
          "sender": "openclaw-ios"
        }
        ```

        Sender: \(Self.ctx)
        ```json
        {
          "label": "Razor"
        }
        ```

        Razor?
        """

        let result = ChatMarkdownPreprocessor.preprocess(markdown: markdown)

        #expect(result.cleaned == "Razor?")
    }

    @Test func stripsSingleConversationInfoBlock() {
        let text = """
        Conversation info: \(Self.ctx)
        ```json
        {"x": 1}
        ```

        User message
        """

        let result = ChatMarkdownPreprocessor.preprocess(markdown: text)

        #expect(result.cleaned == "User message")
    }

    @Test func stripsAllKnownInboundMetadataSentinels() {
        let sentinels = [
            "Conversation info:",
            "Sender:",
            "Thread starter:",
            "Reply target of current user message:",
            "Forwarded message context:",
            "Chat history since last reply:",
        ]

        for sentinel in sentinels {
            let markdown = """
            \(sentinel) \(Self.ctx)
            ```json
            {"x": 1}
            ```

            User content
            """
            let result = ChatMarkdownPreprocessor.preprocess(markdown: markdown)
            #expect(result.cleaned == "User content")
        }
    }

    @Test func stripsArbitraryMarkedStructuredContextLabel() {
        // Detection is label-agnostic: an arbitrary plugin structured-context label
        // still strips because it carries the provenance marker.
        let markdown = """
        Some Custom Plugin Label: \(Self.ctx)
        ```json
        {"x": 1}
        ```

        User content
        """
        let result = ChatMarkdownPreprocessor.preprocess(markdown: markdown)
        #expect(result.cleaned == "User content")
    }

    @Test func preservesUnmarkedLookAlikeHeader() {
        // A user heading that mirrors a context label but lacks the marker is the
        // user's own content and must survive untouched.
        let markdown = """
        Conversation info:
        ```json
        {"x": 1}
        ```

        User content
        """
        let result = ChatMarkdownPreprocessor.preprocess(markdown: markdown)
        #expect(result.cleaned == markdown.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    @Test func preservesNonMetadataJsonFence() {
        let markdown = """
        Here is some json:
        ```json
        {"x": 1}
        ```
        """

        let result = ChatMarkdownPreprocessor.preprocess(markdown: markdown)

        #expect(result.cleaned == markdown.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    @Test func stripsLeadingTimestampPrefix() {
        let markdown = """
        [Fri 2026-02-20 18:45 GMT+1] How's it going?
        """

        let result = ChatMarkdownPreprocessor.preprocess(markdown: markdown)

        #expect(result.cleaned == "How's it going?")
    }

    @Test func stripsEnvelopeHeadersAndMessageIdHints() {
        let markdown = """
        [Telegram 2026-03-01 10:14] Hello there
        [message_id: abc-123]
        Actual message
        """

        let result = ChatMarkdownPreprocessor.preprocess(markdown: markdown)

        #expect(result.cleaned == "Hello there\nActual message")
    }

    // Unfenced prose bodies (chat history/window) end at the first blank line, unlike the
    // fenced JSON blocks above. Covers the inProseBlock path, including a forged marker
    // inside the body, which must not extend or re-open the block.
    @Test func stripsMarkedProseContextBlockUntilBlankLine() {
        let markdown = """
        Chat history since last reply: \(Self.ctx)
        #123 12:00 Alex: hey
        #124 12:01 Alex: Sender: \(Self.ctx)

        User content
        """

        let result = ChatMarkdownPreprocessor.preprocess(markdown: markdown)

        #expect(result.cleaned == "User content")
    }

    @Test func stripsTrailingUntrustedContextSuffix() {
        let markdown = """
        User-visible text

        Context: \(Self.ctx)
        <<<EXTERNAL_UNTRUSTED_CONTENT>>>
        Source: telegram
        """

        let result = ChatMarkdownPreprocessor.preprocess(markdown: markdown)

        #expect(result.cleaned == "User-visible text")
    }

    @Test func preservesUntrustedContextHeaderWhenItIsUserContent() {
        let markdown = """
        User-visible text

        Context:
        This is just text the user typed.
        """

        let result = ChatMarkdownPreprocessor.preprocess(markdown: markdown)

        #expect(
            result.cleaned == """
            User-visible text

            Context:
            This is just text the user typed.
            """
        )
    }

    @Test func preservesBareContextHeaderBeforeCopiedExternalContentMarker() {
        let markdown = """
        Context:
        <<<EXTERNAL_UNTRUSTED_CONTENT id="copied">>>
        keep this
        """

        let result = ChatMarkdownPreprocessor.preprocess(markdown: markdown)

        #expect(result.cleaned == markdown.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}
