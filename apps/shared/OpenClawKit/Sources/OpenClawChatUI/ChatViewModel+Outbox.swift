import Foundation
import OpenClawKit
import OSLog

private let outboxLogger = Logger(subsystem: "ai.openclaw", category: "OpenClawChatOutbox")

/// Display state for a transcript row backed by a durable outbox command.
public enum OpenClawChatOutboxMessageState: Equatable, Sendable {
    case queued
    case sending
    case confirming
    case failed(reason: String?)

    public var isFailed: Bool {
        if case .failed = self { return true }
        return false
    }

    var preventsDeletion: Bool {
        self == .sending || self == .confirming
    }
}

/// Durable offline command outbox. Sends made while the gateway is unhealthy
/// are persisted in installation-wide client state and flushed
/// strictly in createdAt order when health recovers. A gateway ACK only moves
/// a row to awaiting-confirmation; canonical history owns durable completion.
extension OpenClawChatViewModel {
    struct OutboxDeliveryTarget: Hashable {
        let presentationSessionKey: String
        let deliverySessionKey: String
        let agentID: String?
    }

    private enum OutboxFlushDisposition {
        case continueFlush
        case continueAndReconcile(OutboxDeliveryTarget)
        case stop
        case stopAndReconcile(OutboxDeliveryTarget)
    }

    public func outboxState(for messageID: UUID) -> OpenClawChatOutboxMessageState? {
        self.outboxStatesByMessageID[messageID]
    }

    static func activeBranchLeafEntryID(in branches: [OpenClawChatSessionBranch]) -> String? {
        let active = branches.filter(\.active)
        guard active.count == 1 else { return nil }
        let leaf = active[0].leafEntryId.trimmingCharacters(in: .whitespacesAndNewlines)
        return leaf.isEmpty ? nil : leaf
    }

    static func branchListingIsUnsupported(_ error: Error) -> Bool {
        if let gatewayError = error as? GatewayResponseError {
            let message = gatewayError.message.lowercased()
            return message.contains("sessions.branches.list") &&
                (gatewayError.code == "INVALID_REQUEST" ||
                    message.contains("unsupported") ||
                    message.contains("unimplemented"))
        }
        let error = error as NSError
        let message = error.localizedDescription.lowercased()
        return message.contains("sessions.branches.list") &&
            (message.contains("not supported") || message.contains("unsupported") ||
                message.contains("unimplemented") || message.contains("unknown method"))
    }

    func outboxBranchScope(for session: SessionSnapshot) -> OpenClawChatOutboxScope? {
        let agentID = self.outboxAgentID(for: session)
        guard !self.outboxRequiresAgentID(for: session) || agentID != nil else { return nil }
        return OpenClawChatOutboxScope(sessionKey: session.key, agentID: agentID)
    }

    private static func outboxBranchScope(for command: OpenClawChatOutboxCommand) -> OpenClawChatOutboxScope {
        OpenClawChatOutboxScope(sessionKey: command.sessionKey, agentID: command.agentID)
    }

    var hasPendingOutboxCommandsForCurrentSession: Bool {
        self
            .outbox != nil &&
            (!self.hasRestoredOutboxMessages || self.outboxStatesByMessageID.values.contains { !$0.isFailed })
    }

    var hasUnresolvedOutboxCommandsForCurrentSession: Bool {
        self.outbox != nil && (!self.hasRestoredOutboxMessages || !self.outboxStatesByMessageID.isEmpty)
    }

    func beginOutboxSessionMutation(_ session: SessionSnapshot) async -> Bool {
        guard let outbox, let scope = self.outboxBranchScope(for: session) else { return self.outbox == nil }
        await self.pendingCacheWriteTask?.value
        return await outbox.beginBranchSwitch(scope)
    }

    func cancelOutboxSessionMutation(_ session: SessionSnapshot) async {
        guard let outbox, let scope = self.outboxBranchScope(for: session) else { return }
        _ = await outbox.cancelBranchSwitch(scope)
    }

    func recoverOutboxAfterSessionMutationRefreshFailure(
        _ session: SessionSnapshot,
        branchingUnsupported: Bool) async
    {
        self.pauseOutboxBranchScope(session)
        if let outbox = self.outbox, let scope = self.outboxBranchScope(for: session) {
            _ = await outbox.demoteBranchSwitchToReconcile(scope)
        }
        if branchingUnsupported {
            self.allowOutboxReplayWithoutBranching(session)
        } else {
            self.reconcilePendingOutboxBranchScopes()
        }
    }

    func confirmOutboxBranchChange(_ session: SessionSnapshot, activeLeafEntryID: String) async -> Bool {
        guard let outbox, let scope = self.outboxBranchScope(for: session) else { return self.outbox == nil }
        self.reconciledOutboxBranchScopes.remove(scope)
        await self.pendingCacheWriteTask?.value
        guard let commands = await outbox.confirmBranchChange(
            scope,
            activeLeafEntryID: activeLeafEntryID,
            lastError: "Session branch changed; review and retry this message.")
        else { return false }
        self.reconciledOutboxBranchScopes.insert(scope)
        guard self.isCurrentSession(session) else { return true }
        self.presentOutboxCommands(commands.filter { self.commandMatchesTarget($0, session: session) })
        return true
    }

    func pauseOutboxBranchScope(_ session: SessionSnapshot) {
        guard let scope = self.outboxBranchScope(for: session) else { return }
        self.reconciledOutboxBranchScopes.remove(scope)
    }

    func captureOutboxBranchState(for session: SessionSnapshot) async -> OpenClawChatOutboxBranchState? {
        guard let outbox, let scope = self.outboxBranchScope(for: session) else { return nil }
        await self.pendingCacheWriteTask?.value
        return await outbox.branchState(for: scope)
    }

    private func waitForBootstrapOutboxBranchCapture(for session: SessionSnapshot) async {
        guard let capture = self.bootstrapOutboxBranchStateCapture, capture.session == session else { return }
        _ = await capture.task.value
    }

