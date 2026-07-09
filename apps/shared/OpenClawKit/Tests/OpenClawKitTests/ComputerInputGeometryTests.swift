import Foundation
import OpenClawKit
import Testing

struct ComputerInputGeometryTests {
    private func display(
        originX: Double = 0,
        originY: Double = 0,
        width: Double,
        height: Double) -> OpenClawComputerDisplayGeometry
    {
        OpenClawComputerDisplayGeometry(
            originX: originX,
            originY: originY,
            widthPoints: width,
            heightPoints: height)
    }

    private func capturedWidth(refWidth: Int?, sourceWidth: Double, sourceHeight: Double = 0) -> Double {
        OpenClawComputerInputGeometry.capturedWidth(
            refWidth: refWidth,
            sourceWidth: sourceWidth,
            sourceHeight: sourceHeight)
    }

    @Test func `maps one to one when capture matches display`() {
        // Source width equals display points and refWidth: captured 1280px over
        // a 1280pt display → 1:1.
        let captured = self.capturedWidth(refWidth: 1280, sourceWidth: 1280)
        #expect(captured == 1280)
        let mapped = OpenClawComputerInputGeometry.mapReferencePointToGlobal(
            x: 100,
            y: 200,
            capturedWidthPixels: captured,
            display: self.display(width: 1280, height: 800))
        #expect(mapped.x == 100)
        #expect(mapped.y == 200)
    }

    @Test func `never upscales when ref width exceeds source`() {
        // refWidth larger than the capture source means the screenshot is the
        // full source width, so mapping over a matching-point display stays 1:1.
        let captured = self.capturedWidth(refWidth: 4000, sourceWidth: 1512)
        #expect(captured == 1512)
        let mapped = OpenClawComputerInputGeometry.mapReferencePointToGlobal(
            x: 300,
            y: 150,
            capturedWidthPixels: captured,
            display: self.display(width: 1512, height: 982))
        #expect(mapped.x == 300)
        #expect(mapped.y == 150)
    }

    @Test func `scales up from downscaled screenshot`() {
        // Display is 2560pt wide, capture source 2560; screenshot captured at
        // refWidth 1280 → captured 1280px, scale 2x.
        let captured = self.capturedWidth(refWidth: 1280, sourceWidth: 2560)
        #expect(captured == 1280)
        let mapped = OpenClawComputerInputGeometry.mapReferencePointToGlobal(
            x: 100,
            y: 50,
            capturedWidthPixels: captured,
            display: self.display(width: 2560, height: 1600))
        #expect(mapped.x == 200)
        #expect(mapped.y == 100)
    }

    @Test func `scales down on retina when pixels exceed points`() {
        // Retina display set to 1024 logical points but 2048 physical pixels:
        // capture source (pixels) 2048 downscales to refWidth 1280, and the
        // 1280px screenshot must map back onto the 1024pt display (scale 0.8).
        let captured = self.capturedWidth(refWidth: 1280, sourceWidth: 2048)
        #expect(captured == 1280)
        let mapped = OpenClawComputerInputGeometry.mapReferencePointToGlobal(
            x: 1280,
            y: 0,
            capturedWidthPixels: captured,
            display: self.display(width: 1024, height: 640))
        #expect(mapped.x == 1024)
        #expect(mapped.y == 0)
    }

    @Test func `adds display origin after scaling`() {
        let captured = self.capturedWidth(refWidth: 1280, sourceWidth: 2560)
        let mapped = OpenClawComputerInputGeometry.mapReferencePointToGlobal(
            x: 100,
            y: 0,
            capturedWidthPixels: captured,
            display: self.display(originX: 1512, originY: 0, width: 2560, height: 1600))
        // 100 * (2560/1280) + 1512 origin.
        #expect(mapped.x == 1712)
        #expect(mapped.y == 0)
    }

