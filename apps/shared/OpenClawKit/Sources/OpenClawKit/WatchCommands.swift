import Foundation

public enum OpenClawWatchCommand: String, Codable, Sendable {
    case status = "watch.status"
    case notify = "watch.notify"
}

public enum OpenClawWatchPayloadType: String, Codable, Sendable, Equatable {
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

public enum OpenClawWatchRisk: String, Codable, Sendable, Equatable {
    case low
    case medium
    case high
}

public enum OpenClawWatchExecApprovalDecision: String, Codable, Sendable, Equatable {
    case allowOnce = "allow-once"
    case deny
}

public enum OpenClawWatchExecApprovalCloseReason: String, Codable, Sendable, Equatable {
    case expired
    case notFound = "not-found"
    case unavailable
    case replaced
    case resolved
}

public struct OpenClawWatchAction: Codable, Sendable, Equatable {
    public var id: String
    public var label: String
    public var style: String?

    public init(id: String, label: String, style: String? = nil) {
        self.id = id
        self.label = label
        self.style = style
    }
}

public struct OpenClawWatchExecApprovalItem: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var gatewayStableID: String?
    public var commandText: String
    public var commandPreview: String?
    public var warningText: String?
    public var host: String?
    public var nodeId: String?
    public var agentId: String?
    public var expiresAtMs: Int64?
    public var allowedDecisions: [OpenClawWatchExecApprovalDecision]
    public var risk: OpenClawWatchRisk?

    public init(
        id: String,
        gatewayStableID: String? = nil,
        commandText: String,
        commandPreview: String? = nil,
        warningText: String? = nil,
        host: String? = nil,
        nodeId: String? = nil,
        agentId: String? = nil,
        expiresAtMs: Int64? = nil,
        allowedDecisions: [OpenClawWatchExecApprovalDecision] = [],
        risk: OpenClawWatchRisk? = nil)
    {
        self.id = id
        self.gatewayStableID = gatewayStableID
        self.commandText = commandText
        self.commandPreview = commandPreview
        self.warningText = warningText
        self.host = host
        self.nodeId = nodeId
        self.agentId = agentId
        self.expiresAtMs = expiresAtMs
        self.allowedDecisions = allowedDecisions
        self.risk = risk
    }
}

public struct OpenClawWatchExecApprovalPromptMessage: Codable, Sendable, Equatable {
    public var type: OpenClawWatchPayloadType
    public var approval: OpenClawWatchExecApprovalItem
    public var sentAtMs: Int64?
    public var resetResolutionAttemptId: String?

    public init(
        approval: OpenClawWatchExecApprovalItem,
        sentAtMs: Int64? = nil,
        resetResolutionAttemptId: String? = nil)
    {
        self.type = .execApprovalPrompt
        self.approval = approval
        self.sentAtMs = sentAtMs
        self.resetResolutionAttemptId = resetResolutionAttemptId
    }
}

public struct OpenClawWatchExecApprovalResolveMessage: Codable, Sendable, Equatable {
    public var type: OpenClawWatchPayloadType
    public var approvalId: String
    public var gatewayStableID: String?
    public var decision: OpenClawWatchExecApprovalDecision
    public var replyId: String
    public var sentAtMs: Int64?

    public init(
        approvalId: String,
        gatewayStableID: String? = nil,
        decision: OpenClawWatchExecApprovalDecision,
        replyId: String,
        sentAtMs: Int64? = nil)
    {
        self.type = .execApprovalResolve
        self.approvalId = approvalId
        self.gatewayStableID = gatewayStableID
        self.decision = decision
        self.replyId = replyId
        self.sentAtMs = sentAtMs
    }
}

public struct OpenClawWatchExecApprovalResolvedMessage: Codable, Sendable, Equatable {
    public var type: OpenClawWatchPayloadType
    public var approvalId: String
    public var gatewayStableID: String?
    public var decision: OpenClawWatchExecApprovalDecision?
    public var resolvedAtMs: Int64?
    public var source: String?
    public var outcomeText: String?

    public init(
        approvalId: String,
        gatewayStableID: String? = nil,
        decision: OpenClawWatchExecApprovalDecision? = nil,
        resolvedAtMs: Int64? = nil,
        source: String? = nil,
        outcomeText: String? = nil)
    {
        self.type = .execApprovalResolved
        self.approvalId = approvalId
        self.gatewayStableID = gatewayStableID
        self.decision = decision
        self.resolvedAtMs = resolvedAtMs
        self.source = source
        self.outcomeText = outcomeText
    }
}

