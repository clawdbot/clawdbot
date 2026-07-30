import Foundation
import Testing
@testable import OpenClawChatUI

struct ChatMarkdownDisplayPreprocessorTests {
    @Test func `converts plain chat soft breaks to markdown hard breaks`() throws {
        let markdown = """
        alpha
        beta
        gamma
        """

        let prepared = ChatMarkdownDisplayPreprocessor.preserveChatSoftBreaks(in: markdown)

        #expect(
            prepared == """
            alpha  
            beta  
            gamma
            """)
        #expect(try self.renderedCharacters(prepared) == "alpha\nbeta\ngamma")
    }

    @Test func `keeps blank line paragraph boundaries`() {
        let markdown = """
        alpha

        beta
        """

        let prepared = ChatMarkdownDisplayPreprocessor.preserveChatSoftBreaks(in: markdown)

        #expect(prepared == markdown)
    }

    @Test func `does not duplicate existing hard breaks`() {
        let markdown = """
        alpha  
        beta\\
        gamma
        """

        let prepared = ChatMarkdownDisplayPreprocessor.preserveChatSoftBreaks(in: markdown)

        #expect(prepared == markdown)
    }

    // Fenced code and table handling moved to ChatMarkdownBlockSegmenter,
    // which strips those blocks before prose reaches this preprocessor; see
    // ChatMarkdownBlockSegmenterTests.

    @Test func `preserves block markdown structure`() {
        let markdown = """
        Intro
        - item one
        - item two

        # Heading
        > quote
        """

        let prepared = ChatMarkdownDisplayPreprocessor.preserveChatSoftBreaks(in: markdown)

        #expect(prepared == markdown)
    }

    @Test func `does not alter fenced code kept on the prose path`() {
        let markdown = """
        [docs][d]

        ```swift
        let value = 1
        ```

        [d]: https://example.com
        """

        #expect(ChatMarkdownDisplayPreprocessor.preserveChatSoftBreaks(in: markdown) == markdown)
    }

    @Test func `does not alter nested fenced code`() {
        let markdown = """
        - item
          ```swift
          let value = 1
          ```
          continuation
        """

        #expect(ChatMarkdownDisplayPreprocessor.preserveChatSoftBreaks(in: markdown) == markdown)
    }

    @Test func `converts plain pipe prose soft breaks`() {
        let markdown = """
        Use foo | bar
        then continue
        """

        let prepared = ChatMarkdownDisplayPreprocessor.preserveChatSoftBreaks(in: markdown)

        #expect(
            prepared == """
            Use foo | bar  
            then continue
            """)
    }

    private func renderedCharacters(_ markdown: String) throws -> String {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .full,
            failurePolicy: .returnPartiallyParsedIfPossible)
        let attributed = try AttributedString(markdown: markdown, options: options)
        return String(attributed.characters)
    }
}
