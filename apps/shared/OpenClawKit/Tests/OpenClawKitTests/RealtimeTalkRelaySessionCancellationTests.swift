import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawKit

@MainActor
struct RealtimeTalkRelaySessionCancellationTests {
    private func makeIdleCancellationSession(
        _ onSpeakingChanged: @escaping (Bool) -> Void) -> RealtimeTalkRelaySession
    {
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { _, _, _ in Data("{\"ok\":true}".utf8) })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: onSpeakingChanged)
        session._test_setRelaySessionId("relay-1")
        return session
    }

    @Test func `output cancellation fences delayed audio and preserves exact identity`() async throws {
        let requests = RealtimeRelayStartupRequestLog()
        var speakingStates: [Bool] = []
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { speakingStates.append($0) })
        session._test_setRelaySessionId("relay-1")

        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-7"))
        await session._test_handleGatewayEvent(playbackMarkEvent("cancelled-output"))
        session.cancelOutput(reason: "barge-in")
        try await requests.waitForRequestCount(1)
        let request = try #require(await requests.snapshot().first)
        #expect(request.method == "talk.session.cancelOutput")
        #expect(request.params?["sessionId"]?.stringValue == "relay-1")
        #expect(request.params?["turnId"]?.stringValue == "turn-7")
        #expect(request.params?["reason"]?.stringValue == "barge-in")

        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-7"))
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-8"))
        #expect(speakingStates.first == true)
        #expect(!speakingStates.dropFirst().contains(true))
        await session._test_handleGatewayEvent(outputClearEvent(turnId: "turn-8"))
        #expect(await requests.snapshot().count == 1)
        await session._test_handleGatewayEvent(outputClearEvent(turnId: "turn-7"))
        try await requests.waitForRequestCount(2)
        let acknowledgements = await requests.snapshot().filter {
            $0.method == "talk.session.acknowledgeMark"
        }
        #expect(acknowledgements.count == 1)
        #expect(acknowledgements.first?.params?["markName"]?.stringValue == "cancelled-output")
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-7"))
        #expect(speakingStates == [true, false])
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-8"))
        #expect(speakingStates == [true, false, true])
        await session._test_handleGatewayEvent(outputClearEvent(turnId: "turn-7"))
        #expect(await requests.snapshot().filter {
            $0.method == "talk.session.acknowledgeMark"
        }.count == 1)
        #expect(speakingStates == [true, false, true])
        await session._test_handleGatewayEvent(outputClearEvent(turnId: "turn-8"))
        #expect(speakingStates == [true, false, true, false])
    }

    @Test func `idle cancellation and pause retain the relay without false interruption`() async {
        let requests = RealtimeRelayStartupRequestLog()
        var speakingStates: [Bool] = []
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { speakingStates.append($0) })
        session._test_setRelaySessionId("relay-1")

        session.setOutputPaused(true)
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-1"))
        #expect(speakingStates.isEmpty)
        #expect(await requests.snapshot().isEmpty)
        session.setOutputPaused(false)
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-2"))
        #expect(speakingStates == [true])
        #expect(await requests.snapshot().isEmpty)
    }

    @Test(arguments: ["stale", "idle"])
    func `non applied cancellation retires the wait without reopening the old turn`(
        status: String) async throws
    {
        let barrier = RealtimeRelayStartupBarrier()
        let speakingChanged = RealtimeRelayTestSignal<Bool>()
        var speakingStates: [Bool] = []
        let requests = RealtimeRelayStartupRequestLog()
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                request: { method, params, _ in
                    await requests.record(method: method, params: params)
                    await barrier.suspend()
                    return Data("{\"ok\":true,\"status\":\"\(status)\"}".utf8)
                }),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: {
                speakingStates.append($0)
                speakingChanged.send($0)
            })
        defer { session.stop() }
        session._test_setRelaySessionId("relay-1")
        session._test_prepareAudioSender(relaySessionId: "relay-1")
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-1"))
        await session._test_handleGatewayEvent(playbackMarkEvent("cancelled-output"))
        var successor: Task<Void, Never>?
        do {
            #expect(try await speakingChanged.next("initial output") == true)

            #expect(session.cancelOutput())
            let cancellationTask = try #require(session._test_outputCancellationTask())
            #expect(try await speakingChanged.next("cancellation fence") == false)
            try await barrier.waitUntilEntered()
            #expect(await requests.snapshot().map(\.method) == ["talk.session.cancelOutput"])
            #expect(session._test_enqueueMicrophoneFrame(Data([0x01])) == nil)
            await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-2"))
            #expect(speakingStates == [true, false])

            await barrier.release()
            await cancellationTask.value
            try await requests.waitForRequestCount(2)
            let acknowledgements = await requests.snapshot().filter {
                $0.method == "talk.session.acknowledgeMark"
            }
            #expect(acknowledgements.count == 1)
            #expect(acknowledgements.first?.params?["markName"]?.stringValue == "cancelled-output")
            await session._test_handleGatewayEvent(outputClearEvent(turnId: "turn-1"))
            await session._test_handleGatewayEvent(outputClearEvent(turnId: "turn-1"))
            #expect(await requests.snapshot().filter {
                $0.method == "talk.session.acknowledgeMark"
            }.count == 1)
            await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-1"))
            successor = Task { @MainActor in
                await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-2"))
            }
            #expect(try await speakingChanged.next("successor output") == true)
            await successor?.value
        } catch {
            await barrier.release()
            successor?.cancel()
            await successor?.value
            throw error
        }

        #expect(speakingStates == [true, false, true])
    }

    @Test func `cancellation without active identified output is a no-op`() async {
        var speakingStates: [Bool] = []
        let session = self.makeIdleCancellationSession { speakingStates.append($0) }
        #expect(!session.cancelOutput(reason: "barge-in"))
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-1"))
        #expect(speakingStates == [true])

        var unfencedStates: [Bool] = []
        let unfenced = RealtimeTalkRelaySession(
            transport: unusedRealtimeRelayTransport(),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { unfencedStates.append($0) })
        #expect(!unfenced.cancelOutput())
        unfenced._test_setRelaySessionId("relay-1")
        await unfenced._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-1"))
        #expect(unfencedStates == [true])
    }

    @Test func `active output pause cancels the exact turn`() async throws {
        let requests = RealtimeRelayStartupRequestLog()
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                request: { method, params, _ in
                    await requests.record(method: method, params: params)
                    return Data("{\"ok\":true}".utf8)
                }),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")
        await session._test_handleGatewayEvent(EventFrame(
            type: "event",
            event: "talk.event",
            payload: AnyCodable([
                "relaySessionId": "relay-1",
                "type": "audio",
                "audioBase64": Data([0x01]).base64EncodedString(),
                "talkEvent": ["turnId": "turn-7"],
            ]),
            seq: nil,
            stateversion: nil))

        session.setOutputPaused(true)
        try await requests.waitForRequestCount(1)
        let request = try #require(await requests.snapshot().first)
        #expect(request.params?["turnId"]?.stringValue == "turn-7")
        #expect(request.params?["reason"]?.stringValue == "pause")
    }

    @Test func `current cancellation failure terminates and rejects late audio`() async throws {
        let requests = RealtimeRelayStartupRequestLog()
        let issueObserved = RealtimeRelayTestSignal<RealtimeTalkRelayIssue>()
        let terminationObserved = RealtimeRelayTestSignal<RealtimeTalkRelayTermination>()
        var issues: [RealtimeTalkRelayIssue] = []
        var terminations: [RealtimeTalkRelayTermination] = []
        var speakingStates: [Bool] = []
        let cancellationError = URLError(.cannotConnectToHost)
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                if method == "talk.session.cancelOutput" {
                    throw cancellationError
                }
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onIssue: {
                issues.append($0)
                issueObserved.send($0)
            },
            onTermination: {
                terminations.append($0)
                terminationObserved.send($0)
            },
            onSpeakingChanged: { speakingStates.append($0) })
        session._test_setRelaySessionId("relay-1")
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-1"))

        session.cancelOutput()
        _ = try await issueObserved.next("output cancellation issue")
        #expect(try await terminationObserved.next("output cancellation termination") == .outputCancellationFailed)
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-2"))
        try await requests.waitForRequestCount(2)

        #expect(issues.map(\.code) == ["realtime_output_cancel_failed"])
        #expect(issues.map(\.phase) == ["output-cancel"])
        #expect(issues.first?.message == String(
            format: String(localized: "Realtime output cancellation failed: %@"),
            cancellationError.localizedDescription))
        #expect(terminations == [.outputCancellationFailed])
        #expect(await requests.snapshot().map(\.method) == [
            "talk.session.cancelOutput",
            "talk.session.close",
        ])
        #expect(speakingStates.first == true)
        #expect(!speakingStates.dropFirst().contains(true))
    }

    @Test(arguments: [
        #"{"ok":true,"turnId":"turn-2"}"#,
        #"{"ok":true,"status":"applied","turnId":"turn-2"}"#,
    ])
    func `accepted cancellation result with mismatched turn fails closed`(
        response: String) async throws
    {
        let issueObserved = RealtimeRelayTestSignal<RealtimeTalkRelayIssue>()
        let terminationObserved = RealtimeRelayTestSignal<RealtimeTalkRelayTermination>()
        let requests = RealtimeRelayStartupRequestLog()
        var issues: [RealtimeTalkRelayIssue] = []
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                request: { method, params, _ in
                    await requests.record(method: method, params: params)
                    return method == "talk.session.cancelOutput"
                        ? Data(response.utf8)
                        : Data(#"{"ok":true}"#.utf8)
                }),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onIssue: {
                issues.append($0)
                issueObserved.send($0)
            },
            onTermination: { terminationObserved.send($0) },
            onSpeakingChanged: { _ in })
        defer { session.stop() }
        session._test_setRelaySessionId("relay-1")
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-1"))

        #expect(session.cancelOutput())
        let issue = try await issueObserved.next("mismatched cancellation issue")
        #expect(try await terminationObserved.next("mismatched cancellation termination") == .outputCancellationFailed)
        try await requests.waitForRequestCount(2)

        #expect(issue.code == "realtime_output_cancel_failed")
        #expect(issue.phase == "output-cancel")
        #expect(issues.count == 1)
        #expect(await requests.snapshot().map(\.method) == [
            "talk.session.cancelOutput",
            "talk.session.close",
        ])
    }

    @Test func `superseded cancellation failure leaves the active fence intact`() async throws {
        let barrier = RealtimeRelayStartupBarrier()
        let requests = RealtimeRelayStartupRequestLog()
        var issues: [RealtimeTalkRelayIssue] = []
        var speakingStates: [Bool] = []
        let transport = RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                if await requests.snapshot().count == 1 {
                    await barrier.suspend()
                    throw URLError(.cancelled)
                }
                return Data("{\"ok\":true}".utf8)
            })
        let session = RealtimeTalkRelaySession(
            transport: transport,
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onIssue: { issues.append($0) },
            onSpeakingChanged: { speakingStates.append($0) })
        session._test_setRelaySessionId("relay-1")
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-1"))

        #expect(session.cancelOutput())
        let staleCancellationTask = try #require(session._test_outputCancellationTask())
        try await barrier.waitUntilEntered()
        await session._test_handleGatewayEvent(outputClearEvent(turnId: "turn-1"))
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-2"))
        #expect(session.cancelOutput())
        await barrier.release()
        await staleCancellationTask.value
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-1"))

        #expect(issues.isEmpty)
        #expect(await requests.snapshot().count == 2)
        #expect(speakingStates == [true, false, true, false])
    }

    @Test func `clear keeps microphone fenced until cancellation response`() async throws {
        let barrier = RealtimeRelayStartupBarrier()
        let requests = RealtimeRelayStartupRequestLog()
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                request: { method, params, _ in
                    await requests.record(method: method, params: params)
                    if method == "talk.session.cancelOutput" {
                        await barrier.suspend()
                        return Data("{\"ok\":true,\"status\":\"applied\",\"turnId\":\"turn-1\"}".utf8)
                    }
                    return Data("{\"ok\":true}".utf8)
                }),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")
        session._test_prepareAudioSender(relaySessionId: "relay-1")
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-1"))
        #expect(session.cancelOutput())
        let cancellationTask = try #require(session._test_outputCancellationTask())
        try await barrier.waitUntilEntered()
        await session._test_handleGatewayEvent(outputClearEvent(turnId: "turn-1"))

        #expect(session._test_enqueueMicrophoneFrame(Data([0x01])) == nil)
        await barrier.release()
        await cancellationTask.value
        let admittedTask = try #require(session._test_enqueueMicrophoneFrame(Data([0x02])))
        await admittedTask.value
        #expect(await requests.snapshot().map(\.method) == [
            "talk.session.cancelOutput",
            "talk.session.appendAudio",
        ])
    }

    @Test(arguments: [
        #"{"ok":true}"#,
        #"{"ok":true,"status":"applied","turnId":"turn-1"}"#,
    ], [false, true])
    func `accepted cancellation response keeps fence until matching clear`(
        response: String, providerClearBeforeResponse: Bool) async throws
    {
        let barrier = RealtimeRelayStartupBarrier()
        var speakingStates: [Bool] = []
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                request: { method, _, _ in
                    if method == "talk.session.cancelOutput" {
                        await barrier.suspend()
                        return Data(response.utf8)
                    }
                    return Data(#"{"ok":true}"#.utf8)
                }),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { speakingStates.append($0) })
        defer { session.stop() }
        session._test_setRelaySessionId("relay-1")
        session._test_prepareAudioSender(relaySessionId: "relay-1")
        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-1"))
        #expect(session.cancelOutput())
        let cancellationTask = try #require(session._test_outputCancellationTask())
        do {
            try await barrier.waitUntilEntered()
            if !providerClearBeforeResponse {
                await barrier.release()
                await cancellationTask.value
            }
            await session._test_handleGatewayEvent(outputClearEvent())
            await session._test_handleGatewayEvent(outputClearEvent(
                turnId: "turn-1", talkEventType: "output.audio.done"))
            if providerClearBeforeResponse {
                await barrier.release()
                await cancellationTask.value
            }
            #expect(session._test_enqueueMicrophoneFrame(Data([0x01])) == nil)
            await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-2"))
            #expect(speakingStates == [true, false])

            await session._test_handleGatewayEvent(outputClearEvent(turnId: "turn-1"))
            let admittedTask = try #require(session._test_enqueueMicrophoneFrame(Data([0x02])))
            await admittedTask.value
            await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-2"))
        } catch {
            await barrier.release()
            throw error
        }
        #expect(speakingStates == [true, false, true])
    }

    @Test func `close retires in flight cancellation failure`() async throws {
        let barrier = RealtimeRelayStartupBarrier()
        var issues: [RealtimeTalkRelayIssue] = []
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                request: { method, _, _ in
                    if method == "talk.session.cancelOutput" {
                        await barrier.suspend()
                        throw URLError(.cancelled)
                    }
                    return Data("{\"ok\":true}".utf8)
                }),
            options: .init(sessionKey: "main", provider: "openai", model: nil, voice: nil),
            audioCapture: TestRealtimeTalkAudioCapture(),
            pcmPlayer: DrainingPCMStreamingAudioPlayer(),
            onStatus: { _ in },
            onIssue: { issues.append($0) },
            onSpeakingChanged: { _ in })
        session._test_setRelaySessionId("relay-1")

        await session._test_handleGatewayEvent(outputAudioEvent(turnId: "turn-1"))
        #expect(session.cancelOutput())
        let cancellationTask = try #require(session._test_outputCancellationTask())
        do {
            try await barrier.waitUntilEntered()
            session.stop()
            await barrier.release()
            await cancellationTask.value
        } catch {
            session.stop()
            await barrier.release()
            throw error
        }

        #expect(issues.isEmpty)
    }
}
