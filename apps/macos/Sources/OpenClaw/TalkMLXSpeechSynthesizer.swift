import Dispatch
import Foundation
import OpenClawKit
import OpenClawMLXTTSProtocol
import OSLog
import Subprocess

protocol MLXTTSTransport: AnyObject, Sendable {
    func send(_ request: MLXTTSRequest) async throws
    func nextEvent() async throws -> MLXTTSEvent
    func close() async
}

typealias MLXTTSTransportFactory = @Sendable () async throws -> any MLXTTSTransport

struct MLXTTSPlaybackStream: Sendable {
    let sampleRate: Double
    let chunks: AsyncThrowingStream<Data, Error>
}

actor TalkMLXSpeechSynthesizer {
    enum SynthesizeError: Error {
        case canceled
        case modelLoadFailed(String)
        case audioGenerationFailed
        case audioPlaybackFailed
        case timedOut
    }

    static let shared = TalkMLXSpeechSynthesizer()
    static let defaultModelRepo = "mlx-community/Soprano-80M-bf16"

    private let logger = Logger(subsystem: "ai.openclaw", category: "talk.mlx")
    private let transportFactory: MLXTTSTransportFactory
    private let idleDuration: Duration
    private let cancelGraceDuration: Duration
    private let observesMemoryPressure: Bool
    private var transport: (any MLXTTSTransport)?
    private var activeID: String?
    private var cancelRequestedID: String?
    private var fallbackRequiredID: String?
    private var cancelEscalationTask: Task<Void, Never>?
    private var idleTask: Task<Void, Never>?
    private var memoryPressureMonitor: MLXMemoryPressureMonitor?

    private init() {
        self.transportFactory = {
            try await ProcessMLXTTSTransport.launch(invocation: TalkMLXSpeechSynthesizer.helperInvocation())
        }
        self.idleDuration = .seconds(300)
        self.cancelGraceDuration = .seconds(1)
        self.observesMemoryPressure = true
    }

    init(
        transportFactory: @escaping MLXTTSTransportFactory,
        idleDuration: Duration = .seconds(300),
        cancelGraceDuration: Duration = .seconds(1),
        observesMemoryPressure: Bool = false)
    {
        self.transportFactory = transportFactory
        self.idleDuration = idleDuration
        self.cancelGraceDuration = cancelGraceDuration
        self.observesMemoryPressure = observesMemoryPressure
    }

    func synthesize(
        text: String,
        modelRepo: String?,
        language: String?,
        voicePreset: String?,
        referenceAudioPath: String? = nil,
        referenceText: String? = nil) async throws -> Data
    {
        #if !arch(arm64)
        throw SynthesizeError.modelLoadFailed("MLX TTS requires Apple silicon")
        #else
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return Data() }
        guard self.activeID == nil else {
            throw SynthesizeError.audioGenerationFailed
        }

        self.ensureMemoryPressureMonitor()
        self.idleTask?.cancel()
        self.idleTask = nil

        let id = UUID().uuidString
        self.activeID = id
        let request = MLXTTSRequest.synthesize(MLXTTSSynthesizeRequest(
            id: id,
            text: trimmed,
            modelRepo: Self.resolvedModelRepo(modelRepo),
            language: language?.nilIfBlank,
            voice: voicePreset?.nilIfBlank,
            referenceAudioPath: referenceAudioPath?.nilIfBlank,
            referenceText: referenceText?.nilIfBlank))

        for attempt in 0...1 {
            do {
                let transport = try await ensureTransport()
                guard self.activeID == id, self.cancelRequestedID != id else {
                    await self.discardTransport(forRequest: id)
                    throw SynthesizeError.canceled
                }
                try await transport.send(request)
                let audio = try await waitForAudio(id: id, transport: transport)
                self.finishRequest(id: id)
                return try Self.makeWAV(audio: audio)
            } catch let error as SynthesizeError {
                let requiresFallback = self.fallbackRequiredID == id
                self.finishRequest(id: id)
                if requiresFallback {
                    throw SynthesizeError.audioGenerationFailed
                }
                throw error
            } catch is CancellationError {
                if self.activeID == id {
                    try? await self.transport?.send(.cancel(id: id))
                }
                await self.discardTransport(forRequest: id)
                self.finishRequest(id: id)
                throw SynthesizeError.canceled
            } catch {
                self.logger.error(
                    """
                    talk mlx helper transport failed attempt=\(attempt + 1, privacy: .public): \
                    \(error.localizedDescription, privacy: .public)
                    """)
                await self.discardTransport(forRequest: id)
                if self.fallbackRequiredID == id {
                    self.finishRequest(id: id)
                    throw SynthesizeError.audioGenerationFailed
                }
                if self.cancelRequestedID == id {
                    self.finishRequest(id: id)
                    throw SynthesizeError.canceled
                }
                guard self.activeID == id else {
                    throw SynthesizeError.canceled
                }
                if attempt == 0 {
                    continue
                }
                self.finishRequest(id: id)
                throw SynthesizeError.modelLoadFailed(Self.helperInvocation().displayName)
            }
        }

        self.finishRequest(id: id)
        throw SynthesizeError.audioGenerationFailed
        #endif
    }

    func synthesizeStream(
        text: String,
        modelRepo: String?,
        language: String?,
        voicePreset: String?,
        referenceAudioPath: String?,
        referenceText: String?,
        stallTimeoutSeconds: Double = 90) async throws -> MLXTTSPlaybackStream
    {
        #if !arch(arm64)
        throw SynthesizeError.modelLoadFailed("MLX TTS requires Apple silicon")
        #else
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return MLXTTSPlaybackStream(
                sampleRate: 1,
                chunks: AsyncThrowingStream { $0.finish() })
        }
        guard self.activeID == nil else {
            throw SynthesizeError.audioGenerationFailed
        }

        self.ensureMemoryPressureMonitor()
        self.idleTask?.cancel()
        self.idleTask = nil

        let id = UUID().uuidString
        self.activeID = id
        let request = MLXTTSRequest.synthesize(MLXTTSSynthesizeRequest(
            id: id,
            text: trimmed,
            modelRepo: Self.resolvedModelRepo(modelRepo),
            language: language?.nilIfBlank,
            voice: voicePreset?.nilIfBlank,
            referenceAudioPath: referenceAudioPath?.nilIfBlank,
            referenceText: referenceText?.nilIfBlank,
            stream: true))

        for attempt in 0...1 {
            do {
                let transport = try await ensureTransport()
                guard self.activeID == id, self.cancelRequestedID != id else {
                    await self.discardTransport(forRequest: id)
                    throw SynthesizeError.canceled
                }
                try await transport.send(request)
                let start = try await waitForStreamStart(id: id, transport: transport)
                switch start {
                case let .stream(info):
                    return MLXTTSPlaybackStream(
                        sampleRate: Double(info.sampleRate),
                        chunks: self.makeAudioStream(
                            id: id,
                            transport: transport,
                            stallTimeoutSeconds: stallTimeoutSeconds))
                case let .legacy(audio):
                    self.finishRequest(id: id)
                    return MLXTTSPlaybackStream(
                        sampleRate: Double(audio.sampleRate),
                        chunks: AsyncThrowingStream { continuation in
                            continuation.yield(audio.pcm)
                            continuation.finish()
                        })
                }
            } catch let error as SynthesizeError {
                let requiresFallback = self.fallbackRequiredID == id
                self.finishRequest(id: id)
                if requiresFallback {
                    throw SynthesizeError.audioGenerationFailed
                }
                throw error
            } catch is CancellationError {
                if self.activeID == id {
                    try? await self.transport?.send(.cancel(id: id))
                }
                await self.discardTransport(forRequest: id)
                self.finishRequest(id: id)
                throw SynthesizeError.canceled
            } catch {
                self.logger.error(
                    "talk mlx helper stream failed attempt=\(attempt + 1, privacy: .public): " +
                        "\(error.localizedDescription, privacy: .public)")
                await self.discardTransport(forRequest: id)
                if self.fallbackRequiredID == id {
                    self.finishRequest(id: id)
                    throw SynthesizeError.audioGenerationFailed
                }
                if self.cancelRequestedID == id {
                    self.finishRequest(id: id)
                    throw SynthesizeError.canceled
                }
                guard self.activeID == id else {
                    throw SynthesizeError.canceled
                }
                if attempt == 0 {
                    continue
                }
                self.finishRequest(id: id)
                throw SynthesizeError.modelLoadFailed(Self.helperInvocation().displayName)
            }
        }

        self.finishRequest(id: id)
        throw SynthesizeError.audioGenerationFailed
        #endif
    }

    func cancelCurrent() async {
        guard let activeID else { return }
        self.cancelRequestedID = activeID
        do {
            try await self.transport?.send(.cancel(id: activeID))
        } catch {
            await self.discardTransport(forRequest: activeID)
        }
        self.scheduleCancelEscalation(id: activeID)
    }

    func shutdown() async {
        self.cancelEscalationTask?.cancel()
        self.cancelEscalationTask = nil
        self.idleTask?.cancel()
        self.idleTask = nil
        if let activeID {
            try? await self.transport?.send(.cancel(id: activeID))
        }
        try? await self.transport?.send(.shutdown)
        activeID = nil
        self.cancelRequestedID = nil
        await self.discardTransport()
    }

    private func ensureTransport() async throws -> any MLXTTSTransport {
        if let transport = self.transport {
            return transport
        }

        let transport = try await transportFactory()
        // Publish the starting transport before waiting for `ready` so talk
        // cancellation and app shutdown can still terminate a wedged startup.
        self.transport = transport
        do {
            guard try await transport.nextEvent() == .ready else {
                throw MLXTTSTransportError.unexpectedEvent
            }
            self.logger.info("talk mlx helper ready")
            return transport
        } catch {
            // Shutdown can admit a replacement while this startup is unwinding.
            // Only the exact failed transport may surrender current ownership.
            if self.transport === transport {
                self.transport = nil
            }
            await transport.close()
            throw error
        }
    }

    private func waitForAudio(id: String, transport: any MLXTTSTransport) async throws -> MLXTTSAudio {
        while true {
            switch try await transport.nextEvent() {
            case let .audio(audio) where audio.id == id:
                guard self.cancelRequestedID != id else {
                    throw SynthesizeError.canceled
                }
                return audio
            case let .canceled(canceledID) where canceledID == id:
                throw SynthesizeError.canceled
            case let .error(error) where error.id == nil || error.id == id:
                switch error.code {
                case .canceled:
                    throw SynthesizeError.canceled
                case .modelLoadFailed:
                    throw SynthesizeError.modelLoadFailed(error.message)
                case .busy, .generationFailed, .invalidRequest, .protocolError:
                    throw SynthesizeError.audioGenerationFailed
                }
            case .ready, .audio, .streamStarted, .audioChunk, .completed, .error, .canceled:
                continue
            }
        }
    }

    private enum StreamStart {
        case stream(MLXTTSStreamStart)
        case legacy(MLXTTSAudio)
    }

    private func waitForStreamStart(
        id: String,
        transport: any MLXTTSTransport) async throws -> StreamStart
    {
        while true {
            switch try await transport.nextEvent() {
            case let .streamStarted(start) where start.id == id:
                guard start.format == .pcmS16LE, start.sampleRate > 0, start.channels == 1 else {
                    throw SynthesizeError.audioGenerationFailed
                }
                return .stream(start)
            case let .audio(audio) where audio.id == id:
                return .legacy(audio)
            case let .canceled(canceledID) where canceledID == id:
                throw SynthesizeError.canceled
            case let .error(error) where error.id == nil || error.id == id:
                throw Self.synthesizeError(error)
            case .ready, .audio, .streamStarted, .audioChunk, .completed, .error, .canceled:
                continue
            }
        }
    }

    private func makeAudioStream(
        id: String,
        transport: any MLXTTSTransport,
        stallTimeoutSeconds: Double) -> AsyncThrowingStream<Data, Error>
    {
        AsyncThrowingStream { continuation in
            Task { [weak self] in
                guard let self else {
                    continuation.finish(throwing: SynthesizeError.audioGenerationFailed)
                    return
                }
                await self.pumpAudioStream(
                    id: id,
                    transport: transport,
                    stallTimeoutSeconds: stallTimeoutSeconds,
                    continuation: continuation)
            }
            continuation.onTermination = { [weak self] _ in
                // Keep the pump alive to observe the helper's canceled event.
                // The id-scoped grace timer kills a helper that ignores cancel.
                Task { await self?.cancelStreamRequest(id: id, transport: transport) }
            }
        }
    }

    private func cancelStreamRequest(id: String, transport: any MLXTTSTransport) async {
        guard self.activeID == id else { return }
        self.cancelRequestedID = id
        do {
            try await transport.send(.cancel(id: id))
        } catch {
            await self.discardTransport(forRequest: id)
            return
        }
        self.scheduleCancelEscalation(id: id)
    }

    private func pumpAudioStream(
        id: String,
        transport: any MLXTTSTransport,
        stallTimeoutSeconds: Double,
        continuation: AsyncThrowingStream<Data, Error>.Continuation) async
    {
        do {
            while true {
                try Task.checkCancellation()
                let event = try await AsyncTimeout.withTimeout(
                    seconds: stallTimeoutSeconds,
                    onTimeout: { SynthesizeError.timedOut },
                    operation: { try await transport.nextEvent() })
                switch event {
                case let .audioChunk(chunk) where chunk.id == id:
                    guard self.cancelRequestedID != id else {
                        throw SynthesizeError.canceled
                    }
                    continuation.yield(chunk.pcm)
                case let .completed(completedID) where completedID == id:
                    self.finishRequest(id: id)
                    continuation.finish()
                    return
                case let .audio(audio) where audio.id == id:
                    continuation.yield(audio.pcm)
                    self.finishRequest(id: id)
                    continuation.finish()
                    return
                case let .canceled(canceledID) where canceledID == id:
                    throw SynthesizeError.canceled
                case let .error(error) where error.id == nil || error.id == id:
                    throw Self.synthesizeError(error)
                case .ready, .audio, .streamStarted, .audioChunk, .completed, .error, .canceled:
                    continue
                }
            }
        } catch SynthesizeError.timedOut {
            await self.discardTransport(forRequest: id)
            self.finishRequest(id: id)
            continuation.finish(throwing: SynthesizeError.timedOut)
        } catch {
            let requiresFallback = self.fallbackRequiredID == id
            self.finishRequest(id: id)
            continuation.finish(throwing: requiresFallback ? SynthesizeError.audioGenerationFailed : error)
        }
    }

    private static func synthesizeError(_ error: MLXTTSErrorEvent) -> SynthesizeError {
        switch error.code {
        case .canceled:
            .canceled
        case .modelLoadFailed:
            .modelLoadFailed(error.message)
        case .busy, .generationFailed, .invalidRequest, .protocolError:
            .audioGenerationFailed
        }
    }

    private func finishRequest(id: String) {
        if self.fallbackRequiredID == id {
            self.fallbackRequiredID = nil
        }
        guard self.activeID == id else { return }
        self.activeID = nil
        self.cancelRequestedID = nil
        self.cancelEscalationTask?.cancel()
        self.cancelEscalationTask = nil
        self.scheduleIdleShutdown()
    }

    private func scheduleCancelEscalation(id: String) {
        self.cancelEscalationTask?.cancel()
        let duration = self.cancelGraceDuration
        self.cancelEscalationTask = Task { [weak self] in
            do {
                try await Task.sleep(for: duration)
            } catch {
                return
            }
            await self?.terminateUnresponsiveCancellation(id: id)
        }
    }

    private func terminateUnresponsiveCancellation(id: String) async {
        guard self.activeID == id, self.cancelRequestedID == id else { return }
        // Soprano checks cancellation while producing tokens, but its final
        // decoder has no cancellation contract. Bound that phase with a kill.
        self.logger.info("talk mlx cancel grace expired; terminating helper")
        await self.discardTransport(forRequest: id)
    }

    private func scheduleIdleShutdown() {
        self.idleTask?.cancel()
        let duration = self.idleDuration
        self.idleTask = Task { [weak self] in
            do {
                try await Task.sleep(for: duration)
            } catch {
                return
            }
            await self?.shutdownIfIdle()
        }
    }

    private func shutdownIfIdle() async {
        guard self.activeID == nil else { return }
        self.logger.info("talk mlx helper idle shutdown")
        await self.shutdown()
    }

    private func ensureMemoryPressureMonitor() {
        guard self.observesMemoryPressure, self.memoryPressureMonitor == nil else { return }
        self.memoryPressureMonitor = MLXMemoryPressureMonitor { [weak self] in
            Task { await self?.handleMemoryPressure() }
        }
    }

    func handleMemoryPressure() async {
        self.logger.info("talk mlx helper memory-pressure shutdown")
        self.fallbackRequiredID = self.activeID
        await self.shutdown()
    }

    private func discardTransport(forRequest id: String) async {
        // A stale request may finish after shutdown admitted a replacement.
        guard self.activeID == id else { return }
        await self.discardTransport()
    }

    private func discardTransport() async {
        let transport = self.transport
        self.transport = nil
        await transport?.close()
    }

    fileprivate struct HelperInvocation: Sendable {
        let executableURL: URL
        let argumentPrefix: [String]
        let displayName: String
    }

    fileprivate static func helperInvocation() -> HelperInvocation {
        let fileManager = FileManager.default
        if let override = ProcessInfo.processInfo.environment["OPENCLAW_MLX_TTS_BIN"], !override.isEmpty {
            return HelperInvocation(
                executableURL: URL(fileURLWithPath: override),
                argumentPrefix: [],
                displayName: override)
        }

        if let executableDir = Bundle.main.executableURL?.deletingLastPathComponent() {
            let bundled = executableDir.appendingPathComponent("openclaw-mlx-tts")
            if fileManager.isExecutableFile(atPath: bundled.path) {
                return HelperInvocation(
                    executableURL: bundled,
                    argumentPrefix: [],
                    displayName: bundled.path)
            }
        }

        return HelperInvocation(
            executableURL: URL(fileURLWithPath: "/usr/bin/env"),
            argumentPrefix: ["openclaw-mlx-tts"],
            displayName: "openclaw-mlx-tts")
    }

    private static func resolvedModelRepo(_ modelRepo: String?) -> String {
        modelRepo?.nilIfBlank ?? self.defaultModelRepo
    }

    static func makeWAV(audio: MLXTTSAudio) throws -> Data {
        guard audio.format == .pcmS16LE,
              audio.sampleRate > 0,
              audio.sampleRate <= Int(UInt32.max),
              audio.channels > 0,
              audio.channels <= Int(UInt16.max),
              audio.pcm.count <= Int(UInt32.max) - 36,
              audio.pcm.count.isMultiple(of: MemoryLayout<Int16>.size * audio.channels)
        else {
            throw SynthesizeError.audioGenerationFailed
        }

        let channels = UInt16(audio.channels)
        let sampleRate = UInt32(audio.sampleRate)
        let bitsPerSample: UInt16 = 16
        let blockAlign = channels * (bitsPerSample / 8)
        let byteRate = sampleRate * UInt32(blockAlign)
        let dataSize = UInt32(audio.pcm.count)

        var data = Data(capacity: 44 + audio.pcm.count)
        data.append(contentsOf: [0x52, 0x49, 0x46, 0x46])
        data.appendLEUInt32(36 + dataSize)
        data.append(contentsOf: [0x57, 0x41, 0x56, 0x45])
        data.append(contentsOf: [0x66, 0x6D, 0x74, 0x20])
        data.appendLEUInt32(16)
        data.appendLEUInt16(1)
        data.appendLEUInt16(channels)
        data.appendLEUInt32(sampleRate)
        data.appendLEUInt32(byteRate)
        data.appendLEUInt16(blockAlign)
        data.appendLEUInt16(bitsPerSample)
        data.append(contentsOf: [0x64, 0x61, 0x74, 0x61])
        data.appendLEUInt32(dataSize)
        data.append(audio.pcm)
        return data
    }
}

