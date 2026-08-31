import AVFoundation

enum CameraDeviceResolver {
    static func availableCameras() -> [AVCaptureDevice] {
        let types: [AVCaptureDevice.DeviceType] = [
            .builtInWideAngleCamera,
            .continuityCamera,
            .external,
        ]
        return AVCaptureDevice.DiscoverySession(
            deviceTypes: types,
            mediaType: .video,
            position: .unspecified).devices
    }

    static func camera(deviceId: String) -> AVCaptureDevice? {
        self.availableCameras().first { $0.uniqueID == deviceId }
    }

    static func landscapePhotoFormatIndex(
        deviceType: AVCaptureDevice.DeviceType,
        activeFormat: CMFormatDescription,
        formats: [CMFormatDescription]) -> Int?
    {
        let activeSize = CMVideoFormatDescriptionGetDimensions(activeFormat)
        guard deviceType == .external, activeSize.width < activeSize.height else {
            return nil
        }
        let subtype = CMFormatDescriptionGetMediaSubType(activeFormat)
        // Repair portrait negotiation without choosing a different resolution or encoding.
        // Cameras without an exact landscape counterpart keep their negotiated format.
        return formats.firstIndex { format in
            let size = CMVideoFormatDescriptionGetDimensions(format)
            return size.width == activeSize.height && size.height == activeSize.width &&
                CMFormatDescriptionGetMediaSubType(format) == subtype
        }
    }
}
