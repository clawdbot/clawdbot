import Foundation
import Markdown
import SwiftUI

public enum ChatMarkdownVariant: String, CaseIterable, Sendable {
    case standard
    case compact
}

@MainActor
struct ChatMarkdownRenderer: View {
    enum Context {
        case user
        case assistant
    }

    struct InlineMathTypography: Equatable {
        static let body = Self(size: OpenClawChatTypography.bodySize, relativeTo: .body)
        static let callout = Self(size: 16, relativeTo: .callout)

        let size: CGFloat
        let relativeTo: Font.TextStyle
    }

    let snapshot: ChatMarkdownRenderSnapshot
    let context: Context
    let variant: ChatMarkdownVariant
    let font: Font
    let textColor: Color
    let inlineMathTypography: InlineMathTypography

    static func styledText(_ content: String, font: Font) -> SwiftUI.Text {
        SwiftUI.Text(content)
            .font(font)
    }

    var reveal: ChatMarkdownProseReveal?

    @ScaledMetric private var inlineMathFontSize: CGFloat
    @Environment(\.colorScheme) private var colorScheme

    init(
        text: String,
        context: Context,
        variant: ChatMarkdownVariant,
        font: Font,
        textColor: Color,
        inlineMathTypography: InlineMathTypography = .body,
        isComplete: Bool = true)
    {
        self.init(
            snapshot: ChatMarkdownRenderSnapshot(text: text, isComplete: isComplete),
            context: context,
            variant: variant,
            font: font,
            textColor: textColor,
            inlineMathTypography: inlineMathTypography)
    }

    init(
        snapshot: ChatMarkdownRenderSnapshot,
        context: Context,
        variant: ChatMarkdownVariant,
        font: Font,
        textColor: Color,
        inlineMathTypography: InlineMathTypography = .body,
        reveal: ChatMarkdownProseReveal? = nil)
    {
        self.snapshot = snapshot
        self.context = context
        self.variant = variant
        self.font = font
        self.textColor = textColor
        self.inlineMathTypography = inlineMathTypography
        self.reveal = reveal
        self._inlineMathFontSize = ScaledMetric(
            wrappedValue: inlineMathTypography.size,
            relativeTo: inlineMathTypography.relativeTo)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(self.snapshot.blocks.enumerated()), id: \.offset) { entry in
                self.blockView(entry.element, index: entry.offset)
            }

            if !self.snapshot.images.isEmpty {
                InlineImageList(images: self.snapshot.images)
            }
        }
    }

    @ViewBuilder
    private func blockView(_ block: ChatMarkdownRenderedBlock, index: Int) -> some View {
        switch block {
        case let .prose(prose):
            self.proseText(prose, index: index)
                .font(self.font)
                .foregroundStyle(self.textColor)
                .tint(self.linkColor)
                .textSelection(.enabled)
                .lineSpacing(self.variant == .compact ? 2 : 4)
                .modifier(ChatInlineMathAccessibilityModifier(label: prose.inlineAccessibilityText))
        case let .heading(level, prose):
            self.proseText(prose, index: index)
                .font(OpenClawChatTypography.heading(level: level))
                .foregroundStyle(self.textColor)
                .tint(self.linkColor)
                .textSelection(.enabled)
                .lineSpacing(self.variant == .compact ? 2 : 4)
                .modifier(ChatInlineMathAccessibilityModifier(label: prose.inlineAccessibilityText))
                .accessibilityAddTraits(.isHeader)
        case let .code(code):
            ChatCodeBlockView(block: code)
        case let .math(math):
            ChatMathBlockView(block: math, textColor: self.textColor)
        case let .table(table):
            ChatMarkdownTableView(table: table)
        case let .list(list):
            self.listView(list)
        case .thematicBreak:
            Divider()
                .accessibilityHidden(true)
        }
    }

    func listView(_ list: ChatMarkdownList) -> ChatMarkdownListView {
        ChatMarkdownListView(
            list: list,
            context: self.context,
            variant: self.variant,
            font: self.font,
            textColor: self.textColor,
            inlineMathTypography: self.inlineMathTypography)
    }

    private func proseText(_ prose: ChatMarkdownProse, index: Int) -> SwiftUI.Text {
        guard let reveal = self.reveal, reveal.blockIndex == index else {
            return prose.renderedText(
                fontSize: self.inlineMathFontSize,
                textColor: self.textColor,
                colorScheme: self.colorScheme)
        }
        return prose.revealedText(
            frame: revealedOpacities(state: reveal.state, now: reveal.now),
            textColor: self.textColor)
    }

    private var linkColor: Color {
        self.context == .user ? self.textColor : OpenClawChatTheme.accent
    }
}

