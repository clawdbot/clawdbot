import Foundation
import OpenClawKit

enum WatchMessagingPayloadCodec {
    private static let durableSnapshotTypes = [
        OpenClawWatchPayloadType.appSnapshot.rawValue,
        OpenClawWatchPayloadType.execApprovalSnapshot.rawValue,
    ]

    static let completedChatReplyTextLimit = 4000

    static func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }

    static func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    static func encodeNotificationPayload(
        id: String,
        params: OpenClawWatchNotifyParams,
        gatewayStableID: String?) -> [String: Any]
    {
        var payload: [String: Any] = [
            "type": OpenClawWatchPayloadType.notify.rawValue,
            "id": id,
            "title": params.title,
            "body": params.body,
            "priority": params.priority?.rawValue ?? OpenClawNotificationPriority.active.rawValue,
            "sentAtMs": self.nowMs(),
        ]
        if let promptId = nonEmpty(params.promptId) {
            payload["promptId"] = promptId
        }
        if let sessionKey = nonEmpty(params.sessionKey) {
            payload["sessionKey"] = sessionKey
        }
        if let gatewayStableID = nonEmpty(gatewayStableID) {
            payload["gatewayStableID"] = gatewayStableID
        }
        if let kind = nonEmpty(params.kind) {
            payload["kind"] = kind
        }
        if let details = nonEmpty(params.details) {
            payload["details"] = details
        }
        if let expiresAtMs = params.expiresAtMs {
            payload["expiresAtMs"] = expiresAtMs
        }
        if let risk = params.risk {
            payload["risk"] = risk.rawValue
        }
        if let actions = params.actions, !actions.isEmpty {
            payload["actions"] = actions.map { action in
                var encoded: [String: Any] = [
                    "id": action.id,
                    "label": action.label,
                ]
                if let style = nonEmpty(action.style) {
                    encoded["style"] = style
                }
                return encoded
            }
        }
        return payload
    }

    static func encodeDirectNodeSetupPayload(setupCode: String) -> [String: Any] {
        [
            "type": OpenClawWatchPayloadType.directNodeSetup.rawValue,
            "setupCode": setupCode,
            "sentAtMs": self.nowMs(),
        ]
    }

    static func encodeExecApprovalItem(_ item: OpenClawWatchExecApprovalItem) -> [String: Any] {
        var payload: [String: Any] = [
            "id": item.id,
            "commandText": item.commandText,
            "allowedDecisions": item.allowedDecisions.map(\.rawValue),
        ]
        if let gatewayStableID = nonEmpty(item.gatewayStableID) {
            payload["gatewayStableID"] = gatewayStableID
        }
        if let commandPreview = nonEmpty(item.commandPreview) {
            payload["commandPreview"] = commandPreview
        }
        if let host = nonEmpty(item.host) {
            payload["host"] = host
        }
        if let nodeId = nonEmpty(item.nodeId) {
            payload["nodeId"] = nodeId
        }
        if let agentId = nonEmpty(item.agentId) {
            payload["agentId"] = agentId
        }
        if let expiresAtMs = item.expiresAtMs {
            payload["expiresAtMs"] = expiresAtMs
        }
        if let risk = item.risk {
            payload["risk"] = risk.rawValue
        }
        return payload
    }

    static func encodeExecApprovalPromptPayload(
        _ message: OpenClawWatchExecApprovalPromptMessage) -> [String: Any]
    {
        var payload: [String: Any] = [
            "type": OpenClawWatchPayloadType.execApprovalPrompt.rawValue,
            "approval": self.encodeExecApprovalItem(message.approval),
        ]
        if let sentAtMs = message.sentAtMs {
            payload["sentAtMs"] = sentAtMs
        }
        if let deliveryId = nonEmpty(message.deliveryId) {
            payload["deliveryId"] = deliveryId
        }
        if message.resetResolvingState == true {
            payload["resetResolvingState"] = true
        }
        return payload
    }

    static func encodeExecApprovalResolvedPayload(
        _ message: OpenClawWatchExecApprovalResolvedMessage) -> [String: Any]
    {
        var payload: [String: Any] = [
            "type": OpenClawWatchPayloadType.execApprovalResolved.rawValue,
            "approvalId": message.approvalId,
        ]
        if let gatewayStableID = nonEmpty(message.gatewayStableID) {
            payload["gatewayStableID"] = gatewayStableID
        }
        if let decision = message.decision {
            payload["decision"] = decision.rawValue
        }
        if let resolvedAtMs = message.resolvedAtMs {
            payload["resolvedAtMs"] = resolvedAtMs
        }
        if let source = nonEmpty(message.source) {
            payload["source"] = source
        }
        return payload
    }

    static func encodeExecApprovalExpiredPayload(
        _ message: OpenClawWatchExecApprovalExpiredMessage) -> [String: Any]
    {
        var payload: [String: Any] = [
            "type": OpenClawWatchPayloadType.execApprovalExpired.rawValue,
            "approvalId": message.approvalId,
            "reason": message.reason.rawValue,
        ]
        if let gatewayStableID = nonEmpty(message.gatewayStableID) {
            payload["gatewayStableID"] = gatewayStableID
        }
        if let expiredAtMs = message.expiredAtMs {
            payload["expiredAtMs"] = expiredAtMs
        }
        return payload
    }

    static func encodeExecApprovalSnapshotPayload(
        _ message: OpenClawWatchExecApprovalSnapshotMessage) -> [String: Any]
    {
        var payload: [String: Any] = [
            "type": OpenClawWatchPayloadType.execApprovalSnapshot.rawValue,
            "approvals": message.approvals.map(self.encodeExecApprovalItem),
        ]
        if let gatewayStableID = nonEmpty(message.gatewayStableID) {
            payload["gatewayStableID"] = gatewayStableID
        }
        if let sentAtMs = message.sentAtMs {
            payload["sentAtMs"] = sentAtMs
        }
        if let snapshotId = nonEmpty(message.snapshotId) {
            payload["snapshotId"] = snapshotId
        }
        return payload
    }

    static func encodeAppSnapshotPayload(
        _ message: OpenClawWatchAppSnapshotMessage) -> [String: Any]
    {
        var payload: [String: Any] = [
            "type": OpenClawWatchPayloadType.appSnapshot.rawValue,
            "gatewayStatusText": message.gatewayStatusText,
            "gatewayConnected": message.gatewayConnected,
            "agentName": message.agentName,
            "sessionKey": message.sessionKey,
            "talkStatusText": message.talkStatusText,
            "talkEnabled": message.talkEnabled,
            "talkListening": message.talkListening,
            "talkSpeaking": message.talkSpeaking,
            "pendingApprovalCount": message.pendingApprovalCount,
        ]
        if let agentAvatarURL = nonEmpty(message.agentAvatarURL) {
            payload["agentAvatarUrl"] = agentAvatarURL
        }
        if let agentAvatarText = nonEmpty(message.agentAvatarText) {
            payload["agentAvatarText"] = agentAvatarText
        }
        if let gatewayStableID = nonEmpty(message.gatewayStableID) {
            payload["gatewayStableID"] = gatewayStableID
        }
        if let sentAtMs = message.sentAtMs {
            payload["sentAtMs"] = sentAtMs
        }
        if let chatItems = message.chatItems {
            payload["chatItems"] = chatItems.map { item in
                var encoded: [String: Any] = [
                    "id": item.id,
                    "role": item.role,
                    "text": item.text,
                ]
                if let timestampMs = item.timestampMs {
                    encoded["timestampMs"] = timestampMs
                }
                return encoded
            }
        }
        if let chatStatusText = nonEmpty(message.chatStatusText) {
            payload["chatStatusText"] = chatStatusText
        }
        if let snapshotId = nonEmpty(message.snapshotId) {
            payload["snapshotId"] = snapshotId
        }
        return payload
    }

    static func encodeSnapshotApplicationContext(
        _ payload: [String: Any],
        merging existingContext: [String: Any]) -> [String: Any]
    {
        guard let payloadType = payload["type"] as? String,
              self.durableSnapshotTypes.contains(payloadType)
        else {
            return payload
        }

        // updateApplicationContext retains one dictionary. Nest both logical snapshots while
        // keeping the newest one at the top level for older Watch app versions.
        var context = payload
        for snapshotType in self.durableSnapshotTypes {
            if snapshotType == payloadType {
                context[snapshotType] = payload
            } else if let previous = existingContext[snapshotType] as? [String: Any] {
                context[snapshotType] = previous
            } else if existingContext["type"] as? String == snapshotType {
                context[snapshotType] = existingContext
            }
        }
        return context
    }

    static func encodeChatCompletionPayload(
        _ message: OpenClawWatchChatCompletionMessage) -> [String: Any]
    {
        [
            "type": message.type.rawValue,
            "commandId": message.commandId,
            "replyText": self.truncatedCompletedChatReplyText(message.replyText),
            "sentAtMs": message.sentAtMs ?? self.nowMs(),
        ]
    }

    private static func truncatedCompletedChatReplyText(_ text: String) -> String {
        guard text.count > self.completedChatReplyTextLimit else { return text }
        return "\(text.prefix(self.completedChatReplyTextLimit - 3))..."
    }

    static func parseQuickReplyPayload(
        _ payload: [String: Any],
        transport: String) -> WatchQuickReplyEvent?
    {
        guard (payload["type"] as? String) == OpenClawWatchPayloadType.reply.rawValue else {
            return nil
        }
        guard let actionId = nonEmpty(payload["actionId"] as? String) else {
            return nil
        }
        let promptId = self.nonEmpty(payload["promptId"] as? String) ?? "unknown"
        let replyId = self.nonEmpty(payload["replyId"] as? String) ?? UUID().uuidString
        let actionLabel = self.nonEmpty(payload["actionLabel"] as? String)
        let sessionKey = self.nonEmpty(payload["sessionKey"] as? String)
        let gatewayStableID = self.nonEmpty(payload["gatewayStableID"] as? String)
        let note = self.nonEmpty(payload["note"] as? String)
        let sentAtMs = (payload["sentAtMs"] as? NSNumber)?.int64Value

        return WatchQuickReplyEvent(
            replyId: replyId,
            promptId: promptId,
            actionId: actionId,
            actionLabel: actionLabel,
            sessionKey: sessionKey,
            gatewayStableID: gatewayStableID,
            note: note,
            sentAtMs: sentAtMs,
            transport: transport)
    }

    static func parseExecApprovalResolvePayload(
        _ payload: [String: Any],
        transport: String) -> WatchExecApprovalResolveEvent?
    {
        guard (payload["type"] as? String) == OpenClawWatchPayloadType.execApprovalResolve.rawValue else {
            return nil
        }
        guard let approvalId = nonEmpty(payload["approvalId"] as? String),
              let rawDecision = nonEmpty(payload["decision"] as? String),
              let decision = OpenClawWatchExecApprovalDecision(rawValue: rawDecision)
        else {
            return nil
        }
        let replyId = self.nonEmpty(payload["replyId"] as? String) ?? UUID().uuidString
        let gatewayStableID = self.nonEmpty(payload["gatewayStableID"] as? String)
        let sentAtMs = (payload["sentAtMs"] as? NSNumber)?.int64Value
        return WatchExecApprovalResolveEvent(
            replyId: replyId,
            approvalId: approvalId,
            gatewayStableID: gatewayStableID,
            decision: decision,
            sentAtMs: sentAtMs,
            transport: transport)
    }

    static func parseExecApprovalSnapshotRequestPayload(
        _ payload: [String: Any],
        transport: String) -> WatchExecApprovalSnapshotRequestEvent?
    {
        guard (payload["type"] as? String) == OpenClawWatchPayloadType.execApprovalSnapshotRequest.rawValue else {
            return nil
        }
        let requestId = self.nonEmpty(payload["requestId"] as? String) ?? UUID().uuidString
        let sentAtMs = (payload["sentAtMs"] as? NSNumber)?.int64Value
        return WatchExecApprovalSnapshotRequestEvent(
            requestId: requestId,
            sentAtMs: sentAtMs,
            transport: transport)
    }

    static func parseAppSnapshotRequestPayload(
        _ payload: [String: Any],
        transport: String) -> WatchAppSnapshotRequestEvent?
    {
        guard (payload["type"] as? String) == OpenClawWatchPayloadType.appSnapshotRequest.rawValue else {
            return nil
        }
        let requestId = self.nonEmpty(payload["requestId"] as? String) ?? UUID().uuidString
        let sentAtMs = (payload["sentAtMs"] as? NSNumber)?.int64Value
        return WatchAppSnapshotRequestEvent(
            requestId: requestId,
            sentAtMs: sentAtMs,
            transport: transport)
    }

    static func parseAppCommandPayload(
        _ payload: [String: Any],
        transport: String) -> WatchAppCommandEvent?
    {
        guard (payload["type"] as? String) == OpenClawWatchPayloadType.appCommand.rawValue else {
            return nil
        }
        guard let rawCommand = nonEmpty(payload["command"] as? String),
              let command = OpenClawWatchAppCommand(rawValue: rawCommand)
        else {
            return nil
        }
        let commandId = self.nonEmpty(payload["commandId"] as? String) ?? UUID().uuidString
        let sessionKey = self.nonEmpty(payload["sessionKey"] as? String)
        let gatewayStableID = self.nonEmpty(payload["gatewayStableID"] as? String)
        let text = self.nonEmpty(payload["text"] as? String)
        let sentAtMs = (payload["sentAtMs"] as? NSNumber)?.int64Value
        return WatchAppCommandEvent(
            commandId: commandId,
            command: command,
            sessionKey: sessionKey,
            gatewayStableID: gatewayStableID,
            text: text,
            sentAtMs: sentAtMs,
            transport: transport)
    }
}
