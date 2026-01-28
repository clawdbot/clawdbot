import Foundation
import Testing
@testable import Moltbot

@Suite
struct ScreenshotSizeTests {
    @Test
    func readPNGSizeReturnsDimensions() throws {
        let pngBase64 =
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+WZxkAAAAASUVORK5CYII="
        let data = try #require(Data(base64Encoded: pngBase64))
        let size = ScreenshotSize.readPNGSize(data: data)
        #expect(size?.width == 1)
        #expect(size?.height == 1)
    }

    @Test
    func readPNGSizeRejectsNonPNGData() {
        #expect(ScreenshotSize.readPNGSize(data: Data("nope".utf8)) == nil)
    }
}
