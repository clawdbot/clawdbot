import Foundation
import OpenClawKit
import OSLog

private let transportEventsLogger = Logger(subsystem: "ai.openclaw", category: "OpenClawChatUI")

@MainActor
private final class PendingRunOwnerReference {
    weak var value: OpenClawChatViewModel?

    init(_ value: OpenClawChatViewModel) {
        self.value = value
    }
}

extension OpenClawChatViewModel {
    func resolveInlineWidgetResource(
        path: String,
        replacing failedResource: OpenClawChatWidgetResource?) async -> OpenClawChatWidgetResource?
    {
        await self.transport.resolveInlineWidgetResource(path: path, replacing: failedResource)
    }

    func handleTransportEvent(_ evt: OpenClawChatTransportEvent) {
        switch evt {
        case let .health(ok):
            let reconnected = ok && !self.healthOK
            applyTransportHealth(ok)
            if reconnected {
                Task { [weak self] in await self?.refreshQuestions() }
            }
        case .tick:
            let context = self.currentSessionSnapshot()
            Task { await self.pollHealthIfNeeded(force: false, sessionSnapshot: context) }
        case let .sessionsChanged(change):
            let projectedSessions = ChatSessionSidebarModel.applying(
                sessionChange: change,
                to: self.sessions)
            if let projectedSessions {
                self.sessions = projectedSessions
            } else if change.reason != "patch", change.reason != "command-metadata" {
                let context = self.currentSessionSnapshot()
                Task { await self.fetchSessions(limit: 50, sessionSnapshot: context) }
            }
            // Group-catalog mutations from any client arrive as reason "groups"
            // (mirrors web ui/src/lib/sessions); bump the revision so views keyed
            // on it refetch. Rename/delete also rewrite member sessions' category
            // values, so refresh sessions too or inspectors keep stale placement.
            if change.reason == "groups" {
                self.sessionGroupsRevision += 1
                let context = self.currentSessionSnapshot()
                Task { await self.fetchSessions(limit: 50, sessionSnapshot: context) }
                return
            }
            if change.reason == "rewind" || change.reason == "branch-switch" {
                guard let sessionKey = change.sessionKey,
                      self.matchesCurrentSessionKey(
                          incoming: sessionKey,
                          agentId: change.agentId,
                          current: self.sessionKey)
                else { return }
                self.replyTarget = nil
                self.runMessageScopesByRunID.removeAll()
                self.provisionalFinalMessagesByID.removeAll()
                let context = self.beginHistoryRequest()
                if change.reason == "branch-switch" {
                    let switchActivity = self.beginSessionBranchSwitchActivity(for: context.session)
                    Task {
                        defer { self.endSessionBranchSwitchActivity(switchActivity) }
                        await self.reconcileSessionBranchChange(
                            switchActivity,
                            confirmFromBranchRefresh: true)
                    }
                    return
                }
                Task {
                    await self.refreshHistoryAfterRun(historyRequest: context)
                    guard self.isCurrentSession(context.session) else { return }
                    await self.refreshSessionBranches(confirmingBranchChange: true)
                }
                return
            }
            guard change.reason == "patch" || change.reason == "command-metadata" else { return }
            let context = self.currentSessionSnapshot()
            Task { await self.fetchSessions(limit: 50, sessionSnapshot: context) }
        case let .sessionObserver(digest):
            self.sessions = ChatSessionSidebarModel.applying(
                observerDigest: digest,
                to: self.sessions)
        case let .chat(chat):
            self.handleChatEvent(chat)
        case let .sessionMessage(message):
            self.handleSessionMessageEvent(message)
        case let .agent(agent):
            self.handleAgentEvent(agent)
        case let .questionRequested(question):
            self.upsertQuestion(question)
            self.reconcileQuestionsAfterEvent()
        case let .questionResolved(resolved):
            self.resolveQuestionEvent(resolved)
            self.reconcileQuestionsAfterEvent()
        case .seqGap:
            self.errorText = nil
            self.invalidateHistorySnapshots()
            self.invalidateRunSnapshots()
            self.clearPendingRuns(reason: nil)
            self.pendingToolCallsById = [:]
            self.updateStreamingAssistantText(nil)
            self.clearPlan()
            let context = self.beginHistoryRequest()
            // Question refresh is best-effort and must not delay transcript
            // recovery behind a slow gateway round trip.
            Task { await self.refreshQuestions() }
            Task {
                await self.refreshHistoryAfterRun(historyRequest: context)
                await self.pollHealthIfNeeded(force: true, sessionSnapshot: context.session)
            }
        }
    }

