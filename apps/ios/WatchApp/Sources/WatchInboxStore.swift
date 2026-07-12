import Foundation
import Observation
import UserNotifications
import WatchKit

@MainActor @Observable final class WatchInboxStore {
    private typealias ExecApprovalOwnerKey = WatchExecApprovalIdentityKey

    private struct ExecApprovalTerminalTombstone: Codable, Equatable {
        var approvalId: String
        var gatewayStableID: String
        var outcome: WatchExecApprovalOutcome
        var outcomeIsAuthoritative: Bool?
        var recordedAt: Date

        private enum CodingKeys: String, CodingKey {
            case approvalId
            case gatewayStableID
            case outcome
            case outcomeText
            case outcomeIsAuthoritative
            case recordedAt
        }

        init(
            approvalId: String,
            gatewayStableID: String,
            outcome: WatchExecApprovalOutcome,
            outcomeIsAuthoritative: Bool?,
            recordedAt: Date)
        {
            self.approvalId = approvalId
            self.gatewayStableID = gatewayStableID
            self.outcome = outcome
            self.outcomeIsAuthoritative = outcomeIsAuthoritative
            self.recordedAt = recordedAt
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            self.approvalId = try container.decode(String.self, forKey: .approvalId)
            self.gatewayStableID = try container.decode(String.self, forKey: .gatewayStableID)
            self.outcome = try container.decodeIfPresent(
                WatchExecApprovalOutcome.self,
                forKey: .outcome) ?? Self.decodeLegacyOutcome(
                container.decodeIfPresent(String.self, forKey: .outcomeText))
            self.outcomeIsAuthoritative = try container.decodeIfPresent(
                Bool.self,
                forKey: .outcomeIsAuthoritative)
            self.recordedAt = try container.decode(Date.self, forKey: .recordedAt)
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(self.approvalId, forKey: .approvalId)
            try container.encode(self.gatewayStableID, forKey: .gatewayStableID)
            try container.encode(self.outcome, forKey: .outcome)
            try container.encodeIfPresent(
                self.outcomeIsAuthoritative,
                forKey: .outcomeIsAuthoritative)
            try container.encode(self.recordedAt, forKey: .recordedAt)
        }

