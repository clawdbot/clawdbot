import AVFoundation
import OpenClawKit
import ReplayKit

final class ScreenRecordService: @unchecked Sendable {
    typealias CaptureHandler = @Sendable (CMSampleBuffer, RPSampleBufferType, Error?) -> Void
    typealias CaptureCompletion = @Sendable (Error?) -> Void
    typealias StartCaptureAction = @MainActor @Sendable (
        Bool,
        @escaping CaptureHandler,
        @escaping CaptureCompletion)
        -> Void
    typealias StopCaptureAction = @MainActor @Sendable (@escaping CaptureCompletion) -> Void

    private struct UncheckedSendableBox<T>: @unchecked Sendable {
        let value: T
    }

    private final class CaptureState: @unchecked Sendable {
        private let lock = NSLock()
        var writer: AVAssetWriter?
        var videoInput: AVAssetWriterInput?
        var audioInput: AVAssetWriterInput?
        var started = false
        var sawVideo = false
        var lastVideoTime: CMTime?
        var handlerError: Error?
        var acceptingSamples = true

        func withLock<T>(_ body: (CaptureState) -> T) -> T {
            self.lock.lock()
            defer { lock.unlock() }
            return body(self)
        }
    }

    /// Owns cancellation only until ReplayKit resolves startup. A cancelled
    /// pending start keeps its caller's capture lease until both start and the
    /// one matching stop resolve, so late capture cannot escape into a new owner.
    private final class CaptureStartOperation: @unchecked Sendable {
        private enum Phase {
            case idle
            case starting
            case startRequested
            case cancelling
            case cancelled
            case finished
        }

        private struct State {
            var phase: Phase = .idle
            var continuation: CheckedContinuation<Void, Error>?
            var startResult: Result<Void, Error>?
            var stopRequested = false
            var stopCompleted = false
        }

        private let lock = NSLock()
        private var state = State()
        private let startAction: @MainActor @Sendable (@escaping CaptureCompletion) -> Void
        private let stopAction: StopCaptureAction

        init(
            startAction: @escaping @MainActor @Sendable (@escaping CaptureCompletion) -> Void,
            stopAction: @escaping StopCaptureAction)
        {
            self.startAction = startAction
            self.stopAction = stopAction
        }

        @MainActor
        func run() async throws {
            try Task.checkCancellation()
            try await withTaskCancellationHandler(operation: {
                try await withCheckedThrowingContinuation { continuation in
                    self.begin(continuation)
                }
            }, onCancel: {
                self.cancel()
            })
        }

        private func cancel() {
            self.withLock { state in
                switch state.phase {
                case .idle:
                    state.phase = .cancelled
                case .starting, .startRequested:
                    state.phase = .cancelling
                case .cancelling, .cancelled, .finished:
                    break
                }
            }
        }

        @MainActor
        private func begin(_ continuation: CheckedContinuation<Void, Error>) {
            let shouldStart = self.withLock { state -> Bool in
                switch state.phase {
                case .idle:
                    state.phase = .starting
                    state.continuation = continuation
                    return true
                case .cancelled:
                    state.phase = .finished
                    return false
                case .starting, .startRequested, .cancelling, .finished:
                    preconditionFailure("ReplayKit capture start operation can only run once")
                }
            }
            guard shouldStart else {
                continuation.resume(throwing: CancellationError())
                return
            }

            self.startAction { [weak self] error in
                self?.captureDidStart(error: error)
            }

            self.withLock { state in
                switch state.phase {
                case .starting:
                    state.phase = .startRequested
                case .cancelling, .finished:
                    break
                case .idle, .startRequested, .cancelled:
                    break
                }
            }
        }

        private func captureDidStart(error: Error?) {
            let result: Result<Void, Error> = error.map(Result.failure) ?? .success(())
            var shouldStop = false
            let completion = self.withLock { state -> (CheckedContinuation<Void, Error>, Result<Void, Error>)? in
                switch state.phase {
                case .starting, .startRequested:
                    state.phase = .finished
                    guard let continuation = state.continuation else { return nil }
                    state.continuation = nil
                    return (continuation, result)
                case .cancelling:
                    state.startResult = result
                    if case .success = result, !state.stopRequested {
                        state.stopRequested = true
                        shouldStop = true
                    }
                    return Self.takeCancellationCompletionIfReady(state: &state)
                case .idle, .cancelled, .finished:
                    return nil
                }
            }
            if shouldStop {
                Task { @MainActor in self.requestStop() }
            }
            Self.resume(completion)
        }