public struct OpenClawWatchExecApprovalExpiredMessage: Codable, Sendable, Equatable {
    public var type: OpenClawWatchPayloadType
    public var approvalId: String
    public var gatewayStableID: String?
    public var reason: OpenClawWatchExecApprovalCloseReason
    public var expiredAtMs: Int64?

    public init(
        approvalId: String,
        gatewayStableID: String? = nil,
        reason: OpenClawWatchExecApprovalCloseReason,
        expiredAtMs: Int64? = nil)
    {
        self.type = .execApprovalExpired
        self.approvalId = approvalId
        self.gatewayStableID = gatewayStableID
        self.reason = reason
        self.expiredAtMs = expiredAtMs
    }
}

public struct OpenClawWatchExecApprovalSnapshotMessage: Codable, Sendable, Equatable {
    public var type: OpenClawWatchPayloadType
    public var approvals: [OpenClawWatchExecApprovalItem]
    public var gatewayStableID: String?
    public var sentAtMs: Int64?
    public var snapshotId: String?
    public var requestId: String?
    public var requestGatewayStableID: String?

    public init(
        approvals: [OpenClawWatchExecApprovalItem],
        gatewayStableID: String? = nil,
        sentAtMs: Int64? = nil,
        snapshotId: String? = nil,
        requestId: String? = nil,
        requestGatewayStableID: String? = nil)
    {
        self.type = .execApprovalSnapshot
        self.approvals = approvals
        self.gatewayStableID = gatewayStableID
        self.sentAtMs = sentAtMs
        self.snapshotId = snapshotId
        self.requestId = requestId
        self.requestGatewayStableID = requestGatewayStableID
    }
}

public struct OpenClawWatchExecApprovalSnapshotRequestItem: Codable, Sendable, Equatable {
    public var approvalId: String
    public var activeResolutionAttemptId: String?

    public init(
        approvalId: String,
        activeResolutionAttemptId: String? = nil)
    {
        self.approvalId = approvalId
        self.activeResolutionAttemptId = activeResolutionAttemptId
    }
}

public struct OpenClawWatchExecApprovalSnapshotRequestMessage: Codable, Sendable, Equatable {
    public var type: OpenClawWatchPayloadType
    public var requestId: String
    public var sentAtMs: Int64?
    public var gatewayStableID: String?
    public var heldApprovals: [OpenClawWatchExecApprovalSnapshotRequestItem]

    public init(
        requestId: String,
        sentAtMs: Int64? = nil,
        gatewayStableID: String? = nil,
        heldApprovals: [OpenClawWatchExecApprovalSnapshotRequestItem] = [])
    {
        self.type = .execApprovalSnapshotRequest
        self.requestId = requestId
        self.sentAtMs = sentAtMs
        self.gatewayStableID = gatewayStableID
        self.heldApprovals = heldApprovals
    }
}

public struct OpenClawWatchChatItem: Codable, Sendable, Equatable, Identifiable {
    public var id: String
    public var role: String
    public var text: String
    public var timestampMs: Int64?

    public init(
        id: String,
        role: String,
        text: String,
        timestampMs: Int64? = nil)
    {
        self.id = id
        self.role = role
        self.text = text
        self.timestampMs = timestampMs
    }
}

public struct OpenClawWatchChatCompletionMessage: Codable, Sendable, Equatable {
    public var type: OpenClawWatchPayloadType
    public var commandId: String
    public var replyText: String
    public var sentAtMs: Int64?

    public init(commandId: String, replyText: String, sentAtMs: Int64? = nil) {
        self.type = .chatCompletion
        self.commandId = commandId
        self.replyText = replyText
        self.sentAtMs = sentAtMs
    }
}

public struct OpenClawWatchAppSnapshotMessage: Codable, Sendable, Equatable {
    public var type: OpenClawWatchPayloadType
    public var gatewayStatusText: String
    public var gatewayConnected: Bool
    public var agentName: String
    public var agentAvatarURL: String?
    public var agentAvatarText: String?
    public var sessionKey: String
    public var gatewayStableID: String?
    public var talkStatusText: String
    public var talkEnabled: Bool
    public var talkListening: Bool
    public var talkSpeaking: Bool
    public var pendingApprovalCount: Int
    public var chatItems: [OpenClawWatchChatItem]?
    public var chatStatusText: String?
    public var sentAtMs: Int64?
    public var snapshotId: String?

