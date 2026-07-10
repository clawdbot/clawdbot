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

@MainActor
struct RealtimeTalkRelaySessionTests {
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
}
