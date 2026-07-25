import AVFAudio
import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import OSLog
@preconcurrency import WebRTC

@MainActor
protocol TalkRealtimeWebRTCSessionDelegate: AnyObject {
    func realtimeSession(_ session: TalkRealtimeWebRTCSession, didChangeStatus status: String)
    func realtimeSession(_ session: TalkRealtimeWebRTCSession, didDetectInputSpeech active: Bool)
    /// Live mic/playback levels (normalized 0...1) polled from WebRTC stats; nil
    /// when the report carries no audio level for that direction.
    func realtimeSession(_ session: TalkRealtimeWebRTCSession, didUpdateAudioLevels input: Double?, output: Double?)
    func realtimeSession(_ session: TalkRealtimeWebRTCSession, didReceiveUserTranscript text: String)
    func realtimeSession(_ session: TalkRealtimeWebRTCSession, didReceiveAssistantTranscript text: String)
    func realtimeSession(
        _ session: TalkRealtimeWebRTCSession,
        didFailTranscriptPersistenceForEntry entryId: String,
        error: Error)
    func realtimeSessionDidFinish(_ session: TalkRealtimeWebRTCSession)
}

@MainActor
final class TalkRealtimeTranscriptWriteQueue {
    typealias Persist = @MainActor (TalkRealtimeTranscriptParams) async throws -> Void
    typealias FailureLog = @MainActor (String, Error) -> Void

    private let retryDelaysNanoseconds: [UInt64]
    private var tail: Task<Void, Never>?
    private var generation = 0

    init(retryDelaysNanoseconds: [UInt64] = [100_000_000, 250_000_000]) {
        self.retryDelaysNanoseconds = retryDelaysNanoseconds
    }