    private func handleSessionMessageEvent(_ payload: OpenClawSessionMessageEventPayload) {
        guard let message = payload.message else { return }
        let sanitized = Self.stripInboundMetadata(from: message)
        let isCurrentSession = payload.sessionKey.map {
            self.matchesCurrentSessionKey(incoming: $0, agentId: payload.agentId, current: self.sessionKey)
        } ?? true
        // Confirmation is gateway-scoped, not presentation-scoped. A flush
        // can drain session A while session B is visible, and A's event must
        // still retire its durable row before this handler returns early.
        confirmOutboxCommands(in: [sanitized])
        guard isCurrentSession else { return }
        self.observeOutboxTranscriptTip(sanitized, session: self.currentSessionSnapshot())

        self.invalidateHistorySnapshots()
        // The active client also receives the gateway's echo of the user turn it
        // just sent. performSend already appended an optimistic row carrying a
        // local client timestamp, while the echo carries a server timestamp, so
        // the timestamp-keyed identity/dedupe paths below never collapse them.
        // Adopt the server record onto the exactly correlated row even when the
        // run's final event already cleared pending state. Same-content turns
        // without this key remain distinct.
        if adoptCorrelatedUserMessage(incoming: sanitized) {
            self.clearActiveSessionRunIndicatorIfLatestUserAnswered()
            self.applyDeferredExternalStateIfReady()
            return
        }
        if adoptProvisionalFinalMessage(incoming: sanitized) {
            self.clearActiveSessionRunIndicatorIfLatestUserAnswered()
            return
        }

        let reconciled = Self.reconcileMessageIDs(previous: self.messages, incoming: self.messages + [sanitized])
        replaceMessages(Self.dedupeMessages(reconciled))
        pruneProvisionalFinalMessages()
        pruneRunMessageScopes()
        self.clearActiveSessionRunIndicatorIfLatestUserAnswered()
        self.applyDeferredExternalStateIfReady()
    }

    private func handleChatEvent(_ chat: OpenClawChatEventPayload) {
        let isOurRun = chat.runId.flatMap { self.pendingRuns.contains($0) } ?? false
        if let runId = chat.runId {
            self.logDiagnostic(
                "chat.ui event chat state=\(chat.state ?? "unknown") "
                    + "runId=\(runId) ours=\(isOurRun) pending=\(self.pendingRunCount)")
        }

        // Gateway may publish canonical session keys (for example "agent:main:main")
        // even when this view currently uses an alias key (for example "main").
        // Never drop events for our own pending run on key mismatch, or the UI can stay
        // stuck at "thinking" until the user reopens and forces a history reload.
        if let sessionKey = chat.sessionKey,
           !self.matchesCurrentSessionKey(
               incoming: sessionKey,
               agentId: chat.agentId,
               current: self.sessionKey),
           !isOurRun
        {
            return
        }
        if chat.state == "delta",
           let runId = Self.normalizedRunID(chat.runId)
        {
            guard self.pendingRuns.isEmpty || self.pendingRuns.contains(runId) else {
                return
            }
            self.invalidateRunSnapshots()
            self.adoptRun(
                runId: runId,
                bufferedText: OpenClawChatEventText.assistantText(from: chat) ?? "")
            return
        }
        if chat.state == "final" || chat.state == "aborted" || chat.state == "error" {
            self.invalidateHistorySnapshots()
            self.updateActiveSessionRunWithoutChatSnapshot(false)
        }
        self.invalidateRunSnapshots()
        if !isOurRun {
            // Keep multiple clients in sync: if another client finishes a run for our session, refresh history.
            switch chat.state {
            case "final", "aborted", "error":
                self.updateStreamingAssistantText(nil)
                self.pendingToolCallsById = [:]
                if let runId = chat.runId {
                    self.clearPlan(for: runId)
                }
                self.appendFinalChatMessageIfPresent(chat)
                let context = self.beginHistoryRequest()
                Task { await self.refreshHistoryAfterRun(historyRequest: context) }
            default:
                break
            }
            return
        }

        switch chat.state {
        case "final", "aborted", "error":
            if chat.state == "error" {
                self.errorText = chat.errorMessage ?? "Chat failed"
            }
            let hapticEvent: OpenClawChatHaptics.Event? = switch chat.state {
            case "final": .runCompleted
            case "error": .runFailed
            default: nil
            }
            if let runId = chat.runId {
                self.clearPendingRun(runId, hapticEvent: hapticEvent)
            } else if self.pendingRuns.count <= 1 {
                self.clearPendingRuns(reason: nil, hapticEvent: hapticEvent)
            }
            self.pendingToolCallsById = [:]
            self.updateStreamingAssistantText(nil)
            self.appendFinalChatMessageIfPresent(chat)
            let context = self.beginHistoryRequest()
            self.applyDeferredExternalStateIfReady()
            Task { await self.refreshHistoryAfterRun(historyRequest: context) }
        default:
            break
        }
    }

