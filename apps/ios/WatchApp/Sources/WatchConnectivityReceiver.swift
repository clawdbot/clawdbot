import Foundation
import WatchConnectivity

struct WatchReplyDraft {
    var replyId: String
    var promptId: String
    var actionId: String
    var actionLabel: String?
    var sessionKey: String?
    var gatewayStableID: String?
    var note: String?
    var sentAtMs: Int64
}

enum WatchReplyDeliveryState: Equatable {
    case delivered
    case queued
    case notSent
}

struct WatchReplySendResult: Equatable {
    var delivery: WatchReplyDeliveryState
    var transport: String
    var errorMessage: String?
    var requiresCanonicalReadback: Bool

    var deliveredImmediately: Bool {
        self.delivery == .delivered
    }

    var queuedForDelivery: Bool {
        self.delivery == .queued
    }
}

struct WatchExecApprovalSnapshotRequestToken: Hashable, Sendable {
    let requestId: String
    let gatewayStableID: String
    private let requestKey: WatchOpaqueUTF8Key
    private let gatewayKey: WatchOpaqueUTF8Key

    init?(requestId: String, gatewayStableID: String?) {
        guard !requestId.isEmpty,
              let gatewayStableID = WatchGatewayID.exact(gatewayStableID)
        else { return nil }
        self.requestId = requestId
        self.gatewayStableID = gatewayStableID
        self.requestKey = WatchOpaqueUTF8Key(requestId)
        self.gatewayKey = WatchOpaqueUTF8Key(gatewayStableID)
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.requestKey == rhs.requestKey && lhs.gatewayKey == rhs.gatewayKey
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(self.requestKey)
        hasher.combine(self.gatewayKey)
    }

    func matchesGatewayStableID(_ gatewayStableID: String?) -> Bool {
        WatchGatewayID.key(gatewayStableID) == self.gatewayKey
    }
}

final class WatchConnectivityReceiver: NSObject, @unchecked Sendable {
    private typealias MessageSendContinuation = CheckedContinuation<Void, Error>
    private static let maxAcceptedExecApprovalSnapshotRequests = 32

    private let store: WatchInboxStore
    private let session: WCSession?
    private let activationGate = WatchSessionActivationGate()
    private let execApprovalSnapshotAcknowledgmentLock = NSLock()
    private var acceptedExecApprovalSnapshotRequests: Set<WatchExecApprovalSnapshotRequestToken> = []
    private var acceptedExecApprovalSnapshotRequestOrder: [WatchExecApprovalSnapshotRequestToken] = []
    private let directNodeSetupHandler: @MainActor @Sendable (String, Int64) -> Void

    init(
        store: WatchInboxStore,
        directNodeSetupHandler: @escaping @MainActor @Sendable (String, Int64) -> Void)
    {
        self.store = store
        self.directNodeSetupHandler = directNodeSetupHandler
        if WCSession.isSupported() {
            self.session = WCSession.default
        } else {
            self.session = nil
        }
        super.init()
    }

    func activate() {
        guard let session else { return }
        session.delegate = self
        self.beginActivation(session)
    }

    private func beginActivation(_ session: WCSession) {
        if self.activationGate.beginActivation() {
            session.activate()
        }
    }

    private func activatedSession() async throws -> WCSession {
        guard let session else {
            throw WatchSessionActivationError.failed("session unavailable")
        }
        if session.activationState == .activated {
            self.activationGate.complete(activated: true, errorDescription: nil)
            return session
        }
        self.beginActivation(session)
        try await self.activationGate.waitUntilActivated()
        guard session.activationState == .activated else {
            throw WatchSessionActivationError.failed("session stayed inactive")
        }
        return session
    }

    @discardableResult
    func requestExecApprovalSnapshot(
        gatewayStableID: String? = nil,
        heldApprovals: [WatchExecApprovalSnapshotRequestItem] = []) async
        -> WatchExecApprovalSnapshotRequestToken?
    {
        guard let session = try? await activatedSession() else { return nil }
        let requestId = UUID().uuidString
        let exactGatewayStableID = WatchGatewayID.exact(gatewayStableID)
        let request = WatchExecApprovalSnapshotRequestMessage(
            requestId: requestId,
            sentAtMs: Self.nowMs(),
            gatewayStableID: exactGatewayStableID,
            heldApprovals: heldApprovals)
        let token = WatchExecApprovalSnapshotRequestToken(
            requestId: requestId,
            gatewayStableID: exactGatewayStableID)
        let payload = Self.encodeSnapshotRequestPayload(request)
        if session.isReachable {
            do {
                try await Self.sendMessage(payload, through: session)
                return token
            } catch {
                // Fall through to queued delivery.
            }
        }
        _ = session.transferUserInfo(payload)
        return token
    }

