import Foundation
import OpenClawProtocol
import Speech
import Testing
@testable import OpenClaw
@testable import OpenClawKit

private enum RuntimeTestAudioCaptureError: Error {
    case inputUnavailable
}

private struct RuntimeTestTimeout: Error, CustomStringConvertible {
    let operation: String

    var description: String {
        "timed out waiting for \(self.operation)"
    }
}

private final class RuntimeTestSignal<Value: Sendable>: @unchecked Sendable {
    private struct Waiter {
        let id: UUID
        let continuation: CheckedContinuation<Value, any Error>
        var deadline: Task<Void, Never>?
    }

    private let lock = NSLock()
    private var values: [Value] = []
    private var waiters: [Waiter] = []

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
                let result: Result<Value, any Error>? = self.lock.withLock {
                    if Task.isCancelled {
                        return .failure(CancellationError())
                    }
                    if !self.values.isEmpty {
                        return .success(self.values.removeFirst())
                    }
                    self.waiters.append(Waiter(id: id, continuation: continuation))
                    return nil
                }
                if let result {
                    continuation.resume(with: result)
                    return
                }
                let deadline = Task {
                    do {
                        try await Task.sleep(for: .seconds(5))
                        self.fail(id, with: RuntimeTestTimeout(operation: operation))
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
            self.fail(id, with: CancellationError())
        }
    }

    private func fail(_ id: UUID, with error: any Error) {
        let waiter: Waiter? = self.lock.withLock {
            guard let index = self.waiters.firstIndex(where: { $0.id == id }) else {
                return nil
            }
            return self.waiters.remove(at: index)
        }
        self.resume(waiter, with: .failure(error))
    }

    private func resume(_ waiter: Waiter?, with result: Result<Value, any Error>) {
        guard let waiter else { return }
        waiter.deadline?.cancel()
        waiter.continuation.resume(with: result)
    }
}

@MainActor
private final class RuntimeTestAudioCapture: RealtimeTalkAudioCapturing {
    let suppressesInputDuringOutput = false
    var startError: Error?
    private(set) var startCount = 0

    func start(
        targetSampleRate: Double,
        onAudio: @escaping @Sendable (RealtimeTalkAudioFrame) -> Void,
        onFailure: @escaping @MainActor (String) -> Void) throws
    {
        self.startCount += 1
        if let startError = self.startError {
            throw startError
        }
    }

    func stop() {}
}

private actor RuntimeTestRelayRequestLog {
    private var methods: [String] = []
    private var sessionIds: [String?] = []
    private nonisolated let changed = RuntimeTestSignal<Void>()

    func record(method: String, params: [String: AnyCodable]?) {
        self.methods.append(method)
        self.sessionIds.append(params?["sessionId"]?.stringValue)
        self.changed.send(())
    }

    func snapshot() -> (methods: [String], sessionIds: [String?]) {
        (self.methods, self.sessionIds)
    }

    func waitForCount(_ count: Int) async throws {
        while self.methods.count < count {
            _ = try await self.changed.next("relay request \(count)")
        }
    }
}

/// Relay whose close RPC is observable, so runtime termination paths can be proven to release the
/// server-side session instead of only dropping their local reference.
@MainActor
private func makeRecordingRelaySession(
    requests: RuntimeTestRelayRequestLog,
    audioCapture: RuntimeTestAudioCapture) -> RealtimeTalkRelaySession
{
    let session = RealtimeTalkRelaySession(
        transport: RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { method, params, _ in
                await requests.record(method: method, params: params)
                return Data("{\"ok\":true}".utf8)
            }),
        options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
        audioCapture: audioCapture,
        pcmPlayer: RuntimeTestPCMPlayer(),
        onStatus: { _ in },
        onSpeakingChanged: { _ in })
    session._test_setRelaySessionId("relay-1")
    return session
}

private func waitForRelayClose(_ requests: RuntimeTestRelayRequestLog) async throws -> [String] {
    try await requests.waitForCount(1)
    return await requests.snapshot().methods
}

@MainActor
private final class RuntimeTestPCMPlayer: PCMStreamingAudioPlaying {
    private(set) var stopCount = 0
    private let onStop: (() -> Void)?

    init(onStop: (() -> Void)? = nil) {
        self.onStop = onStop
    }

    func play(
        stream: AsyncThrowingStream<Data, Error>,
        sampleRate: Double) async -> StreamingPlaybackResult
    {
        fatalError("Playback is not used by this test")
    }

    func stop() -> Double? {
        self.stopCount += 1
        self.onStop?()
        return nil
    }
}

private actor RuntimeContinuationBarrier {
    private var entered = false
    private var released = false
    private nonisolated let enteredSignal = RuntimeTestSignal<Void>()
    private nonisolated let releaseSignal = RuntimeTestSignal<Void>()

    func wait() async throws {
        self.entered = true
        self.enteredSignal.send(())
        guard !self.released else { return }
        do {
            _ = try await self.releaseSignal.next("barrier release")
        } catch {
            self.release()
            throw error
        }
    }

    func waitUntilEntered() async throws {
        if self.entered { return }
        _ = try await self.enteredSignal.next("barrier entry")
    }

    func release() {
        guard !self.released else { return }
        self.released = true
        self.releaseSignal.send(())
    }
}

private func waitForRuntimeBarrier(
    _ barrier: RuntimeContinuationBarrier,
    cleaningUp attempt: Task<Bool, Never>) async throws
{
    do {
        try await barrier.waitUntilEntered()
    } catch {
        attempt.cancel()
        await barrier.release()
        _ = try? await AsyncTimeout.withTimeout(
            seconds: 5,
            onTimeout: { RuntimeTestTimeout(operation: "cancelled runtime attempt") },
            operation: { await attempt.value })
        throw error
    }
}

private final class RuntimeCommitProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var recordedValues: [String] = []

    func record(_ value: String) {
        self.lock.withLock {
            self.recordedValues.append(value)
        }
    }

    func values() -> [String] {
        self.lock.withLock { self.recordedValues }
    }
}

