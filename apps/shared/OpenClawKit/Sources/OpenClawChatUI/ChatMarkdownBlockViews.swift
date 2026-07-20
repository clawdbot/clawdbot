import SwiftMath
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor
struct ChatCodeBlockView: View {
    let block: ChatCodeBlock

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let language = self.block.language {
                Text(language)
                    .font(OpenClawChatTypography.caption2)
                    .foregroundStyle(.secondary)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(self.attributedCode)
                    .font(OpenClawChatTypography.mono(size: 13, relativeTo: .footnote))
                    .foregroundStyle(OpenClawChatTheme.assistantText)
                    .lineSpacing(2)
                    .textSelection(.enabled)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(OpenClawChatTheme.subtleCard)
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)))
    }

    private var attributedCode: AttributedString {
        // Open (still-streaming) fences skip highlighting so each delta stays
        // cheap; completed blocks hit the content-keyed highlight cache.
        guard self.block.isComplete else { return AttributedString(self.block.code) }
        return ChatCodeHighlightCache.highlighted(
            code: self.block.code,
            languageId: self.block.language)
    }
}

@MainActor
struct ChatMathBlockView: View {
    let block: ChatMathBlock
    let textColor: Color

    @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = OpenClawChatTypography.bodySize

    var body: some View {
        if self.block.isComplete,
           ChatMathParseCache.mathList(latex: self.block.latex) != nil
        {
            ScrollView(.horizontal, showsIndicators: false) {
                ChatMathPlatformView(
                    latex: self.block.latex,
                    fontSize: self.fontSize,
                    textColor: self.textColor)
                    .fixedSize()
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(self.block.latex)
            }
            .defaultScrollAnchor(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
        } else {
            ChatCodeBlockView(block: ChatCodeBlock(
                language: nil,
                code: self.block.latex,
                isComplete: false))
        }
    }
}

#if os(macOS)
@MainActor
private struct ChatMathPlatformView: NSViewRepresentable {
    let latex: String
    let fontSize: CGFloat
    let textColor: Color

    func makeNSView(context: Context) -> MTMathUILabel {
        MTMathUILabel()
    }

    func updateNSView(_ view: MTMathUILabel, context: Context) {
        self.configure(view)
    }

    private func configure(_ view: MTMathUILabel) {
        view.displayErrorInline = false
        view.labelMode = .display
        view.textAlignment = .center
        view.fontSize = self.fontSize
        view.textColor = NSColor(self.textColor)
        if view.latex != self.latex {
            view.latex = self.latex
        }
    }
}
#else
@MainActor
private struct ChatMathPlatformView: UIViewRepresentable {
    let latex: String
    let fontSize: CGFloat
    let textColor: Color

    func makeUIView(context: Context) -> MTMathUILabel {
        MTMathUILabel()
    }

    func updateUIView(_ view: MTMathUILabel, context: Context) {
        self.configure(view)
    }

    private func configure(_ view: MTMathUILabel) {
        view.displayErrorInline = false
        view.labelMode = .display
        view.textAlignment = .center
        view.fontSize = self.fontSize
        view.textColor = UIColor(self.textColor)
        if view.latex != self.latex {
            view.latex = self.latex
        }
    }
}
#endif

@MainActor
struct ChatMarkdownTableView: View {
    let table: ChatMarkdownTable

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .topLeading, horizontalSpacing: 14, verticalSpacing: 7) {
                GridRow {
                    ForEach(self.table.header.indices, id: \.self) { column in
                        // One cell per column carries the GFM alignment.
                        self.cell(self.table.header[column], isHeader: true)
                            .gridColumnAlignment(self.columnAlignment(column))
                    }
                }
                Divider()
                ForEach(self.table.rows.indices, id: \.self) { rowIndex in
                    GridRow {
                        ForEach(self.table.rows[rowIndex].indices, id: \.self) { column in
                            self.cell(self.table.rows[rowIndex][column], isHeader: false)
                        }
                    }
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(OpenClawChatTheme.subtleCard)
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)))
    }

    private func cell(_ text: String, isHeader: Bool) -> some View {
        Text(self.inlineMarkdown(text))
            .font(isHeader ? OpenClawChatTypography.footnoteSemiBold : OpenClawChatTypography.footnote)
            .foregroundStyle(OpenClawChatTheme.assistantText)
            .textSelection(.enabled)
    }

    private func inlineMarkdown(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }

    private func columnAlignment(_ column: Int) -> HorizontalAlignment {
        guard column < self.table.alignments.count else { return .leading }
        switch self.table.alignments[column] {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }
}