    func requestAppSnapshot() async -> WatchReplySendResult {
        let session: WCSession
        do {
            session = try await self.activatedSession()
        } catch {
            return Self.unavailableResult(error)
        }
        let request = WatchAppSnapshotRequestMessage(
            requestId: UUID().uuidString,
            sentAtMs: Self.nowMs())
        let payload = Self.encodeAppSnapshotRequestPayload(request)
        return await self.sendPayload(payload, session: session)
    }

    func sendReply(_ draft: WatchReplyDraft) async -> WatchReplySendResult {
        let session: WCSession
        do {
            session = try await self.activatedSession()
        } catch {
            return Self.unavailableResult(error)
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
        if let gatewayStableID = WatchGatewayID.exact(draft.gatewayStableID) {
            payload["gatewayStableID"] = gatewayStableID
        }
        if let note = draft.note?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty {
            payload["note"] = note
        }

        return await self.sendPayload(payload, session: session)
    }

    func sendExecApprovalResolve(
        approvalId: String,
        gatewayStableID: String?,
        attemptID: String,
        decision: WatchExecApprovalDecision) async -> WatchReplySendResult
    {
        let session: WCSession
        do {
            session = try await self.activatedSession()
        } catch {
            return Self.unavailableResult(error)
        }

        let payload = Self.encodeExecApprovalResolvePayload(
            WatchExecApprovalResolveMessage(
                approvalId: approvalId,
                gatewayStableID: gatewayStableID,
                decision: decision,
                replyId: attemptID,
                sentAtMs: Self.nowMs()))
        return await self.sendPayload(payload, session: session)
    }

    func sendAppCommand(_ message: WatchAppCommandMessage) async -> WatchReplySendResult {
        let session: WCSession
        do {
            session = try await self.activatedSession()
        } catch {
            return Self.unavailableResult(error)
        }
        return await self.sendPayload(Self.encodeAppCommandPayload(message), session: session)
    }

    private func sendPayload(_ payload: [String: Any], session: WCSession) async -> WatchReplySendResult {
        var requiresCanonicalReadback = false
        if session.isReachable {
            do {
                try await Self.sendMessage(payload, through: session)
                return WatchReplySendResult(
                    delivery: .delivered,
                    transport: "sendMessage",
                    errorMessage: nil,
                    requiresCanonicalReadback: false)
            } catch {
                // The immediate send may have reached the iPhone before its reply path
                // failed. Queue a durable copy, but require canonical state readback.
                requiresCanonicalReadback = true
                // Fall through to queued delivery below.
            }
        }

        _ = session.transferUserInfo(payload)
        return WatchReplySendResult(
            delivery: .queued,
            transport: "transferUserInfo",
            errorMessage: nil,
            requiresCanonicalReadback: requiresCanonicalReadback)
    }

    private static func sendMessage(_ payload: [String: Any], through session: WCSession) async throws {
        try await withCheckedThrowingContinuation(isolation: nil) { (continuation: MessageSendContinuation) in
            session.sendMessage(
                payload,
                replyHandler: { _ in continuation.resume(returning: ()) },
                errorHandler: { error in continuation.resume(throwing: error) })
        }
    }

    private static func unavailableResult(_ error: any Error) -> WatchReplySendResult {
        // Activation failed before a payload could be handed to WatchConnectivity.
        // The closed notSent state lets callers safely offer an immediate retry.
        WatchReplySendResult(
            delivery: .notSent,
            transport: "none",
            errorMessage: error.localizedDescription,
            requiresCanonicalReadback: false)
    }

    private static func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }

    func consumeExecApprovalSnapshotAcknowledgment(
        for token: WatchExecApprovalSnapshotRequestToken) -> Bool
    {
        self.execApprovalSnapshotAcknowledgmentLock.withLock {
            guard self.acceptedExecApprovalSnapshotRequests.remove(token) != nil else { return false }
            self.acceptedExecApprovalSnapshotRequestOrder.removeAll { $0 == token }
            return true
        }
    }

