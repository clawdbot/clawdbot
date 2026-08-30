import CoreGraphics
import Foundation
import Testing
@testable import OpenClawChatUI

struct ChatInlineMathTests {
    @Test func `basic span splits from prose`() {
        #expect(ChatInlineMathScanner.pieces(in: #"before \(x + 1\) after"#) == [
            .markdown("before "),
            .math(latex: "x + 1", source: #"\(x + 1\)"#),
            .markdown(" after"),
        ])
    }

    @Test func `multiple spans split independently`() {
        let pieces = ChatInlineMathScanner.pieces(in: #"\(x\), then \(y\)"#)
        #expect(pieces.compactMap(\.mathLatex) == ["x", "y"])
    }

    @Test func `span inside backticks stays markdown`() {
        let source = #"use `\(not math\)` here"#
        #expect(ChatInlineMathScanner.pieces(in: source) == [.markdown(source)])
    }

    @Test func `unmatched backtick does not hide later math`() {
        #expect(ChatInlineMathScanner.pieces(in: #"stray ` before \(x\)"#) == [
            .markdown("stray ` before "),
            .math(latex: "x", source: #"\(x\)"#),
        ])
    }

    @Test func `escaped delimiters stay markdown`() {
        let source = #"escaped \\(x\\)"#
        #expect(ChatInlineMathScanner.pieces(in: source) == [.markdown(source)])
    }

    @Test func `unclosed opener stays literal`() {
        #expect(ChatInlineMathScanner.pieces(in: #"before \(x"#) == [
            .markdown("before "),
            .literal(#"\(x"#),
        ])
    }

    @Test func `newline span stays literal`() {
        let source = "before \\(x\ny\\) after"
        #expect(ChatInlineMathScanner.pieces(in: source) == [
            .markdown("before "),
            .literal("\\(x\ny\\)"),
            .markdown(" after"),
        ])
    }

    @Test func `only first sixteen spans are candidates`() {
        let source = (0..<17).map { #"\(x\#($0)\)"# }.joined(separator: " ")
        let pieces = ChatInlineMathScanner.pieces(in: source)
        #expect(pieces.compactMap(\.mathLatex).count == ChatInlineMathScanner.maxSpanCount)
        #expect(pieces.contains(.literal(#"\(x16\)"#)))
    }

    @Test @MainActor func `markdown after excess spans remains parsed`() throws {
        let spans = (0..<17).map { #"\(x\#($0)\)"# }.joined(separator: " ")
        let snapshot = ChatMarkdownRenderSnapshot(
            text: spans + " [docs](https://example.com)",
            isComplete: true)
        let prose = try self.prose(in: snapshot)
        let hasLink = prose.inlineContent?.contains { content in
            guard case let .text(attributed) = content else { return false }
            return attributed.runs.contains { $0.link != nil }
        }

        #expect(hasLink == true)
    }

    @Test @MainActor func `math link label stays literal and linked`() throws {
        let snapshot = ChatMarkdownRenderSnapshot(
            text: #"[\(x\)](https://example.com)"#,
            isComplete: true)
        let prose = try self.prose(in: snapshot)
        let linkedText = prose.inlineContent?.compactMap { content -> AttributedString? in
            guard case let .text(attributed) = content,
                  attributed.runs.contains(where: { $0.link != nil })
            else { return nil }
            return attributed
        }.first

        #expect(prose.inlineMathLatex.isEmpty)
        #expect(try String(#require(linkedText).characters) == #"\(x\)"#)
    }

    @Test func `two hundred byte cap is inclusive`() {
        let acceptedLatex = String(repeating: "x", count: ChatInlineMathScanner.maxSourceBytes - 4)
        let rejectedLatex = acceptedLatex + "x"
        #expect(ChatInlineMathScanner.pieces(in: "\\(\(acceptedLatex)\\)").compactMap(\.mathLatex) == [
            acceptedLatex,
        ])
        #expect(ChatInlineMathScanner.pieces(in: "\\(\(rejectedLatex)\\)") == [
            .literal("\\(\(rejectedLatex)\\)"),
        ])
    }

    @Test @MainActor func `only completed prose prepares inline math`() throws {
        let complete = ChatMarkdownRenderSnapshot(text: #"value \(x^2\)"#, isComplete: true)
        let streaming = ChatMarkdownRenderSnapshot(
            text: #"value \(x^2\)"#,
            isComplete: false,
            preparesReveal: true)

        #expect(try self.prose(in: complete).inlineMathLatex == ["x^2"])
        #expect(try self.prose(in: streaming).inlineMathLatex.isEmpty)
    }

    @Test @MainActor func `display math guards also reject inline math`() throws {
        for source in [#"value \(α + β\)"#, #"value \(x\color{red}\)"#] {
            let snapshot = ChatMarkdownRenderSnapshot(text: source, isComplete: true)
            #expect(try self.prose(in: snapshot).inlineMathLatex.isEmpty)
        }
    }

    @Test @MainActor func `markdown attributes can cross inline math`() throws {
        let snapshot = ChatMarkdownRenderSnapshot(text: #"**value \(x\)**"#, isComplete: true)
        let prose = try self.prose(in: snapshot)

        #expect(prose.inlineMathLatex == ["x"])
        #expect(prose.inlineAccessibilityText == "value x")
    }

    @Test @MainActor func `image sizing rejects unsafe bitmap bounds`() {
        #expect(!ChatInlineMathImageCache.isSafeImageSize(.zero, scale: 2))
        #expect(!ChatInlineMathImageCache.isSafeImageSize(
            CGSize(width: 4097, height: 1),
            scale: 1))
        #expect(!ChatInlineMathImageCache.isSafeImageSize(
            CGSize(width: 1024, height: 1024),
            scale: 1))
        #expect(ChatInlineMathImageCache.isSafeImageSize(
            CGSize(width: 256, height: 256),
            scale: 2))
    }

    @MainActor
    private func prose(in snapshot: ChatMarkdownRenderSnapshot) throws -> ChatMarkdownProse {
        guard case let .prose(prose) = try #require(snapshot.blocks.first) else {
            Issue.record("expected prose block")
            throw InlineMathTestError.expectedProse
        }
        return prose
    }
}

private enum InlineMathTestError: Error {
    case expectedProse
}

extension ChatInlineMathScanner.Piece {
    fileprivate var mathLatex: String? {
        if case let .math(latex, _) = self {
            return latex
        }
        return nil
    }
}
