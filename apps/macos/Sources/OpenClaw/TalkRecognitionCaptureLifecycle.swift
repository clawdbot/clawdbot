@preconcurrency import AVFoundation
import Foundation
import Speech

struct PreparedRecognitionCapture {
    let request: SFSpeechAudioBufferRecognitionRequest
    let engine: AVAudioEngine
    let activeInputResolution: AudioInputDeviceResolution

    func discard() {
        self.request.endAudio()
        self.engine.inputNode.removeTap(onBus: 0)
        self.engine.stop()
    }
}

enum TalkAudioInputError: LocalizedError {
    case unavailable
    case invalidFormat

    var errorDescription: String? {
        switch self {
        case .unavailable: "Selected input and system default are unavailable"
        case .invalidFormat: "Selected audio input has no usable format"
        }
    }
}

enum TalkRecognitionCaptureLifecycle {
    static func configure(_ request: SFSpeechAudioBufferRecognitionRequest) {
        SpeechRecognitionRequestPolicy.configureInteractiveTranscription(request)
    }

    static func start<Capture>(
        isCurrent: () -> Bool,
        prepare: (_ enableVoiceProcessing: Bool) throws -> Capture,
        discard: (Capture) -> Void,
        publish: (Capture) -> Void,
        onFailure: (_ enableVoiceProcessing: Bool, _ error: Error) -> Void) -> Bool
    {
        for enableVoiceProcessing in [true, false] {
            guard isCurrent() else { return false }
            do {
                let capture = try prepare(enableVoiceProcessing)
                guard isCurrent() else {
                    discard(capture)
                    return false
                }
                publish(capture)
                return true
            } catch {
                onFailure(enableVoiceProcessing, error)
            }
        }
        return false
    }
}
