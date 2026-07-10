import Foundation
import OpenClawKit
import OSLog

private let chatSendingLogger = Logger(subsystem: "ai.openclaw", category: "OpenClawChatUI")

extension OpenClawChatViewModel {
    public func send() {
        self.logDiagnostic(
            "chat.ui send invoked sessionKey=\(self.sessionKey) "
                + "inputLen=\(self.input.count) attachments=\(self.attachments.count) "
                + "pending=\(self.pendingRunCount) sending=\(self.isSending) "
                + "health=\(self.healthOK)")
        Task { await self.performSend() }
    }

    public func loadSlashCommandsIfNeeded() {
        guard self.transport.supportsSlashCommandCatalog else { return }
        guard !self.hasLoadedSlashCommands, !self.isLoadingSlashCommands else { return }
        Task { await self.loadSlashCommands(force: false) }
    }

    public func refreshSlashCommands() {
        guard self.transport.supportsSlashCommandCatalog else { return }
        Task { await self.loadSlashCommands(force: true) }
    }

    public func slashCommandMatches(
        query: String,
        filter: OpenClawChatCommandFilter) -> [OpenClawChatCommandChoice]
    {
        if let cache = slashFilterCache, cache.query == query, cache.filter == filter {
            return cache.result
        }
        let result = Self.filteredSlashCommands(self.slashCommands, query: query, filter: filter)
        self.slashFilterCache = SlashFilterCache(query: query, filter: filter, result: result)
        return result
    }

    public func applySlashCommandSelection(_ command: OpenClawChatCommandChoice) {
        let invocation = command.preferredInvocation.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !invocation.isEmpty else { return }
        self.input = command.acceptsArgs ? "\(invocation) " : invocation
        self.errorText = nil
    }

    private static let resetTriggers: Set<String> = ["/reset", "/clear"]
    private static let compactTriggers: Set<String> = ["/compact"]

    private func loadSlashCommands(force: Bool) async {
        guard self.transport.supportsSlashCommandCatalog else { return }
        guard force || !self.hasLoadedSlashCommands else { return }
        guard !self.isLoadingSlashCommands else { return }
        let sessionSnapshot = self.currentSessionSnapshot()
        self.isLoadingSlashCommands = true
        defer { self.isLoadingSlashCommands = false }

        do {
            let commands = try await transport.listCommands(sessionKey: sessionSnapshot.key)
            guard self.isCurrentSession(sessionSnapshot) else { return }
            self.slashCommands = commands
            self.slashFilterCache = nil
            self.slashCommandsErrorText = nil
            self.hasLoadedSlashCommands = true
        } catch {
            guard self.isCurrentSession(sessionSnapshot) else { return }
            self.slashCommandsErrorText = error.localizedDescription
        }
    }

    private func waitForSlashCommandLoadIfNeeded() async {
        guard self.transport.supportsSlashCommandCatalog else { return }
        if !self.hasLoadedSlashCommands, !self.isLoadingSlashCommands {
            await self.loadSlashCommands(force: false)
            return
        }
        while self.isLoadingSlashCommands {
            do {
                try await Task.sleep(nanoseconds: 50_000_000)
            } catch {
                return
            }
        }
    }

    private func validateSlashCommandDraftForSend(trimmed: String, hasAttachments: Bool) async -> Bool {
        guard let slashName = Self.slashCommandName(from: trimmed) else {
            return true
        }
        guard !slashName.isEmpty else {
            self.errorText = "Choose a command."
            return false
        }

        await self.waitForSlashCommandLoadIfNeeded()

        if self.hasLoadedSlashCommands,
           Self.isKnownSlashCommandText(trimmed, commands: self.slashCommands),
           hasAttachments
        {
            self.errorText = "Commands cannot be sent with attachments."
            return false
        }
        return true
    }

    func resetSlashCommandCatalog() {
        self.slashCommands = []
        self.slashFilterCache = nil
        self.slashCommandsErrorText = nil
        self.hasLoadedSlashCommands = false
    }

