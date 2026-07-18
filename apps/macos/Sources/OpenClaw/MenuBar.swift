import AppKit
import Darwin
import Foundation
import MenuBarExtraAccess
import Observation
import OSLog
import Security
import SwiftUI

@main
struct OpenClawApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @Environment(\.openWindow) private var openWindow
    @State private var state: AppState
    private static let logger = Logger(subsystem: "ai.openclaw", category: "app")
    private let gatewayManager = GatewayProcessManager.shared
    private let controlChannel = ControlChannel.shared
    private let activityStore = WorkActivityStore.shared
    @State private var statusItem: NSStatusItem?
    @State private var statusItemMouseRouter = StatusItemMouseRouter()
    @State private var isMenuPresented = false
    @State private var isPanelVisible = false
    @State private var tailscaleService = TailscaleService.shared

    @MainActor
    private func updateStatusHighlight() {
        self.statusItem?.button?.highlight(self.isPanelVisible)
    }

    @MainActor
    private func updateHoverHUDSuppression() {
        HoverHUDController.shared.setSuppressed(self.isMenuPresented || self.isPanelVisible)
    }

    init() {
        OpenClawLogging.bootstrapIfNeeded()

        Self.applyAttachOnlyOverrideIfNeeded()
        _state = State(initialValue: AppStateStore.shared)
    }

    var body: some Scene {
        MenuBarExtra { MenuContent(state: self.state, updater: self.delegate.updaterController) } label: {
            CritterStatusLabel(
                isPaused: self.state.isPaused,
                isSleeping: self.isGatewaySleeping,
                isWorking: self.state.isWorking,
                earBoostActive: self.state.earBoostActive,
                blinkTick: self.state.blinkTick,
                sendCelebrationTick: self.state.sendCelebrationTick,
                gatewayStatus: self.gatewayManager.status,
                animationsEnabled: self.state.iconAnimationsEnabled && !self.isGatewaySleeping,
                iconState: self.effectiveIconState,
                voiceWakeMeterActive: self.state.voiceWakeMeterActive)
                .background(SettingsWindowOpenRegistrar())
        }
        .menuBarExtraAccess(isPresented: self.$isMenuPresented) { item in
            // SwiftUI can vend a replacement status item during connection churn.
            // Keep ownership to one item so stale menu bar icons are removed.
            if let currentStatusItem = self.statusItem {
                guard currentStatusItem !== item else { return }
                Self.logger.warning("Replacing stale menu bar status item")
                NSStatusBar.system.removeStatusItem(currentStatusItem)
            }
            self.statusItem = item
            MenuSessionsInjector.shared.install(into: item)
            self.applyStatusItemAppearance(paused: self.state.isPaused, sleeping: self.isGatewaySleeping)
            self.installStatusItemMouseHandler(for: item)
            self.updateHoverHUDSuppression()
        }
        .menuBarExtraStyle(.menu)
        .onChange(of: self.state.isPaused) { _, paused in
            self.applyStatusItemAppearance(paused: paused, sleeping: self.isGatewaySleeping)
            if self.state.connectionMode == .local {
                self.gatewayManager.setActive(!paused)
            } else {
                self.gatewayManager.stop()
            }
        }
        .onChange(of: self.controlChannel.state) { _, _ in
            self.applyStatusItemAppearance(paused: self.state.isPaused, sleeping: self.isGatewaySleeping)
        }
        .onChange(of: self.gatewayManager.status) { _, _ in
            self.applyStatusItemAppearance(paused: self.state.isPaused, sleeping: self.isGatewaySleeping)
        }
        .onChange(of: self.state.voiceWakeMeterActive) { _, _ in
            self.applyStatusItemAppearance(paused: self.state.isPaused, sleeping: self.isGatewaySleeping)
        }
        .onChange(of: self.state.connectionMode) { _, mode in
            Task { await ConnectionModeCoordinator.shared.apply(mode: mode, paused: self.state.isPaused) }
            CLIInstallPrompter.shared.checkAndPromptIfNeeded(reason: "connection-mode")
            BrowserProfileImportModel.shared.handleConnectionModeChange()
        }

        Window("OpenClaw Settings", id: SettingsWindowOpener.windowID) {
            SettingsRootView(state: self.state, updater: self.delegate.updaterController)
                .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight, alignment: .topLeading)
                .environment(self.tailscaleService)
        }
        .defaultLaunchBehavior(.suppressed)
        .restorationBehavior(.disabled)
        .defaultSize(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
        .windowResizability(.contentSize)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Session") {
                    DashboardManager.shared.dispatchNativeCommand(.newSession)
                }
                .keyboardShortcut("n", modifiers: .command)
            }
            CommandGroup(replacing: .appSettings) {
                Button("Settings...") {
                    self.openWindow(id: SettingsWindowOpener.windowID)
                }
                .keyboardShortcut(",", modifiers: .command)
            }
            SidebarCommands()
            CommandMenu("Navigate") {
                Button("Back") {
                    DashboardManager.shared.navigateBack()
                }
                .keyboardShortcut("[", modifiers: .command)

                Button("Forward") {
                    DashboardManager.shared.navigateForward()
                }
                .keyboardShortcut("]", modifiers: .command)

                Divider()

                Button("Command Palette…") {
                    DashboardManager.shared.dispatchNativeCommand(.commandPalette)
                }
                .keyboardShortcut("k", modifiers: .command)
            }
        }
        .onChange(of: self.isMenuPresented) { _, _ in
            self.updateStatusHighlight()
            self.updateHoverHUDSuppression()
        }
    }

    private func applyStatusItemAppearance(paused _: Bool, sleeping _: Bool) {
        // Keep the status item actionable even when the Gateway is paused or disconnected.
        // The SwiftUI label already renders those states; AppKit's disabled appearance can
        // leak into menu item validation and grey out app-level commands like Settings.
        self.statusItem?.button?.appearsDisabled = false
        self.statusItem?.button?.toolTip = self.state.voiceWakeMeterActive
            ? "OpenClaw - Voice Wake live meter active"
            : "OpenClaw"
    }

    private static func applyAttachOnlyOverrideIfNeeded() {
        let args = CommandLine.arguments
        guard args.contains("--attach-only") || args.contains("--no-launchd") else { return }
        if let error = GatewayLaunchAgentManager.applyAttachOnlyRuntimeOverride() {
            Self.logger.error("attach-only flag failed: \(error, privacy: .public)")
            return
        }
        Self.logger.info("attach-only flag enabled")
    }

    private var isGatewaySleeping: Bool {
        if self.state.isPaused {
            return false
        }
        switch self.state.connectionMode {
        case .unconfigured:
            return true
        case .remote:
            if case .connected = self.controlChannel.state {
                return false
            }
            return true
        case .local:
            switch self.gatewayManager.status {
            case .running, .starting, .attachedExisting:
                if case .connected = self.controlChannel.state {
                    return false
                }
                return true
            case .failed, .stopped:
                return true
            }
        }
    }

    @MainActor
    private func installStatusItemMouseHandler(for item: NSStatusItem) {
        WebChatManager.shared.onPanelVisibilityChanged = { [self] visible in
            self.isPanelVisible = visible
            self.updateStatusHighlight()
            self.updateHoverHUDSuppression()
        }
        CanvasManager.shared.onPanelVisibilityChanged = { [self] visible in
            self.state.canvasPanelVisible = visible
        }
        CanvasManager.shared.defaultAnchorProvider = { [self] in self.statusButtonScreenFrame() }

        self.statusItemMouseRouter.install(
            on: item,
            onLeftClick: { [self] in
                HoverHUDController.shared.dismiss()
                self.openDashboardWindow()
            },
            onRightClick: { [self] in
                HoverHUDController.shared.dismiss()
                WebChatManager.shared.closePanel()
                self.isMenuPresented = true
                self.updateStatusHighlight()
            },
            onHoverChanged: { [self] inside in
                HoverHUDController.shared.statusItemHoverChanged(
                    inside: inside,
                    anchorProvider: { [self] in self.statusButtonScreenFrame() })
            })
    }

    @MainActor
    private func openDashboardWindow() {
        HoverHUDController.shared.setSuppressed(true)
        self.isMenuPresented = false
        AppNavigationActions.openDashboard()
    }

    @MainActor
    private func statusButtonScreenFrame() -> NSRect? {
        guard let button = statusItem?.button, let window = button.window else { return nil }
        let inWindow = button.convert(button.bounds, to: nil)
        return window.convertToScreen(inWindow)
    }

    private var effectiveIconState: IconState {
        let selection = self.state.iconOverride
        if selection == .system {
            return self.activityStore.iconState
        }
        let overrideState = selection.toIconState()
        switch overrideState {
        case let .workingMain(kind): return .overridden(kind)
        case let .workingOther(kind): return .overridden(kind)
        case .idle: return .idle
        case let .overridden(kind): return .overridden(kind)
        }
    }
}

