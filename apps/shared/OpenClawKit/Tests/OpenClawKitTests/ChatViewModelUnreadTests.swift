import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

private actor UnreadTestTransportState {
    var historyCalls = 0
    var listCalls = 0
    var unreadPatchAttempts: [(String, Bool)] = []
    var unreadPatchStarts = 0
    var sessionOverride: [OpenClawChatSessionEntry]?
    var historyFailuresRemaining: Int
    var patchFailuresRemaining: Int

    init(historyFailures: Int, patchFailures: Int) {
        self.historyFailuresRemaining = historyFailures
        self.patchFailuresRemaining = patchFailures
    }
}

private actor UnreadMutationRecorder {
    private(set) var events: [String] = []

    func append(_ event: String) {
        self.events.append(event)
    }
}

private actor UnreadPatchGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var released = false

    func wait() async {
        guard !self.released else { return }
        await withCheckedContinuation { continuation in
            if self.released {
                continuation.resume()
            } else {
                self.continuation = continuation
            }
        }
    }

    func release() {
        self.released = true
        self.continuation?.resume()
        self.continuation = nil
    }
}

private final class UnreadTestTransport: @unchecked Sendable, OpenClawChatTransport {
    private let state: UnreadTestTransportState
    private let sessions: [OpenClawChatSessionEntry]
    private let respectsListLimit: Bool
    private let patchDelay: Duration?
    private let patchGate: UnreadPatchGate?

    init(
        sessions: [OpenClawChatSessionEntry],
        historyFailures: Int = 0,
        patchFailures: Int = 0,
        respectsListLimit: Bool = false,
        patchDelay: Duration? = nil,
        patchGate: UnreadPatchGate? = nil)
    {
        self.sessions = sessions
        self.respectsListLimit = respectsListLimit
        self.patchDelay = patchDelay
        self.patchGate = patchGate
        self.state = UnreadTestTransportState(
            historyFailures: historyFailures,
            patchFailures: patchFailures)
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        await self.state.recordHistoryCall()
        if await self.state.consumeHistoryFailure() {
            throw NSError(domain: "UnreadTestTransport", code: 1)
        }
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
        throw NSError(domain: "UnreadTestTransport", code: 3)
    }

    func listSessions(
        limit: Int?,
        search _: String?,
        archived _: Bool) async throws -> OpenClawChatSessionsListResponse
    {
        await self.state.recordListCall()
        let sessions = await self.state.sessionOverride ?? self.sessions
        let listed = if self.respectsListLimit, let limit {
            Array(sessions.prefix(limit))
        } else {
            sessions
        }
        return OpenClawChatSessionsListResponse(
            ts: nil,
            path: nil,
            count: listed.count,
            defaults: nil,
            sessions: listed)
    }

    func patchSession(
        key: String,
        label _: String??,
        category _: String??,
        pinned _: Bool?,
        archived _: Bool?,
        unread: Bool?) async throws
    {
        guard let unread else { return }
        await self.state.recordUnreadPatchStart()
        if let patchGate {
            await patchGate.wait()
        } else if let patchDelay {
            try await Task.sleep(for: patchDelay)
        }
        await self.state.recordUnreadPatch(key: key, unread: unread)
        if await self.state.consumePatchFailure() {
            throw NSError(domain: "UnreadTestTransport", code: 2)
        }
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func listModels() async throws -> [OpenClawChatModelChoice] {
        []
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { $0.finish() }
    }

    func unreadPatchAttempts() async -> [(String, Bool)] {
        await self.state.unreadPatchAttempts
    }

    func historyCallCount() async -> Int {
        await self.state.historyCalls
    }

    func unreadPatchStartCount() async -> Int {
        await self.state.unreadPatchStarts
    }

    func listCallCount() async -> Int {
        await self.state.listCalls
    }

    func setSessions(_ sessions: [OpenClawChatSessionEntry]) async {
        await self.state.setSessions(sessions)
    }
}

extension UnreadTestTransportState {
    fileprivate func recordHistoryCall() {
        self.historyCalls += 1
    }

