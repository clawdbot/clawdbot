import Foundation
import Observation
import UserNotifications
import WatchKit

enum WatchPayloadType: String, Codable, Equatable {
    case notify = "watch.notify"
    case directNodeSetup = "watch.node.setup"
    case reply = "watch.reply"
    case appSnapshot = "watch.app.snapshot"
    case appSnapshotRequest = "watch.app.snapshotRequest"
    case appCommand = "watch.app.command"
    case chatCompletion = "watch.chat.completion"
    case execApprovalPrompt = "watch.execApproval.prompt"
    case execApprovalResolve = "watch.execApproval.resolve"
    case execApprovalResolved = "watch.execApproval.resolved"
    case execApprovalExpired = "watch.execApproval.expired"
    case execApprovalSnapshot = "watch.execApproval.snapshot"
    case execApprovalSnapshotRequest = "watch.execApproval.snapshotRequest"
}

enum WatchRiskLevel: String, Codable, Equatable {
    case low
    case medium
    case high
}

enum WatchExecApprovalDecision: String, Codable, Equatable {
    case allowOnce = "allow-once"
    case deny
}

enum WatchExecApprovalCloseReason: String, Codable, Equatable {
    case expired
    case notFound = "not-found"
    case unavailable
    case replaced
    case resolved
}

struct WatchExecApprovalItem: Codable, Equatable, Identifiable {
    var id: String
    var gatewayStableID: String?
    var commandText: String
    var commandPreview: String?
    var host: String?
    var nodeId: String?
    var agentId: String?
    var expiresAtMs: Int64?
    var allowedDecisions: [WatchExecApprovalDecision]
    var risk: WatchRiskLevel?
}

struct WatchExecApprovalPromptMessage: Codable, Equatable {
    var approval: WatchExecApprovalItem
    var sentAtMs: Int64?
    var deliveryId: String?
    var resetResolvingState: Bool?
}

struct WatchExecApprovalResolvedMessage: Codable, Equatable {
    var approvalId: String
    var gatewayStableID: String?
    var decision: WatchExecApprovalDecision?
    var resolvedAtMs: Int64?
    var source: String?
}

struct WatchExecApprovalExpiredMessage: Codable, Equatable {
    var approvalId: String
    var gatewayStableID: String?
    var reason: WatchExecApprovalCloseReason
    var expiredAtMs: Int64?
}

struct WatchExecApprovalSnapshotMessage: Codable, Equatable {
    var approvals: [WatchExecApprovalItem]
    var gatewayStableID: String?
    var sentAtMs: Int64?
    var snapshotId: String?
}

struct WatchExecApprovalSnapshotRequestMessage: Codable, Equatable {
    var requestId: String
    var sentAtMs: Int64?
}

struct WatchExecApprovalResolveMessage: Codable, Equatable {
    var approvalId: String
    var gatewayStableID: String?
    var decision: WatchExecApprovalDecision
    var replyId: String
    var sentAtMs: Int64?
}

struct WatchAppSnapshotMessage: Codable, Equatable {
    var gatewayStatusText: String
    var gatewayConnected: Bool
    var agentName: String
    var agentAvatarURL: String?
    var agentAvatarText: String?
    var sessionKey: String
    var gatewayStableID: String?
    var talkStatusText: String
    var talkEnabled: Bool
    var talkListening: Bool
    var talkSpeaking: Bool
    var pendingApprovalCount: Int
    var chatItems: [WatchChatItem]?
    var chatStatusText: String?
    var sentAtMs: Int64?
    var snapshotId: String?
}

struct WatchChatCompletionMessage: Codable, Equatable {
    var commandId: String
    var replyText: String
    var sentAtMs: Int64?
}

struct WatchChatItem: Codable, Equatable, Identifiable {
    var id: String
    var role: String
    var text: String
    var timestampMs: Int64?
}

struct WatchAppSnapshotRequestMessage: Codable, Equatable {
    var requestId: String
    var sentAtMs: Int64?
}

enum WatchAppCommand: String, Codable, Equatable {
    case refresh
    case openChat = "open-chat"
    case sendChat = "send-chat"
    case startTalk = "start-talk"
    case stopTalk = "stop-talk"
}

struct WatchAppCommandMessage: Codable, Equatable {
    var command: WatchAppCommand
    var commandId: String
    var sessionKey: String?
    var gatewayStableID: String?
    var text: String?
    var sentAtMs: Int64?
}

struct WatchPromptAction: Codable, Equatable, Identifiable {
    var id: String
    var label: String
    var style: String?
}

struct WatchNotifyMessage: Codable {
    var id: String?
    var title: String
    var body: String
    var sentAtMs: Int64?
    var promptId: String?
    var sessionKey: String?
    var gatewayStableID: String?
    var kind: String?
    var details: String?
    var expiresAtMs: Int64?
    var risk: String?
    var actions: [WatchPromptAction]
}

struct WatchExecApprovalRecord: Codable, Equatable, Identifiable {
    var approval: WatchExecApprovalItem
    var transport: String
    var updatedAt: Date
    var isResolving: Bool
    var pendingDecision: WatchExecApprovalDecision?
    var statusText: String?
    var statusAt: Date?

    var id: String {
        self.approval.id
    }
}

@MainActor @Observable final class WatchInboxStore {
    private enum DeferredGatewayPayload: Codable {
        case notification(message: WatchNotifyMessage, transport: String)
        case execApprovalPrompt(message: WatchExecApprovalPromptMessage, transport: String)
        case execApprovalResolved(message: WatchExecApprovalResolvedMessage)
        case execApprovalExpired(message: WatchExecApprovalExpiredMessage)
        case execApprovalSnapshot(message: WatchExecApprovalSnapshotMessage, transport: String)

