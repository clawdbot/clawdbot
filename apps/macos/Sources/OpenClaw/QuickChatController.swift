import AppKit
import KeyboardShortcuts
import Observation
import SwiftUI

private let quickChatLogger = Logger(subsystem: "ai.openclaw", category: "quickchat")

private final class QuickChatPanel: NSPanel {
    /// Quick Chat must accept typing without behaving like a normal activating app window.
    override var canBecomeKey: Bool {
        true
    }
}

@MainActor
private final class QuickChatAgentMenuTarget: NSObject {
    let onSelect: (String) -> Void

    init(onSelect: @escaping (String) -> Void) {
        self.onSelect = onSelect
    }

    @objc func selectAgent(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        self.onSelect(id)
    }
}

@MainActor
@Observable
final class QuickChatController: NSObject, NSWindowDelegate {
    typealias GlobalMonitorInstaller = (NSEvent.EventTypeMask, @escaping (NSEvent) -> Void) -> Any?
    typealias LocalMonitorInstaller = (NSEvent.EventTypeMask, @escaping (NSEvent) -> NSEvent?) -> Any?
    typealias MonitorClearer = (inout Any?) -> Void
    typealias HotkeyRegistrar = (@escaping () -> Void) -> Void
    typealias HotkeyRemover = () -> Void
    typealias ChatOpener = @MainActor (_ sessionKey: String?, _ agentID: String?) -> Void

    static let shared = QuickChatController()

    private(set) var isVisible = false
    private(set) var isEnabled = true

    @ObservationIgnored let model: QuickChatModel
    @ObservationIgnored private let enableUI: Bool
    @ObservationIgnored private let monitoringEnabled: Bool
    @ObservationIgnored private let globalMonitorInstaller: GlobalMonitorInstaller
    @ObservationIgnored private let localMonitorInstaller: LocalMonitorInstaller
    @ObservationIgnored private let monitorClearer: MonitorClearer
    @ObservationIgnored private let hotkeyRegistrar: HotkeyRegistrar
    @ObservationIgnored private let hotkeyRemover: HotkeyRemover
    @ObservationIgnored private let chatOpener: ChatOpener
    @ObservationIgnored private let allowsHotkeyRegistrationInTests: Bool
    @ObservationIgnored private var panel: QuickChatPanel?
    @ObservationIgnored private var hostingView: NSHostingView<QuickChatView>?
    @ObservationIgnored private weak var textView: NSTextView?
    @ObservationIgnored private var globalMonitor: Any?
    @ObservationIgnored private var localMonitor: Any?
    @ObservationIgnored private var presentationTask: Task<Void, Never>?
    @ObservationIgnored private var visibleFrame = NSRect.zero
    @ObservationIgnored private var contentHeight: CGFloat = 58
    @ObservationIgnored private var transitionID = UUID()
    @ObservationIgnored private var isStarted = false
    @ObservationIgnored private var hotkeyRegistered = false
    @ObservationIgnored private var windowPicker: QuickChatWindowPicker?
    @ObservationIgnored private var isAgentMenuActive = false

