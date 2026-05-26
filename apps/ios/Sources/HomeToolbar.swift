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

struct TalkToolbarTray: View {
    var brighten: Bool
    var tint: Color
    var statusText: String
    var agentName: String
    var micLevel: Double
    var isListening: Bool
    var isSpeaking: Bool
    var isUserSpeechDetected: Bool
    var permissionState: TalkGatewayPermissionState
    var onEnableTalk: () -> Void
    var onStopTalk: () -> Void

    @Environment(\.colorSchemeContrast) private var contrast

    private var state: TalkToolbarTrayState {
        TalkToolbarTrayState(
            statusText: self.statusText,
            isListening: self.isListening,
            isSpeaking: self.isSpeaking,
            isUserSpeechDetected: self.isUserSpeechDetected,
            permissionState: self.permissionState)
    }

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(self.tint.opacity(self.state.iconFillOpacity))
                    .frame(width: 36, height: 36)
                Image(systemName: self.state.systemImage)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(self.state.iconColor(tint: self.tint))
            }

            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    Text(self.state.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    if self.state.showsProgress {
                        ProgressView()
                            .controlSize(.mini)
                    }
                }

                HStack(spacing: 8) {
                    TalkWaveformView(
                        mode: self.state.waveformMode(micLevel: self.micLevel),
                        tint: self.state.waveformTint(tint: self.tint))
                        .frame(width: 84, height: 18)
                        .accessibilityHidden(true)

                    Text(self.subtitle)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 0)

            switch self.state.action {
            case .enable:
                Button(action: self.onEnableTalk) {
                    Label("Enable Talk", systemImage: "key.fill")
                        .labelStyle(.titleAndIcon)
                }
                .font(.caption.weight(.semibold))
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            case .stop:
                Button(action: self.onStopTalk) {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .bold))
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .background {
                    Circle()
                        .fill(Color.black.opacity(self.brighten ? 0.10 : 0.18))
                        .overlay {
                            Circle()
                                .strokeBorder(
                                    .white.opacity(self.contrast == .increased ? 0.42 : 0.16),
                                    lineWidth: self.contrast == .increased ? 1.0 : 0.6)
                        }
                }
                .accessibilityLabel("Stop Talk")
            case .none:
                EmptyView()
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity)
        .background(.ultraThinMaterial)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(.white.opacity(self.contrast == .increased ? 0.46 : (self.brighten ? 0.18 : 0.12)))
                .frame(height: self.contrast == .increased ? 1.0 : 0.6)
                .allowsHitTesting(false)
        }
        .overlay(alignment: .bottom) {
            LinearGradient(
                colors: [
                    self.tint.opacity(self.brighten ? 0.12 : 0.16),
                    .clear,
                ],
                startPoint: .leading,
                endPoint: .trailing)
                .frame(height: 1)
                .allowsHitTesting(false)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Talk Mode")
        .accessibilityValue("\(self.state.title), \(self.subtitle)")
    }

    private var subtitle: String {
        let trimmedAgent = self.agentName.trimmingCharacters(in: .whitespacesAndNewlines)
        if self.state.prefersPermissionCopy {
            return "Gateway approval needed"
        }
        if !trimmedAgent.isEmpty {
            return trimmedAgent
        }
        return "OpenClaw"
    }
}

private enum TalkToolbarTrayAction {
    case none
    case enable
    case stop
}

private enum TalkWaveformMode: Equatable {
    case level(Double)
    case inputSpeech
    case speaking
    case indeterminate
    case still
}

private struct TalkToolbarTrayState: Equatable {
    let statusText: String
    let isListening: Bool
    let isSpeaking: Bool
    let isUserSpeechDetected: Bool
    let permissionState: TalkGatewayPermissionState

