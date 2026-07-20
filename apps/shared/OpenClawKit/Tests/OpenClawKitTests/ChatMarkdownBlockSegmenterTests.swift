import Foundation
import Testing
#if canImport(UIKit)
import SwiftUI
import UIKit
#endif
@testable import OpenClawChatUI

struct ChatMarkdownBlockSegmenterTests {
    private func segments(_ markdown: String, isComplete: Bool = true) -> [ChatMarkdownBlock] {
        ChatMarkdownBlockSegmenter.segments(markdown: markdown, isComplete: isComplete)
    }

    private func item(
        _ content: [ChatMarkdownListItemContent],
        checkbox: ChatMarkdownListItem.Checkbox? = nil) -> ChatMarkdownListItem
    {
        ChatMarkdownListItem(checkbox: checkbox, content: content)
    }

    // MARK: - Prose

    @Test func `plain prose stays one block`() {
        let blocks = self.segments("alpha\nbeta\n\ngamma")
        #expect(blocks == [.prose("alpha\nbeta\n\ngamma")])
    }

    @Test func `whitespace only input yields no blocks`() {
        #expect(self.segments("  \n\n ") == [])
    }

    @Test func `crlf input is normalized`() {
        let blocks = self.segments("alpha\r\n```\r\ncode\r\n```")
        #expect(blocks == [
            .prose("alpha"),
            .code(ChatCodeBlock(language: nil, code: "code", isComplete: true)),
        ])
    }

    // MARK: - Headings

    @Test func `all ATX heading levels become native blocks`() {
        for level in 1...6 {
            let markdown = "\(String(repeating: "#", count: level)) Heading \(level)"
            #expect(self.segments(markdown) == [
                .heading(ChatMarkdownHeading(level: level, markdown: markdown)),
            ])
        }
    }

    @Test func `Setext headings preserve their complete source`() {
        #expect(self.segments("Primary\n=======") == [
            .heading(ChatMarkdownHeading(level: 1, markdown: "Primary\n=======")),
        ])
        #expect(self.segments("Secondary\n---------") == [
            .heading(ChatMarkdownHeading(level: 2, markdown: "Secondary\n---------")),
        ])
    }

    @Test func `streaming ATX heading keeps the current source`() {
        let markdown = "### Streamed heading"
        #expect(self.segments(markdown, isComplete: false) == [
            .heading(ChatMarkdownHeading(level: 3, markdown: markdown)),
        ])
    }

    @Test func `heading keeps inline markdown source and surrounding prose`() {
        let heading = "## **Status** with `code` and [docs](https://example.com) ##"
        #expect(self.segments("before\n\n\(heading)\n\nafter") == [
            .prose("before"),
            .heading(ChatMarkdownHeading(level: 2, markdown: heading)),
            .prose("after"),
        ])
    }

    @Test func `heading nested in block quote stays prose`() {
        let markdown = "> # Quoted"
        #expect(self.segments(markdown) == [.prose(markdown)])
    }

    @Test func `heading nested in list stays attached to its item`() {
        #expect(self.segments("- # Listed") == [
            .list(ChatMarkdownList(
                kind: .unordered,
                items: [self.item([.markdown("# Listed")])])),
        ])
    }

    @Test func `reference heading keeps document scoped definition`() {
        let markdown = "# [Docs][docs]\n\n[docs]: https://example.com"
        #expect(self.segments(markdown) == [.prose(markdown)])
    }

    @Test func `heading composes with an unchanged native table`() {
        let blocks = self.segments("# Results\n\n| Name | Count |\n| --- | ---: |\n| Claw | 2 |")
        #expect(blocks == [
            .heading(ChatMarkdownHeading(level: 1, markdown: "# Results")),
            .table(ChatMarkdownTable(
                header: ["Name", "Count"],
                alignments: [.leading, .trailing],
                rows: [["Claw", "2"]])),
        ])
    }

    @Test @MainActor func `render snapshot preserves heading inline attributes`() throws {
        let snapshot = ChatMarkdownRenderSnapshot(
            text: "## **Status** and [docs](https://example.com)",
            isComplete: true)
        guard case let .heading(level, prose) = try #require(snapshot.blocks.first) else {
            Issue.record("expected heading block")
            return
        }

        #expect(level == 2)
        #expect(String(prose.attributed.characters) == "Status and docs")
        #expect(prose.attributed.runs.contains { $0.link != nil })
        #expect(prose.attributed.runs.contains {
            $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true
        })
    }

    // MARK: - Fenced code

    @Test func `fence with language and surrounding prose`() {
        let blocks = self.segments("""
        before
        ```swift
        let x = 1
        ```
        after
        """)
        #expect(blocks == [
            .prose("before"),
            .code(ChatCodeBlock(language: "swift", code: "let x = 1", isComplete: true)),
            .prose("after"),
        ])
    }

    @Test func `info string extras keep only the first word lowercased`() {
        let blocks = self.segments("```Swift title=Example.swift\nlet x = 1\n```")
        #expect(blocks == [
            .code(ChatCodeBlock(language: "swift", code: "let x = 1", isComplete: true)),
        ])
    }

    @Test func `backtick info string containing backtick is not a fence`() {
        // CommonMark: ``` foo`bar ``` is an inline code span, not a fence.
        let blocks = self.segments("``` foo`bar ```")
        #expect(blocks == [.prose("``` foo`bar ```")])
    }

    @Test func `tilde fence keeps nested backtick fences as content`() {
        let blocks = self.segments("""
        ~~~markdown
        ```swift
        let x = 1
        ```
        ~~~
        """)
        #expect(blocks == [
            .code(ChatCodeBlock(
                language: "markdown",
                code: "```swift\nlet x = 1\n```",
                isComplete: true)),
        ])
    }

    @Test func `shorter close run does not close the fence`() {
        let blocks = self.segments("````\n```\ncode\n````")
        #expect(blocks == [
            .code(ChatCodeBlock(language: nil, code: "```\ncode", isComplete: true)),
        ])
    }

    @Test func `longer close run closes the fence`() {
        let blocks = self.segments("```\ncode\n`````")
        #expect(blocks == [
            .code(ChatCodeBlock(language: nil, code: "code", isComplete: true)),
        ])
    }

    @Test func `close line with trailing text stays content`() {
        let blocks = self.segments("```text\n``` not a close\nstill code\n```")
        #expect(blocks == [
            .code(ChatCodeBlock(
                language: "text",
                code: "``` not a close\nstill code",
                isComplete: true)),
        ])
    }

    @Test func `top level indented fence remains native`() {
        let blocks = self.segments("  ```\n   code\n  ```")
        #expect(blocks == [
            .code(ChatCodeBlock(language: nil, code: " code", isComplete: true)),
        ])
    }

    @Test func `four space indent is not a fence`() {
        let markdown = "    ```\n    code"
        #expect(self.segments(markdown) == [.prose(markdown)])
    }

    @Test func `unclosed fence in complete message renders as code`() {
        let blocks = self.segments("```swift\nlet x = 1")
        #expect(blocks == [
            .code(ChatCodeBlock(language: "swift", code: "let x = 1", isComplete: true)),
        ])
    }

    // MARK: - Display math

    @Test func `same line dollar delimiters extract display math`() {
        let blocks = self.segments("before\n$$ x^2 + y^2 $$\nafter")
        #expect(blocks == [
            .prose("before"),
            .math(ChatMathBlock(latex: "x^2 + y^2", isComplete: true)),
            .prose("after"),
        ])
    }

    @Test func `own line dollar delimiters extract multiline display math`() {
        let blocks = self.segments("""
        $$
        \\begin{aligned}
        x &= 1 \\\\
        y &= 2
        \\end{aligned}
        $$
        """)
        #expect(blocks == [
            .math(ChatMathBlock(
                latex: "\\begin{aligned}\nx &= 1 \\\\\ny &= 2\n\\end{aligned}",
                isComplete: true)),
        ])
    }

    @Test func `bracket delimiters extract display math`() {
        let blocks = self.segments(#"\[\frac{a}{b}\]"#)
        #expect(blocks == [
            .math(ChatMathBlock(latex: #"\frac{a}{b}"#, isComplete: true)),
        ])
    }

    @Test func `inline math delimiters stay prose`() {
        let markdown = #"single $x$, parenthesized \(y\), and prose around $$z$$"#
        #expect(self.segments(markdown) == [.prose(markdown)])
    }

    @Test func `unclosed math while streaming stays prose`() {
        let markdown = "$$\nx + y"
        #expect(self.segments(markdown, isComplete: false) == [.prose(markdown)])
    }

    @Test func `unclosed math in complete message renders as math`() {
        let blocks = self.segments("$$\nx + y")
        #expect(blocks == [
            .math(ChatMathBlock(latex: "x + y", isComplete: true)),
        ])
    }

    @Test func `math composes with prose and fenced code blocks`() {
        let blocks = self.segments("before\n$$E = mc^2$$\n```swift\nlet value = 1\n```\nafter")
        #expect(blocks == [
            .prose("before"),
            .math(ChatMathBlock(latex: "E = mc^2", isComplete: true)),
            .code(ChatCodeBlock(language: "swift", code: "let value = 1", isComplete: true)),
            .prose("after"),
        ])
    }

    @Test func `oversized math stays raw prose`() {
        let latex = String(repeating: "x", count: ChatMarkdownBlockSegmenter.maxMathBytes + 1)
        let markdown = "$$\n\(latex)\n$$"
        #expect(self.segments(markdown) == [.prose(markdown)])
    }

    @Test func `oversized math keeps nested code fence in prose`() {
        let latex = String(repeating: "x", count: ChatMarkdownBlockSegmenter.maxMathBytes + 1)
        let markdown = "$$\n\(latex)\n```swift\nlet value = 1\n```\n$$"
        #expect(self.segments(markdown) == [.prose(markdown)])
    }

    @Test func `math delimiters inside code fences stay code`() {
        let code = "$x$\n$$\nx + y\n$$\n\\[z\\]"
        let blocks = self.segments("```tex\n\(code)\n```")
        #expect(blocks == [
            .code(ChatCodeBlock(language: "tex", code: code, isComplete: true)),
        ])
    }

    @Test func `math delimiters inside multiline code span stay prose`() {
        let markdown = "`literal\n$$ x + y $$\nend`"
        #expect(self.segments(markdown) == [.prose(markdown)])
    }

    @Test func `math delimiters inside list stay attached to their item`() {
        #expect(self.segments("- item\n  $$x + y$$") == [
            .list(ChatMarkdownList(
                kind: .unordered,
                items: [self.item([.markdown("item\n$$x + y$$")])])),
        ])
    }

    // MARK: - Lists and thematic breaks

    @Test func `issue reproduction renders ordered options as a native list`() {
        let markdown = """
        Here are the options:

        **My read of each:**

        1. **Option one heading** – a sentence describing it.
        2. **Option two heading** – another sentence.
        3. **Option three heading** – my pick, one more sentence.
        """
        #expect(self.segments(markdown) == [
            .prose("Here are the options:\n\n**My read of each:**"),
            .list(ChatMarkdownList(
                kind: .ordered(start: 1),
                items: [
                    self.item([.markdown("**Option one heading** – a sentence describing it.")]),
                    self.item([.markdown("**Option two heading** – another sentence.")]),
                    self.item([.markdown("**Option three heading** – my pick, one more sentence.")]),
                ])),
        ])
    }

    @Test func `ordered list keeps its parsed start index`() {
        #expect(self.segments("7. seven\n8. eight") == [
            .list(ChatMarkdownList(
                kind: .ordered(start: 7),
                items: [
                    self.item([.markdown("seven")]),
                    self.item([.markdown("eight")]),
                ])),
        ])
    }

    @Test func `ordered task list keeps both number and checkbox markers`() throws {
        guard case let .list(list) = try #require(self.segments("3. [ ] Pending\n4. [x] Done").first) else {
            Issue.record("expected list block")
            return
        }

        #expect(list.marker(for: list.items[0], at: 0) == ChatMarkdownListMarker(
            text: "3.",
            checkbox: .unchecked))
        #expect(list.marker(for: list.items[1], at: 1) == ChatMarkdownListMarker(
            text: "4.",
            checkbox: .checked))
    }

    @Test func `nested and task lists preserve structure and state`() {
        #expect(self.segments("- Parent\n  1. Child one\n  2. Child two\n- [x] Done\n- [ ] Pending") == [
            .list(ChatMarkdownList(
                kind: .unordered,
                items: [
                    self.item([
                        .markdown("Parent"),
                        .list(ChatMarkdownList(
                            kind: .ordered(start: 1),
                            items: [
                                self.item([.markdown("Child one")]),
                                self.item([.markdown("Child two")]),
                            ])),
                    ]),
                    self.item([.markdown("Done")], checkbox: .checked),
                    self.item([.markdown("Pending")], checkbox: .unchecked),
                ])),
        ])
    }

    @Test func `list reference links preserve their document scoped definitions`() {
        for markdown in [
            "- [Docs][docs]\n\n[docs]: https://example.com",
            "- [Docs][docs]\n\n  [docs]: https://example.com",
        ] {
            #expect(self.segments(markdown) == [.prose(markdown)])
        }
    }

    @Test func `tab indented list fence keeps its structure`() {
        #expect(self.segments("- item\n\t```swift\n\tlet value = 1\n\t```") == [
            .list(ChatMarkdownList(
                kind: .unordered,
                items: [self.item([
                    .markdown("item"),
                    .code(ChatCodeBlock(language: "swift", code: " let value = 1", isComplete: true)),
                ])])),
        ])
    }

    @Test func `tab indentation keeps columns beyond the list prefix`() {
        #expect(self.segments("- item\n  ```\n\tindented\n  ```") == [
            .list(ChatMarkdownList(
                kind: .unordered,
                items: [self.item([
                    .markdown("item"),
                    .code(ChatCodeBlock(language: nil, code: "  indented", isComplete: true)),
                ])])),
        ])
    }

    @Test func `indented code block in a list stays code`() {
        #expect(self.segments("- item\n\n      code") == [
            .list(ChatMarkdownList(
                kind: .unordered,
                items: [self.item([
                    .markdown("item"),
                    .code(ChatCodeBlock(language: nil, code: "code", isComplete: true)),
                ])])),
        ])
    }

    @Test func `top level thematic break becomes a dedicated block`() {
        #expect(self.segments("before\n\n---\n\nafter") == [
            .prose("before"),
            .thematicBreak,
            .prose("after"),
        ])
    }

    @Test func `thematic break does not consume immediately following prose`() {
        #expect(self.segments("---\nafter") == [
            .thematicBreak,
            .prose("after"),
        ])
    }

    @Test func `list does not consume an adjacent top level heading`() {
        #expect(self.segments("- item\n# Heading") == [
            .list(ChatMarkdownList(
                kind: .unordered,
                items: [self.item([.markdown("item")])])),
            .heading(ChatMarkdownHeading(level: 1, markdown: "# Heading")),
        ])
    }

    @Test func `Setext underline is not mistaken for a thematic break`() {
        #expect(self.segments("Heading\n---") == [
            .heading(ChatMarkdownHeading(level: 2, markdown: "Heading\n---")),
        ])
    }

    @Test func `trailing list and thematic break stay prose while streaming`() {
        for markdown in ["- streamed item", "---"] {
            #expect(self.segments(markdown, isComplete: false) == [.prose(markdown)])
        }
    }

    @Test func `lists stay prose while streaming and settled thematic breaks render`() {
        #expect(self.segments("- settled\n\nafter", isComplete: false) == [
            .prose("- settled\n\nafter"),
        ])
        #expect(self.segments("---\n\nafter", isComplete: false) == [
            .thematicBreak,
            .prose("after"),
        ])
    }

    @Test @MainActor func `streaming list stays one revealable prose block`() {
        let snapshot = ChatMarkdownRenderSnapshot(
            text: "- first\n- second\n\nafter",
            isComplete: false,
            preparesReveal: true)
        #expect(snapshot.blocks.count == 1)
        #expect(snapshot.lastProseIndex == 0)
        guard case .prose = snapshot.blocks[0] else {
            Issue.record("expected streaming list to remain prose")
            return
        }
    }

    @Test func `oversized and overdeep lists stay raw prose`() {
        let oversized = Array(
            repeating: "- item",
            count: ChatMarkdownBlockSegmenter.maxListItems + 1).joined(separator: "\n")
        #expect(self.segments(oversized) == [.prose(oversized)])

        let overdeep = (0...ChatMarkdownBlockSegmenter.maxListDepth)
            .map { String(repeating: "  ", count: $0) + "- level \($0)" }
            .joined(separator: "\n")
        #expect(self.segments(overdeep) == [.prose(overdeep)])
    }

    @Test @MainActor func `render snapshot exposes native list and thematic blocks`() {
        let snapshot = ChatMarkdownRenderSnapshot(
            text: "Intro\n\n- **First**\n- Second\n\n---",
            isComplete: true)
        #expect(snapshot.blocks.count == 3)
        guard case let .list(list) = snapshot.blocks[1] else {
            Issue.record("expected list block")
            return
        }
        #expect(list.items.count == 2)
        guard case .thematicBreak = snapshot.blocks[2] else {
            Issue.record("expected thematic break block")
            return
        }
    }

    @Test @MainActor func `list recursion preserves inline math typography`() throws {
        let snapshot = ChatMarkdownRenderSnapshot(
            text: "- Parent \\(x\\)\n  - Child \\(y\\)",
            isComplete: true)
        guard case let .list(list) = try #require(snapshot.blocks.first),
              case let .list(nestedList) = try #require(list.items.first?.content.last)
        else {
            Issue.record("expected nested list block")
            return
        }

        let renderer = ChatMarkdownRenderer(
            snapshot: snapshot,
            context: .assistant,
            variant: .standard,
            font: OpenClawChatTypography.callout.italic(),
            textColor: OpenClawChatTheme.assistantText,
            inlineMathTypography: .callout)
        let listView = renderer.listView(list)
        let nestedListView = listView.nestedListView(nestedList)

        #expect(renderer.inlineMathTypography == .callout)
        #expect(listView.inlineMathTypography == .callout)
        #expect(listView.markdownRenderer("Parent \\(x\\)").inlineMathTypography == .callout)
        #expect(nestedListView.inlineMathTypography == .callout)
        #expect(nestedListView.markdownRenderer("Child \\(y\\)").inlineMathTypography == .callout)
    }

    #if canImport(UIKit)
    @Test @MainActor func `native list renderer builds on iOS across appearance and type size`() {
        let markdown = """
        9. **First** option
           - Nested detail
           - [x] Completed detail
        10. Second option

        ---
        """
        var windows: [UIWindow] = []
        defer { windows.forEach { $0.isHidden = true } }

        for scheme in [ColorScheme.light, .dark] {
            let root = ChatMarkdownRenderer(
                text: markdown,
                context: .assistant,
                variant: .standard,
                font: OpenClawChatTypography.body,
                textColor: OpenClawChatTheme.assistantText)
                .environment(\.dynamicTypeSize, .accessibility2)
                .preferredColorScheme(scheme)
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 320, height: 700))
            window.rootViewController = UIHostingController(rootView: root)
            window.makeKeyAndVisible()
            window.rootViewController?.view.layoutIfNeeded()
            windows.append(window)
        }
    }
    #endif

    @Test func `unclosed streaming math leaves later opener lines as prose`() {
        let markdown = "\\[\nfirst\n\\[\nsecond"
        #expect(self.segments(markdown, isComplete: false) == [.prose(markdown)])
    }

    @Test func `unclosed streaming math keeps later code fence in prose`() {
        let markdown = "before\n$$\nx + y\n```swift\nlet value = 1\n```"
        #expect(self.segments(markdown, isComplete: false) == [.prose(markdown)])
    }

    // MARK: - Streaming fallbacks

    @Test func `unclosed fence while streaming stays plain`() {
        let blocks = self.segments("```swift\nlet x = 1", isComplete: false)
        #expect(blocks == [
            .code(ChatCodeBlock(language: "swift", code: "let x = 1", isComplete: false)),
        ])
    }

    @Test func `closed fence while streaming is complete`() {
        let blocks = self.segments("```swift\nlet x = 1\n```\nmore", isComplete: false)
        #expect(blocks == [
            .code(ChatCodeBlock(language: "swift", code: "let x = 1", isComplete: true)),
            .prose("more"),
        ])
    }

    @Test func `trailing table while streaming stays prose`() {
        let markdown = "intro\n| a | b |\n| - | - |\n| 1 | 2 |"
        #expect(self.segments(markdown, isComplete: false) == [.prose(markdown)])
    }

    @Test func `trailing table with only trailing newline while streaming stays prose`() {
        // The trailing newline is not a committed blank line: the next delta
        // may still append rows, so the table must not render rich yet.
        let markdown = "| a | b |\n| - | - |\n| 1 | 2 |\n"
        #expect(self.segments(markdown, isComplete: false) == [
            .prose("| a | b |\n| - | - |\n| 1 | 2 |"),
        ])
    }

    @Test func `settled table while streaming renders as table`() {
        let blocks = self.segments("| a | b |\n| - | - |\n| 1 | 2 |\n\nafter", isComplete: false)
        #expect(blocks == [
            .table(ChatMarkdownTable(
                header: ["a", "b"],
                alignments: [.leading, .leading],
                rows: [["1", "2"]])),
            .prose("after"),
        ])
    }

    // MARK: - Tables

    @Test func `table with alignments and body rows`() {
        let blocks = self.segments("""
        | Name | Count | Price |
        | :--- | :---: | ----: |
        | a | 1 | 2.50 |
        | b | 2 | 3.00 |
        """)
        #expect(blocks == [
            .table(ChatMarkdownTable(
                header: ["Name", "Count", "Price"],
                alignments: [.leading, .center, .trailing],
                rows: [["a", "1", "2.50"], ["b", "2", "3.00"]])),
        ])
    }

    @Test func `table without boundary pipes`() {
        let blocks = self.segments("a | b\n--- | ---\n1 | 2")
        #expect(blocks == [
            .table(ChatMarkdownTable(
                header: ["a", "b"],
                alignments: [.leading, .leading],
                rows: [["1", "2"]])),
        ])
    }

    @Test func `top level indented table remains native`() {
        let blocks = self.segments("  | a | b |\n  | - | - |\n  | 1 | 2 |")
        #expect(blocks == [
            .table(ChatMarkdownTable(
                header: ["a", "b"],
                alignments: [.leading, .leading],
                rows: [["1", "2"]])),
        ])
    }

    @Test func `list nested table stays attached to its item`() {
        #expect(self.segments("- item\n  | a | b |\n  | - | - |\n  | 1 | 2 |") == [
            .list(ChatMarkdownList(
                kind: .unordered,
                items: [self.item([.markdown("item\n| a | b |\n| - | - |\n| 1 | 2 |")])])),
        ])
    }

    @Test func `escaped pipe stays a literal cell character`() {
        let blocks = self.segments("| a\\|b | c |\n| - | - |\n| 1 | 2 |")
        #expect(blocks == [
            .table(ChatMarkdownTable(
                header: ["a|b", "c"],
                alignments: [.leading, .leading],
                rows: [["1", "2"]])),
        ])
    }

    @Test func `short rows pad and long rows truncate to header width`() {
        let blocks = self.segments("| a | b |\n| - | - |\n| 1 |\n| 1 | 2 | 3 |")
        #expect(blocks == [
            .table(ChatMarkdownTable(
                header: ["a", "b"],
                alignments: [.leading, .leading],
                rows: [["1", ""], ["1", "2"]])),
        ])
    }

    @Test func `adjacent pipes remain an empty gfm cell`() {
        let blocks = self.segments("| a | b | c |\n| - | - | - |\n| 1 || 3 |")
        #expect(blocks == [
            .table(ChatMarkdownTable(
                header: ["a", "b", "c"],
                alignments: [.leading, .leading, .leading],
                rows: [["1", "", "3"]])),
        ])
    }

    @Test func `caret remains a literal gfm cell`() {
        let blocks = self.segments("| a | b |\n| - | - |\n| ^ | value |")
        #expect(blocks == [
            .table(ChatMarkdownTable(
                header: ["a", "b"],
                alignments: [.leading, .leading],
                rows: [["^", "value"]])),
        ])
    }

    @Test func `one cell body row without pipes is padded`() {
        let blocks = self.segments("| a | b |\n| - | - |\nonly one cell")
        #expect(blocks == [
            .table(ChatMarkdownTable(
                header: ["a", "b"],
                alignments: [.leading, .leading],
                rows: [["only one cell", ""]])),
        ])
    }

    @Test func `setext underline and link definition text remain body rows`() {
        let blocks = self.segments("| a | b |\n| - | - |\n===\n[foo]: /url\n[foo]")
        #expect(blocks == [
            .table(ChatMarkdownTable(
                header: ["a", "b"],
                alignments: [.leading, .leading],
                rows: [["===", ""], ["[foo]: /url", ""], ["[foo]", ""]])),
        ])
    }

    @Test func `table body stops at blank line`() {
        let blocks = self.segments("| a |b|\n| - |-|\n| 1 |2|\n\nprose | not a row")
        #expect(blocks == [
            .table(ChatMarkdownTable(
                header: ["a", "b"],
                alignments: [.leading, .leading],
                rows: [["1", "2"]])),
            .prose("prose | not a row"),
        ])
    }

    @Test func `table body stops at another block`() {
        let blocks = self.segments("| a | b |\n| - | - |\n| 1 | 2 |\n> quote")
        #expect(blocks == [
            .table(ChatMarkdownTable(
                header: ["a", "b"],
                alignments: [.leading, .leading],
                rows: [["1", "2"]])),
            .prose("> quote"),
        ])
    }

    @Test func `table body stops at empty list markers`() {
        for (marker, kind) in [
            ("-", ChatMarkdownList.Kind.unordered),
            ("1.", ChatMarkdownList.Kind.ordered(start: 1)),
        ] {
            let markdown = "| a | b |\n| - | - |\n| 1 | 2 |\n\(marker)"
            #expect(self.segments(markdown) == [
                .table(ChatMarkdownTable(
                    header: ["a", "b"],
                    alignments: [.leading, .leading],
                    rows: [["1", "2"]])),
                .list(ChatMarkdownList(kind: kind, items: [self.item([])])),
            ])
        }
    }

    @Test func `table body stops at fenced code`() {
        let blocks = self.segments("| a | b |\n| - | - |\n| 1 | 2 |\n```swift\nlet x = 1\n```")
        #expect(blocks == [
            .table(ChatMarkdownTable(
                header: ["a", "b"],
                alignments: [.leading, .leading],
                rows: [["1", "2"]])),
            .code(ChatCodeBlock(language: "swift", code: "let x = 1", isComplete: true)),
        ])
    }

    @Test func `table body stops at html block`() {
        let blocks = self.segments("| a | b |\n| - | - |\n| 1 | 2 |\n<x-status when=\"count > 0\">\nhtml\n</x-status>")
        #expect(blocks == [
            .table(ChatMarkdownTable(
                header: ["a", "b"],
                alignments: [.leading, .leading],
                rows: [["1", "2"]])),
            .prose("<x-status when=\"count > 0\">\nhtml\n</x-status>"),
        ])
    }

    @Test func `header delimiter count mismatch falls back to prose`() {
        let markdown = "| a | b |\n| - | - | - |\n| 1 | 2 |"
        #expect(self.segments(markdown) == [.prose(markdown)])
    }

    @Test func `delimiter row without header pipe falls back to prose`() {
        let markdown = "heading\n| - | - |"
        #expect(self.segments(markdown) == [.prose(markdown)])
    }

    @Test func `pipes without delimiter row stay prose`() {
        let markdown = "use foo | bar\nthen continue"
        #expect(self.segments(markdown) == [.prose(markdown)])
    }

    @Test func `table header inside paragraph is detected`() {
        let blocks = self.segments("intro line\n| a | b |\n| - | - |\n| 1 | 2 |\n\ndone")
        #expect(blocks == [
            .prose("intro line"),
            .table(ChatMarkdownTable(
                header: ["a", "b"],
                alignments: [.leading, .leading],
                rows: [["1", "2"]])),
            .prose("done"),
        ])
    }

    @Test func `table syntax inside fence stays code`() {
        let blocks = self.segments("```\n| a | b |\n| - | - |\n```")
        #expect(blocks == [
            .code(ChatCodeBlock(language: nil, code: "| a | b |\n| - | - |", isComplete: true)),
        ])
    }

    @Test func `nested list fence stays attached to its item`() {
        #expect(self.segments("- item\n  ```swift\n  let value = 1\n  ```\n  continuation") == [
            .list(ChatMarkdownList(
                kind: .unordered,
                items: [self.item([
                    .markdown("item"),
                    .code(ChatCodeBlock(language: "swift", code: "let value = 1", isComplete: true)),
                    .markdown("continuation"),
                ])])),
        ])
    }

    @Test func `table syntax inside list fence stays fenced`() {
        #expect(self.segments("- item\n  ```\n  | a | b |\n  | - | - |\n  ```") == [
            .list(ChatMarkdownList(
                kind: .unordered,
                items: [self.item([
                    .markdown("item"),
                    .code(ChatCodeBlock(
                        language: nil,
                        code: "| a | b |\n| - | - |",
                        isComplete: true)),
                ])])),
        ])
    }

    @Test func `list marker inside top level fence stays code`() {
        let blocks = self.segments("```markdown\n- item\n```")
        #expect(blocks == [
            .code(ChatCodeBlock(language: "markdown", code: "- item", isComplete: true)),
        ])
    }

    @Test func `html block containing fence stays one prose document`() {
        let markdown = "<div>\n```swift\nlet value = 1\n```\n</div>"
        #expect(self.segments(markdown) == [.prose(markdown)])
    }

    @Test func `blank line ends html block before top level fence`() {
        let markdown = "<div>\nraw\n\n```swift\nlet value = 1\n```"
        #expect(self.segments(markdown) == [
            .prose("<div>\nraw"),
            .code(ChatCodeBlock(language: "swift", code: "let value = 1", isComplete: true)),
        ])
    }

    @Test func `type seven html tag does not interrupt paragraph`() {
        let markdown = "text\n<span>\n```swift\nlet value = 1\n```"
        #expect(self.segments(markdown) == [
            .prose("text\n<span>"),
            .code(ChatCodeBlock(language: "swift", code: "let value = 1", isComplete: true)),
        ])
    }

    @Test func `type seven html tag does not interrupt indented paragraph continuation`() {
        let markdown = "text\n    continuation\n<span>\n```swift\nlet value = 1\n```"
        #expect(self.segments(markdown) == [
            .prose("text\n    continuation\n<span>"),
            .code(ChatCodeBlock(language: "swift", code: "let value = 1", isComplete: true)),
        ])
    }

    @Test func `reference definitions preserve document scope across blocks`() {
        let markdown = "[docs][d]\n\n```swift\nlet value = 1\n```\n\n[d]: https://example.com"
        #expect(self.segments(markdown) == [.prose(markdown)])
    }

    @Test func `multiline reference definitions preserve document scope`() {
        let markdown = "[docs][d]\n\n```swift\nlet value = 1\n```\n\n[d]:\n  https://example.com"
        #expect(self.segments(markdown) == [.prose(markdown)])
    }

    @Test func `reference definitions inside containers preserve document scope`() {
        let markdown = "[docs]\n\n```swift\nlet value = 1\n```\n\n> [docs]: https://example.com"
        #expect(self.segments(markdown) == [.prose(markdown)])
    }

    @Test func `multiline reference labels preserve document scope`() {
        let markdown = "[docs]\n\n```swift\nlet value = 1\n```\n\n[\ndocs\n]: https://example.com"
        #expect(self.segments(markdown) == [.prose(markdown)])
    }

    @Test func `table after paragraph keeps inline header markdown`() {
        let blocks = self.segments("intro\n| **a** | b\\|c |\n| - | - |\n| 1 | 2 |")
        #expect(blocks == [
            .prose("intro"),
            .table(ChatMarkdownTable(
                header: ["**a**", "b|c"],
                alignments: [.leading, .leading],
                rows: [["1", "2"]])),
        ])
    }

    @Test func `oversized table stays raw prose`() {
        let rows = Array(
            repeating: "| value | value |",
            count: ChatMarkdownBlockSegmenter.maxTableRows)
        let markdown = (["| a | b |", "| - | - |"] + rows).joined(separator: "\n")
        #expect(self.segments(markdown) == [.prose(markdown)])
    }

    @Test func `table at the rendering bounds remains native`() {
        let bodyRowCount = ChatMarkdownBlockSegmenter.maxTableRows - 1
        let rows = Array(repeating: "| value | value |", count: bodyRowCount)
        let markdown = (["| a | b |", "| - | - |"] + rows).joined(separator: "\n")
        let blocks = self.segments(markdown)
        guard case let .table(table) = blocks.first else {
            Issue.record("expected bounded table")
            return
        }
        #expect(table.rows.count == bodyRowCount)
    }
}