    func observeOutboxTranscriptTip(_ message: OpenClawChatMessage, session: SessionSnapshot) {
        guard let outbox, let scope = self.outboxBranchScope(for: session),
              let tip = message.transcriptMessageID?.trimmingCharacters(in: .whitespacesAndNewlines), !tip.isEmpty
        else { return }
        let state = Task { await outbox.branchState(for: scope) }
        let previous = self.pendingCacheWriteTask
        self.pendingCacheWriteTask = Task.detached {
            await previous?.value
            guard let epoch = await state.value?.epoch else { return }
            _ = await outbox.updateLastActiveLeafEntryID(tip, expectedEpoch: epoch, for: scope)
        }
    }

    @discardableResult
    func reconcileOutboxBranchScope(
        _ session: SessionSnapshot,
        branches: [OpenClawChatSessionBranch],
        previousState: OpenClawChatOutboxBranchState?,
        connectionGeneration: UInt64) async -> Bool
    {
        guard let outbox, let scope = self.outboxBranchScope(for: session), let previousState,
              connectionGeneration == self.outboxBranchConnectionGeneration
        else { return self.outbox == nil }
        let activeLeaf: String? = branches.isEmpty ? nil : Self.activeBranchLeafEntryID(in: branches)
        guard branches.isEmpty || activeLeaf != nil else { return false }
        let leaves = Set(branches.map(\.leafEntryId).filter { !$0.isEmpty })
        let activeTranscriptEntryIDs = self.isCurrentSession(session)
            ? Set(self.messages.compactMap(\.transcriptMessageID))
            : []
        guard let commands = await outbox.reconcileBranchScope(
            scope,
            previousState: previousState,
            activeLeafEntryID: activeLeaf,
            branchLeafEntryIDs: leaves,
            activeTranscriptEntryIDs: activeTranscriptEntryIDs,
            lastError: "Session branch changed; review and retry this message.")
        else { return false }
        self.reconciledOutboxBranchScopes.insert(scope)
        if self.isCurrentSession(session) {
            self.presentOutboxCommands(commands.filter { self.commandMatchesTarget($0, session: session) })
        }
        return true
    }

    func allowOutboxReplayWithoutBranching(_ session: SessionSnapshot) {
        guard let scope = self.outboxBranchScope(for: session) else { return }
        self.reconciledOutboxBranchScopes.insert(scope)
        self.flushOutboxIfNeeded()
    }

    func reconcilePendingOutboxBranchScopes() {
        guard let outbox, self.healthOK else { return }
        Task { [weak self] in
            guard let self, let commands = await outbox.loadCommandsIfAvailable() else { return }
            let grouped = Dictionary(grouping: commands.filter {
                $0.status == .queued || $0.status == .sending || $0.status == .awaitingConfirmation
            }, by: Self.outboxBranchScope(for:))
            for (scope, scopedCommands) in grouped where !self.reconciledOutboxBranchScopes.contains(scope) {
                guard let command = scopedCommands.first,
                      let state = await outbox.branchState(for: scope)
                else { continue }
                do {
                    let response = try await self.transport.listSessionBranches(
                        sessionKey: command.deliverySessionKey,
                        agentID: command.agentID)
                    let activeLeaf: String? = response.branches.isEmpty ? nil : Self
                        .activeBranchLeafEntryID(in: response.branches)
                    guard response.branches.isEmpty || activeLeaf != nil else { continue }
                    let leaves = Set(response.branches.map(\.leafEntryId).filter { !$0.isEmpty })
                    let activeTranscriptEntryIDs = self.outboxBranchScope(for: self.currentSessionSnapshot()) == scope
                        ? Set(self.messages.compactMap(\.transcriptMessageID))
                        : []
                    guard let reconciled = await outbox.reconcileBranchScope(
                        scope,
                        previousState: state,
                        activeLeafEntryID: activeLeaf,
                        branchLeafEntryIDs: leaves,
                        activeTranscriptEntryIDs: activeTranscriptEntryIDs,
                        lastError: "Session branch changed; review and retry this message.")
                    else { continue }
                    self.reconciledOutboxBranchScopes.insert(scope)
                    let visible = self.currentSessionSnapshot()
                    if self.outboxBranchScope(for: visible) == scope {
                        self
                            .presentOutboxCommands(reconciled
                                .filter { self.commandMatchesTarget($0, session: visible) })
                    }
                } catch {
                    if Self.branchListingIsUnsupported(error) {
                        self.reconciledOutboxBranchScopes.insert(scope)
                    }
                }
            }
            self.flushOutboxIfNeeded()
        }
    }

    func invalidateOutboxBranchReconciliation() {
        self.outboxBranchConnectionGeneration &+= 1
        self.reconciledOutboxBranchScopes.removeAll()
        self.reconcilingOutboxBranchScopes.removeAll()
        for task in self.outboxBranchReconcileRetryTasks.values {
            task.cancel()
        }
        self.outboxBranchReconcileRetryTasks.removeAll()
        self.outboxBranchReconcileRetryAttempts.removeAll()
    }

    /// Tap-to-retry for a failed command: reset attempts, refresh createdAt
    /// (so even an expired row can send again), and flush if healthy.
    public func retryOutboxMessage(_ messageID: UUID) {
        guard !self.isSwitchingSessionBranch,
              let outbox,
              let commandID = self.outboxCommandIDsByMessageID[messageID],
              let failure = self.outboxFailureVersionsByMessageID[messageID]
        else { return }
        let session = self.currentSessionSnapshot()
        Task { [weak self] in
            guard let self else { return }
            let agentID = self.outboxAgentID(for: session)
            if self.outboxRequiresAgentID(for: session), agentID == nil {
                self.errorText = "Select an agent before retrying this message."
                return
            }
            guard
                let deliverySessionKey = self.outboxDeliverySessionKey(for: session, agentID: agentID),
                let routingContract = self.outboxRoutingContract(for: session)
            else {
                self.errorText = "Reconnect to verify this message's delivery target before retrying."
                return
            }
            let result = await outbox.markCommandRetriedIfPresent(
                id: commandID,
                expectation: OpenClawChatOutboxRetryExpectation(
                    attemptVersion: failure.attemptVersion,
                    retryCount: failure.retryCount,
                    lastError: failure.lastError),
                agentID: agentID,
                deliverySessionKey: deliverySessionKey,
                routingContract: routingContract,
                replacementID: UUID().uuidString)
            if result == .updated {
                // Durable work is gateway-global. Flush even when the visible
                // session changed while the SQLite update was suspended.
                self.flushOutboxIfNeeded()
            }
            guard self.isCurrentSession(session) else { return }
            switch result {
            case .updated:
                self.outboxStatesByMessageID[messageID] = .queued
                self.outboxFailureVersionsByMessageID.removeValue(forKey: messageID)
            case .missing, .confirmed, .superseded:
                self.clearOutboxState(forCommandID: commandID)
            case .unavailable:
                self.errorText = "Could not retry the queued message. Try again."
            }
        }
    }

