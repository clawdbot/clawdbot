import OpenClawProtocol
import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct QuickChatViewSmokeTests {
    @Test func `quick chat view builds body`() {
        let model = QuickChatModel(
            sessionKeyProvider: { "main" },
            agentsProvider: {
                AgentsListResult(
                    defaultid: "main",
                    mainkey: "main",
                    scope: AnyCodable("per-agent"),
                    agents: [AgentSummary(id: "main", name: "Agent")])
            },
            agentIdentityProvider: { _ in QuickChatAgentDisplay(id: "main", name: "Agent", emoji: nil) },
            sendProvider: { _, _, _, _, _, _ in "ok" },
            permissionStatusProvider: { capabilities in
                Dictionary(uniqueKeysWithValues: capabilities.map { ($0, true) })
            },
            permissionGrantProvider: { capabilities in
                Dictionary(uniqueKeysWithValues: capabilities.map { ($0, true) })
            },
            connectionGateProvider: { .available },
            modelControlsProvider: { _ in .testFixture },
            modelPatchProvider: { _, _ in nil })
        let view = QuickChatView(
            model: model,
            replyBinding: QuickChatReplyBinding(),
            onDismiss: {},
            onSendAccepted: { _ in },
            onShowAgentPicker: {},
            onShowModelMenu: {},
            onShowRecentSessions: {},
            onToggleDictation: {},
            onStopDictation: {},
            onCaptureTextContext: {},
            onShowCaptureMenu: {},
            onGrantPermissions: {},
            onPasteReply: {},
            onContentHeightChange: { _ in },
            onTextViewReady: { _ in })

        _ = view.body
    }
}
