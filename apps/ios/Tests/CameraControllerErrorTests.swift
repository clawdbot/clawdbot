import Testing
@testable import Clawdbot

@Suite struct CameraControllerErrorTests {
    @Test func errorDescriptionsAreStable() {
        #expect(CameraController.CameraError.cameraUnavailable.errorDescription == "Camera unavailable")
        #expect(CameraController.CameraError.microphoneUnavailable.errorDescription == "Microphone unavailable")
        #expect(CameraController.CameraError.permissionDenied(kind: "Camera")
            .errorDescription == "Camera permission denied")
        #expect(CameraController.CameraError.invalidParams("bad").errorDescription == "bad")
        #expect(CameraController.CameraError.captureFailed("nope").errorDescription == "nope")
        #expect(CameraController.CameraError.exportFailed("export").errorDescription == "export")
    }
}
