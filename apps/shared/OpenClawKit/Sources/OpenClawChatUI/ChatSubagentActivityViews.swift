import SwiftUI

struct ChatSubagentActivityList: View {
    let activities: [ChatSubagentActivity]
    let hiddenWorkingCount: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(self.activities) { activity in
                ChatSubagentActivityRow(activity: activity)
            }
            if self.hiddenWorkingCount > 0 {
                Text(verbatim: String(
                    format: String(localized: "+%1$lld more working"),
                    Int64(self.hiddenWorkingCount)))
                    .font(OpenClawChatTypography.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.leading, 35)
            }
        }
        .padding(4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ChatSubagentActivityRow: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let activity: ChatSubagentActivity

    private var detail: String? {
        if self.activity.status.isWorking {
            return self.activity.snippet
        }
        return self.activity.terminalSummary ?? self.activity.snippet
    }

    private var title: LocalizedStringResource {
        switch self.activity.status {
        case .queued, .running:
            "Subagent working"
        case .completed:
            "Subagent finished"
        case .failed, .timedOut:
            "Subagent failed"
        case .cancelled:
            "Subagent cancelled"
        }
    }

    private var titleColor: Color {
        switch self.activity.status {
        case .failed, .timedOut:
            OpenClawChatTheme.danger
        case .queued, .running, .completed, .cancelled:
            OpenClawChatTheme.assistantText
        }
    }

    var body: some View {
        HStack(alignment: .center, spacing: 7) {
            if self.activity.status.isWorking {
                ChatWorkingClawView(seed: self.activity.id)
            } else {
                Image(systemName: self.activity.status == .completed ? "checkmark" : "xmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(
                        self.activity.status == .completed
                            ? OpenClawChatTheme.success
                            : OpenClawChatTheme.danger)
                    .frame(width: 28, height: 24)
                    .accessibilityHidden(true)
            }

            Text(self.title)
                .font(OpenClawChatTypography.footnoteSemiBold)
                .foregroundStyle(self.titleColor)
                .lineLimit(1)

            if let detail = self.detail {
                Text(verbatim: detail)
                    .font(OpenClawChatTypography.mono(size: 12, relativeTo: .footnote))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .contentTransition(.opacity)
                    .animation(
                        self.reduceMotion ? nil : .easeOut(duration: 0.16),
                        value: detail)
            }

            if let stat = self.activity.diffStat {
                ChatDiffStatChips(stat: stat)
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }
}
