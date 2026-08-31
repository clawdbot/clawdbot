import Testing
@testable import OpenClawChatUI

struct ChatMarkdownRendererTests {
    @Test @MainActor func `streaming disclosure body stays directly renderable`() throws {
        let snapshot = ChatMarkdownRenderSnapshot(
            text: """
            <details>
            <summary>More detail</summary>

            I'm here to help with questions, projects, and practical tasks.

            - Clear answers
            - Thoughtful assistance

            ```bash
            echo "Hello"
            ```

            </details>
            """,
            isComplete: false,
            preparesReveal: true)
        guard case let .disclosure(disclosure) = try #require(snapshot.blocks.first) else {
            Issue.record("expected rendered disclosure")
            return
        }

        #expect(String(disclosure.summary.attributed.characters) == "More detail")
        #expect(disclosure.blocks.count == 2)

        guard case let .prose(prose) = disclosure.blocks[0] else {
            Issue.record("expected renderable disclosure prose")
            return
        }
        let proseText = String(prose.attributed.characters)
        #expect(proseText.contains("I'm here to help with questions, projects, and practical tasks."))
        #expect(proseText.contains("Clear answers"))
        #expect(proseText.contains("Thoughtful assistance"))
        #expect(prose.plainText.isEmpty)
        #expect(prose.prefix.characters.isEmpty)
        #expect(prose.tail.isEmpty)

        guard case let .code(code) = disclosure.blocks[1] else {
            Issue.record("expected rendered disclosure code block")
            return
        }
        #expect(code.language == "bash")
        #expect(code.code == "echo \"Hello\"")
    }
}
