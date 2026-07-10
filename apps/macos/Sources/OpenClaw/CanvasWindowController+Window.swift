import AppKit
import OpenClawIPC

extension CanvasWindowController {
    // MARK: - Window

    static func makeWindow(for presentation: CanvasPresentation, contentView: NSView) -> NSWindow {
        switch presentation {
        case .window:
            let window = NSWindow(
                contentRect: NSRect(origin: .zero, size: CanvasLayout.windowSize),
                styleMask: [.titled, .closable, .resizable, .miniaturizable],
                backing: .buffered,
                defer: false)
            window.title = "OpenClaw Canvas"
            window.isReleasedWhenClosed = false
            window.contentView = contentView
            window.center()
            window.minSize = NSSize(width: 880, height: 680)
            return window

        case .panel:
            let panel = CanvasPanel(
                contentRect: NSRect(origin: .zero, size: CanvasLayout.panelSize),
                styleMask: [.borderless, .resizable],
                backing: .buffered,
                defer: false)
            // Keep Canvas below the Voice Wake overlay panel.
            panel.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue - 1)
            panel.hasShadow = true
            panel.isMovable = false
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            panel.titleVisibility = .hidden
            panel.titlebarAppearsTransparent = true
            panel.backgroundColor = .clear
            panel.isOpaque = false
            panel.contentView = contentView
            panel.becomesKeyOnlyIfNeeded = true
            panel.hidesOnDeactivate = false
            panel.minSize = CanvasLayout.minPanelSize
            return panel
        }
    }

    func presentAnchoredPanel(anchorProvider: @escaping () -> NSRect?) {
        guard case .panel = self.presentation, let window else { return }
        self.repositionPanel(using: anchorProvider)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        window.makeFirstResponder(self.webView)
        VoiceWakeOverlayController.shared.bringToFrontIfVisible()
        self.onVisibilityChanged?(true)
    }

    func repositionPanel(using anchorProvider: () -> NSRect?) {
        guard let panel = self.window else { return }
        let anchor = anchorProvider()
        let targetScreen = Self.screen(forAnchor: anchor)
            ?? Self.screenContainingMouseCursor()
            ?? panel.screen
            ?? NSScreen.main
            ?? NSScreen.screens.first

        let restored = Self.loadRestoredFrame(sessionKey: self.sessionKey)
        let restoredIsValid = if let restored, let targetScreen {
            Self.isFrameMeaningfullyVisible(restored, on: targetScreen)
        } else {
            restored != nil
        }

        var frame = if let restored, restoredIsValid {
            restored
        } else {
            Self.defaultTopRightFrame(panel: panel, screen: targetScreen)
        }

        // Apply agent placement as partial overrides:
        // - If agent provides x/y, override origin.
        // - If agent provides width/height, override size.
        // - If agent provides only size, keep the remembered origin.
        if let placement = self.preferredPlacement {
            if let x = placement.x { frame.origin.x = x }
            if let y = placement.y { frame.origin.y = y }
            if let w = placement.width { frame.size.width = max(CanvasLayout.minPanelSize.width, CGFloat(w)) }
            if let h = placement.height { frame.size.height = max(CanvasLayout.minPanelSize.height, CGFloat(h)) }
        }

        self.setPanelFrame(frame, on: targetScreen)
    }

    static func defaultTopRightFrame(panel: NSWindow, screen: NSScreen?) -> NSRect {
        let w = max(CanvasLayout.minPanelSize.width, panel.frame.width)
        let h = max(CanvasLayout.minPanelSize.height, panel.frame.height)
        return WindowPlacement.topRightFrame(
            size: NSSize(width: w, height: h),
            padding: CanvasLayout.defaultPadding,
            on: screen)
    }

    func setPanelFrame(_ frame: NSRect, on screen: NSScreen?) {
        guard let panel = self.window else { return }
        guard let s = screen ?? panel.screen ?? NSScreen.main ?? NSScreen.screens.first else {
            panel.setFrame(frame, display: false)
            self.persistFrameIfPanel()
            return
        }

        let constrained = Self.constrainFrame(frame, toVisibleFrame: s.visibleFrame)
        panel.setFrame(constrained, display: false)
        self.persistFrameIfPanel()
    }

    static func screen(forAnchor anchor: NSRect?) -> NSScreen? {
        guard let anchor else { return nil }
        let center = NSPoint(x: anchor.midX, y: anchor.midY)
        return NSScreen.screens.first { screen in
            screen.frame.contains(anchor.origin) || screen.frame.contains(center)
        }
    }

    static func screenContainingMouseCursor() -> NSScreen? {
        let point = NSEvent.mouseLocation
        return NSScreen.screens.first { $0.frame.contains(point) }
    }

    static func isFrameMeaningfullyVisible(_ frame: NSRect, on screen: NSScreen) -> Bool {
        frame.intersects(screen.visibleFrame.insetBy(dx: 12, dy: 12))
    }

    static func constrainFrame(_ frame: NSRect, toVisibleFrame bounds: NSRect) -> NSRect {
        if bounds == .zero { return frame }

        var next = frame
        next.size.width = min(max(CanvasLayout.minPanelSize.width, next.size.width), bounds.width)
        next.size.height = min(max(CanvasLayout.minPanelSize.height, next.size.height), bounds.height)

        let maxX = bounds.maxX - next.size.width
        let maxY = bounds.maxY - next.size.height

        next.origin.x = maxX >= bounds.minX ? min(max(next.origin.x, bounds.minX), maxX) : bounds.minX
        next.origin.y = maxY >= bounds.minY ? min(max(next.origin.y, bounds.minY), maxY) : bounds.minY

        next.origin.x = round(next.origin.x)
        next.origin.y = round(next.origin.y)
        return next
    }

    // MARK: - NSWindowDelegate

    func windowWillClose(_: Notification) {
        self.onVisibilityChanged?(false)
    }

    func windowDidMove(_: Notification) {
        self.persistFrameIfPanel()
    }

    func windowDidEndLiveResize(_: Notification) {
        self.persistFrameIfPanel()
    }

    func persistFrameIfPanel() {
        guard case .panel = self.presentation, let window else { return }
        Self.storeRestoredFrame(window.frame, sessionKey: self.sessionKey)
    }
}