    fileprivate func recordListCall() {
        self.listCalls += 1
    }

    fileprivate func recordUnreadPatch(key: String, unread: Bool) {
        self.unreadPatchAttempts.append((key, unread))
    }

    fileprivate func recordUnreadPatchStart() {
        self.unreadPatchStarts += 1
    }

    fileprivate func consumeHistoryFailure() -> Bool {
        guard self.historyFailuresRemaining > 0 else { return false }
        self.historyFailuresRemaining -= 1
        return true
    }

    fileprivate func consumePatchFailure() -> Bool {
        guard self.patchFailuresRemaining > 0 else { return false }
        self.patchFailuresRemaining -= 1
        return true
    }

    fileprivate func setSessions(_ sessions: [OpenClawChatSessionEntry]) {
        self.sessionOverride = sessions
    }
}

@MainActor
struct ChatViewModelUnreadTests {
    @Test func `successful activation clears unread once`() async throws {
        let transport = UnreadTestTransport(sessions: [self.entry(key: "a", unread: true)])
        let viewModel = self.viewModel(sessionKey: "a", transport: transport)

        viewModel.load()
        try await self.waitUntil { await transport.unreadPatchAttempts().count == 1 }
        viewModel.refresh()
        try await self.waitUntil { await transport.listCallCount() >= 2 && !viewModel.isLoading }

        let attempts = await transport.unreadPatchAttempts()
        #expect(attempts.map(\.0) == ["a"])
        #expect(attempts.map(\.1) == [false])
    }

    @Test func `main alias refresh does not rearm unread clearing`() async throws {
        let transport = UnreadTestTransport(
            sessions: [self.entry(key: "agent:alpha:main", unread: true)])
        let viewModel = self.viewModel(
            sessionKey: "main",
            activeAgentID: "alpha",
            transport: transport)

        viewModel.load()
        try await self.waitUntil { await transport.unreadPatchAttempts().count == 1 }
        viewModel.refresh()
        try await self.waitUntil { await transport.historyCallCount() >= 2 && !viewModel.isLoading }

        #expect(await transport.unreadPatchAttempts().count == 1)
    }

    @Test func `cold main alias mark unread shares canonical activation identity`() async throws {
        let transport = UnreadTestTransport(
            sessions: [self.entry(key: "agent:alpha:main", unread: true)],
            patchDelay: .milliseconds(50))
        let viewModel = self.viewModel(
            sessionKey: "main",
            activeAgentID: "alpha",
            transport: transport)

        viewModel.setSessionUnread(key: "main", unread: true)
        viewModel.load()
        try await self.waitUntil { await transport.unreadPatchAttempts().count == 1 && !viewModel.isLoading }

        let attempts = await transport.unreadPatchAttempts()
        #expect(attempts.map(\.0) == ["main"])
        #expect(attempts.map(\.1) == [true])
    }

    @Test func `failed history does not clear unread`() async throws {
        let transport = UnreadTestTransport(
            sessions: [self.entry(key: "a", unread: true)],
            historyFailures: 1)
        let viewModel = self.viewModel(sessionKey: "a", transport: transport)

        viewModel.load()
        try await self.waitUntil { !viewModel.isLoading && viewModel.errorText != nil }

        let attempts = await transport.unreadPatchAttempts()
        #expect(attempts.isEmpty)
    }

    @Test func `failed unread patch retries on next activation`() async throws {
        let transport = UnreadTestTransport(
            sessions: [
                self.entry(key: "a", unread: true),
                self.entry(key: "b", unread: false),
            ],
            patchFailures: 1)
        let viewModel = self.viewModel(sessionKey: "a", transport: transport)

        viewModel.load()
        try await self.waitUntil { await transport.unreadPatchAttempts().count == 1 }
        viewModel.switchSession(to: "b")
        try await self.waitUntil { viewModel.sessionId == "session-b" }
        viewModel.switchSession(to: "a")
        try await self.waitUntil { await transport.unreadPatchAttempts().count == 2 }

        let attempts = await transport.unreadPatchAttempts()
        #expect(attempts.map(\.0) == ["a", "a"])
        #expect(attempts.allSatisfy { !$0.1 })
    }

