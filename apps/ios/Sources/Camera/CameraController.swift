import AVFoundation
import Foundation
import OpenClawKit
import os

actor CameraController {
    struct CameraDeviceInfo: Codable {
        var id: String
        var name: String
        var position: String
        var deviceType: String
    }

    enum CameraError: LocalizedError {
        case cameraUnavailable
        case microphoneUnavailable
        case permissionDenied(kind: String)
        case invalidParams(String)
        case captureFailed(String)
        case exportFailed(String)

        var errorDescription: String? {
            switch self {
            case .cameraUnavailable:
                "Camera unavailable"
            case .microphoneUnavailable:
                "Microphone unavailable"
            case let .permissionDenied(kind):
                "\(kind) permission denied"
            case let .invalidParams(msg):
                msg
            case let .captureFailed(msg):
                msg
            case let .exportFailed(msg):
                msg
            }
        }
    }

    func snap(
        params: OpenClawCameraSnapParams,
        defaultFacing: OpenClawCameraFacing = .front) async throws -> (
        format: String,
        base64: String,
        width: Int,
        height: Int)
    {
        let facing = Self.resolveFacing(params.facing, defaultFacing: defaultFacing)
        let format = params.format ?? .jpg
        // Default to a reasonable max width to keep gateway payload sizes manageable.
        // If you need the full-res photo, explicitly request a larger maxWidth.
        let maxWidth = params.maxWidth.flatMap { $0 > 0 ? $0 : nil } ?? 1600
        let quality = Self.clampQuality(params.quality)
        let delayMs = max(0, params.delayMs ?? 0)

        try Task.checkCancellation()
        try await self.ensureAccess(for: .video)
        try Task.checkCancellation()

        let prepared = try CameraCapturePipelineSupport.preparePhotoSession(
            preferFrontCamera: facing == .front,
            deviceId: params.deviceId,
            pickCamera: { preferFrontCamera, deviceId in
                Self.pickCamera(facing: preferFrontCamera ? .front : .back, deviceId: deviceId)
            },
            cameraUnavailableError: CameraError.cameraUnavailable,
            mapSetupError: { setupError in
                CameraError.captureFailed(setupError.localizedDescription)
            })
        let session = prepared.session
        let output = prepared.output

        let rawData: Data
        do {
            let sessionStopper = CameraCaptureSessionStopper {
                session.stopRunning()
            }
            try Task.checkCancellation()
            session.startRunning()
            defer { sessionStopper.stop() }
            try Task.checkCancellation()
            try await CameraCapturePipelineSupport.warmUpCaptureSession()
            try await Self.sleepDelayMs(delayMs)

            let capture = CameraPhotoCaptureOperation(
                output: output,
                cancelAction: { sessionStopper.stop() })
            rawData = try await capture.run()
        }

        try Task.checkCancellation()
        let res = try PhotoCapture.transcodeJPEGForGateway(
            rawData: rawData,
            maxWidthPx: maxWidth,
            quality: quality)
        try Task.checkCancellation()
        let base64 = res.data.base64EncodedString()
        try Task.checkCancellation()

        return (
            format: format.rawValue,
            base64: base64,
            width: res.widthPx,
            height: res.heightPx)
    }

    func clip(
        params: OpenClawCameraClipParams,
        defaultFacing: OpenClawCameraFacing = .front) async throws -> (
        format: String,
        base64: String,
        durationMs: Int,
        hasAudio: Bool)
    {
        let facing = Self.resolveFacing(params.facing, defaultFacing: defaultFacing)
        let durationMs = Self.clampDurationMs(params.durationMs)
        let includeAudio = params.includeAudio ?? true
        let format = params.format ?? .mp4

        try Task.checkCancellation()
        try await self.ensureAccess(for: .video)
        try Task.checkCancellation()
        if includeAudio {
            try await self.ensureAccess(for: .audio)
            try Task.checkCancellation()
        }

        let movURL = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-camera-\(UUID().uuidString).mov")
        let mp4URL = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-camera-\(UUID().uuidString).mp4")
        defer {
            try? FileManager().removeItem(at: movURL)
            try? FileManager().removeItem(at: mp4URL)
        }

        let recordedURL = try await CameraCapturePipelineSupport.withWarmMovieSession(
            options: CameraMovieSessionOptions(
                preferFrontCamera: facing == .front,
                deviceId: params.deviceId,
                includeAudio: includeAudio,
                durationMs: durationMs),
            pickCamera: { preferFrontCamera, deviceId in
                Self.pickCamera(facing: preferFrontCamera ? .front : .back, deviceId: deviceId)
            },
            cameraUnavailableError: CameraError.cameraUnavailable,
            mapSetupError: Self.mapMovieSetupError,
            operation: { output in
                let recording = CameraMovieRecordingOperation(output: output, outputURL: movURL)
                return try await recording.run()
            })
        try Task.checkCancellation()
        // The capture session is stopped before post-processing so a timeout cannot
        // keep the camera active while export or payload encoding finishes.
        try await Self.exportToMP4(inputURL: recordedURL, outputURL: mp4URL)
        try Task.checkCancellation()
        let data = try Data(contentsOf: mp4URL)
        try Task.checkCancellation()
        let base64 = data.base64EncodedString()
        try Task.checkCancellation()
        return (
            format: format.rawValue,
            base64: base64,
            durationMs: durationMs,
            hasAudio: includeAudio)
    }

    func listDevices() -> [CameraDeviceInfo] {
        Self.discoverVideoDevices().map { device in
            CameraDeviceInfo(
                id: device.uniqueID,
                name: device.localizedName,
                position: Self.positionLabel(device.position),
                deviceType: device.deviceType.rawValue)
        }
    }

    private func ensureAccess(for mediaType: AVMediaType) async throws {
        let authorized: Bool = switch AVCaptureDevice.authorizationStatus(for: mediaType) {
        case .authorized:
            true
        case .notDetermined:
            await PermissionRequestBridge.awaitRequest { completion in
                AVCaptureDevice.requestAccess(for: mediaType, completionHandler: completion)
            }
        case .denied, .restricted:
            false
        @unknown default:
            false
        }
        try Task.checkCancellation()
        if !authorized {
            throw CameraError.permissionDenied(kind: mediaType == .video ? "Camera" : "Microphone")
        }
    }

    private nonisolated static func pickCamera(
        facing: OpenClawCameraFacing,
        deviceId: String?) -> AVCaptureDevice?
    {
        if let deviceId, !deviceId.isEmpty {
            if let match = discoverVideoDevices().first(where: { $0.uniqueID == deviceId }) {
                return match
            }
        }
        let position: AVCaptureDevice.Position = (facing == .front) ? .front : .back
        if let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position) {
            return device
        }
        // Fall back to any default camera (e.g. simulator / unusual device configurations).
        return AVCaptureDevice.default(for: .video)
    }

    private nonisolated static func mapMovieSetupError(_ setupError: CameraSessionConfigurationError) -> CameraError {
        CameraCapturePipelineSupport.mapMovieSetupError(
            setupError,
            microphoneUnavailableError: .microphoneUnavailable,
            captureFailed: { .captureFailed($0) })
    }

    private nonisolated static func positionLabel(_ position: AVCaptureDevice.Position) -> String {
        CameraCapturePipelineSupport.positionLabel(position)
    }

    private nonisolated static func discoverVideoDevices() -> [AVCaptureDevice] {
        let types: [AVCaptureDevice.DeviceType] = [
            .builtInWideAngleCamera,
            .builtInUltraWideCamera,
            .builtInTelephotoCamera,
            .builtInDualCamera,
            .builtInDualWideCamera,
            .builtInTripleCamera,
            .builtInTrueDepthCamera,
            .builtInLiDARDepthCamera,
        ]
        let session = AVCaptureDevice.DiscoverySession(
            deviceTypes: types,
            mediaType: .video,
            position: .unspecified)
        return session.devices
    }

    nonisolated static func clampQuality(_ quality: Double?) -> Double {
        let q = quality ?? 0.9
        return min(1.0, max(0.05, q))
    }

    nonisolated static func clampDurationMs(_ ms: Int?) -> Int {
        let v = ms ?? 3000
        // Keep clips short by default; avoid huge base64 payloads on the gateway.
        return min(60000, max(250, v))
    }

    nonisolated static func resolveFacing(
        _ explicitFacing: OpenClawCameraFacing?,
        defaultFacing: OpenClawCameraFacing) -> OpenClawCameraFacing
    {
        explicitFacing ?? defaultFacing
    }

    private nonisolated static func exportToMP4(inputURL: URL, outputURL: URL) async throws {
        try Task.checkCancellation()
        let asset = AVURLAsset(url: inputURL)
        guard let exporter = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetMediumQuality) else {
            throw CameraError.exportFailed("Failed to create export session")
        }
        exporter.shouldOptimizeForNetworkUse = true

        // The iOS app and shared package both target iOS 18, whose native async
        // export propagates parent-task cancellation to AVFoundation.
        do {
            try await exporter.export(to: outputURL, as: .mp4)
        } catch {
            try Task.checkCancellation()
            throw CameraError.exportFailed(error.localizedDescription)
        }
    }

    private nonisolated static func sleepDelayMs(_ delayMs: Int) async throws {
        guard delayMs > 0 else { return }
        let maxDelayMs = 10 * 1000
        let ns = UInt64(min(delayMs, maxDelayMs)) * UInt64(NSEC_PER_MSEC)
        try await Task.sleep(nanoseconds: ns)
    }
}

