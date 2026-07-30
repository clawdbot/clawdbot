import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

// MARK: - Scripted transport

/// Replays scripted gateway traffic against `OpenClawChatViewModel` with deterministic
/// ordering: every event is yielded into a single FIFO `AsyncStream`, and the view model
/// consumes that stream serially on the MainActor, so relative event order is exactly the
/// scripted order. Tests never sleep for fixed intervals; each step awaits an observable
/// view-model convergence point instead.
private final class ScriptedChatTransport: @unchecked Sendable, OpenClawChatTransport {
    private actor State {
        var history: OpenClawChatHistoryPayload
        var historyRequestCount = 0
        var sentRunIds: [String] = []

        init(history: OpenClawChatHistoryPayload) {
            self.history = history
        }

        func setHistory(_ payload: OpenClawChatHistoryPayload) {
            self.history = payload
        }

        func recordHistoryRequest() -> OpenClawChatHistoryPayload {
            self.historyRequestCount += 1
            return self.history
        }

        func recordSend(runId: String) {
            self.sentRunIds.append(runId)
        }
    }

    private let state: State
    private let stream: AsyncStream<OpenClawChatTransportEvent>
    private let continuation: AsyncStream<OpenClawChatTransportEvent>.Continuation

    init(history: OpenClawChatHistoryPayload) {
        self.state = State(history: history)
        var cont: AsyncStream<OpenClawChatTransportEvent>.Continuation!
        self.stream = AsyncStream { c in
            cont = c
        }
        self.continuation = cont
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        self.stream
    }

    /// Scripted history is mutable so reconnect scenarios can flip the durable
    /// transcript between requests, mirroring a gateway that finished the run
    /// while the client stream was down.
    func setHistory(_ payload: OpenClawChatHistoryPayload) async {
        await self.state.setHistory(payload)
    }

    func emit(_ event: OpenClawChatTransportEvent) {
        self.continuation.yield(event)
    }

    func sentRunIds() async -> [String] {
        await self.state.sentRunIds
    }

    func historyRequestCount() async -> Int {
        await self.state.historyRequestCount
    }

    // MARK: OpenClawChatTransport

    func requestHistory(sessionKey _: String) async throws -> OpenClawChatHistoryPayload {
        await self.state.recordHistoryRequest()
    }

    func sendMessage(
        sessionKey _: String,
        message _: String,
        thinking _: String,
        idempotencyKey: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        await self.state.recordSend(runId: idempotencyKey)
        // "pending" keeps the run open until scripted terminal events arrive,
        // which is the streaming path this harness exists to exercise.
        return OpenClawChatSendResponse(runId: idempotencyKey, status: "pending")
    }

    func listModels() async throws -> [OpenClawChatModelChoice] {
        []
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
}

// MARK: - Fixture builders

private func replayHistory(
    sessionId: String = "sess-replay",
    messages: [AnyCodable] = []) -> OpenClawChatHistoryPayload
{
    OpenClawChatHistoryPayload(
        sessionKey: "main",
        sessionId: sessionId,
        messages: messages,
        thinkingLevel: "off")
}

/// Raw history/event row shaped like the gateway JSON, including the persisted
/// `__openclaw.idempotencyKey` metadata used for turn correlation.
private func replayRawMessage(
    role: String,
    text: String,
    timestamp: Double,
    idempotencyKey: String? = nil) -> AnyCodable
{
    var message: [String: Any] = [
        "role": role,
        "content": [["type": "text", "text": text]],
        "timestamp": timestamp,
    ]
    if let idempotencyKey {
        message["__openclaw"] = ["idempotencyKey": idempotencyKey]
    }
    return AnyCodable(message)
}

private func replayDurableMessage(
    role: String,
    text: String,
    timestamp: Double,
    idempotencyKey: String? = nil) -> OpenClawChatMessage
{
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
        timestamp: timestamp,
        idempotencyKey: idempotencyKey)
}

private func replaySessionMessageEvent(
    text: String,
    timestamp: Double,
    role: String = "assistant",
    idempotencyKey: String? = nil,
    messageId: String) -> OpenClawChatTransportEvent
{
    .sessionMessage(
        OpenClawSessionMessageEventPayload(
            sessionKey: "main",
            message: replayDurableMessage(
                role: role,
                text: text,
                timestamp: timestamp,
                idempotencyKey: idempotencyKey),
            messageId: messageId,
            messageSeq: nil))
}

