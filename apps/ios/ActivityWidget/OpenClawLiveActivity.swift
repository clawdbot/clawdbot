import ActivityKit
import Foundation
import SwiftUI
import WidgetKit

struct OpenClawLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: OpenClawActivityAttributes.self) { context in
            self.lockScreenView(context: context, state: self.displayState(context: context))
        } dynamicIsland: { context in
            let state = self.displayState(context: context)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    self.agentAvatar(context: context, state: state)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("OPENCLAW")
                            .font(OpenClawActivityType.eyebrow)
                            .foregroundStyle(OpenClawActivityStyle.coral)
                        self.statusText(state: state)
                            .font(OpenClawActivityType.subheadSemiBold)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if self.isVoiceSpeaking(state: state) {
                        Text("LIVE")
                            .font(OpenClawActivityType.eyebrow)
                            .foregroundStyle(OpenClawActivityStyle.sea)
                    } else {
                        self.trailingView(state: state)
                    }
                }
                .contentMargins(.horizontal, 8)
            } compactLeading: {
                self.agentAvatar(context: context, state: state, compact: true)
            } compactTrailing: {
                self.compactTrailingView(state: state)
            } minimal: {
                self.agentAvatar(context: context, state: state, compact: true)
            }
            .keylineTint(self.islandKeylineTint(state: state))
        }
    }

    private func lockScreenView(
        context: ActivityViewContext<OpenClawActivityAttributes>,
        state: OpenClawActivityAttributes.ContentState) -> some View
    {
        HStack(spacing: 10) {
            self.agentAvatar(context: context, state: state)
            VStack(alignment: .leading, spacing: 2) {
                Text("OpenClaw")
                    .font(OpenClawActivityType.subheadBold)
                    .lineLimit(1)
                self.statusText(state: state)
                    .font(OpenClawActivityType.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            Spacer()
            self.trailingView(state: state)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    @ViewBuilder
    private func trailingView(state: OpenClawActivityAttributes.ContentState) -> some View {
        switch state.status {
        case .voiceSpeaking:
            self.voiceTrace(state: state)
                .frame(width: 64, height: 20)
        default:
            self.statusIcon(state: state)
                .font(OpenClawActivityType.symbol(size: 16, weight: .semibold))
                .frame(width: 28, height: 28)
        }
    }

    private func agentAvatar(
        context: ActivityViewContext<OpenClawActivityAttributes>,
        state: OpenClawActivityAttributes.ContentState,
        compact: Bool = false) -> some View
    {
        TalkAvatarWaveformView(
            phase: self.voicePhase(state: state),
            palette: .liveActivity,
            diameter: compact ? 30 : 42,
            avatarDiameter: compact ? 16 : 28,
            samples: self.voiceSamples(state: state))
        {
            Text(verbatim: context.state.agentBadge ?? Self.initials(context.attributes.agentName))
                .font(OpenClawActivityType.symbol(size: compact ? 8 : 13, weight: .bold))
                .foregroundStyle(.white)
                .minimumScaleFactor(0.6)
                .lineLimit(1)
                .frame(width: compact ? 16 : 28, height: compact ? 16 : 28)
                .background(OpenClawActivityStyle.surfaceElevated, in: Circle())
        }
        .accessibilityLabel(Text(verbatim: context.attributes.agentName))
    }

    private func voicePhase(state: OpenClawActivityAttributes.ContentState) -> TalkWaveformPhase {
        switch state.status {
        case .voiceSpeaking:
            .speaking(level: self.voiceSamples(state: state).last)
        case .voiceListening:
            .listening(
                level: self.voiceSamples(state: state).last ?? 0.15,
                speechActive: true)
        case .voiceActive:
            .idle
        default:
            .idle
        }
    }

    private static func initials(_ name: String) -> String {
        let words = name.split(whereSeparator: \.isWhitespace)
        let value = words.prefix(2).compactMap(\.first).map(String.init).joined()
        return value.isEmpty ? "OC" : value.uppercased()
    }

    @ViewBuilder
    private func compactTrailingView(state: OpenClawActivityAttributes.ContentState) -> some View {
        switch state.status {
        case .voiceSpeaking:
            Text("LIVE")
                .font(OpenClawActivityType.eyebrow)
                .foregroundStyle(OpenClawActivityStyle.sea)
        default:
            self.statusIcon(state: state)
                .font(OpenClawActivityType.symbol(size: 12, weight: .semibold))
                .frame(width: 18, height: 18)
        }
    }

    private func voiceTrace(
        state: OpenClawActivityAttributes.ContentState,
        sampleRange: ClosedRange<Double> = 0...1) -> some View
    {
        TalkVoiceTraceView(
            phase: self.voicePhase(state: state),
            palette: .liveActivity,
            samples: self.voiceSamples(state: state),
            sampleRange: sampleRange)
    }

    private func voiceSamples(state: OpenClawActivityAttributes.ContentState) -> [Double] {
        (state.voiceSamples ?? []).map { Double($0) / 255 }
    }

    private func isVoiceSpeaking(state: OpenClawActivityAttributes.ContentState) -> Bool {
        state.status == .voiceSpeaking
    }

    private func islandKeylineTint(state: OpenClawActivityAttributes.ContentState) -> Color? {
        switch state.status {
        case .voiceSpeaking:
            OpenClawActivityStyle.coral
        case .voiceListening, .voiceActive:
            OpenClawActivityStyle.sea
        default:
            nil
        }
    }

    @ViewBuilder
    private func statusIcon(state: OpenClawActivityAttributes.ContentState) -> some View {
        switch state.status {
        case .connecting, .reconnecting:
            Image(systemName: "arrow.triangle.2.circlepath")
                .foregroundStyle(OpenClawActivityStyle.info)
        case .disconnected:
            Image(systemName: "wifi.slash")
                .foregroundStyle(OpenClawActivityStyle.danger)
        case .paused:
            Image(systemName: "pause.fill")
                .foregroundStyle(OpenClawActivityStyle.warn)
        case .idle:
            Image(systemName: "checkmark")
                .foregroundStyle(OpenClawActivityStyle.ok)
        case .approvalNeeded, .actionRequired, .attention:
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(OpenClawActivityStyle.warn)
        case .toolRunning:
            Image(systemName: "hammer.fill")
                .foregroundStyle(OpenClawActivityStyle.info)
        case .voiceListening:
            Image(systemName: "mic.fill")
                .foregroundStyle(OpenClawActivityStyle.sea)
        case .voiceSpeaking:
            Image(systemName: "waveform")
                .foregroundStyle(OpenClawActivityStyle.coral)
        case .voiceActive:
            Image(systemName: "waveform")
                .foregroundStyle(OpenClawActivityStyle.sea)
        }
    }

    private func statusText(state: OpenClawActivityAttributes.ContentState) -> Text {
        if let detail = state.verbatimDetail {
            return Text(verbatim: detail)
        }
        return switch state.status {
        case .connecting: Text("Connecting...")
        case .reconnecting: Text("Reconnecting...")
        case .approvalNeeded: Text("Approval needed")
        case .actionRequired, .attention: Text("Action required")
        case .toolRunning:
            if let toolName = state.toolName {
                Text(verbatim: String(format: String(localized: "Using %@"), toolName))
            } else {
                Text("Using a tool")
            }
        case .voiceListening: Text("Listening")
        case .voiceSpeaking: Text("Speaking")
        case .voiceActive: Text("Voice active")
        case .paused: Text("Paused")
        case .idle: Text("Connected")
        case .disconnected: Text("Disconnected")
        }
    }

    private func displayState(
        context: ActivityViewContext<OpenClawActivityAttributes>) -> OpenClawActivityAttributes.ContentState
    {
        guard context.isStale else { return context.state }
        switch context.state.status {
        case .connecting, .reconnecting, .approvalNeeded, .actionRequired, .attention,
             .toolRunning, .voiceListening, .voiceSpeaking, .voiceActive:
            return OpenClawActivityAttributes.ContentState(
                status: .paused,
                verbatimDetail: nil,
                startedAt: context.state.startedAt,
                agentBadge: context.state.agentBadge)
        case .paused, .idle, .disconnected:
            return context.state
        }
    }
}

private enum OpenClawActivityStyle {
    // Carapace dark-theme tokens, kept local because the widget is a separate target.
    static let coral = Color(red: 245 / 255.0, green: 101 / 255.0, blue: 74 / 255.0)
    static let sea = Color(red: 79 / 255.0, green: 200 / 255.0, blue: 174 / 255.0)
    static let surfaceElevated = Color(red: 32 / 255.0, green: 32 / 255.0, blue: 36 / 255.0)
    static let info = sea
    static let danger = Color(red: 185 / 255.0, green: 28 / 255.0, blue: 28 / 255.0)
    static let ok = Color(red: 34 / 255.0, green: 197 / 255.0, blue: 94 / 255.0)
    static let warn = Color(red: 245 / 255.0, green: 158 / 255.0, blue: 11 / 255.0)
}

extension TalkWaveformPalette {
    fileprivate static let liveActivity = TalkWaveformPalette(
        active: [
            OpenClawActivityStyle.coral,
            OpenClawActivityStyle.sea,
        ],
        inactive: [
            OpenClawActivityStyle.surfaceElevated,
            OpenClawActivityStyle.surfaceElevated,
        ])
}
