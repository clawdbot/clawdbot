import SwiftUI

struct HomeToolbar: View {
    var gateway: StatusPill.GatewayState
    var voiceWakeEnabled: Bool
    var activity: StatusPill.Activity?
    var brighten: Bool
    var talkButtonEnabled: Bool
    var talkActive: Bool
    var talkTint: Color
    var onStatusTap: () -> Void
    var onChatTap: () -> Void
    var onTalkTap: () -> Void
    var onSettingsTap: () -> Void

    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        VStack(spacing: 0) {
            Rectangle()
                .fill(.white.opacity(self.contrast == .increased ? 0.46 : (self.brighten ? 0.18 : 0.12)))
                .frame(height: self.contrast == .increased ? 1.0 : 0.6)
                .allowsHitTesting(false)

            HStack(spacing: 12) {
                HomeToolbarStatusButton(
                    gateway: self.gateway,
                    voiceWakeEnabled: self.voiceWakeEnabled,
                    activity: self.activity,
                    brighten: self.brighten,
                    onTap: self.onStatusTap)

                Spacer(minLength: 0)

                HStack(spacing: 8) {
                    HomeToolbarActionButton(
                        systemImage: "text.bubble.fill",
                        accessibilityLabel: "Chat",
                        brighten: self.brighten,
                        action: self.onChatTap)

                    if self.talkButtonEnabled {
                        HomeToolbarActionButton(
                            systemImage: self.talkActive ? "waveform.circle.fill" : "waveform.circle",
                            accessibilityLabel: self.talkActive ? "Talk Mode On" : "Talk Mode Off",
                            brighten: self.brighten,
                            tint: self.talkTint,
                            isActive: self.talkActive,
                            action: self.onTalkTap)
                    }

                    HomeToolbarActionButton(
                        systemImage: "gearshape.fill",
                        accessibilityLabel: "Settings",
                        brighten: self.brighten,
                        action: self.onSettingsTap)
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 10)
            .padding(.bottom, 8)
        }
        .frame(maxWidth: .infinity)
        .background(.ultraThinMaterial)
        .overlay(alignment: .top) {
            LinearGradient(
                colors: [
                    .white.opacity(self.brighten ? 0.10 : 0.06),
                    .clear,
                ],
                startPoint: .top,
                endPoint: .bottom)
                .allowsHitTesting(false)
        }
    }
}

private struct HomeToolbarStatusButton: View {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

    var gateway: StatusPill.GatewayState
    var voiceWakeEnabled: Bool
    var activity: StatusPill.Activity?
    var brighten: Bool
    var onTap: () -> Void

    @State private var pulse: Bool = false

    var body: some View {
        Button(action: self.onTap) {
            HStack(spacing: 8) {
                HStack(spacing: 6) {
                    Circle()
                        .fill(self.gateway.color)
                        .frame(width: 8, height: 8)
                        .scaleEffect(
                            self.gateway == .connecting && !self.reduceMotion
                                ? (self.pulse ? 1.15 : 0.85)
                                : 1.0)
                        .opacity(self.gateway == .connecting && !self.reduceMotion ? (self.pulse ? 1.0 : 0.6) : 1.0)

                    Text(self.gateway.title)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                }

                if let activity {
                    Image(systemName: activity.systemImage)
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(activity.tint ?? .primary)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                } else {
                    Image(systemName: self.voiceWakeEnabled ? "mic.fill" : "mic.slash")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(self.voiceWakeEnabled ? .primary : .secondary)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.black.opacity(self.brighten ? 0.12 : 0.18))
                    .overlay {
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .strokeBorder(
                                .white.opacity(self.contrast == .increased ? 0.46 : (self.brighten ? 0.22 : 0.16)),
                                lineWidth: self.contrast == .increased ? 1.0 : 0.6)
                    }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Connection Status")
        .accessibilityValue(self.accessibilityValue)
        .accessibilityHint(
            self.gateway == .connected
                ? "Double tap for gateway actions"
                : "Double tap to open settings")
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

    private func updatePulse(for gateway: StatusPill.GatewayState, scenePhase: ScenePhase, reduceMotion: Bool) {
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

private struct HomeToolbarActionButton: View {
    @Environment(\.colorSchemeContrast) private var contrast

    let systemImage: String
    let accessibilityLabel: String
    let brighten: Bool
    var tint: Color?
    var isActive: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: self.action) {
            Image(systemName: self.systemImage)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(self.isActive ? (self.tint ?? .primary) : .primary)
                .frame(width: 40, height: 40)
                .background {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color.black.opacity(self.brighten ? 0.12 : 0.18))
                        .overlay {
                            if let tint {
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .fill(
                                        LinearGradient(
                                            colors: [
                                                tint.opacity(self.isActive ? 0.22 : 0.14),
                                                tint.opacity(self.isActive ? 0.08 : 0.04),
                                                .clear,
                                            ],
                                            startPoint: .topLeading,
                                            endPoint: .bottomTrailing))
                                    .blendMode(.overlay)
                            }
                        }
                        .overlay {
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .strokeBorder(
                                    (self.tint ?? .white).opacity(
                                        self.isActive
                                            ? 0.34
                                            : (self.contrast == .increased ? 0.4 : (self.brighten ? 0.22 : 0.16))),
                                    lineWidth: self.contrast == .increased ? 1.0 : (self.isActive ? 0.8 : 0.6))
                        }
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(self.accessibilityLabel)
    }
}
