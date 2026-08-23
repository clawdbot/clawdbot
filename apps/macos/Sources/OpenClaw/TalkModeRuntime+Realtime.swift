import Foundation
import OpenClawChatUI
import OpenClawKit
import OSLog

private enum RealtimeRelayConfigurationError: LocalizedError {
    case incompatible

    var errorDescription: String? {
        "Gateway realtime Talk configuration changed before startup"
    }
}

extension TalkModeRuntime {
    #if DEBUG
    typealias VoiceWakePermissionProvider = @Sendable () async -> Bool
    #endif

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

    func stop(
        reconfigurationGeneration expectedReconfigurationGeneration: UInt64?,
        lifecycleGeneration expectedLifecycleGeneration: Int?) async
    {
        guard self.ownsReconfiguration(
            expectedReconfigurationGeneration,
            lifecycleGeneration: expectedLifecycleGeneration)
        else { return }
        self.pendingRealtimeRelayStartLifecycleGeneration = nil
        self.resetRealtimeRecoveryState()
        self.realtimeRelayGeneration &+= 1
        self.realtimeRelayStartGeneration = nil
        let realtimeSession = self.detachResourcesForRealtimeStop()

        if let realtimeSession {
            await MainActor.run { realtimeSession.stop() }
        }
        guard self.ownsReconfiguration(
            expectedReconfigurationGeneration,
            lifecycleGeneration: expectedLifecycleGeneration)
        else { return }
        await stopSpeaking(
            reason: .manual,
            reconfigurationGeneration: expectedReconfigurationGeneration,
            lifecycleGeneration: expectedLifecycleGeneration)
        guard self.ownsReconfiguration(
            expectedReconfigurationGeneration,
            lifecycleGeneration: expectedLifecycleGeneration)
        else { return }
        let projectionGeneration = self.realtimeRelayGeneration
        _ = await MainActor.run {
            self.realtimeRelayDeliveryGate.deliver(ifActive: projectionGeneration) {
                TalkModeController.shared.updateLevel(0)
                TalkModeController.shared.updatePartialTranscript("")
                TalkModeController.shared.updatePhase(.idle)
            }
        }
    }

    func ownsReconfiguration(
        _ expectedReconfigurationGeneration: UInt64?,
        lifecycleGeneration expectedLifecycleGeneration: Int?) -> Bool
    {
        (expectedReconfigurationGeneration.map { $0 == self.realtimeReconfigurationGeneration } ?? true) &&
            (expectedLifecycleGeneration.map { $0 == self.lifecycleGeneration } ?? true)
    }

    func beginRealtimeReconfiguration() -> (generation: UInt64, lifecycleGeneration: Int) {
        self.lifecycleGeneration &+= 1
        self.realtimeReconfigurationGeneration &+= 1
        return (self.realtimeReconfigurationGeneration, self.lifecycleGeneration)
    }

    func realtimeRelayPreferenceDidChange() async {
        guard isEnabled else { return }
        let reconfiguration = self.beginRealtimeReconfiguration()
        await self.stop(
            reconfigurationGeneration: reconfiguration.generation,
            lifecycleGeneration: reconfiguration.lifecycleGeneration)
        guard self.isCurrent(reconfiguration.lifecycleGeneration) else { return }
        await self.start()
    }