    private func appendFinalChatMessageIfPresent(_ chat: OpenClawChatEventPayload) {
        guard chat.state == "final" else { return }
        guard let text = OpenClawChatEventText.assistantText(from: chat) else { return }

        let decoded = chat.message.flatMap {
            try? ChatPayloadDecoding.decode($0, as: OpenClawChatMessage.self)
        }
        let message = if let decoded,
                         Self.isAssistantMessage(decoded)
        {
            Self.messageWithTimestampIfNeeded(decoded)
        } else {
            OpenClawChatMessage(
                role: "assistant",
                content: [
                    OpenClawChatMessageContent(
                        type: "text",
                        text: text,
                        thinking: nil,
                        thinkingSignature: nil,
                        mimeType: nil,
                        fileName: nil,
                        content: nil,
                        id: nil,
                        name: nil,
                        arguments: nil),
                ],
                timestamp: Date().timeIntervalSince1970 * 1000,
                stopReason: "stop")
        }

        let runId = Self.normalizedRunID(chat.runId)
        let scope = runMessageScope(for: runId)
        guard self.isCurrentSession(scope.session) else { return }
        guard let reconciliationKey = Self.finalMessageReconciliationKey(for: message) else { return }
        if let runId, hasRecordedFinalMessage(runId: runId) {
            return
        }

        if hasCanonicalFinalMessageMatching(message, scope: scope) {
            if let runId {
                self.runMessageScopesByRunID.removeValue(forKey: runId)
            }
            return
        }

        let reconciled = Self.reconcileMessageIDs(previous: self.messages, incoming: self.messages + [message])
        replaceMessages(Self.dedupeMessages(reconciled))
        if self.messages.contains(where: { $0.id == message.id }) {
            self.provisionalFinalMessagesByID[message.id] = ProvisionalFinalMessage(
                reconciliationKey: reconciliationKey,
                runId: runId,
                scope: scope)
        }
        pruneProvisionalFinalMessages()
        pruneRunMessageScopes()
    }

    static func isAssistantMessage(_ message: OpenClawChatMessage) -> Bool {
        message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "assistant"
    }

    private static func messageWithTimestampIfNeeded(_ message: OpenClawChatMessage) -> OpenClawChatMessage {
        guard message.timestamp == nil else { return message }
        return OpenClawChatMessage(
            id: message.id,
            role: message.role,
            content: message.content,
            timestamp: Date().timeIntervalSince1970 * 1000,
            idempotencyKey: message.idempotencyKey,
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            usage: message.usage,
            stopReason: message.stopReason,
            errorMessage: message.errorMessage,
            details: message.details,
            isError: message.isError)
    }

    private func handleAgentEvent(_ evt: OpenClawAgentEventPayload) {
        let isPendingRun = self.pendingRuns.contains(evt.runId)
        let isLegacySessionStream = self.pendingRuns.isEmpty && self.sessionId == evt.runId
        if !isPendingRun, !isLegacySessionStream {
            return
        }
        self.invalidateRunSnapshots()
        self.logDiagnostic(
            "chat.ui event agent stream=\(evt.stream) "
                + "runId=\(evt.runId) pending=\(self.pendingRunCount)")

        switch evt.stream {
        case "assistant":
            if let text = evt.data["text"]?.value as? String {
                self.updateActiveSessionRunWithoutChatSnapshot(false)
                self.updateStreamingAssistantText(text)
            }
        case "lifecycle":
            self.handleAgentLifecycleEvent(evt, isPendingRun: isPendingRun)
        case "plan":
            guard Self.lowercasedAgentEventString(evt.data["phase"]) == "update" else { return }
            self.applyPlanSnapshot(runId: evt.runId, data: evt.data)
        case "tool":
            guard let phase = evt.data["phase"]?.value as? String else { return }
            guard let name = evt.data["name"]?.value as? String else { return }
            guard let toolCallId = evt.data["toolCallId"]?.value as? String else { return }
            if phase == "start" {
                self.updateActiveSessionRunWithoutChatSnapshot(false)
                let args = evt.data["args"]
                self.pendingToolCallsById[toolCallId] = OpenClawChatPendingToolCall(
                    toolCallId: toolCallId,
                    name: name,
                    args: args,
                    startedAt: evt.ts.map(Double.init) ?? Date().timeIntervalSince1970 * 1000,
                    isError: nil)
            } else if phase == "result" {
                self.pendingToolCallsById[toolCallId] = nil
            }
        default:
            break
        }
    }

    private func handleAgentLifecycleEvent(_ evt: OpenClawAgentEventPayload, isPendingRun: Bool) {
        let phase = Self.lowercasedAgentEventString(evt.data["phase"])
        let status = Self.lowercasedAgentEventString(evt.data["status"])
        let aborted = Self.agentEventBool(evt.data["aborted"])
        let isFailure =
            phase == "error" || phase == "failed" || phase == "aborted" ||
            status == "error" || status == "failed" || status == "aborted"
        let isSuccessfulStatus =
            status == "ok" || status == "success" || status == "succeeded" ||
            status == "complete" || status == "completed"
        let isTerminalPhase = phase == "end" || phase == "complete" || phase == "completed"

        guard isTerminalPhase || isFailure || aborted || isSuccessfulStatus else { return }

        self.invalidateHistorySnapshots()
        self.updateActiveSessionRunWithoutChatSnapshot(false)

        if isFailure || aborted {
            self.errorText = Self.agentLifecycleErrorMessage(evt, aborted: aborted)
        }
        if isPendingRun {
            self.clearPendingRun(
                evt.runId,
                hapticEvent: isFailure || aborted ? .runFailed : .runCompleted)
        }
        self.pendingToolCallsById = [:]
        self.updateStreamingAssistantText(nil)
        self.clearPlan(for: evt.runId)
        let context = self.beginHistoryRequest()
        self.applyDeferredExternalStateIfReady()
        Task { await self.refreshHistoryAfterRun(historyRequest: context) }
    }

