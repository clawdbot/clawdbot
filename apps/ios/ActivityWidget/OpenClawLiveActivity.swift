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
                        .font(OpenClawActivityType.subheadSemiBold)
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
                    .font(OpenClawActivityType.subheadBold)
                    .lineLimit(1)
                Text(context.state.statusText)
                    .font(OpenClawActivityType.caption)
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
            .font(OpenClawActivityType.symbol(size: 16, weight: .semibold))
            .frame(width: 28, height: 28)
    }

    private func statusDot(state: OpenClawActivityAttributes.ContentState) -> some View {
        Circle()
            .fill(self.dotColor(state: state))
            .frame(width: 6, height: 6)
    }

    private func compactStatusIcon(state: OpenClawActivityAttributes.ContentState) -> some View {
        self.statusIcon(state: state)
            .font(OpenClawActivityType.symbol(size: 12, weight: .semibold))
            .frame(width: 18, height: 18)
    }

    @ViewBuilder
    private func statusIcon(state: OpenClawActivityAttributes.ContentState) -> some View {
        if state.isConnecting {
            Image(systemName: "arrow.triangle.2.circlepath")
                .foregroundStyle(OpenClawActivityStyle.info)
        } else if state.isDisconnected {
            Image(systemName: "wifi.slash")
                .foregroundStyle(OpenClawActivityStyle.danger)
        } else if state.isIdle {
            Image(systemName: "checkmark")
                .foregroundStyle(OpenClawActivityStyle.ok)
        } else {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(OpenClawActivityStyle.warn)
        }
    }

    private func dotColor(state: OpenClawActivityAttributes.ContentState) -> Color {
        if state.isDisconnected { return OpenClawActivityStyle.danger }
        if state.isConnecting { return OpenClawActivityStyle.info }
        if state.isIdle { return OpenClawActivityStyle.ok }
        return OpenClawActivityStyle.warn
    }
}

private enum OpenClawActivityStyle {
    static let info = Color(red: 0, green: 122 / 255.0, blue: 1)
    static let danger = Color(red: 185 / 255.0, green: 28 / 255.0, blue: 28 / 255.0)
    static let ok = Color(red: 34 / 255.0, green: 197 / 255.0, blue: 94 / 255.0)
    static let warn = Color(red: 245 / 255.0, green: 158 / 255.0, blue: 11 / 255.0)
}