    public func deleteOutboxMessage(_ messageID: UUID) {
        guard let outbox, let commandID = self.outboxCommandIDsByMessageID[messageID] else { return }
        self.cancelingOutboxCommandIDs.insert(commandID)
        self.outboxPresentationGeneration &+= 1
        Task { [weak self] in
            guard let self else { return }
            let result = await outbox.cancelCommand(id: commandID)
            guard result != .unavailable else {
                self.finishOutboxCancellation(commandID)
                self.errorText = "Could not delete the queued message. Try again."
                return
            }
            if result == .confirmed {
                self.finishOutboxCancellation(commandID)
                self.clearOutboxState(forCommandID: commandID)
                return
            }
            if result == .missing {
                let presentationGeneration = self.outboxPresentationGeneration
                let current = await outbox.loadCommands().first(where: { $0.id == commandID })
                guard presentationGeneration == self.outboxPresentationGeneration else {
                    self.finishOutboxCancellation(commandID)
                    return
                }
                if let current {
                    // Another view model claimed the row first. Keep the bubble
                    // and show its authoritative state; cancellation after claim
                    // would promise deletion while the request can still land.
                    self.finishOutboxCancellation(commandID)
                    self.presentOutboxCommands([current])
                    return
                }
            }
            if self.canonicalOutboxMessageKeys.contains("\(commandID):user") {
                self.finishOutboxCancellation(commandID)
                self.clearOutboxState(forCommandID: commandID)
                return
            }
            self.finishOutboxCancellation(commandID)
            self.outboxCommandIDsByMessageID.removeValue(forKey: messageID)
            self.outboxMessageIDsByCommandID.removeValue(forKey: commandID)
            self.outboxStatesByMessageID.removeValue(forKey: messageID)
            // `.missing` with no current row means another view already
            // canceled (or canonical history completed) this mapping. Never
            // leave its stale bubble looking like an ordinary sent message;
            // canonical history can re-add a genuinely delivered row.
            self.replaceMessages(self.messages.filter { $0.id != messageID })
        }
    }

    // MARK: - Capture

    /// Durable capture path used before text or attachment delivery: persist
    /// first, then render the queued bubble. A full queue refuses the enqueue
    /// and keeps the exact draft intact.
    @discardableResult
    func enqueueOutboxCommand(
        text: String,
        draftInput: String,
        draftRevision: UInt64,
        draftAttachments: [OpenClawPendingAttachment] = [],
        session: SessionSnapshot) async -> Bool
    {
        guard let outbox else { return false }
        let agentID = self.outboxAgentID(for: session)
        if self.outboxRequiresAgentID(for: session), agentID == nil {
            self.errorText = "Select an agent before queueing this message."
            return false
        }
        guard
            let deliverySessionKey = self.outboxDeliverySessionKey(for: session, agentID: agentID),
            let routingContract = self.outboxRoutingContract(for: session)
        else {
            self.errorText = "Reconnect to verify this message's delivery target before queueing."
            return false
        }
        // Capture the effective value only after model selection settles. Raw
        // preferences can outlive this process, when model metadata is absent.
        await self.waitForPendingSessionSettings(
            in: session.key,
            canonicalSessionKey: deliverySessionKey,
            agentID: agentID,
            sessionRoutingContract: routingContract)
        guard self.isCurrentSession(session) else { return false }
        let thinking = self.effectiveThinkingLevelForSend(
            self.preferredThinkingLevel,
            sessionKey: session.key,
            canonicalSessionKey: deliverySessionKey,
            agentID: agentID,
            sessionRoutingContract: routingContract)
        let command = OpenClawChatOutboxCommand(
            id: UUID().uuidString,
            sessionKey: session.key,
            deliverySessionKey: deliverySessionKey,
            routingContract: routingContract,
            agentID: agentID,
            text: text,
            attachments: draftAttachments.map {
                OpenClawChatOutboxAttachment(
                    type: $0.type,
                    mimeType: $0.mimeType,
                    fileName: $0.fileName,
                    data: $0.data,
                    durationSeconds: $0.durationSeconds)
            },
            thinking: thinking,
            createdAt: Date().timeIntervalSince1970,
            status: .queued,
            retryCount: 0,
            lastError: nil)
        await self.waitForBootstrapOutboxBranchCapture(for: session)
        let accepted = await outbox.enqueueCommand(command)
        guard accepted else {
            if self.isCurrentSession(session) {
                self.errorText = "Offline queue is full. Delete a queued message or reconnect to send."
            }
            return false
        }
        // Acceptance is durable even if the user switched sessions during the
        // await. The caller must still retire that session's draft/history.
        // Bubble render and flush scheduling stay with the displayed session
        // (shipped behavior predating this path); the stored command delivers
        // on the next flush trigger, e.g. returning here or a health event.
        guard self.isCurrentSession(session) else { return true }
        if self.input == draftInput, self.composerRevision(for: session.key) == draftRevision {
            self.input = ""
        }
        let capturedAttachmentIDs = Set(draftAttachments.map(\.id))
        self.attachments.removeAll { capturedAttachmentIDs.contains($0.id) }
        self.errorText = nil
        self.presentOutboxCommands([command])
        // Health can recover between the send-gate check and the enqueue;
        // flushing here closes that gap instead of waiting for the next event.
        if self.healthOK {
            self.flushOutboxIfNeeded()
        }
        return true
    }

