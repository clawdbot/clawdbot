import AVFAudio
import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import OSLog

private func makeRealtimeAudioTapBlock(
    inputSampleRate: Double,
    targetSampleRate: Double,
    onAudio: @escaping (Data, Double) -> Void) -> AVAudioNodeTapBlock
{
    { buffer, _ in
        // This callback runs on Core Audio's realtime queue, not MainActor.
        let encoded = RealtimeTalkRelaySession.encodePCM16(
            buffer: buffer,
            inputSampleRate: inputSampleRate,
            targetSampleRate: targetSampleRate)
        guard !encoded.isEmpty else { return }
        let timestampMs = ProcessInfo.processInfo.systemUptime * 1000
        onAudio(encoded, timestampMs)
    }
}

private actor RealtimeAudioSender {
    private let gateway: GatewayNodeSession
    private var relaySessionId: String?
    private var pendingSends = 0
    private let maxPendingSends = 4

    init(gateway: GatewayNodeSession, relaySessionId: String) {
        self.gateway = gateway
        self.relaySessionId = relaySessionId
    }

    func close() {
        self.relaySessionId = nil
    }

    func send(_ data: Data, timestampMs: Double) async -> String? {
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
            _ = try await Self.requestJSON(
                gateway: self.gateway,
                method: "talk.session.appendAudio",
                payload: payload,
                decodeAs: TalkSessionOkResult.self,
                timeoutSeconds: 8)
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    private static func requestJSON<T: Decodable>(
        gateway: GatewayNodeSession,
        method: String,
        payload: [String: Any],
        decodeAs type: T.Type,
        timeoutSeconds: Int) async throws -> T
    {
        let data = try JSONSerialization.data(withJSONObject: payload)
        guard let json = String(data: data, encoding: .utf8) else {
            throw NSError(domain: "RealtimeTalkRelay", code: 4, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode \(method) payload",
            ])
        }
        let response = try await gateway.request(
            method: method,
            paramsJSON: json,
            timeoutSeconds: timeoutSeconds)
        return try JSONDecoder().decode(type, from: response)
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

    private struct ToolCallStartResponse: Decodable {
        let runId: String?
        let idempotencyKey: String?
    }

    private struct ChatCompletionResult {
        let text: String?
        let failed: Bool
    }

    private nonisolated static let expectedInputEncoding = "pcm16"
    private nonisolated static let expectedOutputEncoding = "pcm16"
    private nonisolated static let defaultSampleRateHz = 24000
    private nonisolated static let audioFrameBufferSize: AVAudioFrameCount = 2048

    private let gateway: GatewayNodeSession
    private let options: Options
    private let pcmPlayer: PCMStreamingAudioPlaying
    private let logger = Logger(subsystem: "ai.openclaw", category: "RealtimeTalkRelay")
    private let onStatus: (String) -> Void
    private let onSpeakingChanged: (Bool) -> Void

    private let audioEngine = AVAudioEngine()
    private var relaySessionId: String?
    private var inputSampleRateHz = Double(RealtimeTalkRelaySession.defaultSampleRateHz)
    private var outputSampleRateHz = Double(RealtimeTalkRelaySession.defaultSampleRateHz)
    private var eventTask: Task<Void, Never>?
    private var outputTask: Task<Void, Never>?
    private var outputContinuation: AsyncThrowingStream<Data, Error>.Continuation?
    private var audioSender: RealtimeAudioSender?
    private var isClosed = false
    private var isOutputPlaying = false

    init(
        gateway: GatewayNodeSession,
        options: Options,
        pcmPlayer: PCMStreamingAudioPlaying,
        onStatus: @escaping (String) -> Void,
        onSpeakingChanged: @escaping (Bool) -> Void)
    {
        self.gateway = gateway
        self.options = options
        self.pcmPlayer = pcmPlayer
        self.onStatus = onStatus
        self.onSpeakingChanged = onSpeakingChanged
    }

    func start() async throws {
        self.isClosed = false
        self.onStatus("Connecting realtime…")
        let result = try await self.createRelaySession()
        guard let relaySessionId = result.relaysessionid?.trimmingCharacters(in: .whitespacesAndNewlines),
              !relaySessionId.isEmpty
        else {
            throw NSError(domain: "RealtimeTalkRelay", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Gateway did not return a realtime relay session",
            ])
        }
        self.relaySessionId = relaySessionId
        do {
            self.audioSender = RealtimeAudioSender(gateway: self.gateway, relaySessionId: relaySessionId)
            let eventStream = await self.gateway.subscribeServerEvents(bufferingNewest: 200)
            self.startEventPump(stream: eventStream)
            self.configureAudioContract(result.audio)
            self.startOutputPlayback()
            try self.startMicrophonePump()
            self.onStatus("Listening (Realtime)")
        } catch {
            let createdRelaySessionId = self.relaySessionId
            self.close(sendClose: false)
            if let createdRelaySessionId {
                await Self.closeRelaySession(gateway: self.gateway, relaySessionId: createdRelaySessionId)
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
        self.stopMicrophonePump()
        self.eventTask?.cancel()
        self.eventTask = nil
        let audioSender = self.audioSender
        self.audioSender = nil
        Task { await audioSender?.close() }
        self.stopOutputPlayback()
        if sendClose, let relaySessionId = self.relaySessionId {
            Task { [gateway] in
                await Self.closeRelaySession(gateway: gateway, relaySessionId: relaySessionId)
            }
        }
        self.relaySessionId = nil
        self.onSpeakingChanged(false)
    }

    private nonisolated static func closeRelaySession(
        gateway: GatewayNodeSession,
        relaySessionId: String) async
    {
        let payload = ["sessionId": relaySessionId]
        let data = try? JSONSerialization.data(withJSONObject: payload)
        let json = data.flatMap { String(data: $0, encoding: .utf8) }
        _ = try? await gateway.request(
            method: "talk.session.close",
            paramsJSON: json,
            timeoutSeconds: 8)
    }

    func cancelOutput(reason: String = "user") {
        self.stopOutputPlayback()
        self.startOutputPlayback()
        guard let relaySessionId else { return }
        Task { [gateway] in
            let payload: [String: Any] = [
                "sessionId": relaySessionId,
                "reason": reason,
            ]
            let data = try? JSONSerialization.data(withJSONObject: payload)
            let json = data.flatMap { String(data: $0, encoding: .utf8) }
            _ = try? await gateway.request(
                method: "talk.session.cancelOutput",
                paramsJSON: json,
                timeoutSeconds: 8)
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
        let response = try await self.gateway.request(
            method: "talk.session.create",
            paramsJSON: json,
            timeoutSeconds: 20)
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

    private func startEventPump(stream: AsyncStream<EventFrame>) {
        self.eventTask?.cancel()
        self.eventTask = Task { [weak self] in
            for await event in stream {
                if Task.isCancelled { return }
                await self?.handleGatewayEvent(event)
            }
        }
    }

    private func handleGatewayEvent(_ event: EventFrame) async {
        guard event.event == "talk.event",
              let payload = event.payload?.dictionaryValue
        else { return }
        if let relaySessionId,
           payload["relaySessionId"]?.stringValue != relaySessionId
        {
            return
        }
        guard let type = payload["type"]?.stringValue else { return }
        switch type {
        case "ready":
            self.onStatus("Listening (Realtime)")
        case "audio":
            guard let base64 = payload["audioBase64"]?.stringValue,
                  let data = Data(base64Encoded: base64)
            else { return }
            self.isOutputPlaying = true
            self.onSpeakingChanged(true)
            self.outputContinuation?.yield(data)
        case "clear":
            self.stopOutputPlayback()
            self.startOutputPlayback()
        case "transcript":
            self.handleTranscriptEvent(payload)
        case "toolCall":
            await self.handleToolCall(payload)
        case "error":
            let message = payload["message"]?.stringValue ?? "Realtime failed"
            GatewayDiagnostics.log("talk realtime: error=\(Self.safeLogMessage(message))")
            self.onStatus(message)
        case "close":
            self.onStatus("Ready")
            self.close(sendClose: false)
        default:
            return
        }
    }

    private func handleTranscriptEvent(_ payload: [String: AnyCodable]) {
        guard payload["final"]?.boolValue == true else { return }
        let role = payload["role"]?.stringValue ?? ""
        if role == "user" {
            self.onStatus("Thinking…")
        } else if role == "assistant" {
            self.onStatus("Listening (Realtime)")
        }
    }

    private func handleToolCall(_ payload: [String: AnyCodable]) async {
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
                    args: payload["args"])
                return
            }
            let completionStream = await self.gateway.subscribeServerEvents(bufferingNewest: 200)
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
                timeoutSeconds: 30)
            guard let runId = startResponse.runId ?? startResponse.idempotencyKey else {
                throw NSError(domain: "RealtimeTalkRelay", code: 3, userInfo: [
                    NSLocalizedDescriptionKey: "Realtime tool call did not return a run id",
                ])
            }
            let completion = await self.waitForChatCompletion(
                runId: runId,
                stream: completionStream,
                timeoutSeconds: 120)
            let result: [String: Any] = completion.failed
                ? ["error": "OpenClaw tool call failed"]
                : ["text": completion.text ?? "OpenClaw finished with no text."]
            try await self.submitToolResult(callId: callId, result: result)
            self.onStatus("Listening (Realtime)")
        } catch {
            try? await self.submitToolResult(callId: callId, result: [
                "error": error.localizedDescription,
            ])
            self.onStatus("Listening (Realtime)")
        }
    }

    private func handleAgentControlToolCall(
        callId: String,
        relaySessionId: String,
        args: AnyCodable?) async throws
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
            timeoutSeconds: 30)
        let result = response.dictionaryValue?.mapValues(\.foundationValue) ?? [
            "result": response.foundationValue,
        ]
        try await self.submitToolResult(callId: callId, result: result)
        self.onStatus("Listening (Realtime)")
    }

    private func submitToolResult(callId: String, result: [String: Any]) async throws {
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
            timeoutSeconds: 30)
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
        timeoutSeconds: Int) async throws -> T
    {
        let data = try JSONSerialization.data(withJSONObject: payload)
        guard let json = String(data: data, encoding: .utf8) else {
            throw NSError(domain: "RealtimeTalkRelay", code: 4, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode \(method) payload",
            ])
        }
        let response = try await self.gateway.request(
            method: method,
            paramsJSON: json,
            timeoutSeconds: timeoutSeconds)
        return try JSONDecoder().decode(type, from: response)
    }

    private func startMicrophonePump() throws {
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
        { [weak self, audioSender = self.audioSender] encoded, timestampMs in
            guard let audioSender else { return }
            Task {
                guard let message = await audioSender.send(encoded, timestampMs: timestampMs) else { return }
                await MainActor.run { [weak self] in
                    guard let self, !self.isClosed else { return }
                    self.onStatus("Realtime audio failed: \(message)")
                }
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

    private func stopMicrophonePump() {
        self.audioEngine.inputNode.removeTap(onBus: 0)
        self.audioEngine.stop()
    }

    private func startOutputPlayback() {
        self.stopOutputPlayback()
        let stream = AsyncThrowingStream<Data, Error> { continuation in
            self.outputContinuation = continuation
        }
        self.outputTask = Task { [weak self] in
            guard let self else { return }
            let result = await self.pcmPlayer.play(stream: stream, sampleRate: self.outputSampleRateHz)
            await MainActor.run {
                if !result.finished, let interruptedAt = result.interruptedAt {
                    self.logger.info("realtime output interrupted at \(interruptedAt, privacy: .public)s")
                }
                self.isOutputPlaying = false
                self.onSpeakingChanged(false)
            }
        }
    }

    private func stopOutputPlayback() {
        self.outputContinuation?.finish()
        self.outputContinuation = nil
        self.outputTask?.cancel()
        self.outputTask = nil
        _ = self.pcmPlayer.stop()
        self.isOutputPlaying = false
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