struct ChatMarkdownProseReveal {
    let blockIndex: Int
    let state: ChatStreamingRevealState
    let now: TimeInterval
}

@MainActor
struct ChatMarkdownRenderSnapshot {
    let blocks: [ChatMarkdownRenderedBlock]
    let images: [ChatMarkdownPreprocessor.InlineImage]

    init(text: String, isComplete: Bool, preparesReveal: Bool = false) {
        let processed = ChatMarkdownPreprocessor.preprocess(markdown: text)
        self.blocks = ChatMarkdownBlockSegmenter.segments(
            markdown: processed.cleaned,
            isComplete: isComplete).map { block in
            switch block {
            case let .prose(markdown):
                .prose(ChatMarkdownProse(
                    markdown: markdown,
                    isComplete: isComplete,
                    preparesReveal: preparesReveal))
            case let .heading(heading):
                .heading(
                    level: heading.level,
                    prose: ChatMarkdownProse(
                        markdown: heading.markdown,
                        isComplete: isComplete,
                        preparesReveal: false))
            case let .code(code):
                .code(code)
            case let .math(math):
                .math(math)
            case let .table(table):
                .table(table)
            case let .list(list):
                .list(list)
            case .thematicBreak:
                .thematicBreak
            }
        }
        self.images = processed.images
    }

    var lastProseIndex: Int? {
        self.blocks.lastIndex {
            if case .prose = $0 {
                return true
            }
            return false
        }
    }
}

enum ChatMarkdownRenderedBlock {
    case prose(ChatMarkdownProse)
    case heading(level: Int, prose: ChatMarkdownProse)
    case code(ChatCodeBlock)
    case math(ChatMathBlock)
    case table(ChatMarkdownTable)
    case list(ChatMarkdownList)
    case thematicBreak
}

@MainActor
struct ChatMarkdownProse {
    struct TailPiece {
        let attributed: AttributedString
        let wordRange: Range<Int>?
    }

    let attributed: AttributedString
    let plainText: String
    let prefix: AttributedString
    let tail: [TailPiece]
    let inlineContent: [InlineContent]?

    enum InlineContent {
        case text(AttributedString)
        case math(ChatInlineMathSpan)
    }

    init(markdown: String, isComplete: Bool, preparesReveal: Bool) {
        // preparesReveal belongs only to the streaming snapshot. Keep that path
        // on its single AttributedString build; completed snapshots alone split
        // prose for inline image interpolation.
        let inlineContent = isComplete && !preparesReveal
            ? Self.makeInlineContent(markdown: markdown)
            : nil
        let attributed = inlineContent == nil
            ? Self.parseMarkdown(markdown)
            : AttributedString()
        let plainText = preparesReveal ? String(attributed.characters) : ""
        let wordRanges = preparesReveal
            ? Array(chatStreamingWordRanges(in: plainText).suffix(24))
            : []
        let tailStart = wordRanges.first?.lowerBound ?? plainText.count

        self.attributed = attributed
        self.plainText = plainText
        self.inlineContent = inlineContent
        if preparesReveal {
            self.prefix = Self.slice(attributed, characterRange: 0..<tailStart)
            self.tail = Self.tailPieces(
                attributed: attributed,
                textLength: plainText.count,
                wordRanges: wordRanges,
                tailStart: tailStart)
        } else {
            self.prefix = AttributedString()
            self.tail = []
        }
    }

    // periphery:ignore - package tests inspect parsed math spans without exposing renderer internals.
    var inlineMathLatex: [String] {
        self.inlineContent?.compactMap { content in
            if case let .math(span) = content {
                return span.latex
            }
            return nil
        } ?? []
    }

    var inlineAccessibilityText: String? {
        guard let inlineContent else { return nil }
        return inlineContent.reduce(into: "") { text, content in
            switch content {
            case let .text(attributed):
                text += String(attributed.characters)
            case let .math(span):
                text += span.latex
            }
        }
    }