/// Routes status-item clicks before AppKit starts the menu's nested tracking loop.
/// A label subview is not durable because SwiftUI replaces it when `MenuBarExtra` redraws.
@MainActor
final class StatusItemMouseRouter: NSResponder {
    typealias EventMonitorHandler = (NSEvent) -> NSEvent?
    typealias EventMonitorInstaller = (NSEvent.EventTypeMask, @escaping EventMonitorHandler) -> Any?
    typealias EventMonitorRemover = (Any) -> Void

    private weak var button: NSView?
    private var eventMonitor: Any?
    private var trackingArea: NSTrackingArea?
    private var onLeftClick: (() -> Void)?
    private var onRightClick: (() -> Void)?
    private var onHoverChanged: ((Bool) -> Void)?
    private let eventMonitorInstaller: EventMonitorInstaller
    private let eventMonitorRemover: EventMonitorRemover

    init(
        eventMonitorInstaller: @escaping EventMonitorInstaller = { mask, handler in
            NSEvent.addLocalMonitorForEvents(matching: mask, handler: handler)
        },
        eventMonitorRemover: @escaping EventMonitorRemover = { monitor in
            NSEvent.removeMonitor(monitor)
        })
    {
        self.eventMonitorInstaller = eventMonitorInstaller
        self.eventMonitorRemover = eventMonitorRemover
        super.init()
    }

