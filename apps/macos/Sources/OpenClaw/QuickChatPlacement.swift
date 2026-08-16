import AppKit

enum QuickChatPlacement {
    static func scaledRect(_ rect: NSRect, factor: CGFloat) -> NSRect {
        let size = NSSize(width: rect.width * factor, height: rect.height * factor)
        return NSRect(
            x: rect.midX - (size.width / 2),
            y: rect.midY - (size.height / 2),
            width: size.width,
            height: size.height)
    }

    static func barFrame(contentSize: NSSize, visibleFrame: NSRect) -> NSRect {
        guard visibleFrame.width > 0, visibleFrame.height > 0 else { return .zero }

        let size = NSSize(
            width: min(max(0, contentSize.width), visibleFrame.width),
            height: min(max(0, contentSize.height), visibleFrame.height))
        let desiredTop = visibleFrame.maxY - (0.22 * visibleFrame.height)
        let desiredOrigin = NSPoint(
            x: visibleFrame.midX - (size.width / 2),
            y: desiredTop - size.height)
        let origin = NSPoint(
            x: min(max(desiredOrigin.x, visibleFrame.minX), visibleFrame.maxX - size.width),
            y: min(max(desiredOrigin.y, visibleFrame.minY), visibleFrame.maxY - size.height))
        return NSRect(origin: origin, size: size)
    }
}