        var gatewayStableID: String? {
            switch self {
            case let .notification(message, _):
                message.gatewayStableID
            case let .execApprovalPrompt(message, _):
                message.approval.gatewayStableID
            case let .execApprovalResolved(message):
                message.gatewayStableID
            case let .execApprovalExpired(message):
                message.gatewayStableID
            case let .execApprovalSnapshot(message, _):
                if let gatewayStableID = WatchInboxStore.normalizedGatewayID(message.gatewayStableID) {
                    gatewayStableID
                } else {
                    WatchInboxStore.onlyGatewayStableID(in: message.approvals)
                }
            }
        }

        var sentAtMs: Int64? {
            switch self {
            case let .notification(message, _):
                message.sentAtMs
            case let .execApprovalPrompt(message, _):
                message.sentAtMs
            case let .execApprovalResolved(message):
                message.resolvedAtMs
            case let .execApprovalExpired(message):
                message.expiredAtMs
            case let .execApprovalSnapshot(message, _):
                message.sentAtMs
            }
        }

        var expiresAtMs: Int64? {
            switch self {
            case let .notification(message, _):
                message.expiresAtMs
            case let .execApprovalPrompt(message, _):
                message.approval.expiresAtMs
            case .execApprovalResolved, .execApprovalExpired, .execApprovalSnapshot:
                nil
            }
        }

        var approvalPrompt: WatchExecApprovalItem? {
            guard case let .execApprovalPrompt(message, _) = self else { return nil }
            return message.approval
        }

        var isFullyRepresentedByExecApprovalSnapshot: Bool {
            switch self {
            case .execApprovalResolved, .execApprovalExpired, .execApprovalSnapshot:
                true
            case .notification, .execApprovalPrompt:
                false
            }
        }
    }

    private struct PersistedState: Codable {
        var title: String
        var body: String
        var transport: String
        var updatedAt: Date
        var lastDeliveryKey: String?
        var promptId: String?
        var sessionKey: String?
        var gatewayStableID: String?
        var kind: String?
        var details: String?
        var expiresAtMs: Int64?
        var risk: String?
        var actions: [WatchPromptAction]?
        var replyStatusText: String?
        var replyStatusAt: Date?
        var execApprovals: [WatchExecApprovalRecord]
        var selectedExecApprovalID: String?
        var lastExecApprovalSnapshotID: String?
        var lastExecApprovalSnapshotGatewayStableID: String?
        var lastExecApprovalSnapshotSentAtMs: Int64?
        var lastExecApprovalOutcomeText: String?
        var lastExecApprovalOutcomeAt: Date?
        var appSnapshot: WatchAppSnapshotMessage?
        var appSnapshotUpdatedAt: Date?
        var appSnapshotStatusText: String?
        var appCommandStatusText: String?
        var deferredGatewayPayloads: [DeferredGatewayPayload]?
    }

    private static let persistedStateKey = "watch.inbox.state.v2"
    private static let maxDeferredGatewayPayloads = 32
    private static let defaultTitle = "OpenClaw"
    private static let defaultBody = "Waiting for messages from your iPhone."
    private let defaults: UserDefaults

    var title = WatchInboxStore.defaultTitle
    var body = WatchInboxStore.defaultBody
    var transport = "none"
    var updatedAt: Date?
    var promptId: String?
    var sessionKey: String?
    var gatewayStableID: String?
    var kind: String?
    var details: String?
    var expiresAtMs: Int64?
    var risk: String?
    var actions: [WatchPromptAction] = []
    var replyStatusText: String?
    var replyStatusAt: Date?
    var isReplySending = false
    var execApprovals: [WatchExecApprovalRecord] = []
    var selectedExecApprovalID: String?
    var lastExecApprovalOutcomeText: String?
    var lastExecApprovalOutcomeAt: Date?
    var appSnapshot: WatchAppSnapshotMessage?
    var appSnapshotUpdatedAt: Date?
    var appSnapshotStatusText: String?
    var appCommandStatusText: String?
    var chatCompletion: WatchChatCompletionMessage?
    var greetingTextOverride: String?
    var isExecApprovalReviewLoading = false
    var execApprovalReviewStatusText: String?
    var execApprovalReviewStatusAt: Date?
    private var lastExecApprovalSnapshotID: String?
    private var lastExecApprovalSnapshotGatewayStableID: String?
    private var lastExecApprovalSnapshotSentAtMs: Int64?
    private var hasCompletedExecApprovalSnapshotRefreshInSession = false
    private var lastDeliveryKey: String?
    /// WatchConnectivity does not order application-context updates against user-info
    /// transfers. Persist a bounded handoff queue so a new route's alert is not lost
    /// before its owner snapshot arrives.
    private var deferredGatewayPayloads: [DeferredGatewayPayload] = []

    init(
        defaults: UserDefaults = .standard,
        requestNotificationAuthorization: Bool = true)
    {
        self.defaults = defaults
        self.restorePersistedState()
        self.pruneExpiredExecApprovals(nowMs: Self.nowMs())
        if requestNotificationAuthorization {
            Task {
                await self.ensureNotificationAuthorization()
            }
        }
    }

    var sortedExecApprovals: [WatchExecApprovalRecord] {
        self.execApprovals.sorted { lhs, rhs in
            let lhsExpires = lhs.approval.expiresAtMs ?? Int64.max
            let rhsExpires = rhs.approval.expiresAtMs ?? Int64.max
            if lhsExpires != rhsExpires {
                return lhsExpires < rhsExpires
            }
            return lhs.updatedAt > rhs.updatedAt
        }
    }

    var activeExecApproval: WatchExecApprovalRecord? {
        if let selectedExecApprovalID,
           let selected = execApprovals.first(where: { $0.id == selectedExecApprovalID })
        {
            return selected
        }
        return self.sortedExecApprovals.first
    }

