import Foundation
import GRDB
import OpenClawKit
import Testing
@testable import OpenClawChatUI

extension OpenClawChatSQLiteTranscriptCache {
    fileprivate func markCommandAwaitingConfirmation(id: String) async -> OpenClawChatOutboxUpdateResult {
        guard let command = await self.loadCommands().first(where: { $0.id == id }) else { return .missing }
        return await self.markCommandAwaitingConfirmation(id: id, attemptVersion: command.attemptVersion)
    }

    fileprivate func markCommandFailedIfPresent(
        id: String,
        retryCount: Int,
        lastError: String?) async -> OpenClawChatOutboxUpdateResult
    {
        guard let command = await self.loadCommands().first(where: { $0.id == id }) else { return .missing }
        return await self.markCommandFailedIfPresent(
            id: id,
            attemptVersion: command.attemptVersion,
            retryCount: retryCount,
            lastError: lastError)
    }

    private func markCommandRetriedIfPresent(
        id: String,
        agentID: String?,
        deliverySessionKey: String,
        routingContract: String) async -> OpenClawChatOutboxUpdateResult
    {
        guard let command = await self.loadCommands().first(where: { $0.id == id }) else { return .missing }
        return await self.markCommandRetriedIfPresent(
            id: id,
            expectation: OpenClawChatOutboxRetryExpectation(
                attemptVersion: command.attemptVersion,
                retryCount: command.retryCount,
                lastError: command.lastError),
            agentID: agentID,
            deliverySessionKey: deliverySessionKey,
            routingContract: routingContract,
            replacementID: nil)
    }

    fileprivate func confirmCommand(id: String) async -> OpenClawChatOutboxUpdateResult {
        guard let command = await self.loadCommands().first(where: { $0.id == id }) else { return .missing }
        return await self.confirmCommand(id: id, attemptVersion: command.attemptVersion)
    }
}