private final class RuntimeRecognitionCapture {
    let name: String

    init(_ name: String) {
        self.name = name
    }
}

private enum RuntimeRecognitionStartError: Error {
    case failed
}

private enum RuntimeRelayStartError: Error {
    case failed
}

private struct RuntimeConditionTimeout: Error, CustomStringConvertible {
    let operation: String

    var description: String {
        "timed out waiting for \(self.operation)"
    }
}

private func waitForRuntimeCondition(
    _ operation: String,
    condition: @escaping @Sendable () async -> Bool) async throws
{
    try await AsyncTimeout.withTimeout(
        seconds: 1,
        onTimeout: { RuntimeConditionTimeout(operation: operation) },
        operation: {
            while !Task.isCancelled {
                if await condition() {
                    return
                }
            }
            throw CancellationError()
        })
}

enum RuntimeRelayStartupPauseOutcome: Equatable {
    case resume
    case remainPaused
    case disable
}

@MainActor
private func makeRuntimeTestRealtimeSession(
    player: RuntimeTestPCMPlayer) -> RealtimeTalkRelaySession
{
    RealtimeTalkRelaySession(
        transport: RealtimeTalkRelayTransport(
            subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
            request: { _, _, _ in Data("{\"ok\":true}".utf8) }),
        options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
        audioCapture: RuntimeTestAudioCapture(),
        pcmPlayer: player,
        onStatus: { _ in },
        onSpeakingChanged: { _ in })
}

private func makeRuntimeTestConfigSnapshot(
    sessionKey: String = "main",
    realtimeModel: String = "gpt-realtime-2") -> ConfigSnapshot
{
    ConfigSnapshot(
        path: nil,
        exists: true,
        raw: nil,
        hash: nil,
        parsed: nil,
        valid: true,
        config: [
            "session": AnyCodable(["mainKey": AnyCodable(sessionKey)]),
            "talk": AnyCodable([
                "realtime": AnyCodable([
                    "provider": AnyCodable("openai"),
                    "providers": AnyCodable([
                        "openai": AnyCodable([
                            "model": AnyCodable(realtimeModel),
                        ]),
                    ]),
                    "mode": AnyCodable("realtime"),
                    "transport": AnyCodable("gateway-relay"),
                    "brain": AnyCodable("agent-consult"),
                ]),
            ]),
        ],
        issues: nil)
}

private func makeRuntimeTestBootstrap(
    requests: RuntimeTestRelayRequestLog = RuntimeTestRelayRequestLog(),
    createBarrier: RuntimeContinuationBarrier? = nil,
    probe: RuntimeCommitProbe? = nil,
    sessionKey: String = "main",
    realtimeModel: String = "gpt-realtime-2") throws -> GatewayConnection.RealtimeTalkBootstrap
{
    let events = AsyncStream<EventFrame>.makeStream(bufferingPolicy: .bufferingNewest(8))
    let result = TalkSessionCreateResult(
        sessionid: "talk-session",
        mode: AnyCodable("realtime"),
        transport: AnyCodable("gateway-relay"),
        brain: AnyCodable("agent-consult"),
        relaysessionid: "relay-1")
    let resultData = try JSONEncoder().encode(result)
    let transport = RealtimeTalkRelayTransport(
        subscribeServerEvents: { _ in events.stream },
        request: { method, params, _ in
            await requests.record(method: method, params: params)
            if method == "talk.session.create" {
                probe?.record("start")
                if let createBarrier {
                    try await createBarrier.wait()
                }
                events.continuation.yield(EventFrame(
                    type: "event",
                    event: "talk.event",
                    payload: AnyCodable([
                        "relaySessionId": "relay-1",
                        "type": "ready",
                    ]),
                    seq: nil,
                    stateversion: nil))
                return resultData
            }
            if method == "talk.session.close" {
                events.continuation.finish()
            }
            return Data("{\"ok\":true}".utf8)
        },
        isCurrent: { true })
    return GatewayConnection.RealtimeTalkBootstrap(
        transport: transport,
        configSnapshot: makeRuntimeTestConfigSnapshot(
            sessionKey: sessionKey,
            realtimeModel: realtimeModel),
        sessionKey: sessionKey)
}

private actor RuntimeTestBootstrapSequence {
    private var bootstraps: [GatewayConnection.RealtimeTalkBootstrap]
    private let firstBarrier: RuntimeContinuationBarrier?
    private var count = 0

    init(
        bootstraps: [GatewayConnection.RealtimeTalkBootstrap],
        firstBarrier: RuntimeContinuationBarrier? = nil)
    {
        self.bootstraps = bootstraps
        self.firstBarrier = firstBarrier
    }

    func next() async throws -> GatewayConnection.RealtimeTalkBootstrap {
        let index = self.count
        self.count += 1
        if index == 0, let firstBarrier {
            try await firstBarrier.wait()
        }
        guard self.bootstraps.indices.contains(index) else {
            throw RuntimeRelayStartError.failed
        }
        return self.bootstraps[index]
    }

    func requestCount() -> Int {
        self.count
    }
}