    private static func lowercasedAgentEventString(_ value: AnyCodable?) -> String? {
        (value?.value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private static func agentEventBool(_ value: AnyCodable?) -> Bool {
        if let boolValue = value?.value as? Bool {
            return boolValue
        }
        guard let stringValue = lowercasedAgentEventString(value) else {
            return false
        }
        return stringValue == "true" || stringValue == "yes" || stringValue == "1"
    }

    private static func agentLifecycleErrorMessage(_ evt: OpenClawAgentEventPayload, aborted: Bool) -> String {
        if aborted {
            return "Run aborted"
        }
        if let message = evt.data["error"]?.value as? String,
           !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            return message
        }
        if let message = evt.data["message"]?.value as? String,
           !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            return message
        }
        return "Chat failed"
    }

    func finishPendingRunAfterTerminalOkSendAck(_ response: OpenClawChatSendResponse) {
        self.clearPendingRun(response.runId, hapticEvent: .runCompleted)
        self.pendingToolCallsById = [:]
        self.updateStreamingAssistantText(nil)
        self.logDiagnostic(
            "chat.ui send terminal ack sessionKey=\(self.sessionKey) "
                + "runId=\(response.runId) status=ok")
    }

    func finishPendingRunIfTerminalSendAck(_ response: OpenClawChatSendResponse) -> Bool {
        switch response.status {
        case "timeout":
            self.removePendingLocalUserEcho(for: response.runId)
            self.pendingToolCallsById = [:]
            self.updateStreamingAssistantText(nil)
            self.errorText = "Chat failed before the run started; try again."
            self.clearPendingRun(response.runId, hapticEvent: .runFailed)
            self.logDiagnostic(
                "chat.ui send terminal ack sessionKey=\(self.sessionKey) "
                    + "runId=\(response.runId) status=timeout")
            return true
        case "error":
            self.removePendingLocalUserEcho(for: response.runId)
            self.pendingToolCallsById = [:]
            self.updateStreamingAssistantText(nil)
            self.errorText = "Chat failed before the run started; try again."
            self.clearPendingRun(response.runId, hapticEvent: .runFailed)
            self.logDiagnostic(
                "chat.ui send terminal ack sessionKey=\(self.sessionKey) "
                    + "runId=\(response.runId) status=error")
            return true
        default:
            return false
        }
    }

    func removePendingLocalUserEcho(for runId: String) {
        guard let messageID = pendingLocalUserEchoMessageIDsByRunID[runId] else { return }
        self.removeMessage(id: messageID)
        self.pendingLocalUserEchoMessageIDsByRunID[runId] = nil
    }

    private func refreshIfPending(
        runId: String,
        sessionSnapshot: SessionSnapshot,
        armID: UInt64? = nil,
        after timestamp: Double?,
        terminalState: OpenClawChatRunTerminalState? = nil,
        allowNoOutputCompletion: Bool = false,
        diagnostic: String) async -> Bool
    {
        guard self.isCurrentPendingRunOwner(
            runId: runId,
            sessionSnapshot: sessionSnapshot,
            armID: armID)
        else {
            return false
        }
        self.logDiagnostic(diagnostic)
        let historyContext = self.beginHistoryRequest(for: sessionSnapshot)
        let refresh = await refreshHistoryAfterRun(historyRequest: historyContext)
        guard self.isCurrentPendingRunOwner(
            runId: runId,
            sessionSnapshot: sessionSnapshot,
            armID: armID)
        else { return false }
        if case let .failed(message)? = terminalState {
            if refresh.applied,
               let timestamp,
               self.clearPendingRunIfAssistantMessagePresent(runId: runId, after: timestamp)
            {
                return false
            }
            self.errorText = message
            self.clearPendingRun(runId, hapticEvent: .runFailed)
            self.pendingToolCallsById = [:]
            self.updateStreamingAssistantText(nil)
            return false
        }
        if refresh.applied, refresh.runSnapshotApplied, refresh.supportsInFlightRunState {
            if refresh.hasInFlightRun {
                return true
            }
            if refresh.sessionHasActiveRun,
               Self.hasUnansweredLatestUser(in: self.messages)
            {
                // A session-level active bit cannot identify a new chat run,
                // but it is enough to retain the run ID this client already owns.
                self.pendingToolCallsById = [:]
                self.updateStreamingAssistantText(nil)
                return true
            }
            if let timestamp,
               self.clearPendingRunIfAssistantMessagePresent(runId: runId, after: timestamp)
            {
                return false
            }
            if terminalState == .completed, allowNoOutputCompletion {
                self.finishPendingRun(runId: runId, terminalState: .completed)
                return false
            }
            return true
        }
        if refresh.applied, terminalState == .completed, allowNoOutputCompletion {
            if let timestamp,
               self.clearPendingRunIfAssistantMessagePresent(runId: runId, after: timestamp)
            {
                return false
            }
            self.finishPendingRun(runId: runId, terminalState: .completed)
            return false
        }
        guard let timestamp else { return true }
        return !self.clearPendingRunIfAssistantMessagePresent(runId: runId, after: timestamp)
    }