private enum MLXTTSTransportError: Error {
    case closed
    case unexpectedEvent
}

private actor ProcessMLXTTSTransport: MLXTTSTransport {
    private let process: ManagedProcess
    private let input: FileHandle
    private let output: PipeReadStream
    private let chunkContinuation: AsyncStream<Data>.Continuation
    private let chunks: MLXChunkIterator
    private var decoder = MLXTTSFrameDecoder()
    private var pendingPayloads: [Data] = []
    private var isClosed = false

    private init(
        process: ManagedProcess,
        input: FileHandle,
        output: PipeReadStream,
        chunks: AsyncStream<Data>,
        chunkContinuation: AsyncStream<Data>.Continuation)
    {
        self.process = process
        self.input = input
        self.output = output
        self.chunks = MLXChunkIterator(stream: chunks)
        self.chunkContinuation = chunkContinuation
    }

    static func launch(invocation: TalkMLXSpeechSynthesizer.HelperInvocation) async throws
        -> ProcessMLXTTSTransport
    {
        let inputPipe = Pipe()
        let outputPipe = Pipe()
        // The helper child can exit at any time; without this a racing
        // send() to its stdin raises SIGPIPE and kills the app.
        inputPipe.fileHandleForWriting.disableSIGPIPE()

        let (stream, continuation) = AsyncStream<Data>.makeStream()
        let output = try PipeReadStream(
            handle: outputPipe.fileHandleForReading,
            onData: { continuation.yield($0) },
            onClose: { continuation.finish() })

        let configuration = Subprocess.Configuration(
            executable: .path(.init(invocation.executableURL.path)),
            arguments: Arguments(invocation.argumentPrefix))
        let process = ManagedProcess.launch(
            configuration: configuration,
            input: .fileDescriptor(
                .init(rawValue: inputPipe.fileHandleForReading.fileDescriptor),
                closeAfterSpawningProcess: false),
            output: .fileDescriptor(
                .init(rawValue: outputPipe.fileHandleForWriting.fileDescriptor),
                closeAfterSpawningProcess: false),
            error: .currentStandardError,
            closeAfterSpawn: [
                inputPipe.fileHandleForReading,
                outputPipe.fileHandleForReading,
                outputPipe.fileHandleForWriting,
            ])
        do {
            _ = try await process.waitUntilStarted()
        } catch {
            // The detached launch can still spawn; reap it before closing inherited pipes.
            await process.terminate(gracefully: false)
            output.close()
            continuation.finish()
            await output.finish()
            throw error
        }

        return ProcessMLXTTSTransport(
            process: process,
            input: inputPipe.fileHandleForWriting,
            output: output,
            chunks: stream,
            chunkContinuation: continuation)
    }

    func send(_ request: MLXTTSRequest) async throws {
        try self.input.write(contentsOf: MLXTTSFrameCodec.encode(request))
    }

    func nextEvent() async throws -> MLXTTSEvent {
        while true {
            if !self.pendingPayloads.isEmpty {
                let payload = self.pendingPayloads.removeFirst()
                return try MLXTTSFrameCodec.decode(MLXTTSEvent.self, payload: payload)
            }
            guard let chunk = await chunks.next() else {
                throw MLXTTSTransportError.closed
            }
            try self.pendingPayloads.append(contentsOf: self.decoder.append(chunk))
        }
    }

    func close() async {
        guard !self.isClosed else { return }
        self.isClosed = true
        self.output.close()
        self.chunkContinuation.finish()
        self.input.closeFile()
        await self.process.terminate()
        await self.output.finish()
    }
}

private final class MLXChunkIterator: @unchecked Sendable {
    private var iterator: AsyncStream<Data>.Iterator

    init(stream: AsyncStream<Data>) {
        self.iterator = stream.makeAsyncIterator()
    }

    func next() async -> Data? {
        await self.iterator.next()
    }
}

private final class MLXMemoryPressureMonitor: @unchecked Sendable {
    private let source: DispatchSourceMemoryPressure

    init(handler: @Sendable @escaping () -> Void) {
        self.source = DispatchSource.makeMemoryPressureSource(
            eventMask: [.warning, .critical],
            queue: .global(qos: .utility))
        self.source.setEventHandler(handler: handler)
        self.source.resume()
    }

    deinit {
        self.source.cancel()
    }
}

extension String {
    fileprivate var nilIfBlank: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

extension Data {
    fileprivate mutating func appendLEUInt16(_ value: UInt16) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { self.append(contentsOf: $0) }
    }

    fileprivate mutating func appendLEUInt32(_ value: UInt32) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { self.append(contentsOf: $0) }
    }
}
