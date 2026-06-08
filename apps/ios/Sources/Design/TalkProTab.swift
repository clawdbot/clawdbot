import SwiftUI

struct TalkProTab: View {
    @Environment(NodeAppModel.self) private var appModel
    @AppStorage("talk.enabled") private var talkEnabled: Bool = false
    @AppStorage(TalkSpeechLocale.storageKey) private var talkSpeechLocale: String = TalkSpeechLocale.automaticID
    @AppStorage(TalkDefaults.speakerphoneEnabledKey) private var talkSpeakerphoneEnabled: Bool =
        TalkDefaults.speakerphoneEnabledByDefault
    @AppStorage("talk.background.enabled") private var talkBackgroundEnabled: Bool = false
    @State private var showPermissionPrompt = false
    @State private var showTalkIssueDetails = false
    var openSettings: () -> Void

    private var state: TalkProState {
        TalkProState(
            gatewayConnected: self.gatewayConnected,
            isDemoMode: self.appModel.isAppleReviewDemoModeEnabled,
            isEnabled: self.appModel.talkMode.isEnabled || self.talkEnabled,
            statusText: self.appModel.talkMode.statusText,
            isConfigLoaded: self.appModel.talkMode.gatewayTalkConfigLoaded,
            isListening: self.appModel.talkMode.isListening,
            isSpeaking: self.appModel.talkMode.isSpeaking,
            isUserSpeechDetected: self.appModel.talkMode.isUserSpeechDetected,
            permissionState: self.appModel.talkMode.gatewayTalkPermissionState)
    }

