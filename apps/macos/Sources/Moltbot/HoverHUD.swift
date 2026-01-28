import AppKit
import Observation
import QuartzCore
import SwiftUI

/// Hover-only HUD anchored to the menu bar item. Click expands into full Web Chat.
@MainActor
@Observable
final class HoverHUDController {
    static let shared = HoverHUDController()

    struct Model {
        var isVisible: Bool = false
        var isSuppressed: Bool = false
        var hoveringStatusItem: Bool = false
        var hoveringPanel: Bool = false
    }

    private(set) var model = Model()

    private var window: NSPanel?
    private var hostingView: NSHostingView<HoverHUDView>?
    private var dismissMonitor: Any?
    private var dismissTask: Task<Void, Never>?
    private var showTask: Task<Void, Never>?
    private var anchorProvider: (() -> NSRect?)?

    private let width: CGFloat = 360
    private let height: CGFloat = 74
    private let padding: CGFloat = 8
    private let hoverShowDelay: TimeInterval = 0.18

    func setSuppressed(_ suppressed: Bool) {
        self.model.isSuppressed = suppressed
        if suppressed {
            self.showTask?.cancel()
            self.showTask = nil
            self.dismiss(reason: "suppressed")
        }
    }

    func statusItemHoverChanged(inside: Bool, anchorProvider: @escaping () -> NSRect?) {
        self.model.hoveringStatusItem = inside
        self.anchorProvider = anchorProvider

        guard !self.model.isSuppressed else { return }

        if inside {
            self.dismissTask?.cancel()
            self.dismissTask = nil
            self.showTask?.cancel()
            self.showTask = Task { [weak self] in
                guard let self else { return }
                try? await Task.sleep(nanoseconds: UInt64(self.hoverShowDelay * 1_000_000_000))
                await MainActor.run { [weak self] in
                    guard let self else { return }
                    guard !Task.isCancelled else { return }
                    guard self.model.hoveringStatusItem else { return }
                    guard !self.model.isSuppressed else { return }
                    self.present()
                }
            }
        } else {
            self.showTask?.cancel()
            self.showTask = nil
            self.scheduleDismiss()
        }
    }

    func panelHoverChanged(inside: Bool) {
        self.model.hoveringPanel = inside
        if inside {
            self.dismissTask?.cancel()
            self.dismissTask = nil
        } else if !self.model.hoveringStatusItem {
            self.scheduleDismiss()
        }
    }

    func openChat() {
        guard let anchorProvider = self.anchorProvider else { return }
        self.dismiss(reason: "openChat")
        Task { @MainActor in
            let sessionKey = await WebChatManager.shared.preferredSessionKey()
            WebChatManager.shared.togglePanel(sessionKey: sessionKey, anchorProvider: anchorProvider)
        }
    }

    func dismiss(reason: String = "explicit") {
        self.dismissTask?.cancel()
        self.dismissTask = nil
        self.removeDismissMonitor()
        guard let window else {
            self.model.isVisible = false
            return
        }

        if !self.model.isVisible {
            window.orderOut(nil)
            return
        }

        let target = window.frame.offsetBy(dx: 0, dy: 6)
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.14
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

    private func scheduleDismiss() {
        self.dismissTask?.cancel()
        self.dismissTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            await MainActor.run {
                guard let self else { return }
                if self.model.hoveringStatusItem || self.model.hoveringPanel { return }
                self.dismiss(reason: "hoverExit")
            }
        }
    }

    private func present() {
        guard !self.model.isSuppressed else { return }
        self.ensureWindow()
        self.hostingView?.rootView = HoverHUDView(controller: self)
        let target = self.targetFrame()

        guard let window else { return }
        self.installDismissMonitor()

        if !self.model.isVisible {
            self.model.isVisible = true
            let start = target.offsetBy(dx: 0, dy: 8)
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
            window.orderFrontRegardless()
            self.updateWindowFrame(animate: true)
        }
    }

    private func ensureWindow() {
        if self.window != nil { return }
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: self.width, height: self.height),
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

        let host = NSHostingView(rootView: HoverHUDView(controller: self))
        host.translatesAutoresizingMaskIntoConstraints = false
        panel.contentView = host
        self.hostingView = host
        self.window = panel
    }

    private func targetFrame() -> NSRect {
        guard let anchor = self.anchorProvider?() else {
            return WindowPlacement.topRightFrame(
                size: NSSize(width: self.width, height: self.height),
                padding: self.padding)
        }

        let screen = NSScreen.screens.first { screen in
            screen.frame.contains(anchor.origin) || screen.frame.contains(NSPoint(x: anchor.midX, y: anchor.midY))
        } ?? NSScreen.main

        let bounds = (screen?.visibleFrame ?? .zero).insetBy(dx: self.padding, dy: self.padding)
        return WindowPlacement.anchoredBelowFrame(
            size: NSSize(width: self.width, height: self.height),
            anchor: anchor,
            padding: self.padding,
            in: bounds)
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

    private func installDismissMonitor() {
        if ProcessInfo.processInfo.isRunningTests { return }
        guard self.dismissMonitor == nil, let window else { return }
        self.dismissMonitor = NSEvent.addGlobalMonitorForEvents(matching: [
            .leftMouseDown,
            .rightMouseDown,
            .otherMouseDown,
        ]) { [weak self] _ in
            guard let self, self.model.isVisible else { return }
            let pt = NSEvent.mouseLocation
            if !window.frame.contains(pt) {
                Task { @MainActor in self.dismiss(reason: "outsideClick") }
            }
        }
    }

    private func removeDismissMonitor() {
        if let monitor = self.dismissMonitor {
            NSEvent.removeMonitor(monitor)
            self.dismissMonitor = nil
        }
    }
}

private struct HoverHUDView: View {
    var controller: HoverHUDController
    private let activityStore = WorkActivityStore.shared

    private var statusTitle: String {
        if self.activityStore.iconState.isWorking { return "Working" }
        return "Idle"
    }

    private var detail: String {
        if let current = self.activityStore.current?.label, !current.isEmpty { return current }
        if let last = self.activityStore.lastToolLabel, !last.isEmpty { return last }
        return "No recent activity"
    }

    private var symbolName: String {
        if self.activityStore.iconState.isWorking {
            return self.activityStore.iconState.badgeSymbolName
        }
        return "moon.zzz.fill"
    }

    private var dotColor: Color {
        if self.activityStore.iconState.isWorking {
            return Color(nsColor: NSColor.systemGreen.withAlphaComponent(0.7))
        }
        return .secondary
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(self.dotColor)
                .frame(width: 7, height: 7)
                .padding(.top, 5)

            VStack(alignment: .leading, spacing: 4) {
                Text(self.statusTitle)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.primary)
                Text(self.detail)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .truncationMode(.middle)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 8)

            Image(systemName: self.symbolName)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.secondary)
                .padding(.top, 1)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(.regularMaterial))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Color.black.opacity(0.10), lineWidth: 1))
        .contentShape(Rectangle())
        .onHover { inside in
            self.controller.panelHoverChanged(inside: inside)
        }
        .onTapGesture {
            self.controller.openChat()
        }
    }
}
