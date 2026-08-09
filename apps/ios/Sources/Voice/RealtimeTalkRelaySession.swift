import AVFAudio
import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import OSLog

private func makeRealtimeAudioTapBlock(
    inputSampleRate: Double,
    targetSampleRate: Double,
    onAudio: @escaping (Data, Double, Float) -> Void) -> AVAudioNodeTapBlock
{
    { buffer, _ in
        // This callback runs on Core Audio's realtime queue, not MainActor.
        let encoded = RealtimeTalkRelaySession.encodePCM16(
            buffer: buffer,
            inputSampleRate: inputSampleRate,
            targetSampleRate: targetSampleRate)
        guard !encoded.isEmpty else { return }
        let timestampMs = (ProcessInfo.processInfo.systemUptime * 1000).rounded()
        let rms = Float(TalkAudioLevel.rms(buffer: buffer))
        onAudio(encoded, timestampMs, rms)
    }
}

private actor RealtimeAudioSender {
    private let request: @Sendable (String, String?, Int) async throws -> Data
    private var relaySessionId: String?
    private var pendingSends = 0
    private let maxPendingSends = 4

    init(
        relaySessionId: String,
        request: @escaping @Sendable (String, String?, Int) async throws -> Data)
    {
        self.relaySessionId = relaySessionId
        self.request = request
    }

    func close() {
        self.relaySessionId = nil
    }

    func send(_ data: Data, timestampMs: Double) async -> String? {
        guard !Task.isCancelled else { return nil }
        guard let relaySessionId else { return nil }
        guard self.pendingSends < self.maxPendingSends else { return nil }
        self.pendingSends += 1
        defer { self.pendingSends -= 1 }
        let payload: [String: Any] = [
            "sessionId": relaySessionId,
            "audioBase64": data.base64EncodedString(),
            "timestamp": timestampMs,
        ]
        do {
            let data = try JSONSerialization.data(withJSONObject: payload)
            guard let json = String(data: data, encoding: .utf8) else { return "Failed to encode audio payload" }
            try Task.checkCancellation()
            let response = try await self.request("talk.session.appendAudio", json, 8)
            try Task.checkCancellation()
            _ = try JSONDecoder().decode(TalkSessionOkResult.self, from: response)
            return nil
        } catch {
            return error.localizedDescription
        }
    }
}

@MainActor
final class RealtimeTalkRelaySession {
    private static let agentControlToolName = "openclaw_agent_control"

    struct Options {
        let sessionKey: String
        let provider: String?
        let model: String?
        let voice: String?
    }

    struct StartupTransport: Sendable {
        let subscribeServerEvents: @Sendable (Int) async -> AsyncStream<EventFrame>
        let request: @Sendable (String, String?, Int) async throws -> Data
        let isCurrent: @Sendable () async -> Bool

        init(
            subscribeServerEvents: @escaping @Sendable (Int) async -> AsyncStream<EventFrame>,
            request: @escaping @Sendable (String, String?, Int) async throws -> Data,
            isCurrent: @escaping @Sendable () async -> Bool = { true })
        {
            self.subscribeServerEvents = subscribeServerEvents
            self.request = request
            self.isCurrent = isCurrent
        }

        static func live(gateway: GatewayNodeSession, route: GatewayNodeSessionRoute) -> StartupTransport {
            StartupTransport(
                subscribeServerEvents: { bufferingNewest in
                    await gateway.subscribeServerEvents(bufferingNewest: bufferingNewest)
                },
                request: { method, paramsJSON, timeoutSeconds in
                    let response = try await gateway.request(
                        method: method,
                        paramsJSON: paramsJSON,
                        timeoutSeconds: timeoutSeconds,
                        ifCurrentRoute: route)
                    guard await gateway.currentRoute() == route else { throw CancellationError() }
                    return response
                },
                isCurrent: { await gateway.currentRoute() == route })
        }
    }

    private struct ToolCallStartResponse: Decodable {
        let runId: String?
        let idempotencyKey: String?
    }

    private struct ChatCompletionResult {
        let text: String?
        let failed: Bool
    }

    private enum StartupWaitResult {
        case ready
        case failed(TalkRuntimeIssue)
        case cancelled
    }

    private nonisolated static let expectedInputEncoding = "pcm16"
    private nonisolated static let expectedOutputEncoding = "pcm16"
    private nonisolated static let defaultSampleRateHz = 24000
    private nonisolated static let audioFrameBufferSize: AVAudioFrameCount = 2048
    private nonisolated static let bargeInRmsThreshold: Float = 0.08
    private nonisolated static let bargeInCooldownMs: Double = 900
    private nonisolated static let minOutputBeforeBargeInMs: Double = 250
    private nonisolated static let startupReadyTimeoutSeconds = 12

    private let gateway: GatewayNodeSession
    private let hasInjectedStartupTransport: Bool
    private var startupTransport: StartupTransport?
    private let options: Options
    private let pcmPlayer: PCMStreamingAudioPlaying
    private let logger = Logger(subsystem: "ai.openclawfoundation.app", category: "RealtimeTalkRelay")
    private let onStatus: (String) -> Void
    private let onIssue: (TalkRuntimeIssue) -> Void
    private let onSpeakingChanged: (Bool) -> Void
    private let onInputLevel: (Double) -> Void
    private let onOutputLevel: (Double?) -> Void
    /// Playback-time-aligned envelope of the assistant PCM the relay schedules;
    /// drives the speaking waveform with real audio instead of a synthetic pulse.
    private var outputEnvelope: PCMPlaybackEnvelope?