    var body: some View {
        NavigationStack {
            ZStack {
                CommandControlBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        self.header
                        if let fallbackIssue = self.fallbackIssue {
                            TalkRuntimeIssueBanner(
                                issue: fallbackIssue,
                                onOpenSettings: self.openSettings,
                                onShowDetails: {
                                    self.showTalkIssueDetails = true
                                })
                                .padding(.horizontal, OpenClawProMetric.pagePadding)
                        }
                        self.voiceHeroCard
                        self.conversationCard
                        self.voiceModeCard
                        self.controlsCard
                    }
                    .padding(.top, 16)
                    .padding(.bottom, 18)
                }
            }
            .navigationBarHidden(true)
        }
        .sheet(isPresented: self.$showPermissionPrompt) {
            NavigationStack {
                TalkPermissionPromptView(
                    style: .sheet,
                    onPermissionReady: {
                        self.showPermissionPrompt = false
                        self.startTalk()
                    })
                    .padding()
                    .navigationTitle("Enable Talk")
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Not Now") {
                                self.showPermissionPrompt = false
                            }
                        }
                    }
            }
            .presentationDetents([.medium, .large])
            .openClawSheetChrome()
        }
        .sheet(isPresented: self.$showTalkIssueDetails) {
            if let fallbackIssue = self.fallbackIssue {
                TalkRuntimeIssueDetailsSheet(
                    issue: fallbackIssue,
                    onOpenSettings: self.openSettings)
                    .openClawSheetChrome()
            }
        }
        .onAppear { self.alignPersistedTalkState() }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 11) {
            OpenClawProMark(size: 31, shadowRadius: 9)
            VStack(alignment: .leading, spacing: 2) {
                Text("Talk")
                    .font(.system(size: 27, weight: .bold, design: .rounded))
                Text(self.headerSubtitle)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            self.statusChip
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var statusChip: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(self.state.color)
                .frame(width: 7, height: 7)
            Text(self.state.chipText)
                .font(.caption.weight(.bold))
                .foregroundStyle(self.state.color)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background {
            Capsule(style: .continuous)
                .fill(self.state.color.opacity(0.11))
                .overlay {
                    Capsule(style: .continuous)
                        .strokeBorder(self.state.color.opacity(0.22), lineWidth: 1)
                }
        }
    }

    private var voiceHeroCard: some View {
        CommandPanel(tint: self.state.color, isProminent: true, padding: 16) {
            VStack(alignment: .center, spacing: 16) {
                TalkProOrb(
                    mode: self.state.waveformMode(micLevel: self.appModel.talkMode.micLevel),
                    color: self.state.color,
                    systemImage: self.state.icon)
                    .frame(height: 188)
                    .accessibilityHidden(true)

                VStack(spacing: 5) {
                    Text(self.state.title)
                        .font(.title3.weight(.bold))
                        .multilineTextAlignment(.center)
                    Text(self.heroSubtitle)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }

                Button(action: self.handlePrimaryAction) {
                    Label(self.state.primaryButtonTitle, systemImage: self.state.primaryButtonIcon)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                        .background {
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .fill(self.state.primaryButtonFill)
                                .shadow(color: self.state.color.opacity(0.28), radius: 18, y: 8)
                        }
                }
                .buttonStyle(.plain)
                .disabled(self.state.primaryAction == .waiting)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var conversationCard: some View {
        CommandPanel(padding: 0) {
            VStack(spacing: 0) {
                self.cardHeader(title: "Conversation", value: self.state.chipText, color: self.state.color)
                    .padding(.horizontal, 12)
                    .padding(.top, 11)
                    .padding(.bottom, 3)
                self.infoRow(icon: "person.crop.circle.fill", title: "Agent", value: self.appModel.chatAgentName)
                Divider().padding(.leading, 54)
                self.infoRow(
                    icon: "bubble.left.and.text.bubble.right.fill",
                    title: "Session",
                    value: self.appModel.chatSessionKey)
                Divider().padding(.leading, 54)
                self.infoRow(icon: self.state.icon, title: "Runtime", value: self.appModel.talkMode.statusText)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var voiceModeCard: some View {
        CommandPanel(padding: 0) {
            VStack(spacing: 0) {
                self.cardHeader(
                    title: "Voice mode",
                    value: "Settings ›",
                    color: OpenClawBrand.accent,
                    action: self.openSettings)
                    .padding(.horizontal, 12)
                    .padding(.top, 11)
                    .padding(.bottom, 3)
                self.infoRow(
                    icon: "waveform",
                    title: "Configured",
                    value: self.appModel.talkMode.gatewayTalkVoiceModeTitle)
                Divider().padding(.leading, 54)
                self.infoRow(
                    icon: "waveform",
                    title: "Active now",
                    value: self.activeModeText)
                Divider().padding(.leading, 54)
                self.infoRow(icon: "antenna.radiowaves.left.and.right", title: "Transport", value: self.transportText)
                if let issueText = self.talkIssueText {
                    Divider().padding(.leading, 54)
                    self.infoRow(icon: "exclamationmark.triangle.fill", title: "Last issue", value: issueText)
                }
                Divider().padding(.leading, 54)
                self.infoRow(icon: "key.fill", title: "Permission", value: self.permissionText)
                Divider().padding(.leading, 54)
                self.infoRow(icon: "globe", title: "Speech language", value: self.speechLocaleText)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var controlsCard: some View {
        CommandPanel(padding: 0) {
            VStack(spacing: 0) {
                self.cardHeader(title: "Controls", value: nil, color: .secondary)
                    .padding(.horizontal, 12)
                    .padding(.top, 11)
                    .padding(.bottom, 3)
                self.controlToggleRow("Speakerphone", isOn: self.talkSpeakerphoneBinding)
                Divider().padding(.leading, 14)
                self.controlToggleRow("Background listening", isOn: self.$talkBackgroundEnabled)
                Divider().padding(.leading, 14)
                Button(action: self.openSettings) {
                    HStack {
                        Label("Voice & Talk settings", systemImage: "slider.horizontal.3")
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.secondary)
                    }
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private func controlToggleRow(_ title: String, isOn: Binding<Bool>) -> some View {
        Toggle(title, isOn: isOn)
            .contentShape(Rectangle())
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .overlay {
                // Keep Toggle semantics for accessibility while making the full visual row tappable.
                Button {
                    isOn.wrappedValue.toggle()
                } label: {
                    Rectangle()
                        .fill(.clear)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHidden(true)
            }
    }

    private func cardHeader(
        title: String,
        value: String?,
        color: Color,
        action: (() -> Void)? = nil) -> some View
    {
        HStack(spacing: 8) {
            Text(title)
                .font(.subheadline.weight(.bold))
            Spacer(minLength: 8)
            if let value {
                if let action {
                    Button(value, action: action)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(color)
                } else {
                    Text(value)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(color)
                }
            }
        }
    }

    private func infoRow(icon: String, title: String, value: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .font(.caption.weight(.bold))
                .foregroundStyle(self.state.color)
                .frame(width: 30, height: 30)
                .background {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(self.state.color.opacity(0.11))
                }
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                Text(value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "—" : value)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.78)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
    }

    private var gatewayConnected: Bool {
        !self.appModel.isAppleReviewDemoModeEnabled &&
            GatewayStatusBuilder.build(appModel: self.appModel) == .connected
    }

    private var fallbackIssue: TalkRuntimeIssue? {
        guard self.gatewayConnected else { return nil }
        return self.appModel.talkMode.gatewayTalkCurrentFallbackIssue
    }

    private var headerSubtitle: String {
        let mode = self.appModel.talkMode.gatewayTalkVoiceModeTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let agent = self.appModel.chatAgentName.trimmingCharacters(in: .whitespacesAndNewlines)
        if mode.isEmpty || mode == "Not loaded" { return agent.isEmpty ? "Realtime voice" : agent }
        if agent.isEmpty { return mode }
        return "\(agent) • \(mode)"
    }

    private var heroSubtitle: String {
        if self.state
            .prefersPermissionCopy { return "Gateway approval is required before this phone can capture voice." }
        if self.appModel.isAppleReviewDemoModeEnabled { return "Voice is disabled in Apple Review demo mode." }
        if !self.gatewayConnected { return "Connect to your gateway to start a voice conversation." }
        if !self.appModel.talkMode.gatewayTalkConfigLoaded {
            return "Open Voice settings after the gateway loads Talk configuration."
        }
        let subtitle = (self.appModel.talkMode.gatewayTalkVoiceModeSubtitle ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !subtitle.isEmpty { return subtitle }
        return "Routes voice to \(self.appModel.chatAgentName)."
    }

    private var transportText: String {
        let provider = self.appModel.talkMode.gatewayTalkProviderLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        let transport = self.appModel.talkMode.gatewayTalkTransportLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        if provider.isEmpty || provider == "Not loaded" { return transport.isEmpty ? "Not loaded" : transport }
        if transport.isEmpty || transport == "Not loaded" { return provider }
        return "\(provider) • \(transport)"
    }

    private var activeModeText: String {
        let title = self.appModel.talkMode.gatewayTalkActiveModeTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let subtitle = (self.appModel.talkMode.gatewayTalkActiveModeSubtitle ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if title.isEmpty { return "Not active" }
        if subtitle.isEmpty { return title }
        return "\(title) • \(subtitle)"
    }

    private var talkIssueText: String? {
        let text = (self.appModel.talkMode.gatewayTalkLastIssueText ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : text
    }

    private var permissionText: String {
        if let failure = self.appModel.talkMode.gatewayTalkPermissionState.failureMessage {
            return failure
        }
        return self.appModel.talkMode.gatewayTalkPermissionState.statusLabel
    }

    private var speechLocaleText: String {
        if self.talkSpeechLocale == TalkSpeechLocale.automaticID { return "Automatic" }
        return self.talkSpeechLocale
    }

    private func alignPersistedTalkState() {
        if self.appModel.isAppleReviewDemoModeEnabled,
           self.talkEnabled || self.appModel.talkMode.isEnabled
        {
            self.stopTalk()
        } else if self.appModel.talkMode.gatewayTalkPermissionState.requiresTalkPermissionAction,
                  self.talkEnabled || self.appModel.talkMode.isEnabled
        {
            self.stopTalk()
        } else if self.talkEnabled != self.appModel.talkMode.isEnabled {
            self.appModel.setTalkEnabled(self.talkEnabled)
        }
    }

    private var talkSpeakerphoneBinding: Binding<Bool> {
        Binding(
            get: { self.talkSpeakerphoneEnabled },
            set: { enabled in
                self.talkSpeakerphoneEnabled = enabled
                self.appModel.setTalkSpeakerphoneEnabled(enabled)
            })
    }

    private func handlePrimaryAction() {
        switch self.state.primaryAction {
        case .start:
            self.startTalk()
        case .stop:
            self.stopTalk()
        case .enablePermission:
            self.stopTalk()
            self.showPermissionPrompt = true
        case .openSettings:
            self.openSettings()
        case .waiting:
            break
        }
    }

    private func startTalk() {
        guard !self.appModel.isAppleReviewDemoModeEnabled else { return }
        self.talkEnabled = true
        self.appModel.talkMode.updateMainSessionKey(self.appModel.chatSessionKey)
        self.appModel.setTalkEnabled(true)
    }

    private func stopTalk() {
        self.talkEnabled = false
        self.appModel.setTalkEnabled(false)
    }
}

enum TalkProPrimaryAction: Equatable {
    case start
    case stop
    case enablePermission
    case openSettings
    case waiting
}

enum TalkProWaveformMode: Equatable {
    case level(Double)
    case inputSpeech
    case speaking
    case indeterminate
    case still
}

struct TalkProState: Equatable {
    let gatewayConnected: Bool
    let isDemoMode: Bool
    let isEnabled: Bool
    let statusText: String
    let isConfigLoaded: Bool
    let isListening: Bool
    let isSpeaking: Bool
    let isUserSpeechDetected: Bool
    let permissionState: TalkGatewayPermissionState

    private var normalizedStatus: String {
        self.statusText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    var title: String {
        if self.isDemoMode { return "Demo mode only" }
        if !self.gatewayConnected { return "Gateway offline" }
        switch self.permissionState {
        case .missingScope, .requestFailed:
            return "Gateway permission required"
        case .requestingUpgrade:
            return "Requesting approval"
        case .upgradeRequested:
            return "Approval requested"
        case .apiKeyMissing:
            return "Voice API key missing"
        case .loadFailed:
            return "Voice config failed"
        default:
            break
        }
        if !self.isConfigLoaded { return "Voice config unavailable" }
        if self.isSpeaking { return "Speaking" }
        if self.isListening { return "Listening" }
        if self.normalizedStatus.contains("connecting") { return "Connecting" }
        if self.normalizedStatus.contains("thinking") { return "Asking OpenClaw" }
        if self.isEnabled { return "Ready to talk" }
        return "Talk is off"
    }

    var chipText: String {
        if self.isDemoMode { return "Demo" }
        if !self.gatewayConnected { return "Offline" }
        switch self.permissionState {
        case .missingScope, .requestFailed:
            return "Needs approval"
        case .requestingUpgrade, .upgradeRequested:
            return "Pending"
        case .apiKeyMissing:
            return "API key"
        case .loadFailed:
            return "Config"
        default:
            break
        }
        if !self.isConfigLoaded { return "Config" }
        if self.isSpeaking { return "Speaking" }
        if self.isListening { return "Listening" }
        if self.isEnabled { return "Ready" }
        return "Off"
    }

    var icon: String {
        if self.isDemoMode { return "waveform.slash" }
        if !self.gatewayConnected { return "wifi.slash" }
        switch self.permissionState {
        case .missingScope, .requestFailed:
            return "key.fill"
        case .requestingUpgrade:
            return "paperplane.fill"
        case .upgradeRequested:
            return "hourglass"
        case .apiKeyMissing, .loadFailed:
            return "exclamationmark.triangle.fill"
        default:
            break
        }
        if !self.isConfigLoaded { return "exclamationmark.triangle.fill" }
        if self.isSpeaking { return "speaker.wave.2.fill" }
        if self.isListening { return "mic.fill" }
        if self.normalizedStatus.contains("thinking") { return "sparkles" }
        if self.normalizedStatus.contains("connecting") { return "dot.radiowaves.left.and.right" }
        return "waveform"
    }

    var color: Color {
        if self.isDemoMode { return .secondary }
        if !self.gatewayConnected { return .secondary }
        switch self.permissionState {
        case .requestFailed, .loadFailed:
            return OpenClawBrand.danger
        case .missingScope, .requestingUpgrade, .upgradeRequested, .apiKeyMissing:
            return OpenClawBrand.warn
        default:
            if !self.isConfigLoaded { return OpenClawBrand.warn }
            return self.isEnabled ? OpenClawBrand.ok : OpenClawBrand.accentHot
        }
    }

    var primaryAction: TalkProPrimaryAction {
        if self.isDemoMode { return .waiting }
        if !self.gatewayConnected { return .openSettings }
        switch self.permissionState {
        case .missingScope, .requestFailed:
            return .enablePermission
        case .requestingUpgrade, .upgradeRequested:
            return .waiting
        case .apiKeyMissing, .loadFailed:
            return .openSettings
        default:
            return self.isEnabled ? .stop : .start
        }
    }

    var primaryButtonTitle: String {
        switch self.primaryAction {
        case .start: "Start Talk"
        case .stop: "Stop Talk"
        case .enablePermission: "Enable Talk"
        case .openSettings: self.gatewayConnected ? "Open Voice Settings" : "Open Gateway Settings"
        case .waiting: self.isDemoMode ? "Demo Mode Only" : "Waiting for Approval"
        }
    }

    var primaryButtonIcon: String {
        switch self.primaryAction {
        case .start: "play.fill"
        case .stop: "stop.fill"
        case .enablePermission: "key.fill"
        case .openSettings: "gearshape.fill"
        case .waiting: self.isDemoMode ? "lock.fill" : "hourglass"
        }
    }

    var primaryButtonFill: AnyShapeStyle {
        switch self.primaryAction {
        case .stop:
            AnyShapeStyle(OpenClawBrand.danger)
        case .waiting:
            AnyShapeStyle(OpenClawBrand.warn.opacity(0.72))
        default:
            AnyShapeStyle(LinearGradient(
                colors: [self.color.opacity(0.95), OpenClawBrand.accent],
                startPoint: .topLeading,
                endPoint: .bottomTrailing))
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

    func waveformMode(micLevel: Double) -> TalkProWaveformMode {
        if self.isDemoMode { return .still }
        if !self.gatewayConnected { return .still }
        switch self.permissionState {
        case .requestingUpgrade, .upgradeRequested:
            return .indeterminate
        case .missingScope, .requestFailed, .apiKeyMissing, .loadFailed:
            return .still
        default:
            break
        }
        if !self.isConfigLoaded { return .still }
        if self.isSpeaking { return .speaking }
        if self.isListening, self.isUserSpeechDetected { return .inputSpeech }
        if self.isListening { return .level(micLevel) }
        if self.normalizedStatus.contains("connecting") || self.normalizedStatus.contains("thinking") {
            return .indeterminate
        }
        return self.isEnabled ? .indeterminate : .still
    }
}

private struct TalkProOrb: View {
    let mode: TalkProWaveformMode
    let color: Color
    let systemImage: String

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1.0 / 24.0)) { timeline in
            ZStack {
                ForEach(0..<3, id: \.self) { ring in
                    Circle()
                        .strokeBorder(self.color.opacity(self.ringOpacity(ring)), lineWidth: 1.4)
                        .scaleEffect(self.ringScale(ring, date: timeline.date))
                }
                Circle()
                    .fill(self.color.opacity(0.13))
                    .frame(width: 128, height: 128)
                    .overlay {
                        Circle()
                            .strokeBorder(self.color.opacity(0.30), lineWidth: 1)
                    }
                TalkProWaveform(mode: self.mode, tint: self.color, barCount: 18)
                    .frame(width: 116, height: 52)
                    .opacity(self.systemImage == "waveform" || self.systemImage == "mic.fill" ? 1 : 0.34)
                Image(systemName: self.systemImage)
                    .font(.system(size: 34, weight: .bold))
                    .foregroundStyle(self.color)
                    .opacity(self.systemImage == "waveform" || self.systemImage == "mic.fill" ? 0.20 : 1)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func ringScale(_ ring: Int, date: Date) -> CGFloat {
        guard !self.reduceMotion else { return CGFloat(1.0 + (Double(ring) * 0.12)) }
        let base = 0.88 + (Double(ring) * 0.18)
        let speed = self.mode == .still ? 0.8 : 1.8
        let phase = date.timeIntervalSinceReferenceDate * speed + Double(ring) * 0.9
        return CGFloat(base + (sin(phase) * 0.035))
    }

    private func ringOpacity(_ ring: Int) -> Double {
        switch self.mode {
        case .still:
            0.10 - (Double(ring) * 0.018)
        default:
            0.24 - (Double(ring) * 0.045)
        }
    }
}

private struct TalkProWaveform: View {
    let mode: TalkProWaveformMode
    let tint: Color
    let barCount: Int

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1.0 / 24.0)) { timeline in
            HStack(alignment: .center, spacing: 4) {
                ForEach(0..<self.barCount, id: \.self) { index in
                    Capsule(style: .continuous)
                        .fill(self.tint.opacity(self.opacity(for: index)))
                        .frame(width: 4, height: self.height(for: index, date: timeline.date))
                }
            }
            .frame(maxHeight: .infinity)
        }
    }

    private func height(for index: Int, date: Date) -> CGFloat {
        let minimum = 6.0
        let maximum = 48.0
        return CGFloat(minimum + ((maximum - minimum) * self.amplitude(for: index, date: date)))
    }

    private func opacity(for index: Int) -> Double {
        switch self.mode {
        case .still:
            index == self.barCount / 2 ? 0.64 : 0.30
        default:
            0.82
        }
    }

    private func amplitude(for index: Int, date: Date) -> Double {
        if self.reduceMotion {
            switch self.mode {
            case let .level(level): return min(max(level, 0.10), 1.0)
            case .inputSpeech: return 0.72
            case .speaking: return 0.62
            case .indeterminate: return 0.34
            case .still: return 0.18
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
