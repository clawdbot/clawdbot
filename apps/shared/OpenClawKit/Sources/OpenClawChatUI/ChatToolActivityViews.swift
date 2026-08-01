// Flat rows match the web Control UI's tool rendering and avoid card-in-card chrome.
// Card chrome appears only when a result's detail is expanded.

import Foundation
import OpenClawKit
import SwiftUI

struct ChatToolActivityItem: Identifiable, Equatable {
    let id: String
    let name: String?
    let arguments: AnyCodable?
    let details: AnyCodable?
    let resultText: String?
    let isError: Bool
    let isPending: Bool
}

enum ChatToolActivity {
    static func items(
        calls: [OpenClawChatMessageContent],
        results: [OpenClawChatMessageContent]) -> [ChatToolActivityItem]
    {
        var remainingResults = Array(results.enumerated())
        var items = calls.enumerated().map { index, call in
            let resultIndex = call.id.flatMap { callID in
                remainingResults.firstIndex { _, result in result.id == callID }
            }
            let result = resultIndex.map { remainingResults.remove(at: $0).element }

            return ChatToolActivityItem(
                id: call.id ?? "call-\(index)",
                name: call.name,
                arguments: call.arguments,
                details: result?.details,
                resultText: result?.text,
                isError: result?.isError ?? false,
                isPending: false)
        }

        items.append(contentsOf: remainingResults.map { index, result in
            ChatToolActivityItem(
                id: result.id ?? "result-\(index)",
                name: result.name,
                arguments: nil,
                details: result.details,
                resultText: result.text,
                isError: result.isError ?? false,
                isPending: false)
        })
        return items
    }
}

struct ChatToolActivityRow: View {
    let item: ChatToolActivityItem
    private let resolvedDiff: (lines: [ChatToolDiffLine], stat: ChatToolDiffStat?)?
    @State private var expanded = false
    @State private var showsFullResult = false

    private static let disclosureWidth: CGFloat = 12
    private static let expandedLineLimit = 40

    private var display: ToolDisplaySummary {
        ToolDisplayRegistry.resolve(name: self.item.name ?? "tool", args: self.item.arguments)
    }

    private var detailLine: String? {
        guard let detail = self.display.detailLine, !detail.isEmpty else { return nil }
        return detail
    }

    private var formattedResult: String {
        guard let resultText = self.item.resultText else { return "" }
        return ToolResultTextFormatter.format(text: resultText, toolName: self.item.name)
    }

    private var expandable: Bool {
        self.resolvedDiff != nil || !self.formattedResult.isEmpty
    }

    private var accessibilityValue: String {
        guard self.item.isPending else { return self.detailLine ?? "" }
        let running = String(localized: "Running")
        return self.detailLine.map { "\(running), \($0)" } ?? running
    }

    private var expandedLineCount: Int {
        self.resolvedDiff?.lines.count ?? self.formattedResult.components(separatedBy: .newlines).count
    }

    private var isResultTruncated: Bool {
        self.expandedLineCount > Self.expandedLineLimit
    }

    private var expandedResult: String {
        guard self.isResultTruncated, !self.showsFullResult else { return self.formattedResult }
        let lines = self.formattedResult.components(separatedBy: .newlines)
        return lines.prefix(Self.expandedLineLimit - 1).joined(separator: "\n") + "\n…"
    }

    private var expandedDiffLines: [ChatToolDiffLine] {
        guard let lines = self.resolvedDiff?.lines else { return [] }
        guard self.isResultTruncated, !self.showsFullResult else { return lines }
        return Array(lines.prefix(Self.expandedLineLimit - 1)) + [
            ChatToolDiffLine(kind: .skip, text: ""),
        ]
    }

