import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

private func makeSessionActionOutboxDirectory() throws -> URL {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("chat-session-action-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
}

private func sessionActionOutboxCommand(
    id: String,
    text: String) -> OpenClawChatOutboxCommand
{
    OpenClawChatOutboxCommand(
        id: id,
        sessionKey: "main",
        text: text,
        thinking: "off",
        createdAt: Date().timeIntervalSince1970,
        status: .queued,
        retryCount: 0,
        lastError: nil)
}

private actor SessionActionTransportState {
    var forkedParentKeys: [String] = []
    var rewoundMessages: [(sessionKey: String, entryID: String)] = []
    var forkedMessages: [(sessionKey: String, entryID: String)] = []
    var branchListSessionKeys: [String] = []
    var branchListCallCount = 0
    var switchedBranches: [(sessionKey: String, leafEntryID: String)] = []
    var sentSessionKeys: [String] = []
    var historySessionKeys: [String] = []
    var historyCallCount = 0
    var patchedKeys: [String] = []
    var deletedKeys: [String] = []
    var groupPuts: [[String]] = []
    var createdAgentIDs: [String?] = []
    var createdParentKeys: [String?] = []

    func recordFork(_ key: String) {
        self.forkedParentKeys.append(key)
    }

    func recordRewind(sessionKey: String, entryID: String) {
        self.rewoundMessages.append((sessionKey, entryID))
    }

    func recordForkAtMessage(sessionKey: String, entryID: String) {
        self.forkedMessages.append((sessionKey, entryID))
    }

    func recordBranchList(_ sessionKey: String) -> Int {
        self.branchListSessionKeys.append(sessionKey)
        defer { self.branchListCallCount += 1 }
        return self.branchListCallCount
    }

    func recordBranchSwitch(sessionKey: String, leafEntryID: String) {
        self.switchedBranches.append((sessionKey, leafEntryID))
    }

    func recordSend(sessionKey: String) {
        self.sentSessionKeys.append(sessionKey)
    }

    func recordHistory(_ sessionKey: String) -> Int {
        self.historySessionKeys.append(sessionKey)
        defer { self.historyCallCount += 1 }
        return self.historyCallCount
    }

    func recordPatch(_ key: String) {
        self.patchedKeys.append(key)
    }

    func recordGroupPut(_ names: [String]) {
        self.groupPuts.append(names)
    }

    func recordDelete(_ key: String) {
        self.deletedKeys.append(key)
    }

    func recordCreate(agentID: String?, parentKey: String?) {
        self.createdAgentIDs.append(agentID)
        self.createdParentKeys.append(parentKey)
    }
}

/// Signals the exact suspension point before an action completes, then holds it so
/// navigation can advance deterministically before the stale result resumes.
private struct SessionActionCompletionGate: Sendable {
    private let startedStream: AsyncStream<Void>
    private let startedContinuation: AsyncStream<Void>.Continuation
    private let releaseStream: AsyncStream<Void>
    private let releaseContinuation: AsyncStream<Void>.Continuation

    init() {
        let started = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        self.startedStream = started.stream
        self.startedContinuation = started.continuation
        let release = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        self.releaseStream = release.stream
        self.releaseContinuation = release.continuation
    }

    func suspendCompletion() async {
        self.startedContinuation.yield()
        var iterator = self.releaseStream.makeAsyncIterator()
        _ = await iterator.next()
    }

    func waitUntilStarted() async -> Bool {
        var iterator = self.startedStream.makeAsyncIterator()
        return await iterator.next() != nil
    }

    func release() {
        self.releaseContinuation.yield()
    }
}

private final class SessionActionTransport: @unchecked Sendable, OpenClawChatTransport {
    private let state = SessionActionTransportState()
    private let forkGate: SessionActionCompletionGate?
    private let rewindGate: SessionActionCompletionGate?
    private let forkAtMessageGate: SessionActionCompletionGate?
    private let branchSwitchGate: SessionActionCompletionGate?
    private let branchListGates: [SessionActionCompletionGate]
    private let rewindEditorText: String?
    private let forkAtMessageSessionKey: String
    private let forkAtMessageEditorText: String?
    private let branches: [OpenClawChatSessionBranch]
    private let branchListResponses: [[OpenClawChatSessionBranch]]
    private let branchListFailureIndices: Set<Int>
    private let historyGates: [Int: SessionActionCompletionGate]
    private let historyFailureIndices: Set<Int>
    private let sendSucceeds: Bool

    init(
        forkGate: SessionActionCompletionGate? = nil,
        rewindGate: SessionActionCompletionGate? = nil,
        forkAtMessageGate: SessionActionCompletionGate? = nil,
        branchSwitchGate: SessionActionCompletionGate? = nil,
        branchListGates: [SessionActionCompletionGate] = [],
        rewindEditorText: String? = "rewound draft",
        forkAtMessageSessionKey: String = "forked-at-message",
        forkAtMessageEditorText: String? = "forked draft",
        branches: [OpenClawChatSessionBranch] = [],
        branchListResponses: [[OpenClawChatSessionBranch]] = [],
        branchListFailureIndices: Set<Int> = [],
        historyGates: [Int: SessionActionCompletionGate] = [:],
        historyFailureIndices: Set<Int> = [],
        sendSucceeds: Bool = false)
    {
        self.forkGate = forkGate
        self.rewindGate = rewindGate
        self.forkAtMessageGate = forkAtMessageGate
        self.branchSwitchGate = branchSwitchGate
        self.branchListGates = branchListGates
        self.rewindEditorText = rewindEditorText
        self.forkAtMessageSessionKey = forkAtMessageSessionKey
        self.forkAtMessageEditorText = forkAtMessageEditorText
        self.branches = branches
        self.branchListResponses = branchListResponses
        self.branchListFailureIndices = branchListFailureIndices
        self.historyGates = historyGates
        self.historyFailureIndices = historyFailureIndices
        self.sendSucceeds = sendSucceeds
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        let callIndex = await self.state.recordHistory(sessionKey)
        await self.historyGates[callIndex]?.suspendCompletion()
        if self.historyFailureIndices.contains(callIndex) {
            throw NSError(
                domain: "SessionActionTransport",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "history unavailable"])
        }
        return OpenClawChatHistoryPayload(
            sessionKey: sessionKey,
            sessionId: "session-\(sessionKey)",
            messages: [],
            thinkingLevel: "off")
    }

    func sendMessage(
        sessionKey: String,
        message _: String,
        thinking _: String,
        idempotencyKey: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        await self.state.recordSend(sessionKey: sessionKey)
        if self.sendSucceeds {
            return OpenClawChatSendResponse(runId: idempotencyKey, status: "accepted")
        }
        throw NSError(domain: "SessionActionTransport", code: 1)
    }

    func forkSession(parentKey: String) async throws -> String {
        await self.state.recordFork(parentKey)
        await self.forkGate?.suspendCompletion()
        return "forked"
    }

    func rewindSession(
        sessionKey: String,
        entryId: String) async throws -> OpenClawChatRewindResponse
    {
        await self.state.recordRewind(sessionKey: sessionKey, entryID: entryId)
        await self.rewindGate?.suspendCompletion()
        return OpenClawChatRewindResponse(editorText: self.rewindEditorText)
    }

    func forkSessionAtMessage(
        sessionKey: String,
        entryId: String) async throws -> OpenClawChatForkAtMessageResponse
    {
        await self.state.recordForkAtMessage(sessionKey: sessionKey, entryID: entryId)
        await self.forkAtMessageGate?.suspendCompletion()
        return OpenClawChatForkAtMessageResponse(
            sessionKey: self.forkAtMessageSessionKey,
            editorText: self.forkAtMessageEditorText)
    }

    func listSessionBranches(
        sessionKey: String,
        agentID _: String?) async throws -> OpenClawChatSessionBranchesResponse
    {
        let callIndex = await self.state.recordBranchList(sessionKey)
        if self.branchListGates.indices.contains(callIndex) {
            await self.branchListGates[callIndex].suspendCompletion()
        }
        if self.branchListFailureIndices.contains(callIndex) {
            throw NSError(domain: "SessionActionTransport", code: 3)
        }
        let branches = self.branchListResponses.indices.contains(callIndex)
            ? self.branchListResponses[callIndex]
            : self.branches
        return OpenClawChatSessionBranchesResponse(branches: branches)
    }

    func switchSessionBranch(sessionKey: String, agentID _: String?, leafEntryId: String) async throws {
        await self.state.recordBranchSwitch(sessionKey: sessionKey, leafEntryID: leafEntryId)
        await self.branchSwitchGate?.suspendCompletion()
    }

    func patchSession(
        key: String,
        label _: String??,
        category _: String??,
        pinned _: Bool?,
        archived _: Bool?,
        unread _: Bool?) async throws
    {
        await self.state.recordPatch(key)
    }

    func acquireSessionGroupsRouteLease() async -> OpenClawChatSessionGroupsRouteLease? {
        let state = self.state
        return OpenClawChatSessionGroupsRouteLease(
            listGroups: {
                OpenClawChatSessionGroupsResponse(groups: [
                    OpenClawChatSessionGroup(name: "Existing", position: 0),
                ])
            },
            putGroups: { names in
                await state.recordGroupPut(names)
                return OpenClawChatSessionGroupsMutationResponse(
                    ok: true,
                    groups: names.enumerated().map {
                        OpenClawChatSessionGroup(name: $0.element, position: $0.offset)
                    },
                    updatedSessions: nil)
            },
            renameGroup: { _, _ in
                OpenClawChatSessionGroupsMutationResponse(ok: true, groups: [], updatedSessions: nil)
            },
            deleteGroup: { _ in
                OpenClawChatSessionGroupsMutationResponse(ok: true, groups: [], updatedSessions: nil)
            })
    }

    func acquireNewSessionRouteLease() async -> OpenClawChatNewSessionRouteLease? {
        let state = self.state
        return OpenClawChatNewSessionRouteLease(
            listAgents: {
                OpenClawChatAgentsListResponse(
                    defaultId: "worker",
                    agents: [OpenClawChatAgentChoice(id: "worker", workspaceGit: true)])
            },
            createSession: { key, _, agentID, parentKey, _, _ in
                await state.recordCreate(agentID: agentID, parentKey: parentKey)
                return OpenClawChatCreateSessionResponse(ok: true, key: key, sessionId: nil)
            })
    }

    func deleteSession(key: String) async throws {
        await self.state.recordDelete(key)
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { $0.finish() }
    }

    func forkedParentKeys() async -> [String] {
        await self.state.forkedParentKeys
    }

    func rewoundMessages() async -> [(sessionKey: String, entryID: String)] {
        await self.state.rewoundMessages
    }

    func forkedMessages() async -> [(sessionKey: String, entryID: String)] {
        await self.state.forkedMessages
    }

    func branchListSessionKeys() async -> [String] {
        await self.state.branchListSessionKeys
    }

    func switchedBranches() async -> [(sessionKey: String, leafEntryID: String)] {
        await self.state.switchedBranches
    }

    func sentSessionKeys() async -> [String] {
        await self.state.sentSessionKeys
    }

    func historySessionKeys() async -> [String] {
        await self.state.historySessionKeys
    }

    func patchedKeys() async -> [String] {
        await self.state.patchedKeys
    }

    func groupPuts() async -> [[String]] {
        await self.state.groupPuts
    }

    func deletedKeys() async -> [String] {
        await self.state.deletedKeys
    }

    func createdAgentIDs() async -> [String?] {
        await self.state.createdAgentIDs
    }

    func createdParentKeys() async -> [String?] {
        await self.state.createdParentKeys
    }
}