@MainActor
struct ChatMarkdownListView: View {
    let list: ChatMarkdownList
    let context: ChatMarkdownRenderer.Context
    let variant: ChatMarkdownVariant
    let font: Font
    let textColor: Color
    let inlineMathTypography: ChatMarkdownRenderer.InlineMathTypography

    var body: some View {
        Grid(alignment: .topLeading, horizontalSpacing: 8, verticalSpacing: 7) {
            ForEach(self.list.items.indices, id: \.self) { index in
                GridRow(alignment: .top) {
                    self.marker(for: self.list.items[index], at: index)
                        .frame(minWidth: 18, alignment: .trailing)
                        .padding(.top, 1)

                    VStack(alignment: .leading, spacing: 7) {
                        if self.list.items[index].content.isEmpty {
                            ChatMarkdownRenderer.styledText(" ", font: self.font)
                        } else {
                            ForEach(self.list.items[index].content.indices, id: \.self) { contentIndex in
                                self.content(self.list.items[index].content[contentIndex])
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func marker(for item: ChatMarkdownListItem, at index: Int) -> some View {
        let marker = self.list.marker(for: item, at: index)
        HStack(spacing: 4) {
            if let text = marker.text {
                ChatMarkdownRenderer.styledText(text, font: self.font)
                    .foregroundStyle(self.textColor)
                    .monospacedDigit()
                    .accessibilityLabel(self.markerAccessibilityLabel(at: index))
            }
            if let checkbox = marker.checkbox {
                Image(systemName: checkbox == .checked ? "checkmark.square.fill" : "square")
                    .font(self.font)
                    .foregroundStyle(self.textColor)
                    .accessibilityLabel(Text(self.checkboxAccessibilityLabel(checkbox)))
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func checkboxAccessibilityLabel(
        _ checkbox: ChatMarkdownListItem.Checkbox) -> LocalizedStringKey
    {
        switch checkbox {
        case .checked: "Completed"
        case .unchecked: "Pending"
        }
    }

    @ViewBuilder
    private func content(_ content: ChatMarkdownListItemContent) -> some View {
        switch content {
        case let .markdown(markdown):
            self.markdownRenderer(markdown)
        case let .code(code):
            ChatCodeBlockView(block: code)
        case let .list(list):
            self.nestedListView(list)
        }
    }

    func markdownRenderer(_ markdown: String) -> ChatMarkdownRenderer {
        ChatMarkdownRenderer(
            text: markdown,
            context: self.context,
            variant: self.variant,
            font: self.font,
            textColor: self.textColor,
            inlineMathTypography: self.inlineMathTypography)
    }

    func nestedListView(_ list: ChatMarkdownList) -> ChatMarkdownListView {
        ChatMarkdownListView(
            list: list,
            context: self.context,
            variant: self.variant,
            font: self.font,
            textColor: self.textColor,
            inlineMathTypography: self.inlineMathTypography)
    }

    private func markerAccessibilityLabel(at index: Int) -> Text {
        switch self.list.kind {
        case .unordered:
            return Text("List item")
        case let .ordered(start):
            let itemNumber = start + UInt(index)
            return Text("Item") + Text(verbatim: " \(itemNumber)")
        }
    }
}

struct ChatMarkdownListMarker: Equatable {
    let text: String?
    let checkbox: ChatMarkdownListItem.Checkbox?
}

extension ChatMarkdownList {
    func marker(for item: ChatMarkdownListItem, at index: Int) -> ChatMarkdownListMarker {
        let text: String? = switch self.kind {
        case .unordered where item.checkbox != nil:
            nil
        case .unordered:
            "•"
        case let .ordered(start):
            "\(start + UInt(index))."
        }
        return ChatMarkdownListMarker(text: text, checkbox: item.checkbox)
    }
}