    init(
        enableUI: Bool = true,
        model: QuickChatModel? = nil,
        monitoringEnabled: Bool? = nil,
        globalMonitorInstaller: @escaping GlobalMonitorInstaller = { mask, handler in
            NSEvent.addGlobalMonitorForEvents(matching: mask, handler: handler)
        },
        localMonitorInstaller: @escaping LocalMonitorInstaller = { mask, handler in
            NSEvent.addLocalMonitorForEvents(matching: mask, handler: handler)
        },
        monitorClearer: @escaping MonitorClearer = { monitor in
            OverlayPanelFactory.clearGlobalEventMonitor(&monitor)
        },
        hotkeyRegistrar: @escaping HotkeyRegistrar = { handler in
            KeyboardShortcuts.onKeyUp(for: .toggleQuickChat, action: handler)
        },
        hotkeyRemover: @escaping HotkeyRemover = {
            KeyboardShortcuts.removeHandler(for: .toggleQuickChat)
        },
        chatOpener: @escaping ChatOpener = { sessionKey, agentID in
            AppNavigationActions.openChat(sessionKey: sessionKey, agentID: agentID)
        },
        allowsHotkeyRegistrationInTests: Bool = false)
    {
        self.enableUI = enableUI
        self.model = model ?? QuickChatModel()
        self.monitoringEnabled = monitoringEnabled ?? (enableUI && !ProcessInfo.processInfo.isRunningTests)
        self.globalMonitorInstaller = globalMonitorInstaller
        self.localMonitorInstaller = localMonitorInstaller
        self.monitorClearer = monitorClearer
        self.hotkeyRegistrar = hotkeyRegistrar
        self.hotkeyRemover = hotkeyRemover
        self.chatOpener = chatOpener
        self.allowsHotkeyRegistrationInTests = allowsHotkeyRegistrationInTests
        super.init()
    }

    func start() {
        guard !self.isStarted else { return }
        self.isStarted = true
        self.setEnabled(AppStateStore.shared.quickChatEnabled)
    }

    func setEnabled(_ enabled: Bool) {
        self.isEnabled = enabled
        if enabled {
            self.registerHotkeyIfNeeded()
            return
        }
        self.unregisterHotkeyIfNeeded()
        self.dismiss(immediate: false)
    }

    private func registerHotkeyIfNeeded() {
        guard self.isStarted, !self.hotkeyRegistered else { return }
        guard !ProcessInfo.processInfo.isRunningTests || self.allowsHotkeyRegistrationInTests else { return }
        self.hotkeyRegistrar { [weak self] in
            Task { @MainActor in
                self?.toggle()
            }
        }
        self.hotkeyRegistered = true
        quickChatLogger.info("quick chat hotkey handler registered")
    }

    private func unregisterHotkeyIfNeeded() {
        guard self.hotkeyRegistered else { return }
        self.hotkeyRemover()
        self.hotkeyRegistered = false
    }

    func stop() {
        self.unregisterHotkeyIfNeeded()
        self.isStarted = false
        self.dismiss(immediate: true)
        self.model.cancelAllTasks()
        self.panel?.delegate = nil
        self.panel = nil
        self.hostingView = nil
        self.textView = nil
    }

    func toggle() {
        guard self.isEnabled else { return }
        if self.isVisible {
            self.dismiss()
        } else {
            self.present()
        }
    }

    func present() {
        guard self.isEnabled else { return }
        self.transitionID = UUID()
        let presentationID = self.model.beginPresentation()
        self.presentationTask?.cancel()
        self.presentationTask = Task { [weak self] in
            guard let self else { return }
            await self.model.refreshForPresentation(id: presentationID)
        }
        let wasVisible = self.isVisible
        self.isVisible = true
        self.installDismissMonitors()
        guard self.enableUI, !ProcessInfo.processInfo.isRunningTests else { return }

        self.visibleFrame = self.cursorScreen()?.visibleFrame ?? .zero
        self.ensurePanel()
        let target = self.targetFrame()
        quickChatLogger.info(
            "quick chat present visible=\(NSStringFromRect(self.visibleFrame)) target=\(NSStringFromRect(target))")
        guard let panel = self.panel else { return }
        panel.alphaValue = 1
        if wasVisible {
            OverlayPanelFactory.applyFrame(window: panel, target: target, animate: true)
            panel.makeKeyAndOrderFront(nil)
        } else {
            let start = QuickChatPlacement.scaledRect(target, factor: 0.96)
            OverlayPanelFactory.animatePresent(window: panel, from: start, to: target, duration: 0.16)
            panel.makeKeyAndOrderFront(nil)
        }
        self.focusEditor()
    }

    func dismiss() {
        self.dismiss(immediate: false)
    }