    private func finishPendingRun(runId: String, terminalState: OpenClawChatRunTerminalState) {
        let hapticEvent: OpenClawChatHaptics.Event
        switch terminalState {
        case .completed:
            hapticEvent = .runCompleted
        case let .failed(message):
            self.errorText = message
            hapticEvent = .runFailed
        }
        self.clearPendingRun(runId, hapticEvent: hapticEvent)
        self.pendingToolCallsById = [:]
        self.updateStreamingAssistantText(nil)
    }

    private func isCurrentPendingRunOwner(
        runId: String,
        sessionSnapshot: SessionSnapshot,
        armID: UInt64?) -> Bool
    {
        self.isCurrentSession(sessionSnapshot) &&
            self.pendingRuns.contains(runId) &&
            (armID == nil || self.pendingRunOwnerArmIDs[runId] == armID)
    }

    @discardableResult
    func clearPendingRunIfAssistantMessagePresent(runId: String, after timestamp: Double) -> Bool {
        guard let hapticEvent = assistantHapticEvent(after: timestamp) else { return false }
        self.clearPendingRun(runId, hapticEvent: hapticEvent)
        self.pendingToolCallsById = [:]
        self.updateStreamingAssistantText(nil)
        return true
    }

    static func hasUnansweredLatestUser(in messages: [OpenClawChatMessage]) -> Bool {
        self.latestUserTurn(in: messages) != nil && !self.hasAssistantMessageAfterLatestUser(in: messages)
    }

    static func latestUserTurn(in messages: [OpenClawChatMessage]) -> LatestUserTurn? {
        guard let lastUserIndex = messages.lastIndex(where: { $0.role.lowercased() == "user" }) else {
            return nil
        }
        return self.userTurn(at: lastUserIndex, in: messages)
    }

    static func userTurn(
        at userIndex: [OpenClawChatMessage].Index,
        in messages: [OpenClawChatMessage]) -> LatestUserTurn?
    {
        guard messages.indices.contains(userIndex),
              messages[userIndex].role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "user"
        else {
            return nil
        }
        guard let refreshKey = userRefreshIdentityKey(for: messages[userIndex]) else {
            return LatestUserTurn(
                idempotencyKey: normalizedIdempotencyKey(messages[userIndex].idempotencyKey),
                refreshKey: nil,
                occurrence: 0,
                timestamp: messages[userIndex].timestamp)
        }
        let occurrence = messages[...userIndex].reduce(into: 0) { count, message in
            guard self.userRefreshIdentityKey(for: message) == refreshKey else { return }
            count += 1
        }
        return LatestUserTurn(
            idempotencyKey: Self.normalizedIdempotencyKey(messages[userIndex].idempotencyKey),
            refreshKey: refreshKey,
            occurrence: occurrence,
            timestamp: messages[userIndex].timestamp)
    }

    static func hasAnsweredUser(
        _ user: LatestUserTurn,
        in messages: [OpenClawChatMessage])
        -> Bool
    {
        // Hooks may transform persisted user content while preserving this key.
        // Prefer the durable turn identity so a completed refresh rejects older history.
        if let idempotencyKey = user.idempotencyKey {
            guard let userIndex = messages.lastIndex(where: { message in
                message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "user" &&
                    self.normalizedIdempotencyKey(message.idempotencyKey) == idempotencyKey
            }) else {
                return false
            }
            return self.hasAssistantMessage(after: userIndex, in: messages)
        }
        guard let refreshKey = user.refreshKey else { return false }
        var occurrence = 0
        var latestMatchingUserIndex: [OpenClawChatMessage].Index?
        for (index, message) in messages.enumerated() {
            guard userRefreshIdentityKey(for: message) == refreshKey else { continue }
            occurrence += 1
            latestMatchingUserIndex = index
            guard occurrence == user.occurrence else { continue }
            return self.hasAssistantMessage(after: index, in: messages)
        }
        guard let latestMatchingUserIndex,
              messages.lastIndex(where: { $0.role.lowercased() == "user" }) == latestMatchingUserIndex
        else {
            return false
        }
        if let requestTimestamp = user.timestamp,
           let latestTimestamp = messages[latestMatchingUserIndex].timestamp,
           latestTimestamp < requestTimestamp
        {
            return false
        }
        return self.hasAssistantMessage(after: latestMatchingUserIndex, in: messages)
    }