final class CameraCaptureSessionStopper: @unchecked Sendable {
    private enum State: Equatable {
        case running
        case stopping
        case stopped
    }

    private let condition = NSCondition()
    private var state = State.running
    private let stopAction: () -> Void

    init(stopAction: @escaping () -> Void) {
        self.stopAction = stopAction
    }

    func stop() {
        self.condition.lock()
        switch self.state {
        case .stopped:
            self.condition.unlock()
            return
        case .stopping:
            while self.state == .stopping {
                self.condition.wait()
            }
            self.condition.unlock()
            return
        case .running:
            self.state = .stopping
            self.condition.unlock()
        }

        self.stopAction()

        self.condition.lock()
        self.state = .stopped
        self.condition.broadcast()
        self.condition.unlock()
    }
}

final class CameraPhotoCaptureOperation: NSObject, AVCapturePhotoCaptureDelegate, @unchecked Sendable {
    typealias StartAction = (any AVCapturePhotoCaptureDelegate) -> Void
    typealias CancelAction = () -> Void

    private enum Phase: Equatable {
        case idle
        case starting
        case capturing
        case cancelling
        case cancelled
        case finished
    }

    private struct State {
        var phase = Phase.idle
        var continuation: CheckedContinuation<Data, Error>?
        var processedResult: Result<Data, Error>?
    }

