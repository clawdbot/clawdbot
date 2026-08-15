import AppKit

enum TrackingAreaSupport {
    @MainActor
    static func resetMouseTracking(
        on view: NSView,
        tracking: inout NSTrackingArea?,
        owner: AnyObject)
    {
        if let tracking {
            view.removeTrackingArea(tracking)
        }
        let options: NSTrackingArea.Options = [
            .mouseEnteredAndExited,
            .activeAlways,
            .inVisibleRect,
        ]
        let area = NSTrackingArea(rect: view.bounds, options: options, owner: owner, userInfo: nil)
        view.addTrackingArea(area)
        tracking = area
    }
}