    /// Durable path for a failed live text send. Known pre-dispatch route
    /// changes remain queued; ambiguous results fail closed until canonical
    /// history or explicit retry resolves them.
    /// Returns false when the queue refuses (caller keeps the failure path).
    func preserveFailedLiveSend(
        runId: String,
        text: String,
        thinking: String,
        messageID: UUID,
        session: SessionSnapshot,
        deliveryIsAmbiguous: Bool) async -> Bool
    {
        guard let outbox else { return false }
        let agentID = self.outboxAgentID(for: session)
        guard !self.outboxRequiresAgentID(for: session) || agentID != nil,
              let deliverySessionKey = self.outboxDeliverySessionKey(for: session, agentID: agentID),
              let routingContract = self.outboxRoutingContract(for: session)
        else { return false }
        let command = OpenClawChatOutboxCommand(
            id: runId,
            sessionKey: session.key,
            deliverySessionKey: deliverySessionKey,
            routingContract: routingContract,
            agentID: agentID,
            text: text,
            thinking: thinking,
            createdAt: Date().timeIntervalSince1970,
            status: deliveryIsAmbiguous ? .failed : .queued,
            retryCount: 0,
            lastError: deliveryIsAmbiguous
                ? OpenClawChatSQLiteTranscriptCache.outboxUnconfirmedError
                : nil)
        await self.waitForBootstrapOutboxBranchCapture(for: session)
        guard await outbox.enqueueCommand(command) else { return false }
        guard self.isCurrentSession(session) else { return true }
        self.mapOutboxCommand(command, to: messageID)
        self.errorText = nil
        // Ambiguous rows only reconcile history; known-unsent rows may flush
        // automatically once the replacement route becomes healthy.
        self.flushOutboxIfNeeded()
        return true
    }

    // MARK: - Restore

    /// Session switches drop the visible bubbles, so per-message outbox
    /// state must go with them, and the FIFO send gate must assume a backlog
    /// again until restore adopts the new session's durable rows. Without
    /// this reset a send issued right after a switch could go live ahead of
    /// that session's persisted queue.
    func resetOutboxPresentationForSessionSwitch() {
        self.hasRestoredOutboxMessages = false
        self.outboxCommandIDsByMessageID.removeAll()
        self.outboxMessageIDsByCommandID.removeAll()
        self.outboxStatesByMessageID.removeAll()
        self.outboxFailureVersionsByMessageID.removeAll()
    }

    /// Re-adopts or re-appends queued bubbles for the visible session after
    /// cold open, session switches, and wholesale history replacement.
    func restoreOutboxMessages(session: SessionSnapshot) {
        guard let outbox else { return }
        Task { [weak self] in
            guard let self else { return }
            guard await self.recoverInterruptedOutboxSendsIfNeeded() else { return }
            while self.isCurrentSession(session) {
                let presentationGeneration = self.outboxPresentationGeneration
                guard let commands = await outbox.loadCommandsIfAvailable() else { return }
                guard self.isCurrentSession(session) else { return }
                if presentationGeneration != self.outboxPresentationGeneration {
                    // A cross-view cancellation/confirmation invalidated this
                    // snapshot. Reload so unrelated surviving rows still paint.
                    continue
                }
                self.presentOutboxCommands(commands.filter { self.commandMatchesTarget($0, session: session) })
                // The FIFO send gate assumes a backlog until this point.
                self.hasRestoredOutboxMessages = true
                // Relaunching while already healthy never sees an unhealthy ->
                // healthy transition, so kick the flush here as well.
                if self.healthOK, commands.contains(where: { $0.status == .queued }) {
                    self.reconcilePendingOutboxBranchScopes()
                }
                return
            }
        }
    }

    /// Canonical history is the durable acceptance boundary. Any matching
    /// outbox row—including a delivery-unconfirmed row—is now safe to remove
    /// without replaying the user turn.
    func confirmOutboxCommands(in messages: [OpenClawChatMessage]) {
        self.observeCanonicalOutboxMessageKeys(in: messages)
        Task { [weak self] in
            await self?.confirmOutboxCommandsNow(in: messages)
        }
    }

    func confirmOutboxCommandsNow(in messages: [OpenClawChatMessage]) async {
        self.observeCanonicalOutboxMessageKeys(in: messages)
        guard let outbox else { return }
        let confirmedKeys = Set(messages.compactMap { Self.normalizedIdempotencyKey($0.idempotencyKey) })
        guard !confirmedKeys.isEmpty else { return }
        let commands = await outbox.loadCommands().filter { command in
            // Command UUIDs are gateway-global. Match the durable identity,
            // not a presentation alias (`main` vs `agent:<id>:main`).
            confirmedKeys.contains(Self.outboxUserIdempotencyKey(command.id))
        }
        for command in commands {
            if let canonicalMessage = messages.first(where: {
                Self.normalizedIdempotencyKey($0.idempotencyKey) ==
                    Self.outboxUserIdempotencyKey(command.id)
            }) {
                await self.persistCanonicalOutboxEvidence(canonicalMessage, for: command)
            }
            let result = await outbox.confirmCommand(id: command.id, attemptVersion: command.attemptVersion)
            if result == .updated || result == .confirmed {
                self.clearOutboxState(forCommandID: command.id)
            }
        }
    }

    private func persistCanonicalOutboxEvidence(
        _ message: OpenClawChatMessage,
        for command: OpenClawChatOutboxCommand) async
    {
        guard let transcriptCache = transcriptCache as? any OpenClawChatCanonicalTranscriptMerging else { return }
        let sessionKey = command.sessionKey
        let cacheAgentID = Self.transcriptCacheAgentID(
            sessionKey: sessionKey,
            agentID: command.agentID)
        let messageKey = Self.outboxUserIdempotencyKey(command.id)
        let canonicalMessage = Self.adoptingCanonicalMessage(
            message,
            over: Self.outboxUserMessage(for: command))
        let previous = self.pendingCacheWriteTask
        let task = Task.detached {
            await previous?.value
            await transcriptCache.mergeCanonicalTranscriptMessage(
                sessionKey: sessionKey,
                agentID: cacheAgentID,
                message: canonicalMessage,
                canonicalMessageIdempotencyKey: messageKey)
        }
        self.pendingCacheWriteTask = task
        await task.value
    }

    private func observeCanonicalOutboxMessageKeys(in messages: [OpenClawChatMessage]) {
        let keys = Set(messages.compactMap(\.idempotencyKey))
        for key in keys.sorted() {
            self.canonicalOutboxMessageKeys.removeAll(where: { $0 == key })
            self.canonicalOutboxMessageKeys.append(key)
        }
        if self.canonicalOutboxMessageKeys.count > 512 {
            self.canonicalOutboxMessageKeys.removeFirst(self.canonicalOutboxMessageKeys.count - 512)
        }
        self.transcriptCache?.observeCanonicalMessageIdempotencyKeys(keys)
    }