private actor BatchMutationProbe {
    private(set) var active = 0
    private(set) var maximumActive = 0
    private(set) var visited: [String] = []

    func begin(_ key: String) {
        self.active += 1
        self.maximumActive = max(self.maximumActive, self.active)
        self.visited.append(key)
    }

    func end() {
        self.active -= 1
    }
}

private struct BatchTestError: LocalizedError {
    var errorDescription: String? {
        "rejected"
    }
}

@MainActor
struct ChatViewModelSessionActionTests {
    @Test func `batch mutations continue after per-row failure with bounded fan-out`() async {
        let probe = BatchMutationProbe()
        let result = await ChatSessionBatchMutationRunner.run(
            keys: ["a", "b", "c", "d", "e"],
            maxConcurrent: 2)
        { key in
            await probe.begin(key)
            try? await Task.sleep(for: .milliseconds(10))
            await probe.end()
            if key == "c" { throw BatchTestError() }
        }

        #expect(result.succeededKeys == ["a", "b", "d", "e"])
        #expect(result.errorsByKey == ["c": "rejected"])
        #expect(await probe.maximumActive == 2)
        #expect(await Set(probe.visited) == Set(["a", "b", "c", "d", "e"]))
    }

    @Test func `batch mutation includes selected server-search entry outside live roster`() async {
        let transport = SessionActionTransport()
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        let searchResult = self.entry(key: "older-search-result")

        let result = await viewModel.performSessionBatch(sessions: [searchResult], action: .pin)

        #expect(result.succeededKeys == ["older-search-result"])
        #expect(result.errorsByKey.isEmpty)
        #expect(await transport.patchedKeys() == ["older-search-result"])
    }