        private static func decodeLegacyOutcome(_ text: String?) -> WatchExecApprovalOutcome {
            text.flatMap(WatchExecApprovalOutcome.decodeLegacyLocalizedText)
                ?? WatchExecApprovalOutcome(code: .unavailable)
        }
    }

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
        var replyStatus: WatchReplyStatus?
        var replyStatusText: String?
        var replyStatusAt: Date?
        var execApprovals: [WatchExecApprovalRecord]
        var selectedExecApprovalID: String?
        var selectedExecApprovalGatewayStableID: String?
        var lastExecApprovalSnapshotID: String?
        var lastExecApprovalSnapshotGatewayStableID: String?
        var lastExecApprovalSnapshotSentAtMs: Int64?
        var lastExecApprovalOutcome: WatchExecApprovalOutcome?
        var lastExecApprovalOutcomeText: String?
        var lastExecApprovalOutcomeAt: Date?
        var appSnapshot: WatchAppSnapshotMessage?
        var appSnapshotUpdatedAt: Date?
        var appSnapshotStatus: WatchAppCommandStatus?
        var appSnapshotStatusText: String?
        var appCommandStatus: WatchAppCommandStatus?
        var appCommandStatusText: String?
        var deferredGatewayPayloads: [DeferredGatewayPayload]?
        var execApprovalTerminalTombstones: [ExecApprovalTerminalTombstone]?
    }

    private static let persistedStateKey = "watch.inbox.state.v2"
    private static let maxDeferredGatewayPayloads = 32
    private static let maxExecApprovalTerminalTombstones = 128
    private static let execApprovalTerminalTombstoneLifetime: TimeInterval = 24 * 60 * 60
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
    var replyStatus: WatchReplyStatus?
    var replyStatusAt: Date?
    var isReplySending = false
    var execApprovals: [WatchExecApprovalRecord] = []
    var selectedExecApprovalID: String?
    var selectedExecApprovalGatewayStableID: String?
    var lastExecApprovalOutcome: WatchExecApprovalOutcome?
    var lastExecApprovalOutcomeAt: Date?
    var appSnapshot: WatchAppSnapshotMessage?
    var appSnapshotUpdatedAt: Date?
    var appSnapshotStatus: WatchAppCommandStatus?
    var appCommandStatus: WatchAppCommandStatus?
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
    /// Terminal events can race older prompts and snapshots across WatchConnectivity
    /// transports. Keep a short owner-scoped history so stale deliveries cannot restore
    /// live decision buttons after the canonical approval has closed.
    private var execApprovalTerminalTombstones: [ExecApprovalTerminalTombstone] = []

    var replyStatusText: String? {
        self.replyStatus?.localizedText()
    }

    var lastExecApprovalOutcomeText: String? {
        self.lastExecApprovalOutcome?.localizedText()
    }

    var appSnapshotStatusText: String? {
        self.appSnapshotStatus?.localizedText()
    }

    var appCommandStatusText: String? {
        self.appCommandStatus?.localizedText()
    }

    init(
        defaults: UserDefaults = .standard,
        requestNotificationAuthorization: Bool = true)
    {
        self.defaults = defaults
        self.restorePersistedState()
        self.pruneExecApprovalTerminalTombstones(now: Date())
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
        if let selectedKey = Self.execApprovalOwnerKey(
            approvalId: self.selectedExecApprovalID ?? "",
            gatewayStableID: self.selectedExecApprovalGatewayStableID),
            let selected = execApprovals.first(where: { $0.id == selectedKey })
        {
            return selected
        }
        return self.sortedExecApprovals.first
    }

    var shouldAutoRequestExecApprovalSnapshot: Bool {
        self.execApprovals.contains(where: \.isResolving)
            || (self.execApprovals.isEmpty
                && self.actions.isEmpty
                && self.title == Self.defaultTitle
                && self.body == Self.defaultBody
                && !self.hasCompletedExecApprovalSnapshotRefreshInSession)
    }

    var hasCompletedExecApprovalSnapshotRefresh: Bool {
        self.hasCompletedExecApprovalSnapshotRefreshInSession
    }

    var execApprovalReviewGatewayStableID: String? {
        WatchGatewayID.exact(self.activeExecApproval?.approval.gatewayStableID)
            ?? WatchGatewayID.exact(self.appSnapshot?.gatewayStableID)
    }

    func execApprovalSnapshotRequestItems(
        gatewayStableID: String?) -> [WatchExecApprovalSnapshotRequestItem]
    {
        guard let gatewayKey = WatchGatewayID.key(gatewayStableID) else { return [] }
        return self.execApprovals.compactMap { record in
            guard WatchGatewayID.key(record.approval.gatewayStableID) == gatewayKey,
                  let approvalID = WatchApprovalID.exact(record.approvalID)
            else { return nil }
            let activeAttemptID = record.activeResolutionAttemptID.flatMap { attemptID in
                attemptID.isEmpty ? nil : attemptID
            }
            return WatchExecApprovalSnapshotRequestItem(
                approvalId: approvalID,
                activeResolutionAttemptId: activeAttemptID)
        }.sorted { lhs, rhs in
            Array(lhs.approvalId.utf8).lexicographicallyPrecedes(Array(rhs.approvalId.utf8))
        }
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
        guard let appSnapshot else { return String(localized: "Waiting for iPhone") }
        return appSnapshot.gatewayStatus.localizedText()
    }

    var talkSummaryText: String {
        guard let appSnapshot else { return String(localized: "Not synced") }
        return appSnapshot.talkStatus.localizedText()
    }

    func beginExecApprovalReviewLoading() {
        guard self.execApprovals.isEmpty else {
            self.markExecApprovalReviewLoaded()
            return
        }
        self.isExecApprovalReviewLoading = true
        self.execApprovalReviewStatusText = String(localized: "Loading approval from iPhone…")
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
        self.replyStatus = nil
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
        guard WatchApprovalID.exact(message.approval.id) != nil else { return }
        self.pruneExecApprovalTerminalTombstones(now: Date())
        guard !self.isExecApprovalTerminal(
            approvalId: message.approval.id,
            gatewayStableID: message.approval.gatewayStableID)
        else {
            self.removeExecApprovalNotifications(approvals: [message.approval])
            self.markExecApprovalReviewLoaded()
            self.persistState()
            return
        }
        let nowMs = Self.nowMs()
        self.pruneExpiredExecApprovals(nowMs: nowMs)
        if let expiresAtMs = message.approval.expiresAtMs, expiresAtMs <= nowMs {
            self.removeExecApprovalNotifications(approvals: [message.approval])
            self.markExecApprovalReviewLoaded()
            self.persistState()
            return
        }
        if self.isExecApprovalPromptSupersededBySnapshot(message) {
            self.removeExecApprovalNotifications(approvals: [message.approval])
            self.markExecApprovalReviewLoaded()
            self.persistState()
            return
        }
        guard self.upsertExecApproval(
            message.approval,
            transport: transport,
            sourceSentAtMs: message.sentAtMs,
            keepSelectionIfPossible: true,
            resetResolutionAttemptID: message.resetResolutionAttemptId)
        else { return }
        guard let approvalOwnerKey = Self.execApprovalOwnerKey(
            approvalId: message.approval.id,
            gatewayStableID: message.approval.gatewayStableID)
        else { return }
        guard let notificationIdentifier = Self.execApprovalNotificationIdentifier(for: message.approval) else {
            return
        }
        self.markExecApprovalReviewLoaded()
        self.lastExecApprovalOutcome = nil
        self.lastExecApprovalOutcomeAt = nil
        if let legacyNotificationIdentifier = Self.legacyExecApprovalNotificationIdentifier(
            for: message.approval),
            !self.hasLiveLegacyNotificationCollision(
                identifier: legacyNotificationIdentifier,
                excluding: message.approval)
        {
            self.removeLocalNotifications(identifiers: [legacyNotificationIdentifier])
        }

        Task {
            await self.postLocalNotification(
                identifier: notificationIdentifier,
                title: String(localized: "Exec approval required"),
                body: message.approval.commandPreview ?? message.approval.commandText,
                risk: message.approval.risk?.rawValue,
                stillCurrent: {
                    self.execApprovals.contains { record in
                        Self.execApprovalOwnerKey(
                            approvalId: record.approvalID,
                            gatewayStableID: record.approval.gatewayStableID) == approvalOwnerKey
                    }
                })
        }
    }

    /// Returns true only after this owner snapshot is applied; forced refresh uses it as its retry acknowledgment.
    @discardableResult
    func consume(
        execApprovalSnapshot message: WatchExecApprovalSnapshotMessage,
        transport: String) -> Bool
    {
        let deferredPayload = DeferredGatewayPayload.execApprovalSnapshot(
            message: message,
            transport: transport)
        if deferredPayload.gatewayStableID != nil {
            guard self.routeGatewayPayload(deferredPayload) else { return false }
        }
        guard let snapshotGatewayID = Self.normalizedGatewayID(deferredPayload.gatewayStableID) else {
            return false
        }
        let previousSnapshotGatewayID = Self.normalizedGatewayID(
            self.lastExecApprovalSnapshotGatewayStableID)
        let hasSameSnapshotOwner = Self.gatewayIDsMatch(snapshotGatewayID, previousSnapshotGatewayID)
        let hasCanonicalRequestCorrelation = message.requestId?.isEmpty == false
            && Self.gatewayIDsMatch(message.requestGatewayStableID, snapshotGatewayID)
        if hasCanonicalRequestCorrelation {
            // A correlated snapshot may authoritatively close omitted rows. Reject the
            // whole response when any item is ownerless or belongs to another gateway;
            // filtering those items first would turn malformed input into false omissions.
            let allApprovalOwnersMatch = message.approvals.allSatisfy { approval in
                WatchApprovalID.exact(approval.id) != nil
                    && Self.gatewayIDsMatch(approval.gatewayStableID, snapshotGatewayID)
            }
            guard allApprovalOwnersMatch else { return false }
        }
        let snapshotID = message.snapshotId?.trimmingCharacters(in: .whitespacesAndNewlines)
        if hasSameSnapshotOwner,
           let snapshotID,
           !snapshotID.isEmpty,
           snapshotID == lastExecApprovalSnapshotID
        {
            return false
        }
        if hasSameSnapshotOwner,
           let sentAtMs = message.sentAtMs,
           let lastSentAtMs = lastExecApprovalSnapshotSentAtMs,
           sentAtMs < lastSentAtMs
        {
            return false
        }

        let existingRecords = self.execApprovals
        var existingRecordsByOwner: [ExecApprovalOwnerKey: WatchExecApprovalRecord] = [:]
        for record in existingRecords {
            guard let key = Self.execApprovalOwnerKey(
                approvalId: record.approvalID,
                gatewayStableID: record.approval.gatewayStableID)
            else {
                continue
            }
            existingRecordsByOwner[key] = record
        }
        self.pruneExecApprovalTerminalTombstones(now: Date())
        let incomingApprovals = message.approvals.filter { approval in
            WatchApprovalID.exact(approval.id) != nil
                && Self.gatewayIDsMatch(approval.gatewayStableID, snapshotGatewayID)
                && self.acceptsGatewayOwner(approval.gatewayStableID)
                && !self.isExecApprovalTerminal(
                    approvalId: approval.id,
                    gatewayStableID: approval.gatewayStableID)
        }
        let incomingApprovalKeys = Set(incomingApprovals.compactMap { approval in
            Self.execApprovalOwnerKey(
                approvalId: approval.id,
                gatewayStableID: approval.gatewayStableID)
        })
        let retainedNewerRecords = existingRecords.filter { record in
            guard let recordKey = Self.execApprovalOwnerKey(
                approvalId: record.approvalID,
                gatewayStableID: record.approval.gatewayStableID),
                recordKey.gatewayID == WatchGatewayID.key(snapshotGatewayID)
            else {
                return true
            }
            guard !incomingApprovalKeys.contains(recordKey) else { return false }
            // Unsolicited snapshots can come from an iPhone cache that has not yet
            // read Watch-held IDs. Only the response to a canonical request may close
            // approvals omitted from the snapshot.
            guard hasCanonicalRequestCorrelation else { return true }
            guard Self.snapshotCanReplace(
                record: record,
                snapshotSentAtMs: message.sentAtMs)
            else {
                return true
            }
            _ = self.recordExecApprovalTerminal(
                approvalId: record.approvalID,
                gatewayStableID: record.approval.gatewayStableID,
                outcome: WatchExecApprovalOutcome(code: .resolvedElsewhere),
                authoritativeOutcome: false)
            return false
        }
        let mergedIncomingRecords = incomingApprovals.map { approval in
            let approvalKey = Self.execApprovalOwnerKey(
                approvalId: approval.id,
                gatewayStableID: approval.gatewayStableID)
            let existingRecord = approvalKey.flatMap { existingRecordsByOwner[$0] }
            guard Self.snapshotCanReplace(
                record: existingRecord,
                snapshotSentAtMs: message.sentAtMs)
            else {
                return existingRecord!
            }
            return self.mergedExecApprovalRecord(
                approval: approval,
                transport: transport,
                sourceSentAtMs: message.sentAtMs,
                existingRecord: existingRecord)
        }
        self.execApprovals = retainedNewerRecords + mergedIncomingRecords
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
        self.ensureValidExecApprovalSelection()
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
        return true
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
        if hasExistingAppSnapshot, Self.gatewayIDsMatch(previousGatewayID, nextGatewayID) {
            if merged.chatItems == nil {
                merged.chatItems = self.appSnapshot?.chatItems
            }
            if merged.chatStatus == nil {
                merged.chatStatus = self.appSnapshot?.chatStatus
            }
        }
        self.appSnapshot = merged
        self.appSnapshotUpdatedAt = Date()
        self.appSnapshotStatus = nil
        if !hasExistingAppSnapshot || !Self.gatewayIDsMatch(previousGatewayID, nextGatewayID) {
            self.hasCompletedExecApprovalSnapshotRefreshInSession = false
            if !Self.gatewayIDsMatch(self.gatewayStableID, nextGatewayID) {
                self.clearMessagePrompt()
            }
            let invalidatedApprovals = self.execApprovals.compactMap { record -> WatchExecApprovalItem? in
                guard let nextGatewayID else { return record.approval }
                return Self.gatewayIDsMatch(record.approval.gatewayStableID, nextGatewayID)
                    ? nil
                    : record.approval
            }
            self.execApprovals.removeAll { record in
                guard let nextGatewayID else { return true }
                return !Self.gatewayIDsMatch(record.approval.gatewayStableID, nextGatewayID)
            }
            self.removeExecApprovalNotifications(approvals: invalidatedApprovals)
            self.ensureValidExecApprovalSelection()
        }
        self.persistState()
    }

    func consume(chatCompletion message: WatchChatCompletionMessage) {
        self.chatCompletion = message
    }

    func markAppSnapshotRequestStarted() {
        self.appSnapshotStatus = WatchAppCommandStatus(command: .refresh, code: .sending)
        self.persistState()
    }

    func markAppSnapshotRequestResult(_ result: WatchReplySendResult) {
        if let errorMessage = result.errorMessage, !errorMessage.isEmpty {
            self.appSnapshotStatus = WatchAppCommandStatus(
                command: .refresh,
                code: .failed,
                detail: errorMessage)
        } else if result.deliveredImmediately {
            self.appSnapshotStatus = WatchAppCommandStatus(command: .refresh, code: .sent)
        } else if result.queuedForDelivery {
            self.appSnapshotStatus = WatchAppCommandStatus(command: .refresh, code: .queued)
        } else {
            self.appSnapshotStatus = nil
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
        WatchGatewayID.exact(self.appSnapshot?.gatewayStableID) != nil
    }

    func markAppCommandSending(_ command: WatchAppCommand) {
        self.appCommandStatus = WatchAppCommandStatus(command: command, code: .sending)
        self.persistState()
    }

    func markAppCommandBlocked(_ command: WatchAppCommand, reason: String) {
        self.appCommandStatus = WatchAppCommandStatus(
            command: command,
            code: .blocked,
            detail: reason)
        self.persistState()
    }

    func markAppCommandResult(_ result: WatchReplySendResult, command: WatchAppCommand) {
        if let errorMessage = result.errorMessage, !errorMessage.isEmpty {
            self.appCommandStatus = WatchAppCommandStatus(
                command: command,
                code: .failed,
                detail: errorMessage)
        } else if result.deliveredImmediately {
            self.appCommandStatus = WatchAppCommandStatus(command: command, code: .sent)
        } else if result.queuedForDelivery {
            self.appCommandStatus = WatchAppCommandStatus(command: command, code: .queued)
        } else {
            self.appCommandStatus = WatchAppCommandStatus(command: command, code: .sent)
        }
        self.persistState()
    }
}

