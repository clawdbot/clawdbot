import SwiftUI

struct WatchRealtimeCallView: View {
    @Environment(\.scenePhase) private var scenePhase

    let directNode: WatchDirectNode

    private var controller: WatchRealtimeCallController {
        self.directNode.voiceCall
    }

    private var hasCall: Bool {
        switch self.controller.state {
        case .idle, .failed: false
        default: true
        }
    }

    private var statusText: String {
        switch self.controller.state {
        case .idle:
            if self.directNode.voiceConnection == nil {
                String(localized: "Set up standalone voice")
            } else {
                String(localized: "Ready to talk")
            }
        case .preparingAudio: String(localized: "Preparing microphone…")
        case .connectingGateway: String(localized: "Connecting to Gateway…")
        case .choosingAgent: String(localized: "Choose an agent")
        case .connectingVoice: String(localized: "Connecting voice…")
        case .active:
            if self.controller.isMuted {
                String(localized: "Microphone muted")
            } else {
                String(localized: "Connected")
            }
        case .reconnecting: String(localized: "Reconnecting…")
        case .stopping: String(localized: "Ending call…")
        case .failed: String(localized: "Call unavailable")
        }
    }

    private var waveformPhase: TalkWaveformPhase {
        switch self.controller.state {
        case .active:
            self.controller.isMuted
                ? .idle
                : .listening(level: Double(self.controller.inputLevel), speechActive: false)
        case .preparingAudio, .connectingGateway, .connectingVoice, .reconnecting:
            .thinking
        case .idle, .choosingAgent, .stopping, .failed:
            .idle
        }
    }

    private var selectedAgentName: String? {
        guard let selectedID = self.controller.selectedAgentID else { return nil }
        let agent = self.controller.agents.first { $0.id.utf8.elementsEqual(selectedID.utf8) }
        return agent?.name ?? selectedID
    }

    var body: some View {
        VStack(spacing: 8) {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    // Setup must remain visible above disabled Start on compact Watch displays.
                    if self.directNode.voiceConnection != nil {
                        self.header

                        TalkWaveformView(phase: self.waveformPhase)
                            .frame(height: 40)
                            .accessibilityHidden(true)
                    }

                    Text(self.statusText)
                        .font(WatchClawType.body(size: 13, weight: .semibold))
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("watch-voice-status")

                    if self.directNode.voiceConnection == nil {
                        self.setupGuidance
                    } else if self.controller.state == .idle {
                        Text("Keep OpenClaw on screen until connected. Tap End to finish.")
                            .font(WatchClawType.body(size: 12))
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    if self.controller.state == .choosingAgent {
                        self.agentChoices
                    } else if let agentName = self.selectedAgentName {
                        Text(verbatim: agentName)
                            .font(WatchClawType.captionSemiBold)
                            .foregroundStyle(WatchClawStyle.accent)
                            .lineLimit(2)
                    }

                    if let errorText = self.controller.errorText {
                        Text(verbatim: errorText)
                            .font(WatchClawType.body(size: 12))
                            .foregroundStyle(WatchClawStyle.accent)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if !self.controller.latestUserTranscript.isEmpty {
                        self.transcript(title: "You", text: self.controller.latestUserTranscript)
                    }
                    if !self.controller.latestAssistantTranscript.isEmpty {
                        self.transcript(title: "Claw", text: self.controller.latestAssistantTranscript)
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollIndicators(.hidden)

            self.controls
                .padding(.horizontal, 8)
                .padding(.bottom, 5)
        }
        .background(WatchClawStyle.background.ignoresSafeArea())
        .navigationTitle("Voice")
        .toolbar(.visible, for: .navigationBar)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Talk on Watch")
                .font(WatchClawType.title(size: 19))
                .fixedSize(horizontal: false, vertical: true)
            if let endpoint = self.directNode.endpointText {
                Text(verbatim: endpoint)
                    .font(WatchClawType.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .truncationMode(.middle)
            }
        }
    }

    private var setupGuidance: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("On iPhone, open OpenClaw → Settings → Apple Watch → Connect Apple Watch.")
                .font(WatchClawType.body(size: 12))
                .fixedSize(horizontal: false, vertical: true)
            Text(verbatim: self.directNode.statusText)
                .font(WatchClawType.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var agentChoices: some View {
        VStack(spacing: 6) {
            ForEach(self.controller.agents, id: \.id) { agent in
                Button {
                    self.controller.selectAgent(agent.id)
                } label: {
                    HStack(spacing: 6) {
                        Text(verbatim: agent.name ?? agent.id)
                            .font(WatchClawType.body(size: 13, weight: .semibold))
                            .lineLimit(2)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right")
                            .font(WatchClawType.symbol(size: 10, weight: .semibold))
                    }
                    .padding(.horizontal, 10)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .background(WatchClawStyle.raised, in: RoundedRectangle(cornerRadius: 14))
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder private var controls: some View {
        if self.hasCall {
            HStack(spacing: 6) {
                Button {
                    self.controller.setMuted(!self.controller.isMuted)
                } label: {
                    Text(self.controller.isMuted ? "Unmute" : "Mute")
                        .font(WatchClawType.captionBold)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(WatchClawStyle.raised, in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(self.controller.state != .active)
                .accessibilityIdentifier("watch-voice-mute")

                Button {
                    self.controller.end()
                } label: {
                    Text("End")
                        .font(WatchClawType.captionBold)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(WatchClawStyle.hotGradient, in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(self.controller.state == .stopping)
                .accessibilityIdentifier("watch-voice-end")
            }
        } else {
            Button(action: self.startCall) {
                Text(self.controller.state == .failed ? "Try Again" : "Start")
                    .font(WatchClawType.captionBold)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .background(WatchClawStyle.hotGradient, in: Capsule())
            }
            .buttonStyle(.plain)
            .disabled(self.directNode.voiceConnection == nil || self.scenePhase != .active)
            .accessibilityHint("Starts the microphone and connects directly to your Gateway")
            .accessibilityIdentifier("watch-voice-start")
        }
    }

    private func transcript(title: LocalizedStringKey, text: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(WatchClawType.label())
                .foregroundStyle(WatchClawStyle.accent)
            Text(verbatim: text)
                .font(WatchClawType.body(size: 13))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(WatchClawStyle.surface, in: RoundedRectangle(cornerRadius: 14))
    }

    private func startCall() {
        guard !self.hasCall, self.scenePhase == .active,
              let connection = self.directNode.voiceConnection
        else { return }
        self.controller.start(connection: connection) { [weak directNode = self.directNode] in
            directNode?.voiceConnection == connection
        }
    }
}