    func start() async {
        let gen = lifecycleGeneration
        #if DEBUG
        guard self.voiceWakeSupportedProvider() else { return }
        let hasVoiceWakePermission = await self.voiceWakePermissionProvider()
        #else
        guard voiceWakeSupported else { return }
        let hasVoiceWakePermission = await PermissionManager.ensureVoiceWakePermissions(interactive: true)
        #endif
        guard hasVoiceWakePermission else {
            logger.error("talk runtime not starting: permissions missing")
            return
        }
        macOSRealtimeRelayOptIn = await MainActor.run {
            AppStateStore.shared.talkRealtimeRelayEnabled
        }
        let bypassRealtime = bypassRealtimeOnNextStart
        bypassRealtimeOnNextStart = false
        if !macOSRealtimeRelayOptIn || bypassRealtime {
            await reloadConfig()
        }
        guard isCurrent(gen) else { return }
        if isPaused {
            phase = .idle
            await MainActor.run {
                TalkModeController.shared.updateLevel(0)
                TalkModeController.shared.updatePhase(.idle)
            }
            return
        }
        var nativeFallbackStatus: String?
        if self.macOSRealtimeRelayOptIn, !bypassRealtime {
            let fallbackRecognitionGeneration = recognitionGeneration
            let fallbackRealtimeRelayGeneration = realtimeRelayGeneration &+ 1
            do {
                try await self.startRealtimeRelay(generation: gen)
                return
            } catch is CancellationError {
                if self.consumePendingRealtimeRelayStart() {
                    await self.start()
                }
                return
            } catch {
                pendingRealtimeRelayStartLifecycleGeneration = nil
                guard isCurrent(gen), !isPaused,
                      recognitionGeneration == fallbackRecognitionGeneration,
                      realtimeRelayGeneration == fallbackRealtimeRelayGeneration,
                      realtimeRelayStartGeneration == nil,
                      realtimeSession == nil
                else { return }
                let fallbackConfig = await fetchTalkConfig()
                guard await self.applyNativeFallbackTalkConfig(
                    fallbackConfig,
                    lifecycleGeneration: gen,
                    recognitionGeneration: fallbackRecognitionGeneration,
                    relayGeneration: fallbackRealtimeRelayGeneration)
                else { return }
                logger.error(
                    "talk realtime unavailable; using native fallback: " +
                        "\(error.localizedDescription, privacy: .public)")
                nativeFallbackStatus = String(localized: "Realtime unavailable — using native speech")
            }
        }
        await self.startNativeFallback(generation: gen, status: nativeFallbackStatus)
    }

    func consumePendingRealtimeRelayStart() -> Bool {
        guard let generation = pendingRealtimeRelayStartLifecycleGeneration else { return false }
        pendingRealtimeRelayStartLifecycleGeneration = nil
        return generation == lifecycleGeneration && isEnabled && !isPaused &&
            realtimeSession == nil && realtimeRelayStartGeneration == nil &&
            self.macOSRealtimeRelayOptIn
    }

    private func startNativeFallback(generation: Int, status: String? = nil) async {
        let relayGeneration = realtimeRelayGeneration
        guard await startRecognition(lifecycleGeneration: generation),
              await self.commitNativeFallback(
                  lifecycleGeneration: generation,
                  recognitionGeneration: recognitionGeneration,
                  relayGeneration: relayGeneration,
                  status: status)
        else { return }
        startAudioInputObserver()
        startSilenceMonitor()
    }

    func commitNativeFallback(
        lifecycleGeneration: Int,
        recognitionGeneration: Int,
        relayGeneration: UInt64,
        status: String?) async -> Bool
    {
        let ownsFallback = {
            self.canCommitRecognitionStart(
                lifecycleGeneration: lifecycleGeneration,
                recognitionAttempt: recognitionGeneration) &&
                self.realtimeRelayGeneration == relayGeneration &&
                self.realtimeRelayStartGeneration == nil && self.realtimeSession == nil
        }
        guard ownsFallback() else { return false }
        phase = .listening
        return await self.projectRealtimeRelay(relayGeneration, nil) {
            if let status {
                TalkModeController.shared.updatePartialTranscript(status)
            }
            TalkModeController.shared.updatePhase(.listening)
        }
    }

    func inputDeviceSelectionDidChange() async {
        if let realtimeSession {
            guard isEnabled, !isPaused else { return }
            let relayGeneration = realtimeRelayGeneration
            do {
                try await MainActor.run {
                    try realtimeSession.setInputPaused(true)
                    try realtimeSession.setInputPaused(false)
                }
            } catch {
                logger.error(
                    "talk realtime input restart failed: \(error.localizedDescription, privacy: .public)")
                await self.handleRealtimeInputRestartFailure(
                    error.localizedDescription,
                    relayGeneration: relayGeneration)
            }
            return
        }
        guard isEnabled, !isPaused, phase == .listening else { return }
        logger.info("talk input selection changed; restarting capture")
        let lifecycleGeneration = self.lifecycleGeneration
        _ = await startRecognition(lifecycleGeneration: lifecycleGeneration)
    }

