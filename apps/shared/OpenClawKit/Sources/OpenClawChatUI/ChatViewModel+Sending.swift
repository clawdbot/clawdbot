import Foundation
import OpenClawKit
import OSLog

struct SlashFilterCache {
    let query: String
    let filter: OpenClawChatCommandFilter
    let result: [OpenClawChatCommandChoice]
}

private let chatSendingLogger = Logger(subsystem: "ai.openclaw", category: "OpenClawChatUI")

extension OpenClawChatViewModel {
    public var canSend: Bool {
        !isSubmittingDraft &&
            !isSending &&
            self.attachmentStagingCount == 0 &&
            !self.hasBlockingRunActivity &&
            self.hasDraftToSend
    }

    public var hasDraftToSend: Bool {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty || !attachments.isEmpty
    }

    var hasBlockingRunActivity: Bool {
        pendingRunCount > 0 || self.hasAdvertisedLiveRun ||
            hasActiveSessionRunWithoutChatSnapshot || isSwitchingSessionBranch
    }

    var workingIndicatorIdentity: String {
        let selectedRunIDs = self.liveUsageRunID.map { Set([$0]) } ?? []
        return ChatWorkingIdentity.resolve(
            sessionKey: sessionKey,
            pendingRunIDs: selectedRunIDs,
            localUserMessageIDsByRunID: pendingLocalUserEchoMessageIDsByRunID,
            fallbackGeneration: runOwnershipGeneration)
    }

    public func send() {
        logDiagnostic(
            "chat.ui send invoked sessionKey=\(sessionKey) "
                + "inputLen=\(input.count) attachments=\(attachments.count) "
                + "pending=\(pendingRunCount) sending=\(isSending) "
                + "health=\(healthOK)")
        Task { await self.performSend() }
    }

    public func loadSlashCommandsIfNeeded() {
        guard transport.supportsSlashCommandCatalog else { return }
        guard !hasLoadedSlashCommands, !isLoadingSlashCommands else { return }
        Task { await self.loadSlashCommands(force: false) }
    }

    public func refreshSlashCommands() {
        guard transport.supportsSlashCommandCatalog else { return }
        Task { await self.loadSlashCommands(force: true) }
    }

    public func slashCommandMatches(
        query: String,
        filter: OpenClawChatCommandFilter) -> [OpenClawChatCommandChoice]
    {
        if let cache = slashFilterCache, cache.query == query, cache.filter == filter {
            return cache.result
        }
        let result = Self.filteredSlashCommands(slashCommands, query: query, filter: filter)
        slashFilterCache = SlashFilterCache(query: query, filter: filter, result: result)
        return result
    }

    public func applySlashCommandSelection(_ command: OpenClawChatCommandChoice) {
        let invocation = command.preferredInvocation.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !invocation.isEmpty else { return }
        input = command.acceptsArgs ? "\(invocation) " : invocation
        errorText = nil
    }

    private static let resetTriggers: Set<String> = ["/reset", "/clear"]
    private static let compactTriggers: Set<String> = ["/compact"]

    private func loadSlashCommands(force: Bool) async {
        guard transport.supportsSlashCommandCatalog else { return }
        guard force || !hasLoadedSlashCommands else { return }
        guard !isLoadingSlashCommands else { return }
        let sessionSnapshot = currentSessionSnapshot()
        isLoadingSlashCommands = true
        defer { self.isLoadingSlashCommands = false }

        do {
            let commands = try await transport.listCommands(sessionKey: sessionSnapshot.key)
            guard isCurrentSession(sessionSnapshot) else { return }
            slashCommands = commands
            slashFilterCache = nil
            slashCommandsErrorText = nil
            hasLoadedSlashCommands = true
        } catch {
            guard isCurrentSession(sessionSnapshot) else { return }
            slashCommandsErrorText = error.localizedDescription
        }
    }

