import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

private func cachedMessage(role: String, text: String, timestamp: Double) -> OpenClawChatMessage {
    OpenClawChatMessage(
        role: role,
        content: [
            OpenClawChatMessageContent(
                type: "text",
                text: text,
                mimeType: nil,
                fileName: nil,
                content: nil),
        ],
        timestamp: timestamp)
}

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

private func cachedSessionEntry(key: String, updatedAt: Double) -> OpenClawChatSessionEntry {
    OpenClawChatSessionEntry(
        key: key,
        kind: nil,
        displayName: nil,
        surface: nil,
        subject: nil,
        room: nil,
        space: nil,
        updatedAt: updatedAt,
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

/// In-memory per-instance stub matching the cache seam.
private actor TestTranscriptCache: OpenClawChatTranscriptCache {
    private var transcripts: [String: [OpenClawChatMessage]]
    private var sessions: [OpenClawChatSessionEntry]
    private let loadSessionsHook: (@Sendable () async -> Void)?
    private(set) var storedTranscriptSessionKeys: [String] = []
    private(set) var storedTranscripts: [[OpenClawChatMessage]] = []
    private(set) var storedSessionsCallCount = 0

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

    func loadTranscript(sessionKey: String) async -> [OpenClawChatMessage] {
        self.transcripts[sessionKey] ?? []
    }

    func storeSessions(_ sessions: [OpenClawChatSessionEntry]) async {
        self.sessions = sessions
        self.storedSessionsCallCount += 1
    }

    func storeCanonicalTranscript(
        sessionKey: String,
        agentID _: String?,
        messages: [OpenClawChatMessage],
        canonicalMessageIdempotencyKeys _: Set<String>) async
    {
        self.transcripts[sessionKey] = messages
        self.storedTranscriptSessionKeys.append(sessionKey)
        self.storedTranscripts.append(messages)
    }
}

/// Minimal FIFO scripted transport; history responses can be gated to model a
/// slow or unreachable gateway during cold open.
private final class GatedHistoryChatTransport: @unchecked Sendable, OpenClawChatTransport {
    private let historyGate: AsyncStream<Void>.Continuation?
    private let historyGateStream: AsyncStream<Void>?
    private let historyResult: @Sendable (String, Int) throws -> OpenClawChatHistoryPayload
    private let historyRequestLock = NSLock()
    private var historyRequestCount = 0
    private let stream: AsyncStream<OpenClawChatTransportEvent>
    private let continuation: AsyncStream<OpenClawChatTransportEvent>.Continuation

    init(
        gated: Bool,
        historyResult: @escaping @Sendable (String, Int) throws -> OpenClawChatHistoryPayload)
    {
        self.historyResult = historyResult
        if gated {
            var cont: AsyncStream<Void>.Continuation!
            self.historyGateStream = AsyncStream { c in cont = c }
            self.historyGate = cont
        } else {
            self.historyGateStream = nil
            self.historyGate = nil
        }
        var eventCont: AsyncStream<OpenClawChatTransportEvent>.Continuation!
        self.stream = AsyncStream { c in eventCont = c }
        self.continuation = eventCont
    }

    func releaseHistory() {
        self.historyGate?.yield(())
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        if let historyGateStream {
            var iterator = historyGateStream.makeAsyncIterator()
            _ = await iterator.next()
        }
        let requestNumber = self.historyRequestLock.withLock {
            self.historyRequestCount += 1
            return self.historyRequestCount
        }
        return try self.historyResult(sessionKey, requestNumber)
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

struct ChatViewModelTranscriptCacheTests {
    @Test func `cold open paints cached transcript then live history replaces it`() async throws {
        let cache = TestTranscriptCache(
            transcripts: [
                "main": [
                    cachedMessage(role: "user", text: "cached question", timestamp: 1000),
                    cachedMessage(role: "assistant", text: "cached answer", timestamp: 2000),
                ],
            ])
        let transport = GatedHistoryChatTransport(gated: true) { sessionKey, _ in
            OpenClawChatHistoryPayload(
                sessionKey: sessionKey,
                sessionId: "sess-live",
                messages: [
                    liveHistoryMessage(role: "user", text: "cached question", timestamp: 1000),
                    liveHistoryMessage(role: "assistant", text: "live answer", timestamp: 2000),
                    liveHistoryMessage(role: "user", text: "newer turn", timestamp: 3000),
                ],
                thinkingLevel: "off")
        }
        let vm = await MainActor.run {
            OpenClawChatViewModel(sessionKey: "main", transport: transport, transcriptCache: cache)
        }

        await MainActor.run { vm.load() }

        // Cache pre-paint lands while live history is still gated.
        try await waitUntil("cached transcript painted") {
            await MainActor.run { vm.isShowingCachedTranscript && vm.messages.count == 2 }
        }
        #expect(await visibleTexts(vm) == ["cached question", "cached answer"])

        transport.releaseHistory()

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
                "main": [cachedMessage(role: "assistant", text: "offline answer", timestamp: 1000)],
            ])
        let transport = GatedHistoryChatTransport(gated: false) { _, _ in
            throw TransportOfflineError()
        }
        let vm = await MainActor.run {
            OpenClawChatViewModel(sessionKey: "main", transport: transport, transcriptCache: cache)
        }

        await MainActor.run { vm.load() }

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
        let transport = GatedHistoryChatTransport(gated: false) { sessionKey, _ in
            OpenClawChatHistoryPayload(
                sessionKey: sessionKey,
                sessionId: "sess-live",
                messages: [liveHistoryMessage(role: "assistant", text: "hello", timestamp: 1000)],
                thinkingLevel: "off")
        }
        let vm = await MainActor.run {
            OpenClawChatViewModel(sessionKey: "main", transport: transport, transcriptCache: cache)
        }

        await MainActor.run { vm.load() }

        try await waitUntil("write-through stored transcript") {
            await cache.storedTranscriptSessionKeys.contains("main")
        }
        let stored = await cache.loadTranscript(sessionKey: "main")
        #expect(stored.map { $0.content.compactMap(\.text).joined() } == ["hello"])
        _ = vm
    }

    @Test func `optimistic echo is not written through as canonical history`() async throws {
        let cache = TestTranscriptCache()
        let transport = GatedHistoryChatTransport(gated: false) { sessionKey, requestNumber in
            OpenClawChatHistoryPayload(
                sessionKey: sessionKey,
                sessionId: "sess-live",
                messages: requestNumber == 1
                    ? [liveHistoryMessage(role: "assistant", text: "canonical answer", timestamp: 1000)]
                    : [],
                thinkingLevel: "off")
        }
        let vm = await MainActor.run {
            OpenClawChatViewModel(sessionKey: "main", transport: transport, transcriptCache: cache)
        }

        await MainActor.run { vm.load() }
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
        // The live sessions.list response is authoritative even when empty; a
        // cache read that resolves afterwards must not repaint stale sessions.
        var releaseSessions: AsyncStream<Void>.Continuation!
        let sessionsGate = AsyncStream<Void> { releaseSessions = $0 }
        let release = try #require(releaseSessions)
        let cache = TestTranscriptCache(
            sessions: [cachedSessionEntry(key: "stale-session", updatedAt: 1000)],
            loadSessionsHook: {
                var iterator = sessionsGate.makeAsyncIterator()
                _ = await iterator.next()
            })
        let transport = GatedHistoryChatTransport(gated: false) { sessionKey, _ in
            OpenClawChatHistoryPayload(
                sessionKey: sessionKey,
                sessionId: "sess-live",
                messages: [],
                thinkingLevel: "off")
        }
        let vm = await MainActor.run {
            OpenClawChatViewModel(sessionKey: "main", transport: transport, transcriptCache: cache)
        }

        await MainActor.run { vm.load() }
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
        var global = cachedSessionEntry(key: "global", updatedAt: 1000)
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
        let transport = GatedHistoryChatTransport(gated: false) { sessionKey, _ in
            OpenClawChatHistoryPayload(
                sessionKey: sessionKey,
                sessionId: "unused-live-session",
                messages: [],
                thinkingLevel: "off")
        }
        let vm = await MainActor.run {
            OpenClawChatViewModel(
                sessionKey: "agent:main:work",
                transport: transport,
                activeAgentId: "main",
                transcriptCache: cache)
        }
        let snapshot = await MainActor.run { vm.currentSessionSnapshot() }
        await MainActor.run { vm.paintFromCacheIfNeeded(session: snapshot) }
        _ = await startedIterator.next()

        await MainActor.run { vm.syncActiveAgentId("work") }
        release.yield(())
        try await Task.sleep(nanoseconds: 100_000_000)

        #expect(await MainActor.run { vm.sessions.isEmpty })
    }

    @Test func `ownerless shared cache cannot claim the selected global owner`() async throws {
        var global = cachedSessionEntry(key: "global", updatedAt: 1000)
        global.observerDigest = OpenClawChatSessionObserverDigest(
            runId: "run-legacy",
            revision: 3,
            updatedAt: 1000,
            headline: "Ambiguous legacy owner",
            health: "on-track")
        let cache = TestTranscriptCache(sessions: [global])
        let transport = GatedHistoryChatTransport(gated: false) { sessionKey, _ in
            OpenClawChatHistoryPayload(
                sessionKey: sessionKey,
                sessionId: "unused-live-session",
                messages: [],
                thinkingLevel: "off")
        }
        let vm = await MainActor.run {
            OpenClawChatViewModel(
                sessionKey: "agent:work:main",
                transport: transport,
                activeAgentId: "work",
                transcriptCache: cache)
        }
        let snapshot = await MainActor.run { vm.currentSessionSnapshot() }

        await MainActor.run { vm.paintFromCacheIfNeeded(session: snapshot) }
        try await waitUntil("shared cache row painted without ambiguous digest") {
            await MainActor.run { vm.sessions.count == 1 }
        }

        #expect(await MainActor.run { vm.sessions[0].key == "global" })
        #expect(await MainActor.run { vm.sessions[0].observerDigest == nil })
    }

    @Test func `session cache strips active markers and preserves terminal recap`() {
        var active = cachedSessionEntry(key: "active", updatedAt: 2000)
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
                "main": [cachedMessage(role: "assistant", text: "stale cached", timestamp: 500)],
            ])
        let transport = GatedHistoryChatTransport(gated: false) { sessionKey, _ in
            OpenClawChatHistoryPayload(
                sessionKey: sessionKey,
                sessionId: "sess-live",
                messages: [],
                thinkingLevel: "off")
        }
        let vm = await MainActor.run {
            OpenClawChatViewModel(sessionKey: "main", transport: transport, transcriptCache: cache)
        }

        await MainActor.run { vm.load() }
        try await waitUntil("live history applied") {
            await MainActor.run { vm.sessionId == "sess-live" && !vm.isLoading }
        }
        // Give any straggling cache paint a chance to (incorrectly) land.
        try await Task.sleep(nanoseconds: 100_000_000)
        #expect(await MainActor.run { vm.messages.isEmpty })
        #expect(await MainActor.run { !vm.isShowingCachedTranscript })
    }
}
