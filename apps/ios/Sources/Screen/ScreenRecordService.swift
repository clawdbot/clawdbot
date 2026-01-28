import AVFoundation
import ReplayKit

final class ScreenRecordService: @unchecked Sendable {
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

        func withLock<T>(_ body: (CaptureState) -> T) -> T {
            self.lock.lock()
            defer { lock.unlock() }
            return body(self)
        }
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
        let recordQueue = DispatchQueue(label: "bot.molt.screenrecord")

        try await self.startCapture(state: state, config: config, recordQueue: recordQueue)
        try await Task.sleep(nanoseconds: UInt64(config.durationMs) * 1_000_000)
        try await self.stopCapture()
        try self.finalizeCapture(state: state)
        try await self.finishWriting(state: state)

        return config.outURL.path
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

        let durationMs = Self.clampDurationMs(durationMs)
        let fps = Self.clampFps(fps)
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
            .appendingPathComponent("moltbot-screen-record-\(UUID().uuidString).mp4")
    }

    private func startCapture(
        state: CaptureState,
        config: RecordConfig,
        recordQueue: DispatchQueue) async throws
    {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            let handler = self.makeCaptureHandler(
                state: state,
                config: config,
                recordQueue: recordQueue)
            let completion: @Sendable (Error?) -> Void = { error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            }

            Task { @MainActor in
                startReplayKitCapture(
                    includeAudio: config.includeAudio,
                    handler: handler,
                    completion: completion)
            }
        }
    }

    private func makeCaptureHandler(
        state: CaptureState,
        config: RecordConfig,
        recordQueue: DispatchQueue) -> @Sendable (CMSampleBuffer, RPSampleBufferType, Error?) -> Void
    {
        { sample, type, error in
            let sampleBox = UncheckedSendableBox(value: sample)
            // ReplayKit can call the capture handler on a background queue.
            // Serialize writes to avoid queue asserts.
            recordQueue.async {
                let sample = sampleBox.value
                if let error {
                    state.withLock { state in
                        if state.handlerError == nil { state.handlerError = error }
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
        if shouldSkip { return }

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
                if state.handlerError == nil { state.handlerError = error }
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

    private func stopCapture() async throws {
        let stopError = await withCheckedContinuation { cont in
            Task { @MainActor in
                stopReplayKitCapture { error in cont.resume(returning: error) }
            }
        }
        if let stopError { throw stopError }
    }

    private func finalizeCapture(state: CaptureState) throws {
        if let handlerErrorSnapshot = state.withLock({ $0.handlerError }) {
            throw handlerErrorSnapshot
        }
        let writerSnapshot = state.withLock { $0.writer }
        let videoInputSnapshot = state.withLock { $0.videoInput }
        let audioInputSnapshot = state.withLock { $0.audioInput }
        let sawVideoSnapshot = state.withLock { $0.sawVideo }
        guard let writerSnapshot, let videoInputSnapshot, sawVideoSnapshot else {
            throw ScreenRecordError.captureFailed("No frames captured")
        }

        videoInputSnapshot.markAsFinished()
        audioInputSnapshot?.markAsFinished()
        _ = writerSnapshot
    }

    private func finishWriting(state: CaptureState) async throws {
        guard let writerSnapshot = state.withLock({ $0.writer }) else {
            throw ScreenRecordError.captureFailed("Missing writer")
        }
        let writerBox = UncheckedSendableBox(value: writerSnapshot)
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            writerBox.value.finishWriting {
                let writer = writerBox.value
                if let err = writer.error {
                    cont.resume(throwing: ScreenRecordError.writeFailed(err.localizedDescription))
                } else if writer.status != .completed {
                    cont.resume(throwing: ScreenRecordError.writeFailed("Failed to finalize video"))
                } else {
                    cont.resume()
                }
            }
        }
    }

    private nonisolated static func clampDurationMs(_ ms: Int?) -> Int {
        let v = ms ?? 10000
        return min(60000, max(250, v))
    }

    private nonisolated static func clampFps(_ fps: Double?) -> Double {
        let v = fps ?? 10
        if !v.isFinite { return 10 }
        return min(30, max(1, v))
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
        self.clampDurationMs(ms)
    }

    nonisolated static func _test_clampFps(_ fps: Double?) -> Double {
        self.clampFps(fps)
    }
}
#endif
