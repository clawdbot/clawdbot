import AVFoundation

#if !os(watchOS)
public enum CameraAuthorization {
    public static func isAuthorized(for mediaType: AVMediaType) async -> Bool {
        let status = AVCaptureDevice.authorizationStatus(for: mediaType)
        switch status {
        case .authorized:
            return true
        case .notDetermined:
            #if compiler(>=6.4)
            return await withCheckedContinuation { cont in
                AVCaptureDevice.requestAccess(for: mediaType) { granted in
                    cont.resume(returning: granted)
                }
            }
            #else
            return await withCheckedContinuation(isolation: nil) { cont in
                AVCaptureDevice.requestAccess(for: mediaType) { granted in
                    cont.resume(returning: granted)
                }
            }
            #endif
        case .denied, .restricted:
            return false
        @unknown default:
            return false
        }
    }
}
#endif
