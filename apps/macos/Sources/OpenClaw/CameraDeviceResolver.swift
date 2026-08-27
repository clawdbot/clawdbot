import AVFoundation

enum CameraDeviceResolver {
    static func availableCameras() -> [AVCaptureDevice] {
        var types: [AVCaptureDevice.DeviceType] = [
            .builtInWideAngleCamera,
            .continuityCamera,
        ]
        if let external = self.externalDeviceType() {
            types.append(external)
        }
        return AVCaptureDevice.DiscoverySession(
            deviceTypes: types,
            mediaType: .video,
            position: .unspecified).devices
    }

    static func camera(deviceId: String) -> AVCaptureDevice? {
        self.availableCameras().first { $0.uniqueID == deviceId }
    }

    private static func externalDeviceType() -> AVCaptureDevice.DeviceType? {
        if #available(macOS 14.0, *) {
            return .external
        }
        return AVCaptureDevice.DeviceType(rawValue: "AVCaptureDeviceTypeExternalUnknown")
    }
}
