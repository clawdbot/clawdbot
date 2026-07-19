// Flat rows match the web Control UI's tool rendering and avoid card-in-card chrome.
// Card chrome appears only when a result's detail is expanded.

import Foundation
import OpenClawKit
import SwiftUI

struct ChatToolActivityItem: Identifiable, Equatable {
    let id: String
    let name: String?
    let arguments: AnyCodable?
    let resultText: String?
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
                resultText: result?.text,
                isPending: false)
        }

        items.append(contentsOf: remainingResults.map { index, result in
            ChatToolActivityItem(
                id: result.id ?? "result-\(index)",
                name: result.name,
                arguments: nil,
                resultText: result.text,
                isPending: false)
        })
        return items
    }
}

struct ChatToolActivityRow: View {
    let item: ChatToolActivityItem
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
        !self.formattedResult.isEmpty
    }

    private var accessibilityValue: String {
        guard self.item.isPending else { return self.detailLine ?? "" }
        let running = String(localized: "Running")
        return self.detailLine.map { "\(running), \($0)" } ?? running
    }

    private var resultLineCount: Int {
        self.formattedResult.components(separatedBy: .newlines).count
    }

    private var isResultTruncated: Bool {
        self.resultLineCount > Self.expandedLineLimit
    }

    private var expandedResult: String {
        guard self.isResultTruncated, !self.showsFullResult else { return self.formattedResult }
        let lines = self.formattedResult.components(separatedBy: .newlines)
        return lines.prefix(Self.expandedLineLimit - 1).joined(separator: "\n") + "\n…"
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
                    Text(self.expandedResult)
                        .font(OpenClawChatTypography.mono(size: 12, relativeTo: .footnote))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)

                    if self.isResultTruncated {
                        Button {
                            self.showsFullResult.toggle()
                        } label: {
                            Text(
                                self.showsFullResult
                                    ? String(localized: "Show less")
                                    : String(
                                        format: String(localized: "Show all %lld lines"),
                                        Int64(self.resultLineCount)))
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
                .foregroundStyle(.secondary)

            Text(self.display.title)
                .font(OpenClawChatTypography.footnoteSemiBold)
                .foregroundStyle(OpenClawChatTheme.assistantText)
                .lineLimit(1)

            if let detailLine = self.detailLine {
                Text(detailLine)
                    .font(OpenClawChatTypography.mono(size: 12, relativeTo: .footnote))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, 3)
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
            "edit": "pencil.line",
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
            "node": "server.rack",
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