    var shouldAutoRequestExecApprovalSnapshot: Bool {
        self.execApprovals.isEmpty
            && self.actions.isEmpty
            && self.title == Self.defaultTitle
            && self.body == Self.defaultBody
            && !self.hasCompletedExecApprovalSnapshotRefreshInSession
    }

    var hasCompletedExecApprovalSnapshotRefresh: Bool {
        self.hasCompletedExecApprovalSnapshotRefreshInSession
    }

    var shouldShowExecApprovalReviewStatus: Bool {
        self.execApprovals.isEmpty && !(self.execApprovalReviewStatusText?.isEmpty ?? true)
    }

    var hasAppSnapshot: Bool {
        self.appSnapshot != nil
    }

    var hasMessagePrompt: Bool {
        self.title != Self.defaultTitle
            || self.body != Self.defaultBody
            || !self.actions.isEmpty
    }

    var gatewaySummaryText: String {
        guard let appSnapshot else { return "Waiting for iPhone" }
        return appSnapshot.gatewayConnected ? "Connected" : appSnapshot.gatewayStatusText
    }

    var talkSummaryText: String {
        guard let appSnapshot else { return "Not synced" }
        if appSnapshot.talkListening {
            return "Listening"
        }
        if appSnapshot.talkSpeaking {
            return "Speaking"
        }
        if appSnapshot.talkEnabled {
            return appSnapshot.talkStatusText.isEmpty ? "Ready" : appSnapshot.talkStatusText
        }
        return "Off"
    }

    func beginExecApprovalReviewLoading() {
        guard self.execApprovals.isEmpty else {
            self.markExecApprovalReviewLoaded()
            return
        }
        self.isExecApprovalReviewLoading = true
        self.execApprovalReviewStatusText = "Loading approval from iPhone…"
        self.execApprovalReviewStatusAt = Date()
    }

    func markExecApprovalReviewLoaded() {
        self.isExecApprovalReviewLoading = false
        self.execApprovalReviewStatusText = nil
        self.execApprovalReviewStatusAt = nil
    }

    func markExecApprovalReviewUnavailable(_ message: String) {
        guard self.execApprovals.isEmpty else {
            self.markExecApprovalReviewLoaded()
            return
        }
        self.isExecApprovalReviewLoading = false
        self.execApprovalReviewStatusText = message
        self.execApprovalReviewStatusAt = Date()
    }

    func consume(message: WatchNotifyMessage, transport: String) {
        guard self.routeGatewayPayload(.notification(message: message, transport: transport)) else { return }
        let messageID = message.id?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let deliveryKey = self.deliveryKey(
            messageID: messageID,
            title: message.title,
            body: message.body,
            sentAtMs: message.sentAtMs)
        guard deliveryKey != self.lastDeliveryKey else { return }

        let normalizedTitle = message.title.isEmpty ? "OpenClaw" : message.title
        self.title = normalizedTitle
        self.body = message.body
        self.transport = transport
        self.markExecApprovalReviewLoaded()
        self.updatedAt = Date()
        self.promptId = message.promptId
        self.sessionKey = message.sessionKey
        self.gatewayStableID = message.gatewayStableID
        self.kind = message.kind
        self.details = message.details
        self.expiresAtMs = message.expiresAtMs
        self.risk = message.risk
        self.actions = message.actions
        self.lastDeliveryKey = deliveryKey
        self.replyStatusText = nil
        self.replyStatusAt = nil
        self.isReplySending = false
        self.persistState()

        Task {
            await self.postLocalNotification(
                identifier: deliveryKey,
                title: normalizedTitle,
                body: message.body,
                risk: message.risk,
                stillCurrent: { self.lastDeliveryKey == deliveryKey })
        }
    }

    func consume(
        execApprovalPrompt message: WatchExecApprovalPromptMessage,
        transport: String)
    {
        guard self.routeGatewayPayload(.execApprovalPrompt(message: message, transport: transport)) else { return }
        self.pruneExpiredExecApprovals(nowMs: Self.nowMs())
        self.upsertExecApproval(
            message.approval,
            transport: transport,
            keepSelectionIfPossible: true,
            resetResolvingState: message.resetResolvingState == true)
        let approvalID = message.approval.id
        let approvalGatewayID = message.approval.gatewayStableID
        guard let notificationIdentifier = Self.execApprovalNotificationIdentifier(for: message.approval) else {
            return
        }
        self.markExecApprovalReviewLoaded()
        self.lastExecApprovalOutcomeText = nil
        self.lastExecApprovalOutcomeAt = nil

        Task {
            await self.postLocalNotification(
                identifier: notificationIdentifier,
                title: "Exec approval required",
                body: message.approval.commandPreview ?? message.approval.commandText,
                risk: message.approval.risk?.rawValue,
                stillCurrent: {
                    self.execApprovals.contains { record in
                        record.id == approvalID && record.approval.gatewayStableID == approvalGatewayID
                    }
                })
        }
    }

