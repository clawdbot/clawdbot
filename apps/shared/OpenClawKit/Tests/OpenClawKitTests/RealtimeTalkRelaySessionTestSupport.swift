import Foundation
import OpenClawProtocol
@testable import OpenClawKit

@MainActor
final class UnusedPCMStreamingAudioPlayer: PCMStreamingAudioPlaying {
    func play(stream: AsyncThrowingStream<Data, Error>, sampleRate: Double) async -> StreamingPlaybackResult {
        fatalError("Playback is not used by this test")
    }

    func stop() -> Double? {
        nil
    }
}

@MainActor
final class DrainingPCMStreamingAudioPlayer: PCMStreamingAudioPlaying {
    private(set) var frames: [Data] = []
    private(set) var playCount = 0
    private let playbackStarted = RealtimeRelayTestSignal<Int>()
    private let playbackFinished = RealtimeRelayTestSignal<Void>()

    func play(stream: AsyncThrowingStream<Data, Error>, sampleRate _: Double) async -> StreamingPlaybackResult {
        self.playCount += 1
        self.playbackStarted.send(self.playCount)
        do {
            for try await frame in stream {
                self.frames.append(frame)
            }
        } catch {}
        self.playbackFinished.send(())
        return StreamingPlaybackResult(finished: true, interruptedAt: nil)
    }

    func stop() -> Double? {
        nil
    }

    func waitUntilPlaybackFinished() async throws {
        _ = try await self.playbackFinished.next("draining playback to finish")
    }

    func waitForPlaybackCount(_ expectedCount: Int) async throws {
        while self.playCount < expectedCount {
            _ = try await self.playbackStarted.next("\(expectedCount) draining playback starts")
        }
    }
}

@MainActor
final class StalledPCMStreamingAudioPlayer: PCMStreamingAudioPlaying {
    private(set) var playCount = 0
    private(set) var stopCount = 0
    private var continuations: [CheckedContinuation<StreamingPlaybackResult, Never>] = []
    private let playbackStarted = RealtimeRelayTestSignal<Int>()

    func play(
        stream _: AsyncThrowingStream<Data, Error>,
        sampleRate _: Double) async -> StreamingPlaybackResult
    {
        self.playCount += 1
        self.playbackStarted.send(self.playCount)
        return await withCheckedContinuation { self.continuations.append($0) }
    }

    func stop() -> Double? {
        self.stopCount += 1
        let continuation = self.continuations.isEmpty ? nil : self.continuations.removeFirst()
        continuation?.resume(returning: StreamingPlaybackResult(finished: false, interruptedAt: nil))
        return nil
    }

    func waitForPlaybackCount(_ expectedCount: Int) async throws {
        while self.playCount < expectedCount {
            _ = try await self.playbackStarted.next("\(expectedCount) playback starts")
        }
    }
}

struct RealtimeRelayTestTimeout: Error, CustomStringConvertible {
    let operation: String

    var description: String {
        "timed out waiting for \(self.operation)"
    }
}

final class RealtimeRelayTestSignal<Value: Sendable>: @unchecked Sendable {
    private struct Waiter {
        let id: UUID
        let continuation: CheckedContinuation<Value, any Error>
        var deadline: Task<Void, Never>?
    }

    private let lock = NSLock()
    private let timeoutSeconds: Double
    private var values: [Value] = []
    private var waiters: [Waiter] = []

    init(timeoutSeconds: Double = 30) {
        self.timeoutSeconds = timeoutSeconds
    }

    func send(_ value: Value) {
        let waiter: Waiter? = self.lock.withLock {
            guard !self.waiters.isEmpty else {
                self.values.append(value)
                return nil
            }
            return self.waiters.removeFirst()
        }
        self.resume(waiter, with: .success(value))
    }

