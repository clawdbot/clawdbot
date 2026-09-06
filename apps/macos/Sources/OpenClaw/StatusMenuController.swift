import AppKit
import Foundation
import Observation
import SwiftUI

@MainActor
final class StatusMenuController: NSObject, NSMenuDelegate {
    private let state: AppState
    private let updater: UpdaterProviding
    private let menu = NSMenu()
    private let gatewayManager = GatewayProcessManager.shared
    private let controlChannel = ControlChannel.shared
    private let activityStore = WorkActivityStore.shared
    private let sessions = StatusMenuSessions.shared
    private let approvals = ExecApprovalQueueStore.shared
    private let summaries = StatusMenuSummaries.shared
    private let nodes = NodesStore.shared
    private let cron = CronJobsStore.shared
    private let dashboard = DashboardManager.shared

    private var statusItem: NSStatusItem?
    private var clickMonitor: Any?
    private var renderer: StatusMenuRenderer?
    private var refreshTask: Task<Void, Never>?
    private var observationGeneration: UInt64 = 0
    private var isMenuOpen = false
    private var isChatWindowVisible = false
    private var observedPaused: Bool
    private var observedConnectionMode: AppState.ConnectionMode
    private var observedPushToTalk: Bool

    init(state: AppState, updater: UpdaterProviding) {
        self.state = state
        self.updater = updater
        self.observedPaused = state.isPaused
        self.observedConnectionMode = state.connectionMode
        self.observedPushToTalk = state.voicePushToTalkEnabled
        super.init()
    }

    func start() {
        guard self.statusItem == nil else { return }

        self.menu.autoenablesItems = false
        self.menu.delegate = self
        StatusMenuAppearance.pin(self.menu)

        let renderer = StatusMenuRenderer(menu: self.menu, state: self.state)
        renderer.onInstallUpdate = { [weak self] in
            self?.updater.checkForUpdates(nil)
        }
        self.renderer = renderer

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        self.statusItem = item
        self.installButton(in: item)
        self.installWindowCallbacks()
        self.approvals.start()
        VoicePushToTalkHotkey.shared.setEnabled(voiceWakeSupported && self.state.voicePushToTalkEnabled)

        self.renderCachedMenu()
        self.updateStatusAppearance()
        self.observeChanges()
        self.scheduleDebugMenuOpen()
    }

    func stop() {
        self.observationGeneration &+= 1
        self.refreshTask?.cancel()
        self.refreshTask = nil
        self.sessions.cancelPreviewTasks()
        self.summaries.menuDidClose()
        self.approvals.stop()
        if let clickMonitor = self.clickMonitor {
            NSEvent.removeMonitor(clickMonitor)
            self.clickMonitor = nil
        }
        guard let statusItem else { return }
        self.statusItem = nil
        NSStatusBar.system.removeStatusItem(statusItem)
    }

    func menuWillOpen(_ menu: NSMenu) {
        StatusMenuAppearance.pin(menu)
        guard menu === self.menu, menu.supermenu == nil else { return }
        // Reconciling tracked rows can re-enter this callback without a close;
        // a second pass here would cancel refreshes and re-reconcile forever.
        guard !self.isMenuOpen else { return }

        // Cache projection must precede network work: AppKit begins tracking immediately.
        self.renderCachedMenu()
        self.isMenuOpen = true
        let previousTask = self.refreshTask
        self.refreshTask?.cancel()
        self.refreshTask = Task { [weak self] in
            // Reopening must wait for canceled store refreshes to release their loading state.
            await previousTask?.value
            guard let self, !Task.isCancelled else { return }
            async let sessionRefresh: Void = self.sessions.refresh(force: true)
            async let approvalRefresh: Void = self.approvals.refresh()
            async let healthRefresh: Void = HealthStore.shared.refresh(onDemand: true)
            _ = await (sessionRefresh, approvalRefresh, healthRefresh)
        }
        self.summaries.refresh { [weak self] in
            guard let self, self.isMenuOpen else { return }
            self.renderCachedMenu()
        }
    }

    func menuDidClose(_ menu: NSMenu) {
        guard menu === self.menu else { return }
        StatusMenuHighlightDelegate.shared.menu(menu, willHighlight: nil)
        self.isMenuOpen = false
        self.refreshTask?.cancel()
        self.sessions.cancelPreviewTasks()
        self.summaries.menuDidClose()
        // Leaving the menu attached makes subsequent left clicks open AppKit's menu.
        self.statusItem?.menu = nil
        self.statusItem?.button?.highlight(self.isChatWindowVisible)
    }

    func menu(_ menu: NSMenu, willHighlight item: NSMenuItem?) {
        StatusMenuHighlightDelegate.shared.menu(menu, willHighlight: item)
    }

    /// Accessibility/keyboard activation path; pointer clicks are consumed by the
    /// local event monitor below, so an action firing here has no mouse event.
    @objc
    private func handleStatusClick(_: Any?) {
        AppNavigationActions.openDashboard()
    }