    private let state = OSAllocatedUnfairLock(initialState: State())
    private let startAction: StartAction
    private let cancelAction: CancelAction

    convenience init(output: AVCapturePhotoOutput, cancelAction: @escaping CancelAction) {
        let settings = CameraCapturePipelineSupport.makePhotoSettings(output: output)
        self.init(
            startAction: { delegate in
                output.capturePhoto(with: settings, delegate: delegate)
            },
            cancelAction: cancelAction)
    }

    init(startAction: @escaping StartAction, cancelAction: @escaping CancelAction = {}) {
        self.startAction = startAction
        self.cancelAction = cancelAction
    }

    func run() async throws -> Data {
        try Task.checkCancellation()
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                self.begin(continuation)
            }
        }, onCancel: {
            self.cancel()
        })
    }

    func cancel() {
        let shouldCancel = self.state.withLock { state -> Bool in
            switch state.phase {
            case .idle:
                state.phase = .cancelled
                return false
            case .starting:
                state.phase = .cancelling
                return false
            case .capturing:
                state.phase = .cancelling
                return true
            case .cancelling, .cancelled, .finished:
                return false
            }
        }
        if shouldCancel {
            self.cancelAction()
        }
    }

    func processingDidFinish(_ result: Result<Data, Error>) {
        self.state.withLock { state in
            guard state.phase == .starting || state.phase == .capturing || state.phase == .cancelling else {
                return
            }
            state.processedResult = result
        }
    }

    func captureDidFinish(error: Error?) {
        let completion = self.state.withLock { state -> (CheckedContinuation<Data, Error>, Result<Data, Error>)? in
            guard let continuation = state.continuation else { return nil }

            let result: Result<Data, Error>
            switch state.phase {
            case .cancelling:
                result = .failure(CancellationError())
            case .starting, .capturing:
                if let error {
                    result = .failure(error)
                } else {
                    result = state.processedResult ?? .failure(Self.missingDataError)
                }
            case .idle, .cancelled, .finished:
                return nil
            }

            state.phase = .finished
            state.continuation = nil
            state.processedResult = nil
            return (continuation, result)
        }
        if let (continuation, result) = completion {
            continuation.resume(with: result)
        }
    }

    func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishProcessingPhoto photo: AVCapturePhoto,
        error: Error?)
    {
        if let error {
            self.processingDidFinish(.failure(error))
            return
        }
        guard let data = photo.fileDataRepresentation() else {
            self.processingDidFinish(.failure(Self.missingDataError))
            return
        }
        guard !data.isEmpty else {
            self.processingDidFinish(.failure(NSError(domain: "Camera", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "photo data empty",
            ])))
            return
        }
        self.processingDidFinish(.success(data))
    }

    func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishCaptureFor resolvedSettings: AVCaptureResolvedPhotoSettings,
        error: Error?)
    {
        self.captureDidFinish(error: error)
    }

    private func begin(_ continuation: CheckedContinuation<Data, Error>) {
        let shouldStart = self.state.withLock { state -> Bool in
            switch state.phase {
            case .idle:
                state.phase = .starting
                state.continuation = continuation
                return true
            case .cancelled:
                state.phase = .finished
                return false
            case .starting, .capturing, .cancelling, .finished:
                preconditionFailure("camera photo capture operation can only run once")
            }
        }
        guard shouldStart else {
            continuation.resume(throwing: CancellationError())
            return
        }

        self.startAction(self)
        let shouldCancel = self.state.withLock { state -> Bool in
            switch state.phase {
            case .starting:
                state.phase = .capturing
                return false
            case .cancelling:
                return true
            case .idle, .capturing, .cancelled, .finished:
                return false
            }
        }
        if shouldCancel {
            self.cancelAction()
        }
    }

    private static let missingDataError = NSError(domain: "Camera", code: 1, userInfo: [
        NSLocalizedDescriptionKey: "photo data missing",
    ])
}

