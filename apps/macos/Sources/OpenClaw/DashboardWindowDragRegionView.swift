import AppKit

enum DashboardWindowDragGesture {
    @MainActor
    static func handle(_ event: NSEvent, in window: NSWindow) {
        // These custom surfaces replace AppKit's titlebar hit region. Preserve
        // its maximize gesture instead of consuming the second click as a drag.
        if event.type == .leftMouseDown, event.clickCount == 2 {
            window.performZoom(nil)
            return
        }
        window.performDrag(with: event)
    }
}

final class DashboardWindowDragRegionView: NSView {
    override var mouseDownCanMoveWindow: Bool {
        true
    }

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        DashboardWindowDragGesture.handle(event, in: window)
    }
}