    private static func hasAssistantMessage(
        after userIndex: [OpenClawChatMessage].Index,
        in messages: [OpenClawChatMessage]) -> Bool
    {
        let nextIndex = messages.index(after: userIndex)
        guard nextIndex < messages.endIndex else { return false }
        return messages[nextIndex...].contains { message in
            guard message.role.lowercased() == "assistant" else { return false }
            let text = message.content.compactMap(\.text).joined(separator: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return !text.isEmpty || message.errorMessage != nil
        }
    }

    private static func hasAssistantMessageAfterLatestUser(in messages: [OpenClawChatMessage]) -> Bool {
        guard let lastUserIndex = messages.lastIndex(where: { $0.role.lowercased() == "user" }) else {
            return false
        }
        guard lastUserIndex < messages.index(before: messages.endIndex) else {
            return false
        }
        return messages[messages.index(after: lastUserIndex)...].contains { message in
            guard message.role.lowercased() == "assistant" else { return false }
            let text = message.content.compactMap(\.text).joined(separator: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return !text.isEmpty || message.errorMessage != nil
        }
    }

    private static func assistantHapticEvent(
        for message: OpenClawChatMessage) -> OpenClawChatHaptics.Event?
    {
        guard message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "assistant" else {
            return nil
        }
        let text = message.content.compactMap(\.text).joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || message.errorMessage != nil else { return nil }
        let stopReason = message.stopReason?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return stopReason == "error" || stopReason == "aborted" ? .runFailed : .runCompleted
    }

    func assistantHapticEventAfterLatestUser() -> OpenClawChatHaptics.Event? {
        guard let userIndex = messages.lastIndex(where: { $0.role.lowercased() == "user" }) else { return nil }
        let nextIndex = self.messages.index(after: userIndex)
        guard nextIndex < self.messages.endIndex else { return nil }
        return self.messages[nextIndex...].reversed().lazy.compactMap(Self.assistantHapticEvent).first
    }

    private func assistantHapticEvent(after timestamp: Double) -> OpenClawChatHaptics.Event? {
        self.messages.reversed().lazy.compactMap { message in
            guard (message.timestamp ?? 0) >= timestamp else { return nil }
            return Self.assistantHapticEvent(for: message)
        }.first
    }

    /// Pull canonical history for every session touched by one route-bound
    /// outbox pass. Background sessions only retire confirmed rows; the
    /// visible session also runs the normal reconciliation/cache pipeline.
    func refreshHistoriesAfterOutboxFlush(
        targets: Set<OutboxDeliveryTarget>,
        routeLease: OpenClawChatTransportRouteLease) async
    {
        let sortedTargets = targets.sorted { lhs, rhs in
            if lhs.deliverySessionKey != rhs.deliverySessionKey {
                return lhs.deliverySessionKey < rhs.deliverySessionKey
            }
            return (lhs.agentID ?? "") < (rhs.agentID ?? "")
        }
        for target in sortedTargets {
            let visibleRequest = matchesCurrentSessionKey(
                incoming: target.presentationSessionKey,
                agentId: target.agentID,
                current: self.sessionKey)
                ? self.beginHistoryRequest()
                : nil
            do {
                let payload = try await routeLease.requestHistory(
                    sessionKey: target.deliverySessionKey,
                    agentID: target.agentID)
                let incoming = Self.decodeMessages(payload.messages ?? [])
                await confirmOutboxCommandsNow(in: incoming)
                if let visibleRequest {
                    _ = self.applyHistoryPayload(
                        payload,
                        for: visibleRequest,
                        preservingOptimisticLocalMessages: true)
                }
            } catch is CancellationError {
                // The gateway route changed during confirmation. Keep every
                // unconfirmed row durable for a later matching reconnect.
                applyTransportHealth(false)
                return
            } catch {
                self.logDiagnostic(
                    "chat.ui outbox history failed sessionKey=\(target.deliverySessionKey) "
                        + "error=\(error.localizedDescription)")
            }
        }
    }

    @discardableResult
    func refreshHistoryAfterRun(historyRequest request: HistoryRequest? = nil) async
        -> RunHistoryRefreshResult
    {
        let request = request ?? self.beginHistoryRequest()
        do {
            let payload = try await transport.requestHistory(sessionKey: request.session.key)
            let runSnapshotApplied = request.runOwnershipGeneration == self.runOwnershipGeneration &&
                request.id >= self.latestAppliedRunSnapshotRequestID
            let applied = self.applyHistoryPayload(
                payload,
                for: request,
                preservingOptimisticLocalMessages: true)
            let hasInFlightRun = Self.normalizedRunID(payload.inFlightRun?.runId) != nil
            let sessionHasActiveRun = payload.sessionInfo?.hasActiveRun == true
            // `hasActiveRun` is session-wide and can be true for an embedded agent run.
            // Its presence capability-gates an authoritative missing chat snapshot, but
            // only `inFlightRun` establishes ownership of the pending chat run.
            let supportsInFlightRunState = hasInFlightRun || payload.sessionInfo?.hasActiveRun != nil
            return RunHistoryRefreshResult(
                applied: applied,
                runSnapshotApplied: applied && runSnapshotApplied,
                supportsInFlightRunState: supportsInFlightRunState,
                hasInFlightRun: hasInFlightRun,
                sessionHasActiveRun: sessionHasActiveRun)
        } catch {
            transportEventsLogger.error("refresh history failed \(error.localizedDescription, privacy: .public)")
            return .failed
        }
    }

    func armPendingRunOwner(
        runId: String,
        sessionSnapshot: SessionSnapshot? = nil,
        userMessageTimestamp: Double? = nil)
    {
        self.pendingRunOwnerTasks[runId]?.cancel()
        self.nextPendingRunOwnerArmID &+= 1
        let armID = self.nextPendingRunOwnerArmID
        let scope = self.runMessageScopesByRunID[runId]
        let session = sessionSnapshot ?? scope?.session ?? self.currentSessionSnapshot()
        let timestamp = userMessageTimestamp ?? scope?.latestUserTurn?.timestamp
        self.pendingRunOwnerArmIDs[runId] = armID
        // One arm owns both completion waits and history polling. Rearms cancel
        // every child so stale route/session results cannot retire a successor run.
        let owner = PendingRunOwnerReference(self)
        let transport = self.transport
        self.pendingRunOwnerTasks[runId] = Task {
            await Self.runPendingRunOwner(
                owner: owner,
                runId: runId,
                sessionSnapshot: session,
                userMessageTimestamp: timestamp,
                armID: armID,
                transport: transport)
        }
    }

    private nonisolated static func runPendingRunOwner(
        owner: PendingRunOwnerReference,
        runId: String,
        sessionSnapshot: SessionSnapshot,
        userMessageTimestamp: Double?,
        armID: UInt64,
        transport: any OpenClawChatTransport) async
    {
        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                await Self.observePendingRunCompletion(
                    owner: owner,
                    runId: runId,
                    sessionSnapshot: sessionSnapshot,
                    userMessageTimestamp: userMessageTimestamp,
                    armID: armID,
                    transport: transport)
            }
            group.addTask {
                await Self.pollPendingRunHistory(
                    owner: owner,
                    runId: runId,
                    sessionSnapshot: sessionSnapshot,
                    userMessageTimestamp: userMessageTimestamp,
                    armID: armID)
            }
            _ = await group.next()
            group.cancelAll()
        }
    }

