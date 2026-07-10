import Foundation
import SwiftUI

/// Context usage card shown at the top of the menubar menu.
struct ContextMenuCardView: View {
    private let rows: [SessionRow]
    private let statusText: String?
    private let isLoading: Bool
    private let barHeight: CGFloat = 3

    init(
        rows: [SessionRow],
        statusText: String? = nil,
        isLoading: Bool = false)
    {
        self.rows = rows
        self.statusText = statusText
        self.isLoading = isLoading
    }

    var body: some View {
        MenuHeaderCard(
            title: "Context",
            subtitle: self.subtitle,
            statusText: self.statusText,
            paddingBottom: 8)
        {
            if self.statusText == nil {
                if self.rows.isEmpty, !self.isLoading {
                    Text("No active sessions")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    VStack(alignment: .leading, spacing: 12) {
                        if self.rows.isEmpty, self.isLoading {
                            ForEach(0..<2, id: \.self) { _ in
                                self.placeholderRow
                            }
                        } else {
                            ForEach(self.rows) { row in
                                self.sessionRow(row)
                            }
                        }
                    }
                }
            }
        }
    }

    private var subtitle: String {
        let count = self.rows.count
        if count == 1 { return "1 session · 24h" }
        return "\(count) sessions · 24h"
    }

    private func sessionRow(_ row: SessionRow) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            ContextUsageBar(
                usedTokens: row.tokens.total,
                contextTokens: row.tokens.contextTokens,
                height: self.barHeight)

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(row.label)
                    .font(.caption.weight(row.key == "main" ? .semibold : .regular))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .layoutPriority(1)
                Spacer(minLength: 8)
                Text(row.tokens.contextSummaryShort)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                    .layoutPriority(2)
            }
        }
        .padding(.vertical, 2)
    }

    private var placeholderRow: some View {
        VStack(alignment: .leading, spacing: 5) {
            ContextUsageBar(
                usedTokens: 0,
                contextTokens: 200_000,
                height: self.barHeight)

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("main")
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                    .layoutPriority(1)
                Spacer(minLength: 8)
                Text("000k/000k")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: true, vertical: false)
                    .layoutPriority(2)
            }
            .redacted(reason: .placeholder)
        }
    }
}
