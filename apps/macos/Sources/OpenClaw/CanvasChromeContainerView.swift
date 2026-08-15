import AppKit
import QuartzCore

final class HoverChromeContainerView: NSView {
    private let content: NSView
    private let chrome: CanvasChromeOverlayView
    private var tracking: NSTrackingArea?
    var onClose: (() -> Void)?

    init(containing content: NSView) {
        self.content = content
        self.chrome = CanvasChromeOverlayView(frame: .zero)
        super.init(frame: .zero)

        self.wantsLayer = true
        self.layer?.cornerRadius = 12
        self.layer?.masksToBounds = true
        self.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor

        self.content.translatesAutoresizingMaskIntoConstraints = false
        self.addSubview(self.content)

        self.chrome.translatesAutoresizingMaskIntoConstraints = false
        self.chrome.alphaValue = 0
        self.chrome.onClose = { [weak self] in self?.onClose?() }
        self.addSubview(self.chrome)

        NSLayoutConstraint.activate([
            self.content.leadingAnchor.constraint(equalTo: self.leadingAnchor),
            self.content.trailingAnchor.constraint(equalTo: self.trailingAnchor),
            self.content.topAnchor.constraint(equalTo: self.topAnchor),
            self.content.bottomAnchor.constraint(equalTo: self.bottomAnchor),

            self.chrome.leadingAnchor.constraint(equalTo: self.leadingAnchor),
            self.chrome.trailingAnchor.constraint(equalTo: self.trailingAnchor),
            self.chrome.topAnchor.constraint(equalTo: self.topAnchor),
            self.chrome.bottomAnchor.constraint(equalTo: self.bottomAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking {
            self.removeTrackingArea(tracking)
        }
        let area = NSTrackingArea(
            rect: self.bounds,
            options: [.activeAlways, .mouseEnteredAndExited, .inVisibleRect],
            owner: self,
            userInfo: nil)
        self.addTrackingArea(area)
        self.tracking = area
    }

    private final class CanvasDragHandleView: NSView {
        override func mouseDown(with event: NSEvent) {
            self.window?.performDrag(with: event)
        }

        override func acceptsFirstMouse(for _: NSEvent?) -> Bool {
            true
        }
    }

    private final class CanvasResizeHandleView: NSView {
        private var startPoint: NSPoint = .zero
        private var startFrame: NSRect = .zero

        override func acceptsFirstMouse(for _: NSEvent?) -> Bool {
            true
        }

        override func mouseDown(with event: NSEvent) {
            guard let window else { return }
            _ = window.makeFirstResponder(self)
            self.startPoint = NSEvent.mouseLocation
            self.startFrame = window.frame
            super.mouseDown(with: event)
        }

        override func mouseDragged(with _: NSEvent) {
            guard let window else { return }
            let current = NSEvent.mouseLocation
            let dx = current.x - self.startPoint.x
            let dy = current.y - self.startPoint.y

            var frame = self.startFrame
            frame.size.width = max(CanvasLayout.minPanelSize.width, frame.size.width + dx)
            frame.origin.y += dy
            frame.size.height = max(CanvasLayout.minPanelSize.height, frame.size.height - dy)

            if let screen = window.screen {
                frame = CanvasWindowController.constrainFrame(frame, toVisibleFrame: screen.visibleFrame)
            }
            window.setFrame(frame, display: true)
        }
    }

    private final class CanvasChromeOverlayView: NSView {
        var onClose: (() -> Void)?

        private let dragHandle = CanvasDragHandleView(frame: .zero)
        private let resizeHandle = CanvasResizeHandleView(frame: .zero)

        private final class PassthroughVisualEffectView: NSVisualEffectView {
            override func hitTest(_: NSPoint) -> NSView? {
                nil
            }
        }

        private let closeBackground: NSVisualEffectView = {
            let v = PassthroughVisualEffectView(frame: .zero)
            v.material = .hudWindow
            v.blendingMode = .withinWindow
            v.state = .active
            v.appearance = NSAppearance(named: .vibrantDark)
            v.wantsLayer = true
            v.layer?.cornerRadius = 10
            v.layer?.masksToBounds = true
            v.layer?.borderWidth = 1
            v.layer?.borderColor = NSColor.white.withAlphaComponent(0.22).cgColor
            v.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.28).cgColor
            v.layer?.shadowColor = NSColor.black.withAlphaComponent(0.35).cgColor
            v.layer?.shadowOpacity = 0.35
            v.layer?.shadowRadius = 8
            v.layer?.shadowOffset = .zero
            return v
        }()

        private let closeButton: NSButton = {
            let cfg = NSImage.SymbolConfiguration(pointSize: 8, weight: .semibold)
            let img = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Close")?
                .withSymbolConfiguration(cfg)
                ?? NSImage(size: NSSize(width: 18, height: 18))
            let btn = NSButton(image: img, target: nil, action: nil)
            btn.isBordered = false
            btn.bezelStyle = .regularSquare
            btn.imageScaling = .scaleProportionallyDown
            btn.contentTintColor = NSColor.white.withAlphaComponent(0.92)
            btn.toolTip = "Close"
            return btn
        }()

        override init(frame frameRect: NSRect) {
            super.init(frame: frameRect)

            self.wantsLayer = true
            self.layer?.cornerRadius = 12
            self.layer?.masksToBounds = true
            self.layer?.borderWidth = 1
            self.layer?.borderColor = NSColor.black.withAlphaComponent(0.18).cgColor
            self.layer?.backgroundColor = NSColor.black.withAlphaComponent(0.02).cgColor

            self.dragHandle.translatesAutoresizingMaskIntoConstraints = false
            self.dragHandle.wantsLayer = true
            self.dragHandle.layer?.backgroundColor = NSColor.clear.cgColor
            self.addSubview(self.dragHandle)

            self.resizeHandle.translatesAutoresizingMaskIntoConstraints = false
            self.resizeHandle.wantsLayer = true
            self.resizeHandle.layer?.backgroundColor = NSColor.clear.cgColor
            self.addSubview(self.resizeHandle)

            self.closeBackground.translatesAutoresizingMaskIntoConstraints = false
            self.addSubview(self.closeBackground)

            self.closeButton.translatesAutoresizingMaskIntoConstraints = false
            self.closeButton.target = self
            self.closeButton.action = #selector(self.handleClose)
            self.addSubview(self.closeButton)

            NSLayoutConstraint.activate([
                self.dragHandle.leadingAnchor.constraint(equalTo: self.leadingAnchor),
                self.dragHandle.trailingAnchor.constraint(equalTo: self.trailingAnchor),
                self.dragHandle.topAnchor.constraint(equalTo: self.topAnchor),
                self.dragHandle.heightAnchor.constraint(equalToConstant: 30),

                self.closeBackground.centerXAnchor.constraint(equalTo: self.closeButton.centerXAnchor),
                self.closeBackground.centerYAnchor.constraint(equalTo: self.closeButton.centerYAnchor),
                self.closeBackground.widthAnchor.constraint(equalToConstant: 20),
                self.closeBackground.heightAnchor.constraint(equalToConstant: 20),

                self.closeButton.trailingAnchor.constraint(equalTo: self.trailingAnchor, constant: -8),
                self.closeButton.topAnchor.constraint(equalTo: self.topAnchor, constant: 8),
                self.closeButton.widthAnchor.constraint(equalToConstant: 16),
                self.closeButton.heightAnchor.constraint(equalToConstant: 16),

                self.resizeHandle.trailingAnchor.constraint(equalTo: self.trailingAnchor),
                self.resizeHandle.bottomAnchor.constraint(equalTo: self.bottomAnchor),
                self.resizeHandle.widthAnchor.constraint(equalToConstant: 18),
                self.resizeHandle.heightAnchor.constraint(equalToConstant: 18),
            ])
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) {
            fatalError("init(coder:) is not supported")
        }

        override func hitTest(_ point: NSPoint) -> NSView? {
            // When the chrome is hidden, do not intercept any mouse events (let the WKWebView receive them).
            guard self.alphaValue > 0.02 else { return nil }

            if self.closeButton.frame.contains(point) { return self.closeButton }
            if self.dragHandle.frame.contains(point) { return self.dragHandle }
            if self.resizeHandle.frame.contains(point) { return self.resizeHandle }
            return nil
        }

        @objc private func handleClose() {
            self.onClose?()
        }
    }

    override func mouseEntered(with _: NSEvent) {
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.12
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            self.chrome.animator().alphaValue = 1
        }
    }

    override func mouseExited(with _: NSEvent) {
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.16
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            self.chrome.animator().alphaValue = 0
        }
    }
}
