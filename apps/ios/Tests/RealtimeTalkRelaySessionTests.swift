import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

@MainActor
private final class UnusedPCMStreamingAudioPlayer: PCMStreamingAudioPlaying {
    func play(stream: AsyncThrowingStream<Data, Error>, sampleRate: Double) async -> StreamingPlaybackResult {
        fatalError("Playback is not used by this test")
    }

    func stop() -> Double? {
        nil
    }
}

@MainActor
private final class DrainingPCMStreamingAudioPlayer: PCMStreamingAudioPlaying {
    func play(stream: AsyncThrowingStream<Data, Error>, sampleRate: Double) async -> StreamingPlaybackResult {
        do {
            for try await _ in stream {}
            return StreamingPlaybackResult(finished: true, interruptedAt: nil)
        } catch {
            return StreamingPlaybackResult(finished: false, interruptedAt: nil)
        }
    }

    func stop() -> Double? {
        nil
    }
}

private actor RealtimeRelayStartupBarrier {
    private var entered = false
    private var enteredWaiter: CheckedContinuation<Void, Never>?
    private var releaseWaiter: CheckedContinuation<Void, Never>?

    func suspend() async {
        self.entered = true
        self.enteredWaiter?.resume()
        self.enteredWaiter = nil
        await withCheckedContinuation { self.releaseWaiter = $0 }
    }

    func waitUntilEntered() async {
        if self.entered {
            return
        }
        await withCheckedContinuation { self.enteredWaiter = $0 }
    }

    func release() {
        self.releaseWaiter?.resume()
        self.releaseWaiter = nil
    }
}

private struct RealtimeRelayStartupRequest: Sendable {
    let method: String
    let paramsJSON: String?
}

private actor RealtimeRelayStartupRequestLog {
    private var requests: [RealtimeRelayStartupRequest] = []

    func record(method: String, paramsJSON: String?) {
        self.requests.append(RealtimeRelayStartupRequest(method: method, paramsJSON: paramsJSON))
    }

    func snapshot() -> [RealtimeRelayStartupRequest] {
        self.requests
    }
}

struct RealtimeRelayCancellationCase: Sendable, CustomStringConvertible {
    let name: String
    let responseJSON: String?

    var description: String { self.name }
}

@MainActor
private final class RealtimeRelayCancellationObservations {
    var issues: [TalkRuntimeIssue] = []
    var statuses: [String] = []
}

@MainActor
private func waitForRealtimeRelayMainActorCheckpoint() async {
    await Task { @MainActor in }.value
}

@MainActor
private final class RealtimeRelayCancellationFixture {
    let requests: RealtimeRelayStartupRequestLog
    let observations: RealtimeRelayCancellationObservations
    let session: RealtimeTalkRelaySession
    private let closeStream: AsyncStream<Void>
    private let closeContinuation: AsyncStream<Void>.Continuation

    init(response: @escaping @Sendable () async throws -> Data) {
        let requests = RealtimeRelayStartupRequestLog()
        let observations = RealtimeRelayCancellationObservations()
        let (closeStream, closeContinuation) = AsyncStream<Void>.makeStream(
            bufferingPolicy: .bufferingNewest(1))
        let transport = RealtimeTalkRelaySession.StartupTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, paramsJSON, _ in
                await requests.record(method: method, paramsJSON: paramsJSON)
                if method == "talk.session.cancelOutput" {
                    return try await response()
                }
                if method == "talk.session.close" {
                    closeContinuation.yield()
                }
                return Data(#"{"ok":true}"#.utf8)
            })
        self.requests = requests
        self.observations = observations
        self.closeStream = closeStream
        self.closeContinuation = closeContinuation
        self.session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: "xai", model: nil, voice: nil),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { observations.statuses.append($0) },
            onIssue: { observations.issues.append($0) },
            onSpeakingChanged: { _ in },
            startupTransport: transport)
        self.session._test_setRelaySessionId("relay-1")
    }

    func output(_ turnId: String) async {
        await self.session._test_handleGatewayEvent(
            RealtimeTalkRelaySessionTests.audioEvent(turnId: turnId))
    }

    func waitForClose() async throws {
        try await AsyncTimeout.withTimeout(
            seconds: 2,
            onTimeout: { NSError(domain: "RealtimeTalkRelayTests", code: 1) })
        {
            for await _ in self.closeStream { return }
            throw CancellationError()
        }
    }

    func stop() {
        self.session.stop()
        self.closeContinuation.finish()
    }
}