    /// Appends bubbles for commands in the current session, adopting rows
    /// that already carry the command's user idempotency key from an earlier
    /// restore, and refreshes their display states.
    private func presentOutboxCommands(_ commands: [OpenClawChatOutboxCommand]) {
        self.pruneOutboxMappings()
        guard !commands.isEmpty else { return }
        var next = self.messages
        for command in commands.sorted(by: { $0.createdAt < $1.createdAt }) {
            if self.cancelingOutboxCommandIDs.contains(command.id) { continue }
            let key = Self.outboxUserIdempotencyKey(command.id)
            if let existing = next.first(where: { $0.idempotencyKey == key }) {
                self.mapOutboxCommand(command, to: existing.id)
                continue
            }
            let message = Self.outboxUserMessage(for: command)
            next.append(message)
            self.mapOutboxCommand(command, to: message.id)
        }
        self.replaceMessages(next)
    }

    private static func outboxUserMessage(for command: OpenClawChatOutboxCommand) -> OpenClawChatMessage {
        var content = [
            OpenClawChatMessageContent(
                type: "text",
                text: command.text,
                mimeType: nil,
                fileName: nil,
                content: nil),
        ]
        content.append(contentsOf: command.attachments.map { attachment in
            OpenClawChatMessageContent(
                type: attachment.type,
                text: nil,
                mimeType: attachment.mimeType,
                fileName: attachment.fileName,
                durationSeconds: attachment.durationSeconds,
                content: AnyCodable(attachment.data.base64EncodedString()))
        })
        return OpenClawChatMessage(
            role: "user",
            content: content,
            // Message timestamps are milliseconds; outbox rows store seconds.
            timestamp: command.createdAt * 1000,
            idempotencyKey: self.outboxUserIdempotencyKey(command.id))
    }

    private func mapOutboxCommand(_ command: OpenClawChatOutboxCommand, to messageID: UUID) {
        self.outboxCommandIDsByMessageID[messageID] = command.id
        self.outboxMessageIDsByCommandID[command.id] = messageID
        self.outboxStatesByMessageID[messageID] = Self.outboxDisplayState(for: command)
        if command.status == .failed {
            self.outboxFailureVersionsByMessageID[messageID] = (
                command.attemptVersion, command.retryCount, command.lastError)
        } else {
            self.outboxFailureVersionsByMessageID.removeValue(forKey: messageID)
        }
    }

    private func pruneOutboxMappings() {
        let visibleMessageIDs = Set(self.messages.map(\.id))
        let staleMessageIDs = self.outboxCommandIDsByMessageID.keys.filter {
            !visibleMessageIDs.contains($0)
        }
        for messageID in staleMessageIDs {
            if let commandID = self.outboxCommandIDsByMessageID.removeValue(forKey: messageID) {
                self.outboxMessageIDsByCommandID.removeValue(forKey: commandID)
            }
            self.outboxStatesByMessageID.removeValue(forKey: messageID)
            self.outboxFailureVersionsByMessageID.removeValue(forKey: messageID)
        }
    }

    // MARK: - Health

    func pollHealthIfNeeded(
        force: Bool,
        sessionSnapshot: SessionSnapshot? = nil,
        refreshSessionsOnReconnect: Bool = true) async
    {
        if !force, let last = lastHealthPollAt, Date().timeIntervalSince(last) < 10 {
            return
        }
        self.lastHealthPollAt = Date()
        do {
            let ok = try await self.transport.requestHealth(timeoutMs: 5000)
            if let sessionSnapshot, !self.isCurrentSession(sessionSnapshot) { return }
            self.applyTransportHealth(ok, refreshSessionsOnReconnect: refreshSessionsOnReconnect)
        } catch {
            if let sessionSnapshot, !self.isCurrentSession(sessionSnapshot) { return }
            self.applyTransportHealth(false)
        }
    }

    /// Single choke point for health updates so the offline outbox flushes
    /// exactly on the unhealthy -> healthy transition.
    func applyTransportHealth(_ ok: Bool, refreshSessionsOnReconnect: Bool = true) {
        let wasHealthy = self.healthOK
        self.healthOK = ok
        if !ok, wasHealthy || self.hasCurrentSessionMetadata {
            self.invalidateSessionMetadataReadiness()
        }
        if ok, !wasHealthy {
            guard self.outbox != nil else { return }
            if self.hasCurrentSessionMetadata {
                self.reconcilePendingOutboxBranchScopes()
            } else if refreshSessionsOnReconnect {
                let session = self.currentSessionSnapshot()
                Task { await self.fetchSessions(limit: 50, sessionSnapshot: session) }
            }
        }
    }

    // MARK: - Flush

    func flushOutboxIfNeeded() {
        guard self.outbox != nil, self.healthOK else { return }
        // Health is intentionally established before sessions.list. Replays
        // need the current connection's model/runtime metadata first.
        guard self.hasCurrentSessionMetadata else { return }
        guard !self.isFlushingOutbox else {
            // Coalesce triggers that land mid-pass (tap-to-retry, enqueue
            // race) so their commands are not stranded until the next
            // health transition.
            self.isOutboxFlushRequestedWhileActive = true
            return
        }
        self.isFlushingOutbox = true
        Task { [weak self] in
            await self?.performOutboxFlush()
            guard let self else { return }
            self.isFlushingOutbox = false
            if self.isOutboxFlushRequestedWhileActive {
                self.isOutboxFlushRequestedWhileActive = false
                self.flushOutboxIfNeeded()
            }
        }
    }

