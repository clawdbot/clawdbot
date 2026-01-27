import Testing
@testable import Moltbot

@Suite struct CameraControllerClampTests {
    @Test func clampQualityDefaultsAndBounds() {
        #expect(CameraController.clampQuality(nil) == 0.9)
        #expect(CameraController.clampQuality(0.0) == 0.05)
        #expect(CameraController.clampQuality(0.049) == 0.05)
        #expect(CameraController.clampQuality(0.05) == 0.05)
        #expect(CameraController.clampQuality(0.5) == 0.5)
        #expect(CameraController.clampQuality(1.0) == 1.0)
        #expect(CameraController.clampQuality(1.1) == 1.0)
    }

    @Test func clampDurationDefaultsAndBounds() {
        #expect(CameraController.clampDurationMs(nil) == 3000)
        #expect(CameraController.clampDurationMs(0) == 250)
        #expect(CameraController.clampDurationMs(249) == 250)
        #expect(CameraController.clampDurationMs(250) == 250)
        #expect(CameraController.clampDurationMs(1000) == 1000)
        #expect(CameraController.clampDurationMs(60000) == 60000)
        #expect(CameraController.clampDurationMs(60001) == 60000)
    }
}
