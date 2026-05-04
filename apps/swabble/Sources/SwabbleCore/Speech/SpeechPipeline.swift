import AVFoundation
import Foundation
import Speech

@available(macOS 26.0, iOS 26.0, *)
public struct SpeechSegment: Sendable {
    public let text: String
    public let isFinal: Bool
}

@available(macOS 26.0, iOS 26.0, *)
public enum SpeechPipelineError: Error {
    case authorizationDenied
    case analyzerFormatUnavailable
    case transcriberUnavailable
}

/// Live microphone → SpeechAnalyzer → SpeechTranscriber pipeline.
@available(macOS 26.0, iOS 26.0, *)
public actor SpeechPipeline {
    private struct UnsafeBuffer: @unchecked Sendable { let buffer: AVAudioPCMBuffer }

    private var engine = AVAudioEngine()
    private var transcriber: SpeechTranscriber?
    private var analyzer: SpeechAnalyzer?
    private var inputContinuation: AsyncStream<AnalyzerInput>.Continuation?
    private var resultTask: Task<Void, Never>?
    private let converter = BufferConverter()

    public init() {}

    public func start(localeIdentifier: String, etiquette: Bool) async throws -> AsyncStream<SpeechSegment> {
        let auth = await requestAuthorizationIfNeeded()
        guard auth == .authorized else { throw SpeechPipelineError.authorizationDenied }

        let transcriberModule = SpeechTranscriber(
            locale: Locale(identifier: localeIdentifier),
            transcriptionOptions: etiquette ? [.etiquetteReplacements] : [],
            reportingOptions: [.volatileResults],
            attributeOptions: [])
        transcriber = transcriberModule

        guard let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriberModule])
        else {
            throw SpeechPipelineError.analyzerFormatUnavailable
        }

        analyzer = SpeechAnalyzer(modules: [transcriberModule])
        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        inputContinuation = continuation

        let inputNode = engine.inputNode
        let inputFormat = inputNode.outputFormat(forBus: 0)
        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 2048, format: inputFormat) { [weak self] buffer, _ in
            guard let self else { return }
            let boxed = UnsafeBuffer(buffer: buffer)
            Task { await self.handleBuffer(boxed.buffer, targetFormat: analyzerFormat) }
        }

        engine.prepare()
        try engine.start()
        try await analyzer?.start(inputSequence: stream)

        guard let transcriberForStream = transcriber else {
            throw SpeechPipelineError.transcriberUnavailable
        }

        return AsyncStream { continuation in
            self.resultTask = Task {
                do {
                    for try await result in transcriberForStream.results {
                        let seg = SpeechSegment(text: String(result.text.characters), isFinal: result.isFinal)
                        continuation.yield(seg)
                    }
                } catch {
                    // swallow errors and finish
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in
                Task { await self.stop() }
            }
        }
    }

    public func stop() async {
        resultTask?.cancel()
        inputContinuation?.finish()
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        try? await analyzer?.finalizeAndFinishThroughEndOfInput()
    }

    private func handleBuffer(_ buffer: AVAudioPCMBuffer, targetFormat: AVAudioFormat) async {
        do {
            let converted = try converter.convert(buffer, to: targetFormat)
            let input = AnalyzerInput(buffer: converted)
            inputContinuation?.yield(input)
        } catch {
            // drop on conversion failure
        }
    }

    private func requestAuthorizationIfNeeded() async -> SFSpeechRecognizerAuthorizationStatus {
        let current = SFSpeechRecognizer.authorizationStatus()
        guard current == .notDetermined else { return current }
        return await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
    }
}