final class CameraMovieRecordingOperation: NSObject, AVCaptureFileOutputRecordingDelegate, @unchecked Sendable {
    typealias StartAction = (any AVCaptureFileOutputRecordingDelegate) -> Void
    typealias StopAction = () -> Void

    private enum Phase {
        case idle
        case starting
        case startRequested
        case recording
        case cancelling
        case cancelled
        case finished
    }

    private struct State {
        var phase = Phase.idle
        var continuation: CheckedContinuation<URL, Error>?
        var stopRequested = false
    }

    private let state = OSAllocatedUnfairLock(initialState: State())
    private let startAction: StartAction
    private let stopAction: StopAction

    convenience init(output: AVCaptureMovieFileOutput, outputURL: URL) {
        self.init(
            startAction: { delegate in
                output.startRecording(to: outputURL, recordingDelegate: delegate)
            },
            stopAction: { output.stopRecording() })
    }

    init(
        startAction: @escaping StartAction,
        stopAction: @escaping StopAction)
    {
        self.startAction = startAction
        self.stopAction = stopAction
    }

    func run() async throws -> URL {
        try Task.checkCancellation()
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                self.begin(continuation)
            }
        }, onCancel: {
            self.cancel()
        })
    }

    func cancel() {
        let shouldStop = self.state.withLock { state -> Bool in
            switch state.phase {
            case .idle:
                state.phase = .cancelled
                return false
            case .starting:
                state.phase = .cancelling
                return false
            case .startRequested, .recording:
                state.phase = .cancelling
                guard !state.stopRequested else { return false }
                state.stopRequested = true
                return true
            case .cancelling, .cancelled, .finished:
                return false
            }
        }
        if shouldStop {
            self.stopAction()
        }
    }

    func recordingDidStart() {
        self.state.withLock { state in
            switch state.phase {
            case .starting, .startRequested:
                state.phase = .recording
            case .cancelling:
                break
            case .idle, .recording, .cancelled, .finished:
                break
            }
        }
    }

    func recordingDidFinish(outputURL: URL, error: Error?) {
        let completion = self.state.withLock { state -> (CheckedContinuation<URL, Error>, Result<URL, Error>)? in
            guard let continuation = state.continuation else { return nil }

            let result: Result<URL, Error>
            switch state.phase {
            case .cancelling:
                result = .failure(CancellationError())
            case .starting, .startRequested, .recording:
                result = Self.recordingResult(outputURL: outputURL, error: error)
            case .idle, .cancelled, .finished:
                return nil
            }

            state.phase = .finished
            state.continuation = nil
            return (continuation, result)
        }
        if let (continuation, result) = completion {
            continuation.resume(with: result)
        }
    }

    func fileOutput(
        _ output: AVCaptureFileOutput,
        didStartRecordingTo fileURL: URL,
        from connections: [AVCaptureConnection])
    {
        self.recordingDidStart()
    }

    func fileOutput(
        _ output: AVCaptureFileOutput,
        didFinishRecordingTo outputFileURL: URL,
        from connections: [AVCaptureConnection],
        error: Error?)
    {
        self.recordingDidFinish(outputURL: outputFileURL, error: error)
    }

    private func begin(_ continuation: CheckedContinuation<URL, Error>) {
        let shouldStart = self.state.withLock { state -> Bool in
            switch state.phase {
            case .idle:
                state.phase = .starting
                state.continuation = continuation
                return true
            case .cancelled:
                state.phase = .finished
                return false
            case .starting, .startRequested, .recording, .cancelling, .finished:
                preconditionFailure("camera movie recording operation can only run once")
            }
        }
        guard shouldStart else {
            continuation.resume(throwing: CancellationError())
            return
        }

        self.startAction(self)
        let shouldStop = self.state.withLock { state -> Bool in
            switch state.phase {
            case .starting:
                state.phase = .startRequested
                return false
            case .cancelling:
                guard !state.stopRequested else { return false }
                state.stopRequested = true
                return true
            case .idle, .startRequested, .recording, .cancelled, .finished:
                return false
            }
        }
        if shouldStop {
            self.stopAction()
        }
    }

    private static func recordingResult(outputURL: URL, error: Error?) -> Result<URL, Error> {
        guard let error else { return .success(outputURL) }
        let ns = error as NSError
        if ns.domain == AVFoundationErrorDomain,
           ns.code == AVError.maximumDurationReached.rawValue
        {
            return .success(outputURL)
        }
        return .failure(error)
    }
}