    private static func slashCommandName(from text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/"), !trimmed.hasPrefix("//") else { return nil }
        let body = trimmed.dropFirst()
        guard let rawName = body.split(whereSeparator: { $0.isWhitespace }).first else {
            return ""
        }
        let name = rawName.split(separator: "@", maxSplits: 1, omittingEmptySubsequences: true).first ?? ""
        return String(name).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private static func isKnownSlashCommandText(
        _ text: String,
        commands: [OpenClawChatCommandChoice]) -> Bool
    {
        guard let commandName = slashCommandName(from: text), !commandName.isEmpty else {
            return false
        }
        if self.commands(commands, containInvocationName: commandName) {
            return true
        }
        guard commandName == "skill" else { return false }
        let parts = text.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: { $0.isWhitespace })
        guard parts.count >= 2 else {
            return self.commands(commands, containInvocationName: commandName)
        }
        let skillName = String(parts[1]).lowercased()
        return commands.contains { command in
            command.source == .skill && self.command(command, matchesInvocationName: skillName)
        }
    }

    private static func commands(
        _ commands: [OpenClawChatCommandChoice],
        containInvocationName name: String) -> Bool
    {
        commands.contains { self.command($0, matchesInvocationName: name) }
    }

    private static func command(
        _ command: OpenClawChatCommandChoice,
        matchesInvocationName name: String) -> Bool
    {
        let normalizedName = name.lowercased()
        if command.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == normalizedName {
            return true
        }
        return command.textAliases.contains { alias in
            self.slashCommandName(from: alias) == normalizedName
        }
    }

    private static func filteredSlashCommands(
        _ commands: [OpenClawChatCommandChoice],
        query rawQuery: String,
        filter: OpenClawChatCommandFilter) -> [OpenClawChatCommandChoice]
    {
        let trimmed = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        let query = self.normalizedSlashQuery(trimmed)
        let effectiveFilter: OpenClawChatCommandFilter =
            self.queryTargetsSkills(trimmed) && filter == .all ? .skills : filter
        return commands.enumerated()
            .compactMap { index, command -> (Int, Int, OpenClawChatCommandChoice)? in
                guard self.command(command, isIncludedIn: effectiveFilter) else { return nil }
                guard let rank = self.commandSearchRank(command, query: query) else { return nil }
                return (rank, index, command)
            }
            .sorted {
                if $0.0 != $1.0 {
                    return $0.0 < $1.0
                }
                return $0.1 < $1.1
            }
            .map(\.2)
    }