    func next(_ operation: String) async throws -> Value {
        try Task.checkCancellation()
        let id = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                let registration: Result<Value, any Error>? = self.lock.withLock {
                    if Task.isCancelled {
                        return .failure(CancellationError())
                    }
                    if !self.values.isEmpty {
                        return .success(self.values.removeFirst())
                    }
                    self.waiters.append(Waiter(id: id, continuation: continuation))
                    return nil
                }
                if let registration {
                    continuation.resume(with: registration)
                    return
                }
                let deadline = Task {
                    do {
                        try await Task.sleep(for: .seconds(self.timeoutSeconds))
                        self.failWaiter(id, with: RealtimeRelayTestTimeout(operation: operation))
                    } catch {}
                }
                let retained = self.lock.withLock {
                    guard let index = self.waiters.firstIndex(where: { $0.id == id }) else {
                        return false
                    }
                    self.waiters[index].deadline = deadline
                    return true
                }
                if !retained {
                    deadline.cancel()
                }
            }
        } onCancel: {
            self.failWaiter(id, with: CancellationError())
        }
    }

    private func failWaiter(_ id: UUID, with error: any Error) {
        self.resume(self.claimWaiter(id), with: .failure(error))
    }

    private func claimWaiter(_ id: UUID) -> Waiter? {
        self.lock.withLock {
            guard let index = self.waiters.firstIndex(where: { $0.id == id }) else {
                return nil
            }
            return self.waiters.remove(at: index)
        }
    }

    private func resume(_ waiter: Waiter?, with result: Result<Value, any Error>) {
        guard let waiter else { return }
        waiter.deadline?.cancel()
        waiter.continuation.resume(with: result)
    }
}

@MainActor
final class IndexedPCMStreamingAudioPlayer: PCMStreamingAudioPlaying {
    private(set) var activePlaybackIndexes: Set<Int> = []
    private var continuations: [Int: CheckedContinuation<StreamingPlaybackResult, Never>] = [:]
    private var isShutdown = false
    private let playbackStarted = RealtimeRelayTestSignal<Int>()
    private let mainActorCheckpoint = RealtimeRelayTestSignal<Int>()
    private var nextPlaybackIndex = 0

    func play(
        stream _: AsyncThrowingStream<Data, Error>,
        sampleRate _: Double) async -> StreamingPlaybackResult
    {
        guard !self.isShutdown else {
            return StreamingPlaybackResult(finished: false, interruptedAt: nil)
        }
        let index = self.nextPlaybackIndex
        self.nextPlaybackIndex += 1
        self.activePlaybackIndexes.insert(index)
        let result = await withCheckedContinuation { continuation in
            self.continuations[index] = continuation
            self.playbackStarted.send(index)
        }
        self.mainActorCheckpoint.send(index)
        return result
    }

    func stop() -> Double? {
        nil
    }

    func shutdown() {
        self.isShutdown = true
        self.activePlaybackIndexes.removeAll()
        let continuations = Array(self.continuations.values)
        self.continuations.removeAll()
        for continuation in continuations {
            continuation.resume(returning: StreamingPlaybackResult(finished: false, interruptedAt: nil))
        }
    }

    func waitForPlayback(_ expectedIndex: Int) async throws {
        let index = try await self.playbackStarted.next("playback \(expectedIndex) to start")
        guard index == expectedIndex else {
            throw RealtimeRelayTestTimeout(operation: "playback \(expectedIndex), got \(index)")
        }
    }

    func complete(_ index: Int) {
        self.activePlaybackIndexes.remove(index)
        self.continuations.removeValue(forKey: index)?.resume(
            returning: StreamingPlaybackResult(finished: true, interruptedAt: nil))
    }

    func fail(_ index: Int) {
        self.activePlaybackIndexes.remove(index)
        self.continuations.removeValue(forKey: index)?.resume(
            returning: StreamingPlaybackResult(finished: false, interruptedAt: nil))
    }

