import AVFAudio
import Foundation
import OpenClawKit
import Speech

enum VoicePermissionSupport {
    static func requestMicrophonePermission(timeoutErrorDomain: String) async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            return true
        case .denied:
            return false
        case .undetermined:
            return await self.requestPermissionWithTimeout(errorDomain: timeoutErrorDomain) { completion in
                AVAudioApplication.requestRecordPermission(completionHandler: completion)
            }
        @unknown default:
            return false
        }
    }

    static func requestSpeechPermission(timeoutErrorDomain: String) async -> Bool {
        let status = SFSpeechRecognizer.authorizationStatus()
        switch status {
        case .authorized:
            return true
        case .denied, .restricted:
            return false
        case .notDetermined:
            break
        @unknown default:
            return false
        }

        return await self.requestPermissionWithTimeout(errorDomain: timeoutErrorDomain) { completion in
            SFSpeechRecognizer.requestAuthorization { authStatus in
                completion(authStatus == .authorized)
            }
        }
    }

    static func speechPermissionMessage(
        kind: String,
        status: SFSpeechRecognizerAuthorizationStatus) -> String
    {
        switch status {
        case .denied:
            return String(
                format: String(localized: "%@ permission denied"),
                kind)
        case .restricted:
            return String(
                format: String(localized: "%@ permission restricted"),
                kind)
        case .notDetermined:
            return String(
                format: String(localized: "%@ permission not granted"),
                kind)
        case .authorized:
            return String(
                format: String(localized: "%@ permission denied"),
                kind)
        @unknown default:
            return String(
                format: String(localized: "%@ permission denied"),
                kind)
        }
    }

    private static func requestPermissionWithTimeout(
        errorDomain: String,
        operation: @escaping @Sendable (@escaping @Sendable (Bool) -> Void) -> Void) async -> Bool
    {
        do {
            return try await AsyncTimeout.withTimeout(
                seconds: 8,
                onTimeout: { NSError(domain: errorDomain, code: 6, userInfo: [
                    NSLocalizedDescriptionKey: "permission request timed out",
                ]) },
                operation: { await PermissionRequestBridge.awaitRequest(operation) })
        } catch {
            return false
        }
    }
}