    func renderedText(
        fontSize: CGFloat,
        textColor: Color,
        colorScheme: ColorScheme) -> SwiftUI.Text
    {
        guard let inlineContent else { return SwiftUI.Text(self.attributed) }
        return inlineContent.reduce(SwiftUI.Text("")) { text, content in
            switch content {
            case let .text(attributed):
                return text + SwiftUI.Text(attributed)
            case let .math(span):
                guard let rendered = ChatInlineMathImageCache.image(
                    latex: span.latex,
                    fontSize: fontSize,
                    textColor: textColor,
                    colorScheme: colorScheme)
                else { return text + SwiftUI.Text(span.source) }
                #if os(macOS)
                let image = Image(nsImage: rendered.image)
                #else
                let image = Image(uiImage: rendered.image)
                #endif
                return text + SwiftUI.Text(image).baselineOffset(rendered.baselineOffset)
            }
        }
    }

    func revealedText(frame: ChatStreamingRevealFrame, textColor: Color) -> SwiftUI.Text {
        self.tail.reduce(SwiftUI.Text(self.prefix)) { text, piece in
            var attributed = piece.attributed
            if let wordRange = piece.wordRange,
               let fading = frame.fading.first(where: { $0.characterRange == wordRange })
            {
                attributed.foregroundColor = textColor.opacity(fading.opacity)
            }
            return text + SwiftUI.Text(attributed)
        }
    }

    private static func makeInlineContent(markdown: String) -> [InlineContent]? {
        let pieces = ChatInlineMathScanner.pieces(in: markdown)
        guard pieces.contains(where: { piece in
            if case .markdown = piece {
                return false
            }
            return true
        }) else { return nil }

        var substitutedMarkdown = ""
        var replacements: [InlineReplacement] = []
        var markerValue: UInt32 = 0xE000
        var occupiedMarkerValues = Set(markdown.unicodeScalars.map(\.value))
        for piece in pieces {
            switch piece {
            case let .markdown(source):
                substitutedMarkdown += source
            case let .literal(source):
                substitutedMarkdown += Self.markdownEscapedLiteral(source)
            case let .math(latex, source):
                guard ChatMathParseCache.mathList(latex: latex) != nil else {
                    substitutedMarkdown += Self.markdownEscapedLiteral(source)
                    continue
                }
                let marker = Self.nextMarker(
                    startingAt: &markerValue,
                    occupiedValues: &occupiedMarkerValues)
                substitutedMarkdown.append(marker)
                replacements.append(InlineReplacement(
                    marker: marker,
                    span: ChatInlineMathSpan(latex: latex, source: source)))
            }
        }

        let attributed = self.parseMarkdown(substitutedMarkdown)
        var content: [InlineContent] = []
        var cursor = attributed.startIndex
        for replacement in replacements {
            guard let markerIndex = attributed.characters[cursor...]
                .firstIndex(of: replacement.marker)
            else { return nil }
            if cursor < markerIndex {
                content.append(.text(AttributedString(attributed[cursor..<markerIndex])))
            }
            let markerEnd = attributed.characters.index(after: markerIndex)
            let attributes = attributed[markerIndex..<markerEnd].runs.first?.attributes
            if attributes?.link != nil {
                // Text(Image) cannot carry an AttributedString link. Keep math
                // used as a link label literal so the destination remains
                // visible and tappable instead of silently dropping the link.
                var literal = AttributedString(replacement.span.source)
                if let attributes {
                    literal.mergeAttributes(attributes)
                }
                content.append(.text(literal))
            } else {
                content.append(.math(replacement.span))
            }
            cursor = markerEnd
        }
        if cursor < attributed.endIndex {
            content.append(.text(AttributedString(attributed[cursor...])))
        }
        return content
    }

    private struct InlineReplacement {
        let marker: Character
        let span: ChatInlineMathSpan
    }

    private static func nextMarker(
        startingAt value: inout UInt32,
        occupiedValues: inout Set<UInt32>) -> Character
    {
        while occupiedValues.contains(value) {
            value += 1
        }
        guard let scalar = UnicodeScalar(value) else {
            preconditionFailure("inline math marker range exhausted")
        }
        occupiedValues.insert(value)
        let marker = Character(String(scalar))
        value += 1
        return marker
    }

    private static func markdownEscapedLiteral(_ source: String) -> String {
        source.reduce(into: "") { escaped, character in
            if character.unicodeScalars.count == 1,
               let scalar = character.unicodeScalars.first,
               scalar.isASCII,
               (33...47).contains(scalar.value) ||
               (58...64).contains(scalar.value) ||
               (91...96).contains(scalar.value) ||
               (123...126).contains(scalar.value)
            {
                escaped.append("\\")
            }
            escaped.append(character)
        }
    }