    private func waitForSlashCommandLoadIfNeeded() async {
        guard transport.supportsSlashCommandCatalog else { return }
        if !hasLoadedSlashCommands, !isLoadingSlashCommands {
            await self.loadSlashCommands(force: false)
            return
        }
        while isLoadingSlashCommands {
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
            errorText = "Choose a command."
            return false
        }

        await self.waitForSlashCommandLoadIfNeeded()

        if hasLoadedSlashCommands,
           Self.isKnownSlashCommandText(trimmed, commands: slashCommands),
           hasAttachments
        {
            errorText = "Commands cannot be sent with attachments."
            return false
        }
        return true
    }

    func resetSlashCommandCatalog() {
        slashCommands = []
        slashFilterCache = nil
        slashCommandsErrorText = nil
        hasLoadedSlashCommands = false
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
            if input == draftInput {
                input = ""
            }
            await performStartNewSession(worktree: false)
            return true
        }
        if Self.resetTriggers.contains(command) {
            if input == draftInput {
                input = ""
            }
            await performReset()
            return true
        }
        if Self.compactTriggers.contains(command) {
            if input == draftInput {
                input = ""
            }
            await performCompact()
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
        guard isCurrentSession(session) else { return false }
        guard healthOK else {
            errorText = "Connect to the gateway to run this command."
            return false
        }
        return true
    }

    private struct SendDraft {
        let input: String
        let attachments: [OpenClawPendingAttachment]
        let trimmed: String
        let session: SessionSnapshot
        let replyTarget: OpenClawChatReplyTarget?
        let composerRevision: UInt64

        var messageText: String {
            self.trimmed.isEmpty && !self.attachments.isEmpty ? "See attached." : self.trimmed
        }

        var outgoingMessageText: String {
            guard let replyTarget else { return self.messageText }
            // Web quotes attachment-only replies with an empty typed prompt;
            // retain that exact trailing separator rather than adding the
            // native attachment fallback text.
            return ChatReplyQuote.prepend(message: self.trimmed, replyTarget: replyTarget)
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
        guard let draft = captureSendDraft() else { return }

        // Own every asynchronous validation/probe below. Slash catalog lookup
        // can suspend, so taking this gate later permits duplicate enqueues.
        // It also makes the captured reply selection single-submission; exact
        // target identity keeps a later re-selection safe from completion.
        // Keep it separate from isSending: local /compact checks that flag.
        isSubmittingDraft = true
        defer { self.isSubmittingDraft = false }

        guard await self.validateSendDraft(draft) else { return }

        isSending = true
        isSendingAttachmentDraft = !draft.attachments.isEmpty
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
        guard !isSubmittingDraft, !isSending else {
            logDiagnostic("chat.ui send ignored reason=sending sessionKey=\(sessionKey)")
            return nil
        }
        guard self.attachmentStagingCount == 0 else {
            // File reads and image processing suspend before publishing the
            // attachment. Do not let a programmatic send overtake that owner.
            logDiagnostic("chat.ui send ignored reason=attachment-staging sessionKey=\(sessionKey)")
            return nil
        }
        guard !self.hasBlockingRunActivity else {
            logDiagnostic(
                "chat.ui send ignored reason=pending sessionKey=\(sessionKey) "
                    + "pending=\(pendingRunCount) "
                    + "activeWithoutSnapshot=\(hasActiveSessionRunWithoutChatSnapshot)")
            return nil
        }
        let input = self.input
        let attachments = self.attachments
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty else {
            logDiagnostic("chat.ui send ignored reason=empty sessionKey=\(sessionKey)")
            return nil
        }
        return SendDraft(
            input: input,
            attachments: attachments,
            trimmed: trimmed,
            session: currentSessionSnapshot(),
            replyTarget: Self.isSlashCommandDraft(trimmed) ? nil : replyTarget,
            composerRevision: composerRevision(for: sessionKey))
    }