    func windowDidResignKey(_: Notification) {
        guard self.isVisible else { return }
        // System permission dialogs steal key focus mid-grant; the bar must survive that flow.
        guard !self.model.isGrantingPermissions,
              self.windowPicker?.isInteractionActive != true,
              !self.isAgentMenuActive
        else { return }
        self.dismiss()
    }

    private func dismiss(immediate: Bool) {
        if self.isVisible {
            quickChatLogger.info("quick chat dismiss immediate=\(immediate)")
        }
        self.windowPicker?.cancel()
        self.presentationTask?.cancel()
        self.presentationTask = nil
        self.model.endPresentation()
        self.removeDismissMonitors()
        guard self.isVisible else {
            if immediate { self.panel?.orderOut(nil) }
            return
        }
        self.isVisible = false
        let dismissalID = UUID()
        self.transitionID = dismissalID
        guard self.enableUI, let panel = self.panel, !immediate else {
            self.panel?.orderOut(nil)
            return
        }
        let target = QuickChatPlacement.scaledRect(panel.frame, factor: 0.97)
        OverlayPanelFactory.animateDismissAndHide(
            window: panel,
            to: target,
            duration: 0.12)
        { [weak self, weak panel] in
            guard let self, let panel else { return }
            if self.transitionID != dismissalID, self.isVisible {
                panel.alphaValue = 1
                panel.setFrame(self.targetFrame(), display: true)
                panel.makeKeyAndOrderFront(nil)
                self.focusEditor()
            }
        }
    }