    public init(
        gatewayStatusText: String,
        gatewayConnected: Bool,
        agentName: String,
        agentAvatarURL: String? = nil,
        agentAvatarText: String? = nil,
        sessionKey: String,
        gatewayStableID: String? = nil,
        talkStatusText: String,
        talkEnabled: Bool,
        talkListening: Bool,
        talkSpeaking: Bool,
        pendingApprovalCount: Int,
        chatItems: [OpenClawWatchChatItem]? = nil,
        chatStatusText: String? = nil,
        sentAtMs: Int64? = nil,
        snapshotId: String? = nil)
    {
        self.type = .appSnapshot
        self.gatewayStatusText = gatewayStatusText
        self.gatewayConnected = gatewayConnected
        self.agentName = agentName
        self.agentAvatarURL = agentAvatarURL
        self.agentAvatarText = agentAvatarText
        self.sessionKey = sessionKey
        self.gatewayStableID = gatewayStableID
        self.talkStatusText = talkStatusText
        self.talkEnabled = talkEnabled
        self.talkListening = talkListening
        self.talkSpeaking = talkSpeaking
        self.pendingApprovalCount = pendingApprovalCount
        self.chatItems = chatItems
        self.chatStatusText = chatStatusText
        self.sentAtMs = sentAtMs
        self.snapshotId = snapshotId
    }
}

public struct OpenClawWatchAppSnapshotRequestMessage: Codable, Sendable, Equatable {
    public var type: OpenClawWatchPayloadType
    public var requestId: String
    public var sentAtMs: Int64?

    public init(requestId: String, sentAtMs: Int64? = nil) {
        self.type = .appSnapshotRequest
        self.requestId = requestId
        self.sentAtMs = sentAtMs
    }
}

public enum OpenClawWatchAppCommand: String, Codable, Sendable, Equatable {
    case refresh
    case openChat = "open-chat"
    case sendChat = "send-chat"
    case startTalk = "start-talk"
    case stopTalk = "stop-talk"
}

public struct OpenClawWatchAppCommandMessage: Codable, Sendable, Equatable {
    public var type: OpenClawWatchPayloadType
    public var command: OpenClawWatchAppCommand
    public var commandId: String
    public var sessionKey: String?
    public var gatewayStableID: String?
    public var text: String?
    public var sentAtMs: Int64?

    public init(
        command: OpenClawWatchAppCommand,
        commandId: String,
        sessionKey: String? = nil,
        gatewayStableID: String? = nil,
        text: String? = nil,
        sentAtMs: Int64? = nil)
    {
        self.type = .appCommand
        self.command = command
        self.commandId = commandId
        self.sessionKey = sessionKey
        self.gatewayStableID = gatewayStableID
        self.text = text
        self.sentAtMs = sentAtMs
    }
}

public struct OpenClawWatchStatusPayload: Codable, Sendable, Equatable {
    public var supported: Bool
    public var paired: Bool
    public var appInstalled: Bool
    public var reachable: Bool
    public var activationState: String

    public init(
        supported: Bool,
        paired: Bool,
        appInstalled: Bool,
        reachable: Bool,
        activationState: String)
    {
        self.supported = supported
        self.paired = paired
        self.appInstalled = appInstalled
        self.reachable = reachable
        self.activationState = activationState
    }
}

public struct OpenClawWatchNotifyParams: Codable, Sendable, Equatable {
    public var title: String
    public var body: String
    public var priority: OpenClawNotificationPriority?
    public var promptId: String?
    public var sessionKey: String?
    public var gatewayStableID: String?
    public var kind: String?
    public var details: String?
    public var expiresAtMs: Int64?
    public var risk: OpenClawWatchRisk?
    public var actions: [OpenClawWatchAction]?

    public init(
        title: String,
        body: String,
        priority: OpenClawNotificationPriority? = nil,
        promptId: String? = nil,
        sessionKey: String? = nil,
        gatewayStableID: String? = nil,
        kind: String? = nil,
        details: String? = nil,
        expiresAtMs: Int64? = nil,
        risk: OpenClawWatchRisk? = nil,
        actions: [OpenClawWatchAction]? = nil)
    {
        self.title = title
        self.body = body
        self.priority = priority
        self.promptId = promptId
        self.sessionKey = sessionKey
        self.gatewayStableID = gatewayStableID
        self.kind = kind
        self.details = details
        self.expiresAtMs = expiresAtMs
        self.risk = risk
        self.actions = actions
    }
}

public struct OpenClawWatchNotifyPayload: Codable, Sendable, Equatable {
    public var deliveredImmediately: Bool
    public var queuedForDelivery: Bool
    public var transport: String

    public init(deliveredImmediately: Bool, queuedForDelivery: Bool, transport: String) {
        self.deliveredImmediately = deliveredImmediately
        self.queuedForDelivery = queuedForDelivery
        self.transport = transport
    }
}