    func consume(
        execApprovalSnapshot message: WatchExecApprovalSnapshotMessage,
        transport: String)
    {
        let deferredPayload = DeferredGatewayPayload.execApprovalSnapshot(
            message: message,
            transport: transport)
        if deferredPayload.gatewayStableID != nil {
            guard self.routeGatewayPayload(deferredPayload) else { return }
        }
        let snapshotGatewayID = Self.normalizedGatewayID(deferredPayload.gatewayStableID)
        let previousSnapshotGatewayID = Self.normalizedGatewayID(
            self.lastExecApprovalSnapshotGatewayStableID)
        let hasSameSnapshotOwner = snapshotGatewayID == previousSnapshotGatewayID
        let snapshotID = message.snapshotId?.trimmingCharacters(in: .whitespacesAndNewlines)
        if hasSameSnapshotOwner,
           let snapshotID,
           !snapshotID.isEmpty,
           snapshotID == lastExecApprovalSnapshotID
        {
            return
        }
        if hasSameSnapshotOwner,
           let sentAtMs = message.sentAtMs,
           let lastSentAtMs = lastExecApprovalSnapshotSentAtMs,
           sentAtMs < lastSentAtMs
        {
            return
        }

        let existingRecords = self.execApprovals
        let existingRecordsByID = Dictionary(
            uniqueKeysWithValues: existingRecords.map { ($0.id, $0) })
        self.execApprovals = message.approvals.filter { approval in
            self.acceptsGatewayOwner(approval.gatewayStableID)
        }.map { approval in
            self.mergedExecApprovalRecord(
                approval: approval,
                transport: transport,
                existingRecord: existingRecordsByID[approval.id])
        }
        if hasSameSnapshotOwner {
            if let snapshotID, !snapshotID.isEmpty {
                self.lastExecApprovalSnapshotID = snapshotID
            }
            if let sentAtMs = message.sentAtMs {
                self.lastExecApprovalSnapshotSentAtMs = sentAtMs
            }
        } else {
            self.lastExecApprovalSnapshotID = snapshotID
            self.lastExecApprovalSnapshotSentAtMs = message.sentAtMs
        }
        self.lastExecApprovalSnapshotGatewayStableID = snapshotGatewayID
        self.hasCompletedExecApprovalSnapshotRefreshInSession = true
        if let selectedExecApprovalID,
           !self.execApprovals.contains(where: { $0.id == selectedExecApprovalID })
        {
            self.selectedExecApprovalID = self.sortedExecApprovals.first?.id
        } else if selectedExecApprovalID == nil {
            selectedExecApprovalID = self.sortedExecApprovals.first?.id
        }
        self.pruneExpiredExecApprovals(nowMs: Self.nowMs())
        let currentNotificationIdentifiers = Set(execApprovals.compactMap { record in
            Self.execApprovalNotificationIdentifier(for: record.approval)
        })
        let removedApprovals = existingRecords.map(\.approval).filter { approval in
            guard let identifier = Self.execApprovalNotificationIdentifier(for: approval) else { return false }
            return !currentNotificationIdentifiers.contains(identifier)
        }
        self.removeExecApprovalNotifications(approvals: removedApprovals)
        self.markExecApprovalReviewLoaded()
        self.persistState()
    }

    func consume(appSnapshot message: WatchAppSnapshotMessage) {
        let snapshotID = message.snapshotId?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let snapshotID, !snapshotID.isEmpty, snapshotID == appSnapshot?.snapshotId {
            return
        }
        if let sentAtMs = message.sentAtMs,
           let currentSentAtMs = appSnapshot?.sentAtMs,
           sentAtMs < currentSentAtMs
        {
            return
        }
        let hasExistingAppSnapshot = self.appSnapshot != nil
        let previousGatewayID = Self.normalizedGatewayID(self.appSnapshot?.gatewayStableID)
        let nextGatewayID = Self.normalizedGatewayID(message.gatewayStableID)
        var merged = message
        if hasExistingAppSnapshot, previousGatewayID == nextGatewayID {
            if merged.chatItems == nil {
                merged.chatItems = self.appSnapshot?.chatItems
            }
            if merged.chatStatusText == nil {
                merged.chatStatusText = self.appSnapshot?.chatStatusText
            }
        }
        self.appSnapshot = merged
        self.appSnapshotUpdatedAt = Date()
        self.appSnapshotStatusText = nil
        if !hasExistingAppSnapshot || previousGatewayID != nextGatewayID {
            if Self.normalizedGatewayID(self.gatewayStableID) != nextGatewayID {
                self.clearMessagePrompt()
            }
            let invalidatedApprovals = self.execApprovals.compactMap { record -> WatchExecApprovalItem? in
                guard let nextGatewayID else { return record.approval }
                return Self.normalizedGatewayID(record.approval.gatewayStableID) == nextGatewayID
                    ? nil
                    : record.approval
            }
            self.execApprovals.removeAll { record in
                guard let nextGatewayID else { return true }
                return Self.normalizedGatewayID(record.approval.gatewayStableID) != nextGatewayID
            }
            self.removeExecApprovalNotifications(approvals: invalidatedApprovals)
            if let selectedExecApprovalID,
               !self.execApprovals.contains(where: { $0.id == selectedExecApprovalID })
            {
                self.selectedExecApprovalID = self.sortedExecApprovals.first?.id
            }
        }
        self.persistState()
    }

    func consume(chatCompletion message: WatchChatCompletionMessage) {
        self.chatCompletion = message
    }

    func markAppSnapshotRequestStarted() {
        self.appSnapshotStatusText = "Refreshing from iPhone…"
        self.persistState()
    }

    func markAppSnapshotRequestResult(_ result: WatchReplySendResult) {
        if let errorMessage = result.errorMessage, !errorMessage.isEmpty {
            self.appSnapshotStatusText = "Refresh failed: \(errorMessage)"
        } else if result.deliveredImmediately {
            self.appSnapshotStatusText = "Refresh requested"
        } else if result.queuedForDelivery {
            self.appSnapshotStatusText = "Refresh queued"
        } else {
            self.appSnapshotStatusText = nil
        }
        self.persistState()
    }

    func makeAppCommand(_ command: WatchAppCommand, text: String? = nil) -> WatchAppCommandMessage {
        let snapshotSessionKey = self.appSnapshot?.sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        return WatchAppCommandMessage(
            command: command,
            commandId: UUID().uuidString,
            sessionKey: (snapshotSessionKey?.isEmpty == false) ? snapshotSessionKey : self.sessionKey,
            gatewayStableID: self.appSnapshot?.gatewayStableID,
            text: text,
            sentAtMs: Self.nowMs())
    }

    var hasGatewayTaggedAppSnapshot: Bool {
        let gatewayStableID = self.appSnapshot?.gatewayStableID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return !gatewayStableID.isEmpty
    }