    required init?(coder: NSCoder) {
        self.eventMonitorInstaller = { mask, handler in
            NSEvent.addLocalMonitorForEvents(matching: mask, handler: handler)
        }
        self.eventMonitorRemover = { monitor in
            NSEvent.removeMonitor(monitor)
        }
        super.init(coder: coder)
    }

    func install(
        on item: NSStatusItem,
        onLeftClick: @escaping () -> Void,
        onRightClick: @escaping () -> Void,
        onHoverChanged: @escaping (Bool) -> Void)
    {
        guard let button = item.button else { return }
        self.install(
            on: button,
            onLeftClick: onLeftClick,
            onRightClick: onRightClick,
            onHoverChanged: onHoverChanged)
    }

    func install(
        on button: NSView,
        onLeftClick: @escaping () -> Void,
        onRightClick: @escaping () -> Void,
        onHoverChanged: @escaping (Bool) -> Void)
    {
        self.onLeftClick = onLeftClick
        self.onRightClick = onRightClick
        self.onHoverChanged = onHoverChanged
        self.track(button)

        guard self.eventMonitor == nil else { return }
        self.eventMonitor = Self.installMonitor(using: self.eventMonitorInstaller) { [weak self] event in
            guard let self else { return event }
            return self.route(event)
        }
    }

    func route(_ event: NSEvent) -> NSEvent? {
        Self.route(
            event,
            hitsTarget: self.button.map { Self.contains(event, in: $0) } ?? false,
            onLeftClick: { self.onLeftClick?() },
            onRightClick: { self.onRightClick?() })
    }

    static func installMonitor(
        using installer: EventMonitorInstaller,
        handler: @escaping EventMonitorHandler) -> Any?
    {
        installer([.leftMouseDown, .rightMouseDown]) { event in
            handler(event)
        }
    }

    static func route(
        _ event: NSEvent,
        hitsTarget: Bool,
        onLeftClick: () -> Void,
        onRightClick: () -> Void) -> NSEvent?
    {
        guard hitsTarget else { return event }
        switch event.type {
        case .leftMouseDown:
            onLeftClick()
            return nil
        case .rightMouseDown:
            onRightClick()
            return nil
        default:
            return event
        }
    }

    private func track(_ button: NSView) {
        guard self.button !== button else { return }
        if let previousButton = self.button, let trackingArea {
            previousButton.removeTrackingArea(trackingArea)
        }
        let trackingArea = NSTrackingArea(
            rect: button.bounds,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self,
            userInfo: nil)
        button.addTrackingArea(trackingArea)
        self.button = button
        self.trackingArea = trackingArea
    }

    private static func contains(_ event: NSEvent, in button: NSView) -> Bool {
        guard let window = button.window, event.windowNumber == window.windowNumber else { return false }
        let point = button.convert(event.locationInWindow, from: nil)
        return button.bounds.contains(point)
    }

