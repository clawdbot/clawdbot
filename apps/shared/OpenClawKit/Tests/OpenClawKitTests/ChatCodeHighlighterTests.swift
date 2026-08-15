import Foundation
import Testing
@testable import OpenClawChatUI

struct ChatCodeHighlighterTests {
    private func kinds(_ code: String, language id: String) -> [(ChatCodeTokenKind, String)] {
        guard let language = ChatCodeHighlighter.language(for: id) else { return [] }
        return ChatCodeHighlighter.tokens(code: code, language: language).map { ($0.kind, $0.text) }
    }

    @Test func `swift tokens classify keyword string comment number`() {
        let tokens = self.kinds("let x = \"hi\" // note 42\nreturn 7", language: "swift")
        #expect(tokens.contains(where: { $0.0 == .keyword && $0.1 == "let" }))
        #expect(tokens.contains(where: { $0.0 == .string && $0.1 == "\"hi\"" }))
        #expect(tokens.contains(where: { $0.0 == .comment && $0.1 == "// note 42" }))
        #expect(tokens.contains(where: { $0.0 == .keyword && $0.1 == "return" }))
        #expect(tokens.contains(where: { $0.0 == .number && $0.1 == "7" }))
    }

    @Test func `tokens preserve the exact source text`() {
        let code = """
        func greet(name: String) -> String {
            // says hello
            return "hello \\(name)" + String(42)
        }
        """
        guard let language = ChatCodeHighlighter.language(for: "swift") else {
            Issue.record("missing swift profile")
            return
        }
        let joined = ChatCodeHighlighter.tokens(code: code, language: language)
            .map(\.text).joined()
        #expect(joined == code)
    }

    @Test func `python hash comment and single quotes`() {
        let tokens = self.kinds("def f():\n    return 'x'# done", language: "python")
        #expect(tokens.contains(where: { $0.0 == .keyword && $0.1 == "def" }))
        #expect(tokens.contains(where: { $0.0 == .string && $0.1 == "'x'" }))
        #expect(tokens.contains(where: { $0.0 == .comment && $0.1 == "# done" }))
    }

    @Test func `bash hash comment does not break strings`() {
        let tokens = self.kinds("echo \"# not a comment\" # real", language: "bash")
        #expect(tokens.contains(where: { $0.0 == .string && $0.1 == "\"# not a comment\"" }))
        #expect(tokens.contains(where: { $0.0 == .comment && $0.1 == "# real" }))
    }

    @Test func `bash parameter expansion hash is not a comment`() {
        let tokens = self.kinds("echo ${#items[@]} # count\ncat <# input\necho ok ># output", language: "bash")
        #expect(!tokens.contains(where: { $0.0 == .comment && $0.1.contains("items") }))
        #expect(tokens.contains(where: { $0.0 == .comment && $0.1 == "# count" }))
        #expect(tokens.contains(where: { $0.0 == .comment && $0.1 == "# input" }))
        #expect(tokens.contains(where: { $0.0 == .comment && $0.1 == "# output" }))
    }

    @Test func `swift nested block comment stays one comment token`() {
        let comment = "/* outer /* inner */ outer tail */"
        let tokens = self.kinds("\(comment) let value = 1", language: "swift")
        #expect(tokens.contains(where: { $0.0 == .comment && $0.1 == comment }))
        #expect(tokens.contains(where: { $0.0 == .keyword && $0.1 == "let" }))
    }

    @Test func `json literals are keywords`() {
        let tokens = self.kinds("{\"a\": true, \"b\": null, \"c\": 12}", language: "json")
        #expect(tokens.contains(where: { $0.0 == .keyword && $0.1 == "true" }))
        #expect(tokens.contains(where: { $0.0 == .keyword && $0.1 == "null" }))
        #expect(tokens.contains(where: { $0.0 == .number && $0.1 == "12" }))
    }

    @Test func `typescript template literal spans lines`() {
        let tokens = self.kinds("const s = `a\nb`;\nconst n = 1;", language: "typescript")
        #expect(tokens.contains(where: { $0.0 == .string && $0.1 == "`a\nb`" }))
        #expect(tokens.contains(where: { $0.0 == .keyword && $0.1 == "const" }))
    }

    @Test func `unterminated string stops at end of line`() {
        let tokens = self.kinds("let s = \"open\nlet y = 2", language: "swift")
        #expect(tokens.contains(where: { $0.0 == .string && $0.1 == "\"open" }))
        #expect(tokens.count(where: { $0.0 == .keyword && $0.1 == "let" }) == 2)
    }

    @Test func `identifiers with digits are not numbers`() {
        let tokens = self.kinds("let value2 = 3", language: "swift")
        #expect(!tokens.contains(where: { $0.0 == .number && $0.1.contains("2") && $0.1 != "3" }))
        #expect(tokens.contains(where: { $0.0 == .number && $0.1 == "3" }))
    }

    @Test func `unknown language passes through unstyled`() {
        let attributed = ChatCodeHighlighter.attributedCode("SELECT *", languageId: "sql")
        #expect(String(attributed.characters) == "SELECT *")
        #expect(ChatCodeHighlighter.language(for: "sql") == nil)
    }

    @Test @MainActor func `highlight cache returns identical content`() {
        let code = "let answer = 42 // memoized"
        let first = ChatCodeHighlightCache.highlighted(code: code, languageId: "swift")
        let second = ChatCodeHighlightCache.highlighted(code: code, languageId: "swift")
        #expect(first == second)
        #expect(String(first.characters) == code)
    }

    @Test @MainActor func `oversized blocks bypass highlighting unchanged`() {
        let code = String(repeating: "let value = 1\n", count: ChatCodeHighlighter.maxHighlightedLines)
        let highlighted = ChatCodeHighlightCache.highlighted(code: code, languageId: "swift")
        #expect(String(highlighted.characters) == code)
        #expect(!ChatCodeHighlighter.isWithinHighlightLimits(code))
    }
}
