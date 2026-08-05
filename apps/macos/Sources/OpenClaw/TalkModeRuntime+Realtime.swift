import Foundation
import OpenClawChatUI
import OpenClawKit
import OSLog

extension TalkModeRuntime {
    private enum ScheduledRealtimeRecoveryState: Equatable {
        case cancelled
        case waitingForStartToFinish
        case ready
    }

    private static let realtimeStableSessionSeconds: TimeInterval = 30
    private static let realtimeRestartDelaysNanoseconds: [UInt64] = [500_000_000, 2_000_000_000]

    static func realtimeRestartAttempt(
        previousRapidRestarts: Int,
        activeDuration: TimeInterval) -> Int
    {
        activeDuration >= self.realtimeStableSessionSeconds ? 1 : previousRapidRestarts + 1
    }

    static func realtimeRestartDelayNanoseconds(attempt: Int) -> UInt64? {
        guard attempt > 0, attempt <= self.realtimeRestartDelaysNanoseconds.count else { return nil }
        return self.realtimeRestartDelaysNanoseconds[attempt - 1]
    }

    func startRealtimeRelay(generation: Int) async throws {
        guard self.realtimeSession == nil, self.realtimeRelayStartGeneration == nil else {
            throw CancellationError()
        }
        self.realtimeRelayGeneration &+= 1
        let relayGeneration = self.realtimeRelayGeneration
        self.realtimeRelayStartGeneration = relayGeneration
        defer {
            if self.realtimeRelayStartGeneration == relayGeneration {
                self.realtimeRelayStartGeneration = nil
            }
        }
        let transport = try await GatewayConnection.shared.acquireRealtimeTalkTransport()
        guard self.isCurrent(generation), !self.isPaused,
              self.realtimeRelayGeneration == relayGeneration
        else { throw CancellationError() }
        let activeSessionKey = await MainActor.run {
            WebChatManager.shared.activeSessionKey
        }
        let sessionKey: String = if let activeSessionKey {
            activeSessionKey
        } else {
            await GatewayConnection.shared.mainSessionKey()
        }
        let options = RealtimeTalkRelaySession.Options(
            sessionKey: sessionKey,
            provider: self.realtimeProvider,
            model: self.realtimeModelId,
            voice: self.realtimeSpeakerVoice)
        let session = await MainActor.run {
            let audioCapture = MacRealtimeTalkAudioCapture(onFailure: { [weak self] error in
                Task {
                    await self?.handleRealtimeAudioCaptureFailure(
                        error.localizedDescription,
                        relayGeneration: relayGeneration)
                }
            })
            return RealtimeTalkRelaySession(
                transport: transport,
                options: options,
                audioCapture: audioCapture,
                pcmPlayer: PCMStreamingAudioPlayer.shared,
                onStatus: { [weak self] status in
                    Task { await self?.handleRealtimeStatus(status, relayGeneration: relayGeneration) }
                },
                onIssue: { [weak self] issue in
                    Task { await self?.handleRealtimeIssue(issue, relayGeneration: relayGeneration) }
                },
                onTermination: { [weak self] termination in
                    Task {
                        await self?.handleRealtimeTermination(
                            termination,
                            relayGeneration: relayGeneration)
                    }
                },
                onSpeakingChanged: { [weak self] speaking in
                    Task {
                        await self?.handleRealtimeSpeakingChanged(
                            speaking,
                            relayGeneration: relayGeneration)
                    }
                },
                onInputLevel: { [weak self] level in
                    Task { await self?.handleRealtimeInputLevel(level, relayGeneration: relayGeneration) }
                },
                onOutputLevel: { [weak self] level in
                    Task { await self?.handleRealtimeOutputLevel(level, relayGeneration: relayGeneration) }
                },
                onTranscript: { [weak self] transcript in
                    Task {
                        await self?.handleRealtimeTranscript(
                            transcript,
                            relayGeneration: relayGeneration)
                    }
                })
        }
        self.realtimeSession = session
        do {
            try await session.start()
        } catch {
            await MainActor.run { session.stop() }
            if self.realtimeSession === session {
                self.realtimeSession = nil
            }
            throw error
        }
        guard self.isCurrent(generation), !self.isPaused,
              self.realtimeRelayGeneration == relayGeneration,
              self.realtimeSession === session
        else {
            await MainActor.run { session.stop() }
            if self.realtimeSession === session {
                self.realtimeSession = nil
            }
            throw CancellationError()
        }
        self.phase = .listening
        await MainActor.run {
            TalkModeController.shared.updatePartialTranscript("")
            TalkModeController.shared.updatePhase(.listening)
        }
        self.logger.info(
            "talk realtime ready provider=\(self.realtimeProvider ?? "default", privacy: .public) " +
                "model=\(self.realtimeModelId ?? "default", privacy: .public)")
    }

    private func handleRealtimeStatus(_ status: String, relayGeneration: UInt64) {
        guard self.realtimeRelayGeneration == relayGeneration,
              self.realtimeSession != nil
        else { return }
        self.logger.debug("talk realtime status=\(status, privacy: .public)")
        if status == "Listening (Realtime)", self.realtimeSessionReadyAt == nil {
            self.realtimeSessionReadyAt = Date()
        }
    }