private func replayFinalEvent(
    runId: String,
    text: String,
    timestamp: Double) -> OpenClawChatTransportEvent
{
    .chat(
        OpenClawChatEventPayload(
            runId: runId,
            sessionKey: "main",
            state: "final",
            message: replayRawMessage(
                role: "assistant",
                text: text,
                timestamp: timestamp,
                idempotencyKey: runId),
            errorMessage: nil))
}

private func replayAssistantDeltaEvent(
    runId: String,
    cumulativeText: String,
    seq: Int) -> OpenClawChatTransportEvent
{
    .agent(
        OpenClawAgentEventPayload(
            runId: runId,
            seq: seq,
            stream: "assistant",
            ts: seq,
            data: ["text": AnyCodable(cumulativeText)]))
}

/// Cumulative streaming prefixes, chunked on character boundaries. The gateway
/// assistant stream carries the full accumulated text per event, so replaying
/// growing prefixes matches production framing.
private func cumulativePrefixes(of text: String, chunkLength: Int) -> [String] {
    var prefixes: [String] = []
    var index = text.startIndex
    while index < text.endIndex {
        index = text.index(index, offsetBy: chunkLength, limitedBy: text.endIndex) ?? text.endIndex
        prefixes.append(String(text[..<index]))
    }
    return prefixes
}

// MARK: - Harness

private struct StreamReplayHarness {
    let transport: ScriptedChatTransport
    let vm: OpenClawChatViewModel

    static func bootstrapped(
        initialHistory: OpenClawChatHistoryPayload = replayHistory()) async throws -> StreamReplayHarness
    {
        let transport = ScriptedChatTransport(history: initialHistory)
        let vm = await MainActor.run {
            OpenClawChatViewModel(sessionKey: "main", transport: transport)
        }
        await MainActor.run { vm.load() }
        let harness = StreamReplayHarness(transport: transport, vm: vm)
        try await harness.converge("replay bootstrap") { vm in
            vm.healthOK && !vm.isLoading
        }
        return harness
    }

    /// Awaits an observable view-model state instead of sleeping a fixed interval.
    func converge(
        _ label: String,
        _ condition: @escaping @MainActor @Sendable (OpenClawChatViewModel) -> Bool) async throws
    {
        let vm = self.vm
        try await waitUntil(label) {
            await MainActor.run { condition(vm) }
        }
    }

    /// Sends a user turn and returns the run id after the send acknowledgment has
    /// fully settled: the transport accepted the send AND the post-ack history
    /// refresh has run. That barrier makes subsequent scripted events ordered
    /// strictly after send-side bookkeeping, so pendingRuns assertions are stable.
    func send(_ text: String) async throws -> String {
        let priorSends = await self.transport.sentRunIds().count
        let priorHistoryRequests = await self.transport.historyRequestCount()
        await MainActor.run {
            self.vm.input = text
            self.vm.send()
        }
        try await waitUntil("transport accepted send") {
            await self.transport.sentRunIds().count > priorSends
        }
        let runId = try #require(await self.transport.sentRunIds().last)
        try await waitUntil("post-send ack refresh settled") {
            await self.transport.historyRequestCount() > priorHistoryRequests
        }
        try await self.converge("run pending after send") { vm in
            vm.pendingRunCount == 1
        }
        return runId
    }

    /// Streams the full text as growing prefixes and waits until the final
    /// accumulated streaming text is visible.
    func streamCumulativeChunks(runId: String, fullText: String, chunkLength: Int) async throws {
        for (offset, prefix) in cumulativePrefixes(of: fullText, chunkLength: chunkLength).enumerated() {
            self.transport.emit(
                replayAssistantDeltaEvent(runId: runId, cumulativeText: prefix, seq: offset + 1))
        }
        try await self.converge("streamed text accumulated") { vm in
            vm.streamingAssistantText == fullText
        }
    }
}

extension OpenClawChatViewModel {
    fileprivate var replayAssistantRows: [OpenClawChatMessage] {
        self.messages.filter { $0.role == "assistant" }
    }