    private func validateSendDraft(_ draft: SendDraft) async -> Bool {
        let command = draft.trimmed.lowercased()
        if Self.isLiveOnlyLocalSlashCommand(command) {
            let canRunCommand = await prepareLiveOnlyLocalSlashCommand(session: draft.session)
            guard canRunCommand else { return false }
        }
        if await self.handleLocalSlashCommandIfNeeded(command, draftInput: draft.input) {
            self.recordSuccessfulInput(
                draft.trimmed,
                submittedRevision: draft.composerRevision,
                sessionKey: draft.session.key)
            return false
        }
        return await self.validateSlashCommandDraftForSend(
            trimmed: draft.trimmed,
            hasAttachments: !draft.attachments.isEmpty)
    }

    private func prepareLiveRoute(for draft: SendDraft) async -> Bool {
        let sessionKey = draft.session.key
        if !healthOK {
            await pollHealthIfNeeded(force: true, sessionSnapshot: draft.session)
            guard isCurrentSession(draft.session) else { return false }
            // Offline capture: queue the full draft durably instead of
            // dropping user text or attachment bytes.
            if !healthOK, outbox != nil {
                logDiagnostic(
                    "chat.ui send queued offline sessionKey=\(sessionKey) inputLen=\(draft.trimmed.count)")
                let accepted = await enqueueOutboxCommand(
                    text: draft.outgoingMessageText,
                    draftInput: draft.input,
                    draftRevision: draft.composerRevision,
                    draftAttachments: draft.attachments,
                    session: draft.session)
                if accepted {
                    self.finishAcceptedComposerSend(draft)
                }
                return false
            }
        }

        let mustPreserveOutboxOrder = self.hasPendingOutboxCommandsForCurrentSession
        let attachmentDecision = await attachmentPersistenceDecision(
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
        if outbox != nil,
           shouldPersistAttachmentDraft || mustPreserveOutboxOrder
        {
            logDiagnostic(
                "chat.ui send routed behind outbox sessionKey=\(sessionKey) inputLen=\(draft.trimmed.count)")
            let accepted = await enqueueOutboxCommand(
                text: draft.outgoingMessageText,
                draftInput: draft.input,
                draftRevision: draft.composerRevision,
                draftAttachments: draft.attachments,
                session: draft.session)
            if accepted {
                self.finishAcceptedComposerSend(draft)
            }
            return false
        }
        return true
    }

    private func attachmentPersistenceDecision(
        _ draft: SendDraft,
        mustPreserveOutboxOrder: Bool) async -> AttachmentPersistenceDecision
    {
        guard !draft.attachments.isEmpty,
              healthOK,
              outbox != nil
        else {
            return draft.attachments.isEmpty ? .liveOnly : .persistIfAvailable
        }
        let routeResult = await transport.acquireOutboxRouteLease()
        guard isCurrentSession(draft.session) else { return .stop }
        guard case let .unavailable(reason) = routeResult,
              reason == OpenClawChatTransportUpgradeMessage.routingContract
        else {
            return .persistIfAvailable
        }
        guard hasRestoredOutboxMessages else {
            errorText = "Restoring queued messages. Try again in a moment."
            return .stop
        }
        guard !mustPreserveOutboxOrder else {
            // A legacy gateway cannot drain the existing durable rows, so keep
            // this new attachment in the composer behind them.
            errorText = reason
            return .stop
        }
        // Older healthy gateways can send attachments live but cannot safely
        // replay them. Preserve that shipped live-only path.
        return .liveOnly
    }

    private func beginLiveSend(_ draft: SendDraft) -> LiveSendAttempt {
        errorText = nil
        let runId = UUID().uuidString
        let storedThinkingLevel = preferredThinkingLevel
        pendingRuns.insert(runId)
        logDiagnostic(
            "chat.ui send queued sessionKey=\(draft.session.key) "
                + "localRunId=\(runId) pending=\(pendingRunCount)")
        pendingToolCallsById = [:]
        updateStreamingAssistantText(nil)
        clearPlan()

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
            messageText: draft.outgoingMessageText,
            attachments: draft.attachments,
            encodedAttachments: encodedAttachments)
        let userMessageTimestamp = Date().timeIntervalSince1970 * 1000
        let userMessageID = UUID()
        appendMessage(
            OpenClawChatMessage(
                id: userMessageID,
                role: "user",
                content: userContent,
                timestamp: userMessageTimestamp,
                idempotencyKey: "\(runId):user"))
        pendingLocalUserEchoMessageIDsByRunID[runId] = userMessageID
        runMessageScopesByRunID[runId] = currentRunMessageScope()

        // Clear input immediately for responsive UX (before network await).
        if input == draft.input {
            input = ""
        }
        let sentAttachmentIDs = Set(draft.attachments.map(\.id))
        attachments.removeAll { sentAttachmentIDs.contains($0.id) }

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
            await waitForPendingSessionSettings(in: sessionKey)
            guard isCurrentSession(attempt.draft.session) else { return }
            logDiagnostic(
                "chat.ui transport send start sessionKey=\(sessionKey) "
                    + "localRunId=\(attempt.runId)")
            let thinkingLevel = effectiveThinkingLevelForSend(attempt.storedThinkingLevel)
            let response = try await transport.sendMessage(
                sessionKey: sessionKey,
                agentID: attempt.draft.session.deliveryAgentID,
                expectedSessionRoutingContract: attempt.draft.session.sessionRoutingContract,
                message: attempt.draft.outgoingMessageText,
                thinking: thinkingLevel,
                idempotencyKey: attempt.runId,
                attachments: attempt.encodedAttachments)
            guard isCurrentSession(attempt.draft.session) else { return }
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
        logDiagnostic(
            "chat.ui transport send accepted sessionKey=\(sessionKey) "
                + "localRunId=\(attempt.runId) remoteRunId=\(response.runId)")
        if response.status != "error", response.status != "timeout" {
            haptics.perform(.messageSent)
            self.finishAcceptedComposerSend(attempt.draft)
        }
        let reusedRunAlreadyFinal = response.runId == attempt.runId
            ? false
            : self.adoptRemoteRunID(response.runId, replacing: attempt.runId)

        if response.status == "ok" {
            let historyContext = beginHistoryRequest(for: attempt.draft.session)
            await refreshHistoryAfterRun(historyRequest: historyContext)
            guard isCurrentSession(attempt.draft.session) else { return }
            finishPendingRunAfterTerminalOkSendAck(response)
            return
        }
        guard !finishPendingRunIfTerminalSendAck(response),
              !reusedRunAlreadyFinal
        else {
            return
        }

        let historyContext = beginHistoryRequest(for: attempt.draft.session)
        let refresh = await refreshHistoryAfterRun(historyRequest: historyContext)
        guard isCurrentSession(attempt.draft.session) else { return }
        let hasInFlightRunSnapshot = refresh.applied &&
            refresh.runSnapshotApplied &&
            refresh.hasInFlightRun
        if hasInFlightRunSnapshot ||
            !clearPendingRunIfAssistantMessagePresent(
                runId: response.runId,
                after: attempt.userMessageTimestamp)
        {
            armPendingRunOwner(
                runId: response.runId,
                sessionSnapshot: attempt.draft.session,
                userMessageTimestamp: attempt.userMessageTimestamp)
        }
    }

