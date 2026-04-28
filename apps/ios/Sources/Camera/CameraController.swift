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

    func snap(params: OpenClawCameraSnapParams) async throws -> (
        format: String,
        base64: String,
        width: Int,
        height: Int)
    {
        let facing = params.facing ?? .front
        let format = params.format ?? .jpg
        // Default to a reasonable max width to keep gateway payload sizes manageable.
        // If you need the full-res photo, explicitly request a larger maxWidth.
        let maxWidth = params.maxWidth.flatMap { $0 > 0 ? $0 : nil } ?? 1600
        let quality = Self.clampQuality(params.quality)
        let delayMs = max(0, params.delayMs ?? 0)

        try await self.ensureAccess(for: .video)

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

        session.startRunning()
        defer { session.stopRunning() }
        await CameraCapturePipelineSupport.warmUpCaptureSession()
        await Self.sleepDelayMs(delayMs)

        let rawData = try await CameraCapturePipelineSupport.capturePhotoData(output: output) { continuation in
            PhotoCaptureDelegate(continuation)
        }

        let res = try PhotoCapture.transcodeJPEGForGateway(
            rawData: rawData,
            maxWidthPx: maxWidth,
            quality: quality)

        return (
            format: format.rawValue,
            base64: res.data.base64EncodedString(),
            width: res.widthPx,
            height: res.heightPx)
    }

    func clip(params: OpenClawCameraClipParams) async throws -> (
        format: String,
        base64: String,
        durationMs: Int,
        hasAudio: Bool)
    {
        let facing = params.facing ?? .front
        let durationMs = Self.clampDurationMs(params.durationMs)
        let includeAudio = params.includeAudio ?? true
        let format = params.format ?? .mp4

        try await self.ensureAccess(for: .video)
        if includeAudio {
            try await self.ensureAccess(for: .audio)
        }

        let movURL = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-camera-\(UUID().uuidString).mov")
        let mp4URL = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-camera-\(UUID().uuidString).mp4")
        defer {
            try? FileManager().removeItem(at: movURL)
            try? FileManager().removeItem(at: mp4URL)
        }

        let data = try await CameraCapturePipelineSupport.withWarmMovieSession(
            preferFrontCamera: facing == .front,
            deviceId: params.deviceId,
            includeAudio: includeAudio,
            durationMs: durationMs,
            pickCamera: { preferFrontCamera, deviceId in
                Self.pickCamera(facing: preferFrontCamera ? .front : .back, deviceId: deviceId)
            },
            cameraUnavailableError: CameraError.cameraUnavailable,
            mapSetupError: Self.mapMovieSetupError,
            operation: { output in
                var delegate: MovieFileDelegate?
                let recordedURL: URL = try await withCheckedThrowingContinuation { cont in
                    let d = MovieFileDelegate(cont)
                    delegate = d
                    output.startRecording(to: movURL, recordingDelegate: d)
                }
                withExtendedLifetime(delegate) {}
                // Transcode .mov -> .mp4 for easier downstream handling.
                try await Self.exportToMP4(inputURL: recordedURL, outputURL: mp4URL)
                return try Data(contentsOf: mp4URL)
            })
        return (
            format: format.rawValue,
            base64: data.base64EncodedString(),
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
        if await !(CameraAuthorization.isAuthorized(for: mediaType)) {
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

    private nonisolated static func exportToMP4(inputURL: URL, outputURL: URL) async throws {
        let asset = AVURLAsset(url: inputURL)
        guard let exporter = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetMediumQuality) else {
            throw CameraError.exportFailed("Failed to create export session")
        }
        exporter.shouldOptimizeForNetworkUse = true

        if #available(iOS 18.0, tvOS 18.0, visionOS 2.0, *) {
            do {
                try await exporter.export(to: outputURL, as: .mp4)
                return
            } catch {
                throw CameraError.exportFailed(error.localizedDescription)
            }
        } else {
            exporter.outputURL = outputURL
            exporter.outputFileType = .mp4

            try await withCheckedThrowingContinuation(isolation: nil) { (cont: CheckedContinuation<Void, Error>) in
                exporter.exportAsynchronously {
                    cont.resume(returning: ())
                }
            }

            switch exporter.status {
            case .completed:
                return
            case .failed:
                throw CameraError.exportFailed(exporter.error?.localizedDescription ?? "export failed")
            case .cancelled:
                throw CameraError.exportFailed("export cancelled")
            default:
                throw CameraError.exportFailed("export did not complete")
            }
        }
    }

    private nonisolated static func sleepDelayMs(_ delayMs: Int) async {
        guard delayMs > 0 else { return }
        let maxDelayMs = 10 * 1000
        let ns = UInt64(min(delayMs, maxDelayMs)) * UInt64(NSEC_PER_MSEC)
        try? await Task.sleep(nanoseconds: ns)
    }
}

private final class PhotoCaptureDelegate: NSObject, AVCapturePhotoCaptureDelegate {
    private let continuation: CheckedContinuation<Data, Error>
    private let resumed = OSAllocatedUnfairLock(initialState: false)

    init(_ continuation: CheckedContinuation<Data, Error>) {
        self.continuation = continuation
    }

    func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishProcessingPhoto photo: AVCapturePhoto,
        error: Error?)
    {
        let alreadyResumed = self.resumed.withLock { old in
            let was = old
            old = true
            return was
        }
        guard !alreadyResumed else { return }

        if let error {
            self.continuation.resume(throwing: error)
            return
        }
        guard let data = photo.fileDataRepresentation() else {
            self.continuation.resume(
                throwing: NSError(domain: "Camera", code: 1, userInfo: [
                    NSLocalizedDescriptionKey: "photo data missing",
                ]))
            return
        }
        if data.isEmpty {
            self.continuation.resume(
                throwing: NSError(domain: "Camera", code: 2, userInfo: [
                    NSLocalizedDescriptionKey: "photo data empty",
                ]))
            return
        }
        self.continuation.resume(returning: data)
    }

    func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishCaptureFor resolvedSettings: AVCaptureResolvedPhotoSettings,
        error: Error?)
    {
        guard let error else { return }
        let alreadyResumed = self.resumed.withLock { old in
            let was = old
            old = true
            return was
        }
        guard !alreadyResumed else { return }
        self.continuation.resume(throwing: error)
    }
}

private final class MovieFileDelegate: NSObject, AVCaptureFileOutputRecordingDelegate {
    private let continuation: CheckedContinuation<URL, Error>
    private let resumed = OSAllocatedUnfairLock(initialState: false)

    init(_ continuation: CheckedContinuation<URL, Error>) {
        self.continuation = continuation
    }

    func fileOutput(
        _ output: AVCaptureFileOutput,
        didFinishRecordingTo outputFileURL: URL,
        from connections: [AVCaptureConnection],
        error: Error?)
    {
        let alreadyResumed = self.resumed.withLock { old in
            let was = old
            old = true
            return was
        }
        guard !alreadyResumed else { return }

        if let error {
            let ns = error as NSError
            if ns.domain == AVFoundationErrorDomain,
               ns.code == AVError.maximumDurationReached.rawValue
            {
                self.continuation.resume(returning: outputFileURL)
                return
            }
            self.continuation.resume(throwing: error)
            return
        }
        self.continuation.resume(returning: outputFileURL)
    }
}