    fileprivate func replayAssistantRows(text: String) -> [OpenClawChatMessage] {
        self.replayAssistantRows.filter { message in
            message.content.compactMap(\.text).joined() == text
        }
    }

    fileprivate var replayUserRows: [OpenClawChatMessage] {
        self.messages.filter { $0.role == "user" }
    }
}

// MARK: - Markdown shapes fixture

// Extended-delimiter literal keeps the fenced Swift interpolation inert.
private let markdownShapesFixture = #"""
# Release Notes

This opening paragraph is intentionally long so that chunked streaming splits it mid-sentence and mid-word many times over: it keeps going with more prose, more clauses, and enough characters that dozens of cumulative prefixes land inside it before the first heading boundary is ever reached by the replay script.

## Changes

- First bullet
- Second bullet with **bold** and `inline code`
  - Nested child one
  - Nested child two
    1. Deep ordered a
    2. Deep ordered b

```swift
let answer = 42
print("hello \(answer)")
```

| Column A | Column B |
| --- | --- |
| a1 | b1 |
| a2 | b2 |

Closing paragraph with unicode — dashes, émojis 🦀🚀, and a trailing line.
"""#

// MARK: - Tests

/// Deterministic streaming replay scenarios for the shared iOS/macOS chat pipeline.
/// Covers streaming accumulation, provisional-final reconciliation against durable
/// `session.message` rows, duplicate delivery, out-of-order arrival, and reconnect
/// convergence. Tracking: #100196.
struct ChatStreamReplayTests {
    @Test func `clean streaming run converges losslessly to durable rows`() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let finalText = "Hello, world!"
        let harness = try await StreamReplayHarness.bootstrapped()
        let runId = try await harness.send("hi")

        try await harness.streamCumulativeChunks(runId: runId, fullText: finalText, chunkLength: 4)

        harness.transport.emit(replayFinalEvent(runId: runId, text: finalText, timestamp: now + 1000))
        try await harness.converge("final clears run and shows provisional row") { vm in
            vm.pendingRunCount == 0 &&
                vm.streamingAssistantText == nil &&
                vm.replayAssistantRows(text: finalText).count == 1
        }

        // Durable rows for both turns arrive afterwards; the transcript must
        // adopt them without duplicating or losing either side of the exchange.
        harness.transport.emit(
            replaySessionMessageEvent(
                text: "hi",
                timestamp: now + 500,
                role: "user",
                idempotencyKey: "\(runId):user",
                messageId: "durable-user"))
        harness.transport.emit(
            replaySessionMessageEvent(
                text: finalText,
                timestamp: now + 1500,
                idempotencyKey: runId,
                messageId: "durable-assistant"))

        try await harness.converge("durable rows adopted") { vm in
            vm.replayUserRows.count == 1 &&
                vm.replayUserRows.first?.timestamp == now + 500 &&
                vm.replayAssistantRows(text: finalText).count == 1 &&
                vm.replayAssistantRows(text: finalText).first?.timestamp == now + 1500
        }

        await MainActor.run {
            #expect(harness.vm.messages.count == 2)
            #expect(harness.vm.messages.map(\.role) == ["user", "assistant"])
            #expect(harness.vm.pendingRunCount == 0)
            #expect(harness.vm.pendingToolCalls.isEmpty)
            #expect(harness.vm.streamingAssistantText == nil)
            let assistantText = harness.vm.replayAssistantRows.first?.content.compactMap(\.text).joined()
            #expect(assistantText == finalText)
        }
    }

    @Test func `duplicate durable delivery does not duplicate rows`() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let harness = try await StreamReplayHarness.bootstrapped()

        let keyed = replaySessionMessageEvent(
            text: "keyed reply",
            timestamp: now + 1,
            idempotencyKey: "run-dup",
            messageId: "durable-keyed")
        let unkeyed = replaySessionMessageEvent(
            text: "unkeyed reply",
            timestamp: now + 2,
            messageId: "durable-unkeyed")

        harness.transport.emit(keyed)
        harness.transport.emit(keyed)
        harness.transport.emit(unkeyed)
        harness.transport.emit(unkeyed)
        // FIFO stream: once the sentinel is visible, all four duplicates above
        // have already been applied, so counting rows here is race-free.
        harness.transport.emit(
            replaySessionMessageEvent(
                text: "sentinel",
                timestamp: now + 3,
                idempotencyKey: "run-sentinel",
                messageId: "durable-sentinel"))

        try await harness.converge("sentinel visible after duplicates") { vm in
            vm.replayAssistantRows(text: "sentinel").count == 1
        }

        await MainActor.run {
            #expect(harness.vm.replayAssistantRows(text: "keyed reply").count == 1)
            #expect(harness.vm.replayAssistantRows(text: "unkeyed reply").count == 1)
            #expect(harness.vm.messages.count == 3)
        }
    }

    @Test func `provisional final is replaced by durable row without content loss`() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let replyText = "Considered answer with detail."
        let harness = try await StreamReplayHarness.bootstrapped()
        let runId = try await harness.send("draft question")

        harness.transport.emit(replayFinalEvent(runId: runId, text: replyText, timestamp: now + 1000))
        try await harness.converge("provisional final visible") { vm in
            vm.pendingRunCount == 0 && vm.replayAssistantRows(text: replyText).count == 1
        }
        let provisionalID = try await MainActor.run {
            try #require(harness.vm.replayAssistantRows(text: replyText).first?.id)
        }

        harness.transport.emit(
            replaySessionMessageEvent(
                text: replyText,
                timestamp: now + 2000,
                idempotencyKey: runId,
                messageId: "durable-final"))

        try await harness.converge("durable row replaces provisional") { vm in
            vm.replayAssistantRows(text: replyText).first?.timestamp == now + 2000
        }

        await MainActor.run {
            let rows = harness.vm.replayAssistantRows(text: replyText)
            #expect(rows.count == 1)
            // Row identity survives adoption so SwiftUI does not re-animate the bubble.
            #expect(rows.first?.id == provisionalID)
            #expect(rows.first?.idempotencyKey == runId)
            let rowText = rows.first?.content.compactMap(\.text).joined() ?? ""
            #expect(Array(rowText.utf8) == Array(replyText.utf8))
        }
    }

    @Test func `durable row arriving before run completion does not duplicate on final`() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let replyText = "Answer persisted before completion."
        let harness = try await StreamReplayHarness.bootstrapped()
        let runId = try await harness.send("early durable")

        // Out-of-order: session.message lands while the run is still pending.
        harness.transport.emit(
            replaySessionMessageEvent(
                text: replyText,
                timestamp: now + 5000,
                idempotencyKey: runId,
                messageId: "durable-early"))
        try await harness.converge("durable visible while run still pending") { vm in
            vm.replayAssistantRows(text: replyText).count == 1 && vm.pendingRunCount == 1
        }

        harness.transport.emit(replayFinalEvent(runId: runId, text: replyText, timestamp: now + 1000))
        try await harness.converge("final drains pending run") { vm in
            vm.pendingRunCount == 0
        }

        await MainActor.run {
            let rows = harness.vm.replayAssistantRows(text: replyText)
            #expect(rows.count == 1)
            // The durable row stays canonical; the late final must not append a
            // second provisional copy of the same reply.
            #expect(rows.first?.timestamp == now + 5000)
            #expect(harness.vm.streamingAssistantText == nil)
        }
    }

    @Test func `reconnect mid-run converges via history refetch and drains pending run`() async throws {
        let harness = try await StreamReplayHarness.bootstrapped()
        let runId = try await harness.send("please finish")

        try await harness.streamCumulativeChunks(runId: runId, fullText: "Working on it", chunkLength: 5)

        // Stream stops here (no final, no lifecycle end). The gateway finished the
        // run while the client was away, so the next history fetch returns the
        // completed transcript keyed to this run.
        // With no terminal event, the pending run drains only via the history
        // poller, which requires the durable assistant row to be timestamped at
        // or after the optimistic user echo. Anchor the transcript after the
        // send instead of at test start, where slow bootstrap (>900ms on loaded
        // CI runners) left the row "older" than the echo and the run never drained.
        let reconnectNow = Date().timeIntervalSince1970 * 1000
        await harness.transport.setHistory(
            replayHistory(messages: [
                replayRawMessage(
                    role: "user",
                    text: "please finish",
                    timestamp: reconnectNow + 100,
                    idempotencyKey: "\(runId):user"),
                replayRawMessage(
                    role: "assistant",
                    text: "Finished while you were away.",
                    timestamp: reconnectNow + 900,
                    idempotencyKey: runId),
            ]))
        await MainActor.run { harness.vm.resumeFromForeground() }

        try await harness.converge("reconnect refetch converges transcript") { vm in
            vm.pendingRunCount == 0 &&
                vm.streamingAssistantText == nil &&
                vm.replayAssistantRows(text: "Finished while you were away.").count == 1
        }

        await MainActor.run {
            #expect(harness.vm.messages.count == 2)
            #expect(harness.vm.replayUserRows.count == 1)
            #expect(harness.vm.replayUserRows.first?.idempotencyKey == "\(runId):user")
            #expect(harness.vm.pendingToolCalls.isEmpty)
            #expect(harness.vm.errorText == nil)
        }
    }

    @Test func `markdown shapes fixture streams byte-identically in small chunks`() async throws {
        let now = Date().timeIntervalSince1970 * 1000
        let harness = try await StreamReplayHarness.bootstrapped()
        let runId = try await harness.send("markdown please")

        try await harness.streamCumulativeChunks(
            runId: runId,
            fullText: markdownShapesFixture,
            chunkLength: 5)

        let streamed = try await MainActor.run {
            try #require(harness.vm.streamingAssistantText)
        }
        #expect(Array(streamed.utf8) == Array(markdownShapesFixture.utf8))

        // Completion path: the same bytes must survive final + durable adoption.
        harness.transport.emit(
            replayFinalEvent(runId: runId, text: markdownShapesFixture, timestamp: now + 1000))
        harness.transport.emit(
            replaySessionMessageEvent(
                text: markdownShapesFixture,
                timestamp: now + 1500,
                idempotencyKey: runId,
                messageId: "durable-markdown"))

        try await harness.converge("markdown reply converges to durable row") { vm in
            vm.pendingRunCount == 0 &&
                vm.streamingAssistantText == nil &&
                vm.replayAssistantRows(text: markdownShapesFixture).first?.timestamp == now + 1500
        }

        await MainActor.run {
            let rows = harness.vm.replayAssistantRows
            #expect(rows.count == 1)
            let rowText = rows.first?.content.compactMap(\.text).joined() ?? ""
            #expect(Array(rowText.utf8) == Array(markdownShapesFixture.utf8))
        }
    }

    @Test func `consecutive assistant streams keep independent full text`() async throws {
        let now = Date().timeIntervalSince1970 * 1000 - 10000
        let harness = try await StreamReplayHarness.bootstrapped()
        let firstText = "First streamed response."
        let secondText = "Second response starts fresh."

        let firstRunId = try await harness.send("first")
        try await harness.streamCumulativeChunks(
            runId: firstRunId,
            fullText: firstText,
            chunkLength: 3)
        harness.transport.emit(
            replayFinalEvent(runId: firstRunId, text: firstText, timestamp: now + 1000))
        harness.transport.emit(
            replaySessionMessageEvent(
                text: firstText,
                timestamp: now + 1100,
                idempotencyKey: firstRunId,
                messageId: "durable-first"))
        try await harness.converge("first stream finalized") { vm in
            vm.streamingAssistantText == nil && vm.replayAssistantRows(text: firstText).count == 1
        }

        let secondRunId = try await harness.send("second")
        try await harness.streamCumulativeChunks(
            runId: secondRunId,
            fullText: secondText,
            chunkLength: 4)
        await MainActor.run {
            #expect(harness.vm.streamingAssistantText == secondText)
            #expect(harness.vm.replayAssistantRows(text: firstText).count == 1)
        }

        harness.transport.emit(
            replayFinalEvent(runId: secondRunId, text: secondText, timestamp: now + 2000))
        harness.transport.emit(
            replaySessionMessageEvent(
                text: secondText,
                timestamp: now + 2100,
                idempotencyKey: secondRunId,
                messageId: "durable-second"))
        try await harness.converge("second stream finalized independently") { vm in
            vm.streamingAssistantText == nil &&
                vm.replayAssistantRows(text: firstText).count == 1 &&
                vm.replayAssistantRows(text: secondText).count == 1
        }
    }
}