@MainActor
struct RealtimeTalkRelayCancellationResultTests {
    @Test("invalid cancellation result closes the current relay", arguments: [
        RealtimeRelayCancellationCase(name: "malformed", responseJSON: "{"),
        RealtimeRelayCancellationCase(name: "ok false", responseJSON: #"{"ok":false}"#),
        RealtimeRelayCancellationCase(name: "unknown", responseJSON: #"{"ok":true,"status":"unknown"}"#),
        RealtimeRelayCancellationCase(name: "mismatch", responseJSON: #"{"ok":true,"turnId":"turn-b"}"#),
        RealtimeRelayCancellationCase(name: "request failure", responseJSON: nil),
    ])
    func invalidCancellationResultClosesCurrentRelay(
        testCase: RealtimeRelayCancellationCase) async throws
    {
        let fixture = RealtimeRelayCancellationFixture {
            guard let responseJSON = testCase.responseJSON else {
                throw URLError(.cannotConnectToHost)
            }
            return Data(responseJSON.utf8)
        }
        defer { fixture.stop() }
        await fixture.output("turn-a")

        #expect(fixture.session.cancelOutput(reason: "barge-in"))
        try await fixture.waitForClose()

        #expect(fixture.observations.issues.count == 1)
        #expect(fixture.observations.issues.first?.code == .realtimeUnavailable)
        #expect(fixture.observations.issues.first?.phase == "output-cancel")
        #expect(fixture.observations.statuses == fixture.observations.issues.map(\.displayMessage))
        #expect(await fixture.requests.snapshot().map(\.method) == [
            "talk.session.cancelOutput",
            "talk.session.close",
        ])
    }

    @Test("valid cancellation result preserves replacement output", arguments: [
        RealtimeRelayCancellationCase(name: "legacy", responseJSON: #"{"ok":true}"#),
        RealtimeRelayCancellationCase(name: "applied", responseJSON: #"{"ok":true,"status":"applied"}"#),
        RealtimeRelayCancellationCase(name: "stale", responseJSON: #"{"ok":true,"status":"stale"}"#),
        RealtimeRelayCancellationCase(name: "idle", responseJSON: #"{"ok":true,"status":"idle","turnId":"turn-a"}"#),
    ])
    func validCancellationResultPreservesReplacementOutput(
        testCase: RealtimeRelayCancellationCase) async throws
    {
        let barrier = RealtimeRelayStartupBarrier()
        let fixture = RealtimeRelayCancellationFixture {
            await barrier.suspend()
            guard let responseJSON = testCase.responseJSON else { throw CancellationError() }
            return Data(responseJSON.utf8)
        }
        defer { fixture.stop() }
        await fixture.output("turn-a")

        #expect(fixture.session.cancelOutput(reason: "barge-in"))
        await barrier.waitUntilEntered()
        await fixture.output("turn-b")
        await barrier.release()
        await waitForRealtimeRelayMainActorCheckpoint()

        #expect(fixture.session._test_isOutputPlaying())
        #expect(fixture.observations.issues.isEmpty)
        #expect(fixture.observations.statuses.isEmpty)
        #expect(await fixture.requests.snapshot().map(\.method) == ["talk.session.cancelOutput"])
    }

    @Test func `cancellation failure after stop cannot close the retired lifecycle`() async throws {
        let barrier = RealtimeRelayStartupBarrier()
        let fixture = RealtimeRelayCancellationFixture {
            await barrier.suspend()
            return Data("{".utf8)
        }
        defer { fixture.stop() }
        await fixture.output("turn-a")

        #expect(fixture.session.cancelOutput(reason: "barge-in"))
        await barrier.waitUntilEntered()
        fixture.session.stop()
        await barrier.release()
        await waitForRealtimeRelayMainActorCheckpoint()
        try await fixture.waitForClose()

        #expect(fixture.observations.issues.isEmpty)
        #expect(fixture.observations.statuses.isEmpty)
        #expect(await fixture.requests.snapshot().map(\.method) == [
            "talk.session.cancelOutput",
            "talk.session.close",
        ])
    }
}

@MainActor
struct RealtimeTalkRelaySessionTests {
    @Test func `delayed cancellation remains bound to the output turn it stopped`() async throws {
        let requestStarted = RealtimeRelayStartupBarrier()
        let requestRecorded = RealtimeRelayStartupBarrier()
        let requests = RealtimeRelayStartupRequestLog()
        let transport = RealtimeTalkRelaySession.StartupTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, paramsJSON, _ in
                if method == "talk.session.cancelOutput" {
                    await requestStarted.suspend()
                }
                await requests.record(method: method, paramsJSON: paramsJSON)
                if method == "talk.session.cancelOutput" {
                    await requestRecorded.suspend()
                }
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: "xai", model: nil, voice: nil),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in },
            startupTransport: transport)
        defer { session.stop() }
        session._test_setRelaySessionId("relay-1")

        await session._test_handleGatewayEvent(Self.audioEvent(turnId: "turn-a"))
        session.cancelOutput(reason: "barge-in")
        await requestStarted.waitUntilEntered()

        await session._test_handleGatewayEvent(Self.audioEvent(turnId: "turn-b"))
        await requestStarted.release()
        await requestRecorded.waitUntilEntered()
        await requestRecorded.release()

        let request = try #require(await requests.snapshot().first)
        let paramsData = try #require(request.paramsJSON?.data(using: .utf8))
        let params = try #require(JSONSerialization.jsonObject(with: paramsData) as? [String: String])
        #expect(request.method == "talk.session.cancelOutput")
        #expect(params["turnId"] == "turn-a")
    }

