import OpenClawChatUI
import OpenClawProtocol
import SwiftUI

struct ChatProTab: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.colorScheme) private var colorScheme
    @State private var viewModel: OpenClawChatViewModel?
    @State private var viewModelUsesAppleReviewDemoTransport = false

    var body: some View {
        NavigationStack {
            ZStack {
                OpenClawProBackground()
                VStack(spacing: 0) {
                    self.header
                    if let viewModel {
                        OpenClawChatView(
                            viewModel: viewModel,
                            drawsBackground: false,
                            showsSessionSwitcher: false,
                            userAccent: self.chatUserAccent,
                            assistantName: self.agentDisplayName,
                            assistantAvatarText: self.agentBadge,
                            assistantAvatarTint: OpenClawBrand.accent,
                            showsAssistantAvatars: false,
                            composerChrome: .clean,
                            isComposerEnabled: self.gatewayConnected,
                            messagePlaceholder: self.messagePlaceholder,
                            talkControl: self.talkControl)
                            .id(ObjectIdentifier(viewModel))
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                    } else {
                        ProCard {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Chat is preparing")
                                    .font(.headline)
                                Text("The operator session will attach when the gateway is ready.")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding()
                        Spacer()
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .navigationBarHidden(true)
        }
        .task {
            self.syncChatViewModel()
        }
        .onChange(of: self.appModel.chatSessionKey) { _, _ in
            self.syncChatViewModel()
        }
        .onChange(of: self.appModel.isAppleReviewDemoModeEnabled) { _, _ in
            self.syncChatViewModel()
            self.viewModel?.refresh()
        }
        .onChange(of: self.appModel.isOperatorGatewayConnected) { _, connected in
            guard connected else { return }
            self.syncChatViewModel()
            self.viewModel?.refresh()
        }
    }

    private var header: some View {
        HStack(spacing: 11) {
            Text(self.agentBadge)
                .font(.system(size: self.agentBadge.count > 2 ? 13 : 16, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
                .minimumScaleFactor(0.6)
                .lineLimit(1)
                .frame(width: 38, height: 38)
                .background(
                    Circle()
                        .fill(
                            LinearGradient(
                                colors: [
                                    OpenClawBrand.accent,
                                    OpenClawBrand.accentHot,
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing)))
                .overlay(Circle().strokeBorder(.white.opacity(0.18), lineWidth: 1))
                .shadow(color: OpenClawBrand.accent.opacity(0.18), radius: 10, y: 5)

            VStack(alignment: .leading, spacing: 1) {
                Text(self.agentDisplayName)
                    .font(.headline.weight(.semibold))
                    .lineLimit(1)
                Text("AI Assistant")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            self.connectionPill
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
        .padding(.top, 8)
        .padding(.bottom, 4)
    }

    private func syncChatViewModel() {
        let sessionKey = self.appModel.chatSessionKey
        let usesDemoTransport = self.appModel.isAppleReviewDemoModeEnabled
        guard let viewModel else {
            self.viewModelUsesAppleReviewDemoTransport = usesDemoTransport
            self.viewModel = OpenClawChatViewModel(
                sessionKey: sessionKey,
                transport: usesDemoTransport
                    ? AppleReviewDemoChatTransport()
                    : IOSGatewayChatTransport(gateway: self.appModel.operatorSession),
                onSessionChanged: { sessionKey in
                    self.appModel.focusChatSession(sessionKey)
                },
                diagnosticsLog: { message in
                    GatewayDiagnostics.log(message)
                })
            return
        }
        if self.viewModelUsesAppleReviewDemoTransport != usesDemoTransport {
            self.viewModelUsesAppleReviewDemoTransport = usesDemoTransport
            self.viewModel = OpenClawChatViewModel(
                sessionKey: sessionKey,
                transport: usesDemoTransport
                    ? AppleReviewDemoChatTransport()
                    : IOSGatewayChatTransport(gateway: self.appModel.operatorSession),
                onSessionChanged: { sessionKey in
                    self.appModel.focusChatSession(sessionKey)
                },
                diagnosticsLog: { message in
                    GatewayDiagnostics.log(message)
                })
            return
        }
        guard viewModel.sessionKey != sessionKey else { return }
        viewModel.syncSession(to: sessionKey)
    }

    private var talkControl: OpenClawChatTalkControl {
        OpenClawChatTalkControl(
            isEnabled: self.appModel.talkMode.isEnabled,
            isListening: self.appModel.talkMode.isListening,
            isSpeaking: self.appModel.talkMode.isSpeaking,
            isGatewayConnected: self.appModel.talkMode.isGatewayConnected,
            statusText: self.appModel.talkMode.statusText,
            providerLabel: self.appModel.talkMode.gatewayTalkProviderLabel,
            toggle: { sessionKey in
                self.appModel.focusChatSession(sessionKey)
                self.appModel.setTalkEnabled(!self.appModel.talkMode.isEnabled)
            })
    }

    private var activeAgentID: String {
        self.normalized(self.appModel.chatAgentId)
            ?? "main"
    }

    private var connectionPill: some View {
        HStack(spacing: 6) {
            ProStatusDot(color: self.gatewayConnected ? OpenClawBrand.ok : .orange)
            Text(self.gatewayConnected ? "Connected" : "Connecting")
                .font(.caption.weight(.semibold))
                .lineLimit(1)
        }
        .foregroundStyle(self.gatewayConnected ? OpenClawBrand.ok : .orange)
        .padding(.horizontal, 10)
        .frame(height: 30)
        .background {
            Capsule()
                .fill((self.gatewayConnected ? OpenClawBrand.ok : Color.orange).opacity(0.11))
        }
        .overlay {
            Capsule()
                .strokeBorder((self.gatewayConnected ? OpenClawBrand.ok : Color.orange).opacity(0.16), lineWidth: 1)
        }
    }

    private var gatewayConnected: Bool {
        guard GatewayStatusBuilder.build(appModel: self.appModel) == .connected else {
            return false
        }
        return self.appModel.isAppleReviewDemoModeEnabled || self.appModel.isOperatorGatewayConnected
    }

    private var messagePlaceholder: String {
        self.gatewayConnected ? "Message \(self.agentDisplayName)..." : "Connect to a gateway"
    }

    private var chatUserAccent: Color {
        self.colorScheme == .light ? Color(red: 0 / 255.0, green: 122 / 255.0, blue: 255 / 255.0) : OpenClawBrand.accent
    }

    private var activeAgent: AgentSummary? {
        self.appModel.gatewayAgents.first { $0.id == self.activeAgentID }
    }

    private var agentDisplayName: String {
        self.normalized(self.activeAgent?.name) ?? self.appModel.chatAgentName
    }

    private var agentBadge: String {
        if let identity = self.activeAgent?.identity,
           let emoji = identity["emoji"]?.value as? String,
           let normalizedEmoji = self.normalized(emoji)
        {
            return normalizedEmoji
        }
        let words = self.agentDisplayName
            .split(whereSeparator: { $0.isWhitespace || $0 == "-" || $0 == "_" })
            .prefix(2)
        let initials = words.compactMap(\.first).map(String.init).joined()
        if !initials.isEmpty {
            return initials.uppercased()
        }
        return "OC"
    }

    private func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
