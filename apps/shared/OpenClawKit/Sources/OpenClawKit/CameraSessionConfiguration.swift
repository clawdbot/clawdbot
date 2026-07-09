import AVFoundation
import CoreMedia

#if !os(watchOS)
public enum CameraSessionConfigurationError: LocalizedError {
    case addCameraInputFailed
    case addPhotoOutputFailed
    case microphoneUnavailable
    case addMicrophoneInputFailed
    case addMovieOutputFailed

    public var errorDescription: String? {
        switch self {
        case .addCameraInputFailed:
            "Failed to add camera input"
        case .addPhotoOutputFailed:
            "Failed to add photo output"
        case .microphoneUnavailable:
            "Microphone unavailable"
        case .addMicrophoneInputFailed:
            "Failed to add microphone input"
        case .addMovieOutputFailed:
            "Failed to add movie output"
        }
    }
}

public enum CameraSessionConfiguration {
    public static func addCameraInput(session: AVCaptureSession, camera: AVCaptureDevice) throws {
        let input = try AVCaptureDeviceInput(device: camera)
        guard session.canAddInput(input) else {
            throw CameraSessionConfigurationError.addCameraInputFailed
        }
        session.addInput(input)
    }

    public static func addPhotoOutput(session: AVCaptureSession) throws -> AVCapturePhotoOutput {
        let output = AVCapturePhotoOutput()
        guard session.canAddOutput(output) else {
            throw CameraSessionConfigurationError.addPhotoOutputFailed
        }
        session.addOutput(output)
        output.maxPhotoQualityPrioritization = .quality
        return output
    }

    public static func addMovieOutput(
        session: AVCaptureSession,
        includeAudio: Bool,
        durationMs: Int) throws -> AVCaptureMovieFileOutput
    {
        if includeAudio {
            guard let mic = AVCaptureDevice.default(for: .audio) else {
                throw CameraSessionConfigurationError.microphoneUnavailable
            }
            let micInput = try AVCaptureDeviceInput(device: mic)
            guard session.canAddInput(micInput) else {
                throw CameraSessionConfigurationError.addMicrophoneInputFailed
            }
            session.addInput(micInput)
        }

        let output = AVCaptureMovieFileOutput()
        guard session.canAddOutput(output) else {
            throw CameraSessionConfigurationError.addMovieOutputFailed
        }
        session.addOutput(output)
        output.maxRecordedDuration = CMTime(value: Int64(durationMs), timescale: 1000)
        return output
    }
}
#endif