    @Test func `id less replacement cannot reuse the prior output turn`() async {
        let requests = RealtimeRelayStartupRequestLog()
        let transport = RealtimeTalkRelaySession.StartupTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, paramsJSON, _ in
                await requests.record(method: method, paramsJSON: paramsJSON)
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: "xai", model: nil, voice: nil),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in },
            startupTransport: transport)
        defer { session.stop() }
        session._test_setRelaySessionId("relay-1")

        await session._test_handleGatewayEvent(Self.audioEvent(turnId: "turn-a"))
        await session._test_handleGatewayEvent(Self.audioEvent(turnId: nil))

        #expect(session._test_isOutputPlaying())
        #expect(!session.cancelOutput(reason: "barge-in"))
        #expect(!session._test_isOutputPlaying())
        #expect(await requests.snapshot().isEmpty)
    }

    @Test func `output playback finish clears barge in start time`() {
        var speakingStates: [Bool] = []
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: nil, model: nil, voice: nil),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { speakingStates.append($0) })

        session._test_markOutputAudioStarted(nowMs: 100)
        #expect(session._test_isOutputPlaying())
        #expect(session._test_outputStartedAtMs() == 100)

        session._test_markOutputPlaybackFinished()
        #expect(!session._test_isOutputPlaying())
        #expect(session._test_outputStartedAtMs() == nil)
        #expect(speakingStates == [false])

        session._test_markOutputAudioStarted(nowMs: 500)
        #expect(session._test_outputStartedAtMs() == 500)
    }

    @Test func `playback mark is acknowledged after output finishes`() async throws {
        let requests = RealtimeRelayStartupRequestLog()
        let transport = RealtimeTalkRelaySession.StartupTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, paramsJSON, _ in
                await requests.record(method: method, paramsJSON: paramsJSON)
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: "xai", model: nil, voice: nil),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in },
            startupTransport: transport)
        session._test_setRelaySessionId("relay-1")
        session._test_markOutputAudioStarted(nowMs: 100)

        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "mark",
                "markName": "audio-1",
            ]),
            seq: nil,
            stateversion: nil))
        await Task.yield()
        #expect(await requests.snapshot().isEmpty)

        session._test_markOutputPlaybackFinished()
        for _ in 0..<10 {
            if !(await requests.snapshot()).isEmpty { break }
            await Task.yield()
        }

        let recorded = await requests.snapshot()
        #expect(recorded.count == 1)
        let request = try #require(recorded.first)
        #expect(request.method == "talk.session.acknowledgeMark")
        let paramsData = try #require(request.paramsJSON?.data(using: .utf8))
        let params = try #require(JSONSerialization.jsonObject(with: paramsData) as? [String: String])
        #expect(params == ["sessionId": "relay-1", "markName": "audio-1"])
    }

    @Test func `close after classified error does not replace issue`() async {
        var issues: [TalkRuntimeIssue] = []
        var statuses: [String] = []
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onIssue: { issues.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")

        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "error",
                "message": "OpenAI API key rejected with 401",
                "code": "realtime_unavailable",
                "provider": "openai",
                "model": "gpt-realtime-2",
                "transport": "gateway-relay",
                "phase": "connect",
            ]),
            seq: nil,
            stateversion: nil))
        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "close",
                "reason": "error",
            ]),
            seq: nil,
            stateversion: nil))

        #expect(issues.map(\.code) == [.realtimeUnavailable])
        #expect(statuses == ["OpenAI API key rejected with 401"])
    }

    @Test func `closed relay does not wait for startup ready`() async {
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })

        session.stop()

        #expect(await session._test_waitForStartupCancelled(timeoutSeconds: 1))
    }

    @Test func `startup ready wait covers gateway connect budget`() {
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })

        #expect(session._test_startupReadyTimeoutSeconds() >= 12)
    }

    @Test func `stop during event subscription prevents relay creation`() async throws {
        let barrier = RealtimeRelayStartupBarrier()
        let requests = RealtimeRelayStartupRequestLog()
        var statuses: [String] = []
        var speakingStates: [Bool] = []
        let transport = RealtimeTalkRelaySession.StartupTransport(
            subscribeServerEvents: { _ in
                await barrier.suspend()
                return AsyncStream { $0.finish() }
            },
            request: { method, paramsJSON, _ in
                await requests.record(method: method, paramsJSON: paramsJSON)
                throw URLError(.badServerResponse)
            })
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onSpeakingChanged: { speakingStates.append($0) },
            startupTransport: transport)
        let start = Task { @MainActor in try await session.start() }
        await barrier.waitUntilEntered()

        session.stop()
        await barrier.release()
        try await start.value

        #expect(await requests.snapshot().isEmpty)
        #expect(statuses == ["Connecting realtime…"])
        #expect(!speakingStates.contains(true))
    }

    @Test func `stop during relay creation closes late session once`() async throws {
        let barrier = RealtimeRelayStartupBarrier()
        let requests = RealtimeRelayStartupRequestLog()
        var statuses: [String] = []
        var speakingStates: [Bool] = []
        let result = TalkSessionCreateResult(
            sessionid: "talk-session",
            mode: AnyCodable("realtime"),
            transport: AnyCodable("gateway-relay"),
            brain: AnyCodable("agent-consult"),
            relaysessionid: "relay-1")
        let resultData = try JSONEncoder().encode(result)
        let transport = RealtimeTalkRelaySession.StartupTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, paramsJSON, _ in
                await requests.record(method: method, paramsJSON: paramsJSON)
                if method == "talk.session.create" {
                    await barrier.suspend()
                    return resultData
                }
                return Data("{}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onSpeakingChanged: { speakingStates.append($0) },
            startupTransport: transport)
        let start = Task { @MainActor in try await session.start() }
        await barrier.waitUntilEntered()

        session.stop()
        await barrier.release()
        try await start.value

        let recorded = await requests.snapshot()
        #expect(recorded.map(\.method) == ["talk.session.create", "talk.session.close"])
        let closeJSON = try #require(recorded.last?.paramsJSON?.data(using: .utf8))
        let closeParams = try #require(JSONSerialization.jsonObject(with: closeJSON) as? [String: String])
        #expect(closeParams["sessionId"] == "relay-1")
        #expect(!statuses.contains("Waiting for realtime…"))
        #expect(!speakingStates.contains(true))
    }

    @Test func `stop during buffered tool call prevents late relay side effects`() async {
        let barrier = RealtimeRelayStartupBarrier()
        let requests = RealtimeRelayStartupRequestLog()
        var statuses: [String] = []
        let transport = RealtimeTalkRelaySession.StartupTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, paramsJSON, _ in
                await requests.record(method: method, paramsJSON: paramsJSON)
                if method == "talk.client.toolCall" {
                    await barrier.suspend()
                    return Data("{\"runId\":\"run-1\"}".utf8)
                }
                return Data("{}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { statuses.append($0) },
            onSpeakingChanged: { _ in },
            startupTransport: transport)
        session._test_setRelaySessionId("relay-1")
        let handling = Task { @MainActor in
            await session._test_handleGatewayEvent(EventFrame(
                type: "event",
                event: "talk.event",
                payload: AnyCodable([
                    "relaySessionId": "relay-1",
                    "type": "toolCall",
                    "callId": "call-1",
                    "name": "lookup",
                    "args": [:],
                ]),
                seq: nil,
                stateversion: nil))
        }
        await barrier.waitUntilEntered()

        session.stop()
        await barrier.release()
        await handling.value
        await session._test_waitForToolCalls()

        let methods = await requests.snapshot().map(\.method)
        #expect(methods.first == "talk.client.toolCall")
        #expect(!methods.contains("talk.session.submitToolResult"))
        #expect(statuses == ["Thinking…"])
    }

    @Test func `stop cancels buffered microphone audio before dispatch`() async throws {
        let requests = RealtimeRelayStartupRequestLog()
        let transport = RealtimeTalkRelaySession.StartupTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, paramsJSON, _ in
                await requests.record(method: method, paramsJSON: paramsJSON)
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            gateway: GatewayNodeSession(),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            pcmPlayer: UnusedPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in },
            startupTransport: transport)
        session._test_prepareAudioSender(relaySessionId: "relay-1")
        let send = try #require(session._test_enqueueMicrophoneFrame(Data([0x01, 0x02])))

        session.stop()
        await send.value

        #expect(await requests.snapshot().isEmpty)
    }

    fileprivate static func audioEvent(turnId: String?) -> EventFrame {
        var payload: [String: Any] = [
            "relaySessionId": "relay-1",
            "type": "audio",
            "audioBase64": Data([0x01, 0x02]).base64EncodedString(),
        ]
        if let turnId {
            payload["talkEvent"] = ["turnId": turnId]
        }
        return EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable(payload),
            seq: nil,
            stateversion: nil)
    }
}
