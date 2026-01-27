import Testing
@testable import MoltbotChatUI

@Suite("ChatMarkdownPreprocessor")
struct ChatMarkdownPreprocessorTests {
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
}
