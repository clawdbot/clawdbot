import AVFoundation
import MoltbotIPC
import MoltbotKit
import CoreGraphics
import Foundation
import OSLog

actor CameraCaptureService {
    struct CameraDeviceInfo: Encodable, Sendable {
        let id: String
        let name: String
        let position: String
        let deviceType: String
    }

    enum CameraError: LocalizedError, Sendable {
        case cameraUnavailable
        case microphoneUnavailable
        case permissionDenied(kind: String)
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
            case let .captureFailed(msg):
                msg
            case let .exportFailed(msg):
                msg
            }
        }
    }

    private let logger = Logger(subsystem: "com.clawdbot", category: "camera")

    func listDevices() -> [CameraDeviceInfo] {
        Self.availableCameras().map { device in
            CameraDeviceInfo(
                id: device.uniqueID,
                name: device.localizedName,
                position: Self.positionLabel(device.position),
                deviceType: device.deviceType.rawValue)
        }
    }

    func snap(
        facing: CameraFacing?,
        maxWidth: Int?,
        quality: Double?,
        deviceId: String?,
        delayMs: Int) async throws -> (data: Data, size: CGSize)
    {
        let facing = facing ?? .front
        let normalized = Self.normalizeSnap(maxWidth: maxWidth, quality: quality)
        let maxWidth = normalized.maxWidth
        let quality = normalized.quality
        let delayMs = max(0, delayMs)
        let deviceId = deviceId?.trimmingCharacters(in: .whitespacesAndNewlines)

        try await self.ensureAccess(for: .video)

        let session = AVCaptureSession()
        session.sessionPreset = .photo

        guard let device = Self.pickCamera(facing: facing, deviceId: deviceId) else {
            throw CameraError.cameraUnavailable
        }

        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input) else {
            throw CameraError.captureFailed("Failed to add camera input")
        }
        session.addInput(input)

        let output = AVCapturePhotoOutput()
        guard session.canAddOutput(output) else {
            throw CameraError.captureFailed("Failed to add photo output")
        }
        session.addOutput(output)
        output.maxPhotoQualityPrioritization = .quality

        session.startRunning()
        defer { session.stopRunning() }
        await Self.warmUpCaptureSession()
        await self.waitForExposureAndWhiteBalance(device: device)
        await self.sleepDelayMs(delayMs)

        let settings: AVCapturePhotoSettings = {
            if output.availablePhotoCodecTypes.contains(.jpeg) {
                return AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
            }
            return AVCapturePhotoSettings()
        }()
        settings.photoQualityPrioritization = .quality

        var delegate: PhotoCaptureDelegate?
        let rawData: Data = try await withCheckedThrowingContinuation { cont in
            let d = PhotoCaptureDelegate(cont)
            delegate = d
            output.capturePhoto(with: settings, delegate: d)
        }
        withExtendedLifetime(delegate) {}

        let maxPayloadBytes = 5 * 1024 * 1024
        // Base64 inflates payloads by ~4/3; cap encoded bytes so the payload stays under 5MB (API limit).
        let maxEncodedBytes = (maxPayloadBytes / 4) * 3
        let res = try JPEGTranscoder.transcodeToJPEG(
            imageData: rawData,
            maxWidthPx: maxWidth,
            quality: quality,
            maxBytes: maxEncodedBytes)
        return (data: res.data, size: CGSize(width: res.widthPx, height: res.heightPx))
    }

    func clip(
        facing: CameraFacing?,
        durationMs: Int?,
        includeAudio: Bool,
        deviceId: String?,
        outPath: String?) async throws -> (path: String, durationMs: Int, hasAudio: Bool)
    {
        let facing = facing ?? .front
        let durationMs = Self.clampDurationMs(durationMs)
        let deviceId = deviceId?.trimmingCharacters(in: .whitespacesAndNewlines)

        try await self.ensureAccess(for: .video)
        if includeAudio {
            try await self.ensureAccess(for: .audio)
        }

        let session = AVCaptureSession()
        session.sessionPreset = .high

        guard let camera = Self.pickCamera(facing: facing, deviceId: deviceId) else {
            throw CameraError.cameraUnavailable
        }
        let cameraInput = try AVCaptureDeviceInput(device: camera)
        guard session.canAddInput(cameraInput) else {
            throw CameraError.captureFailed("Failed to add camera input")
        }
        session.addInput(cameraInput)

        if includeAudio {
            guard let mic = AVCaptureDevice.default(for: .audio) else {
                throw CameraError.microphoneUnavailable
            }
            let micInput = try AVCaptureDeviceInput(device: mic)
            guard session.canAddInput(micInput) else {
                throw CameraError.captureFailed("Failed to add microphone input")
            }
            session.addInput(micInput)
        }

        let output = AVCaptureMovieFileOutput()
        guard session.canAddOutput(output) else {
            throw CameraError.captureFailed("Failed to add movie output")
        }
        session.addOutput(output)
        output.maxRecordedDuration = CMTime(value: Int64(durationMs), timescale: 1000)

        session.startRunning()
        defer { session.stopRunning() }
        await Self.warmUpCaptureSession()

        let tmpMovURL = FileManager().temporaryDirectory
            .appendingPathComponent("moltbot-camera-\(UUID().uuidString).mov")
        defer { try? FileManager().removeItem(at: tmpMovURL) }

        let outputURL: URL = {
            if let outPath, !outPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return URL(fileURLWithPath: outPath)
            }
            return FileManager().temporaryDirectory
                .appendingPathComponent("moltbot-camera-\(UUID().uuidString).mp4")
        }()

        // Ensure we don't fail exporting due to an existing file.
        try? FileManager().removeItem(at: outputURL)

        let logger = self.logger
        var delegate: MovieFileDelegate?
        let recordedURL: URL = try await withCheckedThrowingContinuation { cont in
            let d = MovieFileDelegate(cont, logger: logger)
            delegate = d
            output.startRecording(to: tmpMovURL, recordingDelegate: d)
        }
        withExtendedLifetime(delegate) {}

        try await Self.exportToMP4(inputURL: recordedURL, outputURL: outputURL)
        return (path: outputURL.path, durationMs: durationMs, hasAudio: includeAudio)
    }

    private func ensureAccess(for mediaType: AVMediaType) async throws {
        let status = AVCaptureDevice.authorizationStatus(for: mediaType)
        switch status {
        case .authorized:
            return
        case .notDetermined:
            let ok = await withCheckedContinuation(isolation: nil) { cont in
                AVCaptureDevice.requestAccess(for: mediaType) { granted in
                    cont.resume(returning: granted)
                }
            }
            if !ok {
                throw CameraError.permissionDenied(kind: mediaType == .video ? "Camera" : "Microphone")
            }
        case .denied, .restricted:
            throw CameraError.permissionDenied(kind: mediaType == .video ? "Camera" : "Microphone")
        @unknown default:
            throw CameraError.permissionDenied(kind: mediaType == .video ? "Camera" : "Microphone")
        }
    }

    private nonisolated static func availableCameras() -> [AVCaptureDevice] {
        var types: [AVCaptureDevice.DeviceType] = [
            .builtInWideAngleCamera,
            .continuityCamera,
        ]
        if let external = externalDeviceType() {
            types.append(external)
        }
        let session = AVCaptureDevice.DiscoverySession(
            deviceTypes: types,
            mediaType: .video,
            position: .unspecified)
        return session.devices
    }

    private nonisolated static func externalDeviceType() -> AVCaptureDevice.DeviceType? {
        if #available(macOS 14.0, *) {
            return .external
        }
        // Use raw value to avoid deprecated symbol in the SDK.
        return AVCaptureDevice.DeviceType(rawValue: "AVCaptureDeviceTypeExternalUnknown")
    }

    private nonisolated static func pickCamera(
        facing: CameraFacing,
        deviceId: String?) -> AVCaptureDevice?
    {
        if let deviceId, !deviceId.isEmpty {
            if let match = availableCameras().first(where: { $0.uniqueID == deviceId }) {
                return match
            }
        }
        let position: AVCaptureDevice.Position = (facing == .front) ? .front : .back

        if let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position) {
            return device
        }

        // Many macOS cameras report `unspecified` position; fall back to any default.
        return AVCaptureDevice.default(for: .video)
    }

    private nonisolated static func clampQuality(_ quality: Double?) -> Double {
        let q = quality ?? 0.9
        return min(1.0, max(0.05, q))
    }

    nonisolated static func normalizeSnap(maxWidth: Int?, quality: Double?) -> (maxWidth: Int, quality: Double) {
        // Default to a reasonable max width to keep downstream payload sizes manageable.
        // If you need full-res, explicitly request a larger maxWidth.
        let maxWidth = maxWidth.flatMap { $0 > 0 ? $0 : nil } ?? 1600
        let quality = Self.clampQuality(quality)
        return (maxWidth: maxWidth, quality: quality)
    }

    private nonisolated static func clampDurationMs(_ ms: Int?) -> Int {
        let v = ms ?? 3000
        return min(60000, max(250, v))
    }

    private nonisolated static func exportToMP4(inputURL: URL, outputURL: URL) async throws {
        let asset = AVURLAsset(url: inputURL)
        guard let export = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetMediumQuality) else {
            throw CameraError.exportFailed("Failed to create export session")
        }
        export.shouldOptimizeForNetworkUse = true

        if #available(macOS 15.0, *) {
            do {
                try await export.export(to: outputURL, as: .mp4)
                return
            } catch {
                throw CameraError.exportFailed(error.localizedDescription)
            }
        } else {
            export.outputURL = outputURL
            export.outputFileType = .mp4

            try await withCheckedThrowingContinuation(isolation: nil) { (cont: CheckedContinuation<Void, Error>) in
                export.exportAsynchronously {
                    cont.resume(returning: ())
                }
            }

            switch export.status {
            case .completed:
                return
            case .failed:
                throw CameraError.exportFailed(export.error?.localizedDescription ?? "export failed")
            case .cancelled:
                throw CameraError.exportFailed("export cancelled")
            default:
                throw CameraError.exportFailed("export did not complete (\(export.status.rawValue))")
            }
        }
    }

    private nonisolated static func warmUpCaptureSession() async {
        // A short delay after `startRunning()` significantly reduces "blank first frame" captures on some devices.
        try? await Task.sleep(nanoseconds: 150_000_000) // 150ms
    }

    private func waitForExposureAndWhiteBalance(device: AVCaptureDevice) async {
        let stepNs: UInt64 = 50_000_000
        let maxSteps = 30 // ~1.5s
        for _ in 0..<maxSteps {
            if !(device.isAdjustingExposure || device.isAdjustingWhiteBalance) {
                return
            }
            try? await Task.sleep(nanoseconds: stepNs)
        }
    }

    private func sleepDelayMs(_ delayMs: Int) async {
        guard delayMs > 0 else { return }
        let ns = UInt64(min(delayMs, 10000)) * 1_000_000
        try? await Task.sleep(nanoseconds: ns)
    }

    private nonisolated static func positionLabel(_ position: AVCaptureDevice.Position) -> String {
        switch position {
        case .front: "front"
        case .back: "back"
        default: "unspecified"
        }
    }
}

