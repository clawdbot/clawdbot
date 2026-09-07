import AppKit

enum QuickChatAreaPickerLogic {
    static let minimumSelectionDimension: CGFloat = 8

    static func normalizedSelection(from start: CGPoint, to end: CGPoint) -> CGRect? {
        let rect = CGRect(
            x: min(start.x, end.x),
            y: min(start.y, end.y),
            width: abs(end.x - start.x),
            height: abs(end.y - start.y))
        // Tiny drags are almost always clicks or hand jitter; treating them as cancel
        // avoids surprising one-pixel captures and invalid capture-area requests.
        guard rect.width >= Self.minimumSelectionDimension,
              rect.height >= Self.minimumSelectionDimension
        else { return nil }
        return rect
    }

    /// Converts AppKit's bottom-left global screen space into the top-left global
    /// display coordinates consumed by Peekaboo captureArea/SCDisplay.frame.
    static func globalDisplayRect(
        appKitRect: CGRect,
        screenFrame: CGRect,
        displayBounds: CGRect) -> CGRect
    {
        CGRect(
            x: displayBounds.minX + appKitRect.minX - screenFrame.minX,
            y: displayBounds.minY + screenFrame.maxY - appKitRect.maxY,
            width: appKitRect.width,
            height: appKitRect.height)
    }
}

@MainActor
final class QuickChatAreaPickerView: NSView {
    private let onSelect: (CGRect) -> Void
    private let onCancel: () -> Void
    private var dragStart: CGPoint?
    private var selection: CGRect?

    init(frame: CGRect, onSelect: @escaping (CGRect) -> Void, onCancel: @escaping () -> Void) {
        self.onSelect = onSelect
        self.onCancel = onCancel
        super.init(frame: frame)
        self.wantsLayer = true
    }

    @available(*, unavailable)
    required init?(coder _: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func acceptsFirstMouse(for _: NSEvent?) -> Bool {
        true
    }

    override func resetCursorRects() {
        self.addCursorRect(self.bounds, cursor: .crosshair)
    }

    override func mouseDown(with event: NSEvent) {
        let point = self.clamped(self.convert(event.locationInWindow, from: nil))
        self.dragStart = point
        self.selection = nil
        self.needsDisplay = true
    }

    override func mouseDragged(with event: NSEvent) {
        guard let dragStart else { return }
        let point = self.clamped(self.convert(event.locationInWindow, from: nil))
        self.selection = self.normalizedRect(from: dragStart, to: point)
        self.needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        guard let dragStart else {
            self.onCancel()
            return
        }
        let point = self.clamped(self.convert(event.locationInWindow, from: nil))
        self.dragStart = nil
        guard let selection = QuickChatAreaPickerLogic.normalizedSelection(from: dragStart, to: point) else {
            self.onCancel()
            return
        }
        self.onSelect(selection)
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let dimmingPath = NSBezierPath(rect: self.bounds)
        if let selection {
            dimmingPath.appendRect(selection)
        }
        dimmingPath.windingRule = .evenOdd
        NSColor.black.withAlphaComponent(0.35).setFill()
        dimmingPath.fill()

        guard let selection, selection.width > 0, selection.height > 0 else { return }
        let scale = self.window?.backingScaleFactor ?? 1
        let border = NSBezierPath(rect: selection.insetBy(dx: 0.5 / scale, dy: 0.5 / scale))
        border.lineWidth = 1 / scale
        NSColor.controlAccentColor.setStroke()
        border.stroke()
        self.drawSizeBadge(for: selection)
    }

    private func drawSizeBadge(for selection: CGRect) {
        let text = "\(Int(selection.width.rounded())) × \(Int(selection.height.rounded()))" as NSString
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium),
            .foregroundColor: NSColor.white,
        ]
        let textSize = text.size(withAttributes: attributes)
        let badgeSize = CGSize(width: textSize.width + 14, height: textSize.height + 8)
        let preferredY = selection.maxY + 7
        let fallbackY = selection.minY - badgeSize.height - 7
        let y = preferredY + badgeSize.height <= self.bounds.maxY ? preferredY : max(self.bounds.minY + 4, fallbackY)
        let x = min(
            max(self.bounds.minX + 4, selection.minX),
            self.bounds.maxX - badgeSize.width - 4)
        let badgeRect = CGRect(origin: CGPoint(x: x, y: y), size: badgeSize)
        NSColor.black.withAlphaComponent(0.78).setFill()
        NSBezierPath(roundedRect: badgeRect, xRadius: 6, yRadius: 6).fill()
        text.draw(
            at: CGPoint(x: badgeRect.minX + 7, y: badgeRect.minY + 4),
            withAttributes: attributes)
    }

    private func normalizedRect(from start: CGPoint, to end: CGPoint) -> CGRect {
        CGRect(
            x: min(start.x, end.x),
            y: min(start.y, end.y),
            width: abs(end.x - start.x),
            height: abs(end.y - start.y))
    }

    private func clamped(_ point: CGPoint) -> CGPoint {
        CGPoint(
            x: min(max(point.x, self.bounds.minX), self.bounds.maxX),
            y: min(max(point.y, self.bounds.minY), self.bounds.maxY))
    }
}