    private var normalizedStatus: String {
        self.statusText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    var title: String {
        switch self.permissionState {
        case .missingScope, .requestFailed:
            return "Gateway permission required"
        case .requestingUpgrade:
            return "Requesting approval"
        case .upgradeRequested:
            return "Approval requested"
        default:
            break
        }

        if self.isSpeaking { return "Speaking" }
        if self.isListening { return "Listening" }
        if self.normalizedStatus.contains("connecting") { return "Connecting" }
        if self.normalizedStatus.contains("thinking") { return "Asking OpenClaw" }
        if self.normalizedStatus == "ready" { return "Ready to talk" }
        if self.normalizedStatus.isEmpty || self.normalizedStatus == "off" { return "Talk" }
        return self.statusText
    }

    var systemImage: String {
        switch self.permissionState {
        case .missingScope, .requestFailed:
            return "key.fill"
        case .requestingUpgrade:
            return "paperplane.fill"
        case .upgradeRequested:
            return "hourglass"
        default:
            break
        }

        if self.isSpeaking { return "speaker.wave.2.fill" }
        if self.isListening { return "mic.fill" }
        if self.normalizedStatus.contains("thinking") { return "sparkles" }
        if self.normalizedStatus.contains("connecting") { return "dot.radiowaves.left.and.right" }
        return "waveform"
    }

    var action: TalkToolbarTrayAction {
        switch self.permissionState {
        case .missingScope, .requestFailed:
            .enable
        case .requestingUpgrade, .upgradeRequested:
            .none
        default:
            .stop
        }
    }

    var showsProgress: Bool {
        switch self.permissionState {
        case .requestingUpgrade, .upgradeRequested:
            true
        default:
            self.normalizedStatus.contains("connecting") || self.normalizedStatus.contains("thinking")
        }
    }

    var prefersPermissionCopy: Bool {
        switch self.permissionState {
        case .missingScope, .requestingUpgrade, .upgradeRequested, .requestFailed:
            true
        default:
            false
        }
    }

    var iconFillOpacity: Double {
        self.prefersPermissionCopy ? 0.18 : 0.24
    }

    func iconColor(tint: Color) -> Color {
        switch self.permissionState {
        case .requestFailed:
            .red
        case .missingScope, .requestingUpgrade, .upgradeRequested:
            .orange
        default:
            tint
        }
    }

    func waveformTint(tint: Color) -> Color {
        switch self.permissionState {
        case .requestFailed:
            .red
        case .missingScope, .requestingUpgrade, .upgradeRequested:
            .orange
        default:
            tint
        }
    }

    func waveformMode(micLevel: Double) -> TalkWaveformMode {
        switch self.permissionState {
        case .requestingUpgrade, .upgradeRequested:
            return .indeterminate
        case .missingScope, .requestFailed:
            return .still
        default:
            break
        }

        if self.isSpeaking {
            return .speaking
        }
        if self.isListening, self.isUserSpeechDetected {
            return .inputSpeech
        }
        if self.isListening {
            return .level(micLevel)
        }
        if self.normalizedStatus.contains("connecting") || self.normalizedStatus.contains("thinking") {
            return .indeterminate
        }
        return .still
    }
}

private struct TalkWaveformView: View {
    var mode: TalkWaveformMode
    var tint: Color

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let barCount = 14

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1.0 / 24.0)) { timeline in
            HStack(alignment: .center, spacing: 3) {
                ForEach(0..<self.barCount, id: \.self) { index in
                    Capsule(style: .continuous)
                        .fill(self.tint.opacity(self.opacity(for: index)))
                        .frame(width: 3, height: self.height(for: index, date: timeline.date))
                }
            }
            .frame(maxHeight: .infinity)
        }
    }

    private func height(for index: Int, date: Date) -> CGFloat {
        let minimum: Double = 4
        let maximum: Double = 18
        let amplitude = self.amplitude(for: index, date: date)
        return CGFloat(minimum + ((maximum - minimum) * amplitude))
    }

    private func opacity(for index: Int) -> Double {
        switch self.mode {
        case .still:
            index == self.barCount / 2 ? 0.64 : 0.32
        default:
            0.78
        }
    }

    private func amplitude(for index: Int, date: Date) -> Double {
        if self.reduceMotion {
            switch self.mode {
            case let .level(level):
                return min(max(level, 0.10), 1.0)
            case .inputSpeech:
                return 0.72
            case .speaking:
                return 0.62
            case .indeterminate:
                return 0.34
            case .still:
                return 0.18
            }
        }

        let t = date.timeIntervalSinceReferenceDate
        let phase = Double(index) * 0.52
        switch self.mode {
        case let .level(level):
            let clamped = min(max(level, 0), 1)
            let shaped = 0.12 + (0.88 * clamped)
            let variation = 0.72 + (0.28 * sin((t * 12.0) + phase))
            return min(max(shaped * variation, 0.10), 1.0)
        case .inputSpeech:
            let primary = 0.5 + (0.5 * sin((t * 14.0) + phase))
            let secondary = 0.5 + (0.5 * sin((t * 5.0) + (phase * 1.35)))
            return min(max(0.16 + (0.60 * primary) + (0.24 * secondary), 0.14), 1.0)
        case .speaking:
            let wave = 0.5 + (0.5 * sin((t * 7.5) + phase))
            let secondary = 0.5 + (0.5 * sin((t * 3.0) + (phase * 0.7)))
            return min(max(0.18 + (0.58 * wave) + (0.24 * secondary), 0.12), 1.0)
        case .indeterminate:
            let center = (sin((t * 3.2) + phase) + 1) / 2
            return 0.16 + (0.42 * center)
        case .still:
            return index == self.barCount / 2 ? 0.32 : 0.16
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
