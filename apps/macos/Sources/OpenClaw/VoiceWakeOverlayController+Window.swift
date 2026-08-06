import AppKit
import QuartzCore
import SwiftUI

extension VoiceWakeOverlayController {
    func present() {
        if !self.enableUI || ProcessInfo.processInfo.isRunningTests {
            if !self.model.isVisible {
                self.model.isVisible = true
            }
            return
        }
        self.ensureWindow()
        self.hostingView?.rootView = VoiceWakeOverlayView(controller: self)
        let target = self.targetFrame()
        let isFirst = !self.model.isVisible
        if isFirst { self.model.isVisible = true }
        OverlayPanelFactory.present(
            window: self.window,
            isFirstPresent: isFirst,
            target: target,
            onFirstPresent: {
                self.logger.log(
                    level: .info,
                    "overlay present windowShown textLen=\(self.model.text.count, privacy: .public)")
                // Keep the status item in “listening” mode until we explicitly dismiss the overlay.
                AppStateStore.shared.triggerVoiceEars(ttl: nil)
            },
            onAlreadyVisible: { window in
                self.updateWindowFrame(animate: true)
                window.orderFrontRegardless()
            })
    }

    private func ensureWindow() {
        if self.window != nil { return }
        let borderPad = self.closeOverflow
        let panel = OverlayPanelFactory.makePanel(
            contentRect: NSRect(x: 0, y: 0, width: self.width + borderPad * 2, height: 60 + borderPad * 2),
            level: Self.preferredWindowLevel,
            hasShadow: false)

        let host = NSHostingView(rootView: VoiceWakeOverlayView(controller: self))
        host.translatesAutoresizingMaskIntoConstraints = false
        panel.contentView = host
        self.hostingView = host
        self.window = panel
    }

    /// Reassert window ordering when other panels are shown.
    func bringToFrontIfVisible() {
        guard self.model.isVisible, let window = self.window else { return }
        window.level = Self.preferredWindowLevel
        window.orderFrontRegardless()
    }

    func targetFrame() -> NSRect {
        guard let screen = NSScreen.main else { return .zero }
        let height = self.measuredHeight()
        let size = NSSize(width: self.width + self.closeOverflow * 2, height: height + self.closeOverflow * 2)
        let visible = screen.visibleFrame
        let origin = CGPoint(
            x: visible.maxX - size.width,
            y: visible.maxY - size.height)
        return NSRect(origin: origin, size: size)
    }

    func updateWindowFrame(animate: Bool = false) {
        OverlayPanelFactory.applyFrame(window: self.window, target: self.targetFrame(), animate: animate)
    }

    func measuredHeight() -> CGFloat {
        let attributed = self.model.attributed.length > 0 ? self.model.attributed : self
            .makeAttributed(from: self.model.text)
        let maxWidth = self.width - (self.padding * 2) - self.spacing - self.buttonWidth

        let textInset = NSSize(width: 2, height: 6)
        let lineFragmentPadding: CGFloat = 0
        let containerWidth = max(1, maxWidth - (textInset.width * 2) - (lineFragmentPadding * 2))

        let storage = NSTextStorage(attributedString: attributed)
        let container = NSTextContainer(containerSize: CGSize(width: containerWidth, height: .greatestFiniteMagnitude))
        container.lineFragmentPadding = lineFragmentPadding
        container.lineBreakMode = .byWordWrapping

        let layout = NSLayoutManager()
        layout.addTextContainer(container)
        storage.addLayoutManager(layout)

        _ = layout.glyphRange(for: container)
        let used = layout.usedRect(for: container)

        let contentHeight = ceil(used.height + (textInset.height * 2))
        let total = contentHeight + self.verticalPadding * 2
        // Defer the overflow state mutation to break the SwiftUI onChange → measuredHeight →
        // isOverflowing → re-render → onChange synchronous render loop (fixes #43480).
        let overflowing = total > self.maxHeight
        DispatchQueue.main.async { [weak self] in
            guard let self, self.model.isOverflowing != overflowing else { return }
            self.model.isOverflowing = overflowing
        }
        return max(self.minHeight, min(total, self.maxHeight))
    }

    func dismissTargetFrame(for frame: NSRect, reason: DismissReason, outcome: SendOutcome) -> NSRect? {
        switch (reason, outcome) {
        case (.empty, _):
            let scale: CGFloat = 0.95
            let newSize = NSSize(width: frame.size.width * scale, height: frame.size.height * scale)
            let dx = (frame.size.width - newSize.width) / 2
            let dy = (frame.size.height - newSize.height) / 2
            return NSRect(x: frame.origin.x + dx, y: frame.origin.y + dy, width: newSize.width, height: newSize.height)
        case (.explicit, .sent):
            return frame.offsetBy(dx: 8, dy: 6)
        default:
            return frame
        }
    }
}
