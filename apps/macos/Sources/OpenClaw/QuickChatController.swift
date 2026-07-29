import AppKit
import KeyboardShortcuts
import Observation
import OpenClawChatUI
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

private enum QuickChatCaptureMenuAction: String {
    case window
    case area
}

@MainActor
private final class QuickChatCaptureMenuTarget: NSObject {
    let onSelect: (QuickChatCaptureMenuAction) -> Void

    init(onSelect: @escaping (QuickChatCaptureMenuAction) -> Void) {
        self.onSelect = onSelect
    }

    @objc func selectCapture(_ sender: NSMenuItem) {
        guard let rawValue = sender.representedObject as? String,
              let action = QuickChatCaptureMenuAction(rawValue: rawValue)
        else { return }
        self.onSelect(action)
    }
}

private final class QuickChatRecentMenuSelection: NSObject {
    let target: QuickChatSessionTargetOverride?

    init(target: QuickChatSessionTargetOverride?) {
        self.target = target
    }
}

@MainActor
private final class QuickChatRecentMenuTarget: NSObject {
    let onSelect: (QuickChatSessionTargetOverride?) -> Void

    init(onSelect: @escaping (QuickChatSessionTargetOverride?) -> Void) {
        self.onSelect = onSelect
    }

    @objc func selectSession(_ sender: NSMenuItem) {
        guard let selection = sender.representedObject as? QuickChatRecentMenuSelection else { return }
        self.onSelect(selection.target)
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
    typealias RecentSessionsProvider = @MainActor () async throws -> [SessionRow]

    static let shared = QuickChatController()

    private(set) var isVisible = false
    private(set) var isEnabled = true

    @ObservationIgnored let model: QuickChatModel
    @ObservationIgnored let replyBinding: QuickChatReplyBinding
    @ObservationIgnored private let enableUI: Bool
    @ObservationIgnored private let monitoringEnabled: Bool
    @ObservationIgnored private let globalMonitorInstaller: GlobalMonitorInstaller
    @ObservationIgnored private let localMonitorInstaller: LocalMonitorInstaller
    @ObservationIgnored private let monitorClearer: MonitorClearer
    @ObservationIgnored private let hotkeyRegistrar: HotkeyRegistrar
    @ObservationIgnored private let hotkeyRemover: HotkeyRemover
    @ObservationIgnored private let chatOpener: ChatOpener
    @ObservationIgnored private let recentSessionsProvider: RecentSessionsProvider
    @ObservationIgnored private let dictation: QuickChatDictation
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
    @ObservationIgnored private var isMenuActive = false
    @ObservationIgnored private var recentSessionsTask: Task<Void, Never>?
    @ObservationIgnored private var recentSessionsRequestID = UUID()
    @ObservationIgnored private var dictationStartTask: Task<Void, Never>?
    @ObservationIgnored private var dictationRequestID = UUID()
    @ObservationIgnored private var pasteTask: Task<Void, Never>?
    @ObservationIgnored private var pasteRequestID = UUID()

    init(
        enableUI: Bool = true,
        model: QuickChatModel? = nil,
        dictation: QuickChatDictation = QuickChatDictation(),
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
        recentSessionsProvider: @escaping RecentSessionsProvider = {
            try await SessionLoader.loadSnapshot(limit: 5).rows
        },
        replyViewModelFactory: @escaping QuickChatReplyBinding.ViewModelFactory = {
            let transport = MacGatewayChatTransport(defaultGlobalAgentID: $0.agentID)
            return OpenClawChatViewModel(
                sessionKey: $0.sessionKey,
                transport: transport,
                activeAgentId: $0.agentID)
        },
        allowsHotkeyRegistrationInTests: Bool = false)
    {
        self.enableUI = enableUI
        self.model = model ?? QuickChatModel()
        self.dictation = dictation
        self.replyBinding = QuickChatReplyBinding(viewModelFactory: replyViewModelFactory)
        self.monitoringEnabled = monitoringEnabled ?? (enableUI && !ProcessInfo.processInfo.isRunningTests)
        self.globalMonitorInstaller = globalMonitorInstaller
        self.localMonitorInstaller = localMonitorInstaller
        self.monitorClearer = monitorClearer
        self.hotkeyRegistrar = hotkeyRegistrar
        self.hotkeyRemover = hotkeyRemover
        self.chatOpener = chatOpener
        self.recentSessionsProvider = recentSessionsProvider
        self.allowsHotkeyRegistrationInTests = allowsHotkeyRegistrationInTests
        super.init()
        self.model.onSendDispatched = { [weak self] route in
            guard let self else { return }
            self.stopDictation()
            self.cancelPasteRequest()
            // A dispatched send supersedes any pending recents fetch: its menu popping
            // over the fresh reply would rebind away from the response just sent.
            self.invalidateRecentsFetch()
            self.replyBinding.prepare(route: route)
        }
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

    /// Invalidates any in-flight recents fetch: rotates the request ID so stale
    /// completions no-op, and cancels/clears the task so the picker stays usable.
    private func invalidateRecentsFetch() {
        self.recentSessionsRequestID = UUID()
        self.recentSessionsTask?.cancel()
        self.recentSessionsTask = nil
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
        self.recentSessionsTask?.cancel()
        self.recentSessionsTask = nil
        self.replyBinding.clear()
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
        self.stopDictation()
        self.cancelPasteRequest()
        // A fresh presentation must never resurrect a reply prepared or shown by an
        // earlier one (e.g. a capture send that raced the previous hide).
        self.replyBinding.clear()
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
              !self.model.isStartingDictation,
              !self.model.isCapturingTextContext,
              !self.replyBinding.isPastingReply,
              self.windowPicker?.isInteractionActive != true,
              !self.isMenuActive
        else { return }
        self.dismiss()
    }

    private func dismiss(immediate: Bool) {
        self.stopDictation()
        self.cancelPasteRequest()
        if self.isVisible {
            quickChatLogger.info("quick chat dismiss immediate=\(immediate)")
        }
        self.windowPicker?.cancel()
        self.recentSessionsRequestID = UUID()
        self.recentSessionsTask?.cancel()
        self.recentSessionsTask = nil
        self.presentationTask?.cancel()
        self.presentationTask = nil
        self.model.endPresentation()
        self.replyBinding.clear()
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
            replyBinding: self.replyBinding,
            onDismiss: { [weak self] in self?.dismiss() },
            onSendAccepted: { [weak self] openChat in
                self?.handleSendAccepted(openChat: openChat)
            },
            onShowAgentPicker: { [weak self] in
                self?.showAgentPicker()
            },
            onShowModelMenu: { [weak self] in
                self?.showModelMenu()
            },
            onShowRecentSessions: { [weak self] in
                self?.showRecentSessionsPicker()
            },
            onToggleDictation: { [weak self] in
                self?.toggleDictation()
            },
            onStopDictation: { [weak self] in
                self?.stopDictation()
            },
            onCaptureTextContext: { [weak self] in
                self?.captureFocusedAppText()
            },
            onShowCaptureMenu: { [weak self] in
                self?.showCaptureMenu()
            },
            onGrantPermissions: { [weak self] in
                self?.grantMissingPermissions()
            },
            onPasteReply: { [weak self] in
                self?.pasteReplyToFrontmostApp()
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
        guard openChat else {
            if let route {
                self.replyBinding.show(route: route)
            }
            return
        }
        self.dismiss()
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

    private func toggleDictation() {
        if self.model.isDictating || self.model.isStartingDictation {
            self.stopDictation()
            return
        }
        guard self.isVisible, let textView = self.textView,
              self.model.prepareDictation(selection: textView.selectedRange())
        else { return }

        let requestID = UUID()
        let presentationID = self.model.activePresentationID
        self.dictationRequestID = requestID
        self.dictationStartTask?.cancel()
        self.dictationStartTask = Task { [weak self] in
            guard let self else { return }
            let permissions = await PermissionManager.ensure(
                [.microphone, .speechRecognition],
                interactive: true)
            guard !Task.isCancelled,
                  self.dictationRequestID == requestID,
                  self.model.activePresentationID == presentationID,
                  self.isVisible
            else { return }
            guard permissions[.microphone] == true, permissions[.speechRecognition] == true else {
                self.model.failDictation(message: String(
                    localized: "Microphone and speech recognition permission required."))
                self.dictationStartTask = nil
                self.dismissIfFocusWasLost()
                return
            }
            guard self.panel?.isKeyWindow == true else {
                // Permission UI can hide a later app switch from the normal resign handler.
                // Never start audio unless this exact presentation has regained keyboard focus.
                self.dismiss()
                return
            }

            self.model.dictationDidStart()
            do {
                try await self.dictation.start { [weak self] event in
                    guard let self,
                          self.dictationRequestID == requestID,
                          self.isVisible,
                          self.model.isDictating
                    else { return }
                    switch event {
                    case let .transcript(transcript):
                        self.model.applyDictationTranscript(transcript)
                    case .finished:
                        self.stopDictation()
                    case .failed:
                        self.stopDictation()
                        self.model.failDictation(message: String(
                            localized: "Dictation stopped because speech recognition failed."))
                    }
                }
            } catch {
                guard self.dictationRequestID == requestID else { return }
                self.model.failDictation(message: String(localized: "Couldn't start dictation."))
                self.dismissIfFocusWasLost()
            }
            if self.dictationRequestID == requestID {
                self.dictationStartTask = nil
            }
        }
    }

    private func stopDictation() {
        self.dictationRequestID = UUID()
        self.dictationStartTask?.cancel()
        self.dictationStartTask = nil
        self.dictation.stop()
        self.model.stopDictation()
    }

    private func pasteReplyToFrontmostApp() {
        guard let viewModel = self.replyBinding.viewModel,
              let text = QuickChatPasteLogic.finalAssistantText(
                  messages: viewModel.messages,
                  afterUserIdempotencyKey: self.model.lastAcceptedIdempotencyKey,
                  streamingAssistantText: viewModel.streamingAssistantText,
                  pendingRunCount: viewModel.pendingRunCount),
              self.replyBinding.beginPaste()
        else { return }
        self.stopDictation()

        guard let targetApp = NSWorkspace.shared.frontmostApplication else {
            self.replyBinding.finishPaste(message: String(localized: "No app is available to paste into."))
            return
        }
        guard QuickChatPasteLogic.canPaste(
            frontmostProcessIdentifier: targetApp.processIdentifier,
            ownProcessIdentifier: ProcessInfo.processInfo.processIdentifier)
        else {
            self.replyBinding.finishPaste(message: String(localized: "Choose another app before pasting."))
            return
        }

        let requestID = UUID()
        let presentationID = self.model.activePresentationID
        self.pasteRequestID = requestID
        self.pasteTask?.cancel()
        self.pasteTask = Task { [weak self, targetApp] in
            guard let self else { return }
            let permissions = await PermissionManager.ensure([.accessibility], interactive: true)
            guard self.isCurrentPasteRequest(requestID, presentationID: presentationID) else { return }
            guard permissions[.accessibility] == true else {
                self.finishPasteRequest(
                    requestID,
                    message: String(localized: "Accessibility permission is required to paste."))
                return
            }

            // Match a normal copy/paste operation: replace the general pasteboard and
            // deliberately leave the reply there instead of restoring stale clipboard data.
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            guard pasteboard.setString(text, forType: .string),
                  await self.activatePasteTarget(targetApp)
            else {
                self.finishPasteRequest(
                    requestID,
                    message: String(localized: "Couldn't paste the reply."))
                return
            }
            let frontmostPID = NSWorkspace.shared.frontmostApplication?.processIdentifier
            guard self.isCurrentPasteRequest(requestID, presentationID: presentationID),
                  QuickChatPasteLogic.isExpectedTarget(
                      frontmostProcessIdentifier: frontmostPID,
                      targetProcessIdentifier: targetApp.processIdentifier),
                  QuickChatPasteEventInjector.postCommandV(to: targetApp.processIdentifier)
            else {
                if self.isCurrentPasteRequest(requestID, presentationID: presentationID) {
                    self.finishPasteRequest(
                        requestID,
                        message: String(localized: "Couldn't paste the reply."))
                }
                return
            }
            self.finishPasteRequest(requestID)
            self.dismiss()
        }
    }

    private func activatePasteTarget(_ targetApp: NSRunningApplication) async -> Bool {
        let targetPID = targetApp.processIdentifier
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPID {
            return true
        }
        guard targetApp.activate(options: []) else { return false }
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(1))
        while clock.now < deadline {
            guard !Task.isCancelled else { return false }
            if NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPID {
                return true
            }
            do {
                try await Task.sleep(for: .milliseconds(20))
            } catch is CancellationError {
                return false
            } catch {
                return false
            }
        }
        return NSWorkspace.shared.frontmostApplication?.processIdentifier == targetPID
    }

    private func isCurrentPasteRequest(_ requestID: UUID, presentationID: UUID?) -> Bool {
        !Task.isCancelled &&
            self.pasteRequestID == requestID &&
            self.model.activePresentationID == presentationID &&
            self.replyBinding.isPastingReply &&
            self.isVisible
    }

    private func finishPasteRequest(_ requestID: UUID, message: String? = nil) {
        guard self.pasteRequestID == requestID else { return }
        self.pasteTask = nil
        self.replyBinding.finishPaste(message: message)
        if message != nil {
            self.dismissIfFocusWasLost()
        }
    }

    private func dismissIfFocusWasLost() {
        guard self.isVisible, self.panel?.isKeyWindow != true else { return }
        self.dismiss()
    }

    private func cancelPasteRequest() {
        self.pasteRequestID = UUID()
        self.pasteTask?.cancel()
        self.pasteTask = nil
        if self.replyBinding.isPastingReply {
            self.replyBinding.finishPaste()
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
              !self.model.isStartingDictation,
              !self.model.isCapturingTextContext,
              !self.replyBinding.isPastingReply,
              self.windowPicker?.isInteractionActive != true,
              !self.isMenuActive,
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

        self.isMenuActive = true
        self.removeDismissMonitors()
        defer {
            self.isMenuActive = false
            if self.isVisible { self.installDismissMonitors() }
            self.focusEditor()
        }

        let target = QuickChatAgentMenuTarget { [weak self] id in
            guard let self else { return }
            self.model.selectAgent(id)
            if let route = self.model.routingTarget {
                self.replyBinding.rebindIfActive(route: route)
            }
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
        // Competing interaction: invalidate any in-flight recents fetch before blocking.
        self.invalidateRecentsFetch()
        withExtendedLifetime(target) {
            _ = menu.popUp(positioning: nil, at: contentPoint, in: contentView)
        }
    }

    private func showModelMenu() {
        guard self.model.canUseModelControls,
              let panel,
              let contentView = panel.contentView
        else { return }

        self.isMenuActive = true
        self.removeDismissMonitors()
        defer {
            self.isMenuActive = false
            if self.isVisible { self.installDismissMonitors() }
            self.focusEditor()
        }

        QuickChatModelMenuPresenter.present(
            model: self.model,
            panel: panel,
            contentView: contentView)
    }

    private func showRecentSessionsPicker() {
        guard self.canShowRecentSessions, self.recentSessionsTask == nil else { return }
        let requestID = UUID()
        let presentationID = self.model.activePresentationID
        self.recentSessionsRequestID = requestID
        self.recentSessionsTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.recentSessionsRequestID == requestID {
                    self.recentSessionsTask = nil
                }
            }
            do {
                let rows = try await self.recentSessionsProvider()
                guard !Task.isCancelled,
                      self.recentSessionsRequestID == requestID,
                      self.model.activePresentationID == presentationID,
                      // Eligibility can lapse while the fetch is in flight (a send may
                      // have started); a menu whose selections would be ignored is worse
                      // than no menu.
                      self.canShowRecentSessions
                else { return }
                self.presentRecentSessionsMenu(rows: rows)
            } catch {
                quickChatLogger.error(
                    "quick chat recent sessions failed: \(error.localizedDescription, privacy: .public)")
            }
        }
    }

    private var canShowRecentSessions: Bool {
        self.isVisible &&
            self.model.canSelectRecentSession &&
            !self.model.isGrantingPermissions &&
            !self.model.isCapturingTextContext &&
            self.windowPicker?.isInteractionActive != true &&
            !self.isMenuActive
    }

    private func captureFocusedAppText() {
        self.invalidateRecentsFetch()
        self.model.captureFocusedAppText()
    }

    private func grantMissingPermissions() {
        self.invalidateRecentsFetch()
        self.stopDictation()
        self.model.grantMissingPermissions()
    }

    private func presentRecentSessionsMenu(rows: [SessionRow]) {
        guard let panel, let contentView = panel.contentView else { return }
        let items = QuickChatRecentMenuLogic.items(
            rows: rows,
            agentName: self.model.agentDisplay.name,
            selectedTarget: self.model.targetSessionOverride)

        self.isMenuActive = true
        self.removeDismissMonitors()
        defer {
            self.isMenuActive = false
            if self.isVisible { self.installDismissMonitors() }
            self.focusEditor()
        }

        let target = QuickChatRecentMenuTarget { [weak self] selection in
            guard let self else { return }
            self.model.selectSessionOverride(selection)
            if let route = self.model.routingTarget {
                self.replyBinding.rebindIfActive(route: route)
            }
        }
        let menu = NSMenu()
        for (index, recent) in items.enumerated() {
            if index == 1 { menu.addItem(.separator()) }
            let item = NSMenuItem(
                title: recent.title,
                action: #selector(QuickChatRecentMenuTarget.selectSession(_:)),
                keyEquivalent: "")
            item.target = target
            item.representedObject = QuickChatRecentMenuSelection(target: recent.target)
            item.state = recent.isSelected ? .on : .off
            menu.addItem(item)
        }
        let windowPoint = panel.convertPoint(fromScreen: NSEvent.mouseLocation)
        let contentPoint = contentView.convert(windowPoint, from: nil)
        withExtendedLifetime(target) {
            _ = menu.popUp(positioning: nil, at: contentPoint, in: contentView)
        }
    }

    private func showCaptureMenu() {
        guard self.model.canCaptureWindow,
              let panel,
              let contentView = panel.contentView
        else { return }

        self.isMenuActive = true
        self.removeDismissMonitors()
        defer {
            self.isMenuActive = false
            if self.isVisible { self.installDismissMonitors() }
            self.focusEditor()
        }

        let target = QuickChatCaptureMenuTarget { [weak self] action in
            switch action {
            case .window:
                self?.startCapturePicker(area: false)
            case .area:
                self?.startCapturePicker(area: true)
            }
        }
        let menu = NSMenu()
        for (title, action) in [
            (String(localized: "Capture Window…"), QuickChatCaptureMenuAction.window),
            (String(localized: "Capture Area…"), QuickChatCaptureMenuAction.area),
        ] {
            let item = NSMenuItem(
                title: title,
                action: #selector(QuickChatCaptureMenuTarget.selectCapture(_:)),
                keyEquivalent: "")
            item.target = target
            item.representedObject = action.rawValue
            menu.addItem(item)
        }
        let windowPoint = panel.convertPoint(fromScreen: NSEvent.mouseLocation)
        let contentPoint = contentView.convert(windowPoint, from: nil)
        // Competing interaction: invalidate any in-flight recents fetch before blocking.
        self.invalidateRecentsFetch()
        withExtendedLifetime(target) {
            _ = menu.popUp(positioning: nil, at: contentPoint, in: contentView)
        }
    }

    private func startCapturePicker(area: Bool) {
        guard self.isVisible, self.model.canCaptureWindow else { return }
        if self.windowPicker == nil {
            self.windowPicker = QuickChatWindowPicker(
                model: self.model,
                onInteractionChanged: { [weak self] active in
                    self?.pickerInteractionChanged(active)
                },
                onSendAccepted: { [weak self] in
                    self?.handleSendAccepted(openChat: false)
                })
        }
        guard let windowPicker = self.windowPicker else { return }
        // Competing interaction: a recents menu must not pop over the picker overlays.
        self.invalidateRecentsFetch()
        Task {
            if area {
                await windowPicker.beginArea()
            } else {
                await windowPicker.beginWindow()
            }
        }
    }

    private func pickerInteractionChanged(_ active: Bool) {
        if active {
            self.removeDismissMonitors()
        } else if self.isVisible {
            self.installDismissMonitors()
        }
        guard let panel else { return }
        if active {
            // Synchronous hide: overlays are clickable immediately, and a fast drag's
            // capture (80ms settle) must never include a still-fading composer.
            panel.alphaValue = 0
            return
        }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.12
            panel.animator().alphaValue = 1
        } completionHandler: { [weak self] in
            Task { @MainActor in
                self?.focusEditor()
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