    func enqueue(
        _ params: TalkRealtimeTranscriptParams,
        persist: @escaping Persist,
        failureLog: @escaping FailureLog)
    {
        let previous = self.tail
        self.generation += 1
        let retryDelaysNanoseconds = Array(self.retryDelaysNanoseconds.prefix(2))
        self.tail = Task { @MainActor in
            await previous?.value
            var finalError: Error?
            for attempt in 0...retryDelaysNanoseconds.count {
                do {
                    try await persist(params)
                    return
                } catch {
                    finalError = error
                    guard attempt < retryDelaysNanoseconds.count else { break }
                    do {
                        try await Task.sleep(nanoseconds: retryDelaysNanoseconds[attempt])
                    } catch {
                        finalError = error
                        break
                    }
                }
            }
            failureLog(
                params.entryId,
                finalError ?? NSError(
                    domain: "TalkRealtimeTranscript",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Transcript persistence failed"]))
        }
    }

    func flush() async {
        while let tail = self.tail {
            let generation = self.generation
            await tail.value
            if self.generation == generation { return }
        }
    }
}

@MainActor
final class TalkRealtimeTranscriptStore {
    private let retryDelaysNanoseconds: [UInt64]
    private var lastEntryIdByVoiceSession: [String: Int] = [:]
    private var queuesByVoiceSession: [String: TalkRealtimeTranscriptWriteQueue] = [:]

    init(retryDelaysNanoseconds: [UInt64] = [100_000_000, 250_000_000]) {
        self.retryDelaysNanoseconds = retryDelaysNanoseconds
    }

    @discardableResult
    func enqueue(
        sessionKey: String,
        voiceSessionId: String,
        role: TalkRealtimeTranscriptRole,
        text: String,
        timestamp: Double,
        persist: @escaping TalkRealtimeTranscriptWriteQueue.Persist,
        failureLog: @escaping TalkRealtimeTranscriptWriteQueue.FailureLog) -> String
    {
        let nextEntryId = (self.lastEntryIdByVoiceSession[voiceSessionId] ?? 0) + 1
        self.lastEntryIdByVoiceSession[voiceSessionId] = nextEntryId
        let entryId = String(nextEntryId)
        let queue = self.queuesByVoiceSession[voiceSessionId] ?? TalkRealtimeTranscriptWriteQueue(
            retryDelaysNanoseconds: self.retryDelaysNanoseconds)
        self.queuesByVoiceSession[voiceSessionId] = queue
        queue.enqueue(
            TalkRealtimeTranscriptParams(
                sessionKey: sessionKey,
                voiceSessionId: voiceSessionId,
                entryId: entryId,
                role: role,
                text: text,
                timestamp: timestamp),
            persist: persist,
            failureLog: failureLog)
        return entryId
    }

    func flush(voiceSessionId: String) async {
        await self.queuesByVoiceSession[voiceSessionId]?.flush()
    }

    func remove(_ voiceSessionIds: Set<String>) {
        for voiceSessionId in voiceSessionIds {
            self.lastEntryIdByVoiceSession.removeValue(forKey: voiceSessionId)
            self.queuesByVoiceSession.removeValue(forKey: voiceSessionId)
        }
    }
}

@MainActor
final class TalkRealtimeWebRTCSession: NSObject {
    private static let logger = Logger(subsystem: "ai.openclawfoundation.app", category: "TalkRealtimeWebRTC")
    private static let consultToolName = "openclaw_agent_consult"
    private static let controlToolName = "openclaw_agent_control"
    private static let defaultOfferURL = "https://api.openai.com/v1/realtime/calls"
    private static let mediaStreamID = "openclaw-ios-realtime"
    private static let audioTrackID = "openclaw-ios-audio"
    private static let dataChannelLabel = "oai-events"
    private static let toolCallTimeoutSeconds = 12
    private static let toolResultTimeoutSeconds = 45
    private static let agentWaitSliceSeconds = 3
    private static let agentWaitRequestGraceSeconds = 15
    private static let historyFallbackTimeoutSeconds = 5
    private static let stillWorkingDelaySeconds = 6
    private static let assistantPlaybackDrainGraceSeconds = 1.8

    private let gateway: GatewayNodeSession
    private let sessionKey: String
    private let transcriptStore: TalkRealtimeTranscriptStore
    private weak var delegate: TalkRealtimeWebRTCSessionDelegate?
    private var adoptedVoiceSessionId: String?

    private var factory: RTCPeerConnectionFactory?
    private var peerConnection: RTCPeerConnection?
    private var dataChannel: RTCDataChannel?
    private var session: TalkRealtimeClientSession?
    private var toolBuffers: [String: ToolBuffer] = [:]
    private var activeToolTasks: [String: Task<Void, Never>] = [:]
    private var activeToolRunIds: [String: String] = [:]
    private var stopped = false
    private var timelineStartedAt = ProcessInfo.processInfo.systemUptime
    private var seenRealtimeEventTypes: Set<String> = []
    private var loggedFirstServerSpeech = false
    private var loggedFirstAssistantSignal = false
    private var assistantAudioActive = false
    private var assistantAudioFinishTask: Task<Void, Never>?
    private var ownsAudioSessionActivation = false
    private var audioLevelPollTask: Task<Void, Never>?

    private struct ToolBuffer {
        var name: String
        var callId: String
        var args: String
    }

    private struct AgentWaitResponse: Decodable {
        let runId: String?
        let status: String?
        let startedAt: Double?
        let error: String?
        let stopReason: String?
        let timeoutPhase: String?
        let providerStarted: Bool?
    }

    init(
        gateway: GatewayNodeSession,
        sessionKey: String,
        voiceSessionId: String? = nil,
        transcriptStore: TalkRealtimeTranscriptStore,
        delegate: TalkRealtimeWebRTCSessionDelegate)
    {
        self.gateway = gateway
        self.sessionKey = sessionKey
        self.adoptedVoiceSessionId = voiceSessionId
        self.transcriptStore = transcriptStore
        self.delegate = delegate
        super.init()
    }

    var voiceSessionId: String? {
        self.adoptedVoiceSessionId
    }

    func start(
        provider: String?,
        model: String?,
        voice: String?,
        prefetchedSession: TalkRealtimeClientSession? = nil) async throws
    {
        self.timelineStartedAt = ProcessInfo.processInfo.systemUptime
        self.seenRealtimeEventTypes.removeAll()
        self.loggedFirstServerSpeech = false
        self.loggedFirstAssistantSignal = false
        self.assistantAudioActive = false
        self.assistantAudioFinishTask?.cancel()
        self.assistantAudioFinishTask = nil
        self.stopped = false
        self.trace(
            "start provider=\(provider ?? "default") model=\(model ?? "default") "
                + "voice=\(voice ?? "default") sessionKey=\(self.sessionKey)")
        self.delegate?.realtimeSession(self, didChangeStatus: "Connecting")
        let session: TalkRealtimeClientSession
        if let prefetchedSession {
            self.trace(
                "gateway talk.client.create skipped prefetched provider=\(prefetchedSession.provider) "
                    + "transport=\(prefetchedSession.transport) model=\(prefetchedSession.model ?? "unknown") "
                    + "voice=\(prefetchedSession.voice ?? "unknown")")
            session = prefetchedSession
        } else {
            session = try await self.createClientSession(provider: provider, model: model, voice: voice)
        }
        guard let returnedVoiceSessionId = session.voiceSessionId else {
            throw NSError(domain: "TalkRealtimeWebRTC", code: 11, userInfo: [
                NSLocalizedDescriptionKey: "Gateway did not return a realtime voice session",
            ])
        }
        let requestedVoiceSessionId = self.adoptedVoiceSessionId
        self.adoptedVoiceSessionId = returnedVoiceSessionId
        if let requestedVoiceSessionId, requestedVoiceSessionId != returnedVoiceSessionId {
            throw NSError(domain: "TalkRealtimeWebRTC", code: 10, userInfo: [
                NSLocalizedDescriptionKey: "Gateway returned a conflicting realtime voice session",
            ])
        }
        let sessionModel = session.model ?? "unknown"
        let sessionVoice = session.voice ?? "unknown"
        Self.logger.info(
            "realtime session provider=\(session.provider, privacy: .public) model=\(sessionModel, privacy: .public)")
        Self.logger.info(
            "realtime session voice=\(sessionVoice, privacy: .public) transport=\(session.transport, privacy: .public)")
        try self.checkNotStopped()
        guard session.isWebRTC else {
            throw NSError(domain: "TalkRealtimeWebRTC", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Realtime provider returned unsupported transport \(session.transport)",
            ])
        }
        self.session = session

        self.trace("configure audio session start")
        try Self.configureAudioSession(activate: true)
        self.ownsAudioSessionActivation = true
        self.trace("configure audio session done")
        RTCInitializeSSL()
        let factory = RTCPeerConnectionFactory(
            encoderFactory: RTCDefaultVideoEncoderFactory(),
            decoderFactory: RTCDefaultVideoDecoderFactory())
        self.factory = factory

        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        config.continualGatheringPolicy = .gatherContinually
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let peer = factory.peerConnection(with: config, constraints: constraints, delegate: self) else {
            throw NSError(domain: "TalkRealtimeWebRTC", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Failed to create WebRTC peer connection",
            ])
        }
        self.peerConnection = peer

        let audioSource = factory.audioSource(with: constraints)
        let audioTrack = factory.audioTrack(with: audioSource, trackId: Self.audioTrackID)
        peer.add(audioTrack, streamIds: [Self.mediaStreamID])

        let channelConfig = RTCDataChannelConfiguration()
        let channel = peer.dataChannel(forLabel: Self.dataChannelLabel, configuration: channelConfig)
        channel?.delegate = self
        self.dataChannel = channel

        let offer = try await createOffer(peer: peer)
        self.trace("local offer created sdpBytes=\(offer.sdp.utf8.count)")
        try self.checkNotStopped()
        try await self.setLocalDescription(offer, peer: peer)
        self.trace("local description set")
        try self.checkNotStopped()
        let answerSDP = try await exchangeOffer(offer.sdp, session: session)
        self.trace("remote answer received sdpBytes=\(answerSDP.utf8.count)")
        try self.checkNotStopped()
        let answer = RTCSessionDescription(type: .answer, sdp: answerSDP)
        try await setRemoteDescription(answer, peer: peer)
        self.trace("remote description set")
        try self.checkNotStopped()
        self.delegate?.realtimeSession(self, didChangeStatus: "Listening")
        self.startAudioLevelPolling()
    }