    @Test func `group create lists and replaces through one captured route lease`() async throws {
        let transport = SessionActionTransport()
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        let lease = try await viewModel.sessionGroupsRouteLease()

        let groups = try await viewModel.createSessionGroup(named: "New", using: lease)

        #expect(groups.map(\.name) == ["Existing", "New"])
        #expect(await transport.groupPuts() == [["Existing", "New"]])
        // Catalog-only mutations must bump the revision so sidebar group fetches
        // keyed on it refetch instead of staying stale until reconnect.
        #expect(viewModel.sessionGroupsRevision == 1)
    }

    @Test func `remote group mutations bump the catalog revision`() async {
        let transport = SessionActionTransport()
        let viewModel = await MainActor.run {
            OpenClawChatViewModel(sessionKey: "main", transport: transport)
        }

        await MainActor.run {
            viewModel.handleTransportEvent(.sessionsChanged(.init(sessionKey: nil, reason: "groups")))
            viewModel.handleTransportEvent(.sessionsChanged(.init(sessionKey: nil, reason: "unrelated")))
        }

        #expect(await MainActor.run { viewModel.sessionGroupsRevision } == 1)
    }

    @Test func `batch delete rejects current session while attachment owner is pinned`() async {
        let transport = SessionActionTransport()
        let viewModel = OpenClawChatViewModel(sessionKey: "worker", transport: transport)
        viewModel.attachments = [OpenClawPendingAttachment(
            url: nil,
            data: Data([1]),
            fileName: "draft.png",
            mimeType: "image/png",
            preview: nil)]

        let result = await viewModel.performSessionBatch(
            sessions: [self.entry(key: "worker")],
            action: .delete)

        #expect(result.succeededKeys.isEmpty)
        #expect(result.errorsByKey["worker"] != nil)
        #expect(await transport.deletedKeys().isEmpty)
    }

    @Test func `new session options list and create through one captured route lease`() async throws {
        let transport = SessionActionTransport()
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        let lease = try await viewModel.newSessionRouteLease()
        let response = try await lease.listAgents()

        await viewModel.startNewSession(
            agentID: response?.defaultId ?? "",
            worktree: true,
            worktreeBaseRef: "main",
            using: lease)

        #expect(await transport.createdAgentIDs() == ["worker"])
    }

    @Test func `unsupported create with advanced options fails without resetting`() async {
        // SessionActionTransport relies on the protocol's default createSession,
        // which throws the canonical unsupported error; the worktree request must
        // surface it instead of taking the plain-new reset fallback.
        let transport = SessionActionTransport()
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)

        let created = await viewModel.startNewSession(worktree: true)