    private let audioEngine = AVAudioEngine()
    private var relaySessionId: String?
    private var hasReceivedReady = false
    private var hasReceivedFailure = false
    private var startupIssue: TalkRuntimeIssue?
    private var startupWaiter: CheckedContinuation<StartupWaitResult, Never>?
    private var pendingPreRelayEvents: [EventFrame] = []
    private var inputSampleRateHz = Double(RealtimeTalkRelaySession.defaultSampleRateHz)
    private var outputSampleRateHz = Double(RealtimeTalkRelaySession.defaultSampleRateHz)
    private var eventTask: Task<Void, Never>?
    private var toolCallTasks: [UUID: Task<Void, Never>] = [:]
    private var audioSendTasks: [UUID: Task<Void, Never>] = [:]
    private var outputTask: Task<Void, Never>?
    private var outputContinuation: AsyncThrowingStream<Data, Error>.Continuation?
    private var outputIdleTask: Task<Void, Never>?
    private var outputSessionId = 0
    private var pendingOutputChunks: [Data] = []
    private var pendingOutputDone = false
    private var pendingPlaybackMarks: [String] = []
    private var audioSender: RealtimeAudioSender?
    private var isClosed = false
    private var lifecycleGeneration: UInt64 = 0
    private var isOutputPlaying = false
    private var outputStartedAtMs: Double?
    private var outputPlaybackExpectedEndMs: Double = 0
    private var lastBargeInAtMs: Double = 0
    private var micLogFrameCount = 0
    private var micLogByteCount = 0
    private var micLogMaxRms: Float = 0
    private var lastMicLogAtMs: Double = 0
    private var suppressedEchoFrameCount = 0
    private var suppressedEchoByteCount = 0
    private var suppressedEchoMaxRms: Float = 0
    private var lastSuppressedEchoLogAtMs: Double = 0
    private var outputAudioChunkCount = 0
    private var outputAudioByteCount = 0

    init(
        gateway: GatewayNodeSession,
        options: Options,
        pcmPlayer: PCMStreamingAudioPlaying,
        onStatus: @escaping (String) -> Void,
        onIssue: @escaping (TalkRuntimeIssue) -> Void = { _ in },
        onSpeakingChanged: @escaping (Bool) -> Void,
        onInputLevel: @escaping (Double) -> Void = { _ in },
        onOutputLevel: @escaping (Double?) -> Void = { _ in },
        startupTransport: StartupTransport? = nil)
    {
        self.gateway = gateway
        self.hasInjectedStartupTransport = startupTransport != nil
        self.startupTransport = startupTransport
        self.options = options
        self.pcmPlayer = pcmPlayer
        self.onStatus = onStatus
        self.onIssue = onIssue
        self.onSpeakingChanged = onSpeakingChanged
        self.onInputLevel = onInputLevel
        self.onOutputLevel = onOutputLevel
    }

