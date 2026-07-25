import SwiftUI

struct DeepLinkAgentPromptAlert: ViewModifier {
    @Environment(NodeAppModel.self) private var appModel: NodeAppModel

    private var promptBinding: Binding<NodeAppModel.AgentDeepLinkPrompt?> {
        Binding(
            get: { self.appModel.pendingAgentDeepLinkPrompt },
            set: { _ in
                // Keep prompt state until explicit user action.
            })
    }

    func body(content: Content) -> some View {
        content.alert(item: self.promptBinding) { prompt in
            Alert(
                title: Text("Run OpenClaw agent?")
                    .font(OpenClawType.headline),
                message: Text(verbatim: String(
                    format: String(localized: """
                    Message:
                    %1$@

                    URL:
                    %2$@
                    """),
                    prompt.messagePreview,
                    prompt.urlPreview))
                    .font(OpenClawType.subhead),
                primaryButton: .cancel(
                    Text("Cancel")
                        .font(OpenClawType.subheadSemiBold))
                {
                    self.appModel.declinePendingAgentDeepLinkPrompt()
                },
                secondaryButton: .default(
                    Text("Run")
                        .font(OpenClawType.subheadSemiBold))
                {
                    Task { await self.appModel.approvePendingAgentDeepLinkPrompt() }
                })
        }
    }
}

extension View {
    func deepLinkAgentPromptAlert() -> some View {
        self.modifier(DeepLinkAgentPromptAlert())
    }
}
