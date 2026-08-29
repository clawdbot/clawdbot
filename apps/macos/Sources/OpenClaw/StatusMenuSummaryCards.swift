import Foundation
import SwiftUI

/// Root-menu summary row (Automations, Usage, Devices): title left, compact
/// detail right, own chevron. Hosted cards escape the native title budget,
/// so long details truncate instead of stretching or ellipsizing the title.
@MainActor
struct StatusSummaryCard: View {
    let symbolName: String
    let title: String
    let detail: String?
    @Environment(\.menuItemHighlighted) private var isHighlighted

    private var palette: MenuItemHighlightColors.Palette {
        MenuItemHighlightColors.palette(self.isHighlighted)
    }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: self.symbolName)
                .foregroundStyle(self.palette.secondary)
                .frame(width: 16, height: 16)

            Text(self.title)
                .font(.callout)
                .foregroundStyle(self.palette.primary)
                .lineLimit(1)
                .layoutPriority(1)

            Spacer(minLength: 8)

            if let detail = self.detail {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(self.palette.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(self.palette.secondary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(self.detail.map { "\(self.title), \($0)" } ?? self.title)
    }
}

/// Automations submenu row: job name left, next run right. The full name
/// stays on the accessibility label; middle truncation keeps the suffix.
@MainActor
struct StatusJobRow: View {
    let name: String
    let nextRun: String?
    @Environment(\.menuItemHighlighted) private var isHighlighted

    private var palette: MenuItemHighlightColors.Palette {
        MenuItemHighlightColors.palette(self.isHighlighted)
    }

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "clock")
                .foregroundStyle(self.palette.secondary)
                .frame(width: 16, height: 16)

            Text(self.name)
                .font(.callout)
                .foregroundStyle(self.palette.primary)
                .lineLimit(1)
                .truncationMode(.middle)

            Spacer(minLength: 8)

            if let nextRun = self.nextRun {
                Text(nextRun)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(self.palette.secondary)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(self.nextRun.map { "\(self.name), \($0)" } ?? self.name)
    }
}