    private func installButton(in item: NSStatusItem) {
        guard let button = item.button else { return }
        let host = NSHostingView(rootView: StatusMenuIconView(state: self.state))
        // The constraints below own sizing; animation must not remeasure the status item.
        host.sizingOptions = []
        host.translatesAutoresizingMaskIntoConstraints = false
        button.addSubview(host)
        NSLayoutConstraint.activate([
            host.centerXAnchor.constraint(equalTo: button.centerXAnchor),
            host.centerYAnchor.constraint(equalTo: button.centerYAnchor),
            host.widthAnchor.constraint(equalToConstant: 18),
            host.heightAnchor.constraint(equalToConstant: 18),
        ])
        button.target = self
        button.action = #selector(self.handleStatusClick(_:))
        self.installClickMonitor()
    }

    /// NSControl's send-action mask ignores right mouse buttons, so a local
    /// monitor owns pointer routing: left opens the dashboard, right the menu.
    private func installClickMonitor() {
        guard self.clickMonitor == nil else { return }
        self.clickMonitor = NSEvent.addLocalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown])
        { [weak self] event in
            guard let self, let button = self.statusItem?.button,
                  let window = button.window, event.windowNumber == window.windowNumber
            else { return event }
            let point = button.convert(event.locationInWindow, from: nil)
            guard button.bounds.contains(point) else { return event }
            switch event.type {
            case .leftMouseDown:
                AppNavigationActions.openDashboard()
                return nil
            case .rightMouseDown:
                self.presentMenu()
                return nil
            default:
                return event
            }
        }
    }

    private func presentMenu() {
        guard let item = self.statusItem, let button = item.button else { return }
        item.menu = self.menu
        button.performClick(nil)
    }

    private func installWindowCallbacks() {
        WebChatManager.shared.onChatWindowVisibilityChanged = { [weak self] visible in
            guard let self else { return }
            self.isChatWindowVisible = visible
            self.statusItem?.button?.highlight(visible || self.isMenuOpen)
        }
        CanvasManager.shared.onPanelVisibilityChanged = { [weak self] visible in
            self?.state.canvasPanelVisible = visible
        }
        CanvasManager.shared.defaultAnchorProvider = { [weak self] in
            guard let button = self?.statusItem?.button, let window = button.window else { return nil }
            let frame = button.convert(button.bounds, to: nil)
            return window.convertToScreen(frame)
        }
    }

    private func renderCachedMenu() {
        let connection: StatusMenuDescriptor.Connection = if self.state.connectionMode == .unconfigured {
            .unconfigured
        } else {
            switch self.controlChannel.state {
            case .connected: .connected
            case .connecting: .connecting
            case .disconnected: .disconnected
            case .degraded: .degraded
            }
        }
        let snapshot = StatusMenuDescriptor.Snapshot(
            isPaused: self.state.isPaused,
            connection: connection,
            quickChatEnabled: self.state.quickChatEnabled,
            voiceWakeSupported: voiceWakeSupported,
            debugEnabled: self.state.debugPaneEnabled,
            updateReady: self.updater.isAvailable && self.updater.updateStatus.isUpdateReady,
            hasUsage: self.summaries.hasUsage,
            isUsageStalled: self.summaries.isUsageStalled,
            sessions: self.sessions.rows,
            sessionError: self.sessions.errorText,
            mainSessionKey: self.activityStore.mainSessionKey,
            approvals: self.approvals.requests,
            gateways: DashboardGatewayMenuModel.items(from: self.dashboard.gatewayEntries))
        self.renderer?.isSleeping = statusMenuGatewayIsSleeping(state: self.state)
        self.renderer?.reconcile(StatusMenuDescriptor.build(from: snapshot))
    }

    private func observeChanges() {
        let generation = self.observationGeneration
        withObservationTracking {
            _ = self.state.isPaused
            _ = self.state.connectionMode
            _ = self.gatewayManager.status
            _ = self.controlChannel.state
            _ = self.state.voiceWakeMeterActive
            _ = self.state.voicePushToTalkEnabled
            _ = self.state.quickChatEnabled
            _ = self.state.canvasEnabled
            _ = self.state.canvasPanelVisible
            _ = self.state.talkEnabled
            _ = self.state.debugPaneEnabled
            _ = self.updater.updateStatus.isUpdateReady
            _ = self.activityStore.current
            _ = self.activityStore.mainSessionKey
            _ = HealthStore.shared.state
            _ = HealthStore.shared.degradedSummary
            _ = MacNodeChannelStatusStore.shared.state
            _ = self.nodes.nodes
            _ = self.nodes.isLoading
            _ = self.nodes.lastError
            _ = self.nodes.localNodeIdentityState
            _ = self.cron.summary
            _ = self.dashboard.gatewayEntries
            _ = self.sessions.rows
            _ = self.sessions.errorText
            _ = self.approvals.requests
            _ = self.summaries.hasUsage
            _ = self.summaries.isUsageStalled
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, self.observationGeneration == generation else { return }
                self.applyStateSideEffects()
                self.updateStatusAppearance()
                if self.isMenuOpen {
                    self.renderCachedMenu()
                }
                self.observeChanges()
            }
        }
    }

    private func applyStateSideEffects() {
        let paused = self.state.isPaused
        if paused != self.observedPaused {
            self.observedPaused = paused
            if self.state.connectionMode == .local {
                self.gatewayManager.setActive(!paused)
            } else {
                self.gatewayManager.stop()
            }
        }

        let mode = self.state.connectionMode
        if mode != self.observedConnectionMode {
            self.observedConnectionMode = mode
            Task {
                await ConnectionModeCoordinator.shared.apply(mode: mode, paused: self.state.isPaused)
                if self.state.connectionMode == mode, AppLaunchRuntimePlan.current.allowsAutomaticPresentation {
                    CLIInstallPrompter.shared.checkAndPromptIfNeeded(reason: "connection-mode")
                }
            }
            BrowserProfileImportModel.shared.handleConnectionModeChange()
        }

        let pushToTalk = self.state.voicePushToTalkEnabled
        if pushToTalk != self.observedPushToTalk {
            self.observedPushToTalk = pushToTalk
            VoicePushToTalkHotkey.shared.setEnabled(voiceWakeSupported && pushToTalk)
        }
    }

    private func updateStatusAppearance() {
        guard let button = self.statusItem?.button else { return }
        button.appearsDisabled = false
        button.toolTip = self.state.voiceWakeMeterActive
            ? String(localized: "OpenClaw - Voice Wake live meter active")
            : String(localized: "OpenClaw")
    }

    private func scheduleDebugMenuOpen() {
        #if DEBUG
        // launchctl setenv races `open`; arguments are reliable for captures.
        let arguments = CommandLine.arguments
        let environment = ProcessInfo.processInfo.environment
        func flag(_ env: String, _ arg: String) -> Bool {
            environment[env] == "1" || arguments.contains(arg)
        }
        // Screenshot/demo helper: seed synthetic menu content so UI proof
        // captures show populated rows without a configured gateway.
        if flag("OPENCLAW_DEBUG_MENU_FIXTURES", "--debug-menu-fixtures") {
            CronJobsStore.shared.seedDebugFixtureJobs()
        }
        if flag("OPENCLAW_DEBUG_OPEN_MENU", "--debug-open-menu") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                guard let self, let button = self.statusItem?.button else { return }
                self.statusItem?.menu = self.menu
                button.performClick(nil)
            }
        }
        if flag("OPENCLAW_DEBUG_PROBE_RIGHTCLICK", "--debug-probe-rightclick") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                guard let self, let button = self.statusItem?.button,
                      let window = button.window else { return }
                let center = NSPoint(x: button.bounds.midX, y: button.bounds.midY)
                let inWindow = button.convert(center, to: nil)
                guard let event = NSEvent.mouseEvent(
                    with: .rightMouseDown,
                    location: inWindow,
                    modifierFlags: [],
                    timestamp: ProcessInfo.processInfo.systemUptime,
                    windowNumber: window.windowNumber,
                    context: nil,
                    eventNumber: 0,
                    clickCount: 1,
                    pressure: 1) else { return }
                // Route through the local monitor path a real click takes.
                NSApp.postEvent(event, atStart: false)
            }
        }
        #endif
    }
}