// MARK: - Exec approvals

extension WatchInboxStore {
    func consume(execApprovalResolved message: WatchExecApprovalResolvedMessage) {
        guard self.routeGatewayPayload(.execApprovalResolved(message: message)) else { return }
        let outcome = WatchExecApprovalOutcome.resolved(
            outcome: message.outcome,
            legacyText: message.outcomeText,
            decision: message.decision,
            source: message.source)
        let terminalOutcome = self.recordExecApprovalTerminal(
            approvalId: message.approvalId,
            gatewayStableID: message.gatewayStableID,
            outcome: outcome) ?? outcome
        self.removeExecApproval(id: message.approvalId, gatewayStableID: message.gatewayStableID)
        self.markExecApprovalReviewLoaded()
        self.lastExecApprovalOutcome = terminalOutcome
        self.lastExecApprovalOutcomeAt = Date()
        self.persistState()
    }

    func consume(execApprovalExpired message: WatchExecApprovalExpiredMessage) {
        guard self.routeGatewayPayload(.execApprovalExpired(message: message)) else { return }
        let outcome = switch message.reason {
        case .expired:
            WatchExecApprovalOutcome(code: .expired)
        case .notFound:
            WatchExecApprovalOutcome(code: .notFound)
        case .resolved:
            WatchExecApprovalOutcome(code: .resolvedElsewhere)
        case .replaced:
            WatchExecApprovalOutcome(code: .replaced)
        case .unavailable:
            WatchExecApprovalOutcome(code: .unavailable)
        }
        let terminalOutcome = self.recordExecApprovalTerminal(
            approvalId: message.approvalId,
            gatewayStableID: message.gatewayStableID,
            outcome: outcome) ?? outcome
        self.removeExecApproval(id: message.approvalId, gatewayStableID: message.gatewayStableID)
        self.markExecApprovalReviewLoaded()
        self.lastExecApprovalOutcome = terminalOutcome
        self.lastExecApprovalOutcomeAt = Date()
        self.persistState()
    }

