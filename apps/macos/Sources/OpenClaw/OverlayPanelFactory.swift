import AppKit
import QuartzCore

enum OverlayPanelFactory {
    @MainActor
    static func makePanel(
        contentRect: NSRect,
        level: NSWindow.Level,
        hasShadow: Bool,
        acceptsMouseMovedEvents: Bool = false) -> NSPanel
    {
        let panel = NSPanel(
            contentRect: contentRect,
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = hasShadow
        panel.level = level
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.hidesOnDeactivate = false
        panel.isMovable = false
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.acceptsMouseMovedEvents = acceptsMouseMovedEvents
        return panel
    }

    @MainActor
    static func animatePresent(window: NSWindow, from start: NSRect, to target: NSRect, duration: TimeInterval = 0.18) {
        window.setFrame(start, display: true)
        window.alphaValue = 0
        window.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = duration
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            window.animator().setFrame(target, display: true)
            window.animator().alphaValue = 1
        }
    }

    @MainActor
    static func animateFrame(window: NSWindow, to frame: NSRect, duration: TimeInterval = 0.12) {
        NSAnimationContext.runAnimationGroup { context in
            context.duration = duration
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            window.animator().setFrame(frame, display: true)
        }
    }

    @MainActor
    static func applyFrame(window: NSWindow?, target: NSRect, animate: Bool) {
        guard let window else { return }
        if animate {
            self.animateFrame(window: window, to: target)
        } else {
            window.setFrame(target, display: true)
        }
    }

    @MainActor
    static func present(
        window: NSWindow?,
        isFirstPresent: Bool,
        target: NSRect,
        startOffsetY: CGFloat = -6,
        onFirstPresent: (() -> Void)? = nil,
        onAlreadyVisible: (NSWindow) -> Void)
    {
        guard let window else { return }
        if isFirstPresent {
            onFirstPresent?()
            let start = target.offsetBy(dx: 0, dy: startOffsetY)
            self.animatePresent(window: window, from: start, to: target)
        } else {
            onAlreadyVisible(window)
        }
    }

    @MainActor
    static func animateDismiss(
        window: NSWindow,
        offsetX: CGFloat = 6,
        offsetY: CGFloat = 6,
        duration: TimeInterval = 0.16,
        completion: @escaping @MainActor @Sendable () -> Void)
    {
        let target = window.frame.offsetBy(dx: offsetX, dy: offsetY)
        NSAnimationContext.runAnimationGroup { context in
            context.duration = duration
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            window.animator().setFrame(target, display: true)
            window.animator().alphaValue = 0
        } completionHandler: {
            Task { @MainActor in completion() }
        }
    }

    @MainActor
    static func animateDismiss(
        window: NSWindow,
        to target: NSRect,
        duration: TimeInterval,
        completion: @escaping @MainActor @Sendable () -> Void)
    {
        NSAnimationContext.runAnimationGroup { context in
            context.duration = duration
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            window.animator().setFrame(target, display: true)
            window.animator().alphaValue = 0
        } completionHandler: {
            Task { @MainActor in completion() }
        }
    }

    @MainActor
    static func animateDismissAndHide(
        window: NSWindow,
        offsetX: CGFloat = 6,
        offsetY: CGFloat = 6,
        duration: TimeInterval = 0.16,
        onHidden: @escaping @MainActor () -> Void)
    {
        self.animateDismiss(window: window, offsetX: offsetX, offsetY: offsetY, duration: duration) {
            window.orderOut(nil)
            onHidden()
        }
    }

    @MainActor
    static func animateDismissAndHide(
        window: NSWindow,
        to target: NSRect,
        duration: TimeInterval,
        onHidden: @escaping @MainActor () -> Void)
    {
        self.animateDismiss(window: window, to: target, duration: duration) {
            window.orderOut(nil)
            onHidden()
        }
    }

    @MainActor
    static func clearGlobalEventMonitor(_ monitor: inout Any?) {
        if let current = monitor {
            NSEvent.removeMonitor(current)
            monitor = nil
        }
    }
}
