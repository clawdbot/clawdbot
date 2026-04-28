import Foundation
import WatchConnectivity

struct WatchReplyDraft {
    var replyId: String
    var promptId: String
    var actionId: String
    var actionLabel: String?
    var sessionKey: String?
    var note: String?
    var sentAtMs: Int
}

struct WatchReplySendResult: Equatable {
    var deliveredImmediately: Bool
    var queuedForDelivery: Bool
    var transport: String
    var errorMessage: String?
}

final class WatchConnectivityReceiver: NSObject, @unchecked Sendable {
    private typealias MessageSendContinuation = CheckedContinuation<Void, Error>

    private let store: WatchInboxStore
    private let session: WCSession?

    init(store: WatchInboxStore) {
        self.store = store
        if WCSession.isSupported() {
            self.session = WCSession.default
        } else {
            self.session = nil
        }
        super.init()
    }

    func activate() {
        guard let session = self.session else { return }
        session.delegate = self
        session.activate()
    }

    private func ensureActivated() async {
        guard let session = self.session else { return }
        if session.activationState == .activated {
            return
        }
        session.activate()
        for _ in 0..<8 {
            if session.activationState == .activated {
                return
            }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    func requestExecApprovalSnapshot() async {
        await self.ensureActivated()
        guard let session = self.session else { return }
        let request = WatchExecApprovalSnapshotRequestMessage(
            requestId: UUID().uuidString,
            sentAtMs: Self.nowMs())
        let payload = Self.encodeSnapshotRequestPayload(request)
        if session.isReachable {
            do {
                try await Self.sendMessage(payload, through: session)
                return
            } catch {
                // Fall through to queued delivery.
            }
        }
        _ = session.transferUserInfo(payload)
    }

    func sendReply(_ draft: WatchReplyDraft) async -> WatchReplySendResult {
        await self.ensureActivated()
        guard let session = self.session else {
            return WatchReplySendResult(
                deliveredImmediately: false,
                queuedForDelivery: false,
                transport: "none",
                errorMessage: "watch session unavailable")
        }

        var payload: [String: Any] = [
            "type": WatchPayloadType.reply.rawValue,
            "replyId": draft.replyId,
            "promptId": draft.promptId,
            "actionId": draft.actionId,
            "sentAtMs": draft.sentAtMs,
        ]
        if let actionLabel = draft.actionLabel?.trimmingCharacters(in: .whitespacesAndNewlines),
           !actionLabel.isEmpty
        {
            payload["actionLabel"] = actionLabel
        }
        if let sessionKey = draft.sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines),
           !sessionKey.isEmpty
        {
            payload["sessionKey"] = sessionKey
        }
        if let note = draft.note?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty {
            payload["note"] = note
        }

        return await self.sendPayload(payload, session: session)
    }

    func sendExecApprovalResolve(
        approvalId: String,
        decision: WatchExecApprovalDecision) async -> WatchReplySendResult
    {
        await self.ensureActivated()
        guard let session = self.session else {
            return WatchReplySendResult(
                deliveredImmediately: false,
                queuedForDelivery: false,
                transport: "none",
                errorMessage: "watch session unavailable")
        }

        let payload = Self.encodeExecApprovalResolvePayload(
            WatchExecApprovalResolveMessage(
                approvalId: approvalId,
                decision: decision,
                replyId: UUID().uuidString,
                sentAtMs: Self.nowMs()))
        return await self.sendPayload(payload, session: session)
    }

    private func sendPayload(_ payload: [String: Any], session: WCSession) async -> WatchReplySendResult {
        if session.isReachable {
            do {
                try await Self.sendMessage(payload, through: session)
                return WatchReplySendResult(
                    deliveredImmediately: true,
                    queuedForDelivery: false,
                    transport: "sendMessage",
                    errorMessage: nil)
            } catch {
                // Fall through to queued delivery below.
            }
        }

        _ = session.transferUserInfo(payload)
        return WatchReplySendResult(
            deliveredImmediately: false,
            queuedForDelivery: true,
            transport: "transferUserInfo",
            errorMessage: nil)
    }

    private static func sendMessage(_ payload: [String: Any], through session: WCSession) async throws {
        try await withCheckedThrowingContinuation(isolation: nil) { (continuation: MessageSendContinuation) in
            session.sendMessage(
                payload,
                replyHandler: { _ in continuation.resume(returning: ()) },
                errorHandler: { error in continuation.resume(throwing: error) })
        }
    }

    private static func nowMs() -> Int {
        Int(Date().timeIntervalSince1970 * 1000)
    }

    private static func normalizeObject(_ value: Any) -> [String: Any]? {
        if let object = value as? [String: Any] {
            return object
        }
        if let object = value as? [AnyHashable: Any] {
            var normalized: [String: Any] = [:]
            normalized.reserveCapacity(object.count)
            for (key, item) in object {
                guard let stringKey = key as? String else {
                    continue
                }
                normalized[stringKey] = item
            }
            return normalized
        }
        return nil
    }

    private static func parseActions(_ value: Any?) -> [WatchPromptAction] {
        guard let raw = value as? [Any] else {
            return []
        }
        return raw.compactMap { item in
            guard let obj = Self.normalizeObject(item) else {
                return nil
            }
            let id = (obj["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let label = (obj["label"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !id.isEmpty, !label.isEmpty else {
                return nil
            }
            let style = (obj["style"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            return WatchPromptAction(id: id, label: label, style: style)
        }
    }

    private static func parseNotificationPayload(_ payload: [String: Any]) -> WatchNotifyMessage? {
        guard let type = payload["type"] as? String,
              type == WatchPayloadType.notify.rawValue
        else {
            return nil
        }

        let title = (payload["title"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let body = (payload["body"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        guard title.isEmpty == false || body.isEmpty == false else {
            return nil
        }

        let id = (payload["id"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let sentAtMs = (payload["sentAtMs"] as? Int) ?? (payload["sentAtMs"] as? NSNumber)?.intValue
        let promptId = (payload["promptId"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let sessionKey = (payload["sessionKey"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let kind = (payload["kind"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let details = (payload["details"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let expiresAtMs = (payload["expiresAtMs"] as? Int) ?? (payload["expiresAtMs"] as? NSNumber)?.intValue
        let risk = (payload["risk"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let actions = Self.parseActions(payload["actions"])

        return WatchNotifyMessage(
            id: id,
            title: title,
            body: body,
            sentAtMs: sentAtMs,
            promptId: promptId,
            sessionKey: sessionKey,
            kind: kind,
            details: details,
            expiresAtMs: expiresAtMs,
            risk: risk,
            actions: actions)
    }

    private static func parseExecApprovalDecision(_ value: Any?) -> WatchExecApprovalDecision? {
        let raw = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return WatchExecApprovalDecision(rawValue: raw)
    }

    private static func parseExecApprovalItem(_ value: Any?) -> WatchExecApprovalItem? {
        guard let payload = value.flatMap(normalizeObject) else {
            return nil
        }
        let id = (payload["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let commandText = (payload["commandText"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !id.isEmpty, !commandText.isEmpty else {
            return nil
        }
        let commandPreview = (payload["commandPreview"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let host = (payload["host"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let nodeId = (payload["nodeId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let agentId = (payload["agentId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let expiresAtMs = (payload["expiresAtMs"] as? Int) ?? (payload["expiresAtMs"] as? NSNumber)?.intValue
        let riskRaw = (payload["risk"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let risk = WatchRiskLevel(rawValue: riskRaw)
        let allowedDecisions = (payload["allowedDecisions"] as? [Any] ?? []).compactMap {
            Self.parseExecApprovalDecision($0)
        }
        return WatchExecApprovalItem(
            id: id,
            commandText: commandText,
            commandPreview: commandPreview,
            host: host,
            nodeId: nodeId,
            agentId: agentId,
            expiresAtMs: expiresAtMs,
            allowedDecisions: allowedDecisions,
            risk: risk)
    }

    private static func parseExecApprovalPromptPayload(
        _ payload: [String: Any]) -> WatchExecApprovalPromptMessage?
    {
        guard let type = payload["type"] as? String,
              type == WatchPayloadType.execApprovalPrompt.rawValue,
              let approval = parseExecApprovalItem(payload["approval"])
        else {
            return nil
        }
        let sentAtMs = (payload["sentAtMs"] as? Int) ?? (payload["sentAtMs"] as? NSNumber)?.intValue
        let deliveryId = (payload["deliveryId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resetResolvingState = payload["resetResolvingState"] as? Bool
        return WatchExecApprovalPromptMessage(
            approval: approval,
            sentAtMs: sentAtMs,
            deliveryId: deliveryId,
            resetResolvingState: resetResolvingState)
    }

    private static func parseExecApprovalResolvedPayload(
        _ payload: [String: Any]) -> WatchExecApprovalResolvedMessage?
    {
        guard let type = payload["type"] as? String,
              type == WatchPayloadType.execApprovalResolved.rawValue
        else {
            return nil
        }
        let approvalId = (payload["approvalId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !approvalId.isEmpty else { return nil }
        let decision = Self.parseExecApprovalDecision(payload["decision"])
        let resolvedAtMs = (payload["resolvedAtMs"] as? Int)
            ?? (payload["resolvedAtMs"] as? NSNumber)?.intValue
        let source = (payload["source"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return WatchExecApprovalResolvedMessage(
            approvalId: approvalId,
            decision: decision,
            resolvedAtMs: resolvedAtMs,
            source: source)
    }

    private static func parseExecApprovalExpiredPayload(
        _ payload: [String: Any]) -> WatchExecApprovalExpiredMessage?
    {
        guard let type = payload["type"] as? String,
              type == WatchPayloadType.execApprovalExpired.rawValue
        else {
            return nil
        }
        let approvalId = (payload["approvalId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let rawReason = (payload["reason"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !approvalId.isEmpty,
              let reason = WatchExecApprovalCloseReason(rawValue: rawReason)
        else {
            return nil
        }
        let expiredAtMs = (payload["expiredAtMs"] as? Int) ?? (payload["expiredAtMs"] as? NSNumber)?.intValue
        return WatchExecApprovalExpiredMessage(
            approvalId: approvalId,
            reason: reason,
            expiredAtMs: expiredAtMs)
    }

    private static func parseExecApprovalSnapshotPayload(
        _ payload: [String: Any]) -> WatchExecApprovalSnapshotMessage?
    {
        guard let type = payload["type"] as? String,
              type == WatchPayloadType.execApprovalSnapshot.rawValue
        else {
            return nil
        }
        let approvals = (payload["approvals"] as? [Any] ?? []).compactMap { item in
            Self.parseExecApprovalItem(item)
        }
        let sentAtMs = (payload["sentAtMs"] as? Int) ?? (payload["sentAtMs"] as? NSNumber)?.intValue
        let snapshotId = (payload["snapshotId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return WatchExecApprovalSnapshotMessage(
            approvals: approvals,
            sentAtMs: sentAtMs,
            snapshotId: snapshotId)
    }

    private static func encodeSnapshotRequestPayload(
        _ request: WatchExecApprovalSnapshotRequestMessage) -> [String: Any]
    {
        var payload: [String: Any] = [
            "type": WatchPayloadType.execApprovalSnapshotRequest.rawValue,
            "requestId": request.requestId,
        ]
        if let sentAtMs = request.sentAtMs {
            payload["sentAtMs"] = sentAtMs
        }
        return payload
    }

    private static func encodeExecApprovalResolvePayload(
        _ message: WatchExecApprovalResolveMessage) -> [String: Any]
    {
        var payload: [String: Any] = [
            "type": WatchPayloadType.execApprovalResolve.rawValue,
            "approvalId": message.approvalId,
            "decision": message.decision.rawValue,
            "replyId": message.replyId,
        ]
        if let sentAtMs = message.sentAtMs {
            payload["sentAtMs"] = sentAtMs
        }
        return payload
    }
}

extension WatchConnectivityReceiver: WCSessionDelegate {
    func session(
        _: WCSession,
        activationDidCompleteWith _: WCSessionActivationState,
        error _: (any Error)?)
    {
        Task {
            await self.requestExecApprovalSnapshot()
        }
    }

    func session(_: WCSession, didReceiveMessage message: [String: Any]) {
        self.consumeIncomingPayload(message, transport: "sendMessage")
    }

    func session(
        _: WCSession,
        didReceiveMessage message: [String: Any],
        replyHandler: @escaping ([String: Any]) -> Void)
    {
        replyHandler(["ok": true])
        self.consumeIncomingPayload(message, transport: "sendMessage")
    }

    func session(_: WCSession, didReceiveUserInfo userInfo: [String: Any]) {
        self.consumeIncomingPayload(userInfo, transport: "transferUserInfo")
    }

    func session(_: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        self.consumeIncomingPayload(applicationContext, transport: "applicationContext")
    }

    private func consumeIncomingPayload(_ payload: [String: Any], transport: String) {
        if let incoming = Self.parseNotificationPayload(payload) {
            Task { @MainActor in
                self.store.consume(message: incoming, transport: transport)
            }
            return
        }
        if let prompt = Self.parseExecApprovalPromptPayload(payload) {
            Task { @MainActor in
                self.store.consume(execApprovalPrompt: prompt, transport: transport)
            }
            return
        }
        if let resolved = Self.parseExecApprovalResolvedPayload(payload) {
            Task { @MainActor in
                self.store.consume(execApprovalResolved: resolved)
            }
            return
        }
        if let expired = Self.parseExecApprovalExpiredPayload(payload) {
            Task { @MainActor in
                self.store.consume(execApprovalExpired: expired)
            }
            return
        }
        if let snapshot = Self.parseExecApprovalSnapshotPayload(payload) {
            Task { @MainActor in
                self.store.consume(execApprovalSnapshot: snapshot, transport: transport)
            }
        }
    }
}
