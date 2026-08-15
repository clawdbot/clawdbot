import SwiftUI

enum SystemAgentAvailability {
    static func shouldShow(configuredModel: String?) -> Bool {
        !(configuredModel?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
    }
}

/// Settings pane hosting the OpenClaw setup/repair chat.
///
/// The parent settings view exposes this pane only after inference is configured.
struct SystemAgentSettings: View {
    let isActive: Bool
    let onReplyReceived: () -> Void
    @State private var chat = SystemAgentOnboardingChatModel(
        welcomeVariant: nil,
        sessionPrefix: "mac-settings-openclaw")

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            SettingsPageHeader(
                title: "OpenClaw",
                subtitle: """
                Your AI-powered setup helper. It can check status, fix config, switch models, and connect channels.
                """)

            SettingsCardGroup("Chat") {
                SystemAgentOnboardingChatView(model: self.chat)
                    .frame(maxWidth: .infinity, minHeight: 320, maxHeight: .infinity)
            }
            .frame(maxHeight: .infinity)

            Text("Tip: try “status”, “doctor”, “set default model …”, or “connect telegram”.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .settingsDetailContent()
        .task(id: self.isActive) {
            guard self.isActive else { return }
            Self.configureChatCallbacks(
                for: self.chat,
                onReplyReceived: self.onReplyReceived)
            await self.chat.startIfNeeded()
        }
    }

    @MainActor
    static func configureChatCallbacks(
        for chat: SystemAgentOnboardingChatModel,
        onReplyReceived: @escaping () -> Void)
    {
        chat.onAgentHandoff = { agentDraft in
            AppNavigationActions.openChat(draft: agentDraft?.composerValue)
        }
        chat.onReplyReceived = onReplyReceived
    }
}
