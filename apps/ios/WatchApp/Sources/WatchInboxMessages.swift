import Foundation
import OpenClawKit

// Canonical transport leaf models live in OpenClawKit. The local envelope types
// below retain the existing Watch inbox persistence shape without `type`.
typealias WatchPayloadType = OpenClawWatchPayloadType
typealias WatchRiskLevel = OpenClawWatchRisk
typealias WatchExecApprovalDecision = OpenClawWatchExecApprovalDecision
typealias WatchExecApprovalCloseReason = OpenClawWatchExecApprovalCloseReason
typealias WatchOpaqueUTF8Key = ExactOpaqueIdentifierKey
typealias WatchApprovalID = ExecApprovalIdentifier
typealias WatchGatewayID = GatewayStableIdentifier

struct WatchExecApprovalIdentityKey: Hashable, Sendable {
    var gatewayID: WatchGatewayID.Key
    var approvalID: WatchApprovalID.Key
}

typealias WatchExecApprovalItem = OpenClawWatchExecApprovalItem

struct WatchExecApprovalPromptMessage: Codable, Equatable {
    var approval: WatchExecApprovalItem
    var sentAtMs: Int64?
    var resetResolutionAttemptId: String?
}

struct WatchExecApprovalResolvedMessage: Codable, Equatable {
    var approvalId: String
    var gatewayStableID: String?
    var decision: WatchExecApprovalDecision?
    var resolvedAtMs: Int64?
    var source: String?
    var outcomeText: String?
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
    var requestId: String?
    var requestGatewayStableID: String?

    init(
        approvals: [WatchExecApprovalItem],
        gatewayStableID: String? = nil,
        sentAtMs: Int64? = nil,
        snapshotId: String? = nil,
        requestId: String? = nil,
        requestGatewayStableID: String? = nil)
    {
        self.approvals = approvals
        self.gatewayStableID = gatewayStableID
        self.sentAtMs = sentAtMs
        self.snapshotId = snapshotId
        self.requestId = requestId
        self.requestGatewayStableID = requestGatewayStableID
    }
}

typealias WatchExecApprovalSnapshotRequestMessage = OpenClawWatchExecApprovalSnapshotRequestMessage
typealias WatchExecApprovalSnapshotRequestItem = OpenClawWatchExecApprovalSnapshotRequestItem
typealias WatchExecApprovalResolveMessage = OpenClawWatchExecApprovalResolveMessage

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

typealias WatchChatCompletionMessage = OpenClawWatchChatCompletionMessage
typealias WatchChatItem = OpenClawWatchChatItem
typealias WatchAppSnapshotRequestMessage = OpenClawWatchAppSnapshotRequestMessage
typealias WatchAppCommand = OpenClawWatchAppCommand
typealias WatchAppCommandMessage = OpenClawWatchAppCommandMessage
typealias WatchPromptAction = OpenClawWatchAction

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
    var sourceSentAtMs: Int64?
    var updatedAt: Date
    var isResolving: Bool
    var pendingDecision: WatchExecApprovalDecision?
    var activeResolutionAttemptID: String?
    var statusText: String?
    var statusAt: Date?

    var id: WatchExecApprovalIdentityKey {
        WatchExecApprovalIdentityKey(
            gatewayID: WatchOpaqueUTF8Key(self.approval.gatewayStableID ?? ""),
            approvalID: WatchOpaqueUTF8Key(self.approval.id))
    }

    var approvalID: String {
        self.approval.id
    }
}