    func markAppCommandSending(_ command: WatchAppCommand) {
        self.appCommandStatusText = "Sending \(Self.commandLabel(command))…"
        self.persistState()
    }

    func markAppCommandBlocked(_ command: WatchAppCommand, reason: String) {
        self.appCommandStatusText = "\(Self.commandLabel(command)): \(reason)"
        self.persistState()
    }

    func markAppCommandResult(_ result: WatchReplySendResult, command: WatchAppCommand) {
        let label = Self.commandLabel(command)
        if let errorMessage = result.errorMessage, !errorMessage.isEmpty {
            self.appCommandStatusText = "\(label) failed: \(errorMessage)"
        } else if result.deliveredImmediately {
            self.appCommandStatusText = "\(label): sent"
        } else if result.queuedForDelivery {
            self.appCommandStatusText = "\(label): queued"
        } else {
            self.appCommandStatusText = "\(label): sent"
        }
        self.persistState()
    }

    func consume(execApprovalResolved message: WatchExecApprovalResolvedMessage) {
        guard self.routeGatewayPayload(.execApprovalResolved(message: message)) else { return }
        self.removeExecApproval(id: message.approvalId, gatewayStableID: message.gatewayStableID)
        let statusText = switch message.decision {
        case .allowOnce:
            "Allowed once"
        case .deny:
            "Denied"
        case nil:
            "Approval resolved"
        }
        self.lastExecApprovalOutcomeText = statusText
        self.lastExecApprovalOutcomeAt = Date()
        self.persistState()
    }

    func consume(execApprovalExpired message: WatchExecApprovalExpiredMessage) {
        guard self.routeGatewayPayload(.execApprovalExpired(message: message)) else { return }
        self.removeExecApproval(id: message.approvalId, gatewayStableID: message.gatewayStableID)
        let statusText = switch message.reason {
        case .expired:
            "Approval expired"
        case .notFound:
            "Approval no longer available"
        case .resolved:
            "Approval resolved elsewhere"
        case .replaced:
            "Approval replaced"
        case .unavailable:
            "Approval unavailable"
        }
        self.lastExecApprovalOutcomeText = statusText
        self.lastExecApprovalOutcomeAt = Date()
        self.persistState()
    }

    func selectExecApproval(id: String) {
        let normalizedID = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedID.isEmpty else { return }
        guard self.execApprovals.contains(where: { $0.id == normalizedID }) else { return }
        self.selectedExecApprovalID = normalizedID
        self.persistState()
    }

    func markExecApprovalSending(approvalId: String, decision: WatchExecApprovalDecision) {
        guard let index = execApprovals.firstIndex(where: { $0.id == approvalId }) else { return }
        self.execApprovals[index].isResolving = true
        self.execApprovals[index].pendingDecision = decision
        self.execApprovals[index].statusText = "Sending \(Self.decisionLabel(decision))…"
        self.execApprovals[index].statusAt = Date()
        self.persistState()
    }

    func markExecApprovalSendResult(
        approvalId: String,
        decision: WatchExecApprovalDecision,
        result: WatchReplySendResult)
    {
        guard let index = execApprovals.firstIndex(where: { $0.id == approvalId }) else { return }
        if let errorMessage = result.errorMessage, !errorMessage.isEmpty {
            self.execApprovals[index].isResolving = false
            self.execApprovals[index].statusText = "Failed: \(errorMessage)"
        } else if result.deliveredImmediately {
            self.execApprovals[index].isResolving = true
            self.execApprovals[index].statusText = "\(Self.decisionLabel(decision)): sent"
        } else if result.queuedForDelivery {
            self.execApprovals[index].isResolving = true
            self.execApprovals[index].statusText = "\(Self.decisionLabel(decision)): queued"
        } else {
            self.execApprovals[index].isResolving = true
            self.execApprovals[index].statusText = "\(Self.decisionLabel(decision)): sent"
        }
        self.execApprovals[index].pendingDecision = result.errorMessage == nil ? decision : nil
        self.execApprovals[index].statusAt = Date()
        self.persistState()
    }

    private func upsertExecApproval(
        _ approval: WatchExecApprovalItem,
        transport: String,
        keepSelectionIfPossible: Bool,
        resetResolvingState: Bool = false)
    {
        if let index = execApprovals.firstIndex(where: { $0.id == approval.id }) {
            self.execApprovals[index] = self.mergedExecApprovalRecord(
                approval: approval,
                transport: transport,
                existingRecord: self.execApprovals[index],
                resetResolvingState: resetResolvingState)
        } else {
            self.execApprovals.append(
                self.mergedExecApprovalRecord(
                    approval: approval,
                    transport: transport,
                    existingRecord: nil,
                    resetResolvingState: resetResolvingState))
        }
        if !keepSelectionIfPossible || self.selectedExecApprovalID == nil {
            self.selectedExecApprovalID = approval.id
        }
        self.persistState()
    }

    private func mergedExecApprovalRecord(
        approval: WatchExecApprovalItem,
        transport: String,
        existingRecord: WatchExecApprovalRecord?,
        resetResolvingState: Bool = false) -> WatchExecApprovalRecord
    {
        // Preserve in-flight state across ordinary snapshot/prompt refreshes so duplicate
        // submissions stay disabled, but clear it when the iPhone explicitly republishes a
        // prompt after a failed resolve so the watch can retry.
        let isResolving = resetResolvingState ? false : (existingRecord?.isResolving ?? false)
        let pendingDecision = resetResolvingState ? nil : existingRecord?.pendingDecision
        let statusText = resetResolvingState ? nil : existingRecord?.statusText
        let statusAt = resetResolvingState ? nil : existingRecord?.statusAt
        return WatchExecApprovalRecord(
            approval: approval,
            transport: transport,
            updatedAt: Date(),
            isResolving: isResolving,
            pendingDecision: pendingDecision,
            statusText: statusText,
            statusAt: statusAt)
    }

