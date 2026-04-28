import ActivityKit
import SwiftUI
import WidgetKit

struct OpenClawLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: OpenClawActivityAttributes.self) { context in
            self.lockScreenView(context: context)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    self.statusDot(state: context.state)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.statusText)
                        .font(.subheadline)
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    self.trailingView(state: context.state)
                }
            } compactLeading: {
                self.statusDot(state: context.state)
            } compactTrailing: {
                Text(context.state.statusText)
                    .font(.caption2)
                    .lineLimit(1)
                    .frame(maxWidth: 64)
            } minimal: {
                self.statusDot(state: context.state)
            }
        }
    }

    private func lockScreenView(context: ActivityViewContext<OpenClawActivityAttributes>) -> some View {
        HStack(spacing: 8) {
            self.statusDot(state: context.state)
                .frame(width: 10, height: 10)
            VStack(alignment: .leading, spacing: 2) {
                Text("OpenClaw")
                    .font(.subheadline.bold())
                Text(context.state.statusText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            self.trailingView(state: context.state)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func trailingView(state: OpenClawActivityAttributes.ContentState) -> some View {
        if state.isConnecting {
            ProgressView().controlSize(.small)
        } else if state.isDisconnected {
            Image(systemName: "wifi.slash")
                .foregroundStyle(.red)
        } else if state.isIdle {
            Image(systemName: "antenna.radiowaves.left.and.right")
                .foregroundStyle(.green)
        } else {
            Text(state.startedAt, style: .timer)
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
    }

    private func statusDot(state: OpenClawActivityAttributes.ContentState) -> some View {
        Circle()
            .fill(self.dotColor(state: state))
            .frame(width: 6, height: 6)
    }

    private func dotColor(state: OpenClawActivityAttributes.ContentState) -> Color {
        if state.isDisconnected { return .red }
        if state.isConnecting { return .gray }
        if state.isIdle { return .green }
        return .blue
    }
}