        #expect(created == false)
        #expect(viewModel.sessionKey == "main")
        #expect(viewModel.errorText != nil)
    }

    @Test func `ambiguous agent ownership omits the parent session`() async throws {
        let transport = SessionActionTransport()
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        // Roster entries must not decide the current agent: "main" is unscoped and
        // no active agent is set, so agent selection crosses an ownership boundary.
        viewModel.sessions = [self.entry(key: "agent:worker:main")]
        let lease = try await viewModel.newSessionRouteLease()

        await viewModel.startNewSession(
            agentID: "worker",
            worktree: false,
            worktreeBaseRef: nil,
            using: lease)

        #expect(await transport.createdParentKeys() == [nil])
    }

    @Test func `active agent identity preserves parent for an unscoped current key`() async throws {
        let transport = SessionActionTransport()
        let viewModel = OpenClawChatViewModel(
            sessionKey: "main",
            transport: transport,
            activeAgentId: "worker")
        let lease = try await viewModel.newSessionRouteLease()

        await viewModel.startNewSession(
            agentID: "worker",
            worktree: false,
            worktreeBaseRef: nil,
            using: lease)

        #expect(await transport.createdParentKeys() == ["main"])
    }

    @Test func `rewind seeds editor and refreshes history`() async {
        let transport = SessionActionTransport(rewindEditorText: "edit this turn")
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        viewModel.input = "old draft"

        await viewModel.rewindToMessage(self.userMessage(entryID: "message-42"))

        #expect(viewModel.input == "edit this turn")
        #expect(await transport.rewoundMessages().map { [$0.sessionKey, $0.entryID] } == [["main", "message-42"]])
        #expect(await transport.historySessionKeys() == ["main"])
    }

    @Test func `rewind does not dispatch while busy`() async {
        let transport = SessionActionTransport()
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        viewModel.isSending = true

        await viewModel.rewindToMessage(self.userMessage(entryID: "message-42"))

        #expect(await transport.rewoundMessages().isEmpty)
        #expect(await transport.historySessionKeys().isEmpty)
    }

    @Test func `rewind waits for current session outbox confirmation`() async throws {
        let directory = try makeSessionActionOutboxDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let databases = try OpenClawClientDatabases(directoryURL: directory)
        let store = databases.store(gatewayID: "gw-test")
        let scope = OpenClawChatOutboxScope(sessionKey: "main", agentID: nil)
        #expect(await store.updateLastActiveLeafEntryID("leaf-active", expectedEpoch: 0, for: scope))
        #expect(await store.enqueueCommand(sessionActionOutboxCommand(
            id: "rewind-pending",
            text: "wait before rewind")))
        let transport = SessionActionTransport(branches: self.branches())
        let viewModel = OpenClawChatViewModel(
            sessionKey: "main",
            transport: transport,
            outbox: store)
        viewModel.restoreOutboxMessages(session: viewModel.currentSessionSnapshot())
        #expect(await self.waitForOutboxRestore(viewModel))

        await viewModel.rewindToMessage(self.userMessage(entryID: "message-42"))

        #expect(viewModel.canPerformMessageSessionAction == false)
        #expect(await transport.rewoundMessages().isEmpty)
        await viewModel.confirmOutboxCommandsNow(in: [self.confirmingMessage(commandID: "rewind-pending")])
        #expect(viewModel.canPerformMessageSessionAction)

        await viewModel.rewindToMessage(self.userMessage(entryID: "message-42"))

        #expect(await transport.rewoundMessages().map { [$0.sessionKey, $0.entryID] } == [
            ["main", "message-42"],
        ])
    }

    @Test func `fork at message waits for current session outbox confirmation`() async throws {
        let directory = try makeSessionActionOutboxDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try OpenClawClientDatabases(directoryURL: directory).store(gatewayID: "gw-test")
        #expect(await store.enqueueCommand(sessionActionOutboxCommand(
            id: "fork-pending",
            text: "wait before fork")))
        let transport = SessionActionTransport()
        let viewModel = OpenClawChatViewModel(
            sessionKey: "main",
            transport: transport,
            outbox: store)
        viewModel.restoreOutboxMessages(session: viewModel.currentSessionSnapshot())
        #expect(await self.waitForOutboxRestore(viewModel))

        await viewModel.forkAtMessage(self.userMessage(entryID: "message-42"))

        #expect(viewModel.canPerformMessageSessionAction == false)
        #expect(await transport.forkedMessages().isEmpty)
        await viewModel.confirmOutboxCommandsNow(in: [self.confirmingMessage(commandID: "fork-pending")])
        #expect(viewModel.canPerformMessageSessionAction)

        await viewModel.forkAtMessage(self.userMessage(entryID: "message-42"))

        #expect(await transport.forkedMessages().map { [$0.sessionKey, $0.entryID] } == [
            ["main", "message-42"],
        ])
    }

    @Test func `rewind bumps branch epoch and parks a racing enqueue`() async throws {
        let directory = try makeSessionActionOutboxDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let databases = try OpenClawClientDatabases(directoryURL: directory)
        let store = databases.store(gatewayID: "gw-test")
        let siblingStore = databases.store(gatewayID: "gw-test")
        let scope = OpenClawChatOutboxScope(sessionKey: "main", agentID: nil)
        #expect(await store.updateLastActiveLeafEntryID("leaf-active", expectedEpoch: 0, for: scope))
        let rewindGate = SessionActionCompletionGate()
        let transport = SessionActionTransport(
            rewindGate: rewindGate,
            branches: self.branches(activeLeafEntryID: "leaf-new"))
        let viewModel = OpenClawChatViewModel(
            sessionKey: "main",
            transport: transport,
            outbox: store)
        viewModel.hasRestoredOutboxMessages = true

        let rewind = Task {
            await viewModel.rewindToMessage(self.userMessage(entryID: "message-42"))
        }
        guard await self.waitForForkStart(rewindGate) else {
            rewindGate.release()
            rewind.cancel()
            Issue.record("timed out waiting for rewind start signal")
            return
        }
        #expect(await siblingStore.enqueueCommand(sessionActionOutboxCommand(
            id: "racing-rewind",
            text: "belongs to the old transcript")))
        #expect(await siblingStore.claimNextCommand() == nil)

        rewindGate.release()
        await rewind.value

        let state = try #require(await store.branchState(for: scope))
        #expect(state.epoch == 1)
        #expect(state.lastActiveLeafEntryID == "leaf-new")
        #expect(state.switchPendingSince == nil)
        let racedCommand = try #require(await store.loadCommands().first)
        #expect(racedCommand.id == "racing-rewind")
        #expect(racedCommand.status == .failed)
        #expect(OpenClawChatSQLiteTranscriptCache.outboxDisplayError(racedCommand.lastError) ==
            "Session branch changed; review and retry this message.")
    }

    @Test func `rewind list failure clears lease and later reconcile delivers`() async throws {
        let directory = try makeSessionActionOutboxDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let databases = try OpenClawClientDatabases(directoryURL: directory)
        let store = databases.store(gatewayID: "gw-test")
        let siblingStore = databases.store(gatewayID: "gw-test")
        let scope = OpenClawChatOutboxScope(sessionKey: "main", agentID: nil)
        #expect(await store.updateLastActiveLeafEntryID("leaf-active", expectedEpoch: 0, for: scope))
        let transport = SessionActionTransport(
            branches: self.branches(),
            branchListFailureIndices: [0],
            sendSucceeds: true)
        let viewModel = OpenClawChatViewModel(
            sessionKey: "main",
            transport: transport,
            outbox: store)
        viewModel.hasRestoredOutboxMessages = true

        await viewModel.rewindToMessage(self.userMessage(entryID: "message-42"))

        #expect(await store.branchState(for: scope)?.switchPendingSince == nil)
        #expect(await store.branchState(for: scope)?.needsReconciliation == true)
        #expect(viewModel.reconciledOutboxBranchScopes.contains(scope) == false)
        #expect(await store.enqueueCommand(sessionActionOutboxCommand(
            id: "after-rewind-list-failure",
            text: "send after reconcile")))
        #expect(await siblingStore.claimNextCommand() == nil)
        viewModel.healthOK = true
        viewModel.readySessionMetadataGeneration = viewModel.sessionMetadataGeneration
        viewModel.flushOutboxIfNeeded()

        #expect(await self.waitForSend(transport))
        #expect(await transport.branchListSessionKeys().suffix(2) == ["main", "main"])
        #expect(await transport.sentSessionKeys() == ["main"])
        #expect(await store.loadCommands().map(\.status) == [.awaitingConfirmation])
    }

    @Test func `branch refresh populates state`() async {
        let branches = self.branches()
        let transport = SessionActionTransport(branches: branches)
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)

        await viewModel.refreshSessionBranches()

        #expect(viewModel.sessionBranches == branches)
        #expect(viewModel.isLoadingSessionBranches == false)
        #expect(await transport.branchListSessionKeys() == ["main"])
    }

    @Test func `opening branch menu refreshes conversation stale metadata once`() async {
        let staleBranches = self.branches()
        let freshBranches = self.branches(activeLeafEntryID: "leaf-new")
        let transport = SessionActionTransport(branches: freshBranches)
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        viewModel.sessionBranches = staleBranches

        await viewModel.refreshSessionBranchesForMenuPresentation()

        #expect(viewModel.sessionBranches == freshBranches)
        #expect(await transport.branchListSessionKeys() == ["main"])
    }

    @Test func `branch message count uses localized singular and plural forms`() {
        #expect(OpenClawChatComposer.branchMessageCount(1) == "1 message")
        #expect(OpenClawChatComposer.branchMessageCount(2) == "2 messages")
    }

    @Test func `branch refresh failure preserves cached branches`() async {
        let branches = self.branches()
        let transport = SessionActionTransport(branchListFailureIndices: [0])
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        viewModel.sessionBranches = branches

        await viewModel.refreshSessionBranches()

        #expect(viewModel.sessionBranches == branches)
        #expect(viewModel.isLoadingSessionBranches == false)
        #expect(await transport.branchListSessionKeys() == ["main"])
    }

    @Test func `read only branch refresh failure preserves replay eligibility`() async throws {
        let directory = try makeSessionActionOutboxDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try OpenClawClientDatabases(directoryURL: directory).store(gatewayID: "gw-test")
        let scope = OpenClawChatOutboxScope(sessionKey: "main", agentID: nil)
        let transport = SessionActionTransport(branchListFailureIndices: [0])
        let viewModel = OpenClawChatViewModel(
            sessionKey: "main",
            transport: transport,
            outbox: store)
        viewModel.reconciledOutboxBranchScopes.insert(scope)

        await viewModel.refreshSessionBranchesForMenuPresentation()

        #expect(viewModel.reconciledOutboxBranchScopes.contains(scope))
        #expect(await store.branchState(for: scope)?.switchPendingSince == nil)
    }

    @Test func `newer branch refresh supersedes an older response`() async {
        let firstGate = SessionActionCompletionGate()
        let oldBranches = self.branches()
        let newBranches = self.branches(activeLeafEntryID: "leaf-new")
        let transport = SessionActionTransport(
            branchListGates: [firstGate],
            branchListResponses: [oldBranches, newBranches])
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)

        let firstRefresh = Task { await viewModel.refreshSessionBranches() }
        guard await self.waitForForkStart(firstGate) else {
            firstGate.release()
            firstRefresh.cancel()
            Issue.record("timed out waiting for branch list start signal")
            return
        }
        await viewModel.refreshSessionBranches()

        #expect(viewModel.sessionBranches == newBranches)
        firstGate.release()
        await firstRefresh.value

        #expect(viewModel.sessionBranches == newBranches)
        #expect(viewModel.isLoadingSessionBranches == false)
        #expect(await transport.branchListSessionKeys() == ["main", "main"])
    }

    @Test func `branch switch refreshes history and branch state`() async {
        let branches = self.branches()
        let transport = SessionActionTransport(branches: branches)
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        viewModel.sessionBranches = branches

        await viewModel.switchToBranch("leaf-new")

        #expect(await transport.switchedBranches().map { [$0.sessionKey, $0.leafEntryID] } == [
            ["main", "leaf-new"],
        ])
        #expect(await transport.historySessionKeys() == ["main"])
        #expect(await transport.branchListSessionKeys() == ["main"])
        #expect(viewModel.sessionBranches == branches)
    }

    @Test(arguments: [false, true])
    func `branch change failure funnels through full session reload`(remoteEvent: Bool) async {
        let historyReloadGate = SessionActionCompletionGate()
        let branchesReloadGate = SessionActionCompletionGate()
        let remoteConfirmationGate = SessionActionCompletionGate()
        let staleBranches = self.branches()
        let freshBranches = self.branches(activeLeafEntryID: "leaf-new")
        let transport = SessionActionTransport(
            branchListGates: remoteEvent
                ? [remoteConfirmationGate, branchesReloadGate]
                : [branchesReloadGate],
            branches: freshBranches,
            historyGates: [2: historyReloadGate],
            historyFailureIndices: [0, 1])
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        viewModel.sessionBranches = staleBranches
        viewModel.messages = [self.userMessage(entryID: "pre-switch")]

        if remoteEvent {
            viewModel.handleTransportEvent(.sessionsChanged(.init(
                sessionKey: "main",
                reason: "branch-switch")))
            _ = await self.waitForForkStart(remoteConfirmationGate)
            remoteConfirmationGate.release()
        } else {
            await viewModel.switchToBranch("leaf-new")
        }

        let historyReloadStarted = await self.waitForForkStart(historyReloadGate)
        let branchesReloadStarted = await self.waitForForkStart(branchesReloadGate)
        #expect(historyReloadStarted)
        #expect(branchesReloadStarted)
        #expect(await transport.historySessionKeys() == ["main", "main", "main"])
        #expect(await transport.branchListSessionKeys() == (remoteEvent ? ["main", "main"] : ["main"]))
        #expect(viewModel.messages.isEmpty)
        #expect(viewModel.sessionBranches.isEmpty)
        #expect(viewModel.hasAppliedLiveHistory == false)
        #expect(viewModel.isLoading)

        historyReloadGate.release()
        branchesReloadGate.release()
        let reloaded = await self.waitForBranchReload(viewModel, branches: freshBranches)
        #expect(reloaded)
        #expect(viewModel.sessionBranches.first(where: \.active)?.leafEntryId == "leaf-new")
    }

    @Test func `branch switch does not dispatch while busy`() async {
        let branches = self.branches()
        let transport = SessionActionTransport(branches: branches)
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        viewModel.sessionBranches = branches
        viewModel.isSending = true

        await viewModel.switchToBranch("leaf-new")

        #expect(await transport.switchedBranches().isEmpty)
        #expect(await transport.historySessionKeys().isEmpty)
        #expect(await transport.branchListSessionKeys().isEmpty)
    }

    @Test func `branch switch does not overlap an in flight switch`() async {
        let gate = SessionActionCompletionGate()
        let branches = self.branches()
        let transport = SessionActionTransport(branchSwitchGate: gate, branches: branches)
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        viewModel.sessionBranches = branches

        let firstSwitch = Task { await viewModel.switchToBranch("leaf-new") }
        guard await self.waitForForkStart(gate) else {
            gate.release()
            firstSwitch.cancel()
            Issue.record("timed out waiting for branch switch start signal")
            return
        }
        await viewModel.switchToBranch("leaf-new")

        #expect(await transport.switchedBranches().count == 1)
        gate.release()
        await firstSwitch.value
    }

    @Test func `branch switch blocks sends and rewinds until refresh completes`() async {
        let gate = SessionActionCompletionGate()
        let branches = self.branches()
        let transport = SessionActionTransport(branchSwitchGate: gate, branches: branches)
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        viewModel.sessionBranches = branches
        viewModel.input = "new message"

        let branchSwitch = Task { await viewModel.switchToBranch("leaf-new") }
        guard await self.waitForForkStart(gate) else {
            gate.release()
            branchSwitch.cancel()
            Issue.record("timed out waiting for branch switch start signal")
            return
        }

        #expect(viewModel.hasBlockingRunActivity)
        #expect(viewModel.canSend == false)
        viewModel.send()
        await viewModel.rewindToMessage(self.userMessage(entryID: "message-42"))
        await viewModel.forkAtMessage(self.userMessage(entryID: "message-42"))
        for _ in 0..<10 {
            await Task.yield()
        }

        #expect(await transport.sentSessionKeys().isEmpty)
        #expect(await transport.rewoundMessages().isEmpty)
        #expect(await transport.forkedMessages().isEmpty)

        gate.release()
        await branchSwitch.value

        #expect(viewModel.hasBlockingRunActivity == false)
        #expect(viewModel.canSend)
    }

    @Test func `stale branch switch completion is ignored`() async {
        let gate = SessionActionCompletionGate()
        let branches = self.branches()
        let transport = SessionActionTransport(branchSwitchGate: gate, branches: branches)
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        viewModel.sessionBranches = branches

        let branchSwitch = Task { await viewModel.switchToBranch("leaf-new") }
        guard await self.waitForForkStart(gate) else {
            gate.release()
            branchSwitch.cancel()
            Issue.record("timed out waiting for branch switch start signal")
            return
        }
        viewModel.switchSession(to: "other")
        gate.release()
        await branchSwitch.value

        #expect(viewModel.sessionKey == "other")
        #expect(await transport.switchedBranches().map { [$0.sessionKey, $0.leafEntryID] } == [
            ["main", "leaf-new"],
        ])
        #expect(await transport.historySessionKeys().contains("main") == false)
        #expect(await transport.branchListSessionKeys().contains("main") == false)
    }

    @Test func `navigation releases branch switch gate before stale completion`() async {
        let gate = SessionActionCompletionGate()
        let branches = self.branches()
        let transport = SessionActionTransport(branchSwitchGate: gate, branches: branches)
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        viewModel.sessionBranches = branches

        let branchSwitch = Task { await viewModel.switchToBranch("leaf-new") }
        guard await self.waitForForkStart(gate) else {
            gate.release()
            branchSwitch.cancel()
            Issue.record("timed out waiting for branch switch start signal")
            return
        }

        viewModel.switchSession(to: "other")
        viewModel.input = "new session message"
        #expect(viewModel.hasBlockingRunActivity == false)
        #expect(viewModel.canSend)

        gate.release()
        await branchSwitch.value

        #expect(viewModel.sessionKey == "other")
        #expect(viewModel.hasBlockingRunActivity == false)
        #expect(viewModel.canSend)
    }

    @Test func `fork at message switches and seeds editor`() async {
        let transport = SessionActionTransport(
            forkAtMessageSessionKey: "agent:main:forked",
            forkAtMessageEditorText: "continue here")
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)

        await viewModel.forkAtMessage(self.userMessage(entryID: "message-42"))

        #expect(viewModel.sessionKey == "agent:main:forked")
        #expect(viewModel.input == "continue here")
        #expect(await transport.forkedMessages().map { [$0.sessionKey, $0.entryID] } == [["main", "message-42"]])
    }

    @Test func `fork at message completion does not override newer navigation`() async {
        let forkGate = SessionActionCompletionGate()
        let transport = SessionActionTransport(
            forkAtMessageGate: forkGate,
            forkAtMessageSessionKey: "agent:main:forked")
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)

        let fork = Task { await viewModel.forkAtMessage(self.userMessage(entryID: "message-42")) }
        guard await self.waitForForkStart(forkGate) else {
            forkGate.release()
            fork.cancel()
            Issue.record("timed out waiting for fork start signal")
            return
        }
        viewModel.switchSession(to: "other")
        forkGate.release()
        await fork.value

        #expect(viewModel.sessionKey == "other")
        #expect(viewModel.input.isEmpty)
        #expect(await transport.forkedMessages().map { [$0.sessionKey, $0.entryID] } == [["main", "message-42"]])
    }

    @Test func `remote rewind refreshes current transcript only`() async {
        let transport = SessionActionTransport()
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)

        viewModel.handleTransportEvent(.sessionsChanged(.init(sessionKey: "other", reason: "rewind")))
        viewModel.handleTransportEvent(.sessionsChanged(.init(sessionKey: "main", reason: "rewind")))

        let refreshed = await self.waitForHistoryRequest(transport)
        #expect(refreshed)
        #expect(await transport.historySessionKeys() == ["main"])
    }

    @Test func `remote branch switch refreshes current transcript and branches only`() async {
        let transport = SessionActionTransport(branches: self.branches())
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        viewModel.setReplyTarget(messageID: UUID(), text: "old branch", senderLabel: "User")
        viewModel.input = "new message"

        viewModel.handleTransportEvent(.sessionsChanged(.init(sessionKey: "other", reason: "branch-switch")))
        #expect(viewModel.replyTarget != nil)
        #expect(viewModel.canSend)
        viewModel.handleTransportEvent(.sessionsChanged(.init(sessionKey: "main", reason: "branch-switch")))
        #expect(viewModel.hasBlockingRunActivity)
        #expect(viewModel.canSend == false)

        let refreshed = await self.waitForBranchListRequest(transport)
        #expect(refreshed)
        let unlocked = await self.waitForBranchSwitchActivityToClear(viewModel)
        #expect(unlocked)
        #expect(viewModel.replyTarget == nil)
        #expect(await transport.historySessionKeys() == ["main"])
        #expect(await transport.branchListSessionKeys() == ["main"])
    }

    @Test func `fork does not mutate gateway while session switching is blocked`() async {
        let transport = SessionActionTransport()
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        viewModel.attachments = [OpenClawPendingAttachment(
            url: nil,
            data: Data([1]),
            fileName: "draft.png",
            mimeType: "image/png",
            preview: nil)]

        await viewModel.forkSession(key: "main")

        let forkedKeys = await transport.forkedParentKeys()
        #expect(forkedKeys.isEmpty)
        #expect(viewModel.sessionKey == "main")
        #expect(viewModel.errorText == String(
            localized: "Remove attachments or wait for delivery to resolve before starting a new chat."))
    }

    @Test func `fork completion does not override newer navigation`() async {
        let forkGate = SessionActionCompletionGate()
        let transport = SessionActionTransport(forkGate: forkGate)
        let viewModel = OpenClawChatViewModel(sessionKey: "main", transport: transport)

        let fork = Task { await viewModel.forkSession(key: "main") }
        guard await self.waitForForkStart(forkGate) else {
            forkGate.release()
            fork.cancel()
            Issue.record("timed out waiting for fork start signal")
            return
        }
        viewModel.switchSession(to: "other")
        forkGate.release()
        await fork.value

        #expect(viewModel.sessionKey == "other")
        #expect(await transport.forkedParentKeys() == ["main"])
    }

    private func waitForForkStart(
        _ gate: SessionActionCompletionGate,
        timeout: Duration = .seconds(15)) async -> Bool
    {
        // The stream controls ordering; this deadline only bounds a broken fake or call path.
        await withTaskGroup(of: Bool.self) { group in
            group.addTask { await gate.waitUntilStarted() }
            group.addTask {
                try? await Task.sleep(for: timeout)
                return false
            }
            let started = await group.next() ?? false
            group.cancelAll()
            return started
        }
    }

    private func waitForHistoryRequest(
        _ transport: SessionActionTransport,
        timeout: Duration = .seconds(15)) async -> Bool
    {
        let clock = ContinuousClock()
        let deadline = clock.now + timeout
        while clock.now < deadline {
            if await transport.historySessionKeys().isEmpty == false {
                return true
            }
            await Task.yield()
        }
        return false
    }

    private func waitForBranchListRequest(
        _ transport: SessionActionTransport,
        timeout: Duration = .seconds(15)) async -> Bool
    {
        let clock = ContinuousClock()
        let deadline = clock.now + timeout
        while clock.now < deadline {
            if await transport.branchListSessionKeys().isEmpty == false {
                return true
            }
            await Task.yield()
        }
        return false
    }

    private func waitForBranchSwitchActivityToClear(
        _ viewModel: OpenClawChatViewModel,
        timeout: Duration = .seconds(15)) async -> Bool
    {
        let clock = ContinuousClock()
        let deadline = clock.now + timeout
        while clock.now < deadline {
            if viewModel.hasBlockingRunActivity == false {
                return true
            }
            await Task.yield()
        }
        return false
    }

    private func waitForOutboxRestore(
        _ viewModel: OpenClawChatViewModel,
        timeout: Duration = .seconds(15)) async -> Bool
    {
        let clock = ContinuousClock()
        let deadline = clock.now + timeout
        while clock.now < deadline {
            if viewModel.hasRestoredOutboxMessages,
               viewModel.hasPendingOutboxCommandsForCurrentSession
            {
                return true
            }
            await Task.yield()
        }
        return false
    }

    private func waitForSend(
        _ transport: SessionActionTransport,
        timeout: Duration = .seconds(15)) async -> Bool
    {
        let clock = ContinuousClock()
        let deadline = clock.now + timeout
        while clock.now < deadline {
            if await transport.sentSessionKeys().isEmpty == false {
                return true
            }
            await Task.yield()
        }
        return false
    }

    private func waitForBranchReload(
        _ viewModel: OpenClawChatViewModel,
        branches: [OpenClawChatSessionBranch],
        timeout: Duration = .seconds(15)) async -> Bool
    {
        let clock = ContinuousClock()
        let deadline = clock.now + timeout
        while clock.now < deadline {
            if viewModel.sessionBranches == branches, !viewModel.isLoading {
                return true
            }
            await Task.yield()
        }
        return false
    }

    private func userMessage(entryID: String) -> OpenClawChatMessage {
        OpenClawChatMessage(
            role: "user",
            content: [],
            timestamp: nil,
            transcriptMessageID: entryID)
    }

    private func confirmingMessage(commandID: String) -> OpenClawChatMessage {
        OpenClawChatMessage(
            role: "user",
            content: [],
            timestamp: nil,
            idempotencyKey: "\(commandID):user")
    }

    private func branches(activeLeafEntryID: String = "leaf-active") -> [OpenClawChatSessionBranch] {
        [
            OpenClawChatSessionBranch(
                leafEntryId: "leaf-active",
                headline: "Current path",
                messageCount: 4,
                updatedAt: "2026-07-19T12:00:00Z",
                active: activeLeafEntryID == "leaf-active"),
            OpenClawChatSessionBranch(
                leafEntryId: "leaf-new",
                headline: "Alternate path",
                messageCount: 2,
                updatedAt: nil,
                active: activeLeafEntryID == "leaf-new"),
        ]
    }

    private func entry(key: String) -> OpenClawChatSessionEntry {
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
            contextTokens: nil)
    }
}