    private func performOutboxFlush() async {
        guard let outbox else { return }
        let presentationGeneration = self.outboxPresentationGeneration
        guard let initialCommands = await outbox.loadCommandsIfAvailable() else {
            self.applyTransportHealth(false)
            return
        }
        guard presentationGeneration == self.outboxPresentationGeneration else {
            self.isOutboxFlushRequestedWhileActive = true
            return
        }
        let visibleSession = self.currentSessionSnapshot()
        self.presentOutboxCommands(initialCommands.filter { self.commandMatchesTarget($0, session: visibleSession) })
        if initialCommands.contains(where: {
            ($0.status == .queued || $0.status == .sending || $0.status == .awaitingConfirmation) &&
                !self.reconciledOutboxBranchScopes.contains(Self.outboxBranchScope(for: $0))
        }) {
            self.reconcilePendingOutboxBranchScopes()
            return
        }
        // Do not capability-gate ordinary live chat when no durable work
        // needs a replay lease (notably against older gateways).
        let hasRouteWork = initialCommands.contains { command in
            command.status == .queued ||
                command.status == .sending ||
                Self.needsOutboxDeliveryReconciliation(command)
        }
        guard hasRouteWork else { return }
        let routeResult = await self.transport.acquireOutboxRouteLease()
        guard case let .available(routeLease) = routeResult else {
            // The store owner no longer matches the active gateway route.
            // Leave every row queued; the replacement view model owns the
            // new gateway and a later matching reconnect can resume this one.
            if case let .unavailable(reason) = routeResult, let reason {
                self.errorText = reason
            }
            self.applyTransportHealth(false)
            return
        }
        guard await self.recoverInterruptedOutboxSendsIfNeeded() else {
            self.applyTransportHealth(false)
            return
        }
        var confirmationTargets: Set<OutboxDeliveryTarget> = []
        flushLoop: while self.healthOK {
            let presentationGeneration = self.outboxPresentationGeneration
            let commands = await outbox.loadCommands()
            if presentationGeneration != self.outboxPresentationGeneration {
                continue
            }
            confirmationTargets.formUnion(
                commands.lazy
                    .filter(Self.needsOutboxDeliveryReconciliation)
                    .map(Self.deliveryTarget))
            let visibleSession = self.currentSessionSnapshot()
            self.presentOutboxCommands(commands.filter { self.commandMatchesTarget($0, session: visibleSession) })
            guard let next = await outbox.claimNextCommand() else { break }
            let scope = Self.outboxBranchScope(for: next)
            guard self.reconciledOutboxBranchScopes.contains(scope) else {
                _ = await outbox.markCommandQueued(
                    id: next.id,
                    attemptVersion: next.attemptVersion,
                    retryCount: next.retryCount,
                    lastError: nil)
                break
            }
            guard next.branchEpoch == next.scopeBranchEpoch else {
                _ = await outbox.markCommandFailedIfPresent(
                    id: next.id,
                    attemptVersion: next.attemptVersion,
                    retryCount: next.retryCount,
                    lastError: "Session branch changed; review and retry this message.")
                continue
            }
            if self.transport.outboxRequiresSessionRoutingContract,
               next.routingContract != routeLease.sessionRoutingContract
            {
                guard await self.parkOutboxCommandForChangedTarget(next, outbox: outbox) else { break }
                continue
            }
            // Same ordering contract as the live send path: a run must not
            // start with stale model or thinking state while a settings patch
            // for its session is still in flight.
            await self.waitForPendingSessionSettings(
                in: next.sessionKey,
                canonicalSessionKey: next.deliverySessionKey,
                agentID: next.agentID,
                sessionRoutingContract: next.routingContract)
            self.setOutboxState(.sending, forCommandID: next.id)
            switch await self.deliverOutboxCommand(next, outbox: outbox, routeLease: routeLease) {
            case .continueFlush:
                continue
            case let .continueAndReconcile(target):
                confirmationTargets.insert(target)
                continue
            case .stop:
                break flushLoop
            case let .stopAndReconcile(target):
                confirmationTargets.insert(target)
                break flushLoop
            }
        }
        if !confirmationTargets.isEmpty {
            await self.refreshHistoriesAfterOutboxFlush(
                targets: confirmationTargets,
                routeLease: routeLease)
        }
    }

    private func deliverOutboxCommand(
        _ command: OpenClawChatOutboxCommand,
        outbox: any OpenClawChatCommandOutbox,
        routeLease: OpenClawChatTransportRouteLease) async -> OutboxFlushDisposition
    {
        do {
            let response = try await routeLease.sendMessage(
                sessionKey: command.deliverySessionKey,
                agentID: command.agentID,
                message: command.text,
                // Preserve the queued level when supported, but never send an
                // explicit unsupported level after the gate changes.
                thinking: self.effectiveThinkingLevelForSend(
                    command.thinking,
                    sessionKey: command.sessionKey,
                    canonicalSessionKey: command.deliverySessionKey,
                    agentID: command.agentID,
                    sessionRoutingContract: command.routingContract),
                idempotencyKey: command.id,
                attachments: command.attachments.map {
                    OpenClawChatAttachmentPayload(
                        type: $0.type,
                        mimeType: $0.mimeType,
                        fileName: $0.fileName,
                        content: $0.data.base64EncodedString())
                })
            if response.status == "error" || response.status == "timeout" {
                // Gateway rejection consumes a retry attempt, unlike a
                // transport failure that proved the request was not sent.
                return await self.outboxRejectionDisposition(
                    command,
                    outbox: outbox,
                    reason: "Run failed to start (\(response.status)).")
            }
            return await self.finishAcceptedOutboxCommand(command, outbox: outbox)
        } catch is OpenClawChatTransportSendError {
            // The transport proved this payload never reached its request
            // channel, so it is safe to retry automatically.
            await outbox.markCommandQueued(
                id: command.id,
                attemptVersion: command.attemptVersion,
                retryCount: command.retryCount,
                lastError: nil)
            self.setOutboxState(.queued, forCommandID: command.id)
            self.applyTransportHealth(false)
            return .stop
        } catch is CancellationError {
            // Cancellation while the request is suspended does not prove that
            // the gateway rejected it. Never replay automatically.
            return await self.stopAfterUnconfirmedDelivery(command, outbox: outbox)
        } catch let error as GatewayResponseError {
            if error.detailsReason == OpenClawChatSessionRoutingContract.changedErrorReason {
                let parked = await self.parkOutboxCommandForChangedTarget(command, outbox: outbox)
                return parked ? .continueFlush : .stop
            }
            // A response error proves the gateway rejected the request; unlike
            // a socket/timeout failure, replay cannot duplicate an accepted run.
            return await self.outboxRejectionDisposition(
                command,
                outbox: outbox,
                reason: error.localizedDescription)
        } catch {
            // A socket error or timeout is ambiguous: preserve the command for
            // canonical-history reconciliation or explicit user retry.
            outboxLogger.error("outbox flush send failed \(error.localizedDescription, privacy: .public)")
            return await self.stopAfterUnconfirmedDelivery(command, outbox: outbox)
        }
    }