@MainActor
private func statusMenuGatewayIsSleeping(state: AppState) -> Bool {
    guard !state.isPaused else { return false }
    return switch state.connectionMode {
    case .unconfigured:
        true
    case .remote:
        ControlChannel.shared.state != .connected
    case .local:
        switch GatewayProcessManager.shared.status {
        case .running, .starting, .attachedExisting:
            ControlChannel.shared.state != .connected
        case .failed, .stopped:
            true
        }
    }
}

@MainActor
private struct StatusMenuIconView: View {
    let state: AppState

    var body: some View {
        // SwiftUI tracks icon inputs here, independently of menu-only updates.
        let sleeping = statusMenuGatewayIsSleeping(state: self.state)
        CritterStatusLabel(
            isPaused: self.state.isPaused,
            isSleeping: sleeping,
            isWorking: self.state.isWorking,
            earBoostActive: self.state.earBoostActive,
            blinkTick: self.state.blinkTick,
            sendCelebrationTick: self.state.sendCelebrationTick,
            gatewayStatus: GatewayProcessManager.shared.status,
            connectionMode: self.state.connectionMode,
            controlChannelState: ControlChannel.shared.state,
            animationsEnabled: self.state.iconAnimationsEnabled && !sleeping,
            iconState: self.effectiveIconState,
            voiceWakeMeterActive: self.state.voiceWakeMeterActive)
    }

    private var effectiveIconState: IconState {
        let selection = self.state.iconOverride
        guard selection != .system else { return WorkActivityStore.shared.iconState }
        return switch selection.toIconState() {
        case let .workingMain(kind), let .workingOther(kind), let .overridden(kind):
            .overridden(kind)
        case .idle:
            .idle
        }
    }
}