    override func mouseEntered(with _: NSEvent) {
        self.onHoverChanged?(true)
    }

    override func mouseExited(with _: NSEvent) {
        self.onHoverChanged?(false)
    }

    @MainActor deinit {
        if let eventMonitor {
            self.eventMonitorRemover(eventMonitor)
        }
    }
}

private struct SettingsWindowOpenRegistrar: View {
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Color.clear
            .frame(width: 0, height: 0)
            .onAppear {
                let openWindow = self.openWindow
                SettingsWindowOpener.shared.register {
                    openWindow(id: SettingsWindowOpener.windowID)
                }
            }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private static let dashboardURL = URL(string: "openclaw://dashboard")!
    private var state: AppState?
    private var terminationCleanupTask: Task<Void, Never>?
    private var terminationDeadlineTask: Task<Void, Never>?
    private var terminationCleanupFinished = false
    private let webChatAutoLogger = Logger(subsystem: "ai.openclaw", category: "Chat")
    var nodeTerminationCleanup: @MainActor () async -> Void = {
        await TalkMLXSpeechSynthesizer.shared.shutdown()
        await MacNodeModeCoordinator.shared.stopAndWait()
    }

    var waitForTerminationCleanupDeadline: @MainActor () async -> Void = {
        try? await Task.sleep(for: .seconds(AppTerminationTiming.cleanupDeadlineSeconds))
    }

    var applicationTerminationReply: @MainActor (NSApplication, Bool) -> Void = { app, allow in
        app.reply(toApplicationShouldTerminate: allow)
    }

    var openDashboardAction: @MainActor () -> Void = { AppNavigationActions.openDashboard() }
    let updaterController: UpdaterProviding = makeUpdaterController()

    func applicationWillFinishLaunching(_: Notification) {
        // URL/reopen callbacks can create the dashboard before didFinishLaunching.
        DashboardManager.shared.configure(updater: self.updaterController)
    }