    private func finishAcceptedOutboxCommand(
        _ command: OpenClawChatOutboxCommand,
        outbox: any OpenClawChatCommandOutbox) async -> OutboxFlushDisposition
    {
        // Deliberately no pendingRuns adoption for background flushes: the
        // reply still lands via handleChatEvent's external-run final branch,
        // handleSessionMessageEvent, and the post-drain history refresh. Run
        // tracking (typing indicator, streaming, timeouts) stays owned by
        // interactive performSend. chat.send ACK precedes durable user-turn
        // persistence. The durable outbox remains the sole owner of the
        // optimistic bubble until canonical history carries its key; writing
        // it into the cache would require cross-database cancellation logic.
        let update = await outbox.markCommandAwaitingConfirmation(
            id: command.id,
            attemptVersion: command.attemptVersion)
        guard update != .unavailable else {
            self.applyTransportHealth(false)
            return .stop
        }
        if update == .updated {
            self.setOutboxState(.confirming, forCommandID: command.id)
        } else {
            // A concurrent canonical history/session.message confirmation
            // already removed the row.
            self.clearOutboxState(forCommandID: command.id)
        }
        return .continueAndReconcile(Self.deliveryTarget(for: command))
    }

    private func outboxRejectionDisposition(
        _ command: OpenClawChatOutboxCommand,
        outbox: any OpenClawChatCommandOutbox,
        reason: String) async -> OutboxFlushDisposition
    {
        let canContinue = await self.recordOutboxRejection(
            of: command,
            outbox: outbox,
            reason: reason)
        return canContinue ? .continueFlush : .stop
    }

    private func stopAfterUnconfirmedDelivery(
        _ command: OpenClawChatOutboxCommand,
        outbox: any OpenClawChatCommandOutbox) async -> OutboxFlushDisposition
    {
        let update = await self.parkOutboxCommandWithUnconfirmedDelivery(command, outbox: outbox)
        self.applyTransportHealth(false)
        guard update == .updated else { return .stop }
        return .stopAndReconcile(Self.deliveryTarget(for: command))
    }

    private static func needsOutboxDeliveryReconciliation(_ command: OpenClawChatOutboxCommand) -> Bool {
        command.status == .awaitingConfirmation ||
            (command.status == .failed &&
                command.lastError == OpenClawChatSQLiteTranscriptCache.outboxUnconfirmedError)
    }

    private static func deliveryTarget(for command: OpenClawChatOutboxCommand) -> OutboxDeliveryTarget {
        OutboxDeliveryTarget(
            presentationSessionKey: command.sessionKey,
            deliverySessionKey: command.deliverySessionKey,
            agentID: command.agentID)
    }

    private func parkOutboxCommandWithUnconfirmedDelivery(
        _ command: OpenClawChatOutboxCommand,
        outbox: any OpenClawChatCommandOutbox) async -> OpenClawChatOutboxUpdateResult
    {
        let update = await outbox.markCommandFailedIfPresent(
            id: command.id,
            attemptVersion: command.attemptVersion,
            retryCount: command.retryCount,
            lastError: OpenClawChatSQLiteTranscriptCache.outboxUnconfirmedError)
        switch update {
        case .updated:
            self.setOutboxState(
                .failed(reason: OpenClawChatSQLiteTranscriptCache.outboxUnconfirmedError),
                forCommandID: command.id)
        case .missing, .confirmed:
            self.clearOutboxState(forCommandID: command.id)
        case .superseded:
            self.clearOutboxState(forCommandID: command.id)
        case .unavailable:
            self.applyTransportHealth(false)
        }
        return update
    }

    private func parkOutboxCommandForChangedTarget(
        _ command: OpenClawChatOutboxCommand,
        outbox: any OpenClawChatCommandOutbox) async -> Bool
    {
        let update = await outbox.markCommandFailedIfPresent(
            id: command.id,
            attemptVersion: command.attemptVersion,
            retryCount: command.retryCount,
            lastError: OpenClawChatSQLiteTranscriptCache.outboxChangedTargetError)
        guard update != .unavailable else {
            self.applyTransportHealth(false)
            return false
        }
        if update == .updated {
            let reason = "Gateway session routing changed; review and retry this message."
            self.setOutboxState(.failed(reason: reason), forCommandID: command.id)
        } else {
            self.clearOutboxState(forCommandID: command.id)
        }
        return true
    }

    /// Gateway rejections ("error"/"timeout" send acks) burn a retry attempt
    /// and become terminally 'failed' after `maxOutboxSendAttempts`. Returns
    /// true when the flush pass may continue with younger commands.
    private func recordOutboxRejection(
        of command: OpenClawChatOutboxCommand,
        outbox: any OpenClawChatCommandOutbox,
        reason: String) async -> Bool
    {
        outboxLogger.error("outbox flush send rejected \(reason, privacy: .public)")
        let attempts = command.retryCount + 1
        if attempts >= Self.maxOutboxSendAttempts {
            let update = await outbox.markCommandFailedIfPresent(
                id: command.id,
                attemptVersion: command.attemptVersion,
                retryCount: attempts,
                lastError: reason)
            guard update != .unavailable else {
                self.applyTransportHealth(false)
                return false
            }
            if update == .updated {
                self.setOutboxState(.failed(reason: reason), forCommandID: command.id)
            } else {
                // Canonical history may have removed the claimed row while
                // the rejection was in flight.
                self.clearOutboxState(forCommandID: command.id)
            }
            // Terminal failure needs user action; let younger commands
            // flush instead of blocking behind it forever.
            return true
        }
        _ = await outbox.markCommandQueued(
            id: command.id,
            attemptVersion: command.attemptVersion,
            retryCount: attempts,
            lastError: reason)
        self.setOutboxState(.queued, forCommandID: command.id)
        // Strict createdAt ordering: never skip ahead of a command that
        // still has retries left.
        self.scheduleOutboxRetry(afterAttempts: attempts)
        return false
    }