    @Test func `failed intermediate activation still rearms unread clearing`() async throws {
        let transport = UnreadTestTransport(
            sessions: [
                self.entry(key: "a", unread: false),
                self.entry(key: "b", unread: false),
            ],
            historyFailures: 1)
        let viewModel = self.viewModel(sessionKey: "a", transport: transport)
        viewModel.refreshSessions()
        try await self.waitUntil { viewModel.sessions.count == 2 }

        viewModel.setSessionUnread(key: "a", unread: true)
        try await self.waitUntil { await transport.unreadPatchAttempts().count == 1 }
        await transport.setSessions([
            self.entry(key: "a", unread: true),
            self.entry(key: "b", unread: false),
        ])
        viewModel.switchSession(to: "b")
        try await self.waitUntil { viewModel.errorText != nil }
        viewModel.switchSession(to: "a")
        try await self.waitUntil { await transport.unreadPatchAttempts().count == 2 }

        let attempts = await transport.unreadPatchAttempts()
        #expect(attempts.map(\.0) == ["a", "a"])
        #expect(attempts.map(\.1) == [true, false])
    }

    @Test func `explicit mark unread rearms automatic clearing`() async throws {
        let transport = UnreadTestTransport(sessions: [
            self.entry(key: "a", unread: true),
            self.entry(key: "b", unread: false),
        ])
        let viewModel = self.viewModel(sessionKey: "a", transport: transport)

        viewModel.load()
        try await self.waitUntil { await transport.unreadPatchAttempts().count == 1 }
        viewModel.setSessionUnread(key: "a", unread: true)
        try await self.waitUntil { await transport.unreadPatchAttempts().count == 2 }
        viewModel.switchSession(to: "b")
        try await self.waitUntil { viewModel.sessionId == "session-b" }
        viewModel.switchSession(to: "a")
        try await self.waitUntil { await transport.unreadPatchAttempts().count == 3 }

        let attempts = await transport.unreadPatchAttempts()
        #expect(attempts.map(\.1) == [false, true, false])
    }

    @Test func `marking background session unread does not consume its activation`() async throws {
        let transport = UnreadTestTransport(sessions: [
            self.entry(key: "a", unread: false),
            self.entry(key: "b", unread: false),
        ])
        let viewModel = self.viewModel(sessionKey: "a", transport: transport)
        viewModel.refreshSessions()
        try await self.waitUntil { viewModel.sessions.count == 2 }

        viewModel.setSessionUnread(key: "b", unread: true)
        try await self.waitUntil { await transport.unreadPatchAttempts().count == 1 }
        await transport.setSessions([
            self.entry(key: "a", unread: false),
            self.entry(key: "b", unread: true),
        ])
        viewModel.switchSession(to: "b")
        try await self.waitUntil { await transport.unreadPatchAttempts().count == 2 }

        let attempts = await transport.unreadPatchAttempts()
        #expect(attempts.map(\.0) == ["b", "b"])
        #expect(attempts.map(\.1) == [true, false])
    }

    @Test func `successful off-list mark read records read confirmation`() async throws {
        let transport = UnreadTestTransport(sessions: [])
        let viewModel = self.viewModel(sessionKey: "a", transport: transport)

        viewModel.setSessionUnread(key: "hidden", unread: false)
        try await self.waitUntil {
            viewModel.unreadPatchGuard.confirmedUnread(key: "hidden") == false
        }

        #expect(viewModel.unreadPatchGuard.confirmedUnread(key: "hidden") == false)
    }