    /// WebRTC owns capture and playback in this transport, so the app never sees
    /// PCM; peer-connection stats are the only real level source for the waveform.
    private func startAudioLevelPolling() {
        self.audioLevelPollTask?.cancel()
        self.audioLevelPollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self, !self.stopped, let peer = self.peerConnection else { return }
                let levels = await Self.audioLevels(peer: peer)
                guard !Task.isCancelled, !self.stopped else { return }
                self.delegate?.realtimeSession(
                    self,
                    didUpdateAudioLevels: levels.input.map { TalkAudioLevel.normalized(rms: $0) },
                    output: levels.output.map { TalkAudioLevel.normalized(rms: $0) })
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
        }
    }

    private nonisolated static func audioLevels(
        peer: RTCPeerConnection) async -> (input: Double?, output: Double?)
    {
        await withCheckedContinuation { continuation in
            peer.statistics { report in
                var input: Double?
                var output: Double?
                for stat in report.statistics.values {
                    guard (stat.values["kind"] as? String) == "audio",
                          let level = stat.values["audioLevel"] as? NSNumber
                    else { continue }
                    // Per the WebRTC stats spec audioLevel is linear 0...1:
                    // media-source is the local mic, inbound-rtp the remote voice.
                    if stat.type == "media-source" { input = level.doubleValue }
                    if stat.type == "inbound-rtp" { output = level.doubleValue }
                }
                continuation.resume(returning: (input, output))
            }
        }
    }

    func stop() {
        let shouldNotify = !self.stopped
        self.stopped = true
        self.audioLevelPollTask?.cancel()
        self.audioLevelPollTask = nil
        self.cancelActiveToolCalls()
        self.toolBuffers.removeAll()
        self.dataChannel?.close()
        self.dataChannel = nil
        self.peerConnection?.close()
        self.peerConnection = nil
        self.factory = nil
        self.releaseAudioSessionActivation()
        self.session = nil
        self.assistantAudioActive = false
        self.assistantAudioFinishTask?.cancel()
        self.assistantAudioFinishTask = nil
        if shouldNotify {
            self.delegate?.realtimeSessionDidFinish(self)
        }
    }

    func applyAudioRoutePreferenceChanged() throws {
        try Self.configureAudioSession(activate: false)
        self.trace("audio route preference reapplied")
    }

    private func releaseAudioSessionActivation() {
        guard self.ownsAudioSessionActivation else { return }
        self.ownsAudioSessionActivation = false

        // Balance only the activation this session owns. WebRTC may hold its own
        // activation while the peer connection is alive.
        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        defer { session.unlockForConfiguration() }
        do {
            try session.setActive(false)
        } catch {
            self.trace("audio session deactivate failed error=\(error.localizedDescription)")
        }
    }

    private func checkNotStopped() throws {
        if self.stopped {
            throw CancellationError()
        }
    }

    private func elapsedMs() -> Int {
        max(0, Int((ProcessInfo.processInfo.systemUptime - self.timelineStartedAt) * 1000))
    }

    private func trace(_ message: String) {
        GatewayDiagnostics.log("talk.timeline realtime +\(self.elapsedMs())ms \(message)")
        Self.logger.info("timeline +\(self.elapsedMs(), privacy: .public)ms \(message, privacy: .public)")
    }

    private func cancelActiveToolCalls() {
        let runIds = Array(Set(activeToolRunIds.values))
        for task in self.activeToolTasks.values {
            task.cancel()
        }
        self.activeToolTasks.removeAll()
        self.activeToolRunIds.removeAll()
        for runId in runIds {
            Task { [gateway, sessionKey] in
                let request = OpenClawChatGatewayRequests.abortRun(
                    sessionKey: sessionKey,
                    agentID: nil,
                    runID: runId,
                    requestTimeoutMs: 5000)
                _ = try? await gateway.request(request)
            }
        }
    }

    private func recordFinalTranscript(role: TalkRealtimeTranscriptRole, text: String) {
        guard let voiceSessionId = self.voiceSessionId else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        self.transcriptStore.enqueue(
            sessionKey: self.sessionKey,
            voiceSessionId: voiceSessionId,
            role: role,
            text: trimmed,
            timestamp: Date().timeIntervalSince1970 * 1000,
            persist: { [gateway] params in
                let data = try JSONEncoder().encode(params)
                guard let json = String(data: data, encoding: .utf8) else {
                    throw NSError(domain: "TalkRealtimeTranscript", code: 2, userInfo: [
                        NSLocalizedDescriptionKey: "Failed to encode transcript request",
                    ])
                }
                _ = try await gateway.request(
                    method: "talk.client.transcript",
                    paramsJSON: json,
                    timeoutSeconds: 5)
            },
            failureLog: { [weak self] entryId, error in
                self?.reportTranscriptPersistenceFailure(entryId: entryId, error: error)
            })
    }

    private func reportTranscriptPersistenceFailure(entryId: String, error: Error) {
        GatewayDiagnostics.log(
            "talk transcript persist FAILED entryId=\(entryId) error=\(error.localizedDescription)")
        self.delegate?.realtimeSession(
            self,
            didFailTranscriptPersistenceForEntry: entryId,
            error: error)
    }

    #if DEBUG
    func _test_reportTranscriptPersistenceFailure(entryId: String, error: Error) {
        self.reportTranscriptPersistenceFailure(entryId: entryId, error: error)
    }
    #endif

    func flushTranscriptWrites() async {
        guard let voiceSessionId = self.voiceSessionId else { return }
        await self.transcriptStore.flush(voiceSessionId: voiceSessionId)
    }

    private func handleRealtimeEvent(_ event: TalkRealtimeServerEvent) {
        guard !self.stopped else { return }
        if !self.seenRealtimeEventTypes.contains(event.type) {
            self.seenRealtimeEventTypes.insert(event.type)
            self.trace("event first type=\(event.type)")
        }
        if self.handleRealtimeAudioStateEvent(event) {
            return
        }
        switch event.type {
        case "conversation.input_transcript.delta",
             "conversation.item.input_audio_transcription.delta":
            if !self.loggedFirstServerSpeech {
                self.loggedFirstServerSpeech = true
                self.trace("server speech/transcript first delta")
            }
            if let text = event.delta ?? event.transcript {
                self.delegate?.realtimeSession(self, didReceiveUserTranscript: text)
            }
        case "conversation.input_transcript.done",
             "conversation.item.input_audio_transcription.completed":
            if let text = event.transcript ?? event.text {
                self.delegate?.realtimeSession(self, didReceiveUserTranscript: text)
                self.recordFinalTranscript(role: .user, text: text)
            }
        case "conversation.output_transcript.delta",
             "response.output_text.delta",
             "response.audio_transcript.delta",
             "response.output_audio_transcript.delta":
            if !self.loggedFirstAssistantSignal {
                self.loggedFirstAssistantSignal = true
                self.trace("assistant first output signal type=\(event.type)")
            }
            if let text = event.delta ?? event.transcript ?? event.text {
                self.delegate?.realtimeSession(self, didReceiveAssistantTranscript: text)
            }
        case "conversation.output_transcript.done",
             "response.output_text.done",
             "response.audio_transcript.done",
             "response.output_audio_transcript.done":
            if let text = event.transcript ?? event.text {
                self.delegate?.realtimeSession(self, didReceiveAssistantTranscript: text)
                self.recordFinalTranscript(role: .assistant, text: text)
            }
        case "response.function_call_arguments.delta":
            self.bufferToolDelta(event)
        case "response.output_item.added":
            self.bufferToolMetadata(event)
        case "response.function_call_arguments.done",
             "response.output_item.done",
             "conversation.item.done":
            self.handleToolDone(event)
        case "error":
            self.delegate?.realtimeSession(self, didChangeStatus: "Realtime error")
            if event.isMaximumDurationError {
                // The provider's hard limit is terminal before transport state catches up.
                // Finish explicitly so TalkModeManager rotates the session exactly once.
                self.stop()
            }
        default:
            break
        }
    }

    private func handleRealtimeAudioStateEvent(_ event: TalkRealtimeServerEvent) -> Bool {
        switch event.type {
        case "response.audio.delta", "response.output_audio.delta", "conversation.output_audio.delta":
            self.markAssistantAudioActive()
            return true
        case "response.created":
            self.trace("response created")
            self.markAssistantAudioActive()
            return true
        case "response.audio.done", "response.output_audio.done", "conversation.output_audio.done", "response.done":
            self.scheduleAssistantAudioFinished()
            return true
        case "input_audio_buffer.speech_started":
            if self.assistantAudioActive {
                self.trace("input speech ignored while assistant audio active")
                return true
            }
            if !self.loggedFirstServerSpeech {
                self.loggedFirstServerSpeech = true
                self.trace("server detected speech")
            }
            self.delegate?.realtimeSession(self, didDetectInputSpeech: true)
            self.delegate?.realtimeSession(self, didChangeStatus: "Listening")
            return true
        case "input_audio_buffer.speech_stopped", "input_audio_buffer.committed":
            self.delegate?.realtimeSession(self, didDetectInputSpeech: false)
            return true
        default:
            return false
        }
    }

    private func markAssistantAudioActive() {
        self.assistantAudioActive = true
        self.assistantAudioFinishTask?.cancel()
        self.assistantAudioFinishTask = nil
        self.delegate?.realtimeSession(self, didDetectInputSpeech: false)
        self.delegate?.realtimeSession(self, didChangeStatus: "Speaking")
    }

    private func scheduleAssistantAudioFinished() {
        self.assistantAudioFinishTask?.cancel()
        self.assistantAudioFinishTask = Task { @MainActor [weak self] in
            try? await Task.sleep(
                nanoseconds: UInt64(Self.assistantPlaybackDrainGraceSeconds * 1_000_000_000))
            guard let self, !Task.isCancelled, !self.stopped else { return }
            self.assistantAudioActive = false
            self.assistantAudioFinishTask = nil
            self.delegate?.realtimeSession(self, didChangeStatus: "Listening")
        }
    }

    private func toolBufferKey(for event: TalkRealtimeServerEvent) -> String? {
        event.resolvedItemId ?? event.resolvedCallId
    }

    private func bufferToolMetadata(_ event: TalkRealtimeServerEvent) {
        guard Self.isSupportedToolName(event.resolvedName), let key = toolBufferKey(for: event) else { return }
        var buffer = self.toolBuffers[key] ?? ToolBuffer(name: "", callId: "", args: "")
        buffer.name = event.resolvedName ?? buffer.name
        buffer.callId = event.resolvedCallId ?? buffer.callId
        if let arguments = event.resolvedArguments, !arguments.isEmpty {
            buffer.args = arguments
        }
        self.toolBuffers[key] = buffer
    }

    private func bufferToolDelta(_ event: TalkRealtimeServerEvent) {
        guard let key = toolBufferKey(for: event) else { return }
        var buffer = self.toolBuffers[key] ?? ToolBuffer(
            name: event.resolvedName ?? "",
            callId: event.resolvedCallId ?? "",
            args: "")
        buffer.name = buffer.name.isEmpty ? (event.resolvedName ?? "") : buffer.name
        buffer.callId = buffer.callId.isEmpty ? (event.resolvedCallId ?? "") : buffer.callId
        buffer.args += event.delta ?? ""
        self.toolBuffers[key] = buffer
    }

    private func handleToolDone(_ event: TalkRealtimeServerEvent) {
        guard let key = toolBufferKey(for: event) else { return }
        let buffered = self.toolBuffers[key]
        let name = buffered?.name.isEmpty == false ? buffered?.name : event.resolvedName
        let callId = buffered?.callId.isEmpty == false ? buffered?.callId : event.resolvedCallId
        let args = buffered?.args.isEmpty == false ? buffered?.args : event.resolvedArguments
        guard Self.isSupportedToolName(name), let callId, !callId.isEmpty else { return }
        guard args?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false else {
            self.bufferToolMetadata(event)
            return
        }
        guard self.activeToolTasks[callId] == nil else { return }
        self.toolBuffers.removeValue(forKey: key)
        self.trace("tool call ready name=\(name ?? "unknown") callId=\(callId) argsBytes=\((args ?? "").utf8.count)")
        self.assistantAudioActive = false
        self.assistantAudioFinishTask?.cancel()
        self.assistantAudioFinishTask = nil
        self.delegate?.realtimeSession(
            self,
            didChangeStatus: name == Self.controlToolName ? "Updating OpenClaw" : "Asking OpenClaw")
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            if name == Self.controlToolName {
                await self.submitControlToolCall(callId: callId, argsJSON: args ?? "{}")
            } else {
                await self.submitConsultToolCall(callId: callId, argsJSON: args ?? "{}")
            }
        }
        self.activeToolTasks[callId] = task
    }

    private static func isSupportedToolName(_ name: String?) -> Bool {
        name == self.consultToolName || name == self.controlToolName
    }

    private func submitConsultToolCall(callId: String, argsJSON: String) async {
        self.trace("tool call submit start callId=\(callId) argsBytes=\(argsJSON.utf8.count)")
        let statusTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.stillWorkingDelaySeconds) * 1_000_000_000)
            guard let self, !Task.isCancelled, !self.stopped else { return }
            self.delegate?.realtimeSession(self, didChangeStatus: "Still asking OpenClaw")
        }
        defer {
            statusTask.cancel()
            self.activeToolTasks[callId] = nil
            self.activeToolRunIds[callId] = nil
        }
        do {
            let args = try Self.decodeJSONObject(argsJSON)
            await self.flushTranscriptWrites()
            try Task.checkCancellation()
            try self.checkNotStopped()
            var params: [String: Any] = [
                "sessionKey": sessionKey,
                "callId": callId,
                "name": Self.consultToolName,
                "args": args,
            ]
            if let voiceSessionId = self.voiceSessionId {
                params["voiceSessionId"] = voiceSessionId
            }
            let historySince = Date().timeIntervalSince1970
            let data = try JSONSerialization.data(withJSONObject: params)
            guard let json = String(data: data, encoding: .utf8) else {
                throw NSError(domain: "TalkRealtimeWebRTC", code: 7, userInfo: [
                    NSLocalizedDescriptionKey: "Failed to encode realtime tool call",
                ])
            }
            let stream = await gateway.subscribeServerEvents(bufferingNewest: 200)
            self.trace("tool call gateway request start callId=\(callId)")
            let requestStartedAt = ProcessInfo.processInfo.systemUptime
            let res = try await gateway.request(
                method: "talk.client.toolCall",
                paramsJSON: json,
                timeoutSeconds: Self.toolCallTimeoutSeconds)
            let response = try JSONDecoder().decode(TalkRealtimeToolCallResponse.self, from: res)
            let requestElapsed = Int((ProcessInfo.processInfo.systemUptime - requestStartedAt) * 1000)
            guard let runId = response.runId ?? response.idempotencyKey else {
                throw NSError(domain: "TalkRealtimeWebRTC", code: 8, userInfo: [
                    NSLocalizedDescriptionKey: "Gateway did not return a realtime tool run id",
                ])
            }
            self.trace("tool call gateway request done callId=\(callId) runId=\(runId) elapsedMs=\(requestElapsed)")
            self.activeToolRunIds[callId] = runId
            if Task.isCancelled || self.stopped {
                await self.abortChatRun(runId: runId)
                return
            }
            let result = try await waitForChatResult(
                runId: runId,
                stream: stream,
                since: historySince,
                timeoutSeconds: Self.toolResultTimeoutSeconds)
            if Task.isCancelled || self.stopped { return }
            self.trace("tool call chat result ready callId=\(callId) runId=\(runId) chars=\(result.count)")
            self.submitToolResult(callId: callId, result: ["result": result])
        } catch is CancellationError {
            return
        } catch {
            if Task.isCancelled || self.stopped { return }
            Self.logger.error("realtime tool call failed: \(error.localizedDescription, privacy: .public)")
            self.trace("tool call failed callId=\(callId) error=\(error.localizedDescription)")
            if let runId = activeToolRunIds[callId] {
                await self.abortChatRun(runId: runId)
            }
            let confirmationInstruction = Self.voiceConfirmationInstruction(from: error)
            self.delegate?.realtimeSession(
                self,
                didChangeStatus: confirmationInstruction == nil ? "OpenClaw unavailable" : "Confirmation needed")
            let fallbackMessage = confirmationInstruction ?? [
                "OpenClaw consult did not finish quickly enough.",
                "Give a brief spoken fallback from the realtime conversation",
                "and ask the user to try again if they need OpenClaw-specific context.",
            ].joined(separator: " ")
            self.submitToolResult(callId: callId, result: [
                "error": fallbackMessage,
            ])
        }
        guard !Task.isCancelled, !self.stopped else { return }
        if !self.assistantAudioActive {
            self.delegate?.realtimeSession(self, didChangeStatus: "Listening")
        }
    }

    private func submitControlToolCall(callId: String, argsJSON: String) async {
        self.trace("control tool submit start callId=\(callId) argsBytes=\(argsJSON.utf8.count)")
        defer { self.activeToolTasks[callId] = nil }
        do {
            let params = try Self.controlParams(sessionKey: self.sessionKey, argsJSON: argsJSON)
            let data = try JSONSerialization.data(withJSONObject: params)
            guard let json = String(data: data, encoding: .utf8) else {
                throw NSError(domain: "TalkRealtimeWebRTC", code: 19, userInfo: [
                    NSLocalizedDescriptionKey: "Failed to encode realtime control call",
                ])
            }
            let res = try await gateway.request(
                method: "talk.client.steer",
                paramsJSON: json,
                timeoutSeconds: Self.toolCallTimeoutSeconds)
            let message = Self.controlResultMessage(from: res) ?? "OpenClaw updated the active run."
            self.trace("control tool gateway request done callId=\(callId) messageBytes=\(message.utf8.count)")
            self.submitToolResult(callId: callId, result: ["result": message])
        } catch is CancellationError {
            return
        } catch {
            if Task.isCancelled || self.stopped { return }
            Self.logger.error("realtime control tool failed: \(error.localizedDescription, privacy: .public)")
            self.trace("control tool failed callId=\(callId) error=\(error.localizedDescription)")
            self.submitToolResult(callId: callId, result: [
                "error": "OpenClaw could not update the active run.",
            ])
        }
        guard !Task.isCancelled, !self.stopped else { return }
        if !self.assistantAudioActive {
            self.delegate?.realtimeSession(self, didChangeStatus: "Listening")
        }
    }

    private static func controlParams(sessionKey: String, argsJSON: String) throws -> [String: Any] {
        let args = try Self.decodeJSONObject(argsJSON)
        let record = args as? [String: Any] ?? [:]
        let text = Self.nonEmptyString(record["text"])
            ?? Self.nonEmptyString(record["message"])
            ?? Self.nonEmptyString(record["request"])
            ?? Self.nonEmptyString(record["query"])
        guard let text else {
            throw NSError(domain: "TalkRealtimeWebRTC", code: 20, userInfo: [
                NSLocalizedDescriptionKey: "OpenClaw control tool call missing text",
            ])
        }
        var params: [String: Any] = [
            "sessionKey": sessionKey,
            "text": text,
        ]
        if let mode = Self.nonEmptyString(record["mode"]) {
            params["mode"] = mode
        }
        return params
    }

    private static func nonEmptyString(_ value: Any?) -> String? {
        guard let raw = value as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    static func voiceConfirmationInstruction(from error: Error) -> String? {
        let messages: [String] = if let responseError = error as? GatewayResponseError {
            [responseError.message, responseError.detailsReason].compactMap(\.self)
        } else {
            [error.localizedDescription]
        }
        let marker = "VOICE_CONFIRMATION_REQUIRED:"
        for message in messages {
            guard let markerRange = message.range(of: marker) else { continue }
            let suffix = message[markerRange.upperBound...]
            guard let confirmationId = suffix.split(whereSeparator: { $0.isWhitespace }).first,
                  !confirmationId.isEmpty
            else { continue }
            return [
                "\(marker)\(confirmationId) The requested action was not executed.",
                "Ask the user for explicit spoken confirmation, then call openclaw_agent_consult again",
                "with confirmationId \(confirmationId).",
            ].joined(separator: " ")
        }
        return nil
    }

    private static func controlResultMessage(from data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let record = object as? [String: Any]
        else { return nil }
        return Self.nonEmptyString(record["message"])
    }

    private func abortChatRun(runId: String) async {
        let request = OpenClawChatGatewayRequests.abortRun(
            sessionKey: self.sessionKey,
            agentID: nil,
            runID: runId,
            requestTimeoutMs: 5000)
        _ = try? await self.gateway.request(request)
    }

    private static func decodeJSONObject(_ json: String) throws -> Any {
        let trimmed = json.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [:] }
        let data = Data(trimmed.utf8)
        return try JSONSerialization.jsonObject(with: data)
    }

    private func waitForChatResult(
        runId: String,
        stream: AsyncStream<EventFrame>,
        since: Double,
        timeoutSeconds: Int = 120) async throws -> String
    {
        let currentSessionKey = self.sessionKey
        return try await withThrowingTaskGroup(of: String.self) { group in
            group.addTask { [runId, currentSessionKey] in
                for await evt in stream {
                    guard evt.event == "chat", let payload = evt.payload else { continue }
                    guard let chatEvent = try? GatewayPayloadDecoding.decode(
                        payload,
                        as: OpenClawChatEventPayload.self)
                    else {
                        continue
                    }
                    guard chatEvent.runId == runId else { continue }
                    if let eventSessionKey = chatEvent.sessionKey,
                       !Self.matchesSessionKey(eventSessionKey, currentSessionKey)
                    {
                        continue
                    }
                    await MainActor.run {
                        self.trace("chat event runId=\(runId) state=\(chatEvent.state ?? "unknown")")
                    }
                    if chatEvent.state == "final" {
                        return OpenClawChatEventText.assistantText(from: chatEvent) ?? "OpenClaw finished with no text."
                    }
                    if chatEvent.state == "aborted" {
                        throw NSError(domain: "TalkRealtimeWebRTC", code: 9, userInfo: [
                            NSLocalizedDescriptionKey: "OpenClaw realtime tool call aborted",
                        ])
                    }
                    if chatEvent.state == "error" {
                        throw NSError(domain: "TalkRealtimeWebRTC", code: 10, userInfo: [
                            NSLocalizedDescriptionKey: "OpenClaw realtime tool call failed",
                        ])
                    }
                }
                throw NSError(domain: "TalkRealtimeWebRTC", code: 11, userInfo: [
                    NSLocalizedDescriptionKey: "OpenClaw realtime tool event stream ended",
                ])
            }
            group.addTask { [gateway, sessionKey] in
                try await Self.waitForAgentResult(
                    gateway: gateway,
                    sessionKey: sessionKey,
                    runId: runId,
                    since: since,
                    timeoutSeconds: timeoutSeconds)
            }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(timeoutSeconds) * 1_000_000_000)
                throw NSError(domain: "TalkRealtimeWebRTC", code: 12, userInfo: [
                    NSLocalizedDescriptionKey: "OpenClaw realtime tool call timed out",
                ])
            }
            guard let result = try await group.next() else {
                throw NSError(domain: "TalkRealtimeWebRTC", code: 13, userInfo: [
                    NSLocalizedDescriptionKey: "OpenClaw realtime tool call did not finish",
                ])
            }
            group.cancelAll()
            return result
        }
    }

    private nonisolated static func matchesSessionKey(_ incoming: String, _ current: String) -> Bool {
        let incoming = incoming.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let current = current.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if incoming == current { return true }
        return (incoming == "agent:main:main" && current == "main") ||
            (incoming == "main" && current == "agent:main:main")
    }

    private static func waitForAgentResult(
        gateway: GatewayNodeSession,
        sessionKey: String,
        runId: String,
        since: Double,
        timeoutSeconds: Int) async throws -> String
    {
        let deadline = Date().addingTimeInterval(TimeInterval(timeoutSeconds))
        var sawProviderStart = false
        while Date() < deadline {
            let remaining = max(1, Int(ceil(deadline.timeIntervalSinceNow)))
            let waitSeconds = min(Self.agentWaitSliceSeconds, remaining)
            let wait = try await Self.agentWait(
                gateway: gateway,
                runId: runId,
                timeoutSeconds: waitSeconds)
            let status = wait.status?.lowercased() ?? "unknown"
            if wait.startedAt != nil || wait.providerStarted == true {
                sawProviderStart = true
            }
            GatewayDiagnostics.log(
                "talk.timeline realtime agent.wait runId=\(runId) status=\(status) "
                    +
                    "phase=\(wait.timeoutPhase ?? "unknown") "
                    +
                    "providerStarted=\(wait.providerStarted.map(String.init) ?? "unknown")")
            switch status {
            case "ok":
                if let text = try await Self.waitForAssistantTextFromHistory(
                    gateway: gateway,
                    sessionKey: sessionKey,
                    since: since,
                    timeoutSeconds: Self.historyFallbackTimeoutSeconds)
                {
                    return text
                }
            case "error":
                throw NSError(domain: "TalkRealtimeWebRTC", code: 14, userInfo: [
                    NSLocalizedDescriptionKey: wait.error ?? "OpenClaw realtime tool call failed",
                ])
            case "aborted", "cancelled", "canceled":
                throw NSError(domain: "TalkRealtimeWebRTC", code: 15, userInfo: [
                    NSLocalizedDescriptionKey: wait.stopReason ?? "OpenClaw realtime tool call aborted",
                ])
            case "timeout":
                break
            default:
                break
            }
        }
        let phase = sawProviderStart ? "provider" : "queue"
        throw NSError(domain: "TalkRealtimeWebRTC", code: 16, userInfo: [
            NSLocalizedDescriptionKey: "OpenClaw realtime tool call timed out in \(phase)",
        ])
    }

    private static func agentWait(
        gateway: GatewayNodeSession,
        runId: String,
        timeoutSeconds: Int) async throws -> AgentWaitResponse
    {
        let timeoutMs = max(1, timeoutSeconds) * 1000
        let request = OpenClawChatGatewayRequests.agentWait(
            runID: runId,
            timeoutMs: timeoutMs,
            requestGraceMs: Self.agentWaitRequestGraceSeconds * 1000)
        let response = try await gateway.request(request)
        return try JSONDecoder().decode(AgentWaitResponse.self, from: response)
    }

    private static func waitForAssistantTextFromHistory(
        gateway: GatewayNodeSession,
        sessionKey: String,
        since: Double,
        timeoutSeconds: Int) async throws -> String?
    {
        let deadline = Date().addingTimeInterval(TimeInterval(timeoutSeconds))
        while Date() < deadline {
            if let text = try await Self.latestAssistantTextFromHistory(
                gateway: gateway,
                sessionKey: sessionKey,
                since: since)
            {
                return text
            }
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
        return nil
    }

    private static func latestAssistantTextFromHistory(
        gateway: GatewayNodeSession,
        sessionKey: String,
        since: Double) async throws -> String?
    {
        let request = OpenClawChatGatewayRequests.history(sessionKey: sessionKey, agentID: nil)
        let response = try await gateway.request(request)
        let history = try JSONDecoder().decode(OpenClawChatHistoryPayload.self, from: response)
        let messages = history.messages ?? []
        let decoded: [OpenClawChatMessage] = messages.compactMap { item in
            guard let data = try? JSONEncoder().encode(item) else { return nil }
            return try? JSONDecoder().decode(OpenClawChatMessage.self, from: data)
        }
        let assistant = decoded.last { message in
            guard message.role == "assistant" else { return false }
            guard let timestamp = message.timestamp else { return false }
            return TalkHistoryTimestamp.isAfter(timestamp, sinceSeconds: since)
        }
        guard let assistant else { return nil }
        let text = assistant.content.compactMap(\.text).joined(separator: "\n")
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func submitToolResult(callId: String, result: [String: String]) {
        guard let output = Self.encodeJSONString(result) else { return }
        self.trace("tool result send callId=\(callId) outputBytes=\(output.utf8.count)")
        self.sendRealtimeEvent([
            "type": "conversation.item.create",
            "item": [
                "type": "function_call_output",
                "call_id": callId,
                "output": output,
            ],
        ])
        self.sendRealtimeEvent(["type": "response.create"])
    }

    private static func encodeJSONString(_ value: Any) -> String? {
        guard JSONSerialization.isValidJSONObject(value) else { return nil }
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func sendRealtimeEvent(_ event: [String: Any]) {
        guard
            let channel = dataChannel,
            channel.readyState == .open,
            let json = Self.encodeJSONString(event),
            let data = json.data(using: .utf8)
        else { return }
        channel.sendData(RTCDataBuffer(data: data, isBinary: false))
        if let type = event["type"] as? String {
            self.trace("client event sent type=\(type)")
        }
    }

    private static func configureAudioSession(activate: Bool) throws {
        let forceSpeaker = TalkDefaults.speakerphoneEnabled()
        let config = RTCAudioSessionConfiguration.webRTC()
        config.category = AVAudioSession.Category.playAndRecord.rawValue
        config.mode = AVAudioSession.Mode.default.rawValue
        config.categoryOptions = TalkAudioRoute.categoryOptions(speakerphoneEnabled: forceSpeaker)
        config.sampleRate = 48000
        config.ioBufferDuration = 0.01
        RTCAudioSessionConfiguration.setWebRTC(config)

        let session = RTCAudioSession.sharedInstance()
        session.lockForConfiguration()
        defer { session.unlockForConfiguration() }

        session.ignoresPreferredAttributeConfigurationErrors = true
        if activate {
            try session.setConfiguration(config, active: true)
        } else {
            try session.setConfiguration(config)
        }
        let shouldForceSpeaker = TalkAudioRoute.shouldForceSpeaker(
            preferenceEnabled: forceSpeaker,
            outputPortTypes: session.currentRoute.outputs.map(\.portType))
        try? session.overrideOutputAudioPort(shouldForceSpeaker ? .speaker : .none)
    }
}

extension TalkRealtimeWebRTCSession {
    private func createClientSession(
        provider: String?,
        model: String?,
        voice: String?) async throws -> TalkRealtimeClientSession
    {
        self.trace("gateway talk.client.create start")
        let startedAt = ProcessInfo.processInfo.systemUptime
        let params = TalkRealtimeClientCreateParams(
            sessionKey: self.sessionKey,
            voiceSessionId: self.adoptedVoiceSessionId,
            provider: provider,
            model: model,
            voice: voice,
            capabilities: ["voice-transcript"])
        let data = try JSONEncoder().encode(params)
        let json = String(data: data, encoding: .utf8)
        let res = try await gateway.request(method: "talk.client.create", paramsJSON: json, timeoutSeconds: 12)
        let session = try JSONDecoder().decode(TalkRealtimeClientSession.self, from: res)
        let elapsed = Int((ProcessInfo.processInfo.systemUptime - startedAt) * 1000)
        self.trace(
            "gateway talk.client.create done elapsedMs=\(elapsed) "
                + "provider=\(session.provider) transport=\(session.transport) "
                + "model=\(session.model ?? "unknown") voice=\(session.voice ?? "unknown")")
        return session
    }

    private func createOffer(peer: RTCPeerConnection) async throws -> RTCSessionDescription {
        self.trace("local offer create start")
        let constraints = RTCMediaConstraints(
            mandatoryConstraints: [
                "OfferToReceiveAudio": "true",
                "OfferToReceiveVideo": "false",
            ],
            optionalConstraints: nil)
        return try await withCheckedThrowingContinuation { continuation in
            peer.offer(for: constraints) { offer, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let offer {
                    continuation.resume(returning: offer)
                } else {
                    continuation.resume(throwing: NSError(domain: "TalkRealtimeWebRTC", code: 3, userInfo: [
                        NSLocalizedDescriptionKey: "OpenAI realtime offer creation returned no SDP",
                    ]))
                }
            }
        }
    }

    private func setLocalDescription(_ description: RTCSessionDescription, peer: RTCPeerConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setLocalDescription(description) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }

    private func setRemoteDescription(_ description: RTCSessionDescription, peer: RTCPeerConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setRemoteDescription(description) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }

    private func exchangeOffer(_ sdp: String, session: TalkRealtimeClientSession) async throws -> String {
        let rawURL = session.offerUrl ?? Self.defaultOfferURL
        guard let url = URL(string: rawURL) else {
            throw NSError(domain: "TalkRealtimeWebRTC", code: 4, userInfo: [
                NSLocalizedDescriptionKey: "Invalid OpenAI realtime offer URL",
            ])
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(session.clientSecret)", forHTTPHeaderField: "Authorization")
        request.setValue("application/sdp", forHTTPHeaderField: "Content-Type")
        request.httpBody = sdp.data(using: .utf8)
        for (key, value) in session.offerHeaders ?? [:] {
            request.setValue(value, forHTTPHeaderField: key)
        }

        self.trace("openai webrtc offer exchange start urlHost=\(url.host ?? "unknown")")
        let startedAt = ProcessInfo.processInfo.systemUptime
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw NSError(domain: "TalkRealtimeWebRTC", code: 5, userInfo: [
                NSLocalizedDescriptionKey: "OpenAI realtime offer returned a non-HTTP response",
            ])
        }
        let elapsed = Int((ProcessInfo.processInfo.systemUptime - startedAt) * 1000)
        self.trace("openai webrtc offer exchange response status=\(http.statusCode) elapsedMs=\(elapsed)")
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw NSError(domain: "TalkRealtimeWebRTC", code: http.statusCode, userInfo: [
                NSLocalizedDescriptionKey: "OpenAI realtime offer failed: \(http.statusCode) \(body)",
            ])
        }
        guard let answer = String(data: data, encoding: .utf8),
              !answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            throw NSError(domain: "TalkRealtimeWebRTC", code: 6, userInfo: [
                NSLocalizedDescriptionKey: "OpenAI realtime offer returned an empty SDP answer",
            ])
        }
        return answer
    }
}