    private nonisolated static func observePendingRunCompletion(
        owner: PendingRunOwnerReference,
        runId: String,
        sessionSnapshot: SessionSnapshot,
        userMessageTimestamp: Double?,
        armID: UInt64,
        transport: any OpenClawChatTransport) async
    {
        var terminalState: OpenClawChatRunTerminalState?
        var completedObservedAtMs: Double?
        while let timeoutMs = await Self.pendingRunWaitTimeout(
            owner: owner,
            runId: runId,
            sessionSnapshot: sessionSnapshot,
            armID: armID)
        {
            let observation = await transport.waitForRunCompletion(
                runId: runId,
                timeoutMs: timeoutMs)
            if case let .terminal(observedTerminalState) = observation {
                terminalState = observedTerminalState
                if observedTerminalState == .completed, completedObservedAtMs == nil {
                    completedObservedAtMs = Date().timeIntervalSince1970 * 1000
                }
            }
            let effectiveObservation = terminalState.map(OpenClawChatRunObservation.terminal) ?? observation
            guard let retryDelayMs = await Self.processPendingRunObservation(
                owner: owner,
                runId: runId,
                sessionSnapshot: sessionSnapshot,
                userMessageTimestamp: userMessageTimestamp,
                armID: armID,
                observation: effectiveObservation,
                completedObservedAtMs: completedObservedAtMs)
            else { return }
            do {
                try await Task.sleep(nanoseconds: retryDelayMs * 1_000_000)
            } catch {
                return
            }
        }
    }

    private static func pendingRunWaitTimeout(
        owner: PendingRunOwnerReference,
        runId: String,
        sessionSnapshot: SessionSnapshot,
        armID: UInt64) -> Int?
    {
        guard let model = owner.value,
              model.isCurrentPendingRunOwner(
                  runId: runId,
                  sessionSnapshot: sessionSnapshot,
                  armID: armID)
        else { return nil }
        return Int(model.pendingRunWaitTimeoutMs)
    }