    /// Returns owner-scoped terminal truth for a detail screen whose live record was removed.
    func terminalExecApprovalOutcomeText(
        approvalId: String,
        gatewayStableID: String?) -> String?
    {
        guard let key = Self.execApprovalOwnerKey(
            approvalId: approvalId,
            gatewayStableID: gatewayStableID)
        else {
            return nil
        }
        let cutoff = Date().addingTimeInterval(-Self.execApprovalTerminalTombstoneLifetime)
        return self.execApprovalTerminalTombstones.last { tombstone in
            tombstone.recordedAt >= cutoff
                && WatchApprovalID.key(tombstone.approvalId) == key.approvalID
                && WatchGatewayID.key(tombstone.gatewayStableID) == key.gatewayID
        }?.outcome.localizedText()
    }

    func selectExecApproval(id: String, gatewayStableID: String?) {
        guard let exactKey = Self.execApprovalOwnerKey(
            approvalId: id,
            gatewayStableID: gatewayStableID),
            let record = self.execApprovals.first(where: { $0.id == exactKey })
        else { return }
        self.selectedExecApprovalID = record.approvalID
        self.selectedExecApprovalGatewayStableID = record.approval.gatewayStableID
        self.persistState()
    }

    func beginExecApprovalDecision(
        approvalId: String,
        gatewayStableID: String?,
        decision: WatchExecApprovalDecision) -> String?
    {
        self.pruneExpiredExecApprovals(nowMs: Self.nowMs())
        guard let ownerKey = Self.execApprovalOwnerKey(
            approvalId: approvalId,
            gatewayStableID: gatewayStableID),
            !self.isExecApprovalTerminal(
                approvalId: approvalId,
                gatewayStableID: gatewayStableID),
            let index = execApprovals.firstIndex(where: { record in
                Self.execApprovalOwnerKey(
                    approvalId: record.approvalID,
                    gatewayStableID: record.approval.gatewayStableID) == ownerKey
            }),
            !self.execApprovals[index].isResolving,
            execApprovals[index].approval.allowedDecisions.contains(decision)
        else { return nil }

        let attemptID = UUID().uuidString
        self.execApprovals[index].isResolving = true
        self.execApprovals[index].pendingDecision = decision
        self.execApprovals[index].activeResolutionAttemptID = attemptID
        self.execApprovals[index].status = WatchExecApprovalStatus(
            code: .sending,
            decision: decision)
        self.execApprovals[index].statusAt = Date()
        self.persistState()
        return attemptID
    }

