import Foundation
import Speech

enum SpeechRecognitionRequestPolicy {
    enum PolicyError: LocalizedError, Equatable {
        case onDeviceRecognitionUnavailable

        var errorDescription: String? {
            switch self {
            case .onDeviceRecognitionUnavailable:
                "On-device speech recognition is unavailable for this language on this Mac."
            }
        }
    }

    static func configurePassiveVoiceWake(
        _ request: SFSpeechAudioBufferRecognitionRequest,
        supportsOnDeviceRecognition: Bool) throws
    {
        guard supportsOnDeviceRecognition else {
            throw PolicyError.onDeviceRecognitionUnavailable
        }
        self.configureCommon(request)
        request.requiresOnDeviceRecognition = true
    }

    static func configureInteractiveTranscription(_ request: SFSpeechAudioBufferRecognitionRequest) {
        self.configureCommon(request)
        request.requiresOnDeviceRecognition = false
    }

    static func supportsPassiveVoiceWake(localeID: String?) -> Bool {
        let locale = localeID.flatMap { Locale(identifier: $0) }
            ?? Locale(identifier: Locale.current.identifier)
        return SFSpeechRecognizer(locale: locale)?.supportsOnDeviceRecognition == true
    }

    private static func configureCommon(_ request: SFSpeechAudioBufferRecognitionRequest) {
        request.shouldReportPartialResults = true
        request.taskHint = .dictation
    }
}