    private func handleRealtimeIssue(_ issue: RealtimeTalkRelayIssue, relayGeneration: UInt64) async {
        guard self.realtimeRelayGeneration == relayGeneration,
              self.realtimeSession != nil
        else { return }
        self.logger.error(
            "talk realtime issue code=\(issue.code, privacy: .public) " +
                "message=\(issue.message, privacy: .public)")
        await MainActor.run {
            TalkModeController.shared.updatePartialTranscript(issue.message)
        }
    }

    private func handleRealtimeTermination(
        _ termination: RealtimeTalkRelayTermination,
        relayGeneration: UInt64) async
    {
        guard self.realtimeRelayGeneration == relayGeneration,
              self.realtimeSession != nil
        else { return }
        self.logger.warning(
            "talk realtime terminated=\(String(describing: termination), privacy: .public)")
        await self.recoverRealtimeSession(
            relayGeneration: relayGeneration,
            reconnectingStatus: "Realtime disconnected — reconnecting…",
            fallbackStatus: "Realtime disconnected repeatedly — using native speech")
    }

    private func handleRealtimeAudioCaptureFailure(
        _ message: String,
        relayGeneration: UInt64) async
    {
        guard self.realtimeRelayGeneration == relayGeneration,
              let realtimeSession
        else { return }
        self.logger.error("talk realtime input failed: \(message, privacy: .public)")
        await MainActor.run { realtimeSession.stop() }
        await self.recoverRealtimeSession(
            relayGeneration: relayGeneration,
            reconnectingStatus: "Realtime microphone failed — reconnecting…",
            fallbackStatus: "Realtime microphone failed repeatedly — using native speech")
    }

    func setRealtimeInputPaused(
        _ paused: Bool,
        session: RealtimeTalkRelaySession,
        relayGeneration: UInt64) async -> Bool
    {
        do {
            try await MainActor.run {
                try session.setInputPaused(paused)
            }
            return true
        } catch {
            await self.handleRealtimeAudioCaptureFailure(
                error.localizedDescription,
                relayGeneration: relayGeneration)
            return false
        }
    }

    private func recoverRealtimeSession(
        relayGeneration: UInt64,
        reconnectingStatus: String,
        fallbackStatus: String) async
    {
        guard self.realtimeRelayGeneration == relayGeneration,
              self.realtimeSession != nil
        else { return }
        self.realtimeSession = nil
        let activeDuration = self.realtimeSessionReadyAt.map { Date().timeIntervalSince($0) } ?? 0
        self.realtimeSessionReadyAt = nil
        self.phase = .idle
        await MainActor.run {
            TalkModeController.shared.updateLevel(0)
            TalkModeController.shared.updateSpeakingLevel(nil)
            TalkModeController.shared.updatePhase(.idle)
        }

        guard self.isEnabled, !self.isPaused else { return }
        let attempt = Self.realtimeRestartAttempt(
            previousRapidRestarts: self.rapidRealtimeRestartCount,
            activeDuration: activeDuration)
        self.rapidRealtimeRestartCount = attempt
        self.realtimeRestartGeneration &+= 1
        let restartGeneration = self.realtimeRestartGeneration
        let lifecycleGeneration = self.lifecycleGeneration
        if let delay = Self.realtimeRestartDelayNanoseconds(attempt: attempt) {
            await MainActor.run {
                TalkModeController.shared.updatePartialTranscript(reconnectingStatus)
            }
            self.scheduleRealtimeRecovery(
                after: delay,
                lifecycleGeneration: lifecycleGeneration,
                restartGeneration: restartGeneration)
        } else {
            self.bypassRealtimeOnNextStart = true
            await MainActor.run {
                TalkModeController.shared.updatePartialTranscript(fallbackStatus)
            }
            self.scheduleRealtimeRecovery(
                after: nil,
                lifecycleGeneration: lifecycleGeneration,
                restartGeneration: restartGeneration)
        }
    }

    private func handleRealtimeSpeakingChanged(_ speaking: Bool, relayGeneration: UInt64) async {
        guard self.realtimeRelayGeneration == relayGeneration,
              self.realtimeSession != nil,
              self.isEnabled
        else { return }
        if speaking {
            self.phase = .speaking
            await MainActor.run { TalkModeController.shared.updatePhase(.speaking) }
        } else if !self.isPaused {
            self.phase = .listening
            await MainActor.run { TalkModeController.shared.updatePhase(.listening) }
        }
    }

    private func handleRealtimeInputLevel(_ level: Double, relayGeneration: UInt64) async {
        guard self.realtimeRelayGeneration == relayGeneration,
              self.realtimeSession != nil,
              self.isEnabled
        else { return }
        await MainActor.run { TalkModeController.shared.updateLevel(level) }
    }