    private func ensurePanel() {
        guard self.panel == nil else { return }
        let panel = QuickChatPanel(
            contentRect: NSRect(x: 0, y: 0, width: 620, height: self.contentHeight),
            styleMask: [.nonactivatingPanel, .borderless],
            backing: .buffered,
            defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        panel.hidesOnDeactivate = false
        panel.isMovable = false
        panel.isFloatingPanel = true
        panel.becomesKeyOnlyIfNeeded = false
        panel.delegate = self

        let view = self.makeView()
        let host = NSHostingView(rootView: view)
        panel.contentView = host
        self.panel = panel
        self.hostingView = host
    }

    private func makeView() -> QuickChatView {
        QuickChatView(
            model: self.model,
            onDismiss: { [weak self] in self?.dismiss() },
            onSendAccepted: { [weak self] openChat in
                self?.handleSendAccepted(openChat: openChat)
            },
            onShowAgentPicker: { [weak self] in
                self?.showAgentPicker()
            },
            onWindowScreenshot: { [weak self] in
                self?.startWindowPicker()
            },
            onContentHeightChange: { [weak self] height in
                self?.updateContentHeight(height)
            },
            onTextViewReady: { [weak self] textView in
                self?.textView = textView
                self?.focusEditor()
            })
    }

    private func handleSendAccepted(openChat: Bool) {
        // Command-Return must open the immutable route that accepted the send,
        // not live model routing state that may already have changed.
        let route = self.model.lastAcceptedRoute
        self.dismiss()
        guard openChat else { return }
        if let route, !route.sessionKey.isEmpty {
            self.chatOpener(route.sessionKey, route.agentID)
        } else {
            self.chatOpener(nil, nil)
        }
    }

    private func updateContentHeight(_ height: CGFloat) {
        let resolved = max(1, ceil(height))
        guard abs(resolved - self.contentHeight) > 0.5 else { return }
        self.contentHeight = resolved
        guard self.isVisible else { return }
        OverlayPanelFactory.applyFrame(window: self.panel, target: self.targetFrame(), animate: true)
    }

    private func targetFrame() -> NSRect {
        QuickChatPlacement.barFrame(
            contentSize: NSSize(width: 620, height: self.contentHeight),
            visibleFrame: self.visibleFrame)
    }

    private func cursorScreen() -> NSScreen? {
        let cursor = NSEvent.mouseLocation
        return NSScreen.screens.first(where: { $0.frame.contains(cursor) }) ?? NSScreen.main
    }

    private func focusEditor() {
        guard self.isVisible, let panel = self.panel, let textView = self.textView else { return }
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(textView)
        DispatchQueue.main.async { [weak self, weak panel, weak textView] in
            guard let self, self.isVisible, let panel, let textView else { return }
            panel.makeFirstResponder(textView)
        }
    }

    private func installDismissMonitors() {
        guard self.monitoringEnabled, self.globalMonitor == nil, self.localMonitor == nil else { return }
        let mouseEvents: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        // Global and local monitors are paired because global monitors omit this app's clicks.
        self.globalMonitor = self.globalMonitorInstaller(mouseEvents) { [weak self] _ in
            let point = NSEvent.mouseLocation
            Task { @MainActor in self?.dismissIfClickOutside(at: point) }
        }
        self.localMonitor = self.localMonitorInstaller(mouseEvents) { [weak self] event in
            let point = NSEvent.mouseLocation
            Task { @MainActor in self?.dismissIfClickOutside(at: point) }
            return event
        }
    }

    private func dismissIfClickOutside(at point: NSPoint) {
        guard self.isVisible,
              !self.model.isGrantingPermissions,
              self.windowPicker?.isInteractionActive != true,
              !self.isAgentMenuActive,
              let panel = self.panel
        else { return }
        if !panel.frame.contains(point) {
            self.dismiss()
        }
    }

    private func showAgentPicker() {
        guard self.model.agents.count > 1,
              let panel,
              let contentView = panel.contentView
        else { return }

        self.isAgentMenuActive = true
        self.removeDismissMonitors()
        defer {
            self.isAgentMenuActive = false
            if self.isVisible { self.installDismissMonitors() }
            self.focusEditor()
        }

        let target = QuickChatAgentMenuTarget { [weak self] id in
            self?.model.selectAgent(id)
        }
        let menu = NSMenu()
        for agent in self.model.agents {
            let title = agent.emoji.map { "\($0) \(agent.name)" } ?? agent.name
            let item = NSMenuItem(
                title: title,
                action: #selector(QuickChatAgentMenuTarget.selectAgent(_:)),
                keyEquivalent: "")
            item.target = target
            item.representedObject = agent.id
            item.state = agent.id == self.model.selectedAgentID ? .on : .off
            menu.addItem(item)
        }
        let windowPoint = panel.convertPoint(fromScreen: NSEvent.mouseLocation)
        let contentPoint = contentView.convert(windowPoint, from: nil)
        menu.popUp(positioning: nil, at: contentPoint, in: contentView)
    }

    private func startWindowPicker() {
        guard self.isVisible, self.model.canCaptureWindow else { return }
        if self.windowPicker == nil {
            self.windowPicker = QuickChatWindowPicker(
                model: self.model,
                onInteractionChanged: { [weak self] active in
                    self?.pickerInteractionChanged(active)
                },
                onSendAccepted: { [weak self] in
                    self?.dismiss()
                })
        }
        guard let windowPicker = self.windowPicker else { return }
        Task { await windowPicker.begin() }
    }

    private func pickerInteractionChanged(_ active: Bool) {
        if active {
            self.removeDismissMonitors()
        } else if self.isVisible {
            self.installDismissMonitors()
        }
        guard let panel else { return }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.12
            panel.animator().alphaValue = active ? 0.35 : 1
        } completionHandler: { [weak self] in
            Task { @MainActor in
                if active == false { self?.focusEditor() }
            }
        }
    }

    private func removeDismissMonitors() {
        self.monitorClearer(&self.globalMonitor)
        self.monitorClearer(&self.localMonitor)
    }

    #if DEBUG
    var hasGlobalMonitorForTesting: Bool {
        self.globalMonitor != nil
    }

    var hasLocalMonitorForTesting: Bool {
        self.localMonitor != nil
    }

    var hotkeyRegisteredForTesting: Bool {
        self.hotkeyRegistered
    }

    func handleSendAcceptedForTesting(openChat: Bool) {
        self.handleSendAccepted(openChat: openChat)
    }
    #endif
}