    func completeExecApprovalDecision(
        approvalId: String,
        gatewayStableID: String?,
        attemptID: String,
        decision: WatchExecApprovalDecision,
        result: WatchReplySendResult)
    {
        guard let ownerKey = Self.execApprovalOwnerKey(
            approvalId: approvalId,
            gatewayStableID: gatewayStableID),
            let index = execApprovals.firstIndex(where: { record in
                Self.execApprovalOwnerKey(
                    approvalId: record.approvalID,
                    gatewayStableID: record.approval.gatewayStableID) == ownerKey
            }),
            let activeResolutionAttemptID = execApprovals[index].activeResolutionAttemptID,
            WatchOpaqueUTF8Key(activeResolutionAttemptID) == WatchOpaqueUTF8Key(attemptID),
            execApprovals[index].pendingDecision == decision
        else { return }

        switch result.delivery {
        case .delivered:
            self.execApprovals[index].isResolving = true
            self.execApprovals[index].status = WatchExecApprovalStatus(
                code: .sent,
                decision: decision)
        case .queued:
            self.execApprovals[index].isResolving = true
            self.execApprovals[index].status = WatchExecApprovalStatus(
                code: .queued,
                decision: decision)
        case .notSent:
            // Only a definitive pre-dispatch failure unlocks locally. Uncertain sends stay
            // frozen until a canonical retry reset or terminal event arrives.
            self.execApprovals[index].isResolving = false
            self.execApprovals[index].activeResolutionAttemptID = nil
            self.execApprovals[index].status = WatchExecApprovalStatus(
                code: .retry,
                decision: decision)
        }
        self.execApprovals[index].pendingDecision = result.delivery == .notSent ? nil : decision
        self.execApprovals[index].statusAt = Date()
        self.persistState()
    }

    private func upsertExecApproval(
        _ approval: WatchExecApprovalItem,
        transport: String,
        sourceSentAtMs: Int64?,
        keepSelectionIfPossible: Bool,
        resetResolutionAttemptID: String? = nil) -> Bool
    {
        guard let ownerKey = Self.execApprovalOwnerKey(
            approvalId: approval.id,
            gatewayStableID: approval.gatewayStableID)
        else { return false }
        if let index = execApprovals.firstIndex(where: { record in
            Self.execApprovalOwnerKey(
                approvalId: record.approvalID,
                gatewayStableID: record.approval.gatewayStableID) == ownerKey
        }) {
            guard Self.snapshotCanReplace(
                record: self.execApprovals[index],
                snapshotSentAtMs: sourceSentAtMs)
            else { return false }
            let resetResolvingState = if let resetResolutionAttemptID,
                                         let activeResolutionAttemptID =
                                         self.execApprovals[index].activeResolutionAttemptID
            {
                WatchOpaqueUTF8Key(resetResolutionAttemptID) == WatchOpaqueUTF8Key(activeResolutionAttemptID)
            } else {
                false
            }
            self.execApprovals[index] = self.mergedExecApprovalRecord(
                approval: approval,
                transport: transport,
                sourceSentAtMs: sourceSentAtMs,
                existingRecord: self.execApprovals[index],
                resetResolvingState: resetResolvingState)
        } else {
            self.execApprovals.append(
                self.mergedExecApprovalRecord(
                    approval: approval,
                    transport: transport,
                    sourceSentAtMs: sourceSentAtMs,
                    existingRecord: nil))
        }
        if !keepSelectionIfPossible || Self.execApprovalOwnerKey(
            approvalId: self.selectedExecApprovalID ?? "",
            gatewayStableID: self.selectedExecApprovalGatewayStableID) == nil
        {
            self.selectedExecApprovalID = approval.id
            self.selectedExecApprovalGatewayStableID = approval.gatewayStableID
        }
        self.persistState()
        return true
    }

    private func mergedExecApprovalRecord(
        approval: WatchExecApprovalItem,
        transport: String,
        sourceSentAtMs: Int64?,
        existingRecord: WatchExecApprovalRecord?,
        resetResolvingState: Bool = false) -> WatchExecApprovalRecord
    {
        // Preserve in-flight state across ordinary snapshot/prompt refreshes so duplicate
        // submissions stay disabled. Only the iPhone readback for the same attempt may clear it.
        let isResolving = resetResolvingState ? false : (existingRecord?.isResolving ?? false)
        let pendingDecision = resetResolvingState ? nil : existingRecord?.pendingDecision
        let activeResolutionAttemptID = resetResolvingState ? nil : existingRecord?.activeResolutionAttemptID
        let status = resetResolvingState ? nil : existingRecord?.status
        let statusAt = resetResolvingState ? nil : existingRecord?.statusAt
        return WatchExecApprovalRecord(
            approval: approval,
            transport: transport,
            sourceSentAtMs: sourceSentAtMs ?? existingRecord?.sourceSentAtMs,
            updatedAt: Date(),
            isResolving: isResolving,
            pendingDecision: pendingDecision,
            activeResolutionAttemptID: activeResolutionAttemptID,
            status: status,
            statusAt: statusAt)
    }

    private static func snapshotCanReplace(
        record: WatchExecApprovalRecord?,
        snapshotSentAtMs: Int64?) -> Bool
    {
        guard let record else { return true }
        guard let snapshotSentAtMs else {
            // Missing cross-transport ordering evidence cannot safely remove or replace a
            // live prompt. Its expiry or a terminal event will eventually close it.
            return false
        }
        // Records persisted before source timestamps were added yield to a timestamped
        // canonical snapshot instead of remaining actionable indefinitely.
        guard let recordSentAtMs = record.sourceSentAtMs else { return true }
        return snapshotSentAtMs >= recordSentAtMs
    }