    func waitUntilCompletionWasHandled(_ expectedIndex: Int) async throws {
        let index = try await self.mainActorCheckpoint.next("playback \(expectedIndex) completion")
        guard index == expectedIndex else {
            throw RealtimeRelayTestTimeout(
                operation: "playback \(expectedIndex) completion, got \(index)")
        }
    }
}

@MainActor
final class TestRealtimeTalkAudioCapture: RealtimeTalkAudioCapturing {
    var suppressesInputDuringOutput = false
    private(set) var isStarted = false
    private(set) var startCount = 0
    private(set) var stopCount = 0
    private var onFailure: (@MainActor (String) -> Void)?

    func start(
        targetSampleRate: Double,
        onAudio: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void,
        onFailure: @escaping @MainActor (String) -> Void) throws
    {
        self.isStarted = true
        self.startCount += 1
        self.onFailure = onFailure
    }

    func stop() {
        self.isStarted = false
        self.stopCount += 1
        self.onFailure = nil
    }

    func fail(_ message: String) {
        self.onFailure?(message)
    }
}

actor RealtimeRelayStartupBarrier {
    private var entered = false
    private var released = false
    private var enteredWaiter: (id: UUID, continuation: CheckedContinuation<Void, any Error>)?
    private var releaseWaiter: CheckedContinuation<Void, Never>?

    func suspend() async {
        self.entered = true
        if let waiter = self.enteredWaiter {
            self.enteredWaiter = nil
            waiter.continuation.resume()
        }
        guard !self.released else { return }
        await withCheckedContinuation { continuation in
            if self.released { continuation.resume() } else { self.releaseWaiter = continuation }
        }
    }

    func waitUntilEntered() async throws {
        do {
            try await AsyncTimeout.withTimeout(
                seconds: 30,
                onTimeout: { RealtimeRelayTestTimeout(operation: "request barrier entry") },
                operation: { try await self.waitUntilEnteredWithoutDeadline() })
        } catch {
            self.release()
            throw error
        }
    }

    private func waitUntilEnteredWithoutDeadline() async throws {
        guard !self.entered else { return }
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                if self.entered {
                    continuation.resume()
                } else if Task.isCancelled {
                    continuation.resume(throwing: CancellationError())
                } else {
                    self.enteredWaiter = (id, continuation)
                }
            }
        } onCancel: {
            Task { await self.cancelEnteredWaiter(id) }
        }
    }

    private func cancelEnteredWaiter(_ id: UUID) {
        guard let waiter = self.enteredWaiter, waiter.id == id else { return }
        self.enteredWaiter = nil
        waiter.continuation.resume(throwing: CancellationError())
    }

    func release() {
        guard !self.released else { return }
        self.released = true
        self.releaseWaiter?.resume()
        self.releaseWaiter = nil
    }
}

func waitForRealtimeRelayEvent<Event: Sendable>(
    _ stream: AsyncStream<Event>,
    operation: String) async throws -> Event
{
    try await AsyncTimeout.withTimeout(
        seconds: 30,
        onTimeout: { RealtimeRelayTestTimeout(operation: operation) },
        operation: {
            var iterator = stream.makeAsyncIterator()
            guard let event = await iterator.next() else {
                throw RealtimeRelayTestTimeout(operation: "\(operation) before stream ended")
            }
            return event
        })
}

struct RealtimeRelayStartupRequest: Sendable {
    let method: String
    let params: [String: AnyCodable]?
}

actor RealtimeRelayStartupRequestLog {
    private var requests: [RealtimeRelayStartupRequest] = []
    private let requestObserved = RealtimeRelayTestSignal<Int>()

    func record(method: String, params: [String: AnyCodable]?) {
        self.requests.append(RealtimeRelayStartupRequest(method: method, params: params))
        self.requestObserved.send(self.requests.count)
    }

    func snapshot() -> [RealtimeRelayStartupRequest] {
        self.requests
    }

    func waitForRequestCount(_ expectedCount: Int) async throws {
        while self.requests.count < expectedCount {
            _ = try await self.requestObserved.next("\(expectedCount) relay requests")
        }
    }
}

