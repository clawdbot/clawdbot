import AppKit
import Observation
import QuartzCore
import SwiftUI

/// Lightweight, borderless panel for in-app "toast" notifications (bypasses macOS Notification Center).
@MainActor
@Observable
final class NotifyOverlayController {
    static let shared = NotifyOverlayController()

    private(set) var model = Model()
    var isVisible: Bool { self.model.isVisible }

    struct Model {
        var title: String = ""
        var body: String = ""
        var isVisible: Bool = false
    }

    private var window: NSPanel?
    private var hostingView: NSHostingView<NotifyOverlayView>?
    private var dismissTask: Task<Void, Never>?

    private let width: CGFloat = 360
    private let padding: CGFloat = 12
    private let maxHeight: CGFloat = 220
    private let minHeight: CGFloat = 64

    func present(title: String, body: String, autoDismissAfter: TimeInterval = 6) {
        self.dismissTask?.cancel()
        self.model.title = title
        self.model.body = body
        self.ensureWindow()
        self.hostingView?.rootView = NotifyOverlayView(controller: self)
        self.presentWindow()

        if autoDismissAfter > 0 {
            self.dismissTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(autoDismissAfter * 1_000_000_000))
                await MainActor.run { self?.dismiss() }
            }
        }
    }

    func dismiss() {
        self.dismissTask?.cancel()
        self.dismissTask = nil
        guard let window else { return }

        let target = window.frame.offsetBy(dx: 8, dy: 6)
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.16
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            window.animator().setFrame(target, display: true)
            window.animator().alphaValue = 0
        } completionHandler: {
            Task { @MainActor in
                window.orderOut(nil)
                self.model.isVisible = false
            }
        }
    }

    // MARK: - Private

    private func presentWindow() {
        self.ensureWindow()
        self.hostingView?.rootView = NotifyOverlayView(controller: self)
        let target = self.targetFrame()

        guard let window else { return }
        if !self.model.isVisible {
            self.model.isVisible = true
            let start = target.offsetBy(dx: 0, dy: -6)
            window.setFrame(start, display: true)
            window.alphaValue = 0
            window.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.18
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                window.animator().setFrame(target, display: true)
                window.animator().alphaValue = 1
            }
        } else {
            self.updateWindowFrame(animate: true)
            window.orderFrontRegardless()
        }
    }

    private func ensureWindow() {
        if self.window != nil { return }
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: self.width, height: self.minHeight),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.hidesOnDeactivate = false
        panel.isMovable = false
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = true
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true

        let host = NSHostingView(rootView: NotifyOverlayView(controller: self))
        host.translatesAutoresizingMaskIntoConstraints = false
        panel.contentView = host
        self.hostingView = host
        self.window = panel
    }

    private func targetFrame() -> NSRect {
        guard let screen = NSScreen.main else { return .zero }
        let height = self.measuredHeight()
        let size = NSSize(width: self.width, height: height)
        let visible = screen.visibleFrame
        let origin = CGPoint(x: visible.maxX - size.width - 8, y: visible.maxY - size.height - 8)
        return NSRect(origin: origin, size: size)
    }

    private func updateWindowFrame(animate: Bool = false) {
        guard let window else { return }
        let frame = self.targetFrame()
        if animate {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.12
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                window.animator().setFrame(frame, display: true)
            }
        } else {
            window.setFrame(frame, display: true)
        }
    }

    private func measuredHeight() -> CGFloat {
        let maxWidth = self.width - self.padding * 2
        let titleFont = NSFont.systemFont(ofSize: 13, weight: .semibold)
        let bodyFont = NSFont.systemFont(ofSize: 12, weight: .regular)

        let titleRect = (self.model.title as NSString).boundingRect(
            with: CGSize(width: maxWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: titleFont],
            context: nil)

        let bodyRect = (self.model.body as NSString).boundingRect(
            with: CGSize(width: maxWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: bodyFont],
            context: nil)

        let contentHeight = ceil(titleRect.height + 6 + bodyRect.height)
        let total = contentHeight + self.padding * 2
        return max(self.minHeight, min(total, self.maxHeight))
    }
}

private struct NotifyOverlayView: View {
    var controller: NotifyOverlayController

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(self.controller.model.title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.primary)
                .lineLimit(1)

            Text(self.controller.model.body)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .lineLimit(4)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(.regularMaterial))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.black.opacity(0.08), lineWidth: 1))
        .onTapGesture {
            self.controller.dismiss()
        }
    }
}