    func shouldAttemptRealtimeRelay() -> Bool {
        guard macOSRealtimeRelayOptIn else {
            logger.debug("talk macOS realtime relay disabled locally; using native speech")
            return false
        }
        guard hasGatewayRealtimeRelayTuple else {
            logger.warning(
                "talk macOS realtime relay opted in but Gateway tuple is incompatible: " +
                    "mode=\(realtimeMode ?? "missing", privacy: .public) " +
                    "transport=\(realtimeTransport ?? "missing", privacy: .public) " +
                    "brain=\(realtimeBrain ?? "missing", privacy: .public); using native fallback")
            return false
        }
        return Self.shouldUseRealtimeRelay(
            localOptIn: macOSRealtimeRelayOptIn,
            hasGatewayRealtimeRelayTuple: hasGatewayRealtimeRelayTuple)
    }

    static func shouldUseRealtimeRelay(
        localOptIn: Bool,
        hasGatewayRealtimeRelayTuple: Bool) -> Bool
    {
        localOptIn && hasGatewayRealtimeRelayTuple
    }

    func startRealtimeRelay(generation: Int) async throws {
        let relayGeneration = try beginRealtimeRelayStart()
        defer {
            if self.realtimeRelayStartGeneration == relayGeneration {
                self.realtimeRelayStartGeneration = nil
            }
        }
        let bootstrap: GatewayConnection.RealtimeTalkBootstrap
        do {
            bootstrap = try await self.realtimeTalkBootstrapProvider()
        } catch {
            try await self.applyRealtimeTalkConfig(
                self.fallbackTalkConfig(),
                lifecycleGeneration: generation,
                relayGeneration: relayGeneration)
            throw error
        }
        guard isCurrent(generation), !isPaused,
              realtimeRelayGeneration == relayGeneration
        else { throw CancellationError() }
        let config = self.parseTalkConfig(bootstrap.configSnapshot)
        try await self.applyRealtimeTalkConfig(
            config,
            lifecycleGeneration: generation,
            relayGeneration: relayGeneration)
        guard self.shouldAttemptRealtimeRelay() else {
            throw RealtimeRelayConfigurationError.incompatible
        }
        let session = try await makeRealtimeRelaySession(
            bootstrap: bootstrap,
            lifecycleGeneration: generation,
            relayGeneration: relayGeneration)
        try await ownAndStartRealtimeSession(
            session,
            lifecycleGeneration: generation,
            relayGeneration: relayGeneration,
            start: { session in try await session.start() })
        realtimeSessionReadyAt = Date()
        phase = .listening
        _ = await self.projectRealtimeRelay(relayGeneration, session) {
            TalkModeController.shared.updatePartialTranscript("")
            TalkModeController.shared.updatePhase(.listening)
        }
        logger.info(
            "talk realtime ready provider=\(realtimeProvider ?? "default", privacy: .public) " +
                "model=\(realtimeModelId ?? "default", privacy: .public)")
    }

    func applyRealtimeTalkConfig(
        _ config: TalkModeGatewayConfigState,
        lifecycleGeneration: Int,
        relayGeneration: UInt64) async throws
    {
        let locale = await MainActor.run { () -> String? in
            guard self.realtimeRelayDeliveryGate.deliver(ifActive: relayGeneration, {
                AppStateStore.shared.seamColorHex = config.seamColorHex
            }) else { return nil }
            return AppStateStore.shared.voiceWakeLocaleID
        }
        #if DEBUG
        if let checkpoint = self.realtimeConfigApplicationCheckpoint {
            await checkpoint()
        }
        #endif
        guard let locale,
              self.isCurrent(lifecycleGeneration),
              !self.isPaused,
              self.realtimeRelayGeneration == relayGeneration,
              self.realtimeRelayStartGeneration == relayGeneration
        else { throw CancellationError() }
        self.commitTalkConfig(config, locale: locale)
    }

    func applyNativeFallbackTalkConfig(
        _ config: TalkModeGatewayConfigState,
        lifecycleGeneration: Int,
        recognitionGeneration: Int,
        relayGeneration: UInt64) async -> Bool
    {
        let locale = await MainActor.run { AppStateStore.shared.voiceWakeLocaleID }
        #if DEBUG
        if let checkpoint = self.realtimeConfigApplicationCheckpoint {
            await checkpoint()
        }
        #endif
        guard self.isCurrent(lifecycleGeneration),
              !self.isPaused,
              self.recognitionGeneration == recognitionGeneration,
              self.realtimeRelayGeneration == relayGeneration,
              self.realtimeRelayStartGeneration == nil,
              self.realtimeSession == nil
        else { return false }
        self.commitTalkConfig(config, locale: locale)
        return true
    }

