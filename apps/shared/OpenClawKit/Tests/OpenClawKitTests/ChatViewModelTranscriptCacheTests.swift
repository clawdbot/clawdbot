import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

private func liveHistoryMessage(role: String, text: String, timestamp: Double) -> AnyCodable {
    AnyCodable([
        "role": role,
        "content": [["type": "text", "text": text]],
        "timestamp": timestamp,
    ] as [String: Any])
}

private func visibleTexts(_ vm: OpenClawChatViewModel) async -> [String] {
    await MainActor.run { vm.messages.map { $0.content.compactMap(\.text).joined() } }
}

private func historyPayload(
    sessionKey: String,
    sessionID: String = "sess-live",
    messages: [AnyCodable] = []) -> OpenClawChatHistoryPayload
{
    OpenClawChatHistoryPayload(
        sessionKey: sessionKey,
        sessionId: sessionID,
        messages: messages,
        thinkingLevel: "off")
}

/// In-memory per-instance stub matching the cache seam.
private actor TestTranscriptCache: OpenClawChatTranscriptCache {
    private var transcripts: [String: [OpenClawChatMessage]]
    private var sessions: [OpenClawChatSessionEntry]
    private let loadSessionsHook: (@Sendable () async -> Void)?
    private(set) var storedTranscripts: [[OpenClawChatMessage]] = []

    init(
        transcripts: [String: [OpenClawChatMessage]] = [:],
        sessions: [OpenClawChatSessionEntry] = [],
        loadSessionsHook: (@Sendable () async -> Void)? = nil)
    {
        self.transcripts = transcripts
        self.sessions = sessions
        self.loadSessionsHook = loadSessionsHook
    }

    func loadSessions() async -> [OpenClawChatSessionEntry] {
        await self.loadSessionsHook?()
        return self.sessions
    }

    func loadSessions(agentID _: String?) async -> [OpenClawChatSessionEntry] {
        await self.loadSessions()
    }

    func loadTranscript(sessionKey: String) async -> [OpenClawChatMessage] {
        self.transcripts[sessionKey] ?? []
    }

    func storeSessions(_ sessions: [OpenClawChatSessionEntry]) async {
        self.sessions = sessions
    }

    func storeSessions(_ sessions: [OpenClawChatSessionEntry], agentID _: String?) async {
        await self.storeSessions(sessions)
    }

    func storeCanonicalTranscript(
        sessionKey: String,
        agentID _: String?,
        messages: [OpenClawChatMessage],
        canonicalMessageIdempotencyKeys _: Set<String>) async
    {
        self.transcripts[sessionKey] = messages
        self.storedTranscripts.append(messages)
    }
}

/// Old conformers compile through the protocol defaults but cannot partition
/// selected-agent rosters, so scoped access must never reach this storage.
private actor LegacyTranscriptCache: OpenClawChatTranscriptCache {
    private var sessions: [OpenClawChatSessionEntry]

    init(sessions: [OpenClawChatSessionEntry] = []) {
        self.sessions = sessions
    }

    func loadSessions() async -> [OpenClawChatSessionEntry] {
        self.sessions
    }

    func loadTranscript(sessionKey _: String) async -> [OpenClawChatMessage] {
        []
    }

    func storeSessions(_ sessions: [OpenClawChatSessionEntry]) async {
        self.sessions = sessions
    }

    func storeCanonicalTranscript(
        sessionKey _: String,
        agentID _: String?,
        messages _: [OpenClawChatMessage],
        canonicalMessageIdempotencyKeys _: Set<String>) async
    {}
}

/// Minimal FIFO transport whose history responses can be gated during cold open.
private final class GatedHistoryChatTransport: @unchecked Sendable, OpenClawChatTransport {
    private let historyResult: @Sendable (String, Int) async throws -> OpenClawChatHistoryPayload
    private let historyRequestLock = NSLock()
    private var historyRequestCount = 0
    private let stream: AsyncStream<OpenClawChatTransportEvent>
    private let continuation: AsyncStream<OpenClawChatTransportEvent>.Continuation

    init(historyResult: @escaping @Sendable (String, Int) async throws -> OpenClawChatHistoryPayload) {
        self.historyResult = historyResult
        (self.stream, self.continuation) = AsyncStream.makeStream()
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        let requestNumber = self.historyRequestLock.withLock {
            self.historyRequestCount += 1
            return self.historyRequestCount
        }
        return try await self.historyResult(sessionKey, requestNumber)
    }

    func observedHistoryRequestCount() -> Int {
        self.historyRequestLock.withLock { self.historyRequestCount }
    }

