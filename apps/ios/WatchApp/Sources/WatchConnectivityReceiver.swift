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
    private let activationGate = WatchSessionActivationGate()
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

    func requestExecApprovalSnapshot() async {
        guard let session = try? await self.activatedSession() else { return }
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
        if let gatewayStableID = draft.gatewayStableID?.trimmingCharacters(in: .whitespacesAndNewlines),
           !gatewayStableID.isEmpty
        {
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
                replyId: UUID().uuidString,
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

    private static func unavailableResult(_ error: any Error) -> WatchReplySendResult {
        WatchReplySendResult(
            deliveredImmediately: false,
            queuedForDelivery: false,
            transport: "none",
            errorMessage: error.localizedDescription)
    }

    private static func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
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
        let gatewayStableID = (payload["gatewayStableID"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
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
        let gatewayStableID = (payload["gatewayStableID"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let expiresAtMs = (payload["expiresAtMs"] as? NSNumber)?.int64Value
        let riskRaw = (payload["risk"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let risk = WatchRiskLevel(rawValue: riskRaw)
        let allowedDecisions = (payload["allowedDecisions"] as? [Any] ?? []).compactMap {
            Self.parseExecApprovalDecision($0)
        }
        return WatchExecApprovalItem(
            id: id,
            gatewayStableID: gatewayStableID?.isEmpty == false ? gatewayStableID : nil,
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
        let sentAtMs = (payload["sentAtMs"] as? NSNumber)?.int64Value
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
        let gatewayStableID = (payload["gatewayStableID"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedAtMs = (payload["resolvedAtMs"] as? NSNumber)?.int64Value
        let source = (payload["source"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return WatchExecApprovalResolvedMessage(
            approvalId: approvalId,
            gatewayStableID: gatewayStableID?.isEmpty == false ? gatewayStableID : nil,
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
        let expiredAtMs = (payload["expiredAtMs"] as? NSNumber)?.int64Value
        let gatewayStableID = (payload["gatewayStableID"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return WatchExecApprovalExpiredMessage(
            approvalId: approvalId,
            gatewayStableID: gatewayStableID?.isEmpty == false ? gatewayStableID : nil,
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
        let gatewayStableID = (payload["gatewayStableID"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let sentAtMs = (payload["sentAtMs"] as? NSNumber)?.int64Value
        let snapshotId = (payload["snapshotId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return WatchExecApprovalSnapshotMessage(
            approvals: approvals,
            gatewayStableID: gatewayStableID?.isEmpty == false ? gatewayStableID : nil,
            sentAtMs: sentAtMs,
            snapshotId: snapshotId)
    }

    private static func parseAppSnapshotPayload(_ payload: [String: Any]) -> WatchAppSnapshotMessage? {
        guard let type = payload["type"] as? String,
              type == WatchPayloadType.appSnapshot.rawValue
        else {
            return nil
        }
        let gatewayStatusText = (payload["gatewayStatusText"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let agentName = (payload["agentName"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let agentAvatarURL = (payload["agentAvatarUrl"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let agentAvatarText = (payload["agentAvatarText"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let sessionKey = (payload["sessionKey"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let gatewayStableID = (payload["gatewayStableID"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let talkStatusText = (payload["talkStatusText"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let pendingApprovalCount = (payload["pendingApprovalCount"] as? Int)
            ?? (payload["pendingApprovalCount"] as? NSNumber)?.intValue
            ?? 0
        let sentAtMs = (payload["sentAtMs"] as? NSNumber)?.int64Value
        let snapshotId = (payload["snapshotId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let chatItems = (payload["chatItems"] as? [Any])?.compactMap(Self.parseChatItem)
        let chatStatusText = (payload["chatStatusText"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return WatchAppSnapshotMessage(
            gatewayStatusText: gatewayStatusText.isEmpty ? "Unknown" : gatewayStatusText,
            gatewayConnected: Self.boolValue(payload["gatewayConnected"]),
            agentName: agentName.isEmpty ? "Main" : agentName,
            agentAvatarURL: agentAvatarURL?.isEmpty == false ? agentAvatarURL : nil,
            agentAvatarText: agentAvatarText?.isEmpty == false ? agentAvatarText : nil,
            sessionKey: sessionKey.isEmpty ? "main" : sessionKey,
            gatewayStableID: gatewayStableID?.isEmpty == false ? gatewayStableID : nil,
            talkStatusText: talkStatusText.isEmpty ? "Off" : talkStatusText,
            talkEnabled: Self.boolValue(payload["talkEnabled"]),
            talkListening: Self.boolValue(payload["talkListening"]),
            talkSpeaking: Self.boolValue(payload["talkSpeaking"]),
            pendingApprovalCount: max(0, pendingApprovalCount),
            chatItems: chatItems,
            chatStatusText: chatStatusText?.isEmpty == false ? chatStatusText : nil,
            sentAtMs: sentAtMs,
            snapshotId: snapshotId)
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

    private static func parseChatItem(_ item: Any) -> WatchChatItem? {
        guard let dict = item as? [String: Any] else { return nil }
        guard let id = (dict["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !id.isEmpty
        else {
            return nil
        }
        let trimmedRole = (dict["role"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let text = (dict["text"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let text, !text.isEmpty else { return nil }
        let timestampMs = (dict["timestampMs"] as? NSNumber)?.int64Value
        return WatchChatItem(
            id: id,
            role: trimmedRole.isEmpty ? "assistant" : trimmedRole,
            text: text,
            timestampMs: timestampMs)
    }

    private static func boolValue(_ value: Any?) -> Bool {
        if let bool = value as? Bool {
            return bool
        }
        if let number = value as? NSNumber {
            return number.boolValue
        }
        return false
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
        if let gatewayStableID = message.gatewayStableID?.trimmingCharacters(in: .whitespacesAndNewlines),
           !gatewayStableID.isEmpty
        {
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
        if let gatewayStableID = message.gatewayStableID?.trimmingCharacters(in: .whitespacesAndNewlines),
           !gatewayStableID.isEmpty
        {
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
                }
                if let execApprovalSnapshot {
                    self.store.consume(execApprovalSnapshot: execApprovalSnapshot, transport: transport)
                }
                if appSnapshot != nil {
                    self.store.replayDeferredGatewayPayloads()
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
                self.store.consume(execApprovalSnapshot: snapshot, transport: transport)
            }
            return
        }
        if let snapshot = Self.parseAppSnapshotPayload(payload) {
            Task { @MainActor in
                self.store.consume(appSnapshot: snapshot)
                self.store.replayDeferredGatewayPayloads()
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