    private func removeExecApproval(id: String, gatewayStableID: String?) {
        let normalizedID = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedID.isEmpty else { return }
        let normalizedGatewayID = gatewayStableID?.trimmingCharacters(in: .whitespacesAndNewlines)
        let removedApprovals = self.execApprovals.compactMap { record -> WatchExecApprovalItem? in
            guard record.id == normalizedID else { return nil }
            // Legacy ownerless lifecycle messages may only close legacy ownerless prompts.
            return record.approval.gatewayStableID == normalizedGatewayID ? record.approval : nil
        }
        self.execApprovals.removeAll { record in
            guard record.id == normalizedID else { return false }
            // Legacy ownerless lifecycle messages may only close legacy ownerless prompts.
            return record.approval.gatewayStableID == normalizedGatewayID
        }
        self.removeExecApprovalNotifications(approvals: removedApprovals)
        if self.selectedExecApprovalID == normalizedID {
            self.selectedExecApprovalID = self.sortedExecApprovals.first?.id
        }
        self.persistState()
    }

    private func routeGatewayPayload(_ payload: DeferredGatewayPayload) -> Bool {
        guard let incomingGatewayID = Self.normalizedGatewayID(payload.gatewayStableID) else {
            return false
        }
        guard let activeSnapshot = appSnapshot else { return true }
        let activeGatewayID = Self.normalizedGatewayID(activeSnapshot.gatewayStableID)
        guard incomingGatewayID != activeGatewayID else { return true }
        if let payloadSentAtMs = payload.sentAtMs,
           let snapshotSentAtMs = activeSnapshot.sentAtMs,
           payloadSentAtMs <= snapshotSentAtMs
        {
            return false
        }
        if WatchDeferredPayloadOrdering.isExpired(
            expiresAtMs: payload.expiresAtMs,
            nowMs: Self.nowMs())
        {
            return false
        }

        self.deferredGatewayPayloads.append(payload)
        if self.deferredGatewayPayloads.count > Self.maxDeferredGatewayPayloads {
            self.deferredGatewayPayloads.removeFirst(
                self.deferredGatewayPayloads.count - Self.maxDeferredGatewayPayloads)
        }
        self.persistState()
        return false
    }

    private func acceptsGatewayOwner(_ gatewayStableID: String?) -> Bool {
        guard let incomingGatewayID = Self.normalizedGatewayID(gatewayStableID) else { return false }
        guard let activeSnapshot = appSnapshot else { return true }
        guard let activeGatewayID = Self.normalizedGatewayID(activeSnapshot.gatewayStableID) else { return false }
        return incomingGatewayID == activeGatewayID
    }

    func replayDeferredGatewayPayloads() {
        guard let activeGatewayID = Self.normalizedGatewayID(appSnapshot?.gatewayStableID) else {
            let snapshotSentAtMs = self.appSnapshot?.sentAtMs
            let nowMs = Self.nowMs()
            self.deferredGatewayPayloads.removeAll { payload in
                WatchDeferredPayloadOrdering.isExpired(
                    expiresAtMs: payload.expiresAtMs,
                    nowMs: nowMs)
                    || !WatchDeferredPayloadOrdering.isNewerThanSnapshot(
                        payloadSentAtMs: payload.sentAtMs,
                        snapshotSentAtMs: snapshotSentAtMs)
            }
            self.persistState()
            return
        }

        let snapshotSentAtMs = self.appSnapshot?.sentAtMs
        let approvalSnapshotGatewayID = Self.normalizedGatewayID(
            self.lastExecApprovalSnapshotGatewayStableID)
        let nowMs = Self.nowMs()
        var ready: [DeferredGatewayPayload] = []
        var future: [DeferredGatewayPayload] = []
        for payload in self.deferredGatewayPayloads {
            if WatchDeferredPayloadOrdering.isExpired(
                expiresAtMs: payload.expiresAtMs,
                nowMs: nowMs)
            {
                continue
            }
            if Self.normalizedGatewayID(payload.gatewayStableID) == activeGatewayID {
                let isPreexistingApprovalPayload = approvalSnapshotGatewayID == activeGatewayID
                    && WatchDeferredPayloadOrdering.isAtOrBeforeSnapshot(
                        payloadSentAtMs: payload.sentAtMs,
                        snapshotSentAtMs: self.lastExecApprovalSnapshotSentAtMs)
                if isPreexistingApprovalPayload,
                   payload.isFullyRepresentedByExecApprovalSnapshot
                {
                    continue
                }
                if isPreexistingApprovalPayload,
                   let approval = payload.approvalPrompt,
                   !self.execApprovals.contains(where: { record in
                       record.id == approval.id
                           && Self.normalizedGatewayID(record.approval.gatewayStableID) == activeGatewayID
                   })
                {
                    continue
                }
                ready.append(payload)
            } else if let payloadSentAtMs = payload.sentAtMs,
                      let snapshotSentAtMs,
                      payloadSentAtMs > snapshotSentAtMs
            {
                future.append(payload)
            }
        }
        self.deferredGatewayPayloads = future
        self.persistState()

        let replayOrder = WatchDeferredPayloadOrdering.indicesOldestFirst(
            for: ready.map(\.sentAtMs))
        for index in replayOrder {
            let payload = ready[index]
            switch payload {
            case let .notification(message, transport):
                self.consume(message: message, transport: transport)
            case let .execApprovalPrompt(message, transport):
                self.consume(execApprovalPrompt: message, transport: transport)
            case let .execApprovalResolved(message):
                self.consume(execApprovalResolved: message)
            case let .execApprovalExpired(message):
                self.consume(execApprovalExpired: message)
            case let .execApprovalSnapshot(message, transport):
                self.consume(execApprovalSnapshot: message, transport: transport)
            }
        }
    }
}