    @Test func `scales down portrait capture whose height exceeds reference width`() {
        // Portrait source 1080x1920: width cap keeps 1080, but the capture's
        // longest edge (1920) exceeds the 1280 reference width, so the agent
        // scales the whole frame down. Delivered width = 1080 * 1280 / 1920 = 720.
        let captured = self.capturedWidth(refWidth: 1280, sourceWidth: 1080, sourceHeight: 1920)
        #expect(captured == 720)
        // The 720px-wide delivered frame maps back onto the 1080pt portrait
        // display (scale 1.5), so replayed coordinates land on target.
        let mapped = OpenClawComputerInputGeometry.mapReferencePointToGlobal(
            x: 360,
            y: 0,
            capturedWidthPixels: captured,
            display: self.display(width: 1080, height: 1920))
        #expect(mapped.x == 540)
        #expect(mapped.y == 0)
    }

    @Test func `keeps landscape width when the width is the longest edge`() {
        // Landscape source 2560x1440: the width cap (1280) is already the longest
        // edge, so longest-edge scaling is a no-op and the width cap stands.
        let captured = self.capturedWidth(refWidth: 1280, sourceWidth: 2560, sourceHeight: 1440)
        #expect(captured == 1280)
    }

    @Test func `clamps far-edge and out-of-bounds points strictly inside the display`() {
        let display = self.display(originX: 100, originY: 200, width: 1280, height: 800)
        // The far right/bottom edge maps to origin + size, which belongs to the
        // adjacent display; clamp keeps it on the last in-bounds point.
        let farEdge = OpenClawComputerInputGeometry.clampToDisplay(
            x: 100 + 1280,
            y: 200 + 800,
            display: display)
        #expect(farEdge.x == 100 + 1279)
        #expect(farEdge.y == 200 + 799)
        // A slightly-negative epsilon overrun clamps back to the origin.
        let negative = OpenClawComputerInputGeometry.clampToDisplay(x: 99, y: 199, display: display)
        #expect(negative.x == 100)
        #expect(negative.y == 200)
        // A point already inside is unchanged.
        let inside = OpenClawComputerInputGeometry.clampToDisplay(x: 640, y: 400, display: display)
        #expect(inside.x == 640)
        #expect(inside.y == 400)
    }

    @Test func `captured width is non-positive for a non-positive reference width`() {
        // Justifies the executor rejecting refWidth <= 0 before mapping: geometry
        // would otherwise yield a non-positive width that collapses every
        // coordinate onto the display origin.
        #expect(self.capturedWidth(refWidth: 0, sourceWidth: 1280, sourceHeight: 800) <= 0)
        #expect(self.capturedWidth(refWidth: -5, sourceWidth: 1280, sourceHeight: 800) <= 0)
    }

    @Test func `falls back to origin for degenerate display`() {
        let mapped = OpenClawComputerInputGeometry.mapReferencePointToGlobal(
            x: 42,
            y: 42,
            capturedWidthPixels: 0,
            display: self.display(originX: 10, originY: 20, width: 0, height: 0))
        #expect(mapped.x == 10)
        #expect(mapped.y == 20)
    }

    @Test func `decodes partial act params`() throws {
        let json = """
        {"action":"left_click","x":12,"y":34,"modifiers":"shift","screenIndex":0,"refWidth":1280}
        """
        let data = try #require(json.data(using: .utf8))
        let params = try JSONDecoder().decode(OpenClawComputerActParams.self, from: data)
        #expect(params.action == .leftClick)
        #expect(params.x == 12)
        #expect(params.modifiers == "shift")
        #expect(params.refWidth == 1280)
    }

    @Test func `decodes scroll and hold actions`() throws {
        let scroll = try #require(
            "{\"action\":\"scroll\",\"scrollDirection\":\"down\",\"scrollAmount\":3}".data(using: .utf8))
        let scrollParams = try JSONDecoder().decode(OpenClawComputerActParams.self, from: scroll)
        #expect(scrollParams.action == .scroll)
        #expect(scrollParams.scrollDirection == .down)
        #expect(scrollParams.scrollAmount == 3)

        let hold = try #require(
            "{\"action\":\"hold_key\",\"keys\":\"space\",\"durationMs\":2000}".data(using: .utf8))
        let holdParams = try JSONDecoder().decode(OpenClawComputerActParams.self, from: hold)
        #expect(holdParams.action == .holdKey)
        #expect(holdParams.keys == "space")
        #expect(holdParams.durationMs == 2000)
    }
}
