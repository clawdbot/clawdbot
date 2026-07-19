import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

private actor SessionActionTransportState {
    var forkedParentKeys: [String] = []
    var rewoundMessages: [(sessionKey: String, entryID: String)] = []
    var forkedMessages: [(sessionKey: String, entryID: String)] = []
    var historySessionKeys: [String] = []
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

    func recordHistory(_ sessionKey: String) {
        self.historySessionKeys.append(sessionKey)
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

/// Signals the exact suspension point before fork completion, then holds it so
/// navigation can advance deterministically before the stale result resumes.
private struct SessionActionForkGate: Sendable {
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
    private let forkGate: SessionActionForkGate?
    private let forkAtMessageGate: SessionActionForkGate?
    private let rewindEditorText: String?
    private let forkAtMessageSessionKey: String
    private let forkAtMessageEditorText: String?

    init(
        forkGate: SessionActionForkGate? = nil,
        forkAtMessageGate: SessionActionForkGate? = nil,
        rewindEditorText: String? = "rewound draft",
        forkAtMessageSessionKey: String = "forked-at-message",
        forkAtMessageEditorText: String? = "forked draft")
    {
        self.forkGate = forkGate
        self.forkAtMessageGate = forkAtMessageGate
        self.rewindEditorText = rewindEditorText
        self.forkAtMessageSessionKey = forkAtMessageSessionKey
        self.forkAtMessageEditorText = forkAtMessageEditorText
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        await self.state.recordHistory(sessionKey)
        return OpenClawChatHistoryPayload(
            sessionKey: sessionKey,
            sessionId: "session-\(sessionKey)",
            messages: [],
            thinkingLevel: "off")
    }

    func sendMessage(
        sessionKey _: String,
        message _: String,
        thinking _: String,
        idempotencyKey _: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
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
        let forkGate = SessionActionForkGate()
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
        let forkGate = SessionActionForkGate()
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
        _ gate: SessionActionForkGate,
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

    private func userMessage(entryID: String) -> OpenClawChatMessage {
        OpenClawChatMessage(
            role: "user",
            content: [],
            timestamp: nil,
            transcriptMessageID: entryID)
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