    private func adoptRemoteRunID(_ remoteRunId: String, replacing localRunId: String) -> Bool {
        let pendingUserMessageID = pendingLocalUserEchoMessageIDsByRunID.removeValue(forKey: localRunId)
        let localRunScope = runMessageScopesByRunID.removeValue(forKey: localRunId)
        clearPendingRun(localRunId)
        pendingRuns.insert(remoteRunId)
        // The gateway can reuse an identical active run without writing this
        // second turn. Move the optimistic row onto that durable identity,
        // collapsing it if the canonical row is already here.
        let rekeyedUserEcho = rekeyLocalUserEcho(
            messageID: pendingUserMessageID,
            runId: remoteRunId)
        pendingLocalUserEchoMessageIDsByRunID[remoteRunId] = rekeyedUserEcho?.pendingMessageID
        let remoteRunScope = rekeyedUserEcho?.scope ?? localRunScope ?? currentRunMessageScope()
        runMessageScopesByRunID[remoteRunId] = remoteRunScope
        rescopeProvisionalFinalMessages(runId: remoteRunId, scope: remoteRunScope)
        let reusedRunAlreadyFinal = hasRecordedFinalMessage(runId: remoteRunId)
        if reusedRunAlreadyFinal {
            clearPendingRun(remoteRunId, hapticEvent: .runCompleted)
            pendingToolCallsById = [:]
            updateStreamingAssistantText(nil)
        } else {
            armPendingRunOwner(
                runId: remoteRunId,
                sessionSnapshot: remoteRunScope.session,
                userMessageTimestamp: remoteRunScope.latestUserTurn?.timestamp)
        }
        return reusedRunAlreadyFinal
    }