    private static func parseMarkdown(_ markdown: String) -> AttributedString {
        let displayMarkdown = ChatMarkdownDisplayPreprocessor.preserveChatSoftBreaks(in: markdown)
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .full,
            failurePolicy: .returnPartiallyParsedIfPossible)
        return (try? AttributedString(markdown: displayMarkdown, options: options))
            ?? AttributedString(displayMarkdown)
    }

    private static func tailPieces(
        attributed: AttributedString,
        textLength: Int,
        wordRanges: [Range<Int>],
        tailStart: Int) -> [TailPiece]
    {
        guard !wordRanges.isEmpty else { return [] }
        var pieces: [TailPiece] = []
        var cursor = tailStart
        for wordRange in wordRanges {
            if cursor < wordRange.lowerBound {
                pieces.append(TailPiece(
                    attributed: self.slice(attributed, characterRange: cursor..<wordRange.lowerBound),
                    wordRange: nil))
            }
            pieces.append(TailPiece(
                attributed: self.slice(attributed, characterRange: wordRange),
                wordRange: wordRange))
            cursor = wordRange.upperBound
        }
        if cursor < textLength {
            pieces.append(TailPiece(
                attributed: self.slice(attributed, characterRange: cursor..<textLength),
                wordRange: nil))
        }
        return pieces
    }

    private static func slice(
        _ attributed: AttributedString,
        characterRange: Range<Int>) -> AttributedString
    {
        let lower = attributed.characters.index(
            attributed.startIndex,
            offsetBy: characterRange.lowerBound)
        let upper = attributed.characters.index(
            attributed.startIndex,
            offsetBy: characterRange.upperBound)
        return AttributedString(attributed[lower..<upper])
    }
}

private struct ChatInlineMathAccessibilityModifier: ViewModifier {
    let label: String?

    func body(content: Content) -> some View {
        if let label {
            content.accessibilityLabel(label)
        } else {
            content
        }
    }
}

/// Structural Markdown blocks are split out by `ChatMarkdownBlockSegmenter`
/// before this runs, so prose only needs chat-style soft-break preservation.
enum ChatMarkdownDisplayPreprocessor {
    static func preserveChatSoftBreaks(in markdown: String) -> String {
        let normalized = markdown.replacingOccurrences(of: "\r\n", with: "\n")
        let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        guard lines.count > 1 else { return normalized }
        let codeLines = self.codeLineIndices(in: normalized)

        var output = ""
        for index in lines.indices {
            output += lines[index]

            guard index < lines.index(before: lines.endIndex) else {
                continue
            }

            if !codeLines.contains(index),
               !codeLines.contains(index + 1),
               self.shouldPreserveSoftBreak(after: lines[index], before: lines[index + 1])
            {
                output += "  \n"
            } else {
                output += "\n"
            }
        }

        return output
    }

    private static func codeLineIndices(in markdown: String) -> Set<Int> {
        guard markdown.contains("```")
            || markdown.contains("~~~")
            || markdown.hasPrefix("    ")
            || markdown.contains("\n    ")
        else { return [] }

        var indices = Set<Int>()
        func collect(from markup: any Markup) {
            if markup is Markdown.CodeBlock, let range = markup.range {
                indices.formUnion((range.lowerBound.line - 1)..<range.upperBound.line)
            }
            for child in markup.children {
                collect(from: child)
            }
        }
        collect(from: Document(parsing: markdown))
        return indices
    }

    private static func shouldPreserveSoftBreak(after line: String, before nextLine: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        let nextTrimmed = nextLine.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !nextTrimmed.isEmpty else { return false }
        guard !self.hasMarkdownHardBreak(line) else { return false }
        guard !ChatMarkdownBlockSyntax.startsBlock(line), !ChatMarkdownBlockSyntax.startsBlock(nextLine) else {
            return false
        }
        return true
    }

    private static func hasMarkdownHardBreak(_ line: String) -> Bool {
        line.hasSuffix("\\") || line.hasSuffix("  ")
    }
}

@MainActor
private struct InlineImageList: View {
    let images: [ChatMarkdownPreprocessor.InlineImage]

    var body: some View {
        ForEach(self.images, id: \.id) { item in
            if let img = item.image {
                OpenClawPlatformImageFactory.image(img)
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 260)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.12), lineWidth: 1))
            } else {
                Text(item.label.isEmpty ? "Image" : item.label)
                    .font(OpenClawChatTypography.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