    func fallbackTalkConfig() -> TalkModeGatewayConfigState {
        let env = ProcessInfo.processInfo.environment
        return TalkModeGatewayConfigParser.fallback(
            defaultModelIdFallback: Self.defaultModelIdFallback,
            defaultSilenceTimeoutMs: Self.defaultSilenceTimeoutMs,
            envVoice: env["ELEVENLABS_VOICE_ID"],
            sagVoice: env["SAG_VOICE_ID"],
            envApiKey: env["ELEVENLABS_API_KEY"])
    }

    private func beginRealtimeRelayStart() throws -> UInt64 {
        guard realtimeSession == nil, realtimeRelayStartGeneration == nil else {
            throw CancellationError()
        }
        realtimeRelayGeneration &+= 1
        let relayGeneration = realtimeRelayGeneration
        realtimeRelayStartGeneration = relayGeneration
        return relayGeneration
    }

    private func makeRealtimeRelaySession(
        bootstrap: GatewayConnection.RealtimeTalkBootstrap,
        lifecycleGeneration: Int,
        relayGeneration: UInt64) async throws -> RealtimeTalkRelaySession
    {
        guard isCurrent(lifecycleGeneration), !isPaused,
              realtimeRelayGeneration == relayGeneration
        else { throw CancellationError() }
        let activeSessionKey = await MainActor.run {
            WebChatManager.shared.activeSessionKey
        }
        let sessionKey: String = if let activeSessionKey {
            activeSessionKey
        } else {
            bootstrap.sessionKey
        }
        let options = RealtimeTalkRelaySession.Options(
            sessionKey: sessionKey,
            provider: realtimeProvider,
            model: realtimeModelId,
            voice: realtimeSpeakerVoice)
        return await MainActor.run {
            RealtimeTalkRelaySession(
                transport: bootstrap.transport,
                options: options,
                audioCapture: MacRealtimeTalkAudioCapture(),
                pcmPlayer: RealtimePCMStreamingAudioPlayer(),
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
    }

    private func ownAndStartRealtimeSession(
        _ session: RealtimeTalkRelaySession,
        lifecycleGeneration: Int,
        relayGeneration: UInt64,
        start: @MainActor @Sendable (RealtimeTalkRelaySession) async throws -> Void) async throws
    {
        // Construction crosses executors. Claim ownership only after every lifecycle and
        // attempt fact is revalidated, then publish before start can suspend.
        guard isCurrent(lifecycleGeneration), !isPaused,
              realtimeRelayGeneration == relayGeneration,
              realtimeRelayStartGeneration == relayGeneration,
              realtimeSession == nil
        else {
            await MainActor.run { session.stop() }
            throw CancellationError()
        }
        realtimeSession = session
        do {
            try await start(session)
        } catch {
            await MainActor.run { session.stop() }
            if realtimeSession === session {
                realtimeSession = nil
            }
            guard isCurrent(lifecycleGeneration), !isPaused,
                  realtimeRelayGeneration == relayGeneration,
                  realtimeRelayStartGeneration == relayGeneration
            else {
                throw CancellationError()
            }
            throw error
        }
        guard isCurrent(lifecycleGeneration), !isPaused,
              realtimeRelayGeneration == relayGeneration,
              realtimeSession === session
        else {
            await MainActor.run { session.stop() }
            if realtimeSession === session {
                realtimeSession = nil
            }
            throw CancellationError()
        }
    }

    private func handleRealtimeStatus(_ status: String, relayGeneration: UInt64) {
        guard let session = realtimeSession,
              ownsRealtimeRelay(relayGeneration, session)
        else { return }
        logger.debug("talk realtime status=\(status, privacy: .public)")
    }

    private func handleRealtimeIssue(_ issue: RealtimeTalkRelayIssue, relayGeneration: UInt64) async {
        guard let session = realtimeSession,
              ownsRealtimeRelay(relayGeneration, session)
        else { return }
        logger.error(
            "talk realtime issue code=\(issue.code, privacy: .public) " +
                "message=\(issue.message, privacy: .public)")
        _ = await self.projectRealtimeRelay(relayGeneration, session) { TalkModeController.shared
            .updatePartialTranscript(issue.message)
        }
    }

    func handleRealtimeInputRestartFailure(
        _ message: String,
        relayGeneration: UInt64) async
    {
        let issue = RealtimeTalkRelayIssue(
            code: "audio_input_unavailable",
            message: message,
            provider: realtimeProvider,
            model: realtimeModelId,
            transport: "gateway-relay",
            phase: "audio-input")
        await handleRealtimeIssue(issue, relayGeneration: relayGeneration)
        await handleRealtimeTermination(
            .audioInputFailed(message: issue.message),
            relayGeneration: relayGeneration)
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
            logger.error(
                "talk realtime pause transition failed: \(error.localizedDescription, privacy: .public)")
            await self.handleRealtimeInputRestartFailure(
                error.localizedDescription,
                relayGeneration: relayGeneration)
            return false
        }
    }

    func handleRealtimeTermination(
        _ termination: RealtimeTalkRelayTermination,
        relayGeneration: UInt64) async
    {
        guard let session = realtimeSession,
              ownsRealtimeRelay(relayGeneration, session)
        else { return }
        logger.warning(
            "talk realtime terminated=\(String(describing: termination), privacy: .public)")
        let activeDuration = realtimeSessionReadyAt.map { Date().timeIntervalSince($0) } ?? 0
        realtimeRelayGeneration &+= 1
        let terminalGeneration = realtimeRelayGeneration
        // Session-owned terminations close before signalling; runtime-initiated ones do not.
        // stop() is idempotent, so closing here keeps a dead relay and its event subscription
        // from outliving their owner while recovery starts a replacement session.
        await MainActor.run { session.stop() }
        guard self.ownsRealtimeRelay(terminalGeneration, session) else { return }
        realtimeSession = nil
        realtimeSessionReadyAt = nil
        phase = .idle
        let shouldRecover = isEnabled && !isPaused
        let attempt = Self.realtimeRestartAttempt(
            previousRapidRestarts: rapidRealtimeRestartCount,
            activeDuration: activeDuration)
        let delay = Self.realtimeRestartDelayNanoseconds(attempt: attempt)
        guard await self.projectRealtimeRelay(terminalGeneration, nil, {
            TalkModeController.shared.updateLevel(0)
            TalkModeController.shared.updateSpeakingLevel(nil)
            TalkModeController.shared.updatePhase(.idle)
            if shouldRecover {
                TalkModeController.shared.updatePartialTranscript(delay == nil
                    ? String(localized: "Realtime disconnected repeatedly — using native speech")
                    : String(localized: "Realtime disconnected — reconnecting…"))
            }
        }) else { return }
        let lifecycleGeneration = self.lifecycleGeneration
        let restartGeneration = realtimeRestartGeneration &+ 1
        guard shouldRecover, self.ownsRealtimeRelay(terminalGeneration, nil),
              isEnabled, !isPaused
        else { return }
        rapidRealtimeRestartCount = attempt
        realtimeRestartGeneration = restartGeneration
        bypassRealtimeOnNextStart = delay == nil
        self.scheduleRealtimeRecovery(
            after: delay,
            lifecycleGeneration: lifecycleGeneration,
            restartGeneration: restartGeneration)
    }

    func handleRealtimeSpeakingChanged(_ speaking: Bool, relayGeneration: UInt64) async {
        guard let session = realtimeSession,
              ownsRealtimeRelay(relayGeneration, session),
              isEnabled,
              !self.isPaused
        else { return }
        if speaking {
            phase = .speaking
            _ = await self.projectRealtimeRelay(relayGeneration, session) {
                TalkModeController.shared.updatePhase(.speaking)
            }
        } else if !isPaused {
            phase = .listening
            _ = await self.projectRealtimeRelay(relayGeneration, session) {
                TalkModeController.shared.updatePhase(.listening)
            }
        }
    }

    func handleRealtimeInputLevel(_ level: Double, relayGeneration: UInt64) async {
        guard let session = realtimeSession,
              ownsRealtimeRelay(relayGeneration, session),
              isEnabled,
              !self.isPaused
        else { return }
        _ = await self.projectRealtimeRelay(relayGeneration, session) {
            TalkModeController.shared.updateLevel(level)
        }
    }

    func handleRealtimeOutputLevel(_ level: Double?, relayGeneration: UInt64) async {
        guard let session = realtimeSession,
              ownsRealtimeRelay(relayGeneration, session),
              isEnabled,
              !self.isPaused
        else { return }
        _ = await self.projectRealtimeRelay(relayGeneration, session) {
            TalkModeController.shared.updateSpeakingLevel(level)
        }
    }

    func handleRealtimeTranscript(
        _ transcript: RealtimeTalkTranscript,
        relayGeneration: UInt64) async
    {
        guard let session = realtimeSession,
              ownsRealtimeRelay(relayGeneration, session),
              isEnabled,
              !self.isPaused
        else { return }
        let text = transcript.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard transcript.role == "user" else { return }
        if transcript.isFinal {
            phase = .thinking
            _ = await self.projectRealtimeRelay(relayGeneration, session) {
                TalkModeController.shared.commitTranscript(text)
                TalkModeController.shared.updatePhase(.thinking)
            }
        } else {
            _ = await self.projectRealtimeRelay(relayGeneration, session) {
                TalkModeController.shared.updatePartialTranscript(text)
            }
        }
    }

    func ownsRealtimeRelay(_ generation: UInt64, _ session: RealtimeTalkRelaySession?) -> Bool {
        realtimeRelayGeneration == generation && realtimeSession === session
    }

    func projectRealtimeRelay(
        _ generation: UInt64,
        _ session: RealtimeTalkRelaySession?,
        _ body: @escaping @MainActor @Sendable () -> Void) async -> Bool
    {
        guard self.ownsRealtimeRelay(generation, session) else { return false }
        return await MainActor.run {
            self.realtimeRelayDeliveryGate.deliver(ifActive: generation, body)
        }
    }

    func resetRealtimeRecoveryState() {
        self.cancelScheduledRealtimeRecovery()
        realtimeSessionReadyAt = nil
        rapidRealtimeRestartCount = 0
        bypassRealtimeOnNextStart = false
    }

    func cancelScheduledRealtimeRecovery() {
        realtimeRestartGeneration &+= 1
        realtimeRestartTask?.cancel()
        realtimeRestartTask = nil
    }

    private func scheduleRealtimeRecovery(
        after delayNanoseconds: UInt64?,
        lifecycleGeneration: Int,
        restartGeneration: UInt64)
    {
        realtimeRestartTask?.cancel()
        realtimeRestartTask = Task { [weak self] in
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
              realtimeRestartGeneration == restartGeneration,
              isEnabled,
              !isPaused,
              realtimeSession == nil
        else { return .cancelled }
        return realtimeRelayStartGeneration == nil ? .ready : .waitingForStartToFinish
    }

    private func performScheduledRealtimeRecovery(
        lifecycleGeneration: Int,
        restartGeneration: UInt64) async
    {
        guard self.scheduledRealtimeRecoveryState(
            lifecycleGeneration: lifecycleGeneration,
            restartGeneration: restartGeneration) == .ready
        else { return }
        realtimeRestartTask = nil
        await self.start()
    }
}

#if DEBUG
extension TalkModeRuntime {
    func _test_beginRecognitionAttempt(lifecycleGeneration: Int) -> Int? {
        self.beginRecognitionAttempt(lifecycleGeneration: lifecycleGeneration)
    }

    func _test_setRecognitionCleanupProbe(_ probe: (@Sendable () -> Void)?) {
        self.recognitionCleanupProbe = probe
    }

    func _test_setVoiceWakeReadiness(supported: Bool, permissionGranted: Bool) {
        self.voiceWakeSupportedProvider = { supported }
        self.voiceWakePermissionProvider = { permissionGranted }
    }

    func _test_setRealtimeConfigApplicationCheckpoint(
        _ checkpoint: (@Sendable () async -> Void)?)
    {
        self.realtimeConfigApplicationCheckpoint = checkpoint
    }

    func _test_enableRealtimeRelaySelection() {
        (macOSRealtimeRelayOptIn, hasGatewayRealtimeRelayTuple) = (true, true)
    }

    func _test_prepareEnabledLifecycle() -> Int {
        isEnabled = true
        isPaused = false
        lifecycleGeneration &+= 1
        return lifecycleGeneration
    }

    func _test_prepareEnabledRealtimeSessionForClose(
        _ session: RealtimeTalkRelaySession) -> UInt64
    {
        self.cancelScheduledRealtimeRecovery()
        isEnabled = true
        isPaused = false
        lifecycleGeneration &+= 1
        realtimeRelayGeneration &+= 1
        realtimeSession = session
        realtimeSessionReadyAt = nil
        rapidRealtimeRestartCount = 0
        bypassRealtimeOnNextStart = false
        return realtimeRelayGeneration
    }
}
#endif
