import AppKit
import Testing
@testable import Moltbot

@Suite
@MainActor
struct WindowPlacementTests {
    @Test
    func centeredFrameZeroBoundsFallsBackToOrigin() {
        let frame = WindowPlacement.centeredFrame(size: NSSize(width: 120, height: 80), in: NSRect.zero)
        #expect(frame.origin == .zero)
        #expect(frame.size == NSSize(width: 120, height: 80))
    }

    @Test
    func centeredFrameClampsToBoundsAndCenters() {
        let bounds = NSRect(x: 10, y: 20, width: 300, height: 200)
        let frame = WindowPlacement.centeredFrame(size: NSSize(width: 600, height: 120), in: bounds)
        #expect(frame.size.width == bounds.width)
        #expect(frame.size.height == 120)
        #expect(frame.minX == bounds.minX)
        #expect(frame.midY == bounds.midY)
    }

    @Test
    func topRightFrameZeroBoundsFallsBackToOrigin() {
        let frame = WindowPlacement.topRightFrame(
            size: NSSize(width: 120, height: 80),
            padding: 12,
            in: NSRect.zero)
        #expect(frame.origin == .zero)
        #expect(frame.size == NSSize(width: 120, height: 80))
    }

    @Test
    func topRightFrameClampsToBoundsAndAppliesPadding() {
        let bounds = NSRect(x: 10, y: 20, width: 300, height: 200)
        let frame = WindowPlacement.topRightFrame(
            size: NSSize(width: 400, height: 50),
            padding: 8,
            in: bounds)
        #expect(frame.size.width == bounds.width)
        #expect(frame.size.height == 50)
        #expect(frame.maxX == bounds.maxX - 8)
        #expect(frame.maxY == bounds.maxY - 8)
    }

    @Test
    func ensureOnScreenUsesFallbackWhenWindowOffscreen() {
        let window = NSWindow(
            contentRect: NSRect(x: 100_000, y: 100_000, width: 200, height: 120),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false)

        WindowPlacement.ensureOnScreen(
            window: window,
            defaultSize: NSSize(width: 200, height: 120),
            fallback: { _ in NSRect(x: 11, y: 22, width: 33, height: 44) })

        #expect(window.frame == NSRect(x: 11, y: 22, width: 33, height: 44))
    }

    @Test
    func ensureOnScreenDoesNotMoveVisibleWindow() {
        let screen = NSScreen.main ?? NSScreen.screens.first
        #expect(screen != nil)
        guard let screen else { return }

        let visible = screen.visibleFrame.insetBy(dx: 40, dy: 40)
        let window = NSWindow(
            contentRect: NSRect(x: visible.minX, y: visible.minY, width: 200, height: 120),
            styleMask: [.titled],
            backing: .buffered,
            defer: false)
        let original = window.frame

        WindowPlacement.ensureOnScreen(
            window: window,
            defaultSize: NSSize(width: 200, height: 120),
            fallback: { _ in NSRect(x: 11, y: 22, width: 33, height: 44) })

        #expect(window.frame == original)
    }
}
