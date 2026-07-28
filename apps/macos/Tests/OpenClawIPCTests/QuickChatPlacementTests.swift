import AppKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct QuickChatPlacementTests {
    @Test func `centers bar at spotlight height`() {
        let frame = QuickChatPlacement.barFrame(
            contentSize: NSSize(width: 620, height: 60),
            visibleFrame: NSRect(x: 0, y: 0, width: 1000, height: 800))

        #expect(frame == NSRect(x: 190, y: 564, width: 620, height: 60))
    }

    @Test func `respects visible frame origin`() {
        let frame = QuickChatPlacement.barFrame(
            contentSize: NSSize(width: 620, height: 80),
            visibleFrame: NSRect(x: 1200, y: 40, width: 1400, height: 900))

        #expect(frame.origin.x == 1590)
        #expect(frame.maxY == 742)
    }

    @Test func `clamps oversized content to small screen`() {
        let visible = NSRect(x: 20, y: 30, width: 300, height: 100)
        let frame = QuickChatPlacement.barFrame(
            contentSize: NSSize(width: 620, height: 200),
            visibleFrame: visible)

        #expect(frame == visible)
    }

    @Test func `zero visible frame returns zero`() {
        #expect(QuickChatPlacement.barFrame(
            contentSize: NSSize(width: 620, height: 60),
            visibleFrame: .zero) == .zero)
    }

    @Test func `scaled rect preserves center and applies factor`() {
        let source = NSRect(x: 100, y: 200, width: 600, height: 100)
        let scaled = QuickChatPlacement.scaledRect(source, factor: 0.96)

        #expect(scaled.midX == source.midX)
        #expect(scaled.midY == source.midY)
        #expect(scaled.width == 576)
        #expect(scaled.height == 96)
    }
}