    @Test func `failed route lease preserves mutation queue ordering`() async throws {
        let recorder = UnreadMutationRecorder()
        let queue = ChatSessionUnreadMutationQueue()
        let firstLease = OpenClawChatSessionMutationRouteLease { _, _, _, _, _, _ in
            await recorder.append("first-start")
            try await Task.sleep(for: .milliseconds(100))
            await recorder.append("first-end")
        }
        let thirdLease = OpenClawChatSessionMutationRouteLease { _, _, _, _, _, _ in
            await recorder.append("third")
        }

        let first = queue.reserve(
            routeLease: Task<OpenClawChatSessionMutationRouteLease?, Never> { firstLease },
            queueKey: "a",
            routeKey: "a",
            unread: false)
        let second = queue.reserve(
            routeLease: Task<OpenClawChatSessionMutationRouteLease?, Never> { nil },
            queueKey: "a",
            routeKey: "a",
            unread: true)
        let third = queue.reserve(
            routeLease: Task<OpenClawChatSessionMutationRouteLease?, Never> { thirdLease },
            queueKey: "a",
            routeKey: "a",
            unread: false)

        try await first.value
        await #expect(throws: OpenClawChatTransportSendError.self) {
            try await second.value
        }
        try await third.value
        #expect(await recorder.events == ["first-start", "first-end", "third"])
    }

    @Test func `activation clears selected session outside refresh page`() async throws {
        let recent = (0..<50).map { index in
            self.entry(key: "recent-\(index)", unread: false, updatedAt: Double(100 - index))
        }
        let selected = self.entry(key: "old", unread: true, updatedAt: 1)
        let transport = UnreadTestTransport(
            sessions: recent + [selected],
            respectsListLimit: true)
        let viewModel = self.viewModel(sessionKey: "old", transport: transport)

        viewModel.refreshSessions(limit: 200)
        try await self.waitUntil { viewModel.sessions.contains { $0.key == "old" } }
        viewModel.load()
        try await self.waitUntil { await transport.unreadPatchAttempts().count == 1 }

        let attempts = await transport.unreadPatchAttempts()
        #expect(attempts.map(\.0) == ["old"])
        #expect(attempts.map(\.1) == [false])
    }

    @Test func `failed unread patch refreshes authoritative session state`() async throws {
        let transport = UnreadTestTransport(
            sessions: [
                self.entry(key: "a", unread: true),
                self.entry(key: "b", unread: false),
            ],
            patchFailures: 1,
            patchDelay: .milliseconds(50))
        let viewModel = self.viewModel(sessionKey: "b", transport: transport)
        viewModel.refreshSessions()
        try await self.waitUntil { viewModel.sessions.count == 2 }
        await transport.setSessions([
            self.entry(key: "a", unread: true),
            self.entry(key: "b", unread: false, pinned: true),
        ])

        viewModel.setSessionUnread(key: "a", unread: false)
        let otherIndex = try #require(viewModel.sessions.firstIndex(where: { $0.key == "b" }))
        viewModel.sessions[otherIndex].pinned = true
        try await self.waitUntil { viewModel.errorText != nil }
        try await self.waitUntil { await transport.listCallCount() >= 2 }

        #expect(viewModel.sessions.first(where: { $0.key == "a" })?.unread == true)
        #expect(viewModel.sessions.first(where: { $0.key == "b" })?.pinned == true)
    }

    @Test func `mark unread wins over an older activation read`() async throws {
        let transport = UnreadTestTransport(
            sessions: [self.entry(key: "a", unread: true)],
            patchDelay: .milliseconds(50))
        let viewModel = self.viewModel(sessionKey: "a", transport: transport)

        viewModel.load()
        try await self.waitUntil { await transport.unreadPatchStartCount() == 1 }
        viewModel.setSessionUnread(key: "a", unread: true)
        try await self.waitUntil { await transport.unreadPatchAttempts().count == 2 }

        let attempts = await transport.unreadPatchAttempts()
        #expect(attempts.map(\.1) == [false, true])
        #expect(viewModel.sessions.first(where: { $0.key == "a" })?.unread == true)
    }

