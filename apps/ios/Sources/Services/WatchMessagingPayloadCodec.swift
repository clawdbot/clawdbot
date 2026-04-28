import Foundation
import OpenClawKit

enum WatchMessagingPayloadCodec {
    static func nowMs() -> Int {
        Int(Date().timeIntervalSince1970 * 1000)
    }

    static func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    static func encodeNotificationPayload(
        id: String,
        params: OpenClawWatchNotifyParams) -> [String: Any]
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

    static func encodeExecApprovalItem(_ item: OpenClawWatchExecApprovalItem) -> [String: Any] {
        var payload: [String: Any] = [
            "id": item.id,
            "commandText": item.commandText,
            "allowedDecisions": item.allowedDecisions.map(\.rawValue),
        ]
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
        if let sentAtMs = message.sentAtMs {
            payload["sentAtMs"] = sentAtMs
        }
        if let snapshotId = nonEmpty(message.snapshotId) {
            payload["snapshotId"] = snapshotId
        }
        return payload
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
        let note = self.nonEmpty(payload["note"] as? String)
        let sentAtMs = (payload["sentAtMs"] as? Int) ?? (payload["sentAtMs"] as? NSNumber)?.intValue

        return WatchQuickReplyEvent(
            replyId: replyId,
            promptId: promptId,
            actionId: actionId,
            actionLabel: actionLabel,
            sessionKey: sessionKey,
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
        let sentAtMs = (payload["sentAtMs"] as? Int) ?? (payload["sentAtMs"] as? NSNumber)?.intValue
        return WatchExecApprovalResolveEvent(
            replyId: replyId,
            approvalId: approvalId,
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
        let sentAtMs = (payload["sentAtMs"] as? Int) ?? (payload["sentAtMs"] as? NSNumber)?.intValue
        return WatchExecApprovalSnapshotRequestEvent(
            requestId: requestId,
            sentAtMs: sentAtMs,
            transport: transport)
    }
}
