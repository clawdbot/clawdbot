import Foundation
import MLXAudioTTS
import OpenClawMLXTTSProtocol

protocol MLXTTSSpeechModel: AnyObject, Sendable {
    var sampleRate: Int { get }

    func generate(text: String, voice: String?, language: String?) async throws -> [Float]
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
            guard self.currentID == id, let task = self.currentTask else {
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
            let samples = try await model.generate(
                text: request.text,
                voice: request.voice,
                language: request.language)
            try Task.checkCancellation()
            let audio = MLXTTSAudio(
                id: request.id,
                sampleRate: model.sampleRate,
                pcm: Self.makePCM16(samples: samples))
            await self.finish(event: .audio(audio), id: request.id)
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
        if let cachedModel = self.cachedModel, cachedModel.repo == repo {
            return cachedModel.model
        }

        // Only one model is retained. Dropping the previous reference before
        // loading a new repo avoids holding both sets of MLX weights at once.
        self.cachedModel = nil
        let model = try await self.loadModel(repo)
        self.cachedModel = CachedModel(repo: repo, model: model)
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

    func generate(text: String, voice: String?, language: String?) async throws -> [Float] {
        let generatedAudio = try await self.raw.generate(
            text: text,
            voice: voice,
            refAudio: nil,
            refText: nil,
            language: language)
        return generatedAudio.asArray(Float.self)
    }
}
