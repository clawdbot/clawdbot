import OpenClawKit
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

enum WatchScreenshotMode {
    private static let defaultsKey = "openclaw.watch.screenshotMode"
    static let approvals = ProcessInfo.processInfo.arguments.contains(
        "--openclaw-watch-approval-screenshot-mode")
        || ProcessInfo.processInfo.environment["OPENCLAW_WATCH_APPROVAL_SCREENSHOT_MODE"] == "1"
    static let enabled = ProcessInfo.processInfo.arguments.contains("--openclaw-watch-screenshot-mode")
        || ProcessInfo.processInfo.environment["OPENCLAW_WATCH_SCREENSHOT_MODE"] == "1"
        || UserDefaults.standard.bool(forKey: WatchScreenshotMode.defaultsKey)
        || WatchScreenshotMode.approvals
}

@main
struct OpenClawWatchApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var inboxStore = WatchInboxStore(
        requestNotificationAuthorization: !WatchScreenshotMode.enabled)
    @State private var directNode = WatchDirectNode()
    @State private var notificationDelegate = WatchNotificationPresentationDelegate()
    @State private var receiver: WatchConnectivityReceiver?
    @State private var execApprovalRefreshTask: Task<Void, Never>?

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
                    guard let attemptID = self.inboxStore.beginExecApprovalDecision(
                        approvalId: approvalId,
                        gatewayStableID: gatewayStableID,
                        decision: decision)
                    else { return }
                    Task { @MainActor in
                        let result = await receiver.sendExecApprovalResolve(
                            approvalId: approvalId,
                            gatewayStableID: gatewayStableID,
                            attemptID: attemptID,
                            decision: decision)
                        self.inboxStore.completeExecApprovalDecision(
                            approvalId: approvalId,
                            gatewayStableID: gatewayStableID,
                            attemptID: attemptID,
                            decision: decision,
                            result: result)
                        if result.requiresCanonicalReadback {
                            // WatchConnectivity errors can race successful delivery. Keep
                            // actions frozen while the iPhone reads canonical gateway state.
                            self.refreshExecApprovalReview(force: true)
                        }
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
                    if WatchScreenshotMode.enabled {
                        self.inboxStore.configureScreenshotFixture(
                            includeApproval: WatchScreenshotMode.approvals)
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
            self.inboxStore.markAppCommandBlocked(
                .sendChat,
                reason: String(localized: "Refreshing iPhone state"))
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
            var requestTokens: [WatchExecApprovalSnapshotRequestToken] = []
            func consumeCurrentOwnerAcknowledgment(gatewayStableID: String?) -> Bool {
                var received = false
                var retainedTokens: [WatchExecApprovalSnapshotRequestToken] = []
                for token in requestTokens where token.matchesGatewayStableID(gatewayStableID) {
                    if receiver.consumeExecApprovalSnapshotAcknowledgment(for: token) {
                        received = true
                    } else {
                        retainedTokens.append(token)
                    }
                }
                requestTokens = retainedTokens
                return received
            }

            self.inboxStore.beginExecApprovalReviewLoading()
            for attempt in 0..<5 {
                if Task.isCancelled {
                    return
                }
                let gatewayStableID = self.inboxStore.execApprovalReviewGatewayStableID
                receiver.discardExecApprovalSnapshotAcknowledgments(
                    exceptGatewayStableID: gatewayStableID)
                let receivedBeforeRequest = consumeCurrentOwnerAcknowledgment(
                    gatewayStableID: gatewayStableID)
                let reviewAlreadyAvailable = !force
                    && !self.inboxStore.execApprovals.contains(where: \.isResolving)
                    && (!self.inboxStore.execApprovals.isEmpty
                        || self.inboxStore.hasCompletedExecApprovalSnapshotRefresh)
                if receivedBeforeRequest || reviewAlreadyAvailable {
                    self.inboxStore.markExecApprovalReviewLoaded()
                    return
                }

                if let token = await receiver.requestExecApprovalSnapshot(
                    gatewayStableID: gatewayStableID,
                    heldApprovals: self.inboxStore.execApprovalSnapshotRequestItems(
                        gatewayStableID: gatewayStableID))
                {
                    let currentGatewayStableID = self.inboxStore.execApprovalReviewGatewayStableID
                    if token.matchesGatewayStableID(currentGatewayStableID) {
                        requestTokens.append(token)
                    }
                }
                if consumeCurrentOwnerAcknowledgment(
                    gatewayStableID: self.inboxStore.execApprovalReviewGatewayStableID)
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
    fileprivate func configureScreenshotFixture(includeApproval: Bool = false) {
        let sentAtMs = Int64(Date().timeIntervalSince1970 * 1000)
        let approvals: [WatchExecApprovalItem] = if includeApproval {
            [
                WatchExecApprovalItem(
                    id: "watch-screenshot-approval",
                    gatewayStableID: "watch-screenshot-gateway",
                    commandText: "curl --request POST https://deploy.example.invalid/releases",
                    commandPreview: "Deploy the latest release",
                    warningText: "This command can change a production service.",
                    host: "deploy-runner",
                    nodeId: "release-node",
                    agentId: "main",
                    expiresAtMs: sentAtMs + 10 * 60 * 1000,
                    allowedDecisions: [.allowOnce, .deny],
                    risk: .high),
            ]
        } else {
            []
        }
        greetingTextOverride = "Good morning"
        self.consume(
            execApprovalSnapshot: WatchExecApprovalSnapshotMessage(
                approvals: approvals,
                gatewayStableID: "watch-screenshot-gateway",
                sentAtMs: sentAtMs,
                snapshotId: includeApproval ? "watch-screenshot-approval-face" : nil),
            transport: "screenshot")
        self.consume(
            appSnapshot: WatchAppSnapshotMessage(
                gatewayStatus: OpenClawWatchAppStatus(code: .gatewayConnected),
                gatewayConnected: true,
                agentName: "Molty",
                agentAvatarURL: nil,
                agentAvatarText: "M",
                sessionKey: "watch-screenshot-session",
                gatewayStableID: "watch-screenshot-gateway",
                talkStatus: OpenClawWatchAppStatus(code: .talkReady),
                talkEnabled: true,
                talkListening: false,
                talkSpeaking: false,
                pendingApprovalCount: approvals.count,
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
                chatStatus: nil,
                sentAtMs: sentAtMs,
                snapshotId: "watch-screenshot-now-face"))
    }
}
