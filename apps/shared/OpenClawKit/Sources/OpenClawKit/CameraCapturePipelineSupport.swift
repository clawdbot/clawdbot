import AVFoundation
import Foundation

#if !os(watchOS)
public struct CameraMovieSessionOptions: Sendable {
    public let preferFrontCamera: Bool
    public let deviceId: String?
    public let includeAudio: Bool
    public let durationMs: Int

    public init(
        preferFrontCamera: Bool,
        deviceId: String?,
        includeAudio: Bool,
        durationMs: Int)
    {
        self.preferFrontCamera = preferFrontCamera
        self.deviceId = deviceId
        self.includeAudio = includeAudio
        self.durationMs = durationMs
    }
}

public enum CameraCapturePipelineSupport {
    public static func selectCamera<Device>(
        deviceId: String?,
        matching: (String) -> Device?,
        fallback: () -> Device?,
        unavailableError: @autoclosure () -> Error,
        deviceNotFoundError: (String) -> Error) throws -> Device
    {
        if let deviceId, !deviceId.isEmpty {
            guard let device = matching(deviceId) else {
                throw deviceNotFoundError(deviceId)
            }
            return device
        }
        guard let device = fallback() else {
            throw unavailableError()
        }
        return device
    }

    public static func preparePhotoSession(
        preferFrontCamera: Bool,
        deviceId: String?,
        pickCamera: (_ preferFrontCamera: Bool, _ deviceId: String?) throws -> AVCaptureDevice,
        mapSetupError: (CameraSessionConfigurationError) -> Error) throws
        -> (session: AVCaptureSession, device: AVCaptureDevice, output: AVCapturePhotoOutput)
    {
        let session = AVCaptureSession()
        session.sessionPreset = .photo

        let device = try pickCamera(preferFrontCamera, deviceId)

        do {
            try CameraSessionConfiguration.addCameraInput(session: session, camera: device)
            let output = try CameraSessionConfiguration.addPhotoOutput(session: session)
            return (session, device, output)
        } catch let setupError as CameraSessionConfigurationError {
            throw mapSetupError(setupError)
        }
    }

    public static func prepareMovieSession(
        options: CameraMovieSessionOptions,
        pickCamera: (_ preferFrontCamera: Bool, _ deviceId: String?) throws -> AVCaptureDevice,
        mapSetupError: (CameraSessionConfigurationError) -> Error) throws
        -> (session: AVCaptureSession, output: AVCaptureMovieFileOutput)
    {
        let session = AVCaptureSession()
        session.sessionPreset = .high

        let camera = try pickCamera(options.preferFrontCamera, options.deviceId)

        do {
            try CameraSessionConfiguration.addCameraInput(session: session, camera: camera)
            let output = try CameraSessionConfiguration.addMovieOutput(
                session: session,
                includeAudio: options.includeAudio,
                durationMs: options.durationMs)
            return (session, output)
        } catch let setupError as CameraSessionConfigurationError {
            throw mapSetupError(setupError)
        }
    }

    public static func prepareWarmMovieSession(
        options: CameraMovieSessionOptions,
        pickCamera: (_ preferFrontCamera: Bool, _ deviceId: String?) throws -> AVCaptureDevice,
        mapSetupError: (CameraSessionConfigurationError) -> Error) async throws
        -> (session: AVCaptureSession, output: AVCaptureMovieFileOutput)
    {
        try Task.checkCancellation()
        let prepared = try self.prepareMovieSession(
            options: options,
            pickCamera: pickCamera,
            mapSetupError: mapSetupError)
        try Task.checkCancellation()
        prepared.session.startRunning()
        do {
            try await self.warmUpCaptureSession()
            try Task.checkCancellation()
        } catch {
            prepared.session.stopRunning()
            throw error
        }
        return prepared
    }

    public static func withWarmMovieSession<T>(
        options: CameraMovieSessionOptions,
        pickCamera: (_ preferFrontCamera: Bool, _ deviceId: String?) throws -> AVCaptureDevice,
        mapSetupError: (CameraSessionConfigurationError) -> Error,
        operation: (AVCaptureMovieFileOutput) async throws -> T) async throws -> T
    {
        try Task.checkCancellation()
        let prepared = try self.prepareMovieSession(
            options: options,
            pickCamera: pickCamera,
            mapSetupError: mapSetupError)
        return try await self.withCaptureSessionLifecycle(
            start: { prepared.session.startRunning() },
            stop: { prepared.session.stopRunning() },
            warmUp: { try await self.warmUpCaptureSession() },
            operation: { try await operation(prepared.output) })
    }

    static func withCaptureSessionLifecycle<T>(
        start: () -> Void,
        stop: () -> Void,
        warmUp: () async throws -> Void,
        operation: () async throws -> T) async throws -> T
    {
        try Task.checkCancellation()
        start()
        defer { stop() }

        try Task.checkCancellation()
        try await warmUp()
        try Task.checkCancellation()
        return try await operation()
    }

    public static func mapMovieSetupError<E: Error>(
        _ setupError: CameraSessionConfigurationError,
        microphoneUnavailableError: @autoclosure () -> E,
        captureFailed: (String) -> E) -> E
    {
        if case .microphoneUnavailable = setupError {
            return microphoneUnavailableError()
        }
        return captureFailed(setupError.localizedDescription)
    }

    public static func makePhotoSettings(output: AVCapturePhotoOutput) -> AVCapturePhotoSettings {
        let settings: AVCapturePhotoSettings = {
            if output.availablePhotoCodecTypes.contains(.jpeg) {
                return AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
            }
            return AVCapturePhotoSettings()
        }()
        settings.photoQualityPrioritization = .quality
        return settings
    }

    public static func warmUpCaptureSession() async throws {
        // A short delay after `startRunning()` significantly reduces "blank first frame" captures on some devices.
        try await Task.sleep(nanoseconds: 150_000_000) // 150ms
    }

    public static func positionLabel(_ position: AVCaptureDevice.Position) -> String {
        switch position {
        case .front: "front"
        case .back: "back"
        default: "unspecified"
        }
    }
}
#endif
