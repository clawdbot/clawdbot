import Foundation
import Testing
@testable import OpenClaw

struct ScreenshotSizeTests {
    @Test
    func `read PNG size returns dimensions`() throws {
        let pngBase64 =
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+WZxkAAAAASUVORK5CYII="
        let data = try #require(Data(base64Encoded: pngBase64))
        let size = ScreenshotSize.readPNGSize(data: data)
        #expect(size?.width == 1)
        #expect(size?.height == 1)
    }

    @Test
    func `read PNG size rejects non PNG data`() {
        #expect(ScreenshotSize.readPNGSize(data: Data("nope".utf8)) == nil)
    }
}