    @Test func `stale list does not undo pending explicit unread`() async throws {
        let transport = UnreadTestTransport(
            sessions: [self.entry(key: "a", unread: false)],
            patchDelay: .milliseconds(50))
        let viewModel = self.viewModel(sessionKey: "a", transport: transport)
        viewModel.refreshSessions()
        try await self.waitUntil { viewModel.sessions.count == 1 }

        viewModel.setSessionUnread(key: "a", unread: true)
        viewModel.refreshSessions()
        try await self.waitUntil { await transport.unreadPatchAttempts().count == 1 }
        await transport.setSessions([self.entry(key: "a", unread: true)])
        viewModel.load()
        try await self.waitUntil { !viewModel.isLoading && viewModel.sessionId == "session-a" }

        let attempts = await transport.unreadPatchAttempts()
        #expect(attempts.map(\.1) == [true])
    }

    @Test func `pending explicit unread overlays stale list until fresh observation`() async throws {
        let patchGate = UnreadPatchGate()
        let transport = UnreadTestTransport(
            sessions: [
                self.entry(key: "a", unread: false),
                self.entry(key: "b", unread: false),
            ],
            patchGate: patchGate)
        let viewModel = self.viewModel(sessionKey: "b", transport: transport)
        viewModel.refreshSessions()
        try await self.waitUntil { viewModel.sessions.count == 2 }

        viewModel.setSessionUnread(key: "a", unread: true)
        try await self.waitUntil { await transport.unreadPatchStartCount() == 1 }
        viewModel.refreshSessions()
        try await self.waitUntil { await transport.listCallCount() >= 2 }

        #expect(viewModel.sessions.first(where: { $0.key == "a" })?.unread == true)
        #expect(viewModel.unreadPatchGuard.localUnreadOverride(key: "a") == true)

        await patchGate.release()
        await transport.setSessions([
            self.entry(key: "a", unread: true),
            self.entry(key: "b", unread: false),
        ])
        let listCallCount = await transport.listCallCount()
        try await self.waitUntil { await transport.unreadPatchAttempts().count == 1 }
        try await self.waitUntil {
            await transport.listCallCount() > listCallCount &&
                viewModel.unreadPatchGuard.localUnreadOverride(key: "a") == nil
        }

        #expect(viewModel.unreadPatchGuard.localUnreadOverride(key: "a") == nil)
        #expect(viewModel.unreadPatchGuard.confirmedUnread(key: "a") == true)
        #expect(viewModel.sessions.first(where: { $0.key == "a" })?.unread == true)
    }

    private func viewModel(
        sessionKey: String,
        activeAgentID: String? = nil,
        transport: UnreadTestTransport) -> OpenClawChatViewModel
    {
        let defaults = UserDefaults(suiteName: "ChatViewModelUnreadTests.\(UUID().uuidString)") ?? .standard
        return OpenClawChatViewModel(
            sessionKey: sessionKey,
            transport: transport,
            activeAgentId: activeAgentID,
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
    }

    private func entry(
        key: String,
        unread: Bool,
        updatedAt: Double = 1,
        lastInteractionAt: Double? = nil,
        lastActivityAt: Double? = nil,
        pinned: Bool? = nil) -> OpenClawChatSessionEntry
    {
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
            contextTokens: nil,
            pinned: pinned,
            unread: unread,
            lastInteractionAt: lastInteractionAt,
            lastActivityAt: lastActivityAt)
    }

    private func waitUntil(
        timeout: Duration = .seconds(5),
        condition: @escaping @MainActor () async -> Bool) async throws
    {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while clock.now < deadline {
            if await condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        Issue.record("timed out waiting for unread test condition")
    }
}
