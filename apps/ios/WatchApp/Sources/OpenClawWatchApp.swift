import SwiftUI
import UserNotifications

private final class WatchNotificationPresentationDelegate: NSObject, UNUserNotificationCenterDelegate,
    @unchecked Sendable
{
    func userNotificationCenter(
        _: UNUserNotificationCenter,
        willPresent _: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void)
    {
        completionHandler([.banner, .list, .sound])
    }
}

@main
struct OpenClawWatchApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var inboxStore = WatchInboxStore(
        requestNotificationAuthorization: !OpenClawWatchApp.isScreenshotMode)
    @State private var directNode = WatchDirectNode()
    @State private var notificationDelegate = WatchNotificationPresentationDelegate()
    @State private var receiver: WatchConnectivityReceiver?
    @State private var execApprovalRefreshTask: Task<Void, Never>?

    private static let screenshotModeDefaultsKey = "openclaw.watch.screenshotMode"
    private static let isScreenshotMode = ProcessInfo.processInfo.arguments.contains(
        "--openclaw-watch-screenshot-mode")
        || ProcessInfo.processInfo.environment["OPENCLAW_WATCH_SCREENSHOT_MODE"] == "1"
        || UserDefaults.standard.bool(forKey: OpenClawWatchApp.screenshotModeDefaultsKey)

    var body: some Scene {
        WindowGroup {
            WatchInboxView(
                store: self.inboxStore,
                directNode: self.directNode,
                onAction: { action in
                    guard let receiver = self.receiver else { return }
                    let draft = self.inboxStore.makeReplyDraft(action: action)
                    self.inboxStore.markReplySending(actionLabel: action.label)
                    Task { @MainActor in
                        let result = await receiver.sendReply(draft)
                        self.inboxStore.markReplyResult(result, actionLabel: action.label)
                    }
                },
                onExecApprovalDecision: { approvalId, gatewayStableID, decision in
                    guard let receiver = self.receiver else { return }
                    self.inboxStore.markExecApprovalSending(approvalId: approvalId, decision: decision)
                    Task { @MainActor in
                        let result = await receiver.sendExecApprovalResolve(
                            approvalId: approvalId,
                            gatewayStableID: gatewayStableID,
                            decision: decision)
                        self.inboxStore.markExecApprovalSendResult(
                            approvalId: approvalId,
                            decision: decision,
                            result: result)
                    }
                },
                onRefreshExecApprovalReview: {
                    self.refreshExecApprovalReview(force: true)
                },
                onRefreshAppSnapshot: {
                    self.refreshAppSnapshot()
                },
                onAppCommand: { command in
                    self.sendAppCommand(command)
                },
                onSendChatMessage: { text in
                    self.sendChatMessage(text)
                })
                .task {
                    UNUserNotificationCenter.current().delegate = self.notificationDelegate
                    if OpenClawWatchApp.isScreenshotMode {
                        self.inboxStore.configureScreenshotFixture()
                        return
                    }
                    if self.receiver == nil {
                        let receiver = WatchConnectivityReceiver(
                            store: self.inboxStore,
                            directNodeSetupHandler: { [weak directNode] setupCode, sentAtMs in
                                directNode?.configure(setupCode: setupCode, sentAtMs: sentAtMs)
                            })
                        receiver.activate()
                        self.receiver = receiver
                    }
                    if self.scenePhase == .active {
                        self.directNode.connectForForeground()
                    }
                    self.refreshAppSnapshot()
                    self.refreshExecApprovalReview()
                }
                .onChange(of: self.scenePhase) { _, newPhase in
                    switch newPhase {
                    case .active:
                        self.directNode.connectForForeground()
                        self.refreshAppSnapshot()
                        self.refreshExecApprovalReview()
                    case .inactive, .background:
                        self.directNode.disconnectForBackground()
                    @unknown default:
                        break
                    }
                }
        }
    }

    private func refreshAppSnapshot() {
        guard let receiver else { return }
        self.inboxStore.markAppSnapshotRequestStarted()
        Task { @MainActor in
            let result = await receiver.requestAppSnapshot()
            self.inboxStore.markAppSnapshotRequestResult(result)
        }
    }

    private func sendAppCommand(_ command: WatchAppCommand) {
        guard let receiver else { return }
        let message = self.inboxStore.makeAppCommand(command)
        self.inboxStore.markAppCommandSending(command)
        Task { @MainActor in
            let result = await receiver.sendAppCommand(message)
            self.inboxStore.markAppCommandResult(result, command: command)
        }
    }

    private func sendChatMessage(_ text: String) -> String? {
        guard let receiver else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard self.inboxStore.hasGatewayTaggedAppSnapshot else {
            self.inboxStore.markAppCommandBlocked(.sendChat, reason: "refreshing iPhone state")
            self.refreshAppSnapshot()
            return nil
        }
        let message = self.inboxStore.makeAppCommand(.sendChat, text: trimmed)
        self.inboxStore.markAppCommandSending(.sendChat)
        Task { @MainActor in
            let result = await receiver.sendAppCommand(message)
            self.inboxStore.markAppCommandResult(result, command: .sendChat)
            try? await Task.sleep(nanoseconds: 900_000_000)
            self.refreshAppSnapshot()
        }
        return message.commandId
    }

    private func refreshExecApprovalReview(force: Bool = false) {
        guard let receiver else { return }
        guard force || self.inboxStore.shouldAutoRequestExecApprovalSnapshot else { return }

        self.execApprovalRefreshTask?.cancel()
        self.execApprovalRefreshTask = Task { @MainActor in
            self.inboxStore.beginExecApprovalReviewLoading()
            for attempt in 0..<5 {
                if Task.isCancelled { return }
                await receiver.requestExecApprovalSnapshot()
                if !self.inboxStore.execApprovals.isEmpty
                    || self.inboxStore.hasCompletedExecApprovalSnapshotRefresh
                {
                    self.inboxStore.markExecApprovalReviewLoaded()
                    return
                }
                if attempt < 4 {
                    try? await Task.sleep(nanoseconds: 700_000_000)
                }
            }
            if self.inboxStore.execApprovals.isEmpty {
                self.inboxStore.markExecApprovalReviewUnavailable(
                    "Couldn't load approval from your iPhone yet.")
            }
        }
    }
}