    func start() async throws {
        self.lifecycleGeneration &+= 1
        let lifecycleGeneration = self.lifecycleGeneration
        self.isClosed = false
        self.hasReceivedReady = false
        self.hasReceivedFailure = false
        self.startupIssue = nil
        self.startupWaiter = nil
        self.pendingPreRelayEvents.removeAll()
        self.onStatus("Connecting realtime…")
        if self.startupTransport == nil {
            guard let route = await gateway.currentRoute() else {
                throw NSError(domain: "RealtimeTalkRelay", code: 7, userInfo: [
                    NSLocalizedDescriptionKey: "Gateway not connected",
                ])
            }
            guard self.lifecycleGeneration == lifecycleGeneration, !self.isClosed else { return }
            self.startupTransport = .live(gateway: self.gateway, route: route)
        }
        guard let startupTransport = self.startupTransport else { return }
        let eventStream = await startupTransport.subscribeServerEvents(200)
        guard await self.isCurrentLifecycle(lifecycleGeneration) else { return }
        self.startEventPump(stream: eventStream, lifecycleGeneration: lifecycleGeneration)
        do {
            let result = try await self.createRelaySession()
            guard await self.isCurrentLifecycle(lifecycleGeneration) else {
                if let relaySessionId = result.relaysessionid?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !relaySessionId.isEmpty
                {
                    await Self.closeRelaySession(
                        transport: startupTransport,
                        relaySessionId: relaySessionId)
                }
                return
            }
            guard let relaySessionId = result.relaysessionid?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !relaySessionId.isEmpty
            else {
                throw NSError(domain: "RealtimeTalkRelay", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "Gateway did not return a realtime relay session",
                ])
            }
            self.relaySessionId = relaySessionId
            self.audioSender = RealtimeAudioSender(
                relaySessionId: relaySessionId,
                request: startupTransport.request)
            self.configureAudioContract(result.audio)
            try self.startMicrophonePump(lifecycleGeneration: lifecycleGeneration)
            self.onStatus("Waiting for realtime…")
            await self.drainPendingPreRelayEvents(lifecycleGeneration: lifecycleGeneration)
            guard await self.isCurrentLifecycle(lifecycleGeneration) else { return }
            switch await self.waitForStartupResult(
                timeoutSeconds: Self.startupReadyTimeoutSeconds,
                lifecycleGeneration: lifecycleGeneration)
            {
            case .ready:
                return
            case let .failed(issue):
                self.close(sendClose: true)
                throw NSError(domain: "RealtimeTalkRelay", code: 6, userInfo: [
                    NSLocalizedDescriptionKey: issue.displayMessage,
                ])
            case .cancelled:
                return
            }
        } catch {
            guard await self.isCurrentLifecycle(lifecycleGeneration) else { return }
            let createdRelaySessionId = self.relaySessionId
            self.close(sendClose: false)
            if let createdRelaySessionId {
                await Self.closeRelaySession(
                    transport: startupTransport,
                    relaySessionId: createdRelaySessionId)
            }
            throw error
        }
    }

    func stop() {
        self.close(sendClose: true)
    }

    private func close(sendClose: Bool) {
        guard !self.isClosed else { return }
        self.isClosed = true
        self.lifecycleGeneration &+= 1
        self.finishStartupWait(.cancelled)
        self.stopMicrophonePump()
        self.eventTask?.cancel()
        self.eventTask = nil
        for task in self.toolCallTasks.values {
            task.cancel()
        }
        for task in self.audioSendTasks.values {
            task.cancel()
        }
        self.audioSendTasks.removeAll()
        self.pendingPlaybackMarks.removeAll()
        let audioSender = self.audioSender
        self.audioSender = nil
        Task { await audioSender?.close() }
        self.stopOutputPlayback()
        if sendClose, let relaySessionId = self.relaySessionId, let startupTransport = self.startupTransport {
            Task { [startupTransport] in
                await Self.closeRelaySession(transport: startupTransport, relaySessionId: relaySessionId)
            }
        }
        self.relaySessionId = nil
        if !self.hasInjectedStartupTransport {
            self.startupTransport = nil
        }
        self.onSpeakingChanged(false)
    }

    private nonisolated static func closeRelaySession(
        transport: StartupTransport,
        relaySessionId: String) async
    {
        let payload = ["sessionId": relaySessionId]
        let data = try? JSONSerialization.data(withJSONObject: payload)
        let json = data.flatMap { String(data: $0, encoding: .utf8) }
        _ = try? await transport.request("talk.session.close", json, 8)
    }

    func cancelOutput(reason: String = "user") {
        self.stopOutputPlayback()
        guard let relaySessionId, let startupTransport else { return }
        Task { [startupTransport] in
            let payload: [String: Any] = [
                "sessionId": relaySessionId,
                "reason": reason,
            ]
            let data = try? JSONSerialization.data(withJSONObject: payload)
            let json = data.flatMap { String(data: $0, encoding: .utf8) }
            _ = try? await startupTransport.request("talk.session.cancelOutput", json, 8)
        }
    }

    private func createRelaySession() async throws -> TalkSessionCreateResult {
        var payload: [String: Any] = [
            "sessionKey": self.options.sessionKey,
            "mode": "realtime",
            "transport": "gateway-relay",
            "brain": "agent-consult",
        ]
        if let provider = self.nonEmpty(self.options.provider) {
            payload["provider"] = provider
        }
        if let model = self.nonEmpty(self.options.model) {
            payload["model"] = model
        }
        if let voice = self.nonEmpty(self.options.voice) {
            payload["voice"] = voice
        }
        let data = try JSONSerialization.data(withJSONObject: payload)
        guard let json = String(data: data, encoding: .utf8) else {
            throw NSError(domain: "RealtimeTalkRelay", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode realtime relay request",
            ])
        }
        guard let startupTransport else { throw CancellationError() }
        let response = try await startupTransport.request("talk.session.create", json, 20)
        return try JSONDecoder().decode(TalkSessionCreateResult.self, from: response)
    }

    private func configureAudioContract(_ raw: AnyCodable?) {
        guard let audio = raw?.dictionaryValue else { return }
        let inputEncoding = audio["inputEncoding"]?.stringValue ?? Self.expectedInputEncoding
        let outputEncoding = audio["outputEncoding"]?.stringValue ?? Self.expectedOutputEncoding
        if inputEncoding != Self.expectedInputEncoding || outputEncoding != Self.expectedOutputEncoding {
            let message = "unexpected realtime relay audio contract input=\(inputEncoding) output=\(outputEncoding)"
            self.logger.warning("\(message, privacy: .public)")
        }
        self.inputSampleRateHz = audio["inputSampleRateHz"]?.doubleValue
            ?? Double(Self.defaultSampleRateHz)
        self.outputSampleRateHz = audio["outputSampleRateHz"]?.doubleValue
            ?? Double(Self.defaultSampleRateHz)
    }

    private func startEventPump(stream: AsyncStream<EventFrame>, lifecycleGeneration: UInt64) {
        self.eventTask?.cancel()
        self.eventTask = Task { [weak self] in
            for await event in stream {
                if Task.isCancelled { return }
                await self?.handleGatewayEvent(event, lifecycleGeneration: lifecycleGeneration)
            }
        }
    }

    private func handleGatewayEvent(_ event: EventFrame, lifecycleGeneration: UInt64) async {
        guard self.isCurrentLifecycleLocally(lifecycleGeneration) else { return }
        guard event.event == "talk.event",
              let payload = event.payload?.dictionaryValue
        else { return }
        guard let relaySessionId else {
            self.pendingPreRelayEvents.append(event)
            if self.pendingPreRelayEvents.count > 200 {
                self.pendingPreRelayEvents.removeFirst(self.pendingPreRelayEvents.count - 200)
            }
            return
        }
        if payload["relaySessionId"]?.stringValue != relaySessionId {
            return
        }
        guard let type = payload["type"]?.stringValue else { return }
        switch type {
        case "ready":
            self.hasReceivedReady = true
            self.finishStartupWait(.ready)
            self.onStatus("Listening (Realtime)")
        case "audio":
            guard let base64 = payload["audioBase64"]?.stringValue,
                  let data = Data(base64Encoded: base64)
            else { return }
            self.recordOutputAudioChunk(byteCount: data.count)
            self.markOutputAudioStarted(byteCount: data.count, nowMs: ProcessInfo.processInfo.systemUptime * 1000)
            self.onSpeakingChanged(true)
            if self.outputContinuation == nil, self.outputTask != nil {
                self.pendingOutputChunks.append(data)
                return
            }
            self.ensureOutputPlaybackStarted()
            self.outputEnvelope?.append(data)
            self.outputContinuation?.yield(data)
        case "audioDone":
            self.finishOutputPlaybackStream()
        case "clear":
            let marks = self.takePendingPlaybackMarks()
            self.stopOutputPlayback()
            self.acknowledgePlaybackMarks(marks)
        case "mark":
            self.handlePlaybackMark(payload)
        case "transcript":
            self.handleTranscriptEvent(payload)
        case "toolCall":
            self.startToolCall(payload, lifecycleGeneration: lifecycleGeneration)
        case "error":
            let message = payload["message"]?.stringValue ?? "Realtime failed"
            let issue = Self.issue(
                payload: payload,
                fallbackMessage: message,
                fallbackProvider: self.options.provider,
                fallbackModel: self.options.model)
            GatewayDiagnostics.log("talk realtime: error=\(Self.safeLogMessage(message))")
            self.hasReceivedFailure = true
            self.startupIssue = issue
            self.onIssue(issue)
            self.finishStartupWait(.failed(issue))
            self.onStatus(message)
        case "close":
            GatewayDiagnostics.log("talk realtime: close")
            if self.hasReceivedReady {
                self.onStatus("Ready")
            } else if !self.hasReceivedFailure {
                let issue = TalkRuntimeIssue(
                    code: .realtimeUnavailable,
                    message: "Realtime closed before it became ready.",
                    provider: self.options.provider,
                    model: self.options.model,
                    transport: "gateway-relay",
                    phase: "connect")
                self.onIssue(issue)
                self.startupIssue = issue
                self.finishStartupWait(.failed(issue))
                self.onStatus("Realtime failed before connecting")
            }
            self.close(sendClose: false)
        default:
            return
        }
    }

    private func waitForStartupResult(
        timeoutSeconds: Int,
        lifecycleGeneration: UInt64) async -> StartupWaitResult
    {
        if self.isClosed { return .cancelled }
        if self.hasReceivedReady { return .ready }
        if let startupIssue { return .failed(startupIssue) }
        return await withCheckedContinuation { continuation in
            if self.isClosed {
                continuation.resume(returning: .cancelled)
                return
            }
            self.startupWaiter = continuation
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(max(0, timeoutSeconds)) * 1_000_000_000)
                self?.timeoutStartupWaiterIfNeeded(lifecycleGeneration: lifecycleGeneration)
            }
        }
    }

    private func drainPendingPreRelayEvents(lifecycleGeneration: UInt64) async {
        let pendingEvents = self.pendingPreRelayEvents
        self.pendingPreRelayEvents.removeAll()
        for event in pendingEvents {
            guard self.isCurrentLifecycleLocally(lifecycleGeneration) else { return }
            await self.handleGatewayEvent(event, lifecycleGeneration: lifecycleGeneration)
        }
    }

    private func finishStartupWait(_ result: StartupWaitResult) {
        guard let waiter = self.startupWaiter else { return }
        self.startupWaiter = nil
        waiter.resume(returning: result)
    }

    private func timeoutStartupWaiterIfNeeded(lifecycleGeneration: UInt64) {
        guard self.lifecycleGeneration == lifecycleGeneration,
              !self.isClosed,
              self.startupWaiter != nil,
              !self.hasReceivedReady,
              self.startupIssue == nil
        else {
            return
        }
        let issue = TalkRuntimeIssue(
            code: .realtimeUnavailable,
            message: "Realtime did not become ready in time.",
            provider: self.options.provider,
            model: self.options.model,
            transport: "gateway-relay",
            phase: "connect")
        self.hasReceivedFailure = true
        self.startupIssue = issue
        self.onIssue(issue)
        self.onStatus(issue.displayMessage)
        self.finishStartupWait(.failed(issue))
    }

    private static func issue(
        payload: [String: AnyCodable],
        fallbackMessage: String,
        fallbackProvider: String?,
        fallbackModel: String?) -> TalkRuntimeIssue
    {
        let provider = payload["provider"]?.stringValue ?? fallbackProvider
        let model = payload["model"]?.stringValue ?? fallbackModel
        let transport = payload["transport"]?.stringValue ?? "gateway-relay"
        let phase = payload["phase"]?.stringValue
        return TalkRuntimeIssue.realtimeUnavailable(
            message: fallbackMessage,
            provider: provider,
            model: model,
            transport: transport,
            phase: phase)
    }

    private func recordOutputAudioChunk(byteCount: Int) {
        self.outputAudioChunkCount += 1
        self.outputAudioByteCount += byteCount
        guard self.outputAudioChunkCount == 1 || self.outputAudioChunkCount % 20 == 0 else { return }
        GatewayDiagnostics.log(
            "talk realtime audio: chunks=\(self.outputAudioChunkCount) bytes=\(self.outputAudioByteCount)")
    }

    private func markOutputAudioStarted(byteCount: Int, nowMs: Double) {
        if !self.isOutputPlaying {
            self.outputStartedAtMs = nowMs
            self.outputPlaybackExpectedEndMs = nowMs
        }
        self.isOutputPlaying = true
        let bytesPerSecond = max(1, self.outputSampleRateHz * Double(MemoryLayout<Int16>.size))
        let chunkDurationMs = (Double(byteCount) / bytesPerSecond) * 1000
        self.outputPlaybackExpectedEndMs = max(nowMs, self.outputPlaybackExpectedEndMs) + chunkDurationMs
        self.scheduleOutputPlaybackIdle(expectedEndMs: self.outputPlaybackExpectedEndMs)
    }

    private func handleInputLevelDuringOutput(_ rms: Float, timestampMs: Double) {
        guard self.isOutputPlaying else { return }
        guard rms >= Self.bargeInRmsThreshold else { return }
        if let outputStartedAtMs,
           timestampMs - outputStartedAtMs < Self.minOutputBeforeBargeInMs
        {
            return
        }
        guard timestampMs - self.lastBargeInAtMs >= Self.bargeInCooldownMs else { return }
        self.lastBargeInAtMs = timestampMs
        self.cancelOutput(reason: "barge-in")
    }

    private func handleTranscriptEvent(_ payload: [String: AnyCodable]) {
        let isFinal = payload["final"]?.boolValue == true
        let role = payload["role"]?.stringValue ?? ""
        let charCount = payload["text"]?.stringValue?.count ?? 0
        GatewayDiagnostics.log(
            "talk realtime transcript: role=\(role.isEmpty ? "unknown" : role) final=\(isFinal) chars=\(charCount)")
        guard isFinal else { return }
        if role == "user" {
            self.onStatus("Thinking…")
        } else if role == "assistant" {
            self.onStatus("Listening (Realtime)")
        }
    }

    private func handleToolCall(_ payload: [String: AnyCodable], lifecycleGeneration: UInt64) async {
        guard let relaySessionId,
              let callId = payload["callId"]?.stringValue,
              let name = payload["name"]?.stringValue
        else { return }
        self.onStatus("Thinking…")
        do {
            if name == Self.agentControlToolName {
                try await self.handleAgentControlToolCall(
                    callId: callId,
                    relaySessionId: relaySessionId,
                    args: payload["args"],
                    lifecycleGeneration: lifecycleGeneration)
                return
            }
            let completionStream = await self.gateway.subscribeServerEvents(bufferingNewest: 200)
            try await self.ensureCurrentLifecycle(lifecycleGeneration)
            let args = payload["args"]?.foundationValue ?? [:]
            let startPayload: [String: Any] = [
                "sessionKey": self.options.sessionKey,
                "callId": callId,
                "name": name,
                "args": args,
                "relaySessionId": relaySessionId,
            ]
            let startResponse = try await self.requestJSON(
                method: "talk.client.toolCall",
                payload: startPayload,
                decodeAs: ToolCallStartResponse.self,
                timeoutSeconds: 30,
                lifecycleGeneration: lifecycleGeneration)
            guard let runId = startResponse.runId ?? startResponse.idempotencyKey else {
                throw NSError(domain: "RealtimeTalkRelay", code: 3, userInfo: [
                    NSLocalizedDescriptionKey: "Realtime tool call did not return a run id",
                ])
            }
            let completion = await self.waitForChatCompletion(
                runId: runId,
                stream: completionStream,
                timeoutSeconds: 120)
            try await self.ensureCurrentLifecycle(lifecycleGeneration)
            let result: [String: Any] = completion.failed
                ? ["error": "OpenClaw tool call failed"]
                : ["text": completion.text ?? "OpenClaw finished with no text."]
            try await self.submitToolResult(
                callId: callId,
                result: result,
                lifecycleGeneration: lifecycleGeneration)
            try await self.ensureCurrentLifecycle(lifecycleGeneration)
            self.onStatus("Listening (Realtime)")
        } catch {
            guard await self.isCurrentLifecycle(lifecycleGeneration) else { return }
            let errorResult: [String: Any] = [
                "error": error.localizedDescription,
            ]
            try? await self.submitToolResult(
                callId: callId,
                result: errorResult,
                lifecycleGeneration: lifecycleGeneration)
            guard await self.isCurrentLifecycle(lifecycleGeneration) else { return }
            self.onStatus("Listening (Realtime)")
        }
    }

    private func startToolCall(_ payload: [String: AnyCodable], lifecycleGeneration: UInt64) {
        let taskID = UUID()
        let task = Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.toolCallTasks.removeValue(forKey: taskID) }
            await self.handleToolCall(payload, lifecycleGeneration: lifecycleGeneration)
        }
        self.toolCallTasks[taskID] = task
    }

    private func handleAgentControlToolCall(
        callId: String,
        relaySessionId: String,
        args: AnyCodable?,
        lifecycleGeneration: UInt64) async throws
    {
        let controlArgs = args?.dictionaryValue ?? [:]
        var payload: [String: Any] = [
            "sessionId": relaySessionId,
            "sessionKey": self.options.sessionKey,
            "text": controlArgs["text"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "status",
        ]
        if let mode = controlArgs["mode"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
           !mode.isEmpty
        {
            payload["mode"] = mode
        }
        let response = try await self.requestJSON(
            method: "talk.session.steer",
            payload: payload,
            decodeAs: AnyCodable.self,
            timeoutSeconds: 30,
            lifecycleGeneration: lifecycleGeneration)
        try await self.ensureCurrentLifecycle(lifecycleGeneration)
        let result = response.dictionaryValue?.mapValues(\.foundationValue) ?? [
            "result": response.foundationValue,
        ]
        try await self.submitToolResult(
            callId: callId,
            result: result,
            lifecycleGeneration: lifecycleGeneration)
        try await self.ensureCurrentLifecycle(lifecycleGeneration)
        self.onStatus("Listening (Realtime)")
    }

    private func submitToolResult(
        callId: String,
        result: [String: Any],
        lifecycleGeneration: UInt64) async throws
    {
        guard let relaySessionId else { return }
        let payload: [String: Any] = [
            "sessionId": relaySessionId,
            "callId": callId,
            "result": result,
        ]
        _ = try await self.requestJSON(
            method: "talk.session.submitToolResult",
            payload: payload,
            decodeAs: TalkSessionOkResult.self,
            timeoutSeconds: 30,
            lifecycleGeneration: lifecycleGeneration)
    }

    private func waitForChatCompletion(
        runId: String,
        stream: AsyncStream<EventFrame>,
        timeoutSeconds: Int) async -> ChatCompletionResult
    {
        await withTaskGroup(of: ChatCompletionResult.self) { group in
            group.addTask {
                for await event in stream {
                    if Task.isCancelled {
                        return ChatCompletionResult(text: nil, failed: true)
                    }
                    guard event.event == "chat",
                          let payload = event.payload,
                          let chatEvent = try? GatewayPayloadDecoding.decode(
                              payload,
                              as: OpenClawChatEventPayload.self),
                          chatEvent.runId == runId
                    else { continue }
                    if chatEvent.state == "final" {
                        return ChatCompletionResult(
                            text: OpenClawChatEventText.assistantText(from: chatEvent),
                            failed: false)
                    }
                    if chatEvent.state == "aborted" || chatEvent.state == "error" {
                        return ChatCompletionResult(text: nil, failed: true)
                    }
                }
                return ChatCompletionResult(text: nil, failed: true)
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds) * 1_000_000_000)
                return ChatCompletionResult(text: nil, failed: true)
            }
            let result = await group.next() ?? ChatCompletionResult(text: nil, failed: true)
            group.cancelAll()
            return result
        }
    }

    private func requestJSON<T: Decodable>(
        method: String,
        payload: [String: Any],
        decodeAs type: T.Type,
        timeoutSeconds: Int,
        lifecycleGeneration: UInt64) async throws -> T
    {
        let data = try JSONSerialization.data(withJSONObject: payload)
        guard let json = String(data: data, encoding: .utf8) else {
            throw NSError(domain: "RealtimeTalkRelay", code: 4, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode \(method) payload",
            ])
        }
        try await self.ensureCurrentLifecycle(lifecycleGeneration)
        guard let startupTransport else { throw CancellationError() }
        let response = try await startupTransport.request(method, json, timeoutSeconds)
        try await self.ensureCurrentLifecycle(lifecycleGeneration)
        return try JSONDecoder().decode(type, from: response)
    }

    private func isCurrentLifecycle(_ lifecycleGeneration: UInt64) async -> Bool {
        guard self.isCurrentLifecycleLocally(lifecycleGeneration), let startupTransport else { return false }
        let routeIsCurrent = await startupTransport.isCurrent()
        return self.isCurrentLifecycleLocally(lifecycleGeneration) &&
            routeIsCurrent
    }

    private func isCurrentLifecycleLocally(_ lifecycleGeneration: UInt64) -> Bool {
        !Task.isCancelled && !self.isClosed && self.lifecycleGeneration == lifecycleGeneration
    }

    private func ensureCurrentLifecycle(_ lifecycleGeneration: UInt64) async throws {
        try Task.checkCancellation()
        guard await self.isCurrentLifecycle(lifecycleGeneration) else { throw CancellationError() }
    }

    private func ensureOutputPlaybackStarted() {
        guard self.outputContinuation == nil, self.outputTask == nil else { return }
        self.outputSessionId += 1
        let sessionId = self.outputSessionId
        let envelope = self.outputEnvelope ?? PCMPlaybackEnvelope { [weak self] level in
            self?.onOutputLevel(level)
        }
        envelope.begin(sampleRate: self.outputSampleRateHz)
        self.outputEnvelope = envelope
        let stream = AsyncThrowingStream<Data, Error> { continuation in
            self.outputContinuation = continuation
        }
        self.outputTask = Task { [weak self] in
            guard let self else { return }
            let result = await self.pcmPlayer.play(stream: stream, sampleRate: self.outputSampleRateHz)
            await MainActor.run {
                guard self.outputSessionId == sessionId else { return }
                self.outputTask = nil
                self.outputContinuation = nil
                if !result.finished, let interruptedAt = result.interruptedAt {
                    self.logger.info("realtime output interrupted at \(interruptedAt, privacy: .public)s")
                }
                self.markOutputPlaybackFinished()
                self.startPendingOutputPlaybackIfNeeded()
            }
        }
    }

    private func finishOutputPlaybackStream() {
        guard let continuation = self.outputContinuation else {
            if self.outputTask != nil, !self.pendingOutputChunks.isEmpty {
                self.pendingOutputDone = true
            }
            return
        }
        continuation.finish()
        self.outputContinuation = nil
    }

    private func startPendingOutputPlaybackIfNeeded() {
        guard !self.pendingOutputChunks.isEmpty else {
            self.pendingOutputDone = false
            return
        }
        let chunks = self.pendingOutputChunks
        let shouldFinish = self.pendingOutputDone
        self.pendingOutputChunks = []
        self.pendingOutputDone = false
        self.ensureOutputPlaybackStarted()
        for chunk in chunks {
            self.markOutputAudioStarted(byteCount: chunk.count, nowMs: ProcessInfo.processInfo.systemUptime * 1000)
            self.onSpeakingChanged(true)
            self.outputEnvelope?.append(chunk)
            self.outputContinuation?.yield(chunk)
        }
        if shouldFinish {
            self.finishOutputPlaybackStream()
        }
    }

    private func scheduleOutputPlaybackIdle(expectedEndMs: Double) {
        self.outputIdleTask?.cancel()
        let nowMs = ProcessInfo.processInfo.systemUptime * 1000
        let idleDelayMs = max(350, expectedEndMs - nowMs + 500)
        self.outputIdleTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(idleDelayMs * 1_000_000))
            guard !Task.isCancelled else { return }
            await MainActor.run { [weak self] in
                guard let self, !self.isClosed else { return }
                let nowMs = ProcessInfo.processInfo.systemUptime * 1000
                self.refreshOutputPlaybackState(timestampMs: nowMs, cancelIdleTask: false)
            }
        }
    }

    private func refreshOutputPlaybackState(timestampMs: Double, cancelIdleTask: Bool = true) {
        guard self.isOutputPlaying else { return }
        guard timestampMs >= self.outputPlaybackExpectedEndMs + 500 else { return }
        self.markOutputPlaybackFinished(cancelIdleTask: cancelIdleTask)
    }

    private func markOutputPlaybackFinished(cancelIdleTask: Bool = true) {
        if cancelIdleTask {
            self.outputIdleTask?.cancel()
            self.outputIdleTask = nil
        }
        self.isOutputPlaying = false
        self.outputStartedAtMs = nil
        self.outputPlaybackExpectedEndMs = 0
        self.outputEnvelope?.cancel()
        self.onSpeakingChanged(false)
        self.acknowledgePlaybackMarks(self.takePendingPlaybackMarks())
    }

    private func takePendingPlaybackMarks() -> [String] {
        let marks = self.pendingPlaybackMarks
        self.pendingPlaybackMarks.removeAll()
        return marks
    }

    private func handlePlaybackMark(_ payload: [String: AnyCodable]) {
        guard let markName = payload["markName"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
              !markName.isEmpty
        else { return }
        if self.isOutputPlaying {
            self.pendingPlaybackMarks.append(markName)
        } else {
            self.acknowledgePlaybackMarks([markName])
        }
    }

    private func acknowledgePlaybackMarks(_ marks: [String]) {
        guard !marks.isEmpty,
              let relaySessionId = self.relaySessionId,
              let startupTransport = self.startupTransport
        else { return }
        for markName in marks {
            Task { [startupTransport] in
                let payload = ["sessionId": relaySessionId, "markName": markName]
                guard let data = try? JSONSerialization.data(withJSONObject: payload),
                      let json = String(data: data, encoding: .utf8)
                else { return }
                do {
                    _ = try await startupTransport.request("talk.session.acknowledgeMark", json, 8)
                } catch {
                    GatewayDiagnostics.log(
                        "talk realtime: mark acknowledgement failed=\(Self.safeLogMessage(error.localizedDescription))")
                }
            }
        }
    }

    private func stopOutputPlayback() {
        self.outputSessionId += 1
        self.outputContinuation?.finish()
        self.outputContinuation = nil
        self.outputTask?.cancel()
        self.outputTask = nil
        self.outputIdleTask?.cancel()
        self.outputIdleTask = nil
        self.pendingOutputChunks = []
        self.pendingOutputDone = false
        _ = self.pcmPlayer.stop()
        self.isOutputPlaying = false
        self.outputStartedAtMs = nil
        self.outputPlaybackExpectedEndMs = 0
        self.outputEnvelope?.cancel()
        self.onSpeakingChanged(false)
    }

    fileprivate nonisolated static func encodePCM16(
        buffer: AVAudioPCMBuffer,
        inputSampleRate: Double,
        targetSampleRate: Double) -> Data
    {
        guard let channelData = buffer.floatChannelData,
              buffer.frameLength > 0,
              inputSampleRate > 0,
              targetSampleRate > 0
        else { return Data() }
        let frameCount = Int(buffer.frameLength)
        let channelCount = max(1, Int(buffer.format.channelCount))
        let outputCount = max(1, Int((Double(frameCount) * targetSampleRate / inputSampleRate).rounded(.down)))
        var data = Data(capacity: outputCount * MemoryLayout<Int16>.size)
        for index in 0..<outputCount {
            let sourcePosition = Double(index) * inputSampleRate / targetSampleRate
            let lower = min(frameCount - 1, Int(sourcePosition.rounded(.down)))
            let upper = min(frameCount - 1, lower + 1)
            let fraction = Float(sourcePosition - Double(lower))
            var mixed: Float = 0
            for channel in 0..<channelCount {
                let samples = channelData[channel]
                mixed += samples[lower] + ((samples[upper] - samples[lower]) * fraction)
            }
            let sample = max(-1, min(1, mixed / Float(channelCount)))
            var intSample = Int16((sample * Float(Int16.max)).rounded()).littleEndian
            withUnsafeBytes(of: &intSample) { data.append(contentsOf: $0) }
        }
        return data
    }

    private nonisolated static func safeLogMessage(_ value: String) -> String {
        let singleLine = value
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
        if singleLine.count <= 180 {
            return singleLine
        }
        return String(singleLine.prefix(180)) + "..."
    }

    private func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }
}

