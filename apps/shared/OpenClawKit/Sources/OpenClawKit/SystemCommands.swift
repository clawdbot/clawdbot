import Foundation

public enum OpenClawSystemCommand: String, Codable, Sendable {
    case run = "system.run"
    case which = "system.which"
    case notify = "system.notify"
    case execApprovalsGet = "system.execApprovals.get"
    case execApprovalsSet = "system.execApprovals.set"
}

public enum OpenClawNotificationPriority: String, Codable, Sendable {
    case passive
    case active
    case timeSensitive
}

public enum OpenClawNotificationDelivery: String, Codable, Sendable {
    case system
    case overlay
    case auto
}

public struct OpenClawSystemRunApprovalFileOperand: Codable, Sendable, Equatable {
    public var argvIndex: Int
    public var path: String
    public var sha256: String

    public init(argvIndex: Int, path: String, sha256: String) {
        self.argvIndex = argvIndex
        self.path = path
        self.sha256 = sha256
    }
}

public struct OpenClawSystemRunApprovalPlan: Codable, Sendable, Equatable {
    public var argv: [String]
    public var cwd: String?
    public var commandText: String
    public var commandPreview: String?
    public var agentId: String?
    public var sessionKey: String?
    public var policySnapshot: OpenClawSystemRunApprovalPolicySnapshot?
    public var mutableFileOperand: OpenClawSystemRunApprovalFileOperand?

    public init(
        argv: [String],
        cwd: String?,
        commandText: String,
        commandPreview: String? = nil,
        agentId: String?,
        sessionKey: String?,
        policySnapshot: OpenClawSystemRunApprovalPolicySnapshot? = nil,
        mutableFileOperand: OpenClawSystemRunApprovalFileOperand? = nil)
    {
        self.argv = argv
        self.cwd = cwd
        self.commandText = commandText
        self.commandPreview = commandPreview
        self.agentId = agentId
        self.sessionKey = sessionKey
        self.policySnapshot = policySnapshot
        self.mutableFileOperand = mutableFileOperand
    }
}

public struct OpenClawSystemRunParams: Codable, Sendable, Equatable {
    public var command: [String]
    public var rawCommand: String?
    public var cwd: String?
    public var env: [String: String]?
    public var timeoutMs: Int?
    public var needsScreenRecording: Bool?
    public var agentId: String?
    public var sessionKey: String?
    public var runId: String?
    public var systemRunPlan: OpenClawSystemRunApprovalPlan?
    public var approved: Bool?
    public var approvalDecision: String?
    public var approvalSource: String?

    public init(
        command: [String],
        rawCommand: String? = nil,
        cwd: String? = nil,
        env: [String: String]? = nil,
        timeoutMs: Int? = nil,
        needsScreenRecording: Bool? = nil,
        agentId: String? = nil,
        sessionKey: String? = nil,
        runId: String? = nil,
        systemRunPlan: OpenClawSystemRunApprovalPlan? = nil,
        approved: Bool? = nil,
        approvalDecision: String? = nil,
        approvalSource: String? = nil)
    {
        self.command = command
        self.rawCommand = rawCommand
        self.cwd = cwd
        self.env = env
        self.timeoutMs = timeoutMs
        self.needsScreenRecording = needsScreenRecording
        self.agentId = agentId
        self.sessionKey = sessionKey
        self.runId = runId
        self.systemRunPlan = systemRunPlan
        self.approved = approved
        self.approvalDecision = approvalDecision
        self.approvalSource = approvalSource
    }
}

public struct OpenClawSystemWhichParams: Codable, Sendable, Equatable {
    public var bins: [String]

    public init(bins: [String]) {
        self.bins = bins
    }
}

public struct OpenClawSystemNotifyParams: Codable, Sendable, Equatable {
    public var title: String
    public var body: String
    public var sound: String?
    public var priority: OpenClawNotificationPriority?
    public var delivery: OpenClawNotificationDelivery?

    public init(
        title: String,
        body: String,
        sound: String? = nil,
        priority: OpenClawNotificationPriority? = nil,
        delivery: OpenClawNotificationDelivery? = nil)
    {
        self.title = title
        self.body = body
        self.sound = sound
        self.priority = priority
        self.delivery = delivery
    }
}