@Suite(.serialized)
struct TalkModeRuntimeSpeechTests {
    @Test func `macOS realtime relay requires local opt in and exact Gateway tuple`() {
        #expect(!TalkModeRuntime.shouldUseRealtimeRelay(
            localOptIn: false,
            hasGatewayRealtimeRelayTuple: false))
        #expect(!TalkModeRuntime.shouldUseRealtimeRelay(
            localOptIn: false,
            hasGatewayRealtimeRelayTuple: true))
        #expect(!TalkModeRuntime.shouldUseRealtimeRelay(
            localOptIn: true,
            hasGatewayRealtimeRelayTuple: false))
        #expect(TalkModeRuntime.shouldUseRealtimeRelay(
            localOptIn: true,
            hasGatewayRealtimeRelayTuple: true))
    }

    @Test @MainActor func `macOS realtime relay preference defaults off and reads explicit opt in`() async {
        await TestIsolation.withUserDefaultsValues([talkRealtimeRelayEnabledKey: nil]) {
            #expect(!AppState(preview: true).talkRealtimeRelayEnabled)
        }
        await TestIsolation.withUserDefaultsValues([talkRealtimeRelayEnabledKey: true]) {
            #expect(AppState(preview: true).talkRealtimeRelayEnabled)
        }
    }

    @Test func `speech request uses dictation defaults`() {
        let request = SFSpeechAudioBufferRecognitionRequest()

        TalkRecognitionCaptureLifecycle.configure(request)

        #expect(request.shouldReportPartialResults)
        #expect(request.taskHint == .dictation)
        #expect(!request.requiresOnDeviceRecognition)
    }

    @Test func `playback plan routes unsupported local providers through gateway speak`() {
        let elevenLabsPlan = TalkModeRuntime.playbackPlan(
            provider: "elevenlabs",
            apiKey: "key",
            voiceId: "voice")
        let missingKeyPlan = TalkModeRuntime.playbackPlan(
            provider: "elevenlabs",
            apiKey: nil,
            voiceId: "voice")
        let missingVoicePlan = TalkModeRuntime.playbackPlan(
            provider: "elevenlabs",
            apiKey: "key",
            voiceId: nil)
        let blankKeyPlan = TalkModeRuntime.playbackPlan(
            provider: "elevenlabs",
            apiKey: "",
            voiceId: "voice")
        let openAIPlan = TalkModeRuntime.playbackPlan(provider: "openai", apiKey: nil, voiceId: "onyx")
        let customPlan = TalkModeRuntime.playbackPlan(provider: "acme-speech", apiKey: nil, voiceId: nil)
        let mlxPlan = TalkModeRuntime.playbackPlan(provider: "mlx", apiKey: nil, voiceId: nil)
        let systemPlan = TalkModeRuntime.playbackPlan(provider: "system", apiKey: nil, voiceId: nil)

        #expect(elevenLabsPlan == .elevenLabsThenSystemVoice(apiKey: "key", voiceId: "voice"))
        #expect(missingKeyPlan == .systemVoiceOnly)
        #expect(missingVoicePlan == .systemVoiceOnly)
        #expect(blankKeyPlan == .systemVoiceOnly)
        #expect(openAIPlan == .gatewayTalkSpeakThenSystemVoice)
        #expect(customPlan == .gatewayTalkSpeakThenSystemVoice)
        #expect(mlxPlan == .mlxThenSystemVoice)
        #expect(systemPlan == .systemVoiceOnly)
    }

    @Test func `mlx cancellation stops while failures preserve system fallback`() {
        #expect(TalkModeRuntime.mlxFailureDisposition(
            TalkMLXSpeechSynthesizer.SynthesizeError.canceled) == .canceled)
        #expect(TalkModeRuntime.mlxFailureDisposition(
            TalkMLXSpeechSynthesizer.SynthesizeError.audioGenerationFailed) == .fallback)
        #expect(TalkModeRuntime.mlxFailureDisposition(
            TalkMLXSpeechSynthesizer.SynthesizeError.modelLoadFailed("missing")) == .fallback)
    }

    @Test func `realtime recovery uses the iOS retry budget`() {
        #expect(TalkModeRuntime.realtimeRestartAttempt(
            previousRapidRestarts: 1,
            activeDuration: 5) == 2)
        #expect(TalkModeRuntime.realtimeRestartAttempt(
            previousRapidRestarts: 2,
            activeDuration: 31) == 1)
        #expect(TalkModeRuntime.realtimeRestartDelayNanoseconds(attempt: 1) == 500_000_000)
        #expect(TalkModeRuntime.realtimeRestartDelayNanoseconds(attempt: 2) == 2_000_000_000)
        #expect(TalkModeRuntime.realtimeRestartDelayNanoseconds(attempt: 3) == nil)
    }

    @Test @MainActor func `ready then audio failure clears relay owner and schedules bounded recovery`() async {
        let runtime = TalkModeRuntime()
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                request: { _, _, _ in throw CancellationError() }),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: RuntimeTestAudioCapture(),
            pcmPlayer: RuntimeTestPCMPlayer(),
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        let relayGeneration = await runtime._test_prepareEnabledRealtimeSessionForClose(session)

        await runtime.handleRealtimeTermination(
            .remoteClose(reason: "stale"),
            relayGeneration: relayGeneration &- 1)
        #expect(await runtime.realtimeSession != nil)

        await runtime.handleRealtimeTermination(
            .audioInputFailed(message: "microphone unavailable"),
            relayGeneration: relayGeneration)

        #expect(await runtime.realtimeSession == nil)
        #expect(await runtime.rapidRealtimeRestartCount == 1)
        #expect(await runtime.realtimeRestartTask != nil)

        await runtime.setEnabled(false)
        session.stop()
    }

    @Test @MainActor func `selected microphone restart failure closes relay and schedules recovery`() async throws {
        let runtime = TalkModeRuntime()
        let requests = RuntimeTestRelayRequestLog()
        let session = makeRecordingRelaySession(
            requests: requests,
            audioCapture: RuntimeTestAudioCapture())
        let relayGeneration = await runtime._test_prepareEnabledRealtimeSessionForClose(session)

        await runtime.handleRealtimeInputRestartFailure(
            "selected microphone unavailable",
            relayGeneration: relayGeneration)

        #expect(await runtime.realtimeSession == nil)
        #expect(await runtime.rapidRealtimeRestartCount == 1)
        #expect(await runtime.realtimeRestartTask != nil)

        // Ownership must not be dropped while the server relay stays live; recovery would then
        // run a second session against the same gateway lease.
        let recorded = try await waitForRelayClose(requests)
        #expect(recorded == ["talk.session.close"])
        #expect(await requests.snapshot().sessionIds == ["relay-1"])

        await runtime.setEnabled(false)
        session.stop()
    }

    @Test func `stale termination and callbacks cannot tear down or project over a successor`() async throws {
        let runtime = TalkModeRuntime()
        let stopEntered = RuntimeTestSignal<Void>()
        let releaseStop = DispatchSemaphore(value: 0)
        var released = false
        defer {
            if !released {
                releaseStop.signal()
            }
        }
        let sessionA = await MainActor.run {
            makeRuntimeTestRealtimeSession(player: RuntimeTestPCMPlayer(onStop: {
                stopEntered.send(())
                _ = releaseStop.wait(timeout: .now() + 5)
            }))
        }
        let sessionB = await MainActor.run { makeRuntimeTestRealtimeSession(player: RuntimeTestPCMPlayer()) }
        let generationA = await runtime._test_prepareEnabledRealtimeSessionForClose(sessionA)

        let staleTermination = Task {
            await runtime.handleRealtimeTermination(
                .remoteClose(reason: "replaced"),
                relayGeneration: generationA)
        }
        do {
            _ = try await stopEntered.next("stale session stop")
        } catch {
            released = true
            releaseStop.signal()
            await staleTermination.value
            throw error
        }
        let invalidatedGeneration = await runtime.realtimeRelayGeneration
        #expect(invalidatedGeneration != generationA)
        let generationB = await runtime._test_prepareEnabledRealtimeSessionForClose(sessionB)
        #expect(await runtime.realtimeSession === sessionB)
        released = true
        releaseStop.signal()
        await staleTermination.value

        await MainActor.run { TalkModeController.shared.updatePartialTranscript("successor") }
        await runtime.handleRealtimeSpeakingChanged(false, relayGeneration: generationA)
        await runtime.handleRealtimeInputLevel(0.9, relayGeneration: generationA)
        await runtime.handleRealtimeOutputLevel(0.8, relayGeneration: generationA)
        await runtime.handleRealtimeTranscript(
            .init(role: "user", text: "stale", isFinal: false),
            relayGeneration: generationA)

        #expect(await runtime.realtimeRelayGeneration == generationB)
        #expect(await runtime.realtimeSession === sessionB)
        #expect(await runtime.realtimeRestartTask == nil)
        #expect(await MainActor.run { TalkModeController.shared.partialTranscript } == "successor")

        await runtime.setEnabled(false)
        await MainActor.run { sessionB.stop() }
    }

    @Test func `stale preference cleanup preserves successor session recognition and UI`() async throws {
        let runtime = TalkModeRuntime()
        let mainActorEntered = RuntimeTestSignal<Void>()
        let mainActorFinished = RuntimeTestSignal<Void>()
        let releaseMainActor = DispatchSemaphore(value: 0)
        var released = false
        defer {
            if !released {
                releaseMainActor.signal()
            }
        }
        let sessionA = await MainActor.run {
            makeRuntimeTestRealtimeSession(player: RuntimeTestPCMPlayer())
        }
        let sessionB = await MainActor.run {
            makeRuntimeTestRealtimeSession(player: RuntimeTestPCMPlayer())
        }
        _ = await runtime._test_prepareEnabledRealtimeSessionForClose(sessionA)
        let lifecycleA = await runtime.lifecycleGeneration
        _ = try #require(await runtime._test_beginRecognitionAttempt(
            lifecycleGeneration: lifecycleA))
        let recognitionCleanup = RuntimeCommitProbe()
        await runtime._test_setRecognitionCleanupProbe {
            recognitionCleanup.record("cleanup")
        }
        await MainActor.run {
            TalkModeController.shared.updatePartialTranscript("successor")
        }
        DispatchQueue.main.async {
            mainActorEntered.send(())
            _ = releaseMainActor.wait(timeout: .now() + 5)
            mainActorFinished.send(())
        }
        _ = try await mainActorEntered.next("MainActor preference blocker")

        let stalePreference = Task {
            await runtime.realtimeRelayPreferenceDidChange()
        }
        do {
            try await waitForRuntimeCondition("preference owner detachment") {
                await runtime.realtimeSession == nil
            }
        } catch {
            released = true
            releaseMainActor.signal()
            _ = try? await mainActorFinished.next("MainActor preference cleanup")
            await stalePreference.value
            throw error
        }
        #expect(recognitionCleanup.values() == ["cleanup"])

        _ = await runtime._test_prepareEnabledRealtimeSessionForClose(sessionB)
        let lifecycleB = await runtime.lifecycleGeneration
        let recognitionB = try #require(await runtime._test_beginRecognitionAttempt(
            lifecycleGeneration: lifecycleB))
        #expect(recognitionCleanup.values() == ["cleanup", "cleanup"])

        released = true
        releaseMainActor.signal()
        _ = try await mainActorFinished.next("MainActor preference cleanup")
        await stalePreference.value

        #expect(await runtime.realtimeSession === sessionB)
        #expect(await runtime.recognitionGeneration == recognitionB)
        #expect(recognitionCleanup.values() == ["cleanup", "cleanup"])
        #expect(await MainActor.run { TalkModeController.shared.partialTranscript } == "successor")

        await runtime._test_setRecognitionCleanupProbe(nil)
        await runtime.setEnabled(false)
        await MainActor.run { sessionB.stop() }
    }

    @Test @MainActor func `unpause that cannot restart capture closes relay and schedules recovery`() async throws {
        let runtime = TalkModeRuntime()
        let requests = RuntimeTestRelayRequestLog()
        let audioCapture = RuntimeTestAudioCapture()
        let session = makeRecordingRelaySession(requests: requests, audioCapture: audioCapture)
        _ = await runtime._test_prepareEnabledRealtimeSessionForClose(session)

        await runtime.setPaused(true)
        audioCapture.startError = RuntimeTestAudioCaptureError.inputUnavailable
        await runtime.setPaused(false)

        // Talk must never stay enabled with no microphone and no route back: the failed unpause
        // has to reach the same bounded recovery / native-speech fallback as any other capture loss.
        #expect(await runtime.realtimeSession == nil)
        #expect(await runtime.rapidRealtimeRestartCount == 1)
        #expect(await runtime.realtimeRestartTask != nil)

        let recorded = try await waitForRelayClose(requests)
        #expect(recorded == ["talk.session.close"])

        await runtime.setEnabled(false)
        session.stop()
    }

    @Test @MainActor func `paused reenable lets pinned bootstrap refresh realtime selection`() async throws {
        try await TestIsolation.withUserDefaultsValues([talkRealtimeRelayEnabledKey: true]) {
            let previousRelayPreference = AppStateStore.shared.talkRealtimeRelayEnabled
            AppStateStore.shared.talkRealtimeRelayEnabled = true
            defer {
                AppStateStore.shared.talkRealtimeRelayEnabled = previousRelayPreference
            }
            let requests = RuntimeTestRelayRequestLog()
            let bootstrap = try makeRuntimeTestBootstrap(
                requests: requests,
                realtimeModel: "fresh-model")
            let runtime = TalkModeRuntime(realtimeTalkBootstrapProvider: { bootstrap })
            await runtime._test_setVoiceWakeReadiness(supported: true, permissionGranted: true)
            _ = await runtime._test_prepareEnabledLifecycle()
            await runtime.setPaused(true)
            await runtime.setEnabled(false)
            let staleConfig = await runtime.fallbackTalkConfig()
            await runtime.applyTalkConfig(staleConfig)

            await runtime.setEnabled(true)
            #expect(await runtime.realtimeSession == nil)
            #expect(await requests.snapshot().methods.isEmpty)

            await runtime.setPaused(false)

            #expect(await runtime.realtimeSession != nil)
            #expect(await runtime.realtimeModelId == "fresh-model")
            #expect(await requests.snapshot().methods.first == "talk.session.create")
            await runtime.setEnabled(false)
        }
    }

    @Test @MainActor func `pausing realtime resets visible state and ignores late callbacks`() async {
        let runtime = TalkModeRuntime()
        let player = RuntimeTestPCMPlayer()
        let session = makeRuntimeTestRealtimeSession(player: player)
        let relayGeneration = await runtime._test_prepareEnabledRealtimeSessionForClose(session)
        TalkModeController.shared.updatePhase(.speaking)
        TalkModeController.shared.updateLevel(0.8)
        TalkModeController.shared.updatePartialTranscript("stale")

        await runtime.setPaused(true)
        await runtime.handleRealtimeSpeakingChanged(true, relayGeneration: relayGeneration)
        await runtime.handleRealtimeInputLevel(0.9, relayGeneration: relayGeneration)
        await runtime.handleRealtimeOutputLevel(0.8, relayGeneration: relayGeneration)
        await runtime.handleRealtimeTranscript(
            .init(role: "user", text: "late transcript", isFinal: false),
            relayGeneration: relayGeneration)

        #expect(await runtime.phase == .idle)
        #expect(TalkModeController.shared.phase == .idle)
        #expect(TalkModeController.shared.level == 0)
        #expect(TalkModeController.shared.partialTranscript.isEmpty)
        #expect(player.stopCount == 0)

        await runtime.setEnabled(false)
        session.stop()
    }

    @Test @MainActor func `resuming realtime restarts input and reuses the relay`() async throws {
        let runtime = TalkModeRuntime()
        let audioCapture = RuntimeTestAudioCapture()
        let player = RuntimeTestPCMPlayer()
        let eventChannel = AsyncStream<EventFrame>.makeStream()
        let result = TalkSessionCreateResult(
            sessionid: "talk-session",
            mode: AnyCodable("realtime"),
            transport: AnyCodable("gateway-relay"),
            brain: AnyCodable("agent-consult"),
            relaysessionid: "relay-1")
        let resultData = try JSONEncoder().encode(result)
        let session = RealtimeTalkRelaySession(
            transport: RealtimeTalkRelayTransport(
                subscribeServerEvents: { _ in eventChannel.stream },
                request: { method, _, _ in
                    if method == "talk.session.create" {
                        eventChannel.continuation.yield(EventFrame(
                            type: "event",
                            event: "talk.event",
                            payload: AnyCodable([
                                "relaySessionId": "relay-1",
                                "type": "ready",
                            ]),
                            seq: nil,
                            stateversion: nil))
                        return resultData
                    }
                    return Data("{\"ok\":true}".utf8)
                }),
            options: .init(sessionKey: "main", provider: "openai", model: "gpt-realtime-2", voice: nil),
            audioCapture: audioCapture,
            pcmPlayer: player,
            onStatus: { _ in },
            onSpeakingChanged: { _ in })
        try await session.start()
        let relayGeneration = await runtime._test_prepareEnabledRealtimeSessionForClose(session)

        await runtime.setPaused(true)
        await runtime.setPaused(false)

        #expect(audioCapture.startCount == 2)
        #expect(await runtime.realtimeSession === session)
        await runtime.handleRealtimeSpeakingChanged(true, relayGeneration: relayGeneration)
        #expect(await runtime.phase == .speaking)

        await runtime.setEnabled(false)
        session.stop()
        eventChannel.continuation.finish()
    }

    @Test @MainActor func `disabling during relay startup stops the published session`() async throws {
        let barrier = RuntimeContinuationBarrier()
        let requests = RuntimeTestRelayRequestLog()
        let probe = RuntimeCommitProbe()
        let bootstrap = try makeRuntimeTestBootstrap(
            requests: requests,
            createBarrier: barrier,
            probe: probe)
        let runtime = TalkModeRuntime(realtimeTalkBootstrapProvider: { bootstrap })
        let lifecycleGeneration = await runtime._test_prepareEnabledLifecycle()
        await runtime._test_enableRealtimeRelaySelection()
        let attempt = Task {
            do {
                try await runtime.startRealtimeRelay(generation: lifecycleGeneration)
                return true
            } catch {
                return false
            }
        }

        try await waitForRuntimeBarrier(barrier, cleaningUp: attempt)
        #expect(await runtime.realtimeSession != nil)
        await runtime.setEnabled(false)
        await barrier.release()

        #expect(await attempt.value == false)
        #expect(await runtime.realtimeSession == nil)
        #expect(probe.values() == ["start"])
        #expect(await requests.snapshot().methods.contains("talk.session.create"))
    }

    @Test func `failed realtime bootstrap clears prior Gateway selection`() async throws {
        let runtime = TalkModeRuntime(realtimeTalkBootstrapProvider: {
            throw RuntimeRelayStartError.failed
        })
        let staleConfig = await runtime.parseTalkConfig(
            makeRuntimeTestConfigSnapshot(realtimeModel: "stale-model"))
        await runtime.applyTalkConfig(staleConfig)
        let lifecycleGeneration = await runtime._test_prepareEnabledLifecycle()
        await runtime._test_enableRealtimeRelaySelection()

        do {
            try await runtime.startRealtimeRelay(generation: lifecycleGeneration)
            Issue.record("expected bootstrap failure")
        } catch {}

        #expect(await runtime.realtimeProvider == nil)
        #expect(await runtime.realtimeModelId == nil)
        #expect(await !runtime.hasGatewayRealtimeRelayTuple)
        await runtime.setEnabled(false)
    }

    @Test func `stale realtime config application cannot replace current selection`() async throws {
        let checkpoint = RuntimeContinuationBarrier()
        let bootstrap = try makeRuntimeTestBootstrap(realtimeModel: "stale-model")
        let runtime = TalkModeRuntime(realtimeTalkBootstrapProvider: { bootstrap })
        await runtime._test_setRealtimeConfigApplicationCheckpoint {
            try? await checkpoint.wait()
        }
        let currentConfig = await runtime.parseTalkConfig(
            makeRuntimeTestConfigSnapshot(realtimeModel: "current-model"))
        await runtime.applyTalkConfig(currentConfig)
        let lifecycleGeneration = await runtime._test_prepareEnabledLifecycle()
        await runtime._test_enableRealtimeRelaySelection()

        let attempt = Task {
            do {
                try await runtime.startRealtimeRelay(generation: lifecycleGeneration)
                return true
            } catch {
                return false
            }
        }
        try await waitForRuntimeBarrier(checkpoint, cleaningUp: attempt)
        _ = await runtime.beginRealtimeReconfiguration()
        await checkpoint.release()

        #expect(await attempt.value == false)
        #expect(await runtime.realtimeModelId == "current-model")
        await runtime._test_setRealtimeConfigApplicationCheckpoint(nil)
        await runtime.setEnabled(false)
    }

    @Test func `stale native fallback config cannot replace current selection`() async throws {
        let checkpoint = RuntimeContinuationBarrier()
        let runtime = TalkModeRuntime()
        await runtime._test_setRealtimeConfigApplicationCheckpoint {
            try? await checkpoint.wait()
        }
        let staleConfig = await runtime.parseTalkConfig(
            makeRuntimeTestConfigSnapshot(realtimeModel: "stale-model"))
        let currentConfig = await runtime.parseTalkConfig(
            makeRuntimeTestConfigSnapshot(realtimeModel: "current-model"))
        let lifecycleGeneration = await runtime._test_prepareEnabledLifecycle()
        let recognitionGeneration = await runtime.recognitionGeneration
        let relayGeneration = await runtime.realtimeRelayGeneration

        let attempt = Task {
            await runtime.applyNativeFallbackTalkConfig(
                staleConfig,
                lifecycleGeneration: lifecycleGeneration,
                recognitionGeneration: recognitionGeneration,
                relayGeneration: relayGeneration)
        }
        try await waitForRuntimeBarrier(checkpoint, cleaningUp: attempt)
        _ = await runtime.beginRealtimeReconfiguration()
        await runtime.applyTalkConfig(currentConfig)
        await checkpoint.release()

        #expect(await attempt.value == false)
        #expect(await runtime.realtimeModelId == "current-model")
        await runtime._test_setRealtimeConfigApplicationCheckpoint(nil)
        await runtime.setEnabled(false)
    }

    @Test(arguments: [
        RuntimeRelayStartupPauseOutcome.resume,
        .remainPaused,
        .disable,
    ])
    @MainActor
    func `relay startup pause retries only a matching resume`(
        outcome: RuntimeRelayStartupPauseOutcome) async throws
    {
        let barrier = RuntimeContinuationBarrier()
        let requests = RuntimeTestRelayRequestLog()
        let probe = RuntimeCommitProbe()
        let bootstrap = try makeRuntimeTestBootstrap(
            requests: requests,
            createBarrier: barrier,
            probe: probe)
        let runtime = TalkModeRuntime(realtimeTalkBootstrapProvider: { bootstrap })
        let lifecycleGeneration = await runtime._test_prepareEnabledLifecycle()
        await runtime._test_enableRealtimeRelaySelection()
        let attempt = Task {
            do {
                try await runtime.startRealtimeRelay(generation: lifecycleGeneration)
                return true
            } catch {
                return false
            }
        }

        try await waitForRuntimeBarrier(barrier, cleaningUp: attempt)
        #expect(await runtime.realtimeSession != nil)
        await runtime.setPaused(true)
        if outcome != .remainPaused {
            await runtime.setPaused(false)
        }
        if outcome == .disable {
            await runtime.setEnabled(false)
        }
        await barrier.release()

        #expect(await attempt.value == false)
        #expect(await runtime.realtimeSession == nil)
        if await runtime.consumePendingRealtimeRelayStart() { probe.record("retry") }
        if await runtime.consumePendingRealtimeRelayStart() { probe.record("retry") }
        #expect(probe.values() == (outcome == .resume ? ["start", "retry"] : ["start"]))

        await runtime.setEnabled(false)
    }

    @Test @MainActor func `paused pinned bootstrap retries before stale tuple fallback`() async throws {
        try await TestIsolation.withUserDefaultsValues([talkRealtimeRelayEnabledKey: true]) {
            let previousRelayPreference = AppStateStore.shared.talkRealtimeRelayEnabled
            AppStateStore.shared.talkRealtimeRelayEnabled = true
            defer {
                AppStateStore.shared.talkRealtimeRelayEnabled = previousRelayPreference
            }
            let barrier = RuntimeContinuationBarrier()
            let requests = RuntimeTestRelayRequestLog()
            let firstBootstrap = try makeRuntimeTestBootstrap(
                requests: requests,
                realtimeModel: "fresh-model")
            let retryBootstrap = try makeRuntimeTestBootstrap(
                requests: requests,
                realtimeModel: "fresh-model")
            let sequence = RuntimeTestBootstrapSequence(
                bootstraps: [firstBootstrap, retryBootstrap],
                firstBarrier: barrier)
            let runtime = TalkModeRuntime(realtimeTalkBootstrapProvider: { try await sequence.next() })
            await runtime._test_setVoiceWakeReadiness(supported: true, permissionGranted: true)
            let attempt = Task {
                await runtime.setEnabled(true)
                return true
            }

            try await waitForRuntimeBarrier(barrier, cleaningUp: attempt)
            #expect(await runtime.hasGatewayRealtimeRelayTuple == false)
            await runtime.setPaused(true)
            await runtime.setPaused(false)
            await barrier.release()

            _ = await attempt.value
            #expect(await sequence.requestCount() == 2)
            #expect(await requests.snapshot().methods == ["talk.session.create"])
            #expect(await runtime.realtimeSession != nil)
            #expect(await runtime.realtimeModelId == "fresh-model")
            await runtime.setEnabled(false)
        }
    }

    @Test func `processed recognition start failure retries a fresh raw capture`() {
        let probe = RuntimeCommitProbe()

        let started = TalkRecognitionCaptureLifecycle.start(
            isCurrent: { true },
            prepare: { enableVoiceProcessing -> RuntimeRecognitionCapture in
                if enableVoiceProcessing {
                    probe.record("prepare-processed")
                    probe.record("cleanup-processed")
                    throw RuntimeRecognitionStartError.failed
                }
                probe.record("prepare-raw")
                return RuntimeRecognitionCapture("raw")
            },
            discard: { probe.record("discard-\($0.name)") },
            publish: { probe.record("publish-\($0.name)") },
            onFailure: { enableVoiceProcessing, _ in
                probe.record(enableVoiceProcessing ? "failed-processed" : "failed-raw")
            })

        #expect(started)
        #expect(probe.values() == [
            "prepare-processed",
            "cleanup-processed",
            "failed-processed",
            "prepare-raw",
            "publish-raw",
        ])
    }

    @Test func `failed recognition candidates clean up without publishing`() {
        let probe = RuntimeCommitProbe()

        let started = TalkRecognitionCaptureLifecycle.start(
            isCurrent: { true },
            prepare: { enableVoiceProcessing -> RuntimeRecognitionCapture in
                let kind = enableVoiceProcessing ? "processed" : "raw"
                probe.record("prepare-\(kind)")
                probe.record("cleanup-\(kind)")
                throw RuntimeRecognitionStartError.failed
            },
            discard: { probe.record("discard-\($0.name)") },
            publish: { probe.record("publish-\($0.name)") },
            onFailure: { enableVoiceProcessing, _ in
                probe.record(enableVoiceProcessing ? "failed-processed" : "failed-raw")
            })

        #expect(!started)
        #expect(probe.values() == [
            "prepare-processed",
            "cleanup-processed",
            "failed-processed",
            "prepare-raw",
            "cleanup-raw",
            "failed-raw",
        ])
    }

    @Test @MainActor func `stale relay cleanup cannot clear a newer owned session`() async throws {
        let barrier = RuntimeContinuationBarrier()
        let requestsA = RuntimeTestRelayRequestLog()
        let requestsB = RuntimeTestRelayRequestLog()
        let bootstrapA = try makeRuntimeTestBootstrap(requests: requestsA)
        let bootstrapB = try makeRuntimeTestBootstrap(requests: requestsB)
        let sequence = RuntimeTestBootstrapSequence(
            bootstraps: [bootstrapA, bootstrapB],
            firstBarrier: barrier)
        let runtime = TalkModeRuntime(realtimeTalkBootstrapProvider: {
            try await sequence.next()
        })
        let lifecycleA = await runtime._test_prepareEnabledLifecycle()
        await runtime._test_enableRealtimeRelaySelection()
        let attemptA = Task {
            do {
                try await runtime.startRealtimeRelay(generation: lifecycleA)
                return true
            } catch {
                return false
            }
        }

        try await waitForRuntimeBarrier(barrier, cleaningUp: attemptA)
        await runtime.setEnabled(false)
        let lifecycleB = await runtime._test_prepareEnabledLifecycle()
        await runtime._test_enableRealtimeRelaySelection()
        try await runtime.startRealtimeRelay(generation: lifecycleB)
        let sessionB = try #require(await runtime.realtimeSession)
        await barrier.release()

        #expect(await attemptA.value == false)
        #expect(await runtime.realtimeSession === sessionB)
        #expect(await requestsA.snapshot().methods.isEmpty)
        #expect(await requestsB.snapshot().methods.first == "talk.session.create")

        await runtime.setEnabled(false)
        sessionB.stop()
    }

    @Test @MainActor func `current relay failure owner can transition to native fallback`() async throws {
        let runtime = TalkModeRuntime()
        let lifecycleGeneration = await runtime._test_prepareEnabledLifecycle()
        let recognitionGeneration = try #require(await runtime._test_beginRecognitionAttempt(
            lifecycleGeneration: lifecycleGeneration))
        let relayGeneration = await runtime.realtimeRelayGeneration

        #expect(await runtime.commitNativeFallback(
            lifecycleGeneration: lifecycleGeneration,
            recognitionGeneration: recognitionGeneration,
            relayGeneration: relayGeneration,
            status: "native"))
        #expect(TalkModeController.shared.partialTranscript == "native")

        await runtime.setEnabled(false)
    }

    @Test @MainActor func `stale relay fallback cannot replace successor recognition owner`() async throws {
        let runtime = TalkModeRuntime()
        let lifecycleGeneration = await runtime._test_prepareEnabledLifecycle()
        let staleRecognition = try #require(await runtime._test_beginRecognitionAttempt(
            lifecycleGeneration: lifecycleGeneration))
        let relayGeneration = await runtime.realtimeRelayGeneration
        let successorRecognition = try #require(await runtime._test_beginRecognitionAttempt(
            lifecycleGeneration: lifecycleGeneration))
        TalkModeController.shared.updatePartialTranscript("successor")

        let accepted = await runtime.commitNativeFallback(
            lifecycleGeneration: lifecycleGeneration,
            recognitionGeneration: staleRecognition,
            relayGeneration: relayGeneration,
            status: "stale fallback")

        #expect(await runtime.recognitionGeneration == successorRecognition)
        #expect(TalkModeController.shared.partialTranscript == "successor")
        #expect(!accepted)

        await runtime.setEnabled(false)
    }

    @Test func `blocked fallback projection cannot overwrite a successor`() async throws {
        let runtime = TalkModeRuntime()
        let lifecycleGeneration = await runtime._test_prepareEnabledLifecycle()
        let recognitionGeneration = try #require(await runtime._test_beginRecognitionAttempt(
            lifecycleGeneration: lifecycleGeneration))
        let relayGeneration = await runtime.realtimeRelayGeneration
        await MainActor.run {
            TalkModeController.shared.updatePartialTranscript("successor")
        }
        let blocked = AsyncStream<Void>.makeStream()
        let releaseMainActor = DispatchSemaphore(value: 0)
        var didReleaseMainActor = false
        defer {
            if !didReleaseMainActor {
                releaseMainActor.signal()
            }
        }
        DispatchQueue.main.async {
            blocked.continuation.yield()
            releaseMainActor.wait()
        }
        for await _ in blocked.stream.prefix(1) {}

        let staleCommit = Task {
            await runtime.commitNativeFallback(
                lifecycleGeneration: lifecycleGeneration,
                recognitionGeneration: recognitionGeneration,
                relayGeneration: relayGeneration,
                status: "stale fallback")
        }
        try await waitForRuntimeCondition("fallback to enter projection") {
            await runtime.phase == .listening
        }
        let successor = Task { await runtime.setEnabled(false) }
        try await waitForRuntimeCondition("successor generation") {
            await runtime.realtimeRelayGeneration != relayGeneration
        }
        didReleaseMainActor = true
        releaseMainActor.signal()

        #expect(await staleCommit.value == false)
        await successor.value
        #expect(await MainActor.run { TalkModeController.shared.partialTranscript }.isEmpty)
    }

    @Test func `stale recognition attempt preserves current owner`() async {
        let runtime = TalkModeRuntime()
        let lifecycleGeneration = await runtime._test_prepareEnabledLifecycle()
        let currentRecognition = await runtime._test_beginRecognitionAttempt(
            lifecycleGeneration: lifecycleGeneration)

        let staleRecognition = await runtime._test_beginRecognitionAttempt(
            lifecycleGeneration: lifecycleGeneration &- 1)

        #expect(currentRecognition != nil)
        #expect(staleRecognition == nil)
        #expect(await runtime.recognitionGeneration == currentRecognition)
        await runtime.setEnabled(false)
    }

    @Test func `cancelled recognition attempt discards capture before publication`() {
        let probe = RuntimeCommitProbe()
        var isCurrent = true

        let started = TalkRecognitionCaptureLifecycle.start(
            isCurrent: { isCurrent },
            prepare: { _ in
                isCurrent = false
                return RuntimeRecognitionCapture("processed")
            },
            discard: { probe.record("discard-\($0.name)") },
            publish: { probe.record("publish-\($0.name)") },
            onFailure: { _, _ in probe.record("failed") })

        #expect(!started)
        #expect(probe.values() == ["discard-processed"])
    }

    @Test func `talk speak params carry resolved voice and directive overrides`() {
        let params = TalkModeRuntime.makeTalkSpeakParams(
            text: "hello",
            voiceId: "voice-123",
            modelId: "eleven_v3",
            outputFormat: "mp3_44100_128",
            directive: TalkDirective(
                modelId: "eleven_turbo_v2_5",
                speed: 1.1,
                rateWPM: 180,
                stability: 0.4,
                similarity: 0.7,
                style: 0.2,
                speakerBoost: true,
                seed: 42,
                normalize: "auto",
                language: "en",
                outputFormat: "mp3_44100_128",
                latencyTier: 3))

        #expect(params["text"]?.value as? String == "hello")
        #expect(params["voiceId"]?.value as? String == "voice-123")
        #expect(params["modelId"]?.value as? String == "eleven_turbo_v2_5")
        #expect(params["outputFormat"]?.value as? String == "mp3_44100_128")
        #expect(params["speed"]?.value as? Double == 1.1)
        #expect(params["rateWpm"]?.value as? Int == 180)
        #expect(params["stability"]?.value as? Double == 0.4)
        #expect(params["similarity"]?.value as? Double == 0.7)
        #expect(params["style"]?.value as? Double == 0.2)
        #expect(params["speakerBoost"]?.value as? Bool == true)
        #expect(params["seed"]?.value as? Int == 42)
        #expect(params["normalize"]?.value as? String == "auto")
        #expect(params["language"]?.value as? String == "en")
        #expect(params["latencyTier"]?.value as? Int == 3)
    }
}
