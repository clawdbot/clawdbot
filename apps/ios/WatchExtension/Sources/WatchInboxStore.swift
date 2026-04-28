import Foundation
import Observation
import UserNotifications
import WatchKit

enum WatchPayloadType: String, Codable, Equatable {
    case notify = "watch.notify"
    case reply = "watch.reply"
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
    var commandText: String
    var commandPreview: String?
    var host: String?
    var nodeId: String?
    var agentId: String?
    var expiresAtMs: Int?
    var allowedDecisions: [WatchExecApprovalDecision]
    var risk: WatchRiskLevel?
}

struct WatchExecApprovalPromptMessage: Codable, Equatable {
    var approval: WatchExecApprovalItem
    var sentAtMs: Int?
    var deliveryId: String?
    var resetResolvingState: Bool?
}

struct WatchExecApprovalResolvedMessage: Codable, Equatable {
    var approvalId: String
    var decision: WatchExecApprovalDecision?
    var resolvedAtMs: Int?
    var source: String?
}

struct WatchExecApprovalExpiredMessage: Codable, Equatable {
    var approvalId: String
    var reason: WatchExecApprovalCloseReason
    var expiredAtMs: Int?
}

struct WatchExecApprovalSnapshotMessage: Codable, Equatable {
    var approvals: [WatchExecApprovalItem]
    var sentAtMs: Int?
    var snapshotId: String?
}

struct WatchExecApprovalSnapshotRequestMessage: Codable, Equatable {
    var requestId: String
    var sentAtMs: Int?
}

struct WatchExecApprovalResolveMessage: Codable, Equatable {
    var approvalId: String
    var decision: WatchExecApprovalDecision
    var replyId: String
    var sentAtMs: Int?
}

struct WatchPromptAction: Codable, Equatable, Identifiable {
    var id: String
    var label: String
    var style: String?
}

struct WatchNotifyMessage {
    var id: String?
    var title: String
    var body: String
    var sentAtMs: Int?
    var promptId: String?
    var sessionKey: String?
    var kind: String?
    var details: String?
    var expiresAtMs: Int?
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
    private struct PersistedState: Codable {
        var title: String
        var body: String
        var transport: String
        var updatedAt: Date
        var lastDeliveryKey: String?
        var promptId: String?
        var sessionKey: String?
        var kind: String?
        var details: String?
        var expiresAtMs: Int?
        var risk: String?
        var actions: [WatchPromptAction]?
        var replyStatusText: String?
        var replyStatusAt: Date?
        var execApprovals: [WatchExecApprovalRecord]
        var selectedExecApprovalID: String?
        var lastExecApprovalSnapshotID: String?
        var lastExecApprovalOutcomeText: String?
        var lastExecApprovalOutcomeAt: Date?
    }

    private static let persistedStateKey = "watch.inbox.state.v2"
    private static let defaultTitle = "OpenClaw"
    private static let defaultBody = "Waiting for messages from your iPhone."
    private let defaults: UserDefaults