    private func isExecApprovalPromptSupersededBySnapshot(
        _ message: WatchExecApprovalPromptMessage) -> Bool
    {
        let promptGatewayID = Self.normalizedGatewayID(message.approval.gatewayStableID)
        let snapshotGatewayID = Self.normalizedGatewayID(
            self.lastExecApprovalSnapshotGatewayStableID)
        guard Self.gatewayIDsMatch(promptGatewayID, snapshotGatewayID),
              let snapshotSentAtMs = lastExecApprovalSnapshotSentAtMs
        else {
            return false
        }
        let hasLiveRecord = self.execApprovals.contains { record in
            Self.execApprovalOwnerKey(
                approvalId: record.approvalID,
                gatewayStableID: record.approval.gatewayStableID) == Self.execApprovalOwnerKey(
                approvalId: message.approval.id,
                gatewayStableID: message.approval.gatewayStableID)
        }
        guard !hasLiveRecord else { return false }
        guard let promptSentAtMs = message.sentAtMs else {
            // Once an owner snapshot has closed an ID, an undated prompt cannot prove it is newer.
            return true
        }
        return promptSentAtMs <= snapshotSentAtMs
    }

    private func removeExecApproval(id: String, gatewayStableID: String?) {
        guard let exactKey = Self.execApprovalOwnerKey(
            approvalId: id,
            gatewayStableID: gatewayStableID)
        else { return }
        let removedApprovals = self.execApprovals.compactMap { record -> WatchExecApprovalItem? in
            record.id == exactKey ? record.approval : nil
        }
        self.execApprovals.removeAll { record in
            record.id == exactKey
        }
        self.removeExecApprovalNotifications(approvals: removedApprovals)
        if Self.execApprovalOwnerKey(
            approvalId: self.selectedExecApprovalID ?? "",
            gatewayStableID: self.selectedExecApprovalGatewayStableID) == exactKey
        {
            self.selectedExecApprovalID = self.sortedExecApprovals.first?.approvalID
            self.selectedExecApprovalGatewayStableID = self.sortedExecApprovals.first?.approval.gatewayStableID
        }
        self.persistState()
    }
}

// MARK: - Gateway routing and persistence

extension WatchInboxStore {
    private func routeGatewayPayload(_ payload: DeferredGatewayPayload) -> Bool {
        guard let incomingGatewayID = Self.normalizedGatewayID(payload.gatewayStableID) else {
            return false
        }
        guard let activeSnapshot = appSnapshot else { return true }
        let activeGatewayID = Self.normalizedGatewayID(activeSnapshot.gatewayStableID)
        guard !Self.gatewayIDsMatch(incomingGatewayID, activeGatewayID) else { return true }
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
        return Self.gatewayIDsMatch(incomingGatewayID, activeGatewayID)
    }

    @discardableResult
    func replayDeferredGatewayPayloads() -> [WatchExecApprovalSnapshotMessage] {
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
            return []
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
            if Self.gatewayIDsMatch(payload.gatewayStableID, activeGatewayID) {
                let isPreexistingApprovalPayload = Self.gatewayIDsMatch(
                    approvalSnapshotGatewayID,
                    activeGatewayID)
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
                   let approvalOwnerKey = Self.execApprovalOwnerKey(
                       approvalId: approval.id,
                       gatewayStableID: approval.gatewayStableID),
                   !self.execApprovals.contains(where: { record in
                       Self.execApprovalOwnerKey(
                           approvalId: record.approvalID,
                           gatewayStableID: record.approval.gatewayStableID) == approvalOwnerKey
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
        var appliedExecApprovalSnapshots: [WatchExecApprovalSnapshotMessage] = []
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
                if self.consume(execApprovalSnapshot: message, transport: transport) {
                    appliedExecApprovalSnapshots.append(message)
                }
            }
        }
        return appliedExecApprovalSnapshots
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
        self.replyStatus = nil
        self.replyStatusAt = nil
        self.isReplySending = false

        guard let notificationIdentifier else { return }
        self.removeLocalNotifications(identifiers: [notificationIdentifier])
    }

    private func removeExecApprovalNotifications(approvals: [WatchExecApprovalItem]) {
        self.removeLocalNotifications(identifiers: approvals.flatMap { approval in
            var identifiers = Self.execApprovalNotificationIdentifier(for: approval).map { [$0] } ?? []
            if let legacyIdentifier = Self.legacyExecApprovalNotificationIdentifier(for: approval),
               !self.hasLiveLegacyNotificationCollision(
                   identifier: legacyIdentifier,
                   excluding: approval)
            {
                identifiers.append(legacyIdentifier)
            }
            return identifiers
        })
    }

    private func hasLiveLegacyNotificationCollision(
        identifier: String,
        excluding approval: WatchExecApprovalItem) -> Bool
    {
        let identifierKey = WatchOpaqueUTF8Key(identifier)
        let excludedKey = Self.execApprovalOwnerKey(
            approvalId: approval.id,
            gatewayStableID: approval.gatewayStableID)
        return self.execApprovals.contains { record in
            let recordKey = Self.execApprovalOwnerKey(
                approvalId: record.approvalID,
                gatewayStableID: record.approval.gatewayStableID)
            guard recordKey != excludedKey,
                  let candidate = Self.legacyExecApprovalNotificationIdentifier(for: record.approval)
            else { return false }
            return WatchOpaqueUTF8Key(candidate) == identifierKey
        }
    }

    private func removeLocalNotifications(identifiers: [String]) {
        guard !identifiers.isEmpty else { return }
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: identifiers)
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }

    private nonisolated static func normalizedGatewayID(_ gatewayStableID: String?) -> String? {
        WatchGatewayID.exact(gatewayStableID)
    }

    private nonisolated static func gatewayIDsMatch(_ lhs: String?, _ rhs: String?) -> Bool {
        WatchGatewayID.key(lhs) == WatchGatewayID.key(rhs)
    }

    private nonisolated static func onlyGatewayStableID(in approvals: [WatchExecApprovalItem]) -> String? {
        var gatewaysByKey: [WatchGatewayID.Key: String] = [:]
        for approval in approvals {
            guard let gatewayID = self.normalizedGatewayID(approval.gatewayStableID),
                  let gatewayKey = WatchGatewayID.key(gatewayID)
            else { continue }
            gatewaysByKey[gatewayKey] = gatewayID
        }
        return gatewaysByKey.count == 1 ? gatewaysByKey.values.first : nil
    }