    private func scheduleOutboxRetry(afterAttempts attempts: Int) {
        let delays = self.outboxRetryDelaysMs
        guard !delays.isEmpty else {
            self.outboxRetryTask?.cancel()
            self.outboxRetryTask = Task { [weak self] in
                await Task.yield()
                self?.flushOutboxIfNeeded()
            }
            return
        }
        let delayMs = delays[min(max(attempts - 1, 0), delays.count - 1)]
        self.outboxRetryTask?.cancel()
        self.outboxRetryTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: delayMs * 1_000_000)
            guard !Task.isCancelled else { return }
            self?.flushOutboxIfNeeded()
        }
    }

    private func recoverInterruptedOutboxSendsIfNeeded() async -> Bool {
        guard let outbox else { return false }
        // The store owns the once-per-process gate so overlapping/replacement
        // view models cannot reset another active sender's claim.
        return await outbox.recoverInterruptedSends()
    }

    func outboxAgentID(for session: SessionSnapshot) -> String? {
        guard self.transport.outboxRequiresSessionRoutingContract else { return nil }
        if session.key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "unknown" {
            return nil
        }
        let normalized = session.deliveryAgentID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized?.isEmpty == false ? normalized : nil
    }

    private func outboxRequiresAgentID(for session: SessionSnapshot) -> Bool {
        guard self.transport.outboxRequiresSessionRoutingContract else { return false }
        return session.key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() != "unknown"
    }

    private func outboxRoutingContract(for session: SessionSnapshot) -> String? {
        if !self.transport.outboxRequiresSessionRoutingContract {
            return OpenClawChatOutboxCommand.legacyUnboundRoutingContract
        }
        let normalized = session.sessionRoutingContract?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return normalized?.isEmpty == false ? normalized : nil
    }

    /// Resolve once, before persistence. Re-resolving a presentation alias
    /// after reconnect could deliver to a newly selected/default agent.
    private func outboxDeliverySessionKey(
        for session: SessionSnapshot,
        agentID: String?) -> String?
    {
        let raw = session.key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else { return nil }
        guard self.transport.outboxRequiresSessionRoutingContract else { return raw }
        if raw.lowercased() == "unknown" { return raw }
        guard let agentID else { return nil }
        let normalized = raw.lowercased()
        if normalized == "global" { return "global" }
        if OpenClawChatSessionKey.agentID(from: raw) != nil { return raw }
        // A malformed ownership prefix must fail closed, not become a nested
        // key such as agent:<id>:agent::main.
        guard !normalized.hasPrefix("agent:") else { return nil }
        // The gateway owns structural normalization and preserves opaque
        // Matrix/Signal peer IDs. Keep the request key byte-for-byte here.
        return "agent:\(agentID):\(raw)"
    }

    private func commandMatchesTarget(
        _ command: OpenClawChatOutboxCommand,
        session: SessionSnapshot) -> Bool
    {
        guard command.sessionKey == session.key else { return false }
        // Failed rows never auto-send. Keep them reachable on their original
        // presentation alias after an owner change for explicit retry/delete.
        if command.status == .failed { return true }
        // Migrated v2 aliases have no owner and are parked as failed. Show
        // them so explicit retry can adopt the currently selected agent.
        guard let commandAgentID = command.agentID else { return true }
        guard let currentAgentID = self.outboxAgentID(for: session) else {
            // Cold offline launch has not recovered gateway ownership yet.
            // Keep the durable turn visible; the route lease verifies its
            // captured owner and contract before any later delivery.
            return true
        }
        return commandAgentID == currentAgentID
    }

    private func setOutboxState(_ state: OpenClawChatOutboxMessageState, forCommandID commandID: String) {
        guard let messageID = self.outboxMessageIDsByCommandID[commandID] else { return }
        self.outboxStatesByMessageID[messageID] = state
    }

    private func clearOutboxState(forCommandID commandID: String) {
        guard let messageID = self.outboxMessageIDsByCommandID.removeValue(forKey: commandID) else { return }
        self.outboxCommandIDsByMessageID.removeValue(forKey: messageID)
        self.outboxStatesByMessageID.removeValue(forKey: messageID)
        self.outboxFailureVersionsByMessageID.removeValue(forKey: messageID)
    }

    func handleOutboxChange(_ change: OpenClawChatOutboxChange) {
        // Invalidates every command snapshot that started loading before the
        // store mutation, including snapshots owned by another view model.
        self.outboxPresentationGeneration &+= 1
        switch change {
        case let .canceled(_, commandID):
            // The initiating view owns its async result so canonical proof
            // observed before that continuation can still preserve the row.
            // Other views have no local cancellation task and apply the event.
            guard !self.cancelingOutboxCommandIDs.contains(commandID) else { return }
            guard let messageID = self.outboxMessageIDsByCommandID[commandID] else { return }
            self.clearOutboxState(forCommandID: commandID)
            self.replaceMessages(self.messages.filter { $0.id != messageID })
        case let .confirmed(_, commandID):
            // Canonical history owns the message row; only its outbox badge
            // and command mapping disappear.
            self.clearOutboxState(forCommandID: commandID)
        case let .invalidated(_, scope):
            let session = self.currentSessionSnapshot()
            guard self.outboxBranchScope(for: session) == scope else { return }
            self.reconciledOutboxBranchScopes.remove(scope)
            self.restoreOutboxMessages(session: session)
        }
    }

    private func finishOutboxCancellation(_ commandID: String) {
        // Loads started while cancellation was in flight carry the previous
        // generation and cannot re-present their stale command snapshot.
        self.outboxPresentationGeneration &+= 1
        self.cancelingOutboxCommandIDs.remove(commandID)
    }

    private static func outboxDisplayState(for command: OpenClawChatOutboxCommand)
        -> OpenClawChatOutboxMessageState
    {
        switch command.status {
        case .queued:
            .queued
        case .sending:
            .sending
        case .awaitingConfirmation:
            .confirming
        case .failed:
            .failed(reason: command.lastError)
        }
    }

    /// Matches the optimistic-send convention (`"<runId>:user"`), which is
    /// also the key the gateway persists on the durable user row.
    static func outboxUserIdempotencyKey(_ commandID: String) -> String {
        "\(commandID):user"
    }
}