    init(item: ChatToolActivityItem) {
        self.item = item
        self.resolvedDiff = ChatToolDiff.resolveDiff(
            name: item.name,
            arguments: item.arguments,
            details: item.details,
            isError: item.isError)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if self.expandable {
                Button {
                    withAnimation(.easeOut(duration: 0.15)) {
                        self.expanded.toggle()
                    }
                } label: {
                    self.collapsedRow
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(self.display.title)
                .accessibilityValue(self.accessibilityValue)
                .accessibilityHint(self.expanded ? "Collapse tool result" : "Expand tool result")
            } else {
                self.collapsedRow
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(self.display.title)
                    .accessibilityValue(self.accessibilityValue)
            }

            if self.expanded, self.expandable {
                VStack(alignment: .leading, spacing: 6) {
                    if self.resolvedDiff != nil {
                        self.diffRows
                        // The result text carries the outcome (success summary or the
                        // error diagnostic); hiding it would misrepresent failed edits
                        // as applied changes. Bounded so foreign harness output cannot
                        // dwarf the diff.
                        if !self.formattedResult.isEmpty {
                            Text(self.formattedResult)
                                .font(OpenClawChatTypography.mono(size: 12, relativeTo: .footnote))
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                                .lineLimit(Self.expandedLineLimit)
                        }
                    } else {
                        Text(self.expandedResult)
                            .font(OpenClawChatTypography.mono(size: 12, relativeTo: .footnote))
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }

                    if self.isResultTruncated {
                        Button {
                            self.showsFullResult.toggle()
                        } label: {
                            Text(
                                self.showsFullResult
                                    ? String(localized: "Show less")
                                    : String(
                                        format: String(localized: "Show all %lld lines"),
                                        Int64(self.expandedLineCount)))
                                .font(OpenClawChatTypography.caption)
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(OpenClawChatTheme.subtleCard))
                .padding(.leading, 19)
            }
        }
    }

    private var collapsedRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Group {
                if self.item.isPending {
                    ProgressView()
                        .controlSize(.mini)
                } else if self.expandable {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .opacity(0.7)
                        .rotationEffect(.degrees(self.expanded ? 90 : 0))
                } else {
                    Color.clear
                }
            }
            .frame(width: Self.disclosureWidth)

            Image(systemName: Self.symbol(forToolName: self.item.name))
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(self.item.isError ? OpenClawChatTheme.danger : Color.secondary)

            Text(self.display.title)
                .font(OpenClawChatTypography.footnoteSemiBold)
                .foregroundStyle(
                    self.item.isError ? OpenClawChatTheme.danger : OpenClawChatTheme.assistantText)
                .lineLimit(1)

            if let detailLine = self.detailLine {
                Text(detailLine)
                    .font(OpenClawChatTypography.mono(size: 12, relativeTo: .footnote))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            if let stat = self.resolvedDiff?.stat {
                Text(verbatim: "+\(stat.added)")
                    .font(OpenClawChatTypography.mono(size: 12, relativeTo: .footnote))
                    .foregroundStyle(OpenClawChatTheme.success.opacity(0.9))
                    .lineLimit(1)
                Text(verbatim: "−\(stat.removed)")
                    .font(OpenClawChatTypography.mono(size: 12, relativeTo: .footnote))
                    .foregroundStyle(OpenClawChatTheme.danger.opacity(0.9))
                    .lineLimit(1)
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, 3)
    }

    private var diffRows: some View {
        // The orthogonal nested scroll keeps long diff lines reachable without
        // competing with the transcript's vertical gesture.
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(self.expandedDiffLines.indices, id: \.self) { index in
                    self.diffRow(self.expandedDiffLines[index])
                }
            }
            .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func diffRow(_ line: ChatToolDiffLine) -> some View {
        if line.kind == .file {
            Text(verbatim: String(line.text.unicodeScalars.prefix(2000)))
                .font(OpenClawChatTypography.mono(size: 11, relativeTo: .caption))
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: true, vertical: false)
                .padding(.top, 6)
        } else if line.kind == .skip {
            Text("⋯")
                .font(OpenClawChatTypography.mono(size: 12, relativeTo: .footnote))
                .foregroundStyle(.secondary.opacity(0.6))
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 2)
                // Reuses the existing localized "Collapsed" key so omitted
                // preview rows stay announced to assistive tech.
                .accessibilityLabel(Text("Collapsed"))
        } else {
            HStack(spacing: 6) {
                if let lineNo = line.lineNo {
                    Text(verbatim: "\(lineNo)")
                        .font(OpenClawChatTypography.mono(size: 10, relativeTo: .caption2))
                        .foregroundStyle(.secondary.opacity(0.6))
                        .frame(minWidth: 34, alignment: .trailing)
                }
                // Bound per-line render work; generated/minified payloads can put
                // megabytes on a single line.
                Text(verbatim: String(line.text.unicodeScalars.prefix(2000)))
                    .font(OpenClawChatTypography.mono(size: 12, relativeTo: .footnote))
                    .foregroundStyle(self.diffTextColor(line.kind))
                    .fixedSize(horizontal: true, vertical: false)
            }
            .background(self.diffBackground(line.kind))
            // Color alone must not carry add/del semantics for assistive tech.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: Self.accessibilityText(for: line)))
        }
    }

