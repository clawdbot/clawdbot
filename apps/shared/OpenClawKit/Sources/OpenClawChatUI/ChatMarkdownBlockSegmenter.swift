import Foundation
import Markdown

/// One renderable block of a chat message. Prose stays on the
/// AttributedString pipeline; structural Markdown gets dedicated views.
enum ChatMarkdownBlock: Equatable {
    case prose(String)
    case heading(ChatMarkdownHeading)
    case code(ChatCodeBlock)
    case math(ChatMathBlock)
    case table(ChatMarkdownTable)
    case list(ChatMarkdownList)
    case disclosure(ChatMarkdownDisclosure)
    case thematicBreak
}

struct ChatMarkdownDisclosure: Equatable {
    let summary: String?
    let isExpanded: Bool
    let blocks: [ChatMarkdownBlock]
}

struct ChatMarkdownHeading: Equatable {
    let level: Int
    /// Keep the complete source so Swift's Markdown parser continues to own
    /// inline formatting and both ATX and Setext heading syntax.
    let markdown: String
}

struct ChatCodeBlock: Equatable {
    let language: String?
    let code: String
    /// True when the fence was closed or the message finished streaming.
    /// Open fences render as plain mono text so every streaming delta stays cheap.
    let isComplete: Bool
}

struct ChatMathBlock: Equatable {
    let latex: String
    /// True when the delimiter was closed or the message finished streaming.
    let isComplete: Bool
}

struct ChatMarkdownTable: Equatable {
    enum ColumnAlignment: Equatable {
        case leading
        case center
        case trailing
    }

    let header: [String]
    let alignments: [ColumnAlignment]
    let rows: [[String]]
}

struct ChatMarkdownList: Equatable {
    enum Kind: Equatable {
        case unordered
        case ordered(start: UInt)
    }

    let kind: Kind
    let items: [ChatMarkdownListItem]
}

struct ChatMarkdownListItem: Equatable {
    enum Checkbox: Equatable {
        case checked
        case unchecked
    }

    let checkbox: Checkbox?
    let content: [ChatMarkdownListItemContent]
}

indirect enum ChatMarkdownListItemContent: Equatable {
    case markdown(String)
    case code(ChatCodeBlock)
    case list(ChatMarkdownList)
}