    func sendMessage(
        sessionKey _: String,
        message _: String,
        thinking _: String,
        idempotencyKey: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        OpenClawChatSendResponse(runId: idempotencyKey, status: "accepted")
    }

    func listSessions(
        limit _: Int?,
        search _: String?,
        archived _: Bool) async throws -> OpenClawChatSessionsListResponse
    {
        OpenClawChatSessionsListResponse(ts: nil, path: nil, count: 0, defaults: nil, sessions: [])
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        self.stream
    }
}

private struct TransportOfflineError: Error {}

@MainActor
private func makeViewModel(
    sessionKey: String = "main",
    transport: GatedHistoryChatTransport,
    activeAgentID: String? = nil,
    cache: any OpenClawChatTranscriptCache,
    load: Bool = true) -> OpenClawChatViewModel
{
    let vm = OpenClawChatViewModel(
        sessionKey: sessionKey,
        transport: transport,
        activeAgentId: activeAgentID,
        transcriptCache: cache)
    if load { vm.load() }
    return vm
}

struct ChatViewModelTranscriptCacheTests {
    @Test func `cold open paints cached transcript then live history replaces it`() async throws {
        let cache = TestTranscriptCache(
            transcripts: [
                "main": [
                    cacheMessage(role: "user", text: "cached question", timestamp: 1000),
                    cacheMessage(role: "assistant", text: "cached answer", timestamp: 2000),
                ],
            ])
        let (historyGate, releaseHistory) = AsyncStream<Void>.makeStream()
        let transport = GatedHistoryChatTransport { sessionKey, _ in
            var iterator = historyGate.makeAsyncIterator()
            _ = await iterator.next()
            return historyPayload(sessionKey: sessionKey, messages: [
                liveHistoryMessage(role: "user", text: "cached question", timestamp: 1000),
                liveHistoryMessage(role: "assistant", text: "live answer", timestamp: 2000),
                liveHistoryMessage(role: "user", text: "newer turn", timestamp: 3000),
            ])
        }
        let vm = await makeViewModel(transport: transport, cache: cache)

        // Cache pre-paint lands while live history is still gated.
        try await waitUntil("cached transcript painted") {
            await MainActor.run { vm.isShowingCachedTranscript && vm.messages.count == 2 }
        }
        #expect(await visibleTexts(vm) == ["cached question", "cached answer"])

        releaseHistory.yield(())

        // Live history replaces the cached rows wholesale and clears the marker.
        try await waitUntil("live history applied") {
            await MainActor.run { vm.sessionId == "sess-live" }
        }
        #expect(await visibleTexts(vm) == ["cached question", "live answer", "newer turn"])
        #expect(await MainActor.run { !vm.isShowingCachedTranscript })
    }

    @Test func `offline cold open keeps cached transcript browsable`() async throws {
        let cache = TestTranscriptCache(
            transcripts: [
                "main": [cacheMessage(role: "assistant", text: "offline answer", timestamp: 1000)],
            ])
        let transport = GatedHistoryChatTransport { _, _ in
            throw TransportOfflineError()
        }
        let vm = await makeViewModel(transport: transport, cache: cache)

        try await waitUntil("cached transcript painted") {
            await MainActor.run { vm.isShowingCachedTranscript && !vm.messages.isEmpty }
        }
        try await waitUntil("bootstrap finished") {
            await MainActor.run { !vm.isLoading }
        }
        // The failed live request must not clear the cached transcript.
        #expect(await visibleTexts(vm) == ["offline answer"])
        #expect(await MainActor.run { vm.isShowingCachedTranscript })
    }

    @Test func `live history is written through to cache`() async throws {
        let cache = TestTranscriptCache()
        let transport = GatedHistoryChatTransport { sessionKey, _ in
            historyPayload(
                sessionKey: sessionKey,
                messages: [liveHistoryMessage(role: "assistant", text: "hello", timestamp: 1000)])
        }
        let vm = await makeViewModel(transport: transport, cache: cache)

        try await waitUntil("write-through stored transcript") {
            await !cache.storedTranscripts.isEmpty
        }
        let stored = await cache.loadTranscript(sessionKey: "main")
        #expect(stored.map { $0.content.compactMap(\.text).joined() } == ["hello"])
        _ = vm
    }