private final class PhotoCaptureDelegate: NSObject, AVCapturePhotoCaptureDelegate {
    private var cont: CheckedContinuation<Data, Error>?
    private var didResume = false

    init(_ cont: CheckedContinuation<Data, Error>) {
        self.cont = cont
    }

    func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishProcessingPhoto photo: AVCapturePhoto,
        error: Error?)
    {
        guard !self.didResume, let cont else { return }
        self.didResume = true
        self.cont = nil
        if let error {
            cont.resume(throwing: error)
            return
        }
        guard let data = photo.fileDataRepresentation() else {
            cont.resume(throwing: CameraCaptureService.CameraError.captureFailed("No photo data"))
            return
        }
        if data.isEmpty {
            cont.resume(throwing: CameraCaptureService.CameraError.captureFailed("Photo data empty"))
            return
        }
        cont.resume(returning: data)
    }

    func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishCaptureFor resolvedSettings: AVCaptureResolvedPhotoSettings,
        error: Error?)
    {
        guard let error else { return }
        guard !self.didResume, let cont else { return }
        self.didResume = true
        self.cont = nil
        cont.resume(throwing: error)
    }
}

private final class MovieFileDelegate: NSObject, AVCaptureFileOutputRecordingDelegate {
    private var cont: CheckedContinuation<URL, Error>?
    private let logger: Logger

    init(_ cont: CheckedContinuation<URL, Error>, logger: Logger) {
        self.cont = cont
        self.logger = logger
    }

    func fileOutput(
        _ output: AVCaptureFileOutput,
        didFinishRecordingTo outputFileURL: URL,
        from connections: [AVCaptureConnection],
        error: Error?)
    {
        guard let cont else { return }
        self.cont = nil

        if let error {
            let ns = error as NSError
            if ns.domain == AVFoundationErrorDomain,
               ns.code == AVError.maximumDurationReached.rawValue
            {
                cont.resume(returning: outputFileURL)
                return
            }

            self.logger.error("camera record failed: \(error.localizedDescription, privacy: .public)")
            cont.resume(throwing: error)
            return
        }

        cont.resume(returning: outputFileURL)
    }
}
