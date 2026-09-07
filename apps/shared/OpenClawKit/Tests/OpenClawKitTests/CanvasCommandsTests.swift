import Foundation
import OpenClawKit
import Testing

struct CanvasCommandsTests {
    @Test func `presenter command strings are stable`() {
        #expect(OpenClawCanvasCommand.present.rawValue == "canvas.present")
        #expect(OpenClawCanvasCommand.hide.rawValue == "canvas.hide")
        #expect(OpenClawCanvasCommand.navigate.rawValue == "canvas.navigate")
    }

    @Test func `presenter params decode shipped wire shapes`() throws {
        let presentData = try #require(
            """
            {"url":"openclaw-canvas://widget.html","placement":{"x":1,"y":2,"width":3,"height":4}}
            """.data(using: .utf8))
        let present = try JSONDecoder().decode(OpenClawCanvasPresentParams.self, from: presentData)
        #expect(present.url == "openclaw-canvas://widget.html")
        #expect(present.placement?.x == 1)
        #expect(present.placement?.y == 2)
        #expect(present.placement?.width == 3)
        #expect(present.placement?.height == 4)

        let navigateData = try #require(
            "{\"url\":\"openclaw-canvas://next.html\"}".data(using: .utf8))
        let navigate = try JSONDecoder().decode(OpenClawCanvasNavigateParams.self, from: navigateData)
        #expect(navigate.url == "openclaw-canvas://next.html")
    }
}