    private static func accessibilityText(for line: ChatToolDiffLine) -> String {
        let lineNo = line.lineNo.map { "\($0) " } ?? ""
        return lineNo + self.accessibilityMarker(line.kind) + String(line.text.unicodeScalars.prefix(2000))
    }

    private static func accessibilityMarker(_ kind: ChatToolDiffLineKind) -> String {
        switch kind {
        case .add:
            "+ "
        case .del:
            "\u{2212} "
        case .ctx, .file, .skip:
            ""
        }
    }

    private func diffTextColor(_ kind: ChatToolDiffLineKind) -> Color {
        switch kind {
        case .add:
            OpenClawChatTheme.assistantText
        case .del, .ctx, .file, .skip:
            .secondary
        }
    }

    private func diffBackground(_ kind: ChatToolDiffLineKind) -> Color {
        switch kind {
        case .add:
            OpenClawChatTheme.success.opacity(0.14)
        case .del:
            OpenClawChatTheme.danger.opacity(0.12)
        case .ctx, .file, .skip:
            .clear
        }
    }

    private static func symbol(forToolName name: String?) -> String {
        let normalized = name?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        let exact: [String: String] = [
            "agent": "rectangle.stack",
            "bash": "terminal",
            "browser": "safari",
            "canvas": "photo",
            "clock": "clock",
            "command": "terminal",
            "cron": "clock",
            "create_file": "square.and.pencil",
            "edit": "pencil.line",
            "edit_file": "pencil.line",
            "exec": "terminal",
            "fetch": "globe",
            "find": "magnifyingglass",
            "gateway": "server.rack",
            "glob": "magnifyingglass",
            "grep": "magnifyingglass",
            "image": "photo",
            "list": "magnifyingglass",
            "ls": "magnifyingglass",
            "memory": "brain",
            "message": "bubble.left",
            "multi_edit": "pencil.line",
            "multiedit": "pencil.line",
            "notebook_edit": "pencil.line",
            "notebookedit": "pencil.line",
            "node": "server.rack",
            "apply_patch": "pencil.line",
            "applypatch": "pencil.line",
            "patch": "pencil.line",
            "photo": "photo",
            "read": "doc.text",
            "reply": "bubble.left",
            "schedule": "clock",
            "screenshot": "photo",
            "search": "magnifyingglass",
            "send": "bubble.left",
            "session": "rectangle.stack",
            "shell": "terminal",
            "terminal": "terminal",
            "web": "globe",
            "write": "square.and.pencil",
            "write_file": "square.and.pencil",
            "str_replace_based_edit_tool": "pencil.line",
            "str_replace_editor": "pencil.line",
        ]
        if let symbol = exact[normalized] { return symbol }

        let fallbacks: [([String], String)] = [
            (["canvas", "image", "screenshot", "photo"], "photo"),
            (["browser"], "safari"),
            (["message", "send", "reply"], "bubble.left"),
            (["node", "gateway"], "server.rack"),
            (["cron", "schedule", "clock"], "clock"),
            (["memory"], "brain"),
            (["session", "agent"], "rectangle.stack"),
            (["exec", "bash", "shell", "command", "terminal"], "terminal"),
            (["edit", "patch"], "pencil.line"),
            (["write"], "square.and.pencil"),
            (["grep", "glob", "find", "search", "list"], "magnifyingglass"),
            (["read"], "doc.text"),
            (["fetch", "web"], "globe"),
        ]
        return fallbacks.first { keys, _ in keys.contains(where: normalized.contains) }?.1
            ?? "wrench.and.screwdriver"
    }
}

struct ChatToolActivityList: View {
    let items: [ChatToolActivityItem]

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            // Protocol IDs can collide with specified fallback IDs; encounter order is unique here.
            ForEach(self.items.indices, id: \.self) { index in
                ChatToolActivityRow(item: self.items[index])
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