extension TalkRealtimeWebRTCSession: RTCPeerConnectionDelegate {
    nonisolated func peerConnection(_: RTCPeerConnection, didChange _: RTCSignalingState) {}
    nonisolated func peerConnection(_: RTCPeerConnection, didAdd stream: RTCMediaStream) {
        Task { @MainActor in
            self
                .trace(
                    "remote stream added audioTracks=\(stream.audioTracks.count) "
                        + "videoTracks=\(stream.videoTracks.count)")
        }
    }

    nonisolated func peerConnection(_: RTCPeerConnection, didRemove _: RTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_: RTCPeerConnection) {}
    nonisolated func peerConnection(_: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        Task { @MainActor in
            guard !self.stopped else { return }
            switch newState {
            case .connected, .completed:
                if !self.assistantAudioActive {
                    self.delegate?.realtimeSession(self, didChangeStatus: "Listening")
                }
            case .disconnected:
                self.delegate?.realtimeSession(self, didChangeStatus: "Reconnecting")
            case .failed, .closed:
                self.delegate?.realtimeSession(self, didChangeStatus: "Realtime disconnected")
                self.stop()
            default:
                break
            }
        }
    }

    nonisolated func peerConnection(_: RTCPeerConnection, didChange _: RTCIceGatheringState) {}
    nonisolated func peerConnection(_: RTCPeerConnection, didGenerate _: RTCIceCandidate) {}
    nonisolated func peerConnection(_: RTCPeerConnection, didRemove _: [RTCIceCandidate]) {}
    nonisolated func peerConnection(_: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        Task { @MainActor in
            self.dataChannel = dataChannel
            dataChannel.delegate = self
        }
    }
}

extension TalkRealtimeWebRTCSession: RTCDataChannelDelegate {
    nonisolated func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        Task { @MainActor in
            guard !self.stopped else { return }
            switch dataChannel.readyState {
            case .open:
                if !self.assistantAudioActive {
                    self.delegate?.realtimeSession(self, didChangeStatus: "Listening")
                }
            case .closed:
                self.delegate?.realtimeSession(self, didChangeStatus: "Realtime disconnected")
                self.stop()
            default:
                break
            }
        }
    }

    nonisolated func dataChannel(_: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard !buffer.isBinary else { return }
        let data = buffer.data
        Task { @MainActor in
            guard !self.stopped else { return }
            do {
                let event = try JSONDecoder().decode(TalkRealtimeServerEvent.self, from: data)
                self.handleRealtimeEvent(event)
            } catch {
                Self.logger
                    .debug("ignored realtime event decode failure: \(error.localizedDescription, privacy: .public)")
            }
        }
    }
}