@MainActor
extension WatchInboxStore {
    fileprivate func configureScreenshotFixture() {
        let sentAtMs = Int64(Date().timeIntervalSince1970 * 1000)
        greetingTextOverride = "Good morning"
        self.consume(
            execApprovalSnapshot: WatchExecApprovalSnapshotMessage(
                approvals: [],
                gatewayStableID: "watch-screenshot-gateway",
                sentAtMs: sentAtMs,
                snapshotId: nil),
            transport: "screenshot")
        self.consume(
            appSnapshot: WatchAppSnapshotMessage(
                gatewayStatusText: "Connected",
                gatewayConnected: true,
                agentName: "Molty",
                agentAvatarURL: nil,
                agentAvatarText: "M",
                sessionKey: "watch-screenshot-session",
                gatewayStableID: "watch-screenshot-gateway",
                talkStatusText: "Ready",
                talkEnabled: true,
                talkListening: false,
                talkSpeaking: false,
                pendingApprovalCount: 0,
                chatItems: [
                    WatchChatItem(
                        id: "watch-screenshot-user-chat",
                        role: "user",
                        text: "What's on deck?",
                        timestampMs: sentAtMs - 90000),
                    WatchChatItem(
                        id: "watch-screenshot-molty-chat",
                        role: "assistant",
                        text: "Gateway is online and ready.",
                        timestampMs: sentAtMs - 30000),
                ],
                chatStatusText: "Live gateway conversation",
                sentAtMs: sentAtMs,
                snapshotId: "watch-screenshot-now-face"))
    }
}