enum ChatMarkdownBlockSyntax {
    static func startsBlock(_ line: String, includesSetextUnderline: Bool = true) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }

        let startsIndependentBlock = self.matches(line, #"^\s{0,3}#{1,6}(\s|$)"#)
            || self.matches(line, #"^\s{0,3}>"#)
            || self.matches(line, #"^\s{0,3}([-+*])(?:\s+|$)"#)
            || self.matches(line, #"^\s{0,3}\d{1,9}[.)](?:\s+|$)"#)
            || self.matches(line, #"^( {4}|\t)"#)
            || self.matches(line, #"^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$"#)
        return startsIndependentBlock
            || (includesSetextUnderline && self.matches(line, #"^\s{0,3}={3,}$"#))
    }

    private static func matches(_ line: String, _ pattern: String) -> Bool {
        line.range(of: pattern, options: .regularExpression) != nil
    }
}

/// Disclosure scanning pauses inside CommonMark raw HTML block types 1-5;
/// their contents stay literal until the matching terminator.
private enum ChatMarkdownRawHTMLContext {
    case comment
    case processingInstruction
    case declaration
    case cdata
    case element(String)

    static func opening(in line: String) -> ChatMarkdownRawHTMLContext? {
        let trimmed = line.drop(while: \.isWhitespace)
        let lowercased = trimmed.lowercased()
        if trimmed.hasPrefix("<!--") { return .comment }
        if trimmed.hasPrefix("<?") { return .processingInstruction }
        if trimmed.hasPrefix("<![CDATA[") { return .cdata }
        if trimmed.count > 2,
           trimmed.hasPrefix("<!"),
           ("A"..."Z").contains(trimmed[trimmed.index(trimmed.startIndex, offsetBy: 2)])
        {
            return .declaration
        }
        for tag in ["pre", "script", "style", "textarea"] {
            let prefix = "<\(tag)"
            guard lowercased.hasPrefix(prefix) else { continue }
            let boundary = lowercased.index(lowercased.startIndex, offsetBy: prefix.count)
            if boundary == lowercased.endIndex || lowercased[boundary].isWhitespace || lowercased[boundary] == ">" {
                return .element(tag)
            }
        }
        return nil
    }

    func closes(in line: String) -> Bool {
        switch self {
        case .comment:
            line.contains("-->")
        case .processingInstruction:
            line.contains("?>")
        case .declaration:
            line.contains(">")
        case .cdata:
            line.contains("]]>")
        case let .element(tag):
            line.lowercased().contains("</\(tag)>")
        }
    }
}

enum ChatMarkdownBlockSegmenter {
    static let maxMathBytes = 5000
    static let maxTableBytes = 20000
    static let maxTableRows = 100
    static let maxTableColumns = 12
    static let maxTableCells = 600
    static let maxListBytes = 20000
    static let maxListItems = 100
    static let maxListDepth = 6
    static let maxDisclosureDepth = 32

    /// Extracts top-level structural blocks. The parser owns CommonMark
    /// container and reference semantics; nested list content stays attached
    /// to its owning list item.
    static func segments(markdown: String, isComplete: Bool) -> [ChatMarkdownBlock] {
        let (source, document) = self.parsedSourcePreservingDisclosureReferences(markdown)
        let mathResult = self.mathExtractions(
            source: source,
            document: document,
            isComplete: isComplete)
        var extractions = mathResult.extractions
        var proseEnd = source.lines.count

        for child in document.children {
            guard let lineRange = source.lineRange(for: child.range) else { continue }
            if mathResult.protectedRanges.contains(where: { $0.contains(lineRange.lowerBound) }) {
                continue
            }

            if !isComplete,
               child is Markdown.Paragraph,
               source.lines[lineRange].allSatisfy({ $0.trimmingCharacters(in: .whitespaces).hasPrefix("|") }),
               source.lines[lineRange.upperBound...].allSatisfy({ $0.trimmingCharacters(in: .whitespaces).isEmpty })
            {
                // Pending headers and bare row-opening pipes must not enter
                // prose: the parser can absorb them into a table on the next delta.
                proseEnd = lineRange.lowerBound
                continue
            }

            if let html = self.htmlBlockSource(child, source: source, lineRange: lineRange) {
                extractions.append(Extraction(lineRange: lineRange, html: html))
                continue
            }

            if let heading = child as? Markdown.Heading {
                extractions.append(Extraction(
                    lineRange: lineRange,
                    block: .heading(ChatMarkdownHeading(
                        level: heading.level,
                        markdown: source.text(in: lineRange)))))
                continue
            }

            if let code = child as? Markdown.CodeBlock,
               let opener = FenceOpener.parse(source.lines[lineRange.lowerBound])
            {
                let language = code.language?
                    .split(whereSeparator: \.isWhitespace)
                    .first
                    .map { $0.lowercased() }
                let closed = lineRange.count > 1
                    && opener.isClose(source.lines[lineRange.index(before: lineRange.endIndex)])
                extractions.append(Extraction(
                    lineRange: lineRange,
                    block: .code(ChatCodeBlock(
                        language: language,
                        code: self.dropStructuralCodeNewline(code.code),
                        isComplete: closed || isComplete))))
                continue
            }

            if let table = child as? Markdown.Table {
                let tableRange = source.tableLineRange(
                    reportedRange: lineRange,
                    columnCount: table.maxColumnCount)
                guard let rendered = self.table(table, source: source, lineRange: tableRange) else {
                    continue
                }
                extractions.append(Extraction(lineRange: tableRange, block: .table(rendered)))
                continue
            }

            if child is Markdown.OrderedList || child is Markdown.UnorderedList {
                // Streaming reveal tracks one prose block. Keep lists on that
                // path until completion so extracting item subdocuments cannot
                // make still-fading words appear instantly.
                guard isComplete else { continue }
                var itemCount = 0
                guard source.text(in: lineRange).utf8.count <= self.maxListBytes,
                      let list = self.list(
                          child,
                          source: source,
                          depth: 1,
                          itemCount: &itemCount)
                else { continue }
                extractions.append(Extraction(lineRange: lineRange, block: .list(list)))
                continue
            }

            if child is Markdown.ThematicBreak {
                let trailingLines = source.lines[lineRange.upperBound...]
                if !isComplete,
                   trailingLines.allSatisfy({ $0.trimmingCharacters(in: .whitespaces).isEmpty })
                {
                    continue
                }
                extractions.append(Extraction(lineRange: lineRange, block: .thematicBreak))
            }
        }

        extractions.sort { left, right in
            if left.lineRange.lowerBound != right.lineRange.lowerBound {
                return left.lineRange.lowerBound < right.lineRange.lowerBound
            }
            return left.lineRange.upperBound > right.lineRange.upperBound
        }

        let unfolded = self.unfold(extractions, source: source, proseEnd: proseEnd, isComplete: isComplete)
        let blocks = self.foldDisclosures(unfolded)
        let reparsesListContent = blocks.contains { block in
            if case .list = block { return true }
            return false
        }
        if blocks.count > 1 || reparsesListContent,
           self.containsReferenceLink(document, source: source)
        {
            return self.proseOnly(Array(source.lines[..<proseEnd]))
        }
        return blocks
    }

    private static func mathExtractions(
        source: SourceBuffer,
        document: Document,
        isComplete: Bool) -> MathExtractionResult
    {
        guard source.markdown.contains("$$") || source.markdown.contains(#"\["#) else {
            return MathExtractionResult(extractions: [], protectedRanges: [])
        }
        var topLevelParagraphLines = Set<Int>()
        var inlineCodeLines = Set<Int>()
        func collectInlineCodeLines(from markup: any Markup) {
            if markup is Markdown.InlineCode, let lineRange = source.lineRange(for: markup.range) {
                inlineCodeLines.formUnion(lineRange)
            }
            for child in markup.children {
                collectInlineCodeLines(from: child)
            }
        }
        for child in document.children where child is Markdown.Paragraph {
            if let lineRange = source.lineRange(for: child.range) {
                topLevelParagraphLines.formUnion(lineRange)
            }
            collectInlineCodeLines(from: child)
        }
        var extractions: [Extraction] = []
        var protectedRanges: [Range<Int>] = []
        var lineIndex = 0

        while lineIndex < source.lines.count {
            guard topLevelParagraphLines.contains(lineIndex),
                  !inlineCodeLines.contains(lineIndex),
                  let opener = MathDelimiter.parse(source.lines[lineIndex])
            else {
                lineIndex += 1
                continue
            }

            if let sameLineLatex = opener.sameLineLatex {
                let lineRange = lineIndex..<(lineIndex + 1)
                if sameLineLatex.utf8.count <= self.maxMathBytes {
                    extractions.append(Extraction(
                        lineRange: lineRange,
                        block: .math(ChatMathBlock(latex: sameLineLatex, isComplete: true))))
                } else {
                    protectedRanges.append(lineRange)
                }
                lineIndex += 1
                continue
            }

            let contentStart = lineIndex + 1
            var closeIndex = contentStart
            while closeIndex < source.lines.count,
                  !opener.isClose(source.lines[closeIndex])
            {
                closeIndex += 1
            }

            let closed = closeIndex < source.lines.count
            guard closed || isComplete else {
                // The first unmatched opener owns the remaining stream. Stop
                // here so later opener-looking lines do not trigger rescans.
                protectedRanges.append(lineIndex..<source.lines.count)
                return MathExtractionResult(extractions: extractions, protectedRanges: protectedRanges)
            }

            let contentEnd = closed ? closeIndex : source.lines.count
            let lineRange = lineIndex..<(closed ? closeIndex + 1 : source.lines.count)
            let latex = source.lines[contentStart..<contentEnd]
                .joined(separator: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if latex.utf8.count <= self.maxMathBytes {
                extractions.append(Extraction(
                    lineRange: lineRange,
                    block: .math(ChatMathBlock(latex: latex, isComplete: closed || isComplete))))
            } else {
                protectedRanges.append(lineRange)
            }
            lineIndex = lineRange.upperBound
        }
        return MathExtractionResult(extractions: extractions, protectedRanges: protectedRanges)
    }

    private static func proseOnly(_ lines: [String]) -> [ChatMarkdownBlock] {
        // Boundary blank lines only separate extracted blocks; the rendered
        // VStack provides that spacing. Interior blanks remain paragraphs.
        var slice = lines[...]
        while slice.first?.trimmingCharacters(in: .whitespaces).isEmpty == true {
            slice = slice.dropFirst()
        }
        while slice.last?.trimmingCharacters(in: .whitespaces).isEmpty == true {
            slice = slice.dropLast()
        }
        guard !slice.isEmpty else { return [] }
        return [.prose(slice.joined(separator: "\n"))]
    }

    private static func containsReferenceLink(_ document: Document, source: SourceBuffer) -> Bool {
        func search(_ markup: any Markup) -> Bool {
            if self.isReferenceLink(markup, source: source) {
                return true
            }
            return markup.children.contains(where: search)
        }
        return search(document)
    }

    private static func parsedSourcePreservingDisclosureReferences(
        _ markdown: String) -> (SourceBuffer, Document)
    {
        let source = SourceBuffer(markdown)
        let document = Document(parsing: source.markdown)
        guard self.containsDisclosure(in: document, source: source),
              let resolved = self.resolvingReferenceLinks(in: document, source: source)
        else { return (source, document) }

        let resolvedSource = SourceBuffer(resolved)
        return (resolvedSource, Document(parsing: resolvedSource.markdown))
    }

    private static func containsDisclosure(in document: Document, source: SourceBuffer) -> Bool {
        document.children.contains { child in
            guard let lineRange = source.lineRange(for: child.range) else { return false }
            guard let html = self.htmlBlockSource(child, source: source, lineRange: lineRange) else {
                return false
            }
            return DisclosureTokenizer.startsWithCandidateLine(html)
        }
    }

    private static func resolvingReferenceLinks(in document: Document, source: SourceBuffer) -> String? {
        var replacements: [SourceReplacement] = []

        func collect(_ markup: any Markup) {
            if self.isReferenceLink(markup, source: source),
               let range = markup.range
            {
                replacements.append(SourceReplacement(range: range, markdown: markup.format()))
                return
            }
            for child in markup.children {
                collect(child)
            }
        }

        collect(document)
        guard !replacements.isEmpty else { return nil }
        return source.replacing(replacements)
    }

    private static func isReferenceLink(_ markup: any Markup, source: SourceBuffer) -> Bool {
        guard markup is Markdown.Link || markup is Markdown.Image,
              let range = markup.range,
              let raw = source.text(in: range)?.trimmingCharacters(in: .whitespacesAndNewlines)
        else { return false }
        return raw.hasSuffix("]")
    }

    private static func dropStructuralCodeNewline(_ code: String) -> String {
        code.hasSuffix("\n") ? String(code.dropLast()) : code
    }

    private static func htmlBlockSource(
        _ child: any Markup,
        source: SourceBuffer,
        lineRange: Range<Int>) -> String?
    {
        guard child is Markdown.HTMLBlock else { return nil }
        return source.text(in: lineRange)
    }

    private static func foldDisclosures(_ unfolded: [UnfoldedBlock]) -> [ChatMarkdownBlock] {
        struct Frame {
            var summary: String?
            let isExpanded: Bool
            var blocks: [ChatMarkdownBlock] = []
        }

        var result: [ChatMarkdownBlock] = []
        var stack: [Frame] = []

        func append(_ block: ChatMarkdownBlock) {
            if stack.isEmpty {
                result.append(block)
            } else {
                stack[stack.count - 1].blocks.append(block)
            }
        }

        func closeTopFrame() {
            guard let frame = stack.popLast() else { return }
            append(.disclosure(ChatMarkdownDisclosure(
                summary: frame.summary,
                isExpanded: frame.isExpanded,
                blocks: frame.blocks)))
        }

        for token in unfolded {
            switch token {
            case let .block(block):
                append(block)
            case let .disclosureOpen(isExpanded):
                stack.append(Frame(summary: nil, isExpanded: isExpanded))
            case let .disclosureSummary(summary):
                if !stack.isEmpty {
                    stack[stack.count - 1].summary = summary
                }
            case .disclosureClose:
                closeTopFrame()
            }
        }

        // The model streams the opener before the closer. Treat EOF as an
        // implicit close so each delta remains a usable disclosure hierarchy.
        while !stack.isEmpty {
            closeTopFrame()
        }
        return result
    }

    fileprivate struct Extraction {
        let lineRange: Range<Int>
        let content: Content

        enum Content {
            case block(ChatMarkdownBlock)
            case html(String)
        }

        init(lineRange: Range<Int>, block: ChatMarkdownBlock) {
            self.lineRange = lineRange
            self.content = .block(block)
        }

        init(lineRange: Range<Int>, html: String) {
            self.lineRange = lineRange
            self.content = .html(html)
        }
    }

    fileprivate enum UnfoldedBlock {
        case block(ChatMarkdownBlock)
        case disclosureOpen(isExpanded: Bool)
        case disclosureSummary(String)
        case disclosureClose
    }

    private struct DisclosureTokenizer {
        private struct BalanceFrame {
            let isStructural: Bool
            var hasSummary: Bool
        }

        private enum TagKind {
            case detailsOpen(isExpanded: Bool)
            case detailsClose
            case summaryOpen
            case summaryClose
            case unsupportedDetailsOpen
            case unsupportedDetailsClose
            case unsupportedSummary
        }

        private struct Tag {
            let range: Range<String.Index>
            let raw: String
            let kind: TagKind
        }

        private var balanceStack: [BalanceFrame] = []

        static func startsWithCandidateLine(_ source: String) -> Bool {
            let firstContentLine = source
                .split(separator: "\n", omittingEmptySubsequences: false)
                .first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            return firstContentLine.map { Self.tags(in: String($0)) != nil } ?? false
        }

        func shouldTokenize(_ source: String) -> Bool {
            !self.balanceStack.isEmpty || Self.startsWithCandidateLine(source)
        }

        mutating func tokenize(
            _ source: String,
            parseMarkdown: (String) -> [UnfoldedBlock]) -> [UnfoldedBlock]
        {
            let lines = source.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            var tokens: [UnfoldedBlock] = []
            var pendingSource = ""
            var rawHTMLContext: ChatMarkdownRawHTMLContext?

            func flushSource() {
                let trimmed = pendingSource.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else {
                    pendingSource = ""
                    return
                }
                tokens.append(contentsOf: parseMarkdown(pendingSource))
                pendingSource = ""
            }

            func appendLiteral(_ raw: String) {
                flushSource()
                tokens.append(.block(.prose(raw)))
            }

            func appendSourceLine(_ line: String, at index: Int) {
                pendingSource += line
                if index < lines.count - 1 { pendingSource += "\n" }
            }

            for (lineIndex, line) in lines.enumerated() {
                if let context = rawHTMLContext {
                    appendSourceLine(line, at: lineIndex)
                    if context.closes(in: line) { rawHTMLContext = nil }
                    continue
                }
                if let context = ChatMarkdownRawHTMLContext.opening(in: line) {
                    appendSourceLine(line, at: lineIndex)
                    if !context.closes(in: line) { rawHTMLContext = context }
                    continue
                }
                guard let tags = Self.tags(in: line) else {
                    appendSourceLine(line, at: lineIndex)
                    continue
                }

                var cursor = line.startIndex
                var index = 0
                while index < tags.count {
                    let tag = tags[index]
                    pendingSource += line[cursor..<tag.range.lowerBound]

                    switch tag.kind {
                    case let .detailsOpen(isExpanded):
                        flushSource()
                        let isStructural = self.balanceStack.count < Self.maxDepth
                        if isStructural {
                            tokens.append(.disclosureOpen(isExpanded: isExpanded))
                        } else {
                            appendLiteral(tag.raw)
                        }
                        self.balanceStack.append(BalanceFrame(
                            isStructural: isStructural,
                            hasSummary: false))
                    case .unsupportedDetailsOpen:
                        appendLiteral(tag.raw)
                        self.balanceStack.append(BalanceFrame(
                            isStructural: false,
                            hasSummary: false))
                    case .detailsClose, .unsupportedDetailsClose:
                        guard let frame = self.balanceStack.popLast() else {
                            appendLiteral(tag.raw)
                            cursor = tag.range.upperBound
                            index += 1
                            continue
                        }
                        flushSource()
                        if frame.isStructural, case .detailsClose = tag.kind {
                            tokens.append(.disclosureClose)
                        } else {
                            appendLiteral(tag.raw)
                        }
                    case .summaryOpen:
                        // The web block rule also pairs summary tags within one line;
                        // multiline summaries deliberately remain literal on every surface.
                        // Reference definitions resolve in bodies, not standalone summaries;
                        // keeping fragments isolated avoids cross-document splicing.
                        let closeIndex = tags[(index + 1)...].firstIndex { candidate in
                            if case .summaryClose = candidate.kind { return true }
                            return false
                        }
                        if let closeIndex,
                           !self.balanceStack.isEmpty,
                           self.balanceStack[self.balanceStack.count - 1].isStructural,
                           !self.balanceStack[self.balanceStack.count - 1].hasSummary
                        {
                            flushSource()
                            let close = tags[closeIndex]
                            let summary = String(line[tag.range.upperBound..<close.range.lowerBound])
                            if !summary.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                tokens.append(.disclosureSummary(summary))
                            }
                            self.balanceStack[self.balanceStack.count - 1].hasSummary = true
                            cursor = close.range.upperBound
                            index = closeIndex + 1
                            continue
                        }
                        appendLiteral(tag.raw)
                    case .summaryClose, .unsupportedSummary:
                        appendLiteral(tag.raw)
                    }

                    cursor = tag.range.upperBound
                    index += 1
                }
                pendingSource += line[cursor...]
                if lineIndex < lines.count - 1 { pendingSource += "\n" }
            }

            flushSource()
            return tokens
        }

        private static let maxDepth = ChatMarkdownBlockSegmenter.maxDisclosureDepth
        private static let tagExpression: NSRegularExpression = {
            do {
                return try NSRegularExpression(
                    pattern: #"</?(?:details|summary)(?=[\s>])[^>]*>"#,
                    options: [.caseInsensitive])
            } catch {
                preconditionFailure("invalid disclosure tag expression: \(error)")
            }
        }()

        private static func tags(in line: String) -> [Tag]? {
            guard line.range(
                of: #"^ {0,3}</?(?:details|summary)(?=[\s>])"#,
                options: [.regularExpression, .caseInsensitive]) != nil
            else { return nil }

            let codeRanges = self.inlineCodeRanges(in: line)
            let fullRange = NSRange(line.startIndex..<line.endIndex, in: line)
            let matches = self.tagExpression.matches(in: line, range: fullRange)
            let tags = matches.compactMap { match -> Tag? in
                guard let range = Range(match.range, in: line),
                      !self.isEscaped(line, at: range.lowerBound),
                      !codeRanges.contains(where: { $0.contains(range.lowerBound) })
                else { return nil }
                let raw = String(line[range])
                return Tag(range: range, raw: raw, kind: self.kind(of: raw))
            }
            return tags.isEmpty ? nil : tags
        }

        private static func kind(of raw: String) -> TagKind {
            let lower = raw.lowercased()
            switch lower {
            case "<details>": return .detailsOpen(isExpanded: false)
            case "<details open>": return .detailsOpen(isExpanded: true)
            case "</details>": return .detailsClose
            case "<summary>": return .summaryOpen
            case "</summary>": return .summaryClose
            default:
                if lower.hasPrefix("</details") { return .unsupportedDetailsClose }
                if lower.hasPrefix("<details") { return .unsupportedDetailsOpen }
                return .unsupportedSummary
            }
        }

        private static func isEscaped(_ line: String, at index: String.Index) -> Bool {
            var cursor = index
            var count = 0
            while cursor > line.startIndex {
                let previous = line.index(before: cursor)
                guard line[previous] == "\\" else { break }
                count += 1
                cursor = previous
            }
            return count.isMultiple(of: 2) == false
        }

        private static func inlineCodeRanges(in line: String) -> [Range<String.Index>] {
            var ranges: [Range<String.Index>] = []
            var cursor = line.startIndex
            while cursor < line.endIndex {
                guard line[cursor] == "`" else {
                    cursor = line.index(after: cursor)
                    continue
                }
                let openerStart = cursor
                var openerEnd = cursor
                while openerEnd < line.endIndex, line[openerEnd] == "`" {
                    openerEnd = line.index(after: openerEnd)
                }
                let runLength = line.distance(from: openerStart, to: openerEnd)
                var search = openerEnd
                var closeEnd: String.Index?
                while search < line.endIndex {
                    guard line[search] == "`" else {
                        search = line.index(after: search)
                        continue
                    }
                    let closeStart = search
                    while search < line.endIndex, line[search] == "`" {
                        search = line.index(after: search)
                    }
                    if line.distance(from: closeStart, to: search) == runLength {
                        closeEnd = search
                        break
                    }
                }
                if let closeEnd {
                    ranges.append(openerStart..<closeEnd)
                    cursor = closeEnd
                } else {
                    cursor = openerEnd
                }
            }
            return ranges
        }
    }

    private struct MathExtractionResult {
        let extractions: [Extraction]
        /// Rejected math stays prose and owns any block-looking syntax inside its span.
        let protectedRanges: [Range<Int>]
    }

    fileprivate struct SourceReplacement {
        let range: SourceRange
        let markdown: String
    }

    private struct MathDelimiter {
        let close: String
        let sameLineLatex: String?

        static func parse(_ line: String) -> MathDelimiter? {
            let (indent, afterIndent) = FenceOpener.leadingSpaces(of: line)
            guard indent <= 3, afterIndent < line.endIndex else { return nil }
            let suffix = line[afterIndent...]
            let pair: (open: String, close: String)
            if suffix.hasPrefix("$$") {
                pair = ("$$", "$$")
            } else if suffix.hasPrefix(#"\["#) {
                pair = (#"\["#, #"\]"#)
            } else {
                return nil
            }

            let contentStart = suffix.index(suffix.startIndex, offsetBy: pair.open.count)
            let remainder = suffix[contentStart...]
            if remainder.trimmingCharacters(in: .whitespaces).isEmpty {
                return MathDelimiter(close: pair.close, sameLineLatex: nil)
            }
            guard let closeRange = remainder.range(of: pair.close, options: .backwards),
                  remainder[closeRange.upperBound...].trimmingCharacters(in: .whitespaces).isEmpty
            else { return nil }
            let latex = remainder[..<closeRange.lowerBound]
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return MathDelimiter(close: pair.close, sameLineLatex: latex)
        }

        func isClose(_ line: String) -> Bool {
            line.trimmingCharacters(in: .whitespaces) == self.close
        }
    }

    private static func table(
        _ table: Markdown.Table,
        source: SourceBuffer,
        lineRange: Range<Int>) -> ChatMarkdownTable?
    {
        let columnCount = table.maxColumnCount
        let bodyStart = min(lineRange.lowerBound + 2, lineRange.upperBound)
        let bodyLines = bodyStart..<lineRange.upperBound
        let rowCount = bodyLines.count + 1
        let cellCount = columnCount * rowCount
        let byteCount = source.text(in: lineRange).utf8.count
        guard columnCount > 0,
              columnCount <= self.maxTableColumns,
              rowCount <= self.maxTableRows,
              cellCount <= self.maxTableCells,
              byteCount <= self.maxTableBytes
        else { return nil }

        let header = source.tableCells(at: lineRange.lowerBound)
        guard header.count == columnCount else { return nil }
        let rows = bodyLines.map { lineIndex in
            let cells = source.tableCells(at: lineIndex)
            if cells.count >= columnCount { return Array(cells.prefix(columnCount)) }
            return cells + Array(repeating: "", count: columnCount - cells.count)
        }
        let alignments = table.columnAlignments.map { alignment in
            switch alignment {
            case .center: ChatMarkdownTable.ColumnAlignment.center
            case .right: ChatMarkdownTable.ColumnAlignment.trailing
            case .left, nil: ChatMarkdownTable.ColumnAlignment.leading
            }
        }
        return ChatMarkdownTable(header: header, alignments: alignments, rows: rows)
    }

    private static func list(
        _ markup: any Markup,
        source: SourceBuffer,
        depth: Int,
        itemCount: inout Int) -> ChatMarkdownList?
    {
        guard depth <= self.maxListDepth else { return nil }

        let kind: ChatMarkdownList.Kind
        let items: [Markdown.ListItem]
        if let ordered = markup as? Markdown.OrderedList {
            kind = .ordered(start: ordered.startIndex)
            items = Array(ordered.listItems)
        } else if let unordered = markup as? Markdown.UnorderedList {
            kind = .unordered
            items = Array(unordered.listItems)
        } else {
            return nil
        }

        var renderedItems: [ChatMarkdownListItem] = []
        for item in items {
            itemCount += 1
            guard itemCount <= self.maxListItems else { return nil }

            let checkbox: ChatMarkdownListItem.Checkbox? = switch item.checkbox {
            case .checked?: .checked
            case .unchecked?: .unchecked
            case nil: nil
            }
            var content: [ChatMarkdownListItemContent] = []
            for child in item.children {
                if let code = child as? Markdown.CodeBlock {
                    let language = code.language?
                        .split(whereSeparator: \.isWhitespace)
                        .first
                        .map { $0.lowercased() }
                    content.append(.code(ChatCodeBlock(
                        language: language,
                        code: self.dropStructuralCodeNewline(code.code),
                        isComplete: true)))
                } else if child is Markdown.OrderedList || child is Markdown.UnorderedList {
                    guard let nested = self.list(
                        child,
                        source: source,
                        depth: depth + 1,
                        itemCount: &itemCount)
                    else { return nil }
                    content.append(.list(nested))
                } else if let range = child.range,
                          let markdown = source.dedentedText(in: range),
                          !markdown.isEmpty
                {
                    content.append(.markdown(markdown))
                }
            }
            renderedItems.append(ChatMarkdownListItem(checkbox: checkbox, content: content))
        }
        return ChatMarkdownList(kind: kind, items: renderedItems)
    }

    fileprivate struct SourceBuffer {
        let markdown: String
        let lines: [String]

        init(_ markdown: String) {
            self.markdown = markdown.replacingOccurrences(of: "\r\n", with: "\n")
            self.lines = self.markdown.split(separator: "\n", omittingEmptySubsequences: false)
                .map(String.init)
        }

        func lineRange(for range: SourceRange?) -> Range<Int>? {
            guard let range else { return nil }
            let start = range.lowerBound.line - 1
            let end = min(range.upperBound.line, self.lines.count)
            guard start >= 0, start < end else { return nil }
            return start..<end
        }

        func text(in lineRange: Range<Int>) -> String {
            self.lines[lineRange].joined(separator: "\n")
        }

        func text(in range: SourceRange) -> String? {
            let startLine = range.lowerBound.line - 1
            let endLine = range.upperBound.line - 1
            guard self.lines.indices.contains(startLine), self.lines.indices.contains(endLine) else { return nil }

            let startOffset = range.lowerBound.column - 1
            let endOffset = range.upperBound.column - 1
            if startLine == endLine {
                return self.utf8Slice(self.lines[startLine], from: startOffset, to: endOffset)
            }

            guard let first = self.utf8Slice(
                self.lines[startLine],
                from: startOffset,
                to: self.lines[startLine].utf8.count),
                let last = self.utf8Slice(self.lines[endLine], from: 0, to: endOffset)
            else { return nil }
            let middle = self.lines[(startLine + 1)..<endLine]
            return ([first] + middle + [last]).joined(separator: "\n")
        }

        func replacing(_ replacements: [SourceReplacement]) -> String? {
            var bytes = Array(self.markdown.utf8)
            let byteReplacements = replacements.compactMap { replacement -> (Range<Int>, [UInt8])? in
                guard let lower = self.utf8Offset(for: replacement.range.lowerBound),
                      let upper = self.utf8Offset(for: replacement.range.upperBound),
                      lower <= upper
                else { return nil }
                return (lower..<upper, Array(replacement.markdown.utf8))
            }
            guard byteReplacements.count == replacements.count else { return nil }
            for replacement in byteReplacements.sorted(by: { $0.0.lowerBound > $1.0.lowerBound }) {
                bytes.replaceSubrange(replacement.0, with: replacement.1)
            }
            return String(bytes: bytes, encoding: .utf8)
        }

        private func utf8Offset(for location: SourceLocation) -> Int? {
            let lineIndex = location.line - 1
            let columnOffset = location.column - 1
            guard self.lines.indices.contains(lineIndex),
                  columnOffset >= 0,
                  columnOffset <= self.lines[lineIndex].utf8.count
            else { return nil }
            return self.lines[..<lineIndex].reduce(0) { $0 + $1.utf8.count + 1 } + columnOffset
        }

        func dedentedText(in range: SourceRange) -> String? {
            guard let raw = self.text(in: range) else { return nil }
            let startLine = range.lowerBound.line - 1
            let startOffset = max(range.lowerBound.column - 1, 0)
            guard self.lines.indices.contains(startLine),
                  let prefix = self.utf8Slice(self.lines[startLine], from: 0, to: startOffset)
            else { return nil }
            let indentColumns = self.visualWidth(of: prefix)
            guard indentColumns > 0, raw.contains("\n") else { return raw }
            let lines = raw.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
            return ([lines[0]] + lines.dropFirst().map { line in
                self.droppingIndent(columns: indentColumns, from: line)
            }).joined(separator: "\n")
        }

        private func visualWidth(of indentation: String) -> Int {
            indentation.reduce(into: 0) { column, character in
                if character == "\t" {
                    column += 4 - (column % 4)
                } else {
                    column += 1
                }
            }
        }

        private func droppingIndent(columns target: Int, from line: String) -> String {
            var index = line.startIndex
            var column = 0
            while index < line.endIndex, column < target {
                let character = line[index]
                let nextIndex = line.index(after: index)
                if character == " " {
                    column += 1
                    index = nextIndex
                } else if character == "\t" {
                    let nextColumn = column + 4 - (column % 4)
                    if nextColumn > target {
                        return String(repeating: " ", count: nextColumn - target) + line[nextIndex...]
                    }
                    column = nextColumn
                    index = nextIndex
                } else {
                    break
                }
            }
            return String(line[index...])
        }

        private func utf8Slice(_ line: String, from start: Int, to end: Int) -> String? {
            let bytes = line.utf8
            guard start >= 0, start <= end, end <= bytes.count else { return nil }
            let lower = bytes.index(bytes.startIndex, offsetBy: start)
            let upper = bytes.index(bytes.startIndex, offsetBy: end)
            return String(bytes: bytes[lower..<upper], encoding: .utf8)
        }

        func tableCells(at lineIndex: Int) -> [String] {
            guard self.lines.indices.contains(lineIndex) else { return [] }
            let line = self.lines[lineIndex]
            var cells: [String] = []
            var current = ""
            var escaped = false
            for character in line {
                if escaped {
                    if character != "|" { current.append("\\") }
                    current.append(character)
                    escaped = false
                } else if character == "\\" {
                    escaped = true
                } else if character == "|" {
                    cells.append(current)
                    current = ""
                } else {
                    current.append(character)
                }
            }
            if escaped { current.append("\\") }
            cells.append(current)

            var trimmed = cells.map { $0.trimmingCharacters(in: .whitespaces) }
            let trimmedLine = line.trimmingCharacters(in: .whitespaces)
            if trimmedLine.hasPrefix("|"), trimmed.first?.isEmpty == true { trimmed.removeFirst() }
            if trimmedLine.hasSuffix("|"), trimmed.last?.isEmpty == true { trimmed.removeLast() }
            return trimmed
        }

        func tableLineRange(reportedRange: Range<Int>, columnCount: Int) -> Range<Int> {
            guard reportedRange.count > 1 else { return reportedRange }
            for delimiterIndex in reportedRange.dropFirst().indices
                where self.isTableDelimiter(self.lines[delimiterIndex], columnCount: columnCount)
            {
                return reportedRange.index(before: delimiterIndex)..<reportedRange.upperBound
            }
            return reportedRange
        }

        private func isTableDelimiter(_ line: String, columnCount: Int) -> Bool {
            let trimmedLine = line.trimmingCharacters(in: .whitespaces)
            var cells = trimmedLine.split(separator: "|", omittingEmptySubsequences: false)
                .map { $0.trimmingCharacters(in: .whitespaces) }
            if trimmedLine.hasPrefix("|"), cells.first?.isEmpty == true { cells.removeFirst() }
            if trimmedLine.hasSuffix("|"), cells.last?.isEmpty == true { cells.removeLast() }
            return cells.count == columnCount && cells.allSatisfy {
                $0.range(of: #"^:?-+:?$"#, options: .regularExpression) != nil
            }
        }
    }

    private struct FenceOpener {
        let character: Character
        let count: Int

        static func parse(_ line: String) -> FenceOpener? {
            let (indent, afterIndent) = Self.leadingSpaces(of: line)
            guard indent <= 3, afterIndent < line.endIndex else { return nil }
            let character = line[afterIndent]
            guard character == "`" || character == "~" else { return nil }

            var cursor = afterIndent
            var count = 0
            while cursor < line.endIndex, line[cursor] == character {
                count += 1
                cursor = line.index(after: cursor)
            }
            guard count >= 3 else { return nil }
            let info = line[cursor...].trimmingCharacters(in: .whitespaces)
            if character == "`", info.contains("`") { return nil }
            return FenceOpener(character: character, count: count)
        }

        func isClose(_ line: String) -> Bool {
            let (indent, afterIndent) = Self.leadingSpaces(of: line)
            guard indent <= 3, afterIndent < line.endIndex, line[afterIndent] == self.character else {
                return false
            }
            var cursor = afterIndent
            var count = 0
            while cursor < line.endIndex, line[cursor] == self.character {
                count += 1
                cursor = line.index(after: cursor)
            }
            return count >= self.count && line[cursor...].allSatisfy(\.isWhitespace)
        }

        fileprivate static func leadingSpaces(of line: String) -> (count: Int, end: String.Index) {
            var count = 0
            var cursor = line.startIndex
            while cursor < line.endIndex, line[cursor] == " " {
                count += 1
                cursor = line.index(after: cursor)
            }
            return (count, cursor)
        }
    }
}

extension ChatMarkdownBlockSegmenter {
    fileprivate static func unfold(
        _ extractions: [Extraction],
        source: SourceBuffer,
        proseEnd: Int,
        isComplete: Bool) -> [UnfoldedBlock]
    {
        var unfolded: [UnfoldedBlock] = []
        var disclosureTokenizer = DisclosureTokenizer()
        var proseStart = 0

        func appendProse(until end: Int) {
            guard proseStart < end else { return }
            unfolded.append(contentsOf: self.proseOnly(Array(source.lines[proseStart..<end])).map(UnfoldedBlock.block))
        }

        for extraction in extractions where extraction.lineRange.lowerBound >= proseStart {
            if case let .html(html) = extraction.content,
               !disclosureTokenizer.shouldTokenize(html)
            {
                continue
            }
            appendProse(until: extraction.lineRange.lowerBound)
            switch extraction.content {
            case let .block(block):
                unfolded.append(.block(block))
            case let .html(html):
                unfolded.append(contentsOf: disclosureTokenizer.tokenize(
                    html,
                    parseMarkdown: { markdown in
                        self.segments(markdown: markdown, isComplete: isComplete).map(UnfoldedBlock.block)
                    }))
            }
            proseStart = extraction.lineRange.upperBound
        }

        appendProse(until: proseEnd)
        return unfolded
    }
}
