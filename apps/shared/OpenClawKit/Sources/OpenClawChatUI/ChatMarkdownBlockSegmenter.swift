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
    case thematicBreak
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

enum ChatMarkdownBlockSegmenter {
    static let maxMathBytes = 5000
    static let maxTableBytes = 20000
    static let maxTableRows = 100
    static let maxTableColumns = 12
    static let maxTableCells = 600
    static let maxListBytes = 20000
    static let maxListItems = 100
    static let maxListDepth = 6

    /// Extracts top-level structural blocks. The parser owns CommonMark
    /// container and reference semantics; nested list content stays attached
    /// to its owning list item.
    static func segments(markdown: String, isComplete: Bool) -> [ChatMarkdownBlock] {
        let source = SourceBuffer(markdown)
        let document = Document(parsing: source.markdown)
        let mathResult = self.mathExtractions(
            source: source,
            document: document,
            isComplete: isComplete)
        var extractions = mathResult.extractions

        for child in document.children {
            guard let lineRange = source.lineRange(for: child.range) else { continue }
            if mathResult.protectedRanges.contains(where: { $0.contains(lineRange.lowerBound) }) {
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
                let trailingLines = source.lines[tableRange.upperBound...]
                if !isComplete,
                   trailingLines.allSatisfy({ $0.trimmingCharacters(in: .whitespaces).isEmpty })
                {
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

        var blocks: [ChatMarkdownBlock] = []
        var proseStart = 0

        func appendProse(until end: Int) {
            guard proseStart < end else { return }
            blocks.append(contentsOf: self.proseOnly(Array(source.lines[proseStart..<end])))
        }

        for extraction in extractions where extraction.lineRange.lowerBound >= proseStart {
            appendProse(until: extraction.lineRange.lowerBound)
            blocks.append(extraction.block)
            proseStart = extraction.lineRange.upperBound
        }

        appendProse(until: source.lines.count)
        let reparsesListContent = blocks.contains { block in
            if case .list = block { return true }
            return false
        }
        if blocks.count > 1 || reparsesListContent,
           self.containsReferenceLink(document, source: source)
        {
            return self.proseOnly(source.lines)
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
            if markup is Markdown.Link || markup is Markdown.Image,
               let range = markup.range,
               let raw = source.text(in: range)?.trimmingCharacters(in: .whitespacesAndNewlines),
               raw.hasSuffix("]")
            {
                return true
            }
            return markup.children.contains(where: search)
        }
        return search(document)
    }

    private static func dropStructuralCodeNewline(_ code: String) -> String {
        code.hasSuffix("\n") ? String(code.dropLast()) : code
    }

    private struct Extraction {
        let lineRange: Range<Int>
        let block: ChatMarkdownBlock
    }

    private struct MathExtractionResult {
        let extractions: [Extraction]
        /// Rejected math stays prose and owns any block-looking syntax inside its span.
        let protectedRanges: [Range<Int>]
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

    private struct SourceBuffer {
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