// MARK: - State persistence and notifications

extension WatchInboxStore {
    private func clearMessagePrompt() {
        let notificationIdentifier = self.lastDeliveryKey
        self.title = Self.defaultTitle
        self.body = Self.defaultBody
        self.transport = "none"
        self.updatedAt = nil
        self.lastDeliveryKey = nil
        self.promptId = nil
        self.sessionKey = nil
        self.gatewayStableID = nil
        self.kind = nil
        self.details = nil
        self.expiresAtMs = nil
        self.risk = nil
        self.actions = []
        self.replyStatusText = nil
        self.replyStatusAt = nil
        self.isReplySending = false

        guard let notificationIdentifier else { return }
        self.removeLocalNotifications(identifiers: [notificationIdentifier])
    }

    private func removeExecApprovalNotifications(approvals: [WatchExecApprovalItem]) {
        self.removeLocalNotifications(identifiers: approvals.compactMap { approval in
            Self.execApprovalNotificationIdentifier(for: approval)
        })
    }

    private func removeLocalNotifications(identifiers: [String]) {
        guard !identifiers.isEmpty else { return }
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: identifiers)
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }

    private nonisolated static func normalizedGatewayID(_ gatewayStableID: String?) -> String? {
        let normalized = gatewayStableID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return normalized.isEmpty ? nil : normalized
    }

    private nonisolated static func onlyGatewayStableID(in approvals: [WatchExecApprovalItem]) -> String? {
        let gatewayIDs = Set(approvals.compactMap { self.normalizedGatewayID($0.gatewayStableID) })
        return gatewayIDs.count == 1 ? gatewayIDs.first : nil
    }

    private static func execApprovalNotificationIdentifier(for approval: WatchExecApprovalItem) -> String? {
        guard let gatewayStableID = normalizedGatewayID(approval.gatewayStableID) else { return nil }
        let approvalID = approval.id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !approvalID.isEmpty else { return nil }
        return "watch.execApproval.\(gatewayStableID.utf8.count):\(gatewayStableID)\(approvalID)"
    }

    private func pruneExpiredExecApprovals(nowMs: Int64) {
        let expiredApprovals = self.execApprovals.compactMap { record -> WatchExecApprovalItem? in
            guard let expiresAtMs = record.approval.expiresAtMs, expiresAtMs <= nowMs else { return nil }
            return record.approval
        }
        self.execApprovals.removeAll { record in
            guard let expiresAtMs = record.approval.expiresAtMs else { return false }
            return expiresAtMs <= nowMs
        }
        self.removeExecApprovalNotifications(approvals: expiredApprovals)
        if let selectedExecApprovalID,
           !self.execApprovals.contains(where: { $0.id == selectedExecApprovalID })
        {
            self.selectedExecApprovalID = self.sortedExecApprovals.first?.id
        }
        self.persistState()
    }

    private func restorePersistedState() {
        guard let data = defaults.data(forKey: Self.persistedStateKey),
              let state = try? JSONDecoder().decode(PersistedState.self, from: data)
        else {
            return
        }

        self.title = state.title
        self.body = state.body
        self.transport = state.transport
        self.updatedAt = state.updatedAt
        self.lastDeliveryKey = state.lastDeliveryKey
        self.promptId = state.promptId
        self.sessionKey = state.sessionKey
        self.gatewayStableID = state.gatewayStableID
        self.kind = state.kind
        self.details = state.details
        self.expiresAtMs = state.expiresAtMs
        self.risk = state.risk
        self.actions = state.actions ?? []
        self.replyStatusText = state.replyStatusText
        self.replyStatusAt = state.replyStatusAt
        let ownerlessApprovals = state.execApprovals.filter { record in
            Self.normalizedGatewayID(record.approval.gatewayStableID) == nil
        }
        let taggedApprovals = state.execApprovals.filter { record in
            Self.normalizedGatewayID(record.approval.gatewayStableID) != nil
        }
        let activeGatewayID = state.appSnapshot.flatMap { snapshot in
            Self.normalizedGatewayID(snapshot.gatewayStableID)
        }
        let invalidatedApprovals: [WatchExecApprovalRecord]
        if state.appSnapshot != nil {
            self.execApprovals = taggedApprovals.filter { record in
                Self.normalizedGatewayID(record.approval.gatewayStableID) == activeGatewayID
            }
            invalidatedApprovals = taggedApprovals.filter { record in
                Self.normalizedGatewayID(record.approval.gatewayStableID) != activeGatewayID
            }
        } else {
            self.execApprovals = taggedApprovals
            invalidatedApprovals = []
        }
        selectedExecApprovalID = state.selectedExecApprovalID
        self.lastExecApprovalSnapshotID = state.lastExecApprovalSnapshotID
        self.lastExecApprovalSnapshotGatewayStableID = state.lastExecApprovalSnapshotGatewayStableID
        self.lastExecApprovalSnapshotSentAtMs = state.lastExecApprovalSnapshotSentAtMs
        self.lastExecApprovalOutcomeText = state.lastExecApprovalOutcomeText
        self.lastExecApprovalOutcomeAt = state.lastExecApprovalOutcomeAt
        self.appSnapshot = state.appSnapshot
        self.appSnapshotUpdatedAt = state.appSnapshotUpdatedAt
        self.appSnapshotStatusText = state.appSnapshotStatusText
        self.appCommandStatusText = state.appCommandStatusText
        self.deferredGatewayPayloads = Array(
            (state.deferredGatewayPayloads ?? []).suffix(Self.maxDeferredGatewayPayloads))

        if state.appSnapshot != nil,
           Self.normalizedGatewayID(self.lastExecApprovalSnapshotGatewayStableID) != activeGatewayID
        {
            self.lastExecApprovalSnapshotID = nil
            self.lastExecApprovalSnapshotGatewayStableID = nil
            self.lastExecApprovalSnapshotSentAtMs = nil
        }
        if let selectedExecApprovalID,
           !self.execApprovals.contains(where: { $0.id == selectedExecApprovalID })
        {
            self.selectedExecApprovalID = self.sortedExecApprovals.first?.id
        }
        self.removeExecApprovalNotifications(approvals: invalidatedApprovals.map(\.approval))

        guard !ownerlessApprovals.isEmpty else { return }
        // Older Watch state has no gateway owner and cannot be resolved safely after
        // gateway switches. Drop it, clear its old alert keys, and force a fresh snapshot.
        self.lastExecApprovalSnapshotID = nil
        self.lastExecApprovalSnapshotGatewayStableID = nil
        self.lastExecApprovalSnapshotSentAtMs = nil
        self.removeLocalNotifications(identifiers: ownerlessApprovals.compactMap { record in
            let approvalID = record.id.trimmingCharacters(in: .whitespacesAndNewlines)
            return approvalID.isEmpty ? nil : "watch.execApproval.\(approvalID)"
        })
    }

    private func persistState() {
        let updatedAt = self.updatedAt ?? self.lastExecApprovalOutcomeAt ?? Date()
        let state = PersistedState(
            title: title,
            body: body,
            transport: transport,
            updatedAt: updatedAt,
            lastDeliveryKey: lastDeliveryKey,
            promptId: promptId,
            sessionKey: sessionKey,
            gatewayStableID: gatewayStableID,
            kind: kind,
            details: details,
            expiresAtMs: expiresAtMs,
            risk: risk,
            actions: actions,
            replyStatusText: replyStatusText,
            replyStatusAt: replyStatusAt,
            execApprovals: execApprovals,
            selectedExecApprovalID: selectedExecApprovalID,
            lastExecApprovalSnapshotID: lastExecApprovalSnapshotID,
            lastExecApprovalSnapshotGatewayStableID: lastExecApprovalSnapshotGatewayStableID,
            lastExecApprovalSnapshotSentAtMs: lastExecApprovalSnapshotSentAtMs,
            lastExecApprovalOutcomeText: lastExecApprovalOutcomeText,
            lastExecApprovalOutcomeAt: lastExecApprovalOutcomeAt,
            appSnapshot: appSnapshot,
            appSnapshotUpdatedAt: appSnapshotUpdatedAt,
            appSnapshotStatusText: appSnapshotStatusText,
            appCommandStatusText: appCommandStatusText,
            deferredGatewayPayloads: deferredGatewayPayloads)
        guard let data = try? JSONEncoder().encode(state) else { return }
        self.defaults.set(data, forKey: Self.persistedStateKey)
    }

    private func deliveryKey(messageID: String?, title: String, body: String, sentAtMs: Int64?) -> String {
        if let messageID, messageID.isEmpty == false {
            return "id:\(messageID)"
        }
        return "content:\(title)|\(body)|\(sentAtMs ?? 0)"
    }

    private func ensureNotificationAuthorization() async {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .notDetermined:
            _ = try? await center.requestAuthorization(options: [.alert, .sound])
        default:
            break
        }
    }

    private func mapHapticRisk(_ risk: String?) -> WKHapticType {
        switch risk?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "high":
            .failure
        case "medium":
            .notification
        default:
            .click
        }
    }

    func makeReplyDraft(action: WatchPromptAction) -> WatchReplyDraft {
        let prompt = self.promptId?.trimmingCharacters(in: .whitespacesAndNewlines)
        return WatchReplyDraft(
            replyId: UUID().uuidString,
            promptId: (prompt?.isEmpty == false) ? prompt! : "unknown",
            actionId: action.id,
            actionLabel: action.label,
            sessionKey: self.sessionKey,
            gatewayStableID: self.gatewayStableID,
            note: nil,
            sentAtMs: Self.nowMs())
    }

    func markReplySending(actionLabel: String) {
        self.isReplySending = true
        self.replyStatusText = "Sending \(actionLabel)…"
        self.replyStatusAt = Date()
        self.persistState()
    }

    func markReplyResult(_ result: WatchReplySendResult, actionLabel: String) {
        self.isReplySending = false
        if let errorMessage = result.errorMessage, !errorMessage.isEmpty {
            self.replyStatusText = "Failed: \(errorMessage)"
        } else if result.deliveredImmediately {
            self.replyStatusText = "\(actionLabel): sent"
        } else if result.queuedForDelivery {
            self.replyStatusText = "\(actionLabel): queued"
        } else {
            self.replyStatusText = "\(actionLabel): sent"
        }
        self.replyStatusAt = Date()
        self.persistState()
    }

    private func postLocalNotification(
        identifier: String,
        title: String,
        body: String,
        risk: String?,
        stillCurrent: @MainActor @Sendable () -> Bool = { true }) async
    {
        guard stillCurrent() else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.threadIdentifier = "openclaw-watch"

        let request = UNNotificationRequest(
            identifier: identifier,
            content: content,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: 0.2, repeats: false))

        let center = UNUserNotificationCenter.current()
        _ = try? await center.add(request)
        guard stillCurrent() else {
            self.removeLocalNotifications(identifiers: [identifier])
            return
        }
        WKInterfaceDevice.current().play(self.mapHapticRisk(risk))
    }

    private static func decisionLabel(_ decision: WatchExecApprovalDecision) -> String {
        switch decision {
        case .allowOnce:
            "Allow Once"
        case .deny:
            "Deny"
        }
    }

    private static func commandLabel(_ command: WatchAppCommand) -> String {
        switch command {
        case .refresh:
            "Refresh"
        case .openChat:
            "Open Chat"
        case .sendChat:
            "Chat"
        case .startTalk:
            "Start Talk"
        case .stopTalk:
            "Stop Talk"
        }
    }

    private static func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }
}
