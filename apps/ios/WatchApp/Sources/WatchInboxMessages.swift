import Foundation

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

struct WatchOpaqueUTF8Key: Hashable, Sendable {
    fileprivate let bytes: [UInt8]

    init(_ rawValue: String) {
        self.bytes = Array(rawValue.utf8)
    }

    var notificationComponent: String {
        let hexDigits = Array("0123456789ABCDEF".utf8)
        var encoded: [UInt8] = []
        encoded.reserveCapacity(self.bytes.count)
        for byte in self.bytes {
            switch byte {
            case 0x30...0x39, 0x41...0x5A, 0x61...0x7A, 0x2D, 0x5F, 0x7E:
                encoded.append(byte)
            default:
                encoded.append(0x25)
                encoded.append(hexDigits[Int(byte >> 4)])
                encoded.append(hexDigits[Int(byte & 0x0F)])
            }
        }
        guard let component = String(bytes: encoded, encoding: .utf8) else {
            preconditionFailure("Percent-encoded approval ID must be UTF-8")
        }
        return component
    }
}

enum WatchApprovalID {
    typealias Key = WatchOpaqueUTF8Key

    /// Approval IDs are opaque protocol values. Validate without trimming or normalization.
    static func exact(_ value: String?) -> String? {
        guard let value,
              !value.isEmpty,
              value != ".",
              value != ".."
        else { return nil }
        let codeUnits = Array(value.utf16)
        var index = 0
        while index < codeUnits.count {
            let codeUnit = codeUnits[index]
            if (0xD800...0xDBFF).contains(codeUnit) {
                guard index + 1 < codeUnits.count,
                      (0xDC00...0xDFFF).contains(codeUnits[index + 1])
                else { return nil }
                index += 2
                continue
            }
            guard !(0xDC00...0xDFFF).contains(codeUnit) else { return nil }
            index += 1
        }
        return value
    }

    static func key(_ value: String?) -> Key? {
        self.exact(value).map(Key.init)
    }
}

enum WatchGatewayID {
    typealias Key = WatchOpaqueUTF8Key

    static func exact(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }

    static func key(_ value: String?) -> Key? {
        self.exact(value).map(Key.init)
    }
}

struct WatchExecApprovalIdentityKey: Hashable, Sendable {
    var gatewayID: WatchGatewayID.Key
    var approvalID: WatchApprovalID.Key
}

struct WatchExecApprovalItem: Codable, Equatable {
    var id: String
    var gatewayStableID: String?
    var commandText: String
    var commandPreview: String?
    var warningText: String?
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

struct WatchExecApprovalSnapshotRequestMessage: Codable, Equatable, Sendable {
    var requestId: String
    var sentAtMs: Int64?
    var gatewayStableID: String?
    var heldApprovals: [WatchExecApprovalSnapshotRequestItem]

    init(
        requestId: String,
        sentAtMs: Int64? = nil,
        gatewayStableID: String? = nil,
        heldApprovals: [WatchExecApprovalSnapshotRequestItem] = [])
    {
        self.requestId = requestId
        self.sentAtMs = sentAtMs
        self.gatewayStableID = gatewayStableID
        self.heldApprovals = heldApprovals
    }
}

struct WatchExecApprovalSnapshotRequestItem: Codable, Equatable, Sendable {
    var approvalId: String
    var activeResolutionAttemptId: String?
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