    var title = WatchInboxStore.defaultTitle
    var body = WatchInboxStore.defaultBody
    var transport = "none"
    var updatedAt: Date?
    var promptId: String?
    var sessionKey: String?
    var kind: String?
    var details: String?
    var expiresAtMs: Int?
    var risk: String?
    var actions: [WatchPromptAction] = []
    var replyStatusText: String?
    var replyStatusAt: Date?
    var isReplySending = false
    var execApprovals: [WatchExecApprovalRecord] = []
    var selectedExecApprovalID: String?
    var lastExecApprovalOutcomeText: String?
    var lastExecApprovalOutcomeAt: Date?
    var isExecApprovalReviewLoading = false
    var execApprovalReviewStatusText: String?
    var execApprovalReviewStatusAt: Date?
    private var lastExecApprovalSnapshotID: String?
    private var hasCompletedExecApprovalSnapshotRefreshInSession = false
    private var lastDeliveryKey: String?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.restorePersistedState()
        self.pruneExpiredExecApprovals(nowMs: Self.nowMs())
        Task {
            await self.ensureNotificationAuthorization()
        }
    }

    var sortedExecApprovals: [WatchExecApprovalRecord] {
        self.execApprovals.sorted { lhs, rhs in
            let lhsExpires = lhs.approval.expiresAtMs ?? Int.max
            let rhsExpires = rhs.approval.expiresAtMs ?? Int.max
            if lhsExpires != rhsExpires {
                return lhsExpires < rhsExpires
            }
            return lhs.updatedAt > rhs.updatedAt
        }
    }

    var activeExecApproval: WatchExecApprovalRecord? {
        if let selectedExecApprovalID,
           let selected = self.execApprovals.first(where: { $0.id == selectedExecApprovalID })
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
                risk: message.risk)
        }
    }

    func consume(
        execApprovalPrompt message: WatchExecApprovalPromptMessage,
        transport: String)
    {
        self.pruneExpiredExecApprovals(nowMs: Self.nowMs())
        self.upsertExecApproval(
            message.approval,
            transport: transport,
            keepSelectionIfPossible: true,
            resetResolvingState: message.resetResolvingState == true)
        self.markExecApprovalReviewLoaded()
        self.lastExecApprovalOutcomeText = nil
        self.lastExecApprovalOutcomeAt = nil

        Task {
            await self.postLocalNotification(
                identifier: "watch.execApproval.\(message.approval.id)",
                title: "Exec approval required",
                body: message.approval.commandPreview ?? message.approval.commandText,
                risk: message.approval.risk?.rawValue)
        }
    }

    func consume(
        execApprovalSnapshot message: WatchExecApprovalSnapshotMessage,
        transport: String)
    {
        let snapshotID = message.snapshotId?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let snapshotID, !snapshotID.isEmpty, snapshotID == self.lastExecApprovalSnapshotID {
            return
        }

        let existingRecordsByID = Dictionary(
            uniqueKeysWithValues: self.execApprovals.map { ($0.id, $0) })
        self.execApprovals = message.approvals.map { approval in
            self.mergedExecApprovalRecord(
                approval: approval,
                transport: transport,
                existingRecord: existingRecordsByID[approval.id])
        }
        self.lastExecApprovalSnapshotID = snapshotID
        self.hasCompletedExecApprovalSnapshotRefreshInSession = true
        if let selectedExecApprovalID,
           !self.execApprovals.contains(where: { $0.id == selectedExecApprovalID })
        {
            self.selectedExecApprovalID = self.sortedExecApprovals.first?.id
        } else if self.selectedExecApprovalID == nil {
            self.selectedExecApprovalID = self.sortedExecApprovals.first?.id
        }
        self.pruneExpiredExecApprovals(nowMs: Self.nowMs())
        self.markExecApprovalReviewLoaded()
        self.persistState()
    }

    func consume(execApprovalResolved message: WatchExecApprovalResolvedMessage) {
        self.removeExecApproval(id: message.approvalId)
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
        self.removeExecApproval(id: message.approvalId)
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
        guard let index = self.execApprovals.firstIndex(where: { $0.id == approvalId }) else { return }
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
        guard let index = self.execApprovals.firstIndex(where: { $0.id == approvalId }) else { return }
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
        if let index = self.execApprovals.firstIndex(where: { $0.id == approval.id }) {
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

    private func removeExecApproval(id: String) {
        let normalizedID = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedID.isEmpty else { return }
        self.execApprovals.removeAll { $0.id == normalizedID }
        if self.selectedExecApprovalID == normalizedID {
            self.selectedExecApprovalID = self.sortedExecApprovals.first?.id
        }
        self.persistState()
    }

    private func pruneExpiredExecApprovals(nowMs: Int) {
        self.execApprovals.removeAll { record in
            guard let expiresAtMs = record.approval.expiresAtMs else { return false }
            return expiresAtMs <= nowMs
        }
        if let selectedExecApprovalID,
           !self.execApprovals.contains(where: { $0.id == selectedExecApprovalID })
        {
            self.selectedExecApprovalID = self.sortedExecApprovals.first?.id
        }
        self.persistState()
    }

    private func restorePersistedState() {
        guard let data = self.defaults.data(forKey: Self.persistedStateKey),
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
        self.kind = state.kind
        self.details = state.details
        self.expiresAtMs = state.expiresAtMs
        self.risk = state.risk
        self.actions = state.actions ?? []
        self.replyStatusText = state.replyStatusText
        self.replyStatusAt = state.replyStatusAt
        self.execApprovals = state.execApprovals
        self.selectedExecApprovalID = state.selectedExecApprovalID
        self.lastExecApprovalSnapshotID = state.lastExecApprovalSnapshotID
        self.lastExecApprovalOutcomeText = state.lastExecApprovalOutcomeText
        self.lastExecApprovalOutcomeAt = state.lastExecApprovalOutcomeAt
    }

    private func persistState() {
        let updatedAt = self.updatedAt ?? self.lastExecApprovalOutcomeAt ?? Date()
        let state = PersistedState(
            title: self.title,
            body: self.body,
            transport: self.transport,
            updatedAt: updatedAt,
            lastDeliveryKey: self.lastDeliveryKey,
            promptId: self.promptId,
            sessionKey: self.sessionKey,
            kind: self.kind,
            details: self.details,
            expiresAtMs: self.expiresAtMs,
            risk: self.risk,
            actions: self.actions,
            replyStatusText: self.replyStatusText,
            replyStatusAt: self.replyStatusAt,
            execApprovals: self.execApprovals,
            selectedExecApprovalID: self.selectedExecApprovalID,
            lastExecApprovalSnapshotID: self.lastExecApprovalSnapshotID,
            lastExecApprovalOutcomeText: self.lastExecApprovalOutcomeText,
            lastExecApprovalOutcomeAt: self.lastExecApprovalOutcomeAt)
        guard let data = try? JSONEncoder().encode(state) else { return }
        self.defaults.set(data, forKey: Self.persistedStateKey)
    }

    private func deliveryKey(messageID: String?, title: String, body: String, sentAtMs: Int?) -> String {
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

    private func postLocalNotification(identifier: String, title: String, body: String, risk: String?) async {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        content.threadIdentifier = "openclaw-watch"

        let request = UNNotificationRequest(
            identifier: identifier,
            content: content,
            trigger: UNTimeIntervalNotificationTrigger(timeInterval: 0.2, repeats: false))

        _ = try? await UNUserNotificationCenter.current().add(request)
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

    private static func nowMs() -> Int {
        Int(Date().timeIntervalSince1970 * 1000)
    }
}
