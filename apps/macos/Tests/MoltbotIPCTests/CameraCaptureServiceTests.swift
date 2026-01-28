import Testing

@testable import Moltbot

@Suite struct CameraCaptureServiceTests {
    @Test func normalizeSnapDefaults() {
        let res = CameraCaptureService.normalizeSnap(maxWidth: nil, quality: nil)
        #expect(res.maxWidth == 1600)
        #expect(res.quality == 0.9)
    }

    @Test func normalizeSnapClampsValues() {
        let low = CameraCaptureService.normalizeSnap(maxWidth: -1, quality: -10)
        #expect(low.maxWidth == 1600)
        #expect(low.quality == 0.05)

        let high = CameraCaptureService.normalizeSnap(maxWidth: 9999, quality: 10)
        #expect(high.maxWidth == 9999)
        #expect(high.quality == 1.0)
    }
}
