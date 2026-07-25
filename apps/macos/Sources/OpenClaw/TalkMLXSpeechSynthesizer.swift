import Dispatch
import Foundation
import OpenClawMLXTTSProtocol
import OSLog

protocol MLXTTSTransport: AnyObject, Sendable {
    func send(_ request: MLXTTSRequest) async throws
    func nextEvent() async throws -> MLXTTSEvent
    func close() async
}

typealias MLXTTSTransportFactory = @Sendable () async throws -> any MLXTTSTransport

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
            try ProcessMLXTTSTransport.launch(invocation: TalkMLXSpeechSynthesizer.helperInvocation())
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
        voicePreset: String?) async throws -> Data
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
            voice: voicePreset?.nilIfBlank))

        for attempt in 0...1 {
            do {
                let transport = try await self.ensureTransport()
                guard self.activeID == id, self.cancelRequestedID != id else {
                    await self.discardTransport()
                    throw SynthesizeError.canceled
                }
                try await transport.send(request)
                let audio = try await self.waitForAudio(id: id, transport: transport)
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
                try? await self.transport?.send(.cancel(id: id))
                await self.discardTransport()
                self.finishRequest(id: id)
                throw SynthesizeError.canceled
            } catch {
                self.logger.error(
                    """
                    talk mlx helper transport failed attempt=\(attempt + 1, privacy: .public): \
                    \(error.localizedDescription, privacy: .public)
                    """)
                await self.discardTransport()
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
        guard let activeID = self.activeID else { return }
        self.cancelRequestedID = activeID
        do {
            try await self.transport?.send(.cancel(id: activeID))
        } catch {
            await self.discardTransport()
        }
        self.scheduleCancelEscalation(id: activeID)
    }

    func shutdown() async {
        self.cancelEscalationTask?.cancel()
        self.cancelEscalationTask = nil
        self.idleTask?.cancel()
        self.idleTask = nil
        if let activeID = self.activeID {
            try? await self.transport?.send(.cancel(id: activeID))
        }
        try? await self.transport?.send(.shutdown)
        self.activeID = nil
        self.cancelRequestedID = nil
        await self.discardTransport()
    }

    private func ensureTransport() async throws -> any MLXTTSTransport {
        if let transport = self.transport {
            return transport
        }

        let transport = try await self.transportFactory()
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
            self.transport = nil
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
            case .ready, .audio, .error, .canceled:
                continue
            }
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
        await self.discardTransport()
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
    private let process: Process
    private let input: FileHandle
    private let output: FileHandle
    private let chunkContinuation: AsyncStream<Data>.Continuation
    private let chunks: MLXChunkIterator
    private var decoder = MLXTTSFrameDecoder()
    private var pendingPayloads: [Data] = []
    private var isClosed = false

    private init(
        process: Process,
        input: FileHandle,
        output: FileHandle,
        chunks: AsyncStream<Data>,
        chunkContinuation: AsyncStream<Data>.Continuation)
    {
        self.process = process
        self.input = input
        self.output = output
        self.chunks = MLXChunkIterator(stream: chunks)
        self.chunkContinuation = chunkContinuation
    }

    static func launch(invocation: TalkMLXSpeechSynthesizer.HelperInvocation) throws -> ProcessMLXTTSTransport {
        let process = Process()
        let inputPipe = Pipe()
        let outputPipe = Pipe()
        process.executableURL = invocation.executableURL
        process.arguments = invocation.argumentPrefix
        process.standardInput = inputPipe
        process.standardOutput = outputPipe
        process.standardError = FileHandle.standardError

        let output = outputPipe.fileHandleForReading
        let (stream, continuation) = AsyncStream<Data>.makeStream()
        output.readabilityHandler = { handle in
            // Throwing read wrapper; availableData can raise ObjC exceptions on
            // closed/invalid handles and abort the process (FileHandle+SafeRead).
            let data = handle.readSafely(upToCount: 64 * 1024)
            if data.isEmpty {
                handle.readabilityHandler = nil
                continuation.finish()
            } else {
                continuation.yield(data)
            }
        }

        do {
            try process.run()
        } catch {
            output.readabilityHandler = nil
            continuation.finish()
            throw error
        }
        inputPipe.fileHandleForReading.closeFile()
        outputPipe.fileHandleForWriting.closeFile()

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
            guard let chunk = await self.chunks.next() else {
                throw MLXTTSTransportError.closed
            }
            try self.pendingPayloads.append(contentsOf: self.decoder.append(chunk))
        }
    }

    func close() async {
        guard !self.isClosed else { return }
        self.isClosed = true
        self.output.readabilityHandler = nil
        self.chunkContinuation.finish()
        self.input.closeFile()
        self.output.closeFile()
        if self.process.isRunning {
            self.process.terminate()
        }
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
        let trimmed = self.trimmingCharacters(in: .whitespacesAndNewlines)
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