    private func handleRealtimeOutputLevel(_ level: Double?, relayGeneration: UInt64) async {
        guard self.realtimeRelayGeneration == relayGeneration,
              self.realtimeSession != nil,
              self.isEnabled
        else { return }
        await MainActor.run { TalkModeController.shared.updateSpeakingLevel(level) }
    }

    private func handleRealtimeTranscript(
        _ transcript: RealtimeTalkTranscript,
        relayGeneration: UInt64) async
    {
        guard self.realtimeRelayGeneration == relayGeneration,
              self.realtimeSession != nil,
              self.isEnabled
        else { return }
        let text = transcript.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard transcript.role == "user" else { return }
        if transcript.isFinal {
            self.phase = .thinking
            await MainActor.run {
                TalkModeController.shared.commitTranscript(text)
                TalkModeController.shared.updatePhase(.thinking)
            }
        } else {
            await MainActor.run { TalkModeController.shared.updatePartialTranscript(text) }
        }
    }

    func resetRealtimeRecoveryState() {
        self.cancelScheduledRealtimeRecovery()
        self.realtimeSessionReadyAt = nil
        self.rapidRealtimeRestartCount = 0
        self.bypassRealtimeOnNextStart = false
    }

    func cancelScheduledRealtimeRecovery() {
        self.realtimeRestartGeneration &+= 1
        self.realtimeRestartTask?.cancel()
        self.realtimeRestartTask = nil
    }

    private func scheduleRealtimeRecovery(
        after delayNanoseconds: UInt64?,
        lifecycleGeneration: Int,
        restartGeneration: UInt64)
    {
        self.realtimeRestartTask?.cancel()
        self.realtimeRestartTask = Task { [weak self] in
            if let delayNanoseconds {
                do {
                    try await Task.sleep(nanoseconds: delayNanoseconds)
                } catch {
                    return
                }
            }
            while let self {
                switch await self.scheduledRealtimeRecoveryState(
                    lifecycleGeneration: lifecycleGeneration,
                    restartGeneration: restartGeneration)
                {
                case .cancelled:
                    return
                case .waitingForStartToFinish:
                    do {
                        try await Task.sleep(nanoseconds: 50_000_000)
                    } catch {
                        return
                    }
                case .ready:
                    await self.performScheduledRealtimeRecovery(
                        lifecycleGeneration: lifecycleGeneration,
                        restartGeneration: restartGeneration)
                    return
                }
            }
        }
    }

    private func scheduledRealtimeRecoveryState(
        lifecycleGeneration: Int,
        restartGeneration: UInt64) -> ScheduledRealtimeRecoveryState
    {
        guard self.lifecycleGeneration == lifecycleGeneration,
              self.realtimeRestartGeneration == restartGeneration,
              self.isEnabled,
              !self.isPaused,
              self.realtimeSession == nil
        else { return .cancelled }
        return self.realtimeRelayStartGeneration == nil ? .ready : .waitingForStartToFinish
    }

    private func performScheduledRealtimeRecovery(
        lifecycleGeneration: Int,
        restartGeneration: UInt64) async
    {
        guard self.scheduledRealtimeRecoveryState(
            lifecycleGeneration: lifecycleGeneration,
            restartGeneration: restartGeneration) == .ready
        else { return }
        self.realtimeRestartTask = nil
        await self.start()
    }
}

#if DEBUG
extension TalkModeRuntime {
    func _test_prepareEnabledRealtimeSessionForClose(
        _ session: RealtimeTalkRelaySession) -> UInt64
    {
        self.cancelScheduledRealtimeRecovery()
        self.isEnabled = true
        self.isPaused = false
        self.lifecycleGeneration &+= 1
        self.realtimeRelayGeneration &+= 1
        self.realtimeSession = session
        self.realtimeSessionReadyAt = nil
        self.rapidRealtimeRestartCount = 0
        self.bypassRealtimeOnNextStart = false
        return self.realtimeRelayGeneration
    }

    func _test_handleRealtimeStatus(_ status: String, relayGeneration: UInt64) {
        self.handleRealtimeStatus(status, relayGeneration: relayGeneration)
    }

    func _test_handleRealtimeTermination(
        _ termination: RealtimeTalkRelayTermination,
        relayGeneration: UInt64) async
    {
        await self.handleRealtimeTermination(termination, relayGeneration: relayGeneration)
    }

    func _test_handleRealtimeAudioCaptureFailure(
        _ message: String,
        relayGeneration: UInt64) async
    {
        await self.handleRealtimeAudioCaptureFailure(message, relayGeneration: relayGeneration)
    }

    func _test_realtimeSessionIsActive() -> Bool {
        self.realtimeSession != nil
    }

    func _test_phase() -> TalkModePhase {
        self.phase
    }

    func _test_rapidRealtimeRestartCount() -> Int {
        self.rapidRealtimeRestartCount
    }

    func _test_hasPendingRealtimeRestart() -> Bool {
        self.realtimeRestartTask != nil
    }

    func _test_cancelRealtimeRecovery() {
        self.isEnabled = false
        self.cancelScheduledRealtimeRecovery()
        self.realtimeSession = nil
        self.realtimeRelayGeneration &+= 1
    }
}
#endif