private func makeOutboxDatabaseDirectory() throws -> URL {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("chat-outbox-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

private func makeOutboxStore(
    databaseDirectoryURL: URL,
    gatewayID: String) throws -> OpenClawChatSQLiteTranscriptCache
{
    try OpenClawClientDatabases(directoryURL: databaseDirectoryURL).store(gatewayID: gatewayID)
}

extension OpenClawChatSQLiteTranscriptCache {
    private func storeTestTranscript(
        sessionKey: String,
        agentID: String? = nil,
        messages: [OpenClawChatMessage]) async
    {
        await self.storeCanonicalTranscript(
            sessionKey: sessionKey,
            agentID: agentID,
            messages: messages,
            canonicalMessageIdempotencyKeys: Set(messages.compactMap(\.idempotencyKey)))
    }
}

private func outboxTestCommand(id: String, text: String, createdAt: Double) -> OpenClawChatOutboxCommand {
    OpenClawChatOutboxCommand(
        id: id,
        sessionKey: "main",
        routingContract: "per-sender|main|main",
        text: text,
        thinking: "off",
        createdAt: createdAt,
        status: .queued,
        retryCount: 0,
        lastError: nil)
}

private func userTexts(_ vm: OpenClawChatViewModel) async -> [String] {
    await MainActor.run {
        vm.messages
            .filter { $0.role == "user" }
            .map { $0.content.compactMap(\.text).joined() }
    }
}

private struct OutboxSendError: Error, LocalizedError {
    var errorDescription: String? {
        "transport unreachable"
    }
}

private actor OutboxTransportState {
    var sessionRoutingContract = "per-sender|main|main"
    var healthy: Bool
    var routeGeneration = 0
    var sendFails: Bool
    var sendFailsAfterRecording = false
    var sendRejects = false
    var sendResponseErrors = false
    var sendRoutingChanged = false
    var historyFails = false
    var sessionListFails = false
    var historyRequestCount = 0
    var heldSendGate: DeleteGate?
    var commandListGate: DeleteGate?
    let commandListStarted = DeleteGate()
    var sessionListGate: DeleteGate?
    let sessionListStarted = DeleteGate()
    var staleHistoryRows: [AnyCodable]?

    func setHeldSendGate(_ gate: DeleteGate?) {
        self.heldSendGate = gate
    }

    func setCommandListGate(_ gate: DeleteGate?) {
        self.commandListGate = gate
    }

    func waitUntilCommandListStarted() async {
        await self.commandListStarted.wait()
    }

    func awaitCommandListGate() async {
        await self.commandListStarted.open()
        if let commandListGate {
            await commandListGate.wait()
        }
    }

    func setSessionListGate(_ gate: DeleteGate?) {
        self.sessionListGate = gate
    }

    func awaitSessionListGate() async {
        await self.sessionListStarted.open()
        if let sessionListGate {
            await sessionListGate.wait()
        }
    }

    func setStaleHistoryRows(_ rows: [AnyCodable]?) {
        self.staleHistoryRows = rows
    }

    var sentIdempotencyKeys: [String] = []
    var sentMessages: [String] = []
    var sentSessionKeys: [String] = []
    var sentAgentIDs: [String?] = []
    var historyRequestAgentIDs: [String?] = []
    var sentThinkingLevels: [String] = []

    init(healthy: Bool, sendFails: Bool) {
        self.healthy = healthy
        self.sendFails = sendFails
    }

    func setHistoryFails(_ fails: Bool) {
        self.historyFails = fails
    }

    func setSessionListFails(_ fails: Bool) {
        self.sessionListFails = fails
    }

    func recordHistoryRequest(agentID: String?) {
        self.historyRequestCount += 1
        self.historyRequestAgentIDs.append(agentID)
    }

    func setHealthy(_ healthy: Bool) {
        self.healthy = healthy
    }

    func setSessionRoutingContract(_ contract: String) {
        self.sessionRoutingContract = contract
    }

    func replaceRoute() {
        self.routeGeneration += 1
    }

    func setSendFails(_ fails: Bool) {
        self.sendFails = fails
    }

    func setSendFailsAfterRecording(_ fails: Bool) {
        self.sendFailsAfterRecording = fails
    }

    func setSendRejects(_ rejects: Bool) {
        self.sendRejects = rejects
    }

    func setSendResponseErrors(_ rejects: Bool) {
        self.sendResponseErrors = rejects
    }

    func setSendRoutingChanged(_ changed: Bool) {
        self.sendRoutingChanged = changed
    }

    func recordSend(
        sessionKey: String,
        agentID: String?,
        message: String,
        idempotencyKey: String,
        thinking: String)
    {
        self.sentSessionKeys.append(sessionKey)
        self.sentAgentIDs.append(agentID)
        self.sentMessages.append(message)
        self.sentIdempotencyKeys.append(idempotencyKey)
        self.sentThinkingLevels.append(thinking)
    }
}

/// Scripted transport for offline-outbox flows: health is switchable, sends
/// can be forced to fail, and history synthesizes the durable user rows for
/// every accepted send (what the gateway would persist).
private final class OutboxTestTransport: @unchecked Sendable, OpenClawChatTransport {
    let state: OutboxTransportState
    private let sessions: [OpenClawChatSessionEntry]
    private let supportsSlashCommands: Bool
    private let requiresRoutingContract: Bool
    private let routeUnavailableReason: String?
    private let stream: AsyncStream<OpenClawChatTransportEvent>
    private let continuation: AsyncStream<OpenClawChatTransportEvent>.Continuation

    init(
        healthy: Bool,
        sendFails: Bool = false,
        sessions: [OpenClawChatSessionEntry] = [],
        supportsSlashCommands: Bool = false,
        requiresRoutingContract: Bool = true,
        routeUnavailableReason: String? = nil)
    {
        self.state = OutboxTransportState(healthy: healthy, sendFails: sendFails)
        self.sessions = sessions
        self.supportsSlashCommands = supportsSlashCommands
        self.requiresRoutingContract = requiresRoutingContract
        self.routeUnavailableReason = routeUnavailableReason
        var cont: AsyncStream<OpenClawChatTransportEvent>.Continuation!
        self.stream = AsyncStream { c in cont = c }
        self.continuation = cont
    }

    func goOnline() async {
        await self.state.setHealthy(true)
        self.continuation.yield(.health(ok: true))
    }

    func emit(_ event: OpenClawChatTransportEvent) {
        self.continuation.yield(event)
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        try await self.requestHistory(sessionKey: sessionKey, agentID: nil, expectedRoute: nil)
    }

    var supportsSlashCommandCatalog: Bool {
        self.supportsSlashCommands
    }

    var outboxRequiresSessionRoutingContract: Bool {
        self.requiresRoutingContract
    }

    func listCommands(sessionKey _: String) async throws -> [OpenClawChatCommandChoice] {
        await self.state.awaitCommandListGate()
        return []
    }

    private func requestHistory(
        sessionKey: String,
        agentID: String?,
        expectedRoute: Int?) async throws -> OpenClawChatHistoryPayload
    {
        await self.state.recordHistoryRequest(agentID: agentID)
        if let expectedRoute, await state.routeGeneration != expectedRoute {
            throw CancellationError()
        }
        guard await self.state.healthy, await !self.state.historyFails else { throw OutboxSendError() }
        if let stale = await state.staleHistoryRows {
            // Gateway lag: the snapshot predates the just-acked send.
            return OpenClawChatHistoryPayload(
                sessionKey: sessionKey,
                sessionId: "sess-live",
                messages: stale,
                thinkingLevel: "off")
        }
        let keys = await state.sentIdempotencyKeys
        let texts = await state.sentMessages
        let sessions = await state.sentSessionKeys
        let agents = await state.sentAgentIDs
        let durableUserRows = keys.indices.compactMap { index -> AnyCodable? in
            guard index < sessions.count,
                  index < agents.count,
                  sessions[index] == sessionKey,
                  agents[index] == agentID
            else { return nil }
            let key = keys[index]
            return AnyCodable([
                "role": "user",
                "content": [["type": "text", "text": index < texts.count ? texts[index] : ""]],
                "timestamp": Double(1000 + index),
                "__openclaw": ["idempotencyKey": "\(key):user"],
            ] as [String: Any])
        }
        return OpenClawChatHistoryPayload(
            sessionKey: sessionKey,
            sessionId: "sess-live",
            messages: durableUserRows,
            thinkingLevel: "off")
    }

    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        try await self.sendMessage(
            sessionKey: sessionKey,
            agentID: nil,
            message: message,
            thinking: thinking,
            idempotencyKey: idempotencyKey,
            expectedRoute: nil)
    }

    private func sendMessage(
        sessionKey: String,
        agentID: String?,
        message: String,
        thinking: String,
        idempotencyKey: String,
        expectedRoute: Int?) async throws -> OpenClawChatSendResponse
    {
        if let expectedRoute, await state.routeGeneration != expectedRoute {
            throw OpenClawChatTransportSendError.notDispatched
        }
        if let gate = await state.heldSendGate {
            // One-shot: only the first send is held so tests can pin the
            // window where the flush is mid-drain.
            await self.state.setHeldSendGate(nil)
            await gate.wait()
        }
        if let expectedRoute, await state.routeGeneration != expectedRoute {
            throw OpenClawChatTransportSendError.notDispatched
        }
        if await self.state.sendFails {
            throw OutboxSendError()
        }
        if await self.state.sendResponseErrors {
            throw GatewayResponseError(
                method: "chat.send",
                code: "INVALID_REQUEST",
                message: "rejected",
                details: nil)
        }
        if await self.state.sendRoutingChanged {
            throw GatewayResponseError(
                method: "chat.send",
                code: "INVALID_REQUEST",
                message: "session routing changed; review and retry",
                details: [
                    "reason": AnyCodable(OpenClawChatSessionRoutingContract.changedErrorReason),
                ])
        }
        if await self.state.sendRejects {
            // Gateway responded but refused to start the run.
            return OpenClawChatSendResponse(runId: idempotencyKey, status: "error")
        }
        await self.state.recordSend(
            sessionKey: sessionKey,
            agentID: agentID,
            message: message,
            idempotencyKey: idempotencyKey,
            thinking: thinking)
        if await self.state.sendFailsAfterRecording {
            throw OutboxSendError()
        }
        return OpenClawChatSendResponse(runId: idempotencyKey, status: "accepted")
    }

    func acquireOutboxRouteLease() async -> OpenClawChatTransportRouteLeaseResult {
        if let routeUnavailableReason {
            return .unavailable(reason: routeUnavailableReason)
        }
        if !self.requiresRoutingContract {
            let transport = self
            return .available(OpenClawChatTransportRouteLease(
                sendMessage: { sessionKey, message, thinking, idempotencyKey, attachments in
                    try await transport.sendMessage(
                        sessionKey: sessionKey,
                        message: message,
                        thinking: thinking,
                        idempotencyKey: idempotencyKey,
                        attachments: attachments)
                },
                requestHistory: { sessionKey in
                    try await transport.requestHistory(sessionKey: sessionKey)
                }))
        }
        let expectedRoute = await state.routeGeneration
        let routingContract = await state.sessionRoutingContract
        let transport = self
        return .available(OpenClawChatTransportRouteLease(
            sendTargetedMessage: { sessionKey, agentID, message, thinking, idempotencyKey, _ in
                try await transport.sendMessage(
                    sessionKey: sessionKey,
                    agentID: agentID,
                    message: message,
                    thinking: thinking,
                    idempotencyKey: idempotencyKey,
                    expectedRoute: expectedRoute)
            },
            requestTargetedHistory: { sessionKey, agentID in
                try await transport.requestHistory(
                    sessionKey: sessionKey,
                    agentID: agentID,
                    expectedRoute: expectedRoute)
            },
            sessionRoutingContract: routingContract))
    }

    /// Gated model patch: `setSessionModel` blocks until `releaseModelPatch`
    /// so tests can hold a patch in flight while the outbox flushes.
    private let modelPatchGate = AsyncStream<Void>.makeStream()
    private let modelPatchStarted = DeleteGate()

    func releaseModelPatch() {
        self.modelPatchGate.continuation.yield(())
    }

    func waitUntilModelPatchStarted() async {
        await self.modelPatchStarted.wait()
    }

    func setSessionModel(sessionKey _: String, model _: String?) async throws {
        await self.modelPatchStarted.open()
        var iterator = self.modelPatchGate.stream.makeAsyncIterator()
        _ = await iterator.next()
    }

    func listSessions(
        limit _: Int?,
        search _: String?,
        archived _: Bool) async throws -> OpenClawChatSessionsListResponse
    {
        await self.state.awaitSessionListGate()
        guard await !self.state.sessionListFails else { throw OutboxSendError() }
        return OpenClawChatSessionsListResponse(
            ts: nil,
            path: nil,
            count: self.sessions.count,
            defaults: nil,
            sessions: self.sessions)
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        await self.state.healthy
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        self.stream
    }
}

private func outboxSessionEntry(
    key: String,
    thinkingLevels: [String]) -> OpenClawChatSessionEntry
{
    OpenClawChatSessionEntry(
        key: key,
        kind: nil,
        displayName: nil,
        surface: nil,
        subject: nil,
        room: nil,
        space: nil,
        updatedAt: nil,
        sessionId: nil,
        systemSent: nil,
        abortedLastRun: nil,
        thinkingLevel: nil,
        verboseLevel: nil,
        inputTokens: nil,
        outputTokens: nil,
        totalTokens: nil,
        modelProvider: nil,
        model: nil,
        contextTokens: nil,
        thinkingLevels: thinkingLevels.map { OpenClawChatThinkingLevelOption(id: $0, label: $0) })
}

private func makeOutboxViewModel(
    transport: OutboxTestTransport,
    outbox: any OpenClawChatCommandOutbox,
    transcriptCache: (any OpenClawChatTranscriptCache)? = nil,
    retryDelaysMs: [UInt64] = [1, 1],
    sessionKey: String = "main",
    activeAgentID: String? = "main",
    sessionRoutingContract: String? = "per-sender|main|main") async -> OpenClawChatViewModel
{
    await MainActor.run {
        let vm = OpenClawChatViewModel(
            sessionKey: sessionKey,
            transport: transport,
            activeAgentId: activeAgentID,
            sessionRoutingContract: sessionRoutingContract,
            transcriptCache: transcriptCache,
            outbox: outbox)
        vm.outboxRetryDelaysMs = retryDelaysMs
        return vm
    }
}

private func sendWhileOffline(_ vm: OpenClawChatViewModel, text: String) async throws {
    await MainActor.run {
        vm.input = text
        vm.send()
    }
    try await waitUntil("queued bubble for \(text)") {
        await MainActor.run {
            vm.messages.contains { message in
                message.role == "user" && message.content.contains { $0.text == text }
            }
        }
    }
}

@MainActor
private func queuedStateCount(_ vm: OpenClawChatViewModel) -> Int {
    vm.outboxStatesByMessageID.count
}

/// Forwarding outbox that can delay `loadCommands`, making restore-vs-send
/// interleavings deterministic in tests.
private actor DelayingOutbox: OpenClawChatCommandOutbox {
    private nonisolated let base: OpenClawChatSQLiteTranscriptCache
    private var loadDelayNanoseconds: UInt64 = 0
    private var enqueueRelease: DeleteGate?
    private var recoveryAvailable = true
    private var terminalWritesAvailable = true
    private let enqueueStarted = DeleteGate()
    private let recoveryAttempted = DeleteGate()

    init(base: OpenClawChatSQLiteTranscriptCache) {
        self.base = base
    }

    nonisolated func changes() -> AsyncStream<OpenClawChatOutboxChange> {
        self.base.changes()
    }

    func setLoadDelayNanoseconds(_ delay: UInt64) {
        self.loadDelayNanoseconds = delay
    }

    func setRecoveryAvailable(_ available: Bool) {
        self.recoveryAvailable = available
    }

    func setTerminalWritesAvailable(_ available: Bool) {
        self.terminalWritesAvailable = available
    }

    func waitUntilRecoveryAttempted() async {
        await self.recoveryAttempted.wait()
    }

    func holdEnqueue() {
        self.enqueueRelease = DeleteGate()
    }

    func waitUntilEnqueueStarted() async {
        await self.enqueueStarted.wait()
    }

    func releaseEnqueue() async {
        await self.enqueueRelease?.open()
        self.enqueueRelease = nil
    }

    func enqueueCommand(_ command: OpenClawChatOutboxCommand) async -> Bool {
        if let enqueueRelease {
            await self.enqueueStarted.open()
            await enqueueRelease.wait()
        }
        return await self.base.enqueueCommand(command)
    }

    func loadCommands() async -> [OpenClawChatOutboxCommand] {
        if self.loadDelayNanoseconds > 0 {
            try? await Task.sleep(nanoseconds: self.loadDelayNanoseconds)
        }
        return await self.base.loadCommands()
    }

    func loadCommandsIfAvailable() async -> [OpenClawChatOutboxCommand]? {
        if self.loadDelayNanoseconds > 0 {
            try? await Task.sleep(nanoseconds: self.loadDelayNanoseconds)
        }
        return await self.base.loadCommandsIfAvailable()
    }

    @discardableResult
    func recoverInterruptedSends() async -> Bool {
        await self.recoveryAttempted.open()
        guard self.recoveryAvailable else { return false }
        return await self.base.recoverInterruptedSends()
    }

    func claimNextCommand() async -> OpenClawChatOutboxCommand? {
        await self.base.claimNextCommand()
    }

    func markCommandQueued(
        id: String,
        attemptVersion: Int,
        retryCount: Int,
        lastError: String?) async -> OpenClawChatOutboxUpdateResult
    {
        await self.base.markCommandQueued(
            id: id,
            attemptVersion: attemptVersion,
            retryCount: retryCount,
            lastError: lastError)
    }

    func markCommandAwaitingConfirmation(id: String, attemptVersion: Int) async -> OpenClawChatOutboxUpdateResult {
        await self.base.markCommandAwaitingConfirmation(id: id, attemptVersion: attemptVersion)
    }

    func markCommandFailedIfPresent(
        id: String, attemptVersion: Int,
        retryCount: Int,
        lastError: String?) async -> OpenClawChatOutboxUpdateResult
    {
        guard self.terminalWritesAvailable else { return .unavailable }
        return await self.base.markCommandFailedIfPresent(
            id: id,
            attemptVersion: attemptVersion,
            retryCount: retryCount,
            lastError: lastError)
    }

    func cancelCommand(id: String) async -> OpenClawChatOutboxUpdateResult {
        await self.base.cancelCommand(id: id)
    }

    func confirmCommand(id: String, attemptVersion: Int) async -> OpenClawChatOutboxUpdateResult {
        await self.base.confirmCommand(id: id, attemptVersion: attemptVersion)
    }

    func branchState(for scope: OpenClawChatOutboxScope) async -> OpenClawChatOutboxBranchState? {
        await self.base.branchState(for: scope)
    }

    func beginBranchSwitch(_ scope: OpenClawChatOutboxScope) async -> Bool {
        await self.base.beginBranchSwitch(scope)
    }

    func cancelBranchSwitch(_ scope: OpenClawChatOutboxScope) async -> Bool {
        await self.base.cancelBranchSwitch(scope)
    }

    func reconcileBranchScope(
        _ scope: OpenClawChatOutboxScope,
        previousState: OpenClawChatOutboxBranchState,
        activeLeafEntryID: String?,
        branchLeafEntryIDs: Set<String>,
        activeTranscriptEntryIDs: Set<String>,
        lastError: String) async -> [OpenClawChatOutboxCommand]?
    {
        await self.base.reconcileBranchScope(
            scope, previousState: previousState, activeLeafEntryID: activeLeafEntryID,
            branchLeafEntryIDs: branchLeafEntryIDs,
            activeTranscriptEntryIDs: activeTranscriptEntryIDs,
            lastError: lastError)
    }

    func confirmBranchChange(
        _ scope: OpenClawChatOutboxScope,
        activeLeafEntryID: String,
        lastError: String) async -> [OpenClawChatOutboxCommand]?
    {
        await self.base.confirmBranchChange(scope, activeLeafEntryID: activeLeafEntryID, lastError: lastError)
    }

    func updateLastActiveLeafEntryID(
        _ leafEntryID: String,
        expectedEpoch: Int,
        for scope: OpenClawChatOutboxScope) async -> Bool
    {
        await self.base.updateLastActiveLeafEntryID(leafEntryID, expectedEpoch: expectedEpoch, for: scope)
    }
}

/// Returns one already-read command snapshot only after the test releases it,
/// reproducing a restore that resumes after another view canceled the row.
private actor SnapshotHoldingOutbox: OpenClawChatCommandOutbox {
    private nonisolated let base: OpenClawChatSQLiteTranscriptCache
    private var captured = DeleteGate()
    private var release = DeleteGate()
    private var shouldHoldNextLoad = false

    init(base: OpenClawChatSQLiteTranscriptCache) {
        self.base = base
    }

    func waitUntilSnapshotCaptured() async {
        await self.captured.wait()
    }

    func holdNextLoad() {
        self.captured = DeleteGate()
        self.release = DeleteGate()
        self.shouldHoldNextLoad = true
    }

    func releaseSnapshot() async {
        await self.release.open()
    }

    nonisolated func changes() -> AsyncStream<OpenClawChatOutboxChange> {
        self.base.changes()
    }

    func enqueueCommand(_ command: OpenClawChatOutboxCommand) async -> Bool {
        await self.base.enqueueCommand(command)
    }

    func loadCommands() async -> [OpenClawChatOutboxCommand] {
        let commands = await base.loadCommands()
        if self.shouldHoldNextLoad {
            self.shouldHoldNextLoad = false
            await self.captured.open()
            await self.release.wait()
        }
        return commands
    }

    func loadCommandsIfAvailable() async -> [OpenClawChatOutboxCommand]? {
        guard let commands = await base.loadCommandsIfAvailable() else { return nil }
        if self.shouldHoldNextLoad {
            self.shouldHoldNextLoad = false
            await self.captured.open()
            await self.release.wait()
        }
        return commands
    }

    @discardableResult
    func recoverInterruptedSends() async -> Bool {
        await self.base.recoverInterruptedSends()
    }

    func claimNextCommand() async -> OpenClawChatOutboxCommand? {
        await self.base.claimNextCommand()
    }

    func markCommandQueued(
        id: String,
        attemptVersion: Int,
        retryCount: Int,
        lastError: String?) async -> OpenClawChatOutboxUpdateResult
    {
        await self.base.markCommandQueued(
            id: id,
            attemptVersion: attemptVersion,
            retryCount: retryCount,
            lastError: lastError)
    }

    func markCommandAwaitingConfirmation(id: String, attemptVersion: Int) async -> OpenClawChatOutboxUpdateResult {
        await self.base.markCommandAwaitingConfirmation(id: id, attemptVersion: attemptVersion)
    }

    func markCommandFailedIfPresent(
        id: String, attemptVersion: Int,
        retryCount: Int,
        lastError: String?) async -> OpenClawChatOutboxUpdateResult
    {
        await self.base.markCommandFailedIfPresent(
            id: id,
            attemptVersion: attemptVersion,
            retryCount: retryCount,
            lastError: lastError)
    }

    func cancelCommand(id: String) async -> OpenClawChatOutboxUpdateResult {
        await self.base.cancelCommand(id: id)
    }

    func confirmCommand(id: String, attemptVersion: Int) async -> OpenClawChatOutboxUpdateResult {
        await self.base.confirmCommand(id: id, attemptVersion: attemptVersion)
    }
}

/// Holds a completed durable cancellation before its result returns to the
/// MainActor, making late canonical-proof ordering deterministic.
private actor CancellationHoldingOutbox: OpenClawChatCommandOutbox {
    private nonisolated let base: OpenClawChatSQLiteTranscriptCache
    private let canceled = DeleteGate()
    private let release = DeleteGate()

    init(base: OpenClawChatSQLiteTranscriptCache) {
        self.base = base
    }

    func waitUntilCanceled() async {
        await self.canceled.wait()
    }

    func releaseCancellation() async {
        await self.release.open()
    }

    nonisolated func changes() -> AsyncStream<OpenClawChatOutboxChange> {
        self.base.changes()
    }

    func enqueueCommand(_ command: OpenClawChatOutboxCommand) async -> Bool {
        await self.base.enqueueCommand(command)
    }

    func loadCommands() async -> [OpenClawChatOutboxCommand] {
        await self.base.loadCommands()
    }

    func loadCommandsIfAvailable() async -> [OpenClawChatOutboxCommand]? {
        await self.base.loadCommandsIfAvailable()
    }

    @discardableResult
    func recoverInterruptedSends() async -> Bool {
        await self.base.recoverInterruptedSends()
    }

    func claimNextCommand() async -> OpenClawChatOutboxCommand? {
        await self.base.claimNextCommand()
    }

    func markCommandQueued(
        id: String,
        attemptVersion: Int,
        retryCount: Int,
        lastError: String?) async -> OpenClawChatOutboxUpdateResult
    {
        await self.base.markCommandQueued(
            id: id,
            attemptVersion: attemptVersion,
            retryCount: retryCount,
            lastError: lastError)
    }

    func markCommandAwaitingConfirmation(id: String, attemptVersion: Int) async -> OpenClawChatOutboxUpdateResult {
        await self.base.markCommandAwaitingConfirmation(id: id, attemptVersion: attemptVersion)
    }

    func markCommandFailedIfPresent(
        id: String, attemptVersion: Int,
        retryCount: Int,
        lastError: String?) async -> OpenClawChatOutboxUpdateResult
    {
        await self.base.markCommandFailedIfPresent(
            id: id,
            attemptVersion: attemptVersion,
            retryCount: retryCount,
            lastError: lastError)
    }

    func cancelCommand(id: String) async -> OpenClawChatOutboxUpdateResult {
        let result = await base.cancelCommand(id: id)
        await self.canceled.open()
        await self.release.wait()
        return result
    }

    func confirmCommand(id: String, attemptVersion: Int) async -> OpenClawChatOutboxUpdateResult {
        await self.base.confirmCommand(id: id, attemptVersion: attemptVersion)
    }
}

struct ChatViewModelOutboxTests {
    @Test func `offline send queues durably and renders queued row`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)
        #expect(await MainActor.run { vm.supportsOfflineTextOutbox })

        await MainActor.run { vm.load() }
        try await sendWhileOffline(vm, text: "hello offline")

        // Nothing hit the transport; the command is durable instead.
        #expect(await transport.state.sentIdempotencyKeys.isEmpty)
        let commands = await store.loadCommands()
        #expect(commands.map(\.text) == ["hello offline"])
        #expect(commands.map(\.status) == [.queued])
        #expect(commands.map(\.sessionKey) == ["main"])
        #expect(commands.map(\.deliverySessionKey) == ["agent:main:main"])

        // The visible row carries the queued state and the draft was cleared.
        #expect(await MainActor.run { vm.input.isEmpty })
        let queuedStates = await MainActor.run {
            vm.messages.compactMap { vm.outboxState(for: $0.id) }
        }
        #expect(queuedStates == [.queued])

        // Recreating the view model (fresh cold open, still offline)
        // restores the queued bubble from the durable store.
        let vm2 = await makeOutboxViewModel(transport: transport, outbox: store)
        await MainActor.run { vm2.load() }
        try await waitUntil("queued bubble restored after recreation") {
            await MainActor.run {
                vm2.messages.contains { vm2.outboxState(for: $0.id) == .queued }
            }
        }
        #expect(await userTexts(vm2) == ["hello offline"])

        // A cold launch can restore before the gateway provides its default
        // agent. The captured owner still keeps the bubble visible; replay
        // remains blocked on the route lease's owner/contract verification.
        let ownerlessColdOpen = await makeOutboxViewModel(
            transport: transport,
            outbox: store,
            activeAgentID: nil,
            sessionRoutingContract: nil)
        await MainActor.run { ownerlessColdOpen.load() }
        try await waitUntil("ownerless cold open restores queued bubble") {
            await MainActor.run {
                ownerlessColdOpen.messages.contains {
                    ownerlessColdOpen.outboxState(for: $0.id) == .queued
                }
            }
        }
        #expect(await userTexts(ownerlessColdOpen) == ["hello offline"])
    }

    @Test func `unsupported gateway keeps queued work and surfaces upgrade action`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let message = OpenClawChatTransportUpgradeMessage.routingContract
        let transport = OutboxTestTransport(
            healthy: false,
            routeUnavailableReason: message)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run { vm.load() }
        try await sendWhileOffline(vm, text: "wait for upgrade")
        await transport.goOnline()

        try await waitUntil("gateway upgrade guidance") {
            await MainActor.run { vm.errorText == message }
        }
        #expect(await store.loadCommands().map(\.status) == [.queued])
        #expect(await transport.state.sentMessages.isEmpty)
    }

    @Test func `offline queue persists the effective thinking level`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let sessions = [outboxSessionEntry(key: "main", thinkingLevels: ["off"])]
        let transport = OutboxTestTransport(healthy: false, sessions: sessions)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run { vm.load() }
        await MainActor.run {
            vm.sessions = sessions
            vm.preferredThinkingLevel = "ultra"
            vm.syncThinkingLevelOptions()
        }
        #expect(await MainActor.run { !vm.showsThinkingPicker })

        try await sendWhileOffline(vm, text: "persist the send-safe level")
        #expect(await store.loadCommands().map(\.thinking) == ["off"])
    }

    @Test func `inert outbox does not capability gate healthy live chat`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let transport = OutboxTestTransport(
            healthy: true,
            routeUnavailableReason: OpenClawChatTransportUpgradeMessage.routingContract)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run { vm.load() }
        try await waitUntil("empty outbox restore completes") {
            await MainActor.run { vm.hasRestoredOutboxMessages }
        }
        try await Task.sleep(for: .milliseconds(50))
        #expect(await MainActor.run { vm.healthOK })
        #expect(await MainActor.run { vm.errorText == nil })

        var parked = outboxTestCommand(id: "c-parked", text: "review me", createdAt: 1)
        parked.status = .failed
        parked.lastError = OpenClawChatSQLiteTranscriptCache.outboxChangedTargetError
        #expect(await store.enqueueCommand(parked))
        let parkedVM = await makeOutboxViewModel(transport: transport, outbox: store)
        await MainActor.run { parkedVM.load() }
        try await waitUntil("parked outbox restore completes") {
            await MainActor.run { parkedVM.hasRestoredOutboxMessages }
        }
        try await Task.sleep(for: .milliseconds(50))
        #expect(await MainActor.run { parkedVM.healthOK })
        #expect(await MainActor.run { parkedVM.errorText == nil })
    }

    @Test func `legacy transport preserves its untargeted session key`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let transport = OutboxTestTransport(healthy: false, requiresRoutingContract: false)
        let vm = await makeOutboxViewModel(
            transport: transport,
            outbox: store,
            sessionKey: "OpaquePeer",
            activeAgentID: nil,
            sessionRoutingContract: nil)

        await MainActor.run { vm.load() }
        try await sendWhileOffline(vm, text: "legacy route")
        let command = try #require(await store.claimNextCommand())
        #expect(command.deliverySessionKey == "OpaquePeer")
        #expect(command.agentID == nil)
        #expect(await store.markCommandFailedIfPresent(
            id: command.id,
            retryCount: 1,
            lastError: "legacy failure") == .updated)

        let retryView = await makeOutboxViewModel(
            transport: transport,
            outbox: store,
            sessionKey: "OpaquePeer",
            activeAgentID: nil,
            sessionRoutingContract: nil)
        await MainActor.run { retryView.load() }
        try await waitUntil("legacy failed bubble") {
            await MainActor.run {
                retryView.messages.contains { message in
                    retryView.outboxState(for: message.id)?.isFailed == true
                }
            }
        }
        let failedMessageID = try #require(await MainActor.run { retryView.messages.last?.id })
        await MainActor.run { retryView.retryOutboxMessage(failedMessageID) }
        try await waitUntil("legacy retry queues") {
            await store.loadCommands().first?.status == .queued
        }

        await transport.goOnline()
        try await waitUntil("legacy outbox send") {
            await transport.state.sentMessages == ["legacy route"]
        }
        #expect(await transport.state.sentSessionKeys == ["OpaquePeer"])
        #expect(await transport.state.sentAgentIDs == [nil])
    }

    @Test func `reserved unknown session stays unscoped in durable delivery`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(
            transport: transport,
            outbox: store,
            sessionKey: "unknown")

        await MainActor.run { vm.load() }
        try await sendWhileOffline(vm, text: "reserved route")
        let command = try #require(await store.loadCommands().first)

        #expect(command.deliverySessionKey == "unknown")
        #expect(command.agentID == nil)

        await transport.goOnline()
        try await waitUntil("reserved outbox send") {
            await transport.state.sentMessages == ["reserved route"]
        }
        #expect(await transport.state.sentSessionKeys == ["unknown"])
        #expect(await transport.state.sentAgentIDs == [nil])
    }

    @Test(arguments: ["global", "main"])
    func `mutable alias queued turn keeps its original agent target`(_ sessionKey: String) async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let offlineTransport = OutboxTestTransport(healthy: false)
        let agentAView = await makeOutboxViewModel(
            transport: offlineTransport,
            outbox: store,
            transcriptCache: store,
            sessionKey: sessionKey,
            activeAgentID: "agent-a")
        await MainActor.run { agentAView.load() }
        try await sendWhileOffline(agentAView, text: "for agent A")
        #expect(await store.loadCommands().map(\.agentID) == ["agent-a"])

        let reconnectTransport = OutboxTestTransport(healthy: false)
        let agentBView = await makeOutboxViewModel(
            transport: reconnectTransport,
            outbox: store,
            transcriptCache: store,
            sessionKey: sessionKey,
            activeAgentID: "agent-b")
        await MainActor.run { agentBView.load() }
        try await waitUntil("agent B restore completes without adopting agent A bubble") {
            await MainActor.run { agentBView.hasRestoredOutboxMessages }
        }
        #expect(await userTexts(agentBView).isEmpty)

        await reconnectTransport.goOnline()
        try await waitUntil("agent A command drains after agent B reconnects") {
            await store.loadCommands().isEmpty
        }
        let deliverySessionKey = sessionKey == "global" ? "global" : "agent:agent-a:main"
        #expect(await reconnectTransport.state.sentSessionKeys == [deliverySessionKey])
        #expect(await reconnectTransport.state.sentAgentIDs == ["agent-a"])
        #expect(await reconnectTransport.state.historyRequestAgentIDs.contains("agent-a"))
        #expect(await store.loadTranscript(sessionKey: sessionKey, agentID: "agent-a")
            .map { $0.content.compactMap(\.text).joined() } == ["for agent A"])
        #expect(await store.loadTranscript(sessionKey: sessionKey, agentID: "agent-b").isEmpty)
    }

    @Test func `reconnect waits for canonical session metadata before flushing Ultra`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        #expect(await store.updateLastActiveLeafEntryID(
            "leaf-new",
            expectedEpoch: 0,
            for: OpenClawChatOutboxScope(sessionKey: "main", agentID: "main")))
        #expect(await store.updateLastActiveLeafEntryID(
            "leaf-new",
            expectedEpoch: 0,
            for: OpenClawChatOutboxScope(sessionKey: "main", agentID: nil)))
        #expect(await store.enqueueCommand(OpenClawChatOutboxCommand(
            id: "alpha-ultra",
            sessionKey: "main",
            deliverySessionKey: "agent:alpha:main",
            routingContract: "per-sender|main|main",
            agentID: "alpha",
            text: "use canonical Luna metadata",
            thinking: "ultra",
            createdAt: Date().timeIntervalSince1970,
            status: .queued,
            retryCount: 0,
            lastError: nil)))
        let listGate = DeleteGate()
        let sessions = [
            outboxSessionEntry(key: "agent:alpha:main", thinkingLevels: ["off", "max"]),
            outboxSessionEntry(key: "agent:beta:main", thinkingLevels: ["off", "ultra"]),
        ]
        let transport = OutboxTestTransport(healthy: false, sessions: sessions)
        await transport.state.setSessionListGate(listGate)
        let vm = await makeOutboxViewModel(
            transport: transport,
            outbox: store,
            sessionKey: "main",
            activeAgentID: "beta")

        await MainActor.run { vm.load() }
        await transport.goOnline()
        await transport.state.sessionListStarted.wait()
        try await Task.sleep(for: .milliseconds(50))
        #expect(await transport.state.sentMessages.isEmpty)
        #expect(await store.loadCommands().map(\.status) == [.queued])

        await listGate.open()
        try await waitUntil("canonical Alpha command flushes after list metadata") {
            await store.loadCommands().isEmpty
        }
        #expect(await transport.state.sentSessionKeys == ["agent:alpha:main"])
        #expect(await transport.state.sentAgentIDs == ["alpha"])
        #expect(await transport.state.sentThinkingLevels == ["max"])
    }

    @Test func `reconnect retries metadata after a transient session list failure`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        #expect(await store.enqueueCommand(outboxTestCommand(
            id: "retry-metadata",
            text: "send after retry",
            createdAt: Date().timeIntervalSince1970)))
        let transport = OutboxTestTransport(healthy: false)
        await transport.state.setSessionListFails(true)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run { vm.load() }
        await transport.goOnline()
        await transport.state.sessionListStarted.wait()
        try await waitUntil("failed metadata fetch returns to unhealthy") {
            await MainActor.run { !vm.healthOK }
        }
        #expect(await store.loadCommands().map(\.status) == [.queued])

        await transport.state.setSessionListFails(false)
        await transport.goOnline()
        try await waitUntil("next healthy transition retries metadata and drains") {
            await store.loadCommands().isEmpty
        }
        #expect(await transport.state.sentMessages == ["send after retry"])
    }

    @Test func `unscoped opaque peer ID preserves case in its durable target`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let sessionKey = "Matrix:Channel:!MixedRoomAbCdEf:example.org"
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(
            transport: transport,
            outbox: store,
            sessionKey: sessionKey,
            activeAgentID: "agent-a")
        await MainActor.run { vm.load() }
        try await sendWhileOffline(vm, text: "preserve opaque room")

        let command = try #require(await store.loadCommands().first)
        #expect(command.deliverySessionKey == "agent:agent-a:\(sessionKey)")

        await transport.goOnline()
        try await waitUntil("mixed-case target drains") {
            await store.loadCommands().isEmpty
        }
        #expect(await transport.state.sentSessionKeys == ["agent:agent-a:\(sessionKey)"])
    }

    @Test func `changed default agent parks command visibly for retry`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let oldTransport = OutboxTestTransport(healthy: false)
        await oldTransport.state.setSessionRoutingContract("per-sender|main|agent-a")
        let oldView = await makeOutboxViewModel(
            transport: oldTransport,
            outbox: store,
            activeAgentID: "agent-a",
            sessionRoutingContract: "per-sender|main|agent-a")
        await MainActor.run { oldView.load() }
        try await sendWhileOffline(oldView, text: "old main target")

        let newTransport = OutboxTestTransport(healthy: false)
        await newTransport.state.setSessionRoutingContract("per-sender|main|agent-b")
        let newView = await makeOutboxViewModel(
            transport: newTransport,
            outbox: store,
            activeAgentID: "agent-b",
            sessionRoutingContract: "per-sender|main|agent-b")
        await MainActor.run { newView.load() }

        await newTransport.goOnline()
        try await waitUntil("changed target is parked") {
            await store.loadCommands().map(\.status) == [.failed]
        }
        #expect(await store.loadCommands().first?.lastError ==
            OpenClawChatSQLiteTranscriptCache.outboxChangedTargetError)
        #expect(await newTransport.state.sentMessages.isEmpty)
        try await waitUntil("parked target stays visible") {
            await MainActor.run {
                newView.messages.contains { newView.outboxState(for: $0.id)?.isFailed == true }
            }
        }

        let messageID = try #require(await MainActor.run {
            newView.messages.first { newView.outboxState(for: $0.id)?.isFailed == true }?.id
        })
        await MainActor.run { newView.retryOutboxMessage(messageID) }
        try await waitUntil("changed target retry drains") {
            await store.loadCommands().isEmpty
        }
        #expect(await newTransport.state.sentAgentIDs == ["agent-b"])
        #expect(await newTransport.state.sentSessionKeys == ["agent:agent-b:main"])
    }

    @Test func `atomic gateway routing rejection parks without retrying`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)
        await MainActor.run { vm.load() }
        try await sendWhileOffline(vm, text: "do not cross config reload")

        await transport.state.setSendRoutingChanged(true)
        await transport.goOnline()
        try await waitUntil("atomic routing rejection parks") {
            await store.loadCommands().first?.status == .failed
        }
        let command = try #require(await store.loadCommands().first)
        #expect(command.lastError == OpenClawChatSQLiteTranscriptCache.outboxChangedTargetError)
        #expect(command.retryCount == 0)
        #expect(await transport.state.sentMessages.isEmpty)
    }

    @Test func `failed alias row remains reachable after owner change`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        #expect(await store.enqueueCommand(OpenClawChatOutboxCommand(
            id: "c-old-failure",
            sessionKey: "main",
            deliverySessionKey: "agent:agent-a:main",
            routingContract: "per-sender|main|agent-a",
            agentID: "agent-a",
            text: "review old failure",
            thinking: "off",
            createdAt: Date().timeIntervalSince1970,
            status: .failed,
            retryCount: 1,
            lastError: OpenClawChatSQLiteTranscriptCache.outboxExpiredError)))
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(
            transport: transport,
            outbox: store,
            activeAgentID: "agent-b",
            sessionRoutingContract: "per-sender|main|agent-b")

        await MainActor.run { vm.load() }
        try await waitUntil("old failed row stays visible") {
            await MainActor.run {
                vm.messages.contains { vm.outboxState(for: $0.id)?.isFailed == true }
            }
        }
        let messageID = try #require(await MainActor.run { vm.messages.last?.id })
        await MainActor.run { vm.deleteOutboxMessage(messageID) }
        try await waitUntil("old failed row can be deleted") { await store.loadCommands().isEmpty }
    }

    @Test func `ownerless global retry stays failed without a selected agent`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        #expect(await store.enqueueCommand(OpenClawChatOutboxCommand(
            id: "c-ownerless",
            sessionKey: "global",
            text: "choose my owner",
            thinking: "off",
            createdAt: Date().timeIntervalSince1970,
            status: .failed,
            retryCount: 0,
            lastError: OpenClawChatSQLiteTranscriptCache.outboxUnknownTargetError)))
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(
            transport: transport,
            outbox: store,
            sessionKey: "global",
            activeAgentID: nil)
        await MainActor.run { vm.load() }
        try await waitUntil("ownerless failed row visible") {
            await MainActor.run { vm.messages.contains { vm.outboxState(for: $0.id)?.isFailed == true } }
        }
        let messageID = try #require(await MainActor.run {
            vm.messages.first { vm.outboxState(for: $0.id)?.isFailed == true }?.id
        })

        await MainActor.run { vm.retryOutboxMessage(messageID) }
        try await waitUntil("ownerless retry asks for an agent") {
            await MainActor.run { vm.errorText == "Select an agent before retrying this message." }
        }
        let command = await store.loadCommands().first
        #expect(command?.status == .failed)
        #expect(command?.agentID == nil)
    }

    @Test func `unavailable recovery keeps the live send FIFO gate closed`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let outbox = DelayingOutbox(base: store)
        await outbox.setRecoveryAvailable(false)
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: outbox)

        await MainActor.run { vm.load() }
        await outbox.waitUntilRecoveryAttempted()

        #expect(await MainActor.run { !vm.hasRestoredOutboxMessages })
    }

    @Test func `reconnect flushes queued commands in order with their idempotency keys`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let transport = OutboxTestTransport(healthy: false)
        // One facade routes cache and outbox operations to their separate files.
        let vm = await makeOutboxViewModel(transport: transport, outbox: store, transcriptCache: store)

        await MainActor.run { vm.load() }
        try await sendWhileOffline(vm, text: "first")
        try await sendWhileOffline(vm, text: "second")
        let queuedIDs = await store.loadCommands().map(\.id)
        #expect(queuedIDs.count == 2)

        await transport.goOnline()

        try await waitUntil("outbox drained") {
            await store.loadCommands().isEmpty
        }
        // At-least-once contract: the transport saw each command exactly once
        // here, keyed by its client UUID, in strict createdAt order.
        #expect(await transport.state.sentIdempotencyKeys == queuedIDs)
        #expect(await transport.state.sentMessages == ["first", "second"])
        #expect(await transport.state.sentSessionKeys == ["agent:main:main", "agent:main:main"])

        // Durable history replaced the queued bubbles without duplicating
        // them, and no outbox state markers remain.
        try await waitUntil("durable history reconciled") {
            await MainActor.run { vm.sessionId == "sess-live" }
        }
        #expect(await userTexts(vm) == ["first", "second"])
        #expect(await MainActor.run { queuedStateCount(vm) } == 0)

        // The refreshed gateway history is cached for cold offline browsing.
        let cached = await store.loadTranscript(sessionKey: "main", agentID: "main")
        let cachedUserTexts = cached
            .filter { $0.role == "user" }
            .map { $0.content.compactMap(\.text).joined() }
        #expect(cachedUserTexts == ["first", "second"])
    }

    @Test func `overlapping view models share one atomic FIFO sender`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let now = Date().timeIntervalSince1970
        #expect(await store.enqueueCommand(outboxTestCommand(id: "c-1", text: "first", createdAt: now)))
        #expect(await store.enqueueCommand(outboxTestCommand(id: "c-2", text: "second", createdAt: now + 1)))
        let transport = OutboxTestTransport(healthy: false)
        let firstVM = await makeOutboxViewModel(transport: transport, outbox: store)
        let secondVM = await makeOutboxViewModel(transport: transport, outbox: store)

        await transport.state.setHealthy(true)
        await MainActor.run {
            firstVM.load()
            secondVM.load()
            firstVM.applyTransportHealth(true)
            secondVM.applyTransportHealth(true)
        }

        try await waitUntil("shared queue drained") {
            await store.loadCommands().isEmpty
        }
        #expect(await transport.state.sentIdempotencyKeys == ["c-1", "c-2"])
        #expect(await transport.state.sentMessages == ["first", "second"])
    }

    @Test func `assistant reply for a flushed run lands via the external-run final event`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run { vm.load() }
        try await sendWhileOffline(vm, text: "question")
        await transport.goOnline()
        try await waitUntil("outbox drained") {
            await store.loadCommands().isEmpty
        }
        let runId = try #require(await transport.state.sentIdempotencyKeys.first)

        // Drop history availability so the assertion below can only be
        // satisfied by the event path, not a lucky history refresh. (The
        // scripted history never contains assistant rows, so leaving it on
        // would wipe the appended final with an incomplete snapshot.)
        await transport.state.setHistoryFails(true)

        // Flushed runs are intentionally not in pendingRuns; the reply is
        // delivered through the session-scoped external-run final branch.
        transport.emit(
            .chat(
                OpenClawChatEventPayload(
                    runId: runId,
                    sessionKey: "main",
                    state: "final",
                    message: AnyCodable([
                        "role": "assistant",
                        "content": [["type": "text", "text": "answer"]],
                        "timestamp": 5000.0,
                    ] as [String: Any]),
                    errorMessage: nil)))

        try await waitUntil("assistant reply visible") {
            await MainActor.run {
                vm.messages.contains { message in
                    message.role == "assistant" && message.content.contains { $0.text == "answer" }
                }
            }
        }
    }

    @Test func `acknowledged turn stays in client state until history confirms it`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store, transcriptCache: store)

        await MainActor.run { vm.load() }
        try await sendWhileOffline(vm, text: "must survive")

        // chat.send ACKs before user-turn persistence. With history still
        // unreachable, the row must remain durable and non-replayable.
        await transport.state.setHistoryFails(true)
        await transport.goOnline()
        try await waitUntil("acknowledgement awaits history") {
            await store.loadCommands().map(\.status) == [.awaitingConfirmation]
        }

        let cached = await store.loadTranscript(sessionKey: "main", agentID: "main")
        #expect(cached.isEmpty)
        #expect(await store.loadCommands().map(\.text) == ["must survive"])
        #expect(await MainActor.run {
            vm.messages.contains { vm.outboxState(for: $0.id) == .confirming }
        })

        await transport.state.setHistoryFails(false)
        await MainActor.run { vm.refresh() }
        try await waitUntil("canonical history confirms send") {
            await store.loadCommands().isEmpty
        }
    }

    @Test func `healthy restore reconciles a previously acknowledged turn`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        #expect(await store.enqueueCommand(outboxTestCommand(
            id: "c-awaiting",
            text: "already acknowledged",
            createdAt: Date().timeIntervalSince1970)))
        #expect(await store.claimNextCommand()?.id == "c-awaiting")
        #expect(await store.markCommandAwaitingConfirmation(id: "c-awaiting") == .updated)

        let transport = OutboxTestTransport(healthy: true)
        await transport.state.recordSend(
            sessionKey: "main",
            agentID: nil,
            message: "already acknowledged",
            idempotencyKey: "c-awaiting",
            thinking: "off")
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)
        await MainActor.run { vm.load() }

        try await waitUntil("restore history confirms acknowledged turn") {
            await store.loadCommands().isEmpty
        }
        #expect(await transport.state.sentMessages == ["already acknowledged"])
    }

    @Test func `delete race preserves a turn already proven by canonical history`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        #expect(await store.enqueueCommand(outboxTestCommand(
            id: "c-delivered",
            text: "delivered already",
            createdAt: Date().timeIntervalSince1970)))
        let holdingOutbox = CancellationHoldingOutbox(base: store)
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(
            transport: transport,
            outbox: holdingOutbox,
            transcriptCache: store)
        await MainActor.run { vm.load() }
        try await waitUntil("delivered command restored") {
            await MainActor.run { vm.messages.contains { vm.outboxState(for: $0.id) == .queued } }
        }
        let canonicalMessage = OpenClawChatMessage(
            role: "user",
            content: [OpenClawChatMessageContent(
                type: "text",
                text: "delivered already",
                mimeType: nil,
                fileName: nil,
                content: nil)],
            timestamp: 1,
            idempotencyKey: "c-delivered:user")
        let messageID = try #require(await MainActor.run { vm.messages.last?.id })
        await MainActor.run { vm.deleteOutboxMessage(messageID) }
        await holdingOutbox.waitUntilCanceled()
        // Canonical proof lands after SQLite committed the cancellation but
        // before its result can remove presentation state on the MainActor.
        await MainActor.run { vm.confirmOutboxCommands(in: [canonicalMessage]) }
        await holdingOutbox.releaseCancellation()
        try await waitUntil("canonical proof wins delete race") {
            let commandsEmpty = await store.loadCommands().isEmpty
            let badgeCleared = await MainActor.run { vm.outboxState(for: messageID) == nil }
            return commandsEmpty && badgeCleared
        }
        #expect(await userTexts(vm) == ["delivered already"])
    }

    @Test func `offline local slash command keeps its draft and skips transport`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)
        await MainActor.run {
            // A transient transport loss can leave the preserved view model
            // healthy until the next explicit probe.
            vm.healthOK = true
            vm.input = "/new"
            vm.send()
        }
        try await waitUntil("offline slash command rejected") {
            await MainActor.run { vm.errorText == "Connect to the gateway to run this command." }
        }
        #expect(await MainActor.run { vm.input } == "/new")
        #expect(await store.loadCommands().isEmpty)
        #expect(await transport.state.sentMessages.isEmpty)
    }

    @Test func `lagging history does not recursively refresh an acknowledged turn`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        #expect(await store.enqueueCommand(outboxTestCommand(
            id: "c-lagging",
            text: "not persisted yet",
            createdAt: Date().timeIntervalSince1970)))
        #expect(await store.claimNextCommand()?.id == "c-lagging")
        #expect(await store.markCommandAwaitingConfirmation(id: "c-lagging") == .updated)

        let transport = OutboxTestTransport(healthy: true)
        await transport.state.setStaleHistoryRows([])
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)
        await MainActor.run { vm.load() }
        try await waitUntil("bootstrap history settles") {
            let bootstrapComplete = await MainActor.run { !vm.isLoading }
            let requestCount = await transport.state.historyRequestCount
            return bootstrapComplete && requestCount >= 1
        }
        // A recursive refresh starts immediately after applying stale history.
        // Observe beyond bootstrap completion instead of sampling between its
        // ordinary history request and the health-triggered reconciliation.
        try await Task.sleep(nanoseconds: 1_000_000_000)

        // load() also owns its ordinary visible-session history request. The
        // exact count can be one or two; neither may trigger a recursive pass.
        #expect(await transport.state.historyRequestCount <= 2)
        #expect(await store.loadCommands().map(\.status) == [.awaitingConfirmation])
    }

    @Test func `gateway rejections burn attempts then fail terminally and support tap retry`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run { vm.load() }
        try await sendWhileOffline(vm, text: "doomed")

        // Gateway is reachable again but rejects the run on every attempt.
        await transport.state.setSendRejects(true)
        await transport.goOnline()

        try await waitUntil("command failed after max attempts") {
            await store.loadCommands().map(\.status) == [.failed]
        }
        let failed = try #require(await store.loadCommands().first)
        #expect(failed.retryCount == OpenClawChatViewModel.maxOutboxSendAttempts)
        #expect(failed.lastError != nil)
        try await waitUntil("failed state visible") {
            await MainActor.run {
                vm.messages.contains { vm.outboxState(for: $0.id)?.isFailed == true }
            }
        }
        try await waitUntil("terminal failure flush settled") {
            await MainActor.run { !vm.isFlushingOutbox }
        }

        // Tap-to-retry resets attempts; with the gateway accepting again the
        // command now flushes and the row disappears.
        await transport.state.setSendRejects(false)
        let failedMessageID = try #require(await MainActor.run {
            vm.messages.first { vm.outboxState(for: $0.id)?.isFailed == true }?.id
        })
        await MainActor.run { vm.retryOutboxMessage(failedMessageID) }
        try await waitUntil("retried command drained", timeoutSeconds: 30) {
            await store.loadCommands().isEmpty
        }
        #expect(await transport.state.sentIdempotencyKeys.count == 1)
    }

    @Test func `unavailable terminal write drops health instead of advancing FIFO`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        #expect(await store.updateLastActiveLeafEntryID(
            "leaf-new",
            expectedEpoch: 0,
            for: OpenClawChatOutboxScope(sessionKey: "main", agentID: "main")))
        #expect(await store.updateLastActiveLeafEntryID(
            "leaf-new",
            expectedEpoch: 0,
            for: OpenClawChatOutboxScope(sessionKey: "main", agentID: nil)))
        #expect(await store.enqueueCommand(OpenClawChatOutboxCommand(
            id: "c-terminal-write",
            sessionKey: "main",
            routingContract: "per-sender|main|main",
            text: "do not skip me",
            thinking: "off",
            createdAt: Date().timeIntervalSince1970,
            status: .queued,
            retryCount: OpenClawChatViewModel.maxOutboxSendAttempts - 1,
            lastError: "rejected")))
        let outbox = DelayingOutbox(base: store)
        await outbox.setTerminalWritesAvailable(false)
        let transport = OutboxTestTransport(healthy: false)
        await transport.state.setSendRejects(true)
        let vm = await makeOutboxViewModel(transport: transport, outbox: outbox)

        await MainActor.run { vm.load() }
        await transport.goOnline()

        try await waitUntil("terminal write failure closes health with claim intact") {
            let status = await store.loadCommands().first?.status
            let healthDown = await MainActor.run { !vm.healthOK }
            return status == .sending && healthDown
        }
        #expect(await MainActor.run {
            vm.messages.allSatisfy { vm.outboxState(for: $0.id)?.isFailed != true }
        })
    }

    @Test func `gateway response errors are definitive and burn retry attempts`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run { vm.load() }
        try await sendWhileOffline(vm, text: "definitively rejected")
        await transport.state.setSendResponseErrors(true)
        await transport.goOnline()

        try await waitUntil("response error exhausts retry budget") {
            await store.loadCommands().map(\.status) == [.failed]
        }
        let failed = try #require(await store.loadCommands().first)
        #expect(failed.retryCount == OpenClawChatViewModel.maxOutboxSendAttempts)
        #expect(await transport.state.sentIdempotencyKeys.isEmpty)
    }

    @Test func `definitive live-send rejection restores draft without queueing`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let transport = OutboxTestTransport(healthy: true)
        await transport.state.setSendResponseErrors(true)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run { vm.load() }
        // Wait for outbox restore too: until it completes, sends deliberately
        // route behind the outbox (FIFO gate), which is not the path under test.
        try await waitUntil("bootstrap healthy") {
            await MainActor.run { vm.healthOK && vm.hasRestoredOutboxMessages }
        }
        await MainActor.run {
            vm.input = "keep this draft"
            vm.send()
        }
        try await waitUntil("definitive rejection surfaced") {
            await MainActor.run { vm.errorText != nil }
        }
        #expect(await MainActor.run { vm.input } == "keep this draft")
        #expect(await userTexts(vm).isEmpty)
        #expect(await store.loadCommands().isEmpty)
    }

    @Test func `ambiguous live transport failure requires explicit retry`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        // Health reads true, but the actual send path is down: the send gate
        // is bypassed and the transport error must preserve instead of losing
        // the optimistic turn.
        let transport = OutboxTestTransport(healthy: true, sendFails: true)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run { vm.load() }
        // Wait for outbox restore too: until it completes, sends deliberately
        // route behind the outbox (FIFO gate), which is not the path under test.
        try await waitUntil("bootstrap healthy") {
            await MainActor.run { vm.healthOK && vm.hasRestoredOutboxMessages }
        }
        await MainActor.run {
            vm.input = "stale health send"
            vm.send()
        }

        // The optimistic bubble survives, but delivery is ambiguous. It must
        // not return to the automatic queue after dedupe expiry or restart.
        try await waitUntil("ambiguous send preserved durably") {
            await store.loadCommands().map(\.status) == [.failed]
        }
        let preserved = try #require(await store.loadCommands().first)
        #expect(preserved.lastError == OpenClawChatSQLiteTranscriptCache.outboxUnconfirmedError)
        #expect(preserved.retryCount == 0)
        #expect(preserved.text == "stale health send")
        #expect(await userTexts(vm) == ["stale health send"])
        let bubbleKey = await MainActor.run {
            vm.messages.first { $0.role == "user" }?.idempotencyKey
        }
        #expect(bubbleKey == "\(preserved.id):user")
        #expect(await MainActor.run {
            vm.messages.contains { vm.outboxState(for: $0.id)?.isFailed == true }
        })
        #expect(await MainActor.run { !vm.healthOK })

        // Connectivity recovery only reconciles history; it cannot replay an
        // unproven send. A user retry creates the new delivery intent.
        await transport.state.setSendFails(false)
        await transport.goOnline()
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(await store.loadCommands().map(\.status) == [.failed])
        #expect(await transport.state.sentIdempotencyKeys.isEmpty)

        let messageID = try #require(await MainActor.run { vm.messages.last?.id })
        await MainActor.run { vm.retryOutboxMessage(messageID) }
        try await waitUntil("explicit retry drained", timeoutSeconds: 10) {
            await store.loadCommands().isEmpty
        }
        #expect(await transport.state.sentIdempotencyKeys == [preserved.id])
    }

    @Test func `lost queued send ack reconciles history without replay`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run { vm.load() }
        try await sendWhileOffline(vm, text: "accepted before disconnect")
        await transport.state.setSendFailsAfterRecording(true)
        await transport.goOnline()

        try await waitUntil("gateway accepted before ack loss") {
            await transport.state.sentIdempotencyKeys.count == 1
        }
        try await waitUntil("canonical history retires ambiguous send") {
            await store.loadCommands().isEmpty
        }
        #expect(await transport.state.sentMessages == ["accepted before disconnect"])
        #expect(await transport.state.sentIdempotencyKeys.count == 1)
    }

    @Test func `tap retry refreshes createdAt so an expired command can resend`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        // A command that sat offline past the staleness bound.
        let staleCreatedAt = Date().timeIntervalSince1970 -
            OpenClawChatSQLiteTranscriptCache.outboxCommandMaxAge - 60
        #expect(await store.enqueueCommand(
            OpenClawChatOutboxCommand(
                id: "c-expired",
                sessionKey: "main",
                text: "old message",
                thinking: "off",
                createdAt: staleCreatedAt,
                status: .queued,
                retryCount: 0,
                lastError: nil)))
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run { vm.load() }
        // Restore surfaces the expired command as failed("expired").
        try await waitUntil("expired command visible as failed") {
            await MainActor.run {
                vm.messages.contains { vm.outboxState(for: $0.id)?.isFailed == true }
            }
        }
        #expect(await store.loadCommands().map(\.lastError) == [
            OpenClawChatSQLiteTranscriptCache.outboxExpiredError,
        ])

        // Explicit retry is new intent: createdAt refreshes, so the row goes
        // back to queued instead of immediately re-expiring, and it flushes
        // once the gateway is reachable.
        let messageID = try #require(await MainActor.run {
            vm.messages.first { vm.outboxState(for: $0.id)?.isFailed == true }?.id
        })
        await MainActor.run { vm.retryOutboxMessage(messageID) }
        try await waitUntil("retried command re-queued") {
            await store.loadCommands().map(\.status) == [.queued]
        }
        await transport.goOnline()
        try await waitUntil("expired-then-retried command drained") {
            await store.loadCommands().isEmpty
        }
        #expect(await transport.state.sentMessages == ["old message"])
    }

    @Test func `flush gates captured thinking using the queued session metadata`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let now = Date().timeIntervalSince1970
        #expect(await store.enqueueCommand(
            OpenClawChatOutboxCommand(
                id: "c-think",
                sessionKey: "reasoning-session",
                routingContract: "per-sender|main|main",
                text: "think hard",
                thinking: "high",
                createdAt: now,
                status: .queued,
                retryCount: 0,
                lastError: nil)))
        #expect(await store.enqueueCommand(
            OpenClawChatOutboxCommand(
                id: "c-plain",
                sessionKey: "plain-session",
                routingContract: "per-sender|main|main",
                text: "no thinking",
                thinking: "medium",
                createdAt: now + 1,
                status: .queued,
                retryCount: 0,
                lastError: nil)))
        let sessionEntries = [
            outboxSessionEntry(key: "main", thinkingLevels: ["off"]),
            outboxSessionEntry(key: "reasoning-session", thinkingLevels: ["off", "high"]),
            outboxSessionEntry(key: "plain-session", thinkingLevels: ["off"]),
        ]
        let transport = OutboxTestTransport(healthy: false, sessions: sessionEntries)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run { vm.load() }
        await MainActor.run {
            vm.sessions = sessionEntries
            vm.syncThinkingLevelOptions()
        }
        #expect(await MainActor.run { !vm.showsThinkingPicker })
        await transport.goOnline()
        try await waitUntil("background send confirmed") {
            await store.loadCommands().isEmpty
        }
        #expect(await transport.state.sentThinkingLevels == ["high", "off"])
        #expect(await transport.state.sentSessionKeys == ["reasoning-session", "plain-session"])
        _ = vm
    }

    @Test func `gateway history caches a flushed background-session turn`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        // Queued for a session the user is no longer viewing.
        #expect(await store.enqueueCommand(
            OpenClawChatOutboxCommand(
                id: "c-background",
                sessionKey: "other-session",
                routingContract: "per-sender|main|main",
                text: "sent from elsewhere",
                thinking: "off",
                createdAt: Date().timeIntervalSince1970,
                status: .queued,
                retryCount: 0,
                lastError: nil)))
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store, transcriptCache: store)

        await MainActor.run { vm.load() }
        await transport.goOnline()
        try await waitUntil("background send confirmed without opening its session") {
            await store.loadCommands().isEmpty
        }

        // Canonical gateway history, not the optimistic outbox row, owns the
        // cached background transcript.
        let cached = await store.loadTranscript(sessionKey: "other-session")
        #expect(cached.map { $0.content.compactMap(\.text).joined() } == ["sent from elsewhere"])
        #expect(cached.map(\.idempotencyKey) == ["c-background:user"])
    }

    @Test func `background canonical alias event confirms by idempotency key`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        #expect(await store.enqueueCommand(OpenClawChatOutboxCommand(
            id: "c-alias",
            sessionKey: "main",
            deliverySessionKey: "agent:main:main",
            routingContract: "per-sender|main|main",
            agentID: "main",
            text: "canonical alias",
            thinking: "off",
            createdAt: Date().timeIntervalSince1970,
            status: .queued,
            retryCount: 0,
            lastError: nil)))
        #expect(await store.claimNextCommand()?.id == "c-alias")
        #expect(await store.markCommandAwaitingConfirmation(id: "c-alias") == .updated)
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store, transcriptCache: store)
        await MainActor.run {
            vm.load()
            vm.switchSession(to: "other-session")
        }

        transport.emit(.sessionMessage(OpenClawSessionMessageEventPayload(
            sessionKey: "agent:main:main",
            agentId: "main",
            message: OpenClawChatMessage(
                role: "user",
                content: [OpenClawChatMessageContent(
                    type: "text",
                    text: "canonical alias",
                    mimeType: nil,
                    fileName: nil,
                    content: nil)],
                timestamp: 1,
                idempotencyKey: "c-alias:user"),
            messageId: "message-c-alias",
            messageSeq: 1)))

        try await waitUntil("canonical alias confirms background command") {
            await store.loadCommands().isEmpty
        }
        let cached = await store.loadTranscript(sessionKey: "main", agentID: "main")
        #expect(cached.map(\.idempotencyKey) == ["c-alias:user"])
        #expect(cached.map { $0.content.compactMap(\.text).joined() } == ["canonical alias"])
    }

    @Test func `full queue refuses enqueue and keeps the draft`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        for index in 0..<OpenClawChatSQLiteTranscriptCache.maxQueuedCommands {
            let accepted = await store.enqueueCommand(
                OpenClawChatOutboxCommand(
                    id: "prefill-\(index)",
                    sessionKey: "other",
                    text: "m\(index)",
                    thinking: "off",
                    createdAt: Date().timeIntervalSince1970,
                    status: .queued,
                    retryCount: 0,
                    lastError: nil))
            #expect(accepted)
        }
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run {
            vm.input = "does not fit"
            vm.send()
        }
        try await waitUntil("refusal surfaced") {
            await MainActor.run { vm.errorText != nil }
        }
        // The draft survives so the text is not lost, and no row was added.
        #expect(await MainActor.run { vm.input } == "does not fit")
        #expect(await userTexts(vm).isEmpty)
        #expect(await store.loadCommands().count == OpenClawChatSQLiteTranscriptCache.maxQueuedCommands)
    }

    @Test func `accepted enqueue after session switch preserves newer original-session draft`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let outbox = DelayingOutbox(base: store)
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: outbox)
        await MainActor.run { vm.load() }
        try await waitUntil("initial outbox restore") {
            await MainActor.run { vm.hasRestoredOutboxMessages }
        }
        await outbox.holdEnqueue()

        await MainActor.run {
            vm.input = "queued once"
            vm.send()
        }
        await outbox.waitUntilEnqueueStarted()
        await MainActor.run {
            vm.switchSession(to: "other")
            vm.switchSession(to: "main")
            vm.input = ""
            vm.input = "queued once"
            vm.switchSession(to: "other")
        }
        await outbox.releaseEnqueue()
        try await waitUntil("enqueue accepted after switch") {
            await store.loadCommands().count == 1
        }
        try await waitUntil("newer original-session draft preserved") {
            await MainActor.run { vm.draftsBySession["main"] == "queued once" }
        }

        await MainActor.run { vm.switchSession(to: "main") }
        #expect(await MainActor.run { vm.input } == "queued once")
        #expect(await MainActor.run { vm.recallPreviousInput(caretOnFirstLine: true) })
        #expect(await MainActor.run { vm.input } == "queued once")
        #expect(await MainActor.run { vm.recallNextInput() })
        #expect(await MainActor.run { vm.input } == "queued once")
    }

    @Test func `accepted enqueue preserves retyped identical current-session draft`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let outbox = DelayingOutbox(base: store)
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: outbox)
        await MainActor.run { vm.load() }
        try await waitUntil("initial outbox restore") {
            await MainActor.run { vm.hasRestoredOutboxMessages }
        }
        await outbox.holdEnqueue()

        await MainActor.run {
            vm.input = "queued once"
            vm.send()
        }
        await outbox.waitUntilEnqueueStarted()
        await MainActor.run {
            vm.input = ""
            vm.input = "queued once"
        }
        await outbox.releaseEnqueue()
        try await waitUntil("enqueue accepted") {
            await store.loadCommands().count == 1
        }
        try await waitUntil("submission finished") {
            await MainActor.run { !vm.isSubmittingDraft }
        }

        #expect(await MainActor.run { vm.input } == "queued once")
    }

    @Test func `queued send transport failure fails closed until explicit retry`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let transport = OutboxTestTransport(healthy: false, sendFails: true)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run { vm.load() }
        try await sendWhileOffline(vm, text: "stuck in transit")

        // Gateway reports healthy but the send throws. One ambiguous attempt
        // must fail closed and drop health without automatic replay.
        await transport.goOnline()
        try await waitUntil("ambiguous queued send fails closed") {
            let failed = await store.loadCommands().first?.status == .failed
            let healthDown = await MainActor.run { !vm.healthOK }
            return failed && healthDown
        }
        let command = try #require(await store.loadCommands().first)
        #expect(command.lastError == OpenClawChatSQLiteTranscriptCache.outboxUnconfirmedError)
        #expect(command.retryCount == 0)
        #expect(await transport.state.sentIdempotencyKeys.isEmpty)

        // Reconnect only reconciles. Explicit retry is required to send.
        await transport.state.setSendFails(false)
        await transport.goOnline()
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(await store.loadCommands().map(\.status) == [.failed])

        let messageID = try #require(await MainActor.run { vm.messages.last?.id })
        await MainActor.run { vm.retryOutboxMessage(messageID) }
        try await waitUntil("explicit retry drains command") {
            await store.loadCommands().isEmpty
        }
        #expect(await transport.state.sentIdempotencyKeys == [command.id])
    }

    @Test func `deleting a queued message removes bubble and durable row`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let databases = try OpenClawClientDatabases(directoryURL: databaseDirectory)
        let store = databases.store(gatewayID: "gw-test")
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store, transcriptCache: store)

        await MainActor.run { vm.load() }
        try await sendWhileOffline(vm, text: "changed my mind")

        let messageID = try #require(await MainActor.run {
            vm.messages.first { vm.outboxState(for: $0.id) == .queued }?.id
        })
        let commandID = try #require(await store.loadCommands().first?.id)
        let staleMessage = OpenClawChatMessage(
            role: "user",
            content: [OpenClawChatMessageContent(
                type: "text",
                text: "changed my mind",
                mimeType: nil,
                fileName: nil,
                content: nil)],
            timestamp: 1,
            idempotencyKey: "\(commandID):user")
        let stalePayload = try String(decoding: JSONEncoder().encode(staleMessage), as: UTF8.self)
        try await databases.cacheQueue.write { db in
            try db.execute(
                sql: """
                INSERT INTO cached_transcripts(gateway_id, session_key, agent_id, updated_at)
                VALUES (?, ?, ?, ?)
                """,
                arguments: ["gw-test", "main", "", 1])
            try db.execute(
                sql: """
                INSERT INTO cached_messages(
                    gateway_id, session_key, agent_id, position,
                    timestamp_ms, idempotency_key, payload_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                arguments: ["gw-test", "main", "", 0, 1, "\(commandID):user", stalePayload])
        }
        await MainActor.run { vm.deleteOutboxMessage(messageID) }

        // The bubble disappears only after the durable delete lands, so a
        // process kill can never orphan a hidden-but-persisted command.
        try await waitUntil("bubble removed after durable delete") {
            await userTexts(vm).isEmpty
        }
        #expect(await MainActor.run { queuedStateCount(vm) } == 0)
        try await waitUntil("durable row deleted") {
            await store.loadCommands().isEmpty
        }
        try await waitUntil("canceled bubble removed from transcript cache") {
            await store.loadTranscript(sessionKey: "main", agentID: "main").isEmpty
        }

        // A later cold open must not repaint the canceled local bubble as an
        // ordinary sent transcript row after its outbox metadata is gone.
        let recreated = await makeOutboxViewModel(transport: transport, outbox: store, transcriptCache: store)
        await MainActor.run { recreated.load() }
        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(await userTexts(recreated).isEmpty)
    }
}

private actor DeleteGate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func open() {
        self.isOpen = true
        for waiter in self.waiters {
            waiter.resume()
        }
        self.waiters.removeAll()
    }

    func wait() async {
        if self.isOpen {
            return
        }
        await withCheckedContinuation { self.waiters.append($0) }
    }
}

extension ChatViewModelOutboxTests {
    @Test func `double submit during the offline health probe enqueues once`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run { vm.load() }
        // Two rapid submits of the same draft: the second lands while the
        // first is still awaiting the forced health probe. The isSending
        // guard must swallow it instead of enqueueing a duplicate row.
        await MainActor.run {
            vm.input = "tap tap"
            vm.send()
            vm.send()
        }
        try await waitUntil("queued bubble for tap tap") {
            await MainActor.run {
                vm.messages.contains { message in
                    message.role == "user" && message.content.contains { $0.text == "tap tap" }
                }
            }
        }

        let commands = await store.loadCommands()
        #expect(commands.map(\.text) == ["tap tap"])
        #expect(await MainActor.run { queuedStateCount(vm) } == 1)
    }

    @Test func `double submit during slash validation enqueues once`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let transport = OutboxTestTransport(healthy: false, supportsSlashCommands: true)
        let commandListGate = DeleteGate()
        await transport.state.setCommandListGate(commandListGate)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run {
            vm.input = "/remote-command"
            vm.send()
        }
        await transport.state.waitUntilCommandListStarted()
        await MainActor.run {
            vm.input = "newer draft"
            #expect(!vm.canSend)
            vm.send()
        }
        await commandListGate.open()

        try await waitUntil("slash command queued once") {
            await store.loadCommands().count == 1
        }
        #expect(await store.loadCommands().map(\.text) == ["/remote-command"])
        #expect(await MainActor.run { vm.input } == "newer draft")
    }

    @Test func `stale history after the flush ack keeps the durable turn visible`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store, transcriptCache: store)

        await MainActor.run { vm.load() }
        try await sendWhileOffline(vm, text: "must survive stale history")

        // The gateway acks the flush but its history snapshot lags: it still
        // returns only an older turn without the just-sent idempotency key.
        let staleRow = AnyCodable([
            "role": "assistant",
            "content": [["type": "text", "text": "older turn"]],
            "timestamp": 500.0,
        ] as [String: Any])
        await transport.state.setStaleHistoryRows([staleRow])
        await transport.goOnline()
        try await waitUntil("acknowledgement awaits canonical history") {
            await store.loadCommands().map(\.status) == [.awaitingConfirmation]
        }
        try await waitUntil("stale refresh applied") {
            await MainActor.run { vm.messages.contains { message in
                message.content.contains { $0.text == "older turn" }
            } }
        }
        // The cache remains a pure gateway snapshot. The durable confirmation
        // row is merged into the live view instead of being copied into it.
        if let pendingWrite = await MainActor.run(body: { vm.pendingCacheWriteTask }) {
            await pendingWrite.value
        }
        let cached = await store.loadTranscript(sessionKey: "main", agentID: "main")
        #expect(!cached.contains { message in
            message.content.contains { $0.text == "must survive stale history" }
        })
        #expect(await MainActor.run {
            vm.messages.contains { message in
                message.content.contains { $0.text == "must survive stale history" } &&
                    vm.outboxState(for: message.id) == .confirming
            }
        })
        await transport.state.setStaleHistoryRows(nil)
        await MainActor.run { vm.refresh() }
        try await waitUntil("fresh history confirms send") {
            await store.loadCommands().isEmpty
        }
    }

    @Test func `send before restore adopts durable rows still queues behind them`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        // Persist a row as an earlier process would have.
        #expect(await store.enqueueCommand(OpenClawChatOutboxCommand(
            id: UUID().uuidString,
            sessionKey: "main",
            routingContract: "per-sender|main|main",
            text: "queued by the previous launch",
            thinking: "off",
            createdAt: Date().timeIntervalSince1970 - 60,
            status: .queued,
            retryCount: 0,
            lastError: nil)))

        // Healthy cold open: fire a send synchronously after load(), before
        // the async restore has adopted the durable row. The FIFO gate must
        // still route it behind the backlog.
        let transport = OutboxTestTransport(healthy: true)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)
        await MainActor.run {
            vm.load()
            vm.input = "typed instantly on open"
            vm.send()
        }

        try await waitUntil("both turns delivered") {
            await transport.state.sentMessages.count == 2
        }
        #expect(await transport.state.sentMessages == [
            "queued by the previous launch",
            "typed instantly on open",
        ])
        try await waitUntil("rows drained") {
            await store.loadCommands().isEmpty
        }
    }

    @Test func `send right after a session switch still queues behind that session's backlog`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        #expect(await store.updateLastActiveLeafEntryID(
            "leaf-new",
            expectedEpoch: 0,
            for: OpenClawChatOutboxScope(sessionKey: "second", agentID: nil)))
        #expect(await store.updateLastActiveLeafEntryID(
            "leaf-new",
            expectedEpoch: 0,
            for: OpenClawChatOutboxScope(sessionKey: "second", agentID: "main")))
        // Backlog persisted for a session that is not initially visible.
        #expect(await store.enqueueCommand(OpenClawChatOutboxCommand(
            id: UUID().uuidString,
            sessionKey: "second",
            routingContract: "per-sender|main|main",
            text: "backlog in second session",
            thinking: "off",
            createdAt: Date().timeIntervalSince1970 - 60,
            status: .queued,
            retryCount: 0,
            lastError: nil)))

        // Start offline so the backlog cannot drain before the switch.
        let transport = OutboxTestTransport(healthy: false)
        let outbox = DelayingOutbox(base: store)
        let vm = await makeOutboxViewModel(transport: transport, outbox: outbox)
        await MainActor.run { vm.load() }
        // Let "main" finish restoring so the FIFO gate flag is set for it.
        try await waitUntil("initial session restored") {
            await MainActor.run { vm.hasRestoredOutboxMessages }
        }

        // Delay outbox reads from here on so, after the switch, neither the
        // new session's restore nor the reconnect flush can observe the
        // backlog before the send's gate check runs. Only the reset-on-switch
        // keeps ordering safe in that window.
        await outbox.setLoadDelayNanoseconds(150_000_000)

        // Switch, reconnect, and send immediately: the restore gate must
        // reset with the switch, so this send routes behind the new
        // session's backlog instead of going live ahead of it.
        await MainActor.run { vm.switchSession(to: "second") }
        await transport.goOnline()
        await MainActor.run {
            vm.input = "typed right after switching"
            vm.send()
        }

        try await waitUntil("both turns delivered") {
            await transport.state.sentMessages.count == 2
        }
        #expect(await transport.state.sentMessages == [
            "backlog in second session",
            "typed right after switching",
        ])
        try await waitUntil("rows drained") {
            await store.loadCommands().isEmpty
        }
    }

    @Test func `flush waits for an in-flight model patch before sending`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run { vm.load() }
        try await sendWhileOffline(vm, text: "after the model change")

        // A model change is still patching when health recovers. The flush
        // must honor the same ordering as live sends and hold until the
        // patch resolves, or the run would start on the stale model.
        await MainActor.run { vm.selectModel("anthropic/claude-test") }
        await transport.waitUntilModelPatchStarted()
        await transport.goOnline()
        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(await transport.state.sentMessages.isEmpty)

        transport.releaseModelPatch()
        try await waitUntil("outbox drained after patch resolved") {
            await store.loadCommands().isEmpty
        }
        #expect(await transport.state.sentMessages == ["after the model change"])
    }

    @Test func `offline enqueue waits for a truly in-flight model patch`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run { vm.load() }
        await MainActor.run {
            vm.selectModel("anthropic/claude-test")
            vm.input = "enqueue after model patch"
            vm.send()
        }
        await transport.waitUntilModelPatchStarted()
        try await Task.sleep(for: .milliseconds(50))
        #expect(await store.loadCommands().isEmpty)

        transport.releaseModelPatch()
        try await waitUntil("enqueue resumes after model patch") {
            await store.loadCommands().map(\.text) == ["enqueue after model patch"]
        }
        #expect(await transport.state.sentMessages.isEmpty)
    }

    @Test func `live send after reconnect queues behind draining outbox rows`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run { vm.load() }
        try await sendWhileOffline(vm, text: "first, written offline")

        // Reconnect with the first send held mid-flight, then send live text
        // immediately: it must fall in line behind the draining row, not
        // race ahead of it.
        let gate = DeleteGate()
        await transport.state.setHeldSendGate(gate)
        await transport.goOnline()
        try await waitUntil("first row claimed for sending") {
            await store.loadCommands().map(\.status) == [.sending]
        }
        await MainActor.run {
            vm.input = "second, right after reconnect"
            vm.send()
        }
        try await waitUntil("second row queued behind the first") {
            await store.loadCommands().map(\.text).contains("second, right after reconnect")
        }
        #expect(await transport.state.sentMessages.isEmpty)

        await gate.open()
        try await waitUntil("both rows drained in order") {
            await store.loadCommands().isEmpty
        }
        #expect(await transport.state.sentMessages == [
            "first, written offline",
            "second, right after reconnect",
        ])
    }

    @Test func `a stale second view model cannot cancel a claimed send`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let transport = OutboxTestTransport(healthy: false)
        let sender = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run { sender.load() }
        try await sendWhileOffline(sender, text: "already claimed")
        let observer = await makeOutboxViewModel(transport: transport, outbox: store)
        await MainActor.run { observer.load() }
        try await waitUntil("second view model restores queued bubble") {
            await MainActor.run { queuedStateCount(observer) == 1 }
        }

        let messageID = try #require(await MainActor.run {
            observer.messages.first { observer.outboxState(for: $0.id) == .queued }?.id
        })
        let sendGate = DeleteGate()
        await transport.state.setHeldSendGate(sendGate)
        // This fake exposes one shared event stream, unlike native transports that
        // broadcast reconnects. Select the intended owner instead of racing the observer.
        await MainActor.run { sender.applyTransportHealth(true) }
        try await waitUntil("first view model claims row") {
            await store.loadCommands().map(\.status) == [.sending]
        }
        await MainActor.run { observer.deleteOutboxMessage(messageID) }
        try await waitUntil("observer adopts sending status") {
            await MainActor.run { observer.outboxState(for: messageID) == .sending }
        }
        #expect(await store.loadCommands().map(\.status) == [.sending])

        await transport.state.setHealthy(true)
        await sendGate.open()
        try await waitUntil("claimed send confirms") {
            await store.loadCommands().isEmpty
        }
        #expect(await transport.state.sentMessages == ["already claimed"])
    }

    @Test func `both view models remove a command canceled by either one`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let transport = OutboxTestTransport(healthy: false)
        let first = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run { first.load() }
        try await sendWhileOffline(first, text: "cancel everywhere")
        let second = await makeOutboxViewModel(transport: transport, outbox: store)
        await MainActor.run { second.load() }
        try await waitUntil("both views show queued command") {
            await MainActor.run { queuedStateCount(first) == 1 && queuedStateCount(second) == 1 }
        }

        let firstID = try #require(await MainActor.run { first.messages.last?.id })
        let secondID = try #require(await MainActor.run { second.messages.last?.id })
        await MainActor.run { first.deleteOutboxMessage(firstID) }
        try await waitUntil("first view cancels durable row") {
            let rowsEmpty = await store.loadCommands().isEmpty
            let textEmpty = await userTexts(first).isEmpty
            return rowsEmpty && textEmpty
        }

        await MainActor.run { second.deleteOutboxMessage(secondID) }
        try await waitUntil("second view removes stale canceled bubble") {
            await userTexts(second).isEmpty
        }
        #expect(await transport.state.sentMessages.isEmpty)
    }

    @Test func `cancellation invalidates another views in flight restore snapshot`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let transport = OutboxTestTransport(healthy: false)
        let cancelingView = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run { cancelingView.load() }
        try await sendWhileOffline(cancelingView, text: "stale snapshot")
        #expect(await store.enqueueCommand(outboxTestCommand(
            id: "c-survivor",
            text: "survivor",
            createdAt: Date().timeIntervalSince1970 + 1)))
        let staleOutbox = SnapshotHoldingOutbox(base: store)
        await staleOutbox.holdNextLoad()
        let staleView = await MainActor.run {
            OpenClawChatViewModel(
                sessionKey: "main",
                transport: transport,
                activeAgentId: "main",
                sessionRoutingContract: "per-sender|main|main",
                outbox: staleOutbox)
        }
        await MainActor.run { staleView.load() }
        await staleOutbox.waitUntilSnapshotCaptured()

        let messageID = try #require(await MainActor.run { cancelingView.messages.last?.id })
        await MainActor.run { cancelingView.deleteOutboxMessage(messageID) }
        try await waitUntil("durable cancellation broadcasts") {
            await store.loadCommands().map(\.id) == ["c-survivor"]
        }
        await staleOutbox.releaseSnapshot()
        try await Task.sleep(nanoseconds: 100_000_000)

        try await waitUntil("invalidated restore reloads surviving command") {
            await userTexts(staleView) == ["survivor"]
        }
        #expect(await MainActor.run { queuedStateCount(staleView) } == 1)
        #expect(await transport.state.sentMessages.isEmpty)
    }

    @Test func `confirmation invalidates cancellation claimed row reload`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let outbox = SnapshotHoldingOutbox(base: store)
        let transport = OutboxTestTransport(healthy: false)
        let vm = await MainActor.run {
            OpenClawChatViewModel(
                sessionKey: "main",
                transport: transport,
                activeAgentId: "main",
                sessionRoutingContract: "per-sender|main|main",
                outbox: outbox)
        }

        await MainActor.run { vm.load() }
        try await sendWhileOffline(vm, text: "confirmed during delete")
        let command = try #require(await store.claimNextCommand())
        let messageID = try #require(await MainActor.run { vm.messages.last?.id })
        await outbox.holdNextLoad()
        await MainActor.run { vm.deleteOutboxMessage(messageID) }
        await outbox.waitUntilSnapshotCaptured()

        #expect(await store.confirmCommand(id: command.id) == .updated)
        await outbox.releaseSnapshot()
        try await waitUntil("confirmation clears stale sending badge") {
            await MainActor.run { vm.outboxState(for: messageID) == nil }
        }
        #expect(await userTexts(vm) == ["confirmed during delete"])
    }

    @Test func `route replacement cannot retarget a claimed command`() async throws {
        let databaseDirectory = try makeOutboxDatabaseDirectory()
        defer { try? FileManager.default.removeItem(at: databaseDirectory) }
        let store = try makeOutboxStore(
            databaseDirectoryURL: databaseDirectory,
            gatewayID: "gw-test")
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)

        await MainActor.run { vm.load() }
        try await sendWhileOffline(vm, text: "belongs to the old route")
        let sendGate = DeleteGate()
        await transport.state.setHeldSendGate(sendGate)
        await transport.goOnline()
        try await waitUntil("old route claims command") {
            await store.loadCommands().map(\.status) == [.sending]
        }

        await transport.state.replaceRoute()
        await sendGate.open()
        try await waitUntil("pre-dispatch route cancellation requeues command") {
            await store.loadCommands().map(\.status) == [.queued]
        }
        #expect(await transport.state.sentMessages.isEmpty)
        #expect(await store.loadCommands().first?.lastError == nil)
        #expect(await MainActor.run { !vm.healthOK })
    }
}