    private func handleLiveSendFailure(_ error: Error, attempt: LiveSendAttempt) async {
        guard isCurrentSession(attempt.draft.session) else { return }
        if attempt.encodedAttachments.isEmpty, !(error is GatewayResponseError) {
            runMessageScopesByRunID.removeValue(forKey: attempt.runId)
            clearPendingRun(attempt.runId)
            let deliveryIsAmbiguous = !(error is OpenClawChatTransportSendError)
            let preserved = await preserveFailedLiveSend(
                runId: attempt.runId,
                text: attempt.draft.outgoingMessageText,
                thinking: effectiveThinkingLevelForSend(attempt.storedThinkingLevel),
                messageID: attempt.userMessageID,
                session: attempt.draft.session,
                deliveryIsAmbiguous: deliveryIsAmbiguous)
            if preserved {
                self.finishAcceptedComposerSend(attempt.draft)
                applyTransportHealth(false)
                let outcome = deliveryIsAmbiguous ? "delivery unconfirmed" : "queued after route change"
                logDiagnostic(
                    "chat.ui send \(outcome) sessionKey=\(attempt.draft.session.key) "
                        + "localRunId=\(attempt.runId) error=\(error.localizedDescription)")
                return
            }
            guard isCurrentSession(attempt.draft.session) else { return }
            // Refused persistence (queue full / broken store): restore the
            // draft so the text is not lost with the failed bubble.
            if input.isEmpty {
                input = attempt.draft.input
            }
        }
        self.restoreDraftAfterLiveSendFailure(attempt)
        removePendingLocalUserEcho(for: attempt.runId)
        runMessageScopesByRunID.removeValue(forKey: attempt.runId)
        errorText = error.localizedDescription
        clearPendingRun(attempt.runId, hapticEvent: .runFailed)
        logDiagnostic(
            "chat.ui send failed sessionKey=\(attempt.draft.session.key) "
                + "localRunId=\(attempt.runId) error=\(error.localizedDescription)")
        chatSendingLogger.error("chat transport send failed \(error.localizedDescription, privacy: .public)")
    }

    private func restoreDraftAfterLiveSendFailure(_ attempt: LiveSendAttempt) {
        if attempt.encodedAttachments.isEmpty, input.isEmpty {
            input = attempt.draft.input
        } else if !attempt.encodedAttachments.isEmpty {
            if input.isEmpty {
                input = attempt.draft.input
            }
            let currentAttachmentIDs = Set(attachments.map(\.id))
            let removedDraftAttachments = attempt.draft.attachments.filter {
                !currentAttachmentIDs.contains($0.id)
            }
            attachments.insert(contentsOf: removedDraftAttachments, at: 0)
        }
    }

    private static func isSlashCommandDraft(_ text: String) -> Bool {
        text.hasPrefix("/") && !text.hasPrefix("//")
    }

    private func finishAcceptedComposerSend(_ draft: SendDraft) {
        self.recordSuccessfulInput(
            draft.trimmed,
            transcriptEcho: draft.outgoingMessageText,
            submittedRevision: draft.composerRevision,
            sessionKey: draft.session.key)
        self.consumeReplyTarget(draft.replyTarget)
    }
}