    private static func processPendingRunObservation(
        owner: PendingRunOwnerReference,
        runId: String,
        sessionSnapshot: SessionSnapshot,
        userMessageTimestamp: Double?,
        armID: UInt64,
        observation: OpenClawChatRunObservation,
        completedObservedAtMs: Double?) async -> UInt64?
    {
        guard let model = owner.value,
              model.isCurrentPendingRunOwner(
                  runId: runId,
                  sessionSnapshot: sessionSnapshot,
                  armID: armID)
        else { return nil }
        switch observation {
        case let .terminal(terminalState):
            let terminalAgeMs = completedObservedAtMs.map {
                (Date().timeIntervalSince1970 * 1000) - $0
            }
            let allowNoOutputCompletion = terminalAgeMs.map {
                $0 >= Double(model.pendingRunTerminalHistoryGraceMs)
            } ?? false
            let shouldContinue = await model.refreshIfPending(
                runId: runId,
                sessionSnapshot: sessionSnapshot,
                armID: armID,
                after: userMessageTimestamp,
                terminalState: terminalState,
                allowNoOutputCompletion: allowNoOutputCompletion,
                diagnostic: "chat.ui run observation sessionKey=\(sessionSnapshot.key) "
                    + "runId=\(runId) observation=\(observation)")
            return shouldContinue ? model.pendingRunTerminalRetryMs : nil
        case .checkAgain:
            let shouldContinue = await model.refreshIfPending(
                runId: runId,
                sessionSnapshot: sessionSnapshot,
                armID: armID,
                after: userMessageTimestamp,
                diagnostic: "chat.ui run observation sessionKey=\(sessionSnapshot.key) "
                    + "runId=\(runId) observation=\(observation)")
            return shouldContinue ? model.pendingRunTerminalRetryMs : nil
        case .unavailable:
            return model.pendingRunUnavailableRetryMs
        }
    }

    private nonisolated static func pollPendingRunHistory(
        owner: PendingRunOwnerReference,
        runId: String,
        sessionSnapshot: SessionSnapshot,
        userMessageTimestamp: Double?,
        armID: UInt64) async
    {
        var delayIndex = 0
        while let delayMs = await Self.pendingRunRefreshDelay(
            owner: owner,
            runId: runId,
            sessionSnapshot: sessionSnapshot,
            armID: armID,
            delayIndex: delayIndex)
        {
            delayIndex += 1
            do {
                try await Task.sleep(nanoseconds: delayMs * 1_000_000)
            } catch {
                return
            }
            let shouldContinue = await Self.refreshPendingRunOwner(
                owner: owner,
                runId: runId,
                sessionSnapshot: sessionSnapshot,
                armID: armID,
                after: userMessageTimestamp,
                diagnostic: "chat.ui pending refresh sessionKey=\(sessionSnapshot.key) "
                    + "runId=\(runId) delayMs=\(delayMs)")
            guard shouldContinue else { return }
        }
    }

    private static func pendingRunRefreshDelay(
        owner: PendingRunOwnerReference,
        runId: String,
        sessionSnapshot: SessionSnapshot,
        armID: UInt64,
        delayIndex: Int) -> UInt64?
    {
        guard let model = owner.value,
              model.isCurrentPendingRunOwner(
                  runId: runId,
                  sessionSnapshot: sessionSnapshot,
                  armID: armID)
        else { return nil }
        return delayIndex < model.pendingRunRefreshDelaysMs.count
            ? model.pendingRunRefreshDelaysMs[delayIndex]
            : model.pendingRunSteadyRefreshDelayMs
    }

    private static func refreshPendingRunOwner(
        owner: PendingRunOwnerReference,
        runId: String,
        sessionSnapshot: SessionSnapshot,
        armID: UInt64,
        after timestamp: Double?,
        diagnostic: String) async -> Bool
    {
        guard let model = owner.value else { return false }
        return await model.refreshIfPending(
            runId: runId,
            sessionSnapshot: sessionSnapshot,
            armID: armID,
            after: timestamp,
            diagnostic: diagnostic)
    }

    func clearPendingRun(
        _ runId: String,
        hapticEvent: OpenClawChatHaptics.Event? = nil)
    {
        let wasPending = self.pendingRuns.contains(runId)
        self.pendingRuns.remove(runId)
        self.clearPlan(for: runId)
        self.pendingLocalUserEchoMessageIDsByRunID[runId] = nil
        self.pendingRunOwnerTasks[runId]?.cancel()
        self.pendingRunOwnerTasks[runId] = nil
        self.pendingRunOwnerArmIDs[runId] = nil
        if wasPending {
            self.logDiagnostic(
                "chat.ui pending cleared sessionKey=\(self.sessionKey) "
                    + "runId=\(runId)")
            if self.pendingRuns.isEmpty, let hapticEvent {
                self.haptics.perform(hapticEvent)
            }
        }
    }

    func clearPendingRuns(
        reason: String?,
        hapticEvent: OpenClawChatHaptics.Event? = nil,
        preservePlan: Bool = false)
    {
        let runIds = Array(pendingRuns)
        for runId in self.pendingRuns {
            self.pendingRunOwnerTasks[runId]?.cancel()
        }
        self.pendingRunOwnerTasks.removeAll()
        self.pendingRunOwnerArmIDs.removeAll()
        self.pendingRuns.removeAll()
        if !preservePlan {
            self.clearPlan()
        }
        self.pendingLocalUserEchoMessageIDsByRunID.removeAll()
        if !runIds.isEmpty, let hapticEvent {
            self.haptics.perform(hapticEvent)
        }
        if let reason, !reason.isEmpty {
            self.errorText = reason
            for runId in runIds {
                self.logDiagnostic(
                    "chat.ui pending cleared sessionKey=\(self.sessionKey) "
                        + "runId=\(runId) reason=\(reason)")
            }
        }
    }
}
