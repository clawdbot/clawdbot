import SwiftUI

struct StatusPill: View {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    enum GatewayState: Equatable {
        case connected
        case connecting
        case error
        case disconnected

        var title: String {
            switch self {
            case .connected: "Connected"
            case .connecting: "Connecting…"
            case .error: "Error"
            case .disconnected: "Offline"
            }
        }

        var color: Color {
            switch self {
            case .connected: .green
            case .connecting: .yellow
            case .error: .red
            case .disconnected: .gray
            }
        }
    }

    struct Activity: Equatable {
        var title: String
        var systemImage: String
        var tint: Color?
    }

    var gateway: GatewayState
    var voiceWakeEnabled: Bool
    var activity: Activity?
    var compact: Bool = false
    var brighten: Bool = false
    var onTap: () -> Void

    @State private var pulse: Bool = false

    var body: some View {
        Button(action: self.onTap) {
            HStack(spacing: self.compact ? 8 : 10) {
                HStack(spacing: self.compact ? 6 : 8) {
                    Circle()
                        .fill(self.gateway.color)
                        .frame(width: self.compact ? 8 : 9, height: self.compact ? 8 : 9)
                        .scaleEffect(
                            self.gateway == .connecting && !self.reduceMotion
                                ? (self.pulse ? 1.15 : 0.85)
                                : 1.0)
                        .opacity(self.gateway == .connecting && !self.reduceMotion ? (self.pulse ? 1.0 : 0.6) : 1.0)

                    Text(self.gateway.title)
                        .font((self.compact ? Font.footnote : Font.subheadline).weight(.semibold))
                        .foregroundStyle(.primary)
                }

                if let activity {
                    if !self.compact {
                        Divider()
                            .frame(height: 14)
                            .opacity(0.35)
                    }

                    HStack(spacing: self.compact ? 4 : 6) {
                        Image(systemName: activity.systemImage)
                            .font((self.compact ? Font.footnote : Font.subheadline).weight(.semibold))
                            .foregroundStyle(activity.tint ?? .primary)
                        if !self.compact {
                            Text(activity.title)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.primary)
                                .lineLimit(1)
                        }
                    }
                    .transition(.opacity.combined(with: .move(edge: .top)))
                } else {
                    Image(systemName: self.voiceWakeEnabled ? "mic.fill" : "mic.slash")
                        .font((self.compact ? Font.footnote : Font.subheadline).weight(.semibold))
                        .foregroundStyle(self.voiceWakeEnabled ? .primary : .secondary)
                        .accessibilityLabel(self.voiceWakeEnabled ? "Voice Wake enabled" : "Voice Wake disabled")
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .statusGlassCard(brighten: self.brighten, verticalPadding: self.compact ? 6 : 8)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Connection Status")
        .accessibilityValue(self.accessibilityValue)
        .accessibilityHint("Double tap to open settings")
        .onAppear { self.updatePulse(for: self.gateway, scenePhase: self.scenePhase, reduceMotion: self.reduceMotion) }
        .onDisappear { self.pulse = false }
        .onChange(of: self.gateway) { _, newValue in
            self.updatePulse(for: newValue, scenePhase: self.scenePhase, reduceMotion: self.reduceMotion)
        }
        .onChange(of: self.scenePhase) { _, newValue in
            self.updatePulse(for: self.gateway, scenePhase: newValue, reduceMotion: self.reduceMotion)
        }
        .onChange(of: self.reduceMotion) { _, newValue in
            self.updatePulse(for: self.gateway, scenePhase: self.scenePhase, reduceMotion: newValue)
        }
        .animation(.easeInOut(duration: 0.18), value: self.activity?.title)
    }

    private var accessibilityValue: String {
        if let activity {
            return "\(self.gateway.title), \(activity.title)"
        }
        return "\(self.gateway.title), Voice Wake \(self.voiceWakeEnabled ? "enabled" : "disabled")"
    }

    private func updatePulse(for gateway: GatewayState, scenePhase: ScenePhase, reduceMotion: Bool) {
        guard gateway == .connecting, scenePhase == .active, !reduceMotion else {
            withAnimation(reduceMotion ? .none : .easeOut(duration: 0.2)) { self.pulse = false }
            return
        }

        guard !self.pulse else { return }
        withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
            self.pulse = true
        }
    }
}
