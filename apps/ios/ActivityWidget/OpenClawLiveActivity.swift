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
                        .font(.subheadline.weight(.semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    self.trailingView(state: context.state)
                }
            } compactLeading: {
                self.statusDot(state: context.state)
            } compactTrailing: {
                self.compactStatusIcon(state: context.state)
            } minimal: {
                self.statusDot(state: context.state)
            }
        }
    }

    private func lockScreenView(context: ActivityViewContext<OpenClawActivityAttributes>) -> some View {
        HStack(spacing: 10) {
            self.statusIcon(state: context.state)
                .frame(width: 30, height: 30)
                .background(.thinMaterial, in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text("OpenClaw")
                    .font(.subheadline.bold())
                    .lineLimit(1)
                Text(context.state.statusText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            Spacer()
            self.trailingView(state: context.state)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private func trailingView(state: OpenClawActivityAttributes.ContentState) -> some View {
        self.statusIcon(state: state)
            .font(.system(size: 16, weight: .semibold))
            .frame(width: 28, height: 28)
    }

    private func statusDot(state: OpenClawActivityAttributes.ContentState) -> some View {
        Circle()
            .fill(self.dotColor(state: state))
            .frame(width: 6, height: 6)
    }

    private func compactStatusIcon(state: OpenClawActivityAttributes.ContentState) -> some View {
        self.statusIcon(state: state)
            .font(.system(size: 12, weight: .semibold))
            .frame(width: 18, height: 18)
    }

    @ViewBuilder
    private func statusIcon(state: OpenClawActivityAttributes.ContentState) -> some View {
        if state.isConnecting {
            Image(systemName: "arrow.triangle.2.circlepath")
                .foregroundStyle(.cyan)
        } else if state.isDisconnected {
            Image(systemName: "wifi.slash")
                .foregroundStyle(.red)
        } else if state.isIdle {
            Image(systemName: "checkmark")
                .foregroundStyle(.green)
        } else {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
        }
    }

    private func dotColor(state: OpenClawActivityAttributes.ContentState) -> Color {
        if state.isDisconnected { return .red }
        if state.isConnecting { return .cyan }
        if state.isIdle { return .green }
        return .orange
    }
}