    private static func execApprovalNotificationIdentifier(for approval: WatchExecApprovalItem) -> String? {
        guard let gatewayKey = WatchGatewayID.key(approval.gatewayStableID) else { return nil }
        guard let approvalKey = WatchApprovalID.key(approval.id) else { return nil }
        return "watch.execApproval.\(gatewayKey.notificationComponent).\(approvalKey.notificationComponent)"
    }

    private static func legacyExecApprovalNotificationIdentifier(for approval: WatchExecApprovalItem) -> String? {
        guard let gatewayStableID = WatchGatewayID.exact(approval.gatewayStableID),
              let approvalID = WatchApprovalID.exact(approval.id)
        else { return nil }
        return "watch.execApproval.\(gatewayStableID.utf8.count):\(gatewayStableID)\(approvalID)"
    }

    private static func execApprovalOwnerKey(
        approvalId: String,
        gatewayStableID: String?) -> ExecApprovalOwnerKey?
    {
        guard let approvalKey = WatchApprovalID.key(approvalId),
              let gatewayKey = WatchGatewayID.key(gatewayStableID)
        else {
            return nil
        }
        return ExecApprovalOwnerKey(
            gatewayID: gatewayKey,
            approvalID: approvalKey)
    }

    private func isExecApprovalTerminal(approvalId: String, gatewayStableID: String?) -> Bool {
        guard let key = Self.execApprovalOwnerKey(
            approvalId: approvalId,
            gatewayStableID: gatewayStableID)
        else {
            return false
        }
        return self.execApprovalTerminalTombstones.contains { tombstone in
            WatchApprovalID.key(tombstone.approvalId) == key.approvalID
                && WatchGatewayID.key(tombstone.gatewayStableID) == key.gatewayID
        }
    }

    @discardableResult
    private func recordExecApprovalTerminal(
        approvalId: String,
        gatewayStableID: String?,
        outcome: WatchExecApprovalOutcome,
        authoritativeOutcome: Bool = true) -> WatchExecApprovalOutcome?
    {
        guard let exactApprovalID = WatchApprovalID.exact(approvalId),
              let exactGatewayID = WatchGatewayID.exact(gatewayStableID),
              let key = Self.execApprovalOwnerKey(
                  approvalId: approvalId,
                  gatewayStableID: gatewayStableID)
        else {
            return nil
        }
        self.pruneExecApprovalTerminalTombstones(now: Date())
        if let existingIndex = execApprovalTerminalTombstones.lastIndex(where: { tombstone in
            WatchApprovalID.key(tombstone.approvalId) == key.approvalID
                && WatchGatewayID.key(tombstone.gatewayStableID) == key.gatewayID
        }) {
            if authoritativeOutcome,
               self.execApprovalTerminalTombstones[existingIndex].outcomeIsAuthoritative != true
            {
                var upgraded = self.execApprovalTerminalTombstones.remove(at: existingIndex)
                upgraded.outcome = outcome
                upgraded.outcomeIsAuthoritative = true
                upgraded.recordedAt = Date()
                self.execApprovalTerminalTombstones.append(upgraded)
                return upgraded.outcome
            }
            return self.execApprovalTerminalTombstones[existingIndex].outcome
        }
        self.execApprovalTerminalTombstones.append(ExecApprovalTerminalTombstone(
            approvalId: exactApprovalID,
            gatewayStableID: exactGatewayID,
            outcome: outcome,
            outcomeIsAuthoritative: authoritativeOutcome,
            recordedAt: Date()))
        self.pruneExecApprovalTerminalTombstones(now: Date())
        return outcome
    }

    private func pruneExecApprovalTerminalTombstones(now: Date) {
        let cutoff = now.addingTimeInterval(-Self.execApprovalTerminalTombstoneLifetime)
        let retained = self.execApprovalTerminalTombstones.filter { tombstone in
            tombstone.recordedAt >= cutoff
        }
        self.execApprovalTerminalTombstones = Array(
            retained.suffix(Self.maxExecApprovalTerminalTombstones))
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
        self.ensureValidExecApprovalSelection()
        self.persistState()
    }