        @MainActor
        private func requestStop() {
            self.stopAction { [weak self] _ in
                self?.captureStopDidComplete()
            }
        }

        private func captureStopDidComplete() {
            let completion = self.withLock { state -> (CheckedContinuation<Void, Error>, Result<Void, Error>)? in
                guard state.phase == .cancelling else { return nil }
                state.stopCompleted = true
                return Self.takeCancellationCompletionIfReady(state: &state)
            }
            Self.resume(completion)
        }

        private static func takeCancellationCompletionIfReady(
            state: inout State) -> (CheckedContinuation<Void, Error>, Result<Void, Error>)?
        {
            guard state.phase == .cancelling,
                  let startResult = state.startResult,
                  let continuation = state.continuation
            else { return nil }

            let cleanupComplete: Bool = switch startResult {
            case .success:
                state.stopRequested && state.stopCompleted
            case .failure:
                true
            }
            guard cleanupComplete else { return nil }

            state.phase = .finished
            state.continuation = nil
            return (continuation, .failure(CancellationError()))
        }

        private static func resume(
            _ completion: (CheckedContinuation<Void, Error>, Result<Void, Error>)?)
        {
            guard let (continuation, result) = completion else { return }
            continuation.resume(with: result)
        }

        private func withLock<T>(_ body: (inout State) -> T) -> T {
            self.lock.lock()
            defer { self.lock.unlock() }
            return body(&self.state)
        }
    }

    private let startReplayKitCaptureAction: StartCaptureAction
    private let stopReplayKitCaptureAction: StopCaptureAction
    private let recordQueue: DispatchQueue

    init(
        recordQueue: DispatchQueue = DispatchQueue(label: "ai.openclawfoundation.app.screenrecord"),
        startReplayKitCaptureAction: @escaping StartCaptureAction = { includeAudio, handler, completion in
            startReplayKitCapture(
                includeAudio: includeAudio,
                handler: handler,
                completion: completion)
        },
        stopReplayKitCaptureAction: @escaping StopCaptureAction = { completion in
            stopReplayKitCapture(completion)
        })
    {
        self.recordQueue = recordQueue
        self.startReplayKitCaptureAction = startReplayKitCaptureAction
        self.stopReplayKitCaptureAction = stopReplayKitCaptureAction
    }

    enum ScreenRecordError: LocalizedError {
        case invalidScreenIndex(Int)
        case captureFailed(String)
        case writeFailed(String)

        var errorDescription: String? {
            switch self {
            case let .invalidScreenIndex(idx):
                "Invalid screen index \(idx)"
            case let .captureFailed(msg):
                msg
            case let .writeFailed(msg):
                msg
            }
        }
    }

    func record(
        screenIndex: Int?,
        durationMs: Int?,
        fps: Double?,
        includeAudio: Bool?,
        outPath: String?) async throws -> String
    {
        let config = try self.makeRecordConfig(
            screenIndex: screenIndex,
            durationMs: durationMs,
            fps: fps,
            includeAudio: includeAudio,
            outPath: outPath)

        let state = CaptureState()
        do {
            try await self.startCapture(state: state, config: config)
            do {
                try await Task.sleep(nanoseconds: UInt64(config.durationMs) * 1_000_000)
            } catch {
                try? await self.stopCapture()
                throw error
            }
            try await self.stopCapture()
            try await self.finishCapture(state: state)
            return config.outURL.path
        } catch {
            await self.discardCapture(state: state, outputURL: config.outURL)
            throw error
        }
    }

    private struct RecordConfig {
        let durationMs: Int
        let fpsValue: Double
        let includeAudio: Bool
        let outURL: URL
    }

    private func makeRecordConfig(
        screenIndex: Int?,
        durationMs: Int?,
        fps: Double?,
        includeAudio: Bool?,
        outPath: String?) throws -> RecordConfig
    {
        if let idx = screenIndex, idx != 0 {
            throw ScreenRecordError.invalidScreenIndex(idx)
        }

        let durationMs = CaptureRateLimits.clampDurationMs(durationMs)
        let fps = CaptureRateLimits.clampFps(fps, maxFps: 30)
        let fpsInt = Int32(fps.rounded())
        let fpsValue = Double(fpsInt)
        let includeAudio = includeAudio ?? true

        let outURL = self.makeOutputURL(outPath: outPath)
        try? FileManager().removeItem(at: outURL)

        return RecordConfig(
            durationMs: durationMs,
            fpsValue: fpsValue,
            includeAudio: includeAudio,
            outURL: outURL)
    }