extension RealtimeTalkRelaySession {
    private func startMicrophonePump(lifecycleGeneration: UInt64) throws {
        self.stopMicrophonePump()
        let input = self.audioEngine.inputNode
        let format = input.inputFormat(forBus: 0)
        let targetSampleRate = self.inputSampleRateHz
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw NSError(domain: "RealtimeTalkRelay", code: 5, userInfo: [
                NSLocalizedDescriptionKey: "Invalid realtime audio input format",
            ])
        }
        let tapBlock = makeRealtimeAudioTapBlock(
            inputSampleRate: format.sampleRate,
            targetSampleRate: targetSampleRate)
        { [weak self] encoded, timestampMs, rms in
            Task { @MainActor [weak self] in
                _ = self?.enqueueMicrophoneFrame(
                    encoded,
                    timestampMs: timestampMs,
                    rms: rms,
                    lifecycleGeneration: lifecycleGeneration)
            }
        }
        input.installTap(
            onBus: 0,
            bufferSize: Self.audioFrameBufferSize,
            format: format,
            block: tapBlock)
        self.audioEngine.prepare()
        try self.audioEngine.start()
    }

    @discardableResult
    private func enqueueMicrophoneFrame(
        _ encoded: Data,
        timestampMs: Double,
        rms: Float,
        lifecycleGeneration: UInt64) -> Task<Void, Never>?
    {
        guard self.isCurrentLifecycleLocally(lifecycleGeneration),
              let audioSender = self.audioSender
        else { return nil }
        self.recordMicrophoneFrame(byteCount: encoded.count, rms: rms, timestampMs: timestampMs)
        self.refreshOutputPlaybackState(timestampMs: timestampMs)
        if self.isOutputPlaying {
            if self.shouldSuppressMicrophoneDuringOutput() {
                self.recordSuppressedOutputEchoFrame(
                    byteCount: encoded.count,
                    rms: rms,
                    timestampMs: timestampMs)
                return nil
            }
            if rms >= Self.bargeInRmsThreshold {
                self.handleInputLevelDuringOutput(rms, timestampMs: timestampMs)
            }
        }

        let taskID = UUID()
        let task = Task { @MainActor [weak self, audioSender] in
            guard let self else { return }
            defer { self.audioSendTasks.removeValue(forKey: taskID) }
            guard self.isCurrentLifecycleLocally(lifecycleGeneration) else { return }
            guard let message = await audioSender.send(encoded, timestampMs: timestampMs) else { return }
            guard self.isCurrentLifecycleLocally(lifecycleGeneration) else { return }
            self.onStatus("Realtime audio failed: \(message)")
        }
        self.audioSendTasks[taskID] = task
        return task
    }

    private func shouldSuppressMicrophoneDuringOutput() -> Bool {
        let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
        // Built-in speaker output bleeds into the microphone even in voiceChat mode; keep the
        // realtime provider from treating its own speech as user input. Headsets keep barge-in.
        return outputs.contains { $0.portType == .builtInSpeaker }
    }

    private func recordMicrophoneFrame(byteCount: Int, rms: Float, timestampMs: Double) {
        guard !self.isClosed else { return }
        self.onInputLevel(TalkAudioLevel.normalized(rms: Double(rms)))
        self.micLogFrameCount += 1
        self.micLogByteCount += byteCount
        self.micLogMaxRms = max(self.micLogMaxRms, rms)
        guard timestampMs - self.lastMicLogAtMs >= 1000 else { return }
        self.lastMicLogAtMs = timestampMs
        let maxRms = String(format: "%.4f", Double(self.micLogMaxRms))
        GatewayDiagnostics.log(
            "talk realtime mic: buffers=\(self.micLogFrameCount) bytes=\(self.micLogByteCount) maxRms=\(maxRms)")
        self.micLogFrameCount = 0
        self.micLogByteCount = 0
        self.micLogMaxRms = 0
    }

    private func recordSuppressedOutputEchoFrame(byteCount: Int, rms: Float, timestampMs: Double) {
        self.suppressedEchoFrameCount += 1
        self.suppressedEchoByteCount += byteCount
        self.suppressedEchoMaxRms = max(self.suppressedEchoMaxRms, rms)
        guard timestampMs - self.lastSuppressedEchoLogAtMs >= 1000 else { return }
        self.lastSuppressedEchoLogAtMs = timestampMs
        let maxRms = String(format: "%.4f", Double(self.suppressedEchoMaxRms))
        GatewayDiagnostics.log(
            "talk realtime mic suppressed during output: "
                + "buffers=\(self.suppressedEchoFrameCount) "
                + "bytes=\(self.suppressedEchoByteCount) maxRms=\(maxRms)")
        self.suppressedEchoFrameCount = 0
        self.suppressedEchoByteCount = 0
        self.suppressedEchoMaxRms = 0
    }

    private func stopMicrophonePump() {
        self.audioEngine.inputNode.removeTap(onBus: 0)
        self.audioEngine.stop()
    }
}