    private func ensureValidExecApprovalSelection() {
        if let selectedKey = Self.execApprovalOwnerKey(
            approvalId: self.selectedExecApprovalID ?? "",
            gatewayStableID: self.selectedExecApprovalGatewayStableID),
            self.execApprovals.contains(where: { $0.id == selectedKey })
        {
            return
        }
        self.selectedExecApprovalID = self.sortedExecApprovals.first?.approvalID
        self.selectedExecApprovalGatewayStableID = self.sortedExecApprovals.first?.approval.gatewayStableID
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
        self.replyStatus = state.replyStatus
            ?? state.replyStatusText.flatMap(WatchReplyStatus.decodeLegacyLocalizedText)
        self.replyStatusAt = state.replyStatusAt
        let validApprovals = state.execApprovals.filter { record in
            WatchApprovalID.exact(record.approvalID) != nil
        }
        let ownerlessApprovals = validApprovals.filter { record in
            Self.normalizedGatewayID(record.approval.gatewayStableID) == nil
        }
        let taggedApprovals = validApprovals.filter { record in
            Self.normalizedGatewayID(record.approval.gatewayStableID) != nil
        }
        let activeGatewayID = state.appSnapshot.flatMap { snapshot in
            Self.normalizedGatewayID(snapshot.gatewayStableID)
        }
        let invalidatedApprovals: [WatchExecApprovalRecord]
        if state.appSnapshot != nil {
            self.execApprovals = taggedApprovals.filter { record in
                Self.gatewayIDsMatch(record.approval.gatewayStableID, activeGatewayID)
            }
            invalidatedApprovals = taggedApprovals.filter { record in
                !Self.gatewayIDsMatch(record.approval.gatewayStableID, activeGatewayID)
            }
        } else {
            self.execApprovals = taggedApprovals
            invalidatedApprovals = []
        }
        self.selectedExecApprovalID = state.selectedExecApprovalID
        self.selectedExecApprovalGatewayStableID = state.selectedExecApprovalGatewayStableID
        self.lastExecApprovalSnapshotID = state.lastExecApprovalSnapshotID
        self.lastExecApprovalSnapshotGatewayStableID = state.lastExecApprovalSnapshotGatewayStableID
        self.lastExecApprovalSnapshotSentAtMs = state.lastExecApprovalSnapshotSentAtMs
        self.lastExecApprovalOutcome = state.lastExecApprovalOutcome
            ?? state.lastExecApprovalOutcomeText.flatMap(
                WatchExecApprovalOutcome.decodeLegacyLocalizedText)
        self.lastExecApprovalOutcomeAt = state.lastExecApprovalOutcomeAt
        self.appSnapshot = state.appSnapshot
        self.appSnapshotUpdatedAt = state.appSnapshotUpdatedAt
        self.appSnapshotStatus = state.appSnapshotStatus
            ?? state.appSnapshotStatusText.flatMap(
                WatchAppCommandStatus.decodeLegacyLocalizedText)
        self.appCommandStatus = state.appCommandStatus
            ?? state.appCommandStatusText.flatMap(
                WatchAppCommandStatus.decodeLegacyLocalizedText)
        self.deferredGatewayPayloads = Array(
            (state.deferredGatewayPayloads ?? []).suffix(Self.maxDeferredGatewayPayloads))
        self.execApprovalTerminalTombstones = state.execApprovalTerminalTombstones ?? []
        self.pruneExecApprovalTerminalTombstones(now: Date())
        let restoredTerminalApprovals = self.execApprovals.compactMap { record in
            self.isExecApprovalTerminal(
                approvalId: record.approvalID,
                gatewayStableID: record.approval.gatewayStableID)
                ? record.approval
                : nil
        }
        self.execApprovals.removeAll { record in
            self.isExecApprovalTerminal(
                approvalId: record.approvalID,
                gatewayStableID: record.approval.gatewayStableID)
        }
        self.removeExecApprovalNotifications(approvals: restoredTerminalApprovals)

        if state.appSnapshot != nil,
           !Self.gatewayIDsMatch(self.lastExecApprovalSnapshotGatewayStableID, activeGatewayID)
        {
            self.lastExecApprovalSnapshotID = nil
            self.lastExecApprovalSnapshotGatewayStableID = nil
            self.lastExecApprovalSnapshotSentAtMs = nil
        }
        self.ensureValidExecApprovalSelection()
        self.removeExecApprovalNotifications(approvals: invalidatedApprovals.map(\.approval))

        guard !ownerlessApprovals.isEmpty else { return }
        // Older Watch state has no gateway owner and cannot be resolved safely after
        // gateway switches. Drop it, clear its old alert keys, and force a fresh snapshot.
        self.lastExecApprovalSnapshotID = nil
        self.lastExecApprovalSnapshotGatewayStableID = nil
        self.lastExecApprovalSnapshotSentAtMs = nil
        self.removeLocalNotifications(identifiers: ownerlessApprovals.flatMap { record -> [String] in
            guard let approvalKey = WatchApprovalID.key(record.approvalID) else { return [] }
            return [
                "watch.execApproval.\(approvalKey.notificationComponent)",
                "watch.execApproval.\(record.approvalID)",
            ]
        })
    }

    private func persistState() {
        self.pruneExecApprovalTerminalTombstones(now: Date())
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
            replyStatus: replyStatus,
            replyStatusText: nil,
            replyStatusAt: replyStatusAt,
            execApprovals: execApprovals,
            selectedExecApprovalID: selectedExecApprovalID,
            selectedExecApprovalGatewayStableID: selectedExecApprovalGatewayStableID,
            lastExecApprovalSnapshotID: lastExecApprovalSnapshotID,
            lastExecApprovalSnapshotGatewayStableID: lastExecApprovalSnapshotGatewayStableID,
            lastExecApprovalSnapshotSentAtMs: lastExecApprovalSnapshotSentAtMs,
            lastExecApprovalOutcome: lastExecApprovalOutcome,
            lastExecApprovalOutcomeText: nil,
            lastExecApprovalOutcomeAt: lastExecApprovalOutcomeAt,
            appSnapshot: appSnapshot,
            appSnapshotUpdatedAt: appSnapshotUpdatedAt,
            appSnapshotStatus: appSnapshotStatus,
            appSnapshotStatusText: nil,
            appCommandStatus: appCommandStatus,
            appCommandStatusText: nil,
            deferredGatewayPayloads: deferredGatewayPayloads,
            execApprovalTerminalTombstones: execApprovalTerminalTombstones)
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
        self.replyStatus = WatchReplyStatus(
            code: .sending,
            actionLabel: actionLabel,
            detail: nil)
        self.replyStatusAt = Date()
        self.persistState()
    }

    func markReplyResult(_ result: WatchReplySendResult, actionLabel: String) {
        self.isReplySending = false
        if let errorMessage = result.errorMessage, !errorMessage.isEmpty {
            self.replyStatus = WatchReplyStatus(
                code: .failed,
                actionLabel: actionLabel,
                detail: errorMessage)
        } else if result.deliveredImmediately {
            self.replyStatus = WatchReplyStatus(
                code: .sent,
                actionLabel: actionLabel,
                detail: nil)
        } else if result.queuedForDelivery {
            self.replyStatus = WatchReplyStatus(
                code: .queued,
                actionLabel: actionLabel,
                detail: nil)
        } else {
            self.replyStatus = WatchReplyStatus(
                code: .sent,
                actionLabel: actionLabel,
                detail: nil)
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

    private static func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }
}