    private static func normalizedSlashQuery(_ query: String) -> String {
        let withoutSlash = query.hasPrefix("/") ? String(query.dropFirst()) : query
        let lower = withoutSlash.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if lower == "skill" {
            return ""
        }
        if lower.hasPrefix("skill ") {
            return String(lower.dropFirst("skill ".count)).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return lower
    }

    private static func queryTargetsSkills(_ query: String) -> Bool {
        let withoutSlash = query.hasPrefix("/") ? String(query.dropFirst()) : query
        let lower = withoutSlash.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return lower == "skill" || lower.hasPrefix("skill ")
    }

    private static func command(
        _ command: OpenClawChatCommandChoice,
        isIncludedIn filter: OpenClawChatCommandFilter) -> Bool
    {
        switch filter {
        case .all:
            true
        case .commands:
            command.source != .skill
        case .skills:
            command.source == .skill
        }
    }

    private static func commandSearchRank(
        _ command: OpenClawChatCommandChoice,
        query: String) -> Int?
    {
        guard !query.isEmpty else { return 0 }
        let names = ([command.name, command.preferredInvocation] + command.textAliases)
            .map { candidate in
                let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
                let withoutSlash = trimmed.hasPrefix("/") ? String(trimmed.dropFirst()) : trimmed
                return withoutSlash.lowercased()
            }
            .filter { !$0.isEmpty }
        if names.contains(where: { $0.hasPrefix(query) }) {
            return 0
        }
        if names.contains(where: { $0.contains(query) }) {
            return 1
        }
        if command.description.lowercased().contains(query) {
            return 2
        }
        if command.source.rawValue.lowercased().contains(query) {
            return 3
        }
        return nil
    }

    private func handleLocalSlashCommandIfNeeded(_ command: String, draftInput: String) async -> Bool {
        if command == "/new" {
            if self.input == draftInput { self.input = "" }
            await self.performStartNewSession(worktree: false)
            return true
        }
        if Self.resetTriggers.contains(command) {
            if self.input == draftInput { self.input = "" }
            await self.performReset()
            return true
        }
        if Self.compactTriggers.contains(command) {
            if self.input == draftInput { self.input = "" }
            await self.performCompact()
            return true
        }
        return false
    }

    private static func isLiveOnlyLocalSlashCommand(_ command: String) -> Bool {
        command == "/new" || self.resetTriggers.contains(command) || self.compactTriggers.contains(command)
    }

    private func prepareLiveOnlyLocalSlashCommand(session: SessionSnapshot) async -> Bool {
        // Always probe: a preserved view model can retain stale healthy state
        // after its transport disconnects without a health event. performSend
        // owns the send gate across this await.
        await pollHealthIfNeeded(force: true, sessionSnapshot: session)
        guard self.isCurrentSession(session) else { return false }
        guard self.healthOK else {
            self.errorText = "Connect to the gateway to run this command."
            return false
        }
        return true
    }

    private struct SendDraft {
        let input: String
        let attachments: [OpenClawPendingAttachment]
        let trimmed: String
        let session: SessionSnapshot

        var messageText: String {
            self.trimmed.isEmpty && !self.attachments.isEmpty ? "See attached." : self.trimmed
        }
    }

    private struct LiveSendAttempt {
        let draft: SendDraft
        let runId: String
        let storedThinkingLevel: String
        let encodedAttachments: [OpenClawChatAttachmentPayload]
        let userMessageTimestamp: Double
        let userMessageID: UUID
    }

    private enum AttachmentPersistenceDecision {
        case stop
        case persistIfAvailable
        case liveOnly
    }

    private func performSend() async {
        guard let draft = self.captureSendDraft() else { return }

        // Own every asynchronous validation/probe below. Slash catalog lookup
        // can suspend, so taking this gate later permits duplicate enqueues.
        // Keep it separate from isSending: local /compact checks that flag.
        self.isSubmittingDraft = true
        defer { self.isSubmittingDraft = false }

        guard await self.validateSendDraft(draft) else { return }

        self.isSending = true
        self.isSendingAttachmentDraft = !draft.attachments.isEmpty
        defer {
            self.isSendingAttachmentDraft = false
            self.isSending = false
            self.applyDeferredExternalStateIfReady()
        }

        guard await self.prepareLiveRoute(for: draft) else { return }
        let attempt = self.beginLiveSend(draft)
        await self.deliverLiveSend(attempt)
    }

    private func captureSendDraft() -> SendDraft? {
        guard !self.isSubmittingDraft, !self.isSending else {
            self.logDiagnostic("chat.ui send ignored reason=sending sessionKey=\(self.sessionKey)")
            return nil
        }
        guard !self.hasBlockingRunActivity else {
            self.logDiagnostic(
                "chat.ui send ignored reason=pending sessionKey=\(self.sessionKey) "
                    + "pending=\(self.pendingRunCount) "
                    + "activeWithoutSnapshot=\(self.hasActiveSessionRunWithoutChatSnapshot)")
            return nil
        }
        let input = self.input
        let attachments = self.attachments
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty else {
            self.logDiagnostic("chat.ui send ignored reason=empty sessionKey=\(self.sessionKey)")
            return nil
        }
        return SendDraft(
            input: input,
            attachments: attachments,
            trimmed: trimmed,
            session: self.currentSessionSnapshot())
    }

    private func validateSendDraft(_ draft: SendDraft) async -> Bool {
        let command = draft.trimmed.lowercased()
        if Self.isLiveOnlyLocalSlashCommand(command) {
            let canRunCommand = await self.prepareLiveOnlyLocalSlashCommand(session: draft.session)
            guard canRunCommand else { return false }
        }
        if await self.handleLocalSlashCommandIfNeeded(command, draftInput: draft.input) {
            return false
        }
        return await self.validateSlashCommandDraftForSend(
            trimmed: draft.trimmed,
            hasAttachments: !draft.attachments.isEmpty)
    }

    private func prepareLiveRoute(for draft: SendDraft) async -> Bool {
        let sessionKey = draft.session.key
        if !self.healthOK {
            await self.pollHealthIfNeeded(force: true, sessionSnapshot: draft.session)
            guard self.isCurrentSession(draft.session) else { return false }
            // Offline capture: queue the full draft durably instead of
            // dropping user text or attachment bytes.
            if !self.healthOK, self.outbox != nil {
                self.logDiagnostic(
                    "chat.ui send queued offline sessionKey=\(sessionKey) inputLen=\(draft.trimmed.count)")
                await self.enqueueOutboxCommand(
                    text: draft.messageText,
                    draftInput: draft.input,
                    draftAttachments: draft.attachments,
                    session: draft.session)
                return false
            }
        }

        let mustPreserveOutboxOrder = !self.hasRestoredOutboxMessages ||
            self.outboxStatesByMessageID.values.contains(where: { !$0.isFailed })
        let attachmentDecision = await self.attachmentPersistenceDecision(
            draft,
            mustPreserveOutboxOrder: mustPreserveOutboxOrder)
        let shouldPersistAttachmentDraft: Bool
        switch attachmentDecision {
        case .stop:
            return false
        case .persistIfAvailable:
            shouldPersistAttachmentDraft = true
        case .liveOnly:
            shouldPersistAttachmentDraft = false
        }

        // FIFO across the reconnect boundary: while this session still has
        // queued/sending outbox rows — or restore has not yet adopted rows
        // persisted by an earlier process, so we must assume a backlog — a
        // live send would race ahead of them. Route it through the outbox so
        // the queue stays the single ordering authority; it flushes
        // immediately while healthy, so the turn still sends right away.
        // Failed rows are parked user decisions and do not hold new sends
        // hostage. Outbox-backed attachments always take this persist-first
        // path so a crash cannot erase their only remaining bytes. Deliberately
        // session-scoped: other sessions are separate conversations with no
        // ordering contract.
        if self.outbox != nil,
           shouldPersistAttachmentDraft || mustPreserveOutboxOrder
        {
            self.logDiagnostic(
                "chat.ui send routed behind outbox sessionKey=\(sessionKey) inputLen=\(draft.trimmed.count)")
            await self.enqueueOutboxCommand(
                text: draft.messageText,
                draftInput: draft.input,
                draftAttachments: draft.attachments,
                session: draft.session)
            return false
        }
        return true
    }

    private func attachmentPersistenceDecision(
        _ draft: SendDraft,
        mustPreserveOutboxOrder: Bool) async -> AttachmentPersistenceDecision
    {
        guard !draft.attachments.isEmpty,
              self.healthOK,
              self.outbox != nil
        else {
            return draft.attachments.isEmpty ? .liveOnly : .persistIfAvailable
        }
        let routeResult = await self.transport.acquireOutboxRouteLease()
        guard self.isCurrentSession(draft.session) else { return .stop }
        guard case let .unavailable(reason) = routeResult,
              reason == OpenClawChatTransportUpgradeMessage.routingContract
        else {
            return .persistIfAvailable
        }
        guard self.hasRestoredOutboxMessages else {
            self.errorText = "Restoring queued messages. Try again in a moment."
            return .stop
        }
        guard !mustPreserveOutboxOrder else {
            // A legacy gateway cannot drain the existing durable rows, so keep
            // this new attachment in the composer behind them.
            self.errorText = reason
            return .stop
        }
        // Older healthy gateways can send attachments live but cannot safely
        // replay them. Preserve that shipped live-only path.
        return .liveOnly
    }

    private func beginLiveSend(_ draft: SendDraft) -> LiveSendAttempt {
        self.errorText = nil
        let runId = UUID().uuidString
        let storedThinkingLevel = self.preferredThinkingLevel
        self.pendingRuns.insert(runId)
        self.armPendingRunTimeout(runId: runId)
        self.logDiagnostic(
            "chat.ui send queued sessionKey=\(draft.session.key) "
                + "localRunId=\(runId) pending=\(self.pendingRunCount)")
        self.pendingToolCallsById = [:]
        self.updateStreamingAssistantText(nil)

        // Production attachment sends enter the durable outbox above. Fixture,
        // preview, and embedded transports may intentionally have no outbox;
        // keep their established live-only attachment path available.
        let encodedAttachments = draft.attachments.map { attachment in
            OpenClawChatAttachmentPayload(
                type: attachment.type,
                mimeType: attachment.mimeType,
                fileName: attachment.fileName,
                content: attachment.data.base64EncodedString())
        }
        let userContent = Self.userContent(
            messageText: draft.messageText,
            attachments: draft.attachments,
            encodedAttachments: encodedAttachments)
        let userMessageTimestamp = Date().timeIntervalSince1970 * 1000
        let userMessageID = UUID()
        self.appendMessage(
            OpenClawChatMessage(
                id: userMessageID,
                role: "user",
                content: userContent,
                timestamp: userMessageTimestamp,
                idempotencyKey: "\(runId):user"))
        self.pendingLocalUserEchoMessageIDsByRunID[runId] = userMessageID
        self.runMessageScopesByRunID[runId] = self.currentRunMessageScope()

        // Clear input immediately for responsive UX (before network await).
        if self.input == draft.input {
            self.input = ""
        }
        let sentAttachmentIDs = Set(draft.attachments.map(\.id))
        self.attachments.removeAll { sentAttachmentIDs.contains($0.id) }

        return LiveSendAttempt(
            draft: draft,
            runId: runId,
            storedThinkingLevel: storedThinkingLevel,
            encodedAttachments: encodedAttachments,
            userMessageTimestamp: userMessageTimestamp,
            userMessageID: userMessageID)
    }

    private static func userContent(
        messageText: String,
        attachments: [OpenClawPendingAttachment],
        encodedAttachments: [OpenClawChatAttachmentPayload]) -> [OpenClawChatMessageContent]
    {
        var content: [OpenClawChatMessageContent] = [
            OpenClawChatMessageContent(
                type: "text",
                text: messageText,
                thinking: nil,
                thinkingSignature: nil,
                mimeType: nil,
                fileName: nil,
                content: nil,
                id: nil,
                name: nil,
                arguments: nil),
        ]
        for (attachment, payload) in zip(attachments, encodedAttachments) {
            content.append(
                OpenClawChatMessageContent(
                    type: payload.type,
                    text: nil,
                    thinking: nil,
                    thinkingSignature: nil,
                    mimeType: payload.mimeType,
                    fileName: payload.fileName,
                    durationSeconds: attachment.durationSeconds,
                    content: AnyCodable(payload.content),
                    id: nil,
                    name: nil,
                    arguments: nil))
        }
        return content
    }

    private func deliverLiveSend(_ attempt: LiveSendAttempt) async {
        let sessionKey = attempt.draft.session.key
        do {
            await self.waitForPendingModelPatches(in: sessionKey)
            guard self.isCurrentSession(attempt.draft.session) else { return }
            self.logDiagnostic(
                "chat.ui transport send start sessionKey=\(sessionKey) "
                    + "localRunId=\(attempt.runId)")
            let thinkingLevel = self.effectiveThinkingLevelForSend(attempt.storedThinkingLevel)
            let response = try await self.transport.sendMessage(
                sessionKey: sessionKey,
                agentID: attempt.draft.session.deliveryAgentID,
                expectedSessionRoutingContract: attempt.draft.session.sessionRoutingContract,
                message: attempt.draft.messageText,
                thinking: thinkingLevel,
                idempotencyKey: attempt.runId,
                attachments: attempt.encodedAttachments)
            guard self.isCurrentSession(attempt.draft.session) else { return }
            await self.handleLiveSendResponse(response, attempt: attempt)
        } catch {
            await self.handleLiveSendFailure(error, attempt: attempt)
        }
    }

    private func handleLiveSendResponse(
        _ response: OpenClawChatSendResponse,
        attempt: LiveSendAttempt) async
    {
        let sessionKey = attempt.draft.session.key
        self.logDiagnostic(
            "chat.ui transport send accepted sessionKey=\(sessionKey) "
                + "localRunId=\(attempt.runId) remoteRunId=\(response.runId)")
        if response.status != "error", response.status != "timeout" {
            self.haptics.perform(.messageSent)
        }
        let reusedRunAlreadyFinal = response.runId == attempt.runId
            ? false
            : self.adoptRemoteRunID(response.runId, replacing: attempt.runId)

        if response.status == "ok" {
            let historyContext = self.beginHistoryRequest(for: attempt.draft.session)
            await self.refreshHistoryAfterRun(historyRequest: historyContext)
            guard self.isCurrentSession(attempt.draft.session) else { return }
            self.finishPendingRunAfterTerminalOkSendAck(response)
            return
        }
        guard !self.finishPendingRunIfTerminalSendAck(response),
              !reusedRunAlreadyFinal
        else {
            return
        }

        let historyContext = self.beginHistoryRequest(for: attempt.draft.session)
        let refresh = await self.refreshHistoryAfterRun(historyRequest: historyContext)
        guard self.isCurrentSession(attempt.draft.session) else { return }
        let hasInFlightRunSnapshot = refresh.applied &&
            refresh.runSnapshotApplied &&
            refresh.hasInFlightRun
        if hasInFlightRunSnapshot ||
            !self.clearPendingRunIfAssistantMessagePresent(
                runId: response.runId,
                after: attempt.userMessageTimestamp)
        {
            self.armPostSendRefreshFallback(
                runId: response.runId,
                sessionSnapshot: attempt.draft.session,
                userMessageTimestamp: attempt.userMessageTimestamp)
            self.armRunCompletionRefresh(
                runId: response.runId,
                sessionSnapshot: attempt.draft.session,
                userMessageTimestamp: attempt.userMessageTimestamp)
        }
    }

    private func adoptRemoteRunID(_ remoteRunId: String, replacing localRunId: String) -> Bool {
        let pendingUserMessageID = self.pendingLocalUserEchoMessageIDsByRunID.removeValue(forKey: localRunId)
        let localRunScope = self.runMessageScopesByRunID.removeValue(forKey: localRunId)
        self.clearPendingRun(localRunId)
        self.pendingRuns.insert(remoteRunId)
        // The gateway can reuse an identical active run without writing this
        // second turn. Move the optimistic row onto that durable identity,
        // collapsing it if the canonical row is already here.
        let rekeyedUserEcho = self.rekeyLocalUserEcho(
            messageID: pendingUserMessageID,
            runId: remoteRunId)
        self.pendingLocalUserEchoMessageIDsByRunID[remoteRunId] = rekeyedUserEcho?.pendingMessageID
        let remoteRunScope = rekeyedUserEcho?.scope ?? localRunScope ?? self.currentRunMessageScope()
        self.runMessageScopesByRunID[remoteRunId] = remoteRunScope
        self.rescopeProvisionalFinalMessages(runId: remoteRunId, scope: remoteRunScope)
        let reusedRunAlreadyFinal = self.hasRecordedFinalMessage(runId: remoteRunId)
        if reusedRunAlreadyFinal {
            self.clearPendingRun(remoteRunId, hapticEvent: .runCompleted)
            self.pendingToolCallsById = [:]
            self.updateStreamingAssistantText(nil)
        } else {
            self.armPendingRunTimeout(runId: remoteRunId)
        }
        return reusedRunAlreadyFinal
    }

    private func handleLiveSendFailure(_ error: Error, attempt: LiveSendAttempt) async {
        guard self.isCurrentSession(attempt.draft.session) else { return }
        if attempt.encodedAttachments.isEmpty, !(error is GatewayResponseError) {
            self.runMessageScopesByRunID.removeValue(forKey: attempt.runId)
            self.clearPendingRun(attempt.runId)
            let deliveryIsAmbiguous = !(error is OpenClawChatTransportSendError)
            let preserved = await self.preserveFailedLiveSend(
                runId: attempt.runId,
                text: attempt.draft.messageText,
                thinking: self.effectiveThinkingLevelForSend(attempt.storedThinkingLevel),
                messageID: attempt.userMessageID,
                session: attempt.draft.session,
                deliveryIsAmbiguous: deliveryIsAmbiguous)
            if preserved {
                self.applyTransportHealth(false)
                let outcome = deliveryIsAmbiguous ? "delivery unconfirmed" : "queued after route change"
                self.logDiagnostic(
                    "chat.ui send \(outcome) sessionKey=\(attempt.draft.session.key) "
                        + "localRunId=\(attempt.runId) error=\(error.localizedDescription)")
                return
            }
            guard self.isCurrentSession(attempt.draft.session) else { return }
            // Refused persistence (queue full / broken store): restore the
            // draft so the text is not lost with the failed bubble.
            if self.input.isEmpty {
                self.input = attempt.draft.messageText
            }
        }
        self.restoreDraftAfterLiveSendFailure(attempt)
        self.removePendingLocalUserEcho(for: attempt.runId)
        self.runMessageScopesByRunID.removeValue(forKey: attempt.runId)
        self.errorText = error.localizedDescription
        self.clearPendingRun(attempt.runId, hapticEvent: .runFailed)
        self.logDiagnostic(
            "chat.ui send failed sessionKey=\(attempt.draft.session.key) "
                + "localRunId=\(attempt.runId) error=\(error.localizedDescription)")
        chatSendingLogger.error("chat transport send failed \(error.localizedDescription, privacy: .public)")
    }

    private func restoreDraftAfterLiveSendFailure(_ attempt: LiveSendAttempt) {
        if attempt.encodedAttachments.isEmpty, self.input.isEmpty {
            self.input = attempt.draft.messageText
        } else if !attempt.encodedAttachments.isEmpty {
            if self.input.isEmpty {
                self.input = attempt.draft.input
            }
            let currentAttachmentIDs = Set(self.attachments.map(\.id))
            let removedDraftAttachments = attempt.draft.attachments.filter {
                !currentAttachmentIDs.contains($0.id)
            }
            self.attachments.insert(contentsOf: removedDraftAttachments, at: 0)
        }
    }
}