extension RealtimeTalkRelaySession {
    func _test_setRelaySessionId(_ relaySessionId: String) {
        self.relaySessionId = relaySessionId
    }

    func _test_handleGatewayEvent(_ event: EventFrame) async {
        if self.startupTransport == nil {
            self.startupTransport = StartupTransport(
                subscribeServerEvents: { _ in AsyncStream { $0.finish() } },
                request: { _, _, _ in throw CancellationError() })
        }
        await self.handleGatewayEvent(event, lifecycleGeneration: self.lifecycleGeneration)
    }

    func _test_waitForStartupCancelled(timeoutSeconds: Int) async -> Bool {
        if case .cancelled = await self.waitForStartupResult(
            timeoutSeconds: timeoutSeconds,
            lifecycleGeneration: self.lifecycleGeneration)
        {
            return true
        }
        return false
    }

    func _test_waitForToolCalls() async {
        let tasks = self.toolCallTasks.values
        for task in tasks {
            await task.value
        }
    }

    func _test_startupReadyTimeoutSeconds() -> Int {
        Self.startupReadyTimeoutSeconds
    }

    func _test_markOutputAudioStarted(nowMs: Double) {
        self.markOutputAudioStarted(byteCount: 4800, nowMs: nowMs)
    }

    func _test_markOutputPlaybackFinished() {
        self.markOutputPlaybackFinished()
    }

    func _test_outputStartedAtMs() -> Double? {
        self.outputStartedAtMs
    }

    func _test_isOutputPlaying() -> Bool {
        self.isOutputPlaying
    }

    func _test_prepareAudioSender(relaySessionId: String) {
        guard let startupTransport else { return }
        self.isClosed = false
        self.audioSender = RealtimeAudioSender(
            relaySessionId: relaySessionId,
            request: startupTransport.request)
    }

    func _test_enqueueMicrophoneFrame(_ data: Data) -> Task<Void, Never>? {
        self.enqueueMicrophoneFrame(
            data,
            timestampMs: 1,
            rms: 0.01,
            lifecycleGeneration: self.lifecycleGeneration)
    }
}