    func discardExecApprovalSnapshotAcknowledgments(exceptGatewayStableID gatewayStableID: String?) {
        self.execApprovalSnapshotAcknowledgmentLock.withLock {
            self.acceptedExecApprovalSnapshotRequestOrder.removeAll { token in
                !token.matchesGatewayStableID(gatewayStableID)
            }
            self.acceptedExecApprovalSnapshotRequests = Set(
                self.acceptedExecApprovalSnapshotRequestOrder)
        }
    }

    private func recordAcceptedExecApprovalSnapshot(_ snapshot: WatchExecApprovalSnapshotMessage) {
        guard let requestId = snapshot.requestId,
              let token = WatchExecApprovalSnapshotRequestToken(
                  requestId: requestId,
                  gatewayStableID: snapshot.requestGatewayStableID),
              WatchGatewayID.key(snapshot.gatewayStableID) == WatchGatewayID.key(token.gatewayStableID)
        else { return }
        self.execApprovalSnapshotAcknowledgmentLock.withLock {
            guard self.acceptedExecApprovalSnapshotRequests.insert(token).inserted else { return }
            self.acceptedExecApprovalSnapshotRequestOrder.append(token)
            // Responses can arrive after their refresh task is cancelled. Bound retained
            // acknowledgments while keeping enough room for WatchConnectivity reordering.
            if self.acceptedExecApprovalSnapshotRequestOrder.count > Self.maxAcceptedExecApprovalSnapshotRequests {
                let evicted = self.acceptedExecApprovalSnapshotRequestOrder.removeFirst()
                self.acceptedExecApprovalSnapshotRequests.remove(evicted)
            }
        }
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
        let sentAtMs = (payload["sentAtMs"] as? NSNumber)?.int64Value
        let promptId = (payload["promptId"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let sessionKey = (payload["sessionKey"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let gatewayStableID = WatchGatewayID.exact(payload["gatewayStableID"] as? String)
        let kind = (payload["kind"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let details = (payload["details"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let expiresAtMs = (payload["expiresAtMs"] as? NSNumber)?.int64Value
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
            gatewayStableID: gatewayStableID,
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
        guard let id = WatchApprovalID.exact(payload["id"] as? String) else { return nil }
        let commandText = (payload["commandText"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !commandText.isEmpty else { return nil }
        let commandPreview = (payload["commandPreview"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let warningText = (payload["warningText"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let host = (payload["host"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let nodeId = (payload["nodeId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let agentId = (payload["agentId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let gatewayStableID = WatchGatewayID.exact(payload["gatewayStableID"] as? String)
        let expiresAtMs = (payload["expiresAtMs"] as? NSNumber)?.int64Value
        let riskRaw = (payload["risk"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let risk = WatchRiskLevel(rawValue: riskRaw)
        let allowedDecisions = (payload["allowedDecisions"] as? [Any] ?? []).compactMap {
            Self.parseExecApprovalDecision($0)
        }
        return WatchExecApprovalItem(
            id: id,
            gatewayStableID: gatewayStableID,
            commandText: commandText,
            commandPreview: commandPreview,
            warningText: warningText?.isEmpty == false ? warningText : nil,
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
        let sentAtMs = (payload["sentAtMs"] as? NSNumber)?.int64Value
        let resetResolutionAttemptId = (payload["resetResolutionAttemptId"] as? String)
            .flatMap { $0.isEmpty ? nil : $0 }
        return WatchExecApprovalPromptMessage(
            approval: approval,
            sentAtMs: sentAtMs,
            resetResolutionAttemptId: resetResolutionAttemptId)
    }

    private static func parseExecApprovalResolvedPayload(
        _ payload: [String: Any]) -> WatchExecApprovalResolvedMessage?
    {
        guard let type = payload["type"] as? String,
              type == WatchPayloadType.execApprovalResolved.rawValue
        else {
            return nil
        }
        guard let approvalId = WatchApprovalID.exact(payload["approvalId"] as? String) else { return nil }
        let decision = Self.parseExecApprovalDecision(payload["decision"])
        let outcome = WatchExecApprovalResolvedMessage.parseTransportOutcome(payload["outcome"])
        let gatewayStableID = WatchGatewayID.exact(payload["gatewayStableID"] as? String)
        let resolvedAtMs = (payload["resolvedAtMs"] as? NSNumber)?.int64Value
        let source = (payload["source"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let outcomeText = (payload["outcomeText"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return WatchExecApprovalResolvedMessage(
            approvalId: approvalId,
            gatewayStableID: gatewayStableID,
            decision: decision,
            outcome: outcome,
            resolvedAtMs: resolvedAtMs,
            source: source,
            outcomeText: outcomeText?.isEmpty == false ? outcomeText : nil)
    }

    private static func parseExecApprovalExpiredPayload(
        _ payload: [String: Any]) -> WatchExecApprovalExpiredMessage?
    {
        guard let type = payload["type"] as? String,
              type == WatchPayloadType.execApprovalExpired.rawValue
        else {
            return nil
        }
        guard let approvalId = WatchApprovalID.exact(payload["approvalId"] as? String) else { return nil }
        let rawReason = (payload["reason"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard let reason = WatchExecApprovalCloseReason(rawValue: rawReason)
        else {
            return nil
        }
        let expiredAtMs = (payload["expiredAtMs"] as? NSNumber)?.int64Value
        let gatewayStableID = WatchGatewayID.exact(payload["gatewayStableID"] as? String)
        return WatchExecApprovalExpiredMessage(
            approvalId: approvalId,
            gatewayStableID: gatewayStableID,
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
        guard let rawApprovals = payload["approvals"] as? [Any] else { return nil }
        var approvals: [WatchExecApprovalItem] = []
        approvals.reserveCapacity(rawApprovals.count)
        for item in rawApprovals {
            guard let approval = Self.parseExecApprovalItem(item) else { return nil }
            approvals.append(approval)
        }
        let gatewayStableID = WatchGatewayID.exact(payload["gatewayStableID"] as? String)
        let sentAtMs = (payload["sentAtMs"] as? NSNumber)?.int64Value
        let snapshotId = (payload["snapshotId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let requestId = (payload["requestId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let requestGatewayStableID = WatchGatewayID.exact(payload["requestGatewayStableID"] as? String)
        return WatchExecApprovalSnapshotMessage(
            approvals: approvals,
            gatewayStableID: gatewayStableID,
            sentAtMs: sentAtMs,
            snapshotId: snapshotId,
            requestId: requestId,
            requestGatewayStableID: requestGatewayStableID)
    }

    private static func parseAppSnapshotPayload(_ payload: [String: Any]) -> WatchAppSnapshotMessage? {
        WatchAppSnapshotMessage.parsePayload(payload)
    }

    private static func parseChatCompletionPayload(
        _ payload: [String: Any]) -> WatchChatCompletionMessage?
    {
        guard (payload["type"] as? String) == WatchPayloadType.chatCompletion.rawValue else {
            return nil
        }
        let commandId = (payload["commandId"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let replyText = (payload["replyText"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !commandId.isEmpty, !replyText.isEmpty else { return nil }
        let sentAtMs = (payload["sentAtMs"] as? NSNumber)?.int64Value
        return WatchChatCompletionMessage(
            commandId: commandId,
            replyText: replyText,
            sentAtMs: sentAtMs)
    }

    private static func encodeAppSnapshotRequestPayload(
        _ request: WatchAppSnapshotRequestMessage) -> [String: Any]
    {
        var payload: [String: Any] = [
            "type": WatchPayloadType.appSnapshotRequest.rawValue,
            "requestId": request.requestId,
        ]
        if let sentAtMs = request.sentAtMs {
            payload["sentAtMs"] = sentAtMs
        }
        return payload
    }

    private static func encodeAppCommandPayload(_ message: WatchAppCommandMessage) -> [String: Any] {
        var payload: [String: Any] = [
            "type": WatchPayloadType.appCommand.rawValue,
            "command": message.command.rawValue,
            "commandId": message.commandId,
        ]
        if let sessionKey = message.sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines),
           !sessionKey.isEmpty
        {
            payload["sessionKey"] = sessionKey
        }
        if let gatewayStableID = WatchGatewayID.exact(message.gatewayStableID) {
            payload["gatewayStableID"] = gatewayStableID
        }
        if let text = message.text?.trimmingCharacters(in: .whitespacesAndNewlines),
           !text.isEmpty
        {
            payload["text"] = text
        }
        if let sentAtMs = message.sentAtMs {
            payload["sentAtMs"] = sentAtMs
        }
        return payload
    }

    private static func encodeSnapshotRequestPayload(
        _ request: WatchExecApprovalSnapshotRequestMessage) -> [String: Any]
    {
        var payload: [String: Any] = [
            "type": WatchPayloadType.execApprovalSnapshotRequest.rawValue,
            "requestId": request.requestId,
            "heldApprovals": request.heldApprovals.map { item in
                var encoded: [String: Any] = [
                    "approvalId": item.approvalId,
                ]
                if let attemptID = item.activeResolutionAttemptId, !attemptID.isEmpty {
                    encoded["activeResolutionAttemptId"] = attemptID
                }
                return encoded
            },
        ]
        if let sentAtMs = request.sentAtMs {
            payload["sentAtMs"] = sentAtMs
        }
        if let gatewayStableID = WatchGatewayID.exact(request.gatewayStableID) {
            payload["gatewayStableID"] = gatewayStableID
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
        if let gatewayStableID = WatchGatewayID.exact(message.gatewayStableID) {
            payload["gatewayStableID"] = gatewayStableID
        }
        if let sentAtMs = message.sentAtMs {
            payload["sentAtMs"] = sentAtMs
        }
        return payload
    }
}

extension WatchConnectivityReceiver: WCSessionDelegate {
    func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: (any Error)?)
    {
        self.activationGate.complete(
            activated: activationState == .activated,
            errorDescription: error?.localizedDescription)
        if activationState == .activated, !session.receivedApplicationContext.isEmpty {
            self.consumeIncomingPayload(
                session.receivedApplicationContext,
                transport: "receivedApplicationContext")
        }
        Task { @MainActor in
            let gatewayStableID = self.store.execApprovalReviewGatewayStableID
            await self.requestExecApprovalSnapshot(
                gatewayStableID: gatewayStableID,
                heldApprovals: self.store.execApprovalSnapshotRequestItems(
                    gatewayStableID: gatewayStableID))
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
        if let type = payload["type"] as? String,
           type == WatchPayloadType.directNodeSetup.rawValue,
           let setupCode = payload["setupCode"] as? String,
           let sentAtMs = (payload["sentAtMs"] as? NSNumber)?.int64Value
        {
            Task { @MainActor in
                self.directNodeSetupHandler(setupCode, sentAtMs)
            }
            return
        }
        let appSnapshot = (payload[WatchPayloadType.appSnapshot.rawValue] as? [String: Any])
            .flatMap(Self.parseAppSnapshotPayload)
        let execApprovalSnapshot =
            (payload[WatchPayloadType.execApprovalSnapshot.rawValue] as? [String: Any])
            .flatMap(Self.parseExecApprovalSnapshotPayload)
        if appSnapshot != nil || execApprovalSnapshot != nil {
            // Owner state must land first so approvals are filtered against this context's route.
            Task { @MainActor in
                if let appSnapshot {
                    self.store.consume(appSnapshot: appSnapshot)
                    self.discardExecApprovalSnapshotAcknowledgments(
                        exceptGatewayStableID: appSnapshot.gatewayStableID)
                }
                if let execApprovalSnapshot {
                    if self.store.consume(execApprovalSnapshot: execApprovalSnapshot, transport: transport) {
                        self.recordAcceptedExecApprovalSnapshot(execApprovalSnapshot)
                    }
                }
                if appSnapshot != nil {
                    for snapshot in self.store.replayDeferredGatewayPayloads() {
                        self.recordAcceptedExecApprovalSnapshot(snapshot)
                    }
                }
            }
            return
        }
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
                if self.store.consume(execApprovalSnapshot: snapshot, transport: transport) {
                    self.recordAcceptedExecApprovalSnapshot(snapshot)
                }
            }
            return
        }
        if let snapshot = Self.parseAppSnapshotPayload(payload) {
            Task { @MainActor in
                self.store.consume(appSnapshot: snapshot)
                self.discardExecApprovalSnapshotAcknowledgments(
                    exceptGatewayStableID: snapshot.gatewayStableID)
                for snapshot in self.store.replayDeferredGatewayPayloads() {
                    self.recordAcceptedExecApprovalSnapshot(snapshot)
                }
            }
            return
        }
        if let completion = Self.parseChatCompletionPayload(payload) {
            Task { @MainActor in
                self.store.consume(chatCompletion: completion)
            }
        }
    }
}