enum ControlledAudioAppendBehavior {
    case suspended
    case requestFailure
    case malformedResponse
}

actor ControlledRealtimeAudioRequests {
    private let behavior: ControlledAudioAppendBehavior
    private var methods: [String] = []
    private var appendContinuations: [CheckedContinuation<Data, any Error>] = []
    private let requestObserved = RealtimeRelayTestSignal<Int>()

    init(behavior: ControlledAudioAppendBehavior = .suspended) {
        self.behavior = behavior
    }

    func request(method: String) async throws -> Data {
        self.methods.append(method)
        self.requestObserved.send(self.methods.count)
        guard method == "talk.session.appendAudio" else {
            return Data("{\"ok\":true}".utf8)
        }
        switch self.behavior {
        case .suspended:
            return try await withCheckedThrowingContinuation { continuation in
                self.appendContinuations.append(continuation)
            }
        case .requestFailure:
            throw URLError(.badServerResponse)
        case .malformedResponse:
            return Data("{}".utf8)
        }
    }

    func waitForRequestCount(_ expectedCount: Int) async throws {
        while self.methods.count < expectedCount {
            _ = try await self.requestObserved.next("\(expectedCount) relay requests")
        }
    }

    func snapshot() -> [String] {
        self.methods
    }

    func succeedPendingAppends() {
        let continuations = self.appendContinuations
        self.appendContinuations.removeAll()
        continuations.forEach { $0.resume(returning: Data("{\"ok\":true}".utf8)) }
    }
}

actor RealtimeRelayRouteFlag {
    private var isCurrent = true

    func expire() {
        self.isCurrent = false
    }

    func value() -> Bool {
        self.isCurrent
    }
}

actor RealtimeRelayEventSource {
    private var continuation: AsyncStream<EventFrame>.Continuation?

    func stream() -> AsyncStream<EventFrame> {
        AsyncStream { self.continuation = $0 }
    }

    func finish() {
        self.continuation?.finish()
    }
}

func unusedRealtimeRelayTransport() -> RealtimeTalkRelayTransport {
    RealtimeTalkRelayTransport(
        subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
        request: { _, _, _ in throw CancellationError() })
}

func outputAudioEvent(
    turnId: String,
    data: Data = Data([0x01]),
    relaySessionId: String = "relay-1") -> EventFrame
{
    EventFrame(
        type: "event",
        event: "talk.event",
        payload: AnyCodable([
            "relaySessionId": relaySessionId,
            "type": "audio",
            "audioBase64": data.base64EncodedString(),
            "talkEvent": ["turnId": turnId],
        ]),
        seq: nil,
        stateversion: nil)
}

func outputClearEvent(
    turnId: String? = nil,
    talkEventType: String = "turn.cancelled") -> EventFrame
{
    var payload: [String: AnyCodable] = [
        "relaySessionId": AnyCodable("relay-1"),
        "type": AnyCodable("clear"),
    ]
    if let turnId {
        payload["talkEvent"] = AnyCodable(["turnId": turnId, "type": talkEventType])
    }
    return EventFrame(
        type: "event",
        event: "talk.event",
        payload: AnyCodable(payload),
        seq: nil,
        stateversion: nil)
}

func playbackMarkEvent(_ markName: String) -> EventFrame {
    EventFrame(
        type: "event",
        event: "talk.event",
        payload: AnyCodable([
            "relaySessionId": "relay-1",
            "type": "mark",
            "markName": markName,
        ]),
        seq: nil,
        stateversion: nil)
}

func outputAudioDoneEvent(turnId: String) -> EventFrame {
    EventFrame(
        type: "event",
        event: "talk.event",
        payload: AnyCodable([
            "relaySessionId": "relay-1",
            "type": "audioDone",
            "talkEvent": ["turnId": turnId],
        ]),
        seq: nil,
        stateversion: nil)
}