    func applicationDockMenu(_: NSApplication) -> NSMenu? {
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.addItem(self.dockMenuItem(
            title: "Open Dashboard",
            systemImage: "gauge",
            action: #selector(self.openDashboardFromDockMenu(_:))))
        menu.addItem(self.dockMenuItem(
            title: "Open Chat",
            systemImage: "bubble.left.and.bubble.right",
            action: #selector(self.openChatFromDockMenu(_:))))
        let canvasTitle = AppStateStore.shared.canvasPanelVisible ? "Close Canvas" : "Open Canvas"
        let canvasItem = self.dockMenuItem(
            title: canvasTitle,
            systemImage: "rectangle.inset.filled.on.rectangle",
            action: #selector(self.toggleCanvasFromDockMenu(_:)))
        canvasItem.isEnabled = AppStateStore.shared.canvasEnabled
        menu.addItem(canvasItem)
        menu.addItem(.separator())
        menu.addItem(self.dockMenuItem(
            title: "Settings…",
            systemImage: "gearshape",
            action: #selector(self.openSettingsFromDockMenu(_:))))
        return menu
    }

    private func dockMenuItem(title: String, systemImage: String, action: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        item.image = NSImage(systemSymbolName: systemImage, accessibilityDescription: title)
        return item
    }

    @objc
    private func openDashboardFromDockMenu(_: Any?) {
        self.openDashboardAction()
    }

    @objc
    private func openChatFromDockMenu(_: Any?) {
        AppNavigationActions.openChat()
    }

    @objc
    private func toggleCanvasFromDockMenu(_: Any?) {
        AppNavigationActions.toggleCanvas()
    }

    @objc
    private func openSettingsFromDockMenu(_: Any?) {
        AppNavigationActions.openSettings()
    }

    func application(_: NSApplication, open urls: [URL]) {
        Task { @MainActor in
            for url in urls {
                await DeepLinkHandler.shared.handle(url: url)
            }
        }
    }

    func applicationShouldHandleReopen(_: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if flag {
            return true
        }
        self.openDashboardAction()
        return false
    }

    @MainActor
    func applicationDidFinishLaunching(_: Notification) {
        let environment = ProcessInfo.processInfo.environment
        let hasReplacementHandoff = ApplicationRelocator.hasReplacementHandoffMetadata(
            environment: environment)
        let isReplacementHandoff = ApplicationRelocator.acceptReplacementHandoff(
            environment: environment)
        if hasReplacementHandoff, !isReplacementHandoff {
            NSApp.terminate(nil)
            return
        }
        // Only a child whose signed parent and inherited readiness pipe authenticate
        // may overlap the old process during replacement handoff.
        if !isReplacementHandoff, self.isDuplicateInstance() {
            NSWorkspace.shared.open(Self.dashboardURL)
            NSApp.terminate(nil)
            return
        }
        switch ApplicationRelocator.handleLaunch() {
        case .terminating:
            return
        case let .continueLaunch(startUpdater):
            if startUpdater {
                self.updaterController.start()
            }
        }
        // Remote startup can spawn an SSH child. Admit tunnel work only after the
        // singleton check so a short-lived handoff process cannot orphan that child.
        GatewayEndpointStore.admitPrimaryAppLaunch()
        GatewayConnectivityCoordinator.shared.start()
        self.state = AppStateStore.shared
        if let state {
            MacNodeModeCoordinator.prepareNodeIdentityProfile(
                isExistingInstallation: state.onboardingSeen || state.connectionMode != .unconfigured)
        }
        AppActivationPolicy.apply(showDockIcon: state?.showDockIcon ?? false)
        if let state {
            let shouldWaitForConnection = state.connectionMode != .unconfigured
            if !shouldWaitForConnection {
                Task { @MainActor in
                    await self.scheduleFirstRunOnboardingIfNeeded(gatewayConnected: false)
                }
            }
            Task { @MainActor in
                // Validate PATH selection before local startup. Existing installs may not
                // have the validation cache yet, and a stale external CLI must not win.
                if state.connectionMode == .local {
                    _ = await CLIInstaller.status()
                }
                await ConnectionModeCoordinator.shared.apply(
                    mode: state.connectionMode,
                    paused: state.isPaused)
                guard shouldWaitForConnection else { return }
                await self.scheduleFirstRunOnboardingIfNeeded(
                    gatewayConnected: ControlChannel.shared.state == .connected)
            }
        }
        TerminationSignalWatcher.shared.start()
        NodePairingApprovalPrompter.shared.start()
        DevicePairingApprovalPrompter.shared.start()
        ExecApprovalsPromptServer.shared.start()
        ExecApprovalsGatewayPrompter.shared.start()
        MacNodeModeCoordinator.shared.start()
        VoiceWakeGlobalSettingsSync.shared.start()
        QuickChatController.shared.start()
        Task { PresenceReporter.shared.start() }
        Task { await HealthStore.shared.refresh(onDemand: true) }
        Task { await PortGuardian.shared.sweep(mode: AppStateStore.shared.connectionMode) }
        AppStateStore.shared.applyPeekabooBridgeHostState()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            if !PostUpdateController.shared.startIfNeeded() {
                CLIInstallPrompter.shared.checkAndPromptIfNeeded(reason: "launch")
            }
        }
        Task {
            try? await Task.sleep(for: .seconds(2))
            DashboardManager.shared.preloadIfConfigured()
        }

        #if DEBUG
        // Screenshot/demo helper: show the pairing panel with sample requests.
        if ProcessInfo.processInfo.environment["OPENCLAW_DEBUG_PAIRING_DEMO"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                DebugActions.showPairingPanelDemo()
            }
        }
        #endif
        // Developer/testing helper: auto-open chat when launched with --chat (or legacy --webchat).
        if CommandLine.arguments.contains("--chat") || CommandLine.arguments.contains("--webchat") {
            self.webChatAutoLogger.debug("Auto-opening chat via CLI flag")
            Task { @MainActor in
                let sessionKey = await WebChatManager.shared.preferredSessionKey()
                WebChatManager.shared.show(sessionKey: sessionKey)
            }
        }
        if CommandLine.arguments.contains("--dashboard") {
            self.webChatAutoLogger.info("Auto-opening dashboard via CLI flag")
            Task { @MainActor in
                if DashboardManager.shared.showConfiguredWindowIfPossible() {
                    return
                }
                do {
                    try await DashboardManager.shared.show()
                } catch {
                    DashboardManager.shared.showFailure(error)
                }
            }
        }
    }

    func applicationWillTerminate(_: Notification) {
        QuickChatController.shared.stop()
        PresenceReporter.shared.stop()
        NodePairingApprovalPrompter.shared.stop()
        DevicePairingApprovalPrompter.shared.stop()
        ExecApprovalsPromptServer.shared.stop()
        ExecApprovalsGatewayPrompter.shared.stop()
        MacNodeModeCoordinator.shared.stop()
        TerminationSignalWatcher.shared.stop()
        VoiceWakeGlobalSettingsSync.shared.stop()
        DashboardManager.shared.close()
        WebChatManager.shared.close()
        WebChatManager.shared.resetTunnels()
        Task { await RemoteTunnelManager.shared.stopAll() }
        Task { await GatewayConnection.shared.shutdown() }
        Task { await PeekabooBridgeHostCoordinator.shared.stop() }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if self.terminationCleanupFinished {
            return .terminateNow
        }
        guard self.terminationCleanupTask == nil else {
            return .terminateLater
        }
        let cleanup = self.nodeTerminationCleanup
        self.terminationCleanupTask = Task { @MainActor [weak self] in
            await cleanup()
            self?.finishTerminationCleanup(for: sender)
        }
        let waitForDeadline = self.waitForTerminationCleanupDeadline
        self.terminationDeadlineTask = Task { @MainActor [weak self] in
            await waitForDeadline()
            guard !Task.isCancelled else { return }
            self?.finishTerminationCleanup(for: sender)
        }
        return .terminateLater
    }

    private func finishTerminationCleanup(for sender: NSApplication) {
        guard !self.terminationCleanupFinished else { return }
        // Cleanup may ignore cancellation while transport or input teardown is stuck.
        // The deadline replies without awaiting that loser; this gate keeps the reply single.
        self.terminationCleanupFinished = true
        self.terminationCleanupTask?.cancel()
        self.terminationDeadlineTask?.cancel()
        self.terminationCleanupTask = nil
        self.terminationDeadlineTask = nil
        self.applicationTerminationReply(sender, true)
    }

    @MainActor
    static func shouldOpenDashboardInsteadOfOnboarding(
        connectionMode: AppState.ConnectionMode,
        onboardingSeen: Bool,
        systemAgentResumePending: Bool,
        gatewayConnected: Bool,
        configuredInferenceModel: String?) -> Bool
    {
        let model = configuredInferenceModel?.trimmingCharacters(in: .whitespacesAndNewlines)
        return connectionMode != .unconfigured &&
            !onboardingSeen &&
            !systemAgentResumePending &&
            gatewayConnected &&
            model?.isEmpty == false
    }

    static func isCurrentFirstRunInferenceProbe(
        expectedConnectionMode: AppState.ConnectionMode,
        currentConnectionMode: AppState.ConnectionMode,
        expectedRouteIdentity: String?,
        currentRouteIdentity: String?,
        gatewayRouteIsCurrent: Bool) -> Bool
    {
        expectedConnectionMode != .unconfigured &&
            expectedConnectionMode == currentConnectionMode &&
            expectedRouteIdentity != nil &&
            expectedRouteIdentity == currentRouteIdentity &&
            gatewayRouteIsCurrent
    }

    static func shouldPresentScheduledFirstRunOnboarding(
        expectedConnectionMode: AppState.ConnectionMode,
        currentConnectionMode: AppState.ConnectionMode,
        expectedRouteIdentity: String?,
        currentRouteIdentity: String?,
        onboardingSeen: Bool) -> Bool
    {
        !onboardingSeen &&
            expectedConnectionMode == currentConnectionMode &&
            expectedRouteIdentity == currentRouteIdentity
    }

    private func scheduleFirstRunOnboardingIfNeeded(gatewayConnected: Bool) async {
        let connectionMode = AppStateStore.shared.connectionMode
        let expectedRouteIdentity = OnboardingSystemAgentResumeStore.selectedRouteIdentity()
        var configuredInferenceModel: String?
        if connectionMode != .unconfigured,
           !AppStateStore.shared.onboardingSeen,
           gatewayConnected
        {
            guard let route = await GatewayConnection.shared.captureRoute() else {
                self.scheduleFirstRunOnboardingRecovery()
                return
            }
            // Bind inference discovery to the connected route. A socket without a
            // default-agent model cannot run OpenClaw and must stay in onboarding.
            do {
                configuredInferenceModel = try await GatewayConnection.shared.configuredInferenceModel(
                    ifCurrentRoute: route)
            } catch {
                // A transient read failure is not evidence that inference is absent.
                // Onboarding retries the same read without mutating on failure.
                self.scheduleFirstRunOnboardingRecovery()
                return
            }
            let gatewayRouteIsCurrent = await GatewayConnection.shared.isCurrentRoute(route)
            let currentRouteIdentity = OnboardingSystemAgentResumeStore.selectedRouteIdentity()
            guard Self.isCurrentFirstRunInferenceProbe(
                expectedConnectionMode: connectionMode,
                currentConnectionMode: AppStateStore.shared.connectionMode,
                expectedRouteIdentity: expectedRouteIdentity,
                currentRouteIdentity: currentRouteIdentity,
                gatewayRouteIsCurrent: gatewayRouteIsCurrent)
            else {
                self.scheduleFirstRunOnboardingRecovery()
                return
            }
        }
        let onboardingSeen = AppStateStore.shared.onboardingSeen
        let systemAgentResumePending = OnboardingSystemAgentResumeStore.isPending(for: expectedRouteIdentity)
        let shouldOpenDashboard = Self.shouldOpenDashboardInsteadOfOnboarding(
            connectionMode: connectionMode,
            onboardingSeen: onboardingSeen,
            systemAgentResumePending: systemAgentResumePending,
            gatewayConnected: gatewayConnected,
            configuredInferenceModel: configuredInferenceModel)
        if connectionMode != .unconfigured, onboardingSeen || shouldOpenDashboard {
            // Completion flags do not own any route's activation receipt.
            OnboardingController.markComplete()
            if shouldOpenDashboard {
                self.openDashboardAction()
            }
            return
        }
        self.scheduleFirstRunOnboardingPresentation(
            expectedConnectionMode: connectionMode,
            expectedRouteIdentity: expectedRouteIdentity)
    }

    private func scheduleFirstRunOnboardingRecovery() {
        self.scheduleFirstRunOnboardingPresentation(
            expectedConnectionMode: AppStateStore.shared.connectionMode,
            expectedRouteIdentity: OnboardingSystemAgentResumeStore.selectedRouteIdentity())
    }

    private func scheduleFirstRunOnboardingPresentation(
        expectedConnectionMode: AppState.ConnectionMode,
        expectedRouteIdentity: String?)
    {
        let seenVersion = UserDefaults.standard.integer(forKey: onboardingVersionKey)
        let shouldShow = seenVersion < currentOnboardingVersion || !AppStateStore.shared.onboardingSeen
        guard shouldShow else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            let currentRouteIdentity = OnboardingSystemAgentResumeStore.selectedRouteIdentity()
            guard Self.shouldPresentScheduledFirstRunOnboarding(
                expectedConnectionMode: expectedConnectionMode,
                currentConnectionMode: AppStateStore.shared.connectionMode,
                expectedRouteIdentity: expectedRouteIdentity,
                currentRouteIdentity: currentRouteIdentity,
                onboardingSeen: AppStateStore.shared.onboardingSeen)
            else { return }
            OnboardingController.shared.show()
        }
    }

    private func isDuplicateInstance() -> Bool {
        guard let bundleID = Bundle.main.bundleIdentifier else { return false }
        let running = NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == bundleID }
        return running.count > 1
    }
}

// MARK: - Sparkle updater (disabled for unsigned/dev builds)

@MainActor
protocol UpdaterProviding: AnyObject {
    var automaticallyChecksForUpdates: Bool { get set }
    var automaticallyDownloadsUpdates: Bool { get set }
    var isAvailable: Bool { get }
    var updateStatus: UpdateStatus { get }
    func start()
    func checkForUpdates(_ sender: Any?)
}

extension UpdaterProviding {
    func start() {}
}

/// No-op updater used for debug/dev runs to suppress Sparkle dialogs.
final class DisabledUpdaterController: UpdaterProviding {
    var automaticallyChecksForUpdates: Bool = false
    var automaticallyDownloadsUpdates: Bool = false
    let isAvailable: Bool = false
    let updateStatus = UpdateStatus()
    func checkForUpdates(_: Any?) {}
}

@MainActor
@Observable
final class UpdateStatus {
    static let disabled = UpdateStatus()
    var isUpdateReady: Bool

    init(isUpdateReady: Bool = false) {
        self.isUpdateReady = isUpdateReady
    }
}

#if canImport(Sparkle)
import Sparkle

@MainActor
final class SparkleUpdaterController: NSObject, UpdaterProviding {
    private lazy var controller = SPUStandardUpdaterController(
        startingUpdater: false,
        updaterDelegate: self,
        userDriverDelegate: nil)
    let updateStatus = UpdateStatus()
    private var started = false

    init(savedAutoUpdate: Bool) {
        super.init()
        let updater = self.controller.updater
        updater.automaticallyChecksForUpdates = savedAutoUpdate
        updater.automaticallyDownloadsUpdates = savedAutoUpdate
    }

    func start() {
        guard !self.started else { return }
        self.started = true
        self.controller.startUpdater()
    }

    var automaticallyChecksForUpdates: Bool {
        get { self.controller.updater.automaticallyChecksForUpdates }
        set { self.controller.updater.automaticallyChecksForUpdates = newValue }
    }

    var automaticallyDownloadsUpdates: Bool {
        get { self.controller.updater.automaticallyDownloadsUpdates }
        set { self.controller.updater.automaticallyDownloadsUpdates = newValue }
    }

    var isAvailable: Bool {
        self.started
    }

    func checkForUpdates(_ sender: Any?) {
        guard self.started else { return }
        self.controller.checkForUpdates(sender)
    }

    func updater(_: SPUUpdater, didDownloadUpdate _: SUAppcastItem) {
        self.updateStatus.isUpdateReady = true
    }

    func updater(_: SPUUpdater, failedToDownloadUpdate _: SUAppcastItem, error _: Error) {
        self.updateStatus.isUpdateReady = false
    }

    func userDidCancelDownload(_: SPUUpdater) {
        self.updateStatus.isUpdateReady = false
    }

    // periphery:ignore - Sparkle invokes this optional Objective-C delegate callback dynamically.
    func updater(
        _: SPUUpdater,
        userDidMakeChoice choice: SPUUserUpdateChoice,
        forUpdate _: SUAppcastItem,
        state: SPUUserUpdateState)
    {
        switch choice {
        case .install, .skip:
            self.updateStatus.isUpdateReady = false
        case .dismiss:
            self.updateStatus.isUpdateReady = (state.stage == .downloaded)
        @unknown default:
            self.updateStatus.isUpdateReady = false
        }
    }
}

func allowedSparkleChannels(forGatewayUpdateChannel channel: String?) -> Set<String> {
    switch channel {
    case "beta", "dev":
        ["beta"]
    default:
        []
    }
}

extension SparkleUpdaterController: SPUUpdaterDelegate {
    func allowedChannels(for _: SPUUpdater) -> Set<String> {
        allowedSparkleChannels(forGatewayUpdateChannel: OpenClawConfigFile.gatewayUpdateChannel())
    }

    func updater(_: SPUUpdater, willInstallUpdate item: SUAppcastItem) {
        guard let currentVersion = GatewayEnvironment.appVersionString() else { return }
        PostAppUpdateReceiptStore.record(
            fromVersion: currentVersion,
            toVersion: item.displayVersionString)
    }
}

private func isDeveloperIDSigned(bundleURL: URL) -> Bool {
    var staticCode: SecStaticCode?
    guard SecStaticCodeCreateWithPath(bundleURL as CFURL, SecCSFlags(), &staticCode) == errSecSuccess,
          let code = staticCode
    else { return false }

    var infoCF: CFDictionary?
    guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &infoCF) == errSecSuccess,
          let info = infoCF as? [String: Any],
          let certs = info[kSecCodeInfoCertificates as String] as? [SecCertificate],
          let leaf = certs.first
    else {
        return false
    }

    if let summary = SecCertificateCopySubjectSummary(leaf) as String? {
        return summary.hasPrefix("Developer ID Application:")
    }
    return false
}

@MainActor
private func makeUpdaterController() -> UpdaterProviding {
    let bundleURL = Bundle.main.bundleURL
    let isBundledApp = bundleURL.pathExtension == "app"
    guard isBundledApp, isDeveloperIDSigned(bundleURL: bundleURL) else { return DisabledUpdaterController() }

    let defaults = UserDefaults.standard
    let autoUpdateKey = "autoUpdateEnabled"
    // Default to true; honor the user's last choice otherwise.
    let savedAutoUpdate = (defaults.object(forKey: autoUpdateKey) as? Bool) ?? true
    return SparkleUpdaterController(savedAutoUpdate: savedAutoUpdate)
}
#else
@MainActor
private func makeUpdaterController() -> UpdaterProviding {
    DisabledUpdaterController()
}
#endif