    @Test func `optimistic echo is not written through as canonical history`() async throws {
        let cache = TestTranscriptCache()
        let transport = GatedHistoryChatTransport { sessionKey, requestNumber in
            historyPayload(
                sessionKey: sessionKey,
                messages: requestNumber == 1
                    ? [liveHistoryMessage(role: "assistant", text: "canonical answer", timestamp: 1000)]
                    : [])
        }
        let vm = await makeViewModel(transport: transport, cache: cache)
        try await waitUntil("bootstrap finished") {
            await MainActor.run { vm.sessionId == "sess-live" && !vm.isLoading }
        }
        await MainActor.run {
            vm.input = "optimistic only"
            vm.send()
        }
        try await waitUntil("post-send history refreshed") {
            transport.observedHistoryRequestCount() >= 2
        }

        #expect(await visibleTexts(vm) == ["canonical answer", "optimistic only"])
        #expect(await cache.storedTranscripts.count == 1)
        #expect(await cache.storedTranscripts.last?.count == 1)
        #expect(
            await cache.loadTranscript(sessionKey: "main")
                .flatMap { $0.content.compactMap(\.text) } == ["canonical answer"])
    }

    @Test func `stale cached sessions never overwrite live empty session list`() async throws {
        // A live empty sessions.list response stays authoritative if a delayed cache read resolves afterwards.
        var releaseSessions: AsyncStream<Void>.Continuation!
        let sessionsGate = AsyncStream<Void> { releaseSessions = $0 }
        let release = try #require(releaseSessions)
        let cache = TestTranscriptCache(
            sessions: [cacheSessionEntry(key: "stale-session", updatedAt: 1000)],
            loadSessionsHook: {
                var iterator = sessionsGate.makeAsyncIterator()
                _ = await iterator.next()
            })
        let transport = GatedHistoryChatTransport { sessionKey, _ in
            historyPayload(sessionKey: sessionKey)
        }
        let vm = await makeViewModel(transport: transport, cache: cache)
        // Bootstrap completes with a live empty session list while the cache
        // read is still gated.
        try await waitUntil("bootstrap finished") {
            await MainActor.run { vm.sessionId == "sess-live" && !vm.isLoading }
        }
        release.yield(())
        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(await MainActor.run { vm.sessions.isEmpty })
    }

    @Test func `prior agent cache cannot repaint global digest after owner switch`() async throws {
        var releaseSessions: AsyncStream<Void>.Continuation!
        let sessionsGate = AsyncStream<Void> { releaseSessions = $0 }
        let release = try #require(releaseSessions)
        var loadStarted: AsyncStream<Void>.Continuation!
        let started = AsyncStream<Void> { loadStarted = $0 }
        let startedSignal = try #require(loadStarted)
        var startedIterator = started.makeAsyncIterator()
        var global = cacheSessionEntry(key: "global", updatedAt: 1000)
        global.observerDigest = OpenClawChatSessionObserverDigest(
            agentId: "main",
            runId: "run-main",
            revision: 3,
            updatedAt: 1000,
            headline: "Main owner",
            health: "on-track")
        let cache = TestTranscriptCache(
            sessions: [global],
            loadSessionsHook: {
                startedSignal.yield(())
                var iterator = sessionsGate.makeAsyncIterator()
                _ = await iterator.next()
            })
        let transport = GatedHistoryChatTransport { sessionKey, _ in
            historyPayload(sessionKey: sessionKey, sessionID: "unused-live-session")
        }
        let vm = await makeViewModel(
            sessionKey: "agent:main:work",
            transport: transport,
            activeAgentID: "main",
            cache: cache,
            load: false)
        let snapshot = await MainActor.run { vm.currentSessionSnapshot() }
        await MainActor.run { vm.paintFromCacheIfNeeded(session: snapshot) }
        _ = await startedIterator.next()

        await MainActor.run { vm.syncActiveAgentId("work") }
        release.yield(())
        try await Task.sleep(nanoseconds: 100_000_000)

        #expect(await MainActor.run { vm.sessions.isEmpty })
    }

    @Test func `legacy cache cannot paint an ownerless roster for either selected agent`() async throws {
        var global = cacheSessionEntry(key: "global", updatedAt: 1000)
        global.observerDigest = OpenClawChatSessionObserverDigest(
            runId: "run-legacy",
            revision: 3,
            updatedAt: 1000,
            headline: "Ambiguous legacy owner",
            health: "on-track")
        let cache = LegacyTranscriptCache(sessions: [global])
        let transport = GatedHistoryChatTransport { sessionKey, _ in
            historyPayload(sessionKey: sessionKey, sessionID: "unused-live-session")
        }
        let vm = await makeViewModel(
            sessionKey: "agent:work:main",
            transport: transport,
            activeAgentID: "work",
            cache: cache,
            load: false)
        let snapshot = await MainActor.run { vm.currentSessionSnapshot() }

        await MainActor.run { vm.paintFromCacheIfNeeded(session: snapshot) }
        try await Task.sleep(nanoseconds: 100_000_000)

        await MainActor.run { vm.syncActiveAgentId("gadget") }
        let switchedSnapshot = await MainActor.run { vm.currentSessionSnapshot() }
        await MainActor.run { vm.paintFromCacheIfNeeded(session: switchedSnapshot) }
        try await Task.sleep(nanoseconds: 100_000_000)

        #expect(await MainActor.run { vm.sessions.isEmpty })
    }

    @Test func `legacy cache rejects scoped roster writes`() async {
        let original = cacheSessionEntry(key: "agent-a", updatedAt: 1000)
        let cache = LegacyTranscriptCache(sessions: [original])

        await cache.storeSessions(
            [cacheSessionEntry(key: "agent-b", updatedAt: 2000)],
            agentID: "agent-b")

        #expect(await cache.loadSessions().map(\.key) == ["agent-a"])
        #expect(await cache.loadSessions(agentID: "agent-a").isEmpty)
        #expect(await cache.loadSessions(agentID: "agent-b").isEmpty)
    }

    @Test func `cached session prepaint stays within the selected agent`() async throws {
        var matchingBare = cacheSessionEntry(key: "shared-tool", updatedAt: 2000)
        matchingBare.agentId = "main"
        var foreignBare = cacheSessionEntry(key: "foreign-tool", updatedAt: 1750)
        foreignBare.agentId = "gadget"
        var foreignGlobal = cacheSessionEntry(key: "global", updatedAt: 1500)
        foreignGlobal.agentId = "gadget"
        let cache = TestTranscriptCache(sessions: [
            cacheSessionEntry(key: "agent:main:owned", updatedAt: 3000),
            cacheSessionEntry(key: "agent:gadget:foreign", updatedAt: 2500),
            matchingBare,
            foreignBare,
            foreignGlobal,
            cacheSessionEntry(key: "legacy-ownerless", updatedAt: 1000),
        ])
        let transport = GatedHistoryChatTransport { sessionKey, _ in
            historyPayload(sessionKey: sessionKey, sessionID: "unused-live-session")
        }
        let vm = await makeViewModel(
            sessionKey: "agent:main:main",
            transport: transport,
            activeAgentID: "main",
            cache: cache,
            load: false)
        let snapshot = await MainActor.run { vm.currentSessionSnapshot() }

        await MainActor.run { vm.paintFromCacheIfNeeded(session: snapshot) }
        try await waitUntil("cached sessions painted") {
            await MainActor.run { !vm.sessions.isEmpty }
        }

        #expect(await MainActor.run { vm.sessions.map(\.key) } == [
            "agent:main:owned",
            "shared-tool",
            "legacy-ownerless",
        ])
    }

    @Test func `session cache strips active markers and preserves terminal recap`() {
        var active = cacheSessionEntry(key: "active", updatedAt: 2000)
        active.status = "running"
        active.hasActiveRun = true
        active.activeRunIds = ["run-active"]
        active.hasActiveSubagentRun = true
        active.startedAt = 1000
        active.endedAt = 2000
        active.runtimeMs = 1000
        active.outputTokens = 42

        let projected = OpenClawChatViewModel.durableSessionCacheProjection(active)
        #expect(projected.status == nil)
        #expect(projected.hasActiveRun == nil)
        #expect(projected.activeRunIds == nil)
        #expect(projected.hasActiveSubagentRun == nil)
        #expect(projected.startedAt == nil)
        #expect(projected.endedAt == 2000)
        #expect(projected.runtimeMs == 1000)
        #expect(projected.outputTokens == 42)

        var terminal = active
        terminal.status = "done"
        terminal.hasActiveRun = false
        terminal.activeRunIds = []
        terminal.hasActiveSubagentRun = false
        let terminalProjection = OpenClawChatViewModel.durableSessionCacheProjection(terminal)
        #expect(terminalProjection.status == "done")
        #expect(terminalProjection.startedAt == 1000)
    }

    @Test func `empty live history wins over cached transcript`() async throws {
        // Whichever order the cache pre-paint and the live (empty) history
        // land in, live history is authoritative and the cached rows must go.
        let cache = TestTranscriptCache(
            transcripts: [
                "main": [cacheMessage(role: "assistant", text: "stale cached", timestamp: 500)],
            ])
        let transport = GatedHistoryChatTransport { sessionKey, _ in
            historyPayload(sessionKey: sessionKey)
        }
        let vm = await makeViewModel(transport: transport, cache: cache)
        try await waitUntil("live history applied") {
            await MainActor.run { vm.sessionId == "sess-live" && !vm.isLoading }
        }
        // Give any straggling cache paint a chance to (incorrectly) land.
        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(await MainActor.run { vm.messages.isEmpty })
        #expect(await MainActor.run { !vm.isShowingCachedTranscript })
    }
}
