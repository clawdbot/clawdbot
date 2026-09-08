import Foundation
@preconcurrency import MLX
import MLXAudioCore
import MLXAudioTTS
import OpenClawMLXTTSProtocol

protocol MLXTTSSpeechModel: AnyObject, Sendable {
    var sampleRate: Int { get }

    func generate(
        text: String,
        voice: String?,
        language: String?,
        referenceAudioPath: String?,
        referenceText: String?) async throws -> [Float]

    func generateStream(
        text: String,
        voice: String?,
        language: String?,
        referenceAudioPath: String?,
        referenceText: String?) -> AsyncThrowingStream<[Float], Error>
}

typealias MLXTTSModelLoader = @Sendable (String) async throws -> any MLXTTSSpeechModel

public actor MLXTTSHelperService {
    private struct CachedModel {
        let repo: String
        let model: any MLXTTSSpeechModel
    }

    private let loadModel: MLXTTSModelLoader
    private let emit: @Sendable (MLXTTSEvent) async -> Void
    private var cachedModel: CachedModel?
    private var currentID: String?
    private var currentTask: Task<Void, Never>?

    public init(eventSink: @Sendable @escaping (MLXTTSEvent) async -> Void) {
        self.loadModel = { repo in
            let model = try await TTS.loadModel(modelRepo: repo)
            return UncheckedSpeechModel(raw: model)
        }
        self.emit = eventSink
    }

    init(
        loadModel: @escaping MLXTTSModelLoader,
        eventSink: @Sendable @escaping (MLXTTSEvent) async -> Void)
    {
        self.loadModel = loadModel
        self.emit = eventSink
    }

    @discardableResult
    public func handle(_ request: MLXTTSRequest) async -> Bool {
        switch request {
        case let .synthesize(synthesize):
            guard self.currentTask == nil else {
                await self.emit(.error(MLXTTSErrorEvent(
                    id: synthesize.id,
                    code: .busy,
                    message: "another synthesis is already in flight")))
                return true
            }
            self.currentID = synthesize.id
            self.currentTask = Task { await self.run(synthesize) }
            return true

        case let .cancel(id):
            guard self.currentID == id, let task = currentTask else {
                await self.emit(.canceled(id: id))
                return true
            }
            task.cancel()
            return true

        case .shutdown:
            self.currentTask?.cancel()
            await self.currentTask?.value
            self.currentTask = nil
            self.currentID = nil
            self.cachedModel = nil
            return false
        }
    }

    func waitUntilIdle() async {
        await self.currentTask?.value
    }

    private func run(_ request: MLXTTSSynthesizeRequest) async {
        let model: any MLXTTSSpeechModel
        do {
            model = try await self.model(repo: request.modelRepo)
        } catch is CancellationError {
            await self.finishCanceled(id: request.id)
            return
        } catch {
            await self.finish(
                event: .error(MLXTTSErrorEvent(
                    id: request.id,
                    code: .modelLoadFailed,
                    message: String(describing: error))),
                id: request.id)
            return
        }

        do {
            try Task.checkCancellation()
            if request.stream {
                var started = false
                for try await samples in model.generateStream(
                    text: request.text,
                    voice: request.voice,
                    language: request.language,
                    referenceAudioPath: request.referenceAudioPath,
                    referenceText: request.referenceText)
                {
                    try Task.checkCancellation()
                    guard !samples.isEmpty else { continue }
                    if !started {
                        started = true
                        await self.emit(.streamStarted(MLXTTSStreamStart(
                            id: request.id,
                            sampleRate: model.sampleRate)))
                    }
                    await self.emit(.audioChunk(MLXTTSAudioChunk(
                        id: request.id,
                        pcm: Self.makePCM16(samples: samples))))
                }
                guard started else {
                    throw AudioGenerationError.generationFailed("generation produced no audio")
                }
                await self.finish(event: .completed(id: request.id), id: request.id)
            } else {
                let samples = try await model.generate(
                    text: request.text,
                    voice: request.voice,
                    language: request.language,
                    referenceAudioPath: request.referenceAudioPath,
                    referenceText: request.referenceText)
                try Task.checkCancellation()
                let audio = MLXTTSAudio(
                    id: request.id,
                    sampleRate: model.sampleRate,
                    pcm: Self.makePCM16(samples: samples))
                await self.finish(event: .audio(audio), id: request.id)
            }
        } catch is CancellationError {
            await self.finishCanceled(id: request.id)
        } catch {
            await self.finish(
                event: .error(MLXTTSErrorEvent(
                    id: request.id,
                    code: .generationFailed,
                    message: String(describing: error))),
                id: request.id)
        }
    }

    private func model(repo: String) async throws -> any MLXTTSSpeechModel {
        if let cachedModel, cachedModel.repo == repo {
            return cachedModel.model
        }

        // Only one model is retained. Dropping the previous reference before
        // loading a new repo avoids holding both sets of MLX weights at once.
        cachedModel = nil
        let model = try await loadModel(repo)
        cachedModel = CachedModel(repo: repo, model: model)
        return model
    }

    private func finishCanceled(id: String) async {
        await self.finish(event: .canceled(id: id), id: id)
    }

    private func finish(event: MLXTTSEvent, id: String) async {
        guard self.currentID == id else { return }
        self.currentID = nil
        self.currentTask = nil
        await self.emit(event)
    }

    static func makePCM16(samples: [Float]) -> Data {
        var data = Data(capacity: samples.count * MemoryLayout<Int16>.size)
        for sample in samples {
            let clamped = max(-1, min(1, sample))
            var value = Int16((clamped * Float(Int16.max)).rounded()).littleEndian
            Swift.withUnsafeBytes(of: &value) { data.append(contentsOf: $0) }
        }
        return data
    }
}

private final class UncheckedSpeechModel: MLXTTSSpeechModel, @unchecked Sendable {
    let raw: any SpeechGenerationModel

    init(raw: any SpeechGenerationModel) {
        self.raw = raw
    }

    var sampleRate: Int {
        self.raw.sampleRate
    }

    func generate(
        text: String,
        voice: String?,
        language: String?,
        referenceAudioPath: String?,
        referenceText: String?) async throws -> [Float]
    {
        let referenceAudio = try loadReferenceAudio(path: referenceAudioPath)
        let generatedAudio = try await raw.generate(
            text: text,
            voice: voice,
            refAudio: referenceAudio,
            refText: referenceText,
            language: language)
        return generatedAudio.asArray(Float.self)
    }

    func generateStream(
        text: String,
        voice: String?,
        language: String?,
        referenceAudioPath: String?,
        referenceText: String?) -> AsyncThrowingStream<[Float], Error>
    {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let referenceAudio = try self.loadReferenceAudio(path: referenceAudioPath)
                    for try await samples in self.raw.generateSamplesStream(
                        text: text,
                        voice: voice,
                        refAudio: referenceAudio,
                        refText: referenceText,
                        language: language)
                    {
                        try Task.checkCancellation()
                        continuation.yield(samples)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private func loadReferenceAudio(path: String?) throws -> MLXArray? {
        guard let path = path?.trimmingCharacters(in: .whitespacesAndNewlines), !path.isEmpty else {
            return nil
        }
        let expanded = NSString(string: path).expandingTildeInPath
        let (_, audio) = try loadAudioArray(
            from: URL(fileURLWithPath: expanded),
            sampleRate: sampleRate)
        return audio
    }
}
