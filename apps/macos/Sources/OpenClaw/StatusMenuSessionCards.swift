import Foundation
import OpenClawChatUI
import SwiftUI

@MainActor
struct StatusSessionCard: View {
    let row: SessionRow
    @Environment(\.menuItemHighlighted) private var isHighlighted

    private var palette: MenuItemHighlightColors.Palette {
        MenuItemHighlightColors.palette(self.isHighlighted)
    }

    private var isWorking: Bool {
        WorkActivityStore.shared.current?.sessionKey == self.row.key
    }

    private var symbolName: String {
        switch self.row.kind {
        case .cron: "clock"
        case .direct: "person"
        case .group: "person.2"
        case .global: "globe"
        case .unknown: "bubble.left"
        }
    }

    var body: some View {
        HStack(spacing: 10) {
            Group {
                if self.isWorking {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: self.symbolName)
                        .foregroundStyle(self.palette.secondary)
                }
            }
            .frame(width: 16, height: 16)

            Text(self.row.label)
                .font(.callout.weight(
                    self.row.key == WorkActivityStore.shared.mainSessionKey ? .semibold : .regular))
                .foregroundStyle(self.palette.primary)
                .lineLimit(1)
                .truncationMode(.middle)

            Spacer(minLength: 4)

            if let percentUsed = self.row.tokens.percentUsed {
                ContextRingView(percentUsed: Double(percentUsed))
            }

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(self.palette.secondary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .leading) {
            OpenClawSessionColorStripe(color: self.row.color)
                .padding(.leading, 4)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(self.row.label)
    }
}

@MainActor
struct StatusApprovalCard: View {
    let request: ExecApprovalQueueItem

    private var sessionLabel: String {
        self.request.request.sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
            ?? String(localized: "Session approval")
    }

    private var expirationDate: Date {
        Date(timeIntervalSince1970: Double(self.request.expiresAtMs) / 1000)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.shield.fill")
                    .foregroundStyle(.orange)
                Text(self.sessionLabel)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 4)
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let seconds = max(0, Int(ceil(self.expirationDate.timeIntervalSince(context.date))))
                    Text(String(format: String(localized: "%llds"), seconds))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: 48, alignment: .trailing)
                }
            }

            Text(ExecApprovalCommandDisplaySanitizer.sanitize(self.request.request.command))
                .font(.caption.monospaced())
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)

            HStack(spacing: 8) {
                Spacer(minLength: 0)

                if self.request.allowedDecisions.contains(.deny) {
                    Button(String(localized: "Deny")) {
                        self.resolve(.deny)
                    }
                    .controlSize(.small)
                }

                if self.request.allowedDecisions.contains(.allowOnce) {
                    Button(String(localized: "Allow once")) {
                        self.resolve(.allowOnce)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.orange)
                    .controlSize(.small)
                }
            }
        }
        .padding(10)
        .background(.orange.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func resolve(_ decision: ExecApprovalDecision) {
        guard self.request.allowedDecisions.contains(decision) else { return }
        Task {
            await ExecApprovalQueueStore.shared.resolve(request: self.request, decision: decision)
        }
    }
}
