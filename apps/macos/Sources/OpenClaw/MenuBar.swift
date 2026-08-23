import AppKit
import Darwin
import Dispatch
import Foundation
import MenuBarExtraAccess
import Observation
import OpenClawKit
import OSLog
import Security
import SwiftUI

/// Routes private maintenance commands before SwiftUI constructs or activates the application.
@main
enum OpenClawProcessMain {
    static func main() {
        if let status = OpenClawProcessEntrypoint.run(arguments: CommandLine.arguments, launchApplication: {
            OpenClawApp.main()
        }) {
            Darwin.exit(status)
        }
    }
}

enum OpenClawProcessEntrypoint {
    static func run(arguments: [String], launchApplication: () -> Void) -> Int32? {
        if let status = ElevationExclusiveRename.runIfRequested(arguments: arguments) {
            return status
        }
        if let status = ElevationFilesystemSync.runIfRequested(arguments: arguments) {
            return status
        }
        launchApplication()
        return nil
    }
}

struct OpenClawApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @Environment(\.openWindow) private var openWindow
    @State private var state: AppState
    private static let logger = Logger(subsystem: "ai.openclaw", category: "app")
    private var gatewayManager: GatewayProcessManager {
        .shared
    }

    private var controlChannel: ControlChannel {
        .shared
    }

    private var activityStore: WorkActivityStore {
        .shared
    }

    @State private var statusItem: NSStatusItem?
    @State private var statusItemMouseRouter = StatusItemMouseRouter()
    @State private var isMenuPresented = false
    @State private var isChatWindowVisible = false
    private var tailscaleService: TailscaleService {
        .shared
    }

    @MainActor
    private func updateStatusHighlight() {
        self.statusItem?.button?.highlight(self.isChatWindowVisible)
    }

    init() {
        let launchPlan = AppLaunchRuntimePlan.current
        if let error = AppProfile.current.validationError {
            if launchPlan.isElevationHost {
                fputs("OpenClaw elevation host profile is invalid: \(error.localizedDescription)\n", stderr)
                Darwin.exit(2)
            }
            let alert = NSAlert()
            alert.alertStyle = .critical
            alert.messageText = "OpenClaw profile is invalid"
            alert.informativeText = error.localizedDescription
            alert.runModal()
            Darwin.exit(2)
        }
        if AppProfile.current.isActive,
           !DeviceIdentityStore.configureStateDirectory(OpenClawPaths.stateDirURL)
        {
            fatalError("Device identity state root was already used before app profile configuration")
        }
        guard GatewayTLSStore.configureKeychainServiceSuffix(AppProfile.current.keychainServiceSuffix) else {
            fatalError("Gateway TLS Keychain namespace was already used by another app profile")
        }
        OpenClawLogging.bootstrapIfNeeded()

        Self.applyAttachOnlyOverrideIfNeeded(plan: launchPlan)
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
                connectionMode: self.state.connectionMode,
                controlChannelState: self.controlChannel.state,
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
            if AppLaunchRuntimePlan.current.allowsAutomaticPresentation {
                CLIInstallPrompter.shared.checkAndPromptIfNeeded(reason: "connection-mode")
            }
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
                Button("New Gateway Window…") {
                    WebChatManager.shared.newGatewayWindow()
                }
                .keyboardShortcut("n", modifiers: .command)

                Button("New Thread") {
                    DashboardManager.shared.dispatchNativeCommand(.newSession)
                }
                .keyboardShortcut("n", modifiers: [.command, .shift])
            }
            CommandGroup(replacing: .appSettings) {
                Button("Settings...") {
                    self.openWindow(id: SettingsWindowOpener.windowID)
                }
                .keyboardShortcut(",", modifiers: .command)
            }
            DashboardGatewayCommands(dashboardManager: DashboardManager.shared)
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

    private static func applyAttachOnlyOverrideIfNeeded(plan: AppLaunchRuntimePlan) {
        guard plan.attachOnly else { return }
        if let error = GatewayLaunchAgentManager.applyAttachOnlyRuntimeOverride() {
            self.logger.error("attach-only flag failed: \(error, privacy: .public)")
            return
        }
        self.logger.info("attach-only flag enabled")
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
        WebChatManager.shared.onChatWindowVisibilityChanged = { [self] visible in
            self.isChatWindowVisible = visible
            self.updateStatusHighlight()
        }
        CanvasManager.shared.onPanelVisibilityChanged = { [self] visible in
            self.state.canvasPanelVisible = visible
        }
        CanvasManager.shared.defaultAnchorProvider = { [self] in self.statusButtonScreenFrame() }

        self.statusItemMouseRouter.install(
            on: item,
            onLeftClick: { [self] in
                self.openDashboardWindow()
            },
            onRightClick: { [self] in
                self.isMenuPresented = true
            })
    }

    @MainActor
    private func openDashboardWindow() {
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
    private var onLeftClick: (() -> Void)?
    private var onRightClick: (() -> Void)?
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
        onRightClick: @escaping () -> Void)
    {
        guard let button = item.button else { return }
        self.install(
            on: button,
            onLeftClick: onLeftClick,
            onRightClick: onRightClick)
    }

    func install(
        on button: NSView,
        onLeftClick: @escaping () -> Void,
        onRightClick: @escaping () -> Void)
    {
        self.onLeftClick = onLeftClick
        self.onRightClick = onRightClick
        self.button = button

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

    private static func contains(_ event: NSEvent, in button: NSView) -> Bool {
        guard let window = button.window, event.windowNumber == window.windowNumber else { return false }
        let point = button.convert(event.locationInWindow, from: nil)
        return button.bounds.contains(point)
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
    private var state: AppState?
    private var terminationCleanupTask: Task<Void, Never>?
    private var terminationDeadlineTask: Task<Void, Never>?
    private var terminationCleanupFinished = false
    private var profileInstanceLock: AppInstanceLock?
    private let webChatAutoLogger = Logger(subsystem: "ai.openclaw", category: "Chat")
    var nodeTerminationCleanup: @MainActor () async -> Void = {
        // CUA shutdown drains the worker before closing the daemon socket; run it
        // first so other cleanup cannot consume the app termination deadline.
        if AppLaunchRuntimePlan.current.allowsCuaComputerControl {
            await CuaDriverHostCoordinator.shared.shutdown()
        }
        await TalkMLXSpeechSynthesizer.shared.shutdown()
        await MacNodeModeCoordinator.shared.stopAndWait()
    }

    var peekabooBridgeTerminationCleanup: @MainActor () async -> Void = {
        await PeekabooBridgeHostCoordinator.shared.shutdown()
    }

    var waitForTerminationCleanupDeadline: @MainActor () async -> Void = {
        try? await Task.sleep(for: .seconds(AppTerminationTiming.cleanupDeadlineSeconds))
    }

    var applicationTerminationReply: @MainActor (NSApplication, Bool) -> Void = { app, allow in
        app.reply(toApplicationShouldTerminate: allow)
    }

    var openDashboardAction: @MainActor () -> Void = { AppNavigationActions.openDashboard() }
    let updaterController: UpdaterProviding

    override init() {
        let environment = ProcessInfo.processInfo.environment
        let hasReplacementMetadata = ApplicationRelocator.hasReplacementHandoffMetadata(
            environment: environment)
        let isReplacementHandoff = hasReplacementMetadata &&
            ApplicationRelocator.acceptReplacementHandoff(environment: environment)
        if hasReplacementMetadata, !isReplacementHandoff {
            fputs("OpenClaw replacement handoff authentication failed.\n", stderr)
            Darwin.exit(2)
        }
        let ownership = AppInstanceLock.acquire(
            url: AppProfile.current.instanceLockURL(),
            waitMilliseconds: isReplacementHandoff ? 5000 : 0)
        if let exitCode = Self.processExitCode(for: ownership) {
            fputs("OpenClaw profile is already running.\n", stderr)
            Darwin.exit(exitCode)
        }
        var profileInstanceLock: AppInstanceLock?
        var instanceOwnershipFailure: String?
        switch ownership {
        case let .acquired(lock):
            profileInstanceLock = lock
        case .busy:
            break
        case let .failed(message):
            instanceOwnershipFailure = message
        }
        self.profileInstanceLock = profileInstanceLock
        self.updaterController = instanceOwnershipFailure == nil
            ? makeUpdaterController()
            : DisabledUpdaterController()
        super.init()
        if let instanceOwnershipFailure {
            if AppLaunchRuntimePlan.current.isElevationHost {
                fputs(
                    "OpenClaw elevation host could not claim its instance lock: \(instanceOwnershipFailure)\n",
                    stderr)
                Darwin.exit(2)
            }
            let alert = NSAlert()
            alert.alertStyle = .critical
            alert.messageText = "OpenClaw could not claim its instance lock"
            alert.informativeText = instanceOwnershipFailure
            alert.runModal()
            Darwin.exit(2)
        }
    }

    static func processExitCode(for ownership: AppInstanceLockAcquisition) -> Int32? {
        if case .busy = ownership { return 0 }
        return nil
    }

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
        guard !AppLaunchRuntimePlan.current.isElevationHost else { return }
        Task { @MainActor in
            for url in urls {
                await DeepLinkHandler.shared.handle(url: url)
            }
        }
    }

    func applicationShouldHandleReopen(_: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        guard AppLaunchRuntimePlan.current.allowsAutomaticPresentation else { return false }
        if flag {
            return true
        }
        self.openDashboardAction()
        return false
    }

    @MainActor
    func applicationDidFinishLaunching(_: Notification) {
        #if DEBUG
        if CommandLine.arguments.contains("--swarm-chat-fixture") {
            AppActivationPolicy.apply(showDockIcon: true)
            WebChatManager.shared.showSwarmFixture()
            return
        }
        #endif
        let launchPlan = AppLaunchRuntimePlan.current
        if !AppProfile.current.isActive, !launchPlan.isElevationHost {
            switch ApplicationRelocator.handleLaunch() {
            case .terminating:
                return
            case let .continueLaunch(startUpdater):
                if startUpdater, launchPlan.allowsUpdater {
                    if OpenClawConfigFile.gatewayUpdateChannel() == nil {
                        self.updaterController.startAfterResolvingGatewayUpdateChannel()
                    } else {
                        self.updaterController.start()
                    }
                }
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
        AppActivationPolicy.apply(showDockIcon: launchPlan.allowsDockIcon && (state?.showDockIcon ?? false))
        if let state {
            let shouldWaitForConnection = state.connectionMode != .unconfigured
            if !shouldWaitForConnection, launchPlan.allowsAutomaticPresentation {
                Task { @MainActor in
                    await self.scheduleFirstRunOnboardingIfNeeded()
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
                guard shouldWaitForConnection, launchPlan.allowsAutomaticPresentation else { return }
                await self.scheduleFirstRunOnboardingIfNeeded()
            }
        }
        TerminationSignalWatcher.shared.start()
        MacNodeModeCoordinator.shared.start()
        if launchPlan.allowsInteractiveServices {
            NodePairingApprovalPrompter.shared.start()
            DevicePairingApprovalPrompter.shared.start()
            ExecApprovalsPromptServer.shared.start()
            ExecApprovalsGatewayPrompter.shared.start()
            if let state {
                CookieSyncManager.shared.start(state: state)
            }
            VoiceWakeGlobalSettingsSync.shared.start()
            QuickChatController.shared.start()
        }
        Task { PresenceReporter.shared.start() }
        Task { await HealthStore.shared.refresh(onDemand: true) }
        Task { await PortGuardian.shared.reapOrphanedTunnels() }
        AppStateStore.shared.applyComputerControlHostState()
        if launchPlan.allowsAutomaticPresentation {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                if !PostUpdateController.shared.startIfNeeded() {
                    CLIInstallPrompter.shared.checkAndPromptIfNeeded(reason: "launch")
                }
            }
        }
        if launchPlan.allowsAutomaticPresentation {
            Task {
                try? await Task.sleep(for: .seconds(2))
                DashboardManager.shared.preloadIfConfigured()
            }
        }

        #if DEBUG
        // Screenshot/demo helper: show the pairing panel with sample requests.
        if launchPlan.allowsAutomaticPresentation,
           ProcessInfo.processInfo.environment["OPENCLAW_DEBUG_PAIRING_DEMO"] == "1"
        {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                DebugActions.showPairingPanelDemo()
            }
        }
        #endif
        // Developer/testing helper: auto-open chat when launched with --chat (or legacy --webchat).
        if launchPlan.shouldAutoOpenChat(arguments: CommandLine.arguments) {
            self.webChatAutoLogger.debug("Auto-opening chat via CLI flag")
            Task { @MainActor in
                let sessionKey = await WebChatManager.shared.preferredSessionKey()
                WebChatManager.shared.show(sessionKey: sessionKey)
            }
        }
        if launchPlan.shouldAutoOpenDashboard(arguments: CommandLine.arguments) {
            self.webChatAutoLogger.info("Auto-opening dashboard via CLI flag")
            self.openDashboardAction()
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
        CookieSyncManager.shared.stop()
        TerminationSignalWatcher.shared.stop()
        VoiceWakeGlobalSettingsSync.shared.stop()
        DashboardManager.shared.close()
        WebChatManager.shared.close()
        WebChatManager.shared.resetTunnels()
        Task { await RemoteTunnelManager.shared.stopAll() }
        Task { await GatewayConnection.shared.shutdown() }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if self.terminationCleanupFinished {
            return .terminateNow
        }
        guard self.terminationCleanupTask == nil else {
            return .terminateLater
        }
        let nodeCleanup = self.nodeTerminationCleanup
        let bridgeCleanup = self.peekabooBridgeTerminationCleanup
        self.terminationCleanupTask = Task { @MainActor [weak self] in
            async let nodeCleanupResult: Void = nodeCleanup()
            async let bridgeCleanupResult: Void = bridgeCleanup()
            _ = await (nodeCleanupResult, bridgeCleanupResult)
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

    static func shouldPresentScheduledFirstRunOnboarding(onboardingSeen: Bool) -> Bool {
        !onboardingSeen
    }

    private func scheduleFirstRunOnboardingIfNeeded() async {
        let connectionMode = AppStateStore.shared.connectionMode
        let onboardingSeen = AppStateStore.shared.onboardingSeen
        if connectionMode != .unconfigured, onboardingSeen {
            OnboardingController.markComplete()
            return
        }
        self.scheduleFirstRunOnboardingPresentation()
    }

    private func scheduleFirstRunOnboardingPresentation() {
        let seenVersion = AppDefaults.standard.integer(forKey: onboardingVersionKey)
        let shouldShow = seenVersion < currentOnboardingVersion || !AppStateStore.shared.onboardingSeen
        guard shouldShow else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            guard Self.shouldPresentScheduledFirstRunOnboarding(
                onboardingSeen: AppStateStore.shared.onboardingSeen)
            else { return }
            OnboardingController.shared.show()
        }
    }
}

enum AppInstanceLockAcquisition {
    case acquired(AppInstanceLock)
    case busy
    case failed(String)
}

final class AppInstanceLock {
    /// Keep the descriptor open for the process lifetime. Never unlink the path:
    /// another opener could then lock a different inode and admit a duplicate.
    private let descriptor: Int32

    private init(descriptor: Int32) {
        self.descriptor = descriptor
    }

    static func acquire(url: URL, waitMilliseconds: Int = 0) -> AppInstanceLockAcquisition {
        if let error = self.preparePrivateStateRoot(url.deletingLastPathComponent()) {
            return .failed(error)
        }
        let descriptor = Darwin.open(url.path, O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
        guard descriptor >= 0 else { return .failed(String(cString: strerror(errno))) }
        var status = stat()
        guard fstat(descriptor, &status) == 0,
              status.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG),
              status.st_uid == geteuid()
        else {
            Darwin.close(descriptor)
            return .failed("Instance lock is not a safe file owned by the current user.")
        }
        _ = fchmod(descriptor, 0o600)
        let deadline = DispatchTime.now() + .milliseconds(max(0, waitMilliseconds))
        while flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
            guard errno == EWOULDBLOCK, DispatchTime.now() < deadline else {
                let result: AppInstanceLockAcquisition = errno == EWOULDBLOCK
                    ? .busy
                    : .failed(String(cString: strerror(errno)))
                Darwin.close(descriptor)
                return result
            }
            usleep(50000)
        }
        return .acquired(AppInstanceLock(descriptor: descriptor))
    }

    private static func preparePrivateStateRoot(_ root: URL) -> String? {
        var status = stat()
        if lstat(root.path, &status) != 0 {
            guard errno == ENOENT else { return String(cString: strerror(errno)) }
            guard mkdir(root.path, 0o700) == 0 else { return String(cString: strerror(errno)) }
            guard lstat(root.path, &status) == 0 else { return String(cString: strerror(errno)) }
        }
        guard status.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
              status.st_uid == geteuid(),
              status.st_mode & 0o777 == 0o700
        else {
            return "App profile state directory must be an owner-only 0700 directory."
        }
        return nil
    }

    deinit {
        _ = flock(self.descriptor, LOCK_UN)
        Darwin.close(self.descriptor)
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
    func startAfterResolvingGatewayUpdateChannel()
    func checkForUpdates(_ sender: Any?)
}

extension UpdaterProviding {
    func start() {}

    func startAfterResolvingGatewayUpdateChannel() {
        self.start()
    }
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
    private var gatewayUpdateChannel: String?
    private var resolvingGatewayUpdateChannel = false
    private let gatewayUpdateChannelResolver: @MainActor @Sendable () async throws -> String?
    private let onStart: (() -> Void)?

    init(
        savedAutoUpdate: Bool,
        gatewayUpdateChannelResolver: (@MainActor @Sendable () async throws -> String?)? = nil,
        onStart: (() -> Void)? = nil)
    {
        self.gatewayUpdateChannelResolver = gatewayUpdateChannelResolver ?? {
            struct UpdateStatusResponse: Decodable {
                let effectiveChannel: String?
            }
            guard let data = try? await GatewayConnection.shared.requestRaw(
                method: "update.status",
                timeoutMs: 5000),
                let response = try? JSONDecoder().decode(UpdateStatusResponse.self, from: data)
            else { return nil }
            return OpenClawConfigFile.normalizedGatewayUpdateChannel(response.effectiveChannel)
        }
        self.onStart = onStart
        super.init()
        let updater = self.controller.updater
        updater.automaticallyChecksForUpdates = savedAutoUpdate
        updater.automaticallyDownloadsUpdates = savedAutoUpdate
    }

    func start() {
        guard !self.started else { return }
        self.started = true
        if let onStart = self.onStart {
            onStart()
        } else {
            self.controller.startUpdater()
        }
    }

    func startAfterResolvingGatewayUpdateChannel() {
        guard !self.started, !self.resolvingGatewayUpdateChannel else { return }
        self.resolvingGatewayUpdateChannel = true
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.resolvingGatewayUpdateChannel = false }
            self.gatewayUpdateChannel = try? await self.gatewayUpdateChannelResolver()
            // Older or unreachable Gateways cannot report effectiveChannel. Preserve
            // their existing stable Sparkle behavior instead of disabling updates.
            self.start()
        }
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
    case "extended-stable":
        ["extended-stable"]
    default:
        []
    }
}

func isSparkleUpdateAllowed(itemChannel: String?, forGatewayUpdateChannel channel: String?) -> Bool {
    channel != "extended-stable" || itemChannel == "extended-stable"
}

extension SparkleUpdaterController: SPUUpdaterDelegate {
    func allowedChannels(for _: SPUUpdater) -> Set<String> {
        allowedSparkleChannels(
            forGatewayUpdateChannel: self.gatewayUpdateChannel ?? OpenClawConfigFile.gatewayUpdateChannel())
    }

    func bestValidUpdate(in appcast: SUAppcast, for _: SPUUpdater) -> SUAppcastItem? {
        guard self.gatewayUpdateChannel ?? OpenClawConfigFile.gatewayUpdateChannel() == "extended-stable" else {
            return nil
        }
        let comparator = SUStandardVersionComparator.default
        let currentVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        // Sparkle always admits the default channel. Filter it here so an
        // extended-stable Gateway is never prompted to leave its release train.
        let eligibleItems = appcast.items.filter {
            guard isSparkleUpdateAllowed(
                itemChannel: $0.channel,
                forGatewayUpdateChannel: "extended-stable")
            else { return false }
            guard let currentVersion else { return true }
            return comparator.compareVersion(
                $0.versionString,
                toVersion: currentVersion) == .orderedDescending
        }
        return eligibleItems.max { left, right in
            comparator.compareVersion(left.versionString, toVersion: right.versionString) == .orderedAscending
        }
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
    guard AppProfile.current.validationError == nil, !AppProfile.current.isActive else {
        return DisabledUpdaterController()
    }
    let bundleURL = Bundle.main.bundleURL
    let isBundledApp = bundleURL.pathExtension == "app"
    guard isBundledApp, isDeveloperIDSigned(bundleURL: bundleURL) else { return DisabledUpdaterController() }

    let defaults = AppDefaults.standard
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
