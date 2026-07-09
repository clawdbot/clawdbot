import AVFAudio
import Foundation
import OpenClawKit
import Speech

extension TalkModeManager {
    nonisolated static func requestMicrophonePermission() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            return true
        case .denied:
            return false
        case .undetermined:
            return await self.requestPermissionWithTimeout { completion in
                AVAudioApplication.requestRecordPermission(completionHandler: { ok in
                    completion(ok)
                })
            }
        @unknown default:
            return false
        }
    }

    nonisolated static func requestSpeechPermission() async -> Bool {
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

        return await self.requestPermissionWithTimeout { completion in
            SFSpeechRecognizer.requestAuthorization { authStatus in
                completion(authStatus == .authorized)
            }
        }
    }

    private nonisolated static func requestPermissionWithTimeout(
        _ operation: @escaping @Sendable (@escaping @Sendable (Bool) -> Void) -> Void) async -> Bool
    {
        do {
            return try await AsyncTimeout.withTimeout(
                seconds: 8,
                onTimeout: { NSError(domain: "TalkMode", code: 6, userInfo: [
                    NSLocalizedDescriptionKey: "permission request timed out",
                ]) },
                operation: { await PermissionRequestBridge.awaitRequest(operation) })
        } catch {
            return false
        }
    }

    static func permissionMessage(
        kind: String,
        status: SFSpeechRecognizerAuthorizationStatus) -> String
    {
        switch status {
        case .denied:
            return "\(kind) permission denied"
        case .restricted:
            return "\(kind) permission restricted"
        case .notDetermined:
            return "\(kind) permission not granted"
        case .authorized:
            return "\(kind) permission denied"
        @unknown default:
            return "\(kind) permission denied"
        }
    }
}