    private func makeOutputURL(outPath: String?) -> URL {
        if let outPath, !outPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return URL(fileURLWithPath: outPath)
        }
        return FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-screen-record-\(UUID().uuidString).mp4")
    }

    @MainActor
    private func startCapture(
        state: CaptureState,
        config: RecordConfig) async throws
    {
        let handler = self.makeCaptureHandler(
            state: state,
            config: config)
        let operation = CaptureStartOperation(
            startAction: { completion in
                self.startReplayKitCaptureAction(
                    config.includeAudio,
                    handler,
                    completion)
            },
            stopAction: self.stopReplayKitCaptureAction)
        try await operation.run()
    }

    private func makeCaptureHandler(
        state: CaptureState,
        config: RecordConfig) -> @Sendable (CMSampleBuffer, RPSampleBufferType, Error?) -> Void
    {
        { sample, type, error in
            let sampleBox = UncheckedSendableBox(value: sample)
            // ReplayKit can call the capture handler on a background queue.
            // Enqueue under the state lock so closing capture forms a barrier:
            // every accepted sample precedes finalization/discard, and none follow.
            state.withLock { captureState in
                guard captureState.acceptingSamples else { return }
                self.recordQueue.async {
                    let sample = sampleBox.value
                    if let error {
                        state.withLock { state in
                            if state.handlerError == nil {
                                state.handlerError = error
                            }
                        }
                        return
                    }
                    guard CMSampleBufferDataIsReady(sample) else { return }

                    switch type {
                    case .video:
                        self.handleVideoSample(sample, state: state, config: config)
                    case .audioApp, .audioMic:
                        self.handleAudioSample(sample, state: state, includeAudio: config.includeAudio)
                    @unknown default:
                        break
                    }
                }
            }
        }
    }

    private func handleVideoSample(
        _ sample: CMSampleBuffer,
        state: CaptureState,
        config: RecordConfig)
    {
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        let shouldSkip = state.withLock { state in
            if let lastVideoTime = state.lastVideoTime {
                let delta = CMTimeSubtract(pts, lastVideoTime)
                return delta.seconds < (1.0 / config.fpsValue)
            }
            return false
        }
        if shouldSkip {
            return
        }

        if state.withLock({ $0.writer == nil }) {
            self.prepareWriter(sample: sample, state: state, config: config, pts: pts)
        }

        let vInput = state.withLock { $0.videoInput }
        let isStarted = state.withLock { $0.started }
        guard let vInput, isStarted else { return }
        if vInput.isReadyForMoreMediaData {
            if vInput.append(sample) {
                state.withLock { state in
                    state.sawVideo = true
                    state.lastVideoTime = pts
                }
            } else {
                let err = state.withLock { $0.writer?.error }
                if let err {
                    state.withLock { state in
                        if state.handlerError == nil {
                            state.handlerError = ScreenRecordError.writeFailed(err.localizedDescription)
                        }
                    }
                }
            }
        }
    }

    private func prepareWriter(
        sample: CMSampleBuffer,
        state: CaptureState,
        config: RecordConfig,
        pts: CMTime)
    {
        guard let imageBuffer = CMSampleBufferGetImageBuffer(sample) else {
            state.withLock { state in
                if state.handlerError == nil {
                    state.handlerError = ScreenRecordError.captureFailed("Missing image buffer")
                }
            }
            return
        }
        let width = CVPixelBufferGetWidth(imageBuffer)
        let height = CVPixelBufferGetHeight(imageBuffer)
        do {
            let writer = try AVAssetWriter(outputURL: config.outURL, fileType: .mp4)
            let settings: [String: Any] = [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: width,
                AVVideoHeightKey: height,
            ]
            let vInput = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
            vInput.expectsMediaDataInRealTime = true
            guard writer.canAdd(vInput) else {
                throw ScreenRecordError.writeFailed("Cannot add video input")
            }
            writer.add(vInput)

            if config.includeAudio {
                let aInput = AVAssetWriterInput(mediaType: .audio, outputSettings: nil)
                aInput.expectsMediaDataInRealTime = true
                if writer.canAdd(aInput) {
                    writer.add(aInput)
                    state.withLock { state in
                        state.audioInput = aInput
                    }
                }
            }

            guard writer.startWriting() else {
                throw ScreenRecordError.writeFailed(
                    writer.error?.localizedDescription ?? "Failed to start writer")
            }
            writer.startSession(atSourceTime: pts)
            state.withLock { state in
                state.writer = writer
                state.videoInput = vInput
                state.started = true
            }
        } catch {
            state.withLock { state in
                if state.handlerError == nil {
                    state.handlerError = error
                }
            }
        }
    }

    private func handleAudioSample(
        _ sample: CMSampleBuffer,
        state: CaptureState,
        includeAudio: Bool)
    {
        let aInput = state.withLock { $0.audioInput }
        let isStarted = state.withLock { $0.started }
        guard includeAudio, let aInput, isStarted else { return }
        if aInput.isReadyForMoreMediaData {
            _ = aInput.append(sample)
        }
    }

    @MainActor
    private func stopCapture() async throws {
        let stopError = await withCheckedContinuation { cont in
            self.stopReplayKitCaptureAction { error in
                cont.resume(returning: error)
            }
        }
        if let stopError {
            throw stopError
        }
    }

    private func finishCapture(state: CaptureState) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            // ReplayKit has stopped, so finalization can queue behind every pending sample.
            // AVAssetWriter requires all append calls to return before finishWriting starts.
            state.withLock { captureState in
                captureState.acceptingSamples = false
                self.recordQueue.async {
                    do {
                        if let handlerError = state.withLock({ $0.handlerError }) {
                            throw handlerError
                        }
                        let writer = state.withLock { $0.writer }
                        let videoInput = state.withLock { $0.videoInput }
                        let audioInput = state.withLock { $0.audioInput }
                        let sawVideo = state.withLock { $0.sawVideo }
                        guard let writer, let videoInput, sawVideo else {
                            throw ScreenRecordError.captureFailed("No frames captured")
                        }

                        videoInput.markAsFinished()
                        audioInput?.markAsFinished()
                        let writerBox = UncheckedSendableBox(value: writer)
                        writer.finishWriting {
                            let writer = writerBox.value
                            if let error = writer.error {
                                cont.resume(throwing: ScreenRecordError.writeFailed(error.localizedDescription))
                            } else if writer.status != .completed {
                                cont.resume(throwing: ScreenRecordError.writeFailed("Failed to finalize video"))
                            } else {
                                cont.resume()
                            }
                        }
                    } catch {
                        cont.resume(throwing: error)
                    }
                }
            }
        }
    }

    private func discardCapture(state: CaptureState, outputURL: URL) async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            state.withLock { captureState in
                captureState.acceptingSamples = false
                self.recordQueue.async {
                    let writer = state.withLock { state -> AVAssetWriter? in
                        let writer = state.writer
                        state.writer = nil
                        state.videoInput = nil
                        state.audioInput = nil
                        state.started = false
                        return writer
                    }
                    writer?.cancelWriting()
                    try? FileManager.default.removeItem(at: outputURL)
                    cont.resume()
                }
            }
        }
    }
}

@MainActor
private func startReplayKitCapture(
    includeAudio: Bool,
    handler: @escaping @Sendable (CMSampleBuffer, RPSampleBufferType, Error?) -> Void,
    completion: @escaping @Sendable (Error?) -> Void)
{
    let recorder = RPScreenRecorder.shared()
    recorder.isMicrophoneEnabled = includeAudio
    recorder.startCapture(handler: handler, completionHandler: completion)
}

@MainActor
private func stopReplayKitCapture(_ completion: @escaping @Sendable (Error?) -> Void) {
    RPScreenRecorder.shared().stopCapture { error in completion(error) }
}

#if DEBUG
extension ScreenRecordService {
    nonisolated static func _test_clampDurationMs(_ ms: Int?) -> Int {
        CaptureRateLimits.clampDurationMs(ms)
    }

    nonisolated static func _test_clampFps(_ fps: Double?) -> Double {
        CaptureRateLimits.clampFps(fps, maxFps: 30)
    }
}
#endif
