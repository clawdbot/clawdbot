import AppKit
import Darwin
import Dispatch
import Foundation
import OpenClawKit
import OSLog
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
    private var tailscaleService: TailscaleService {
        .shared
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
        Window("OpenClaw Settings", id: SettingsWindowOpener.windowID) {
            SettingsRootView(state: self.state, updater: self.delegate.updaterController)
                .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight, alignment: .topLeading)
                .environment(self.tailscaleService)
                .background(SettingsWindowOpenRegistrar())
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

    private static func applyAttachOnlyOverrideIfNeeded(plan: AppLaunchRuntimePlan) {
        guard plan.attachOnly else { return }
        if let error = GatewayLaunchAgentManager.applyAttachOnlyRuntimeOverride() {
            self.logger.error("attach-only flag failed: \(error, privacy: .public)")
            return
        }
        self.logger.info("attach-only flag enabled")
    }
}

struct SettingsWindowOpenRegistrar: View {
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
    private var statusMenuController: StatusMenuController?
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

    func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool {
        false
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
        if launchPlan.allowsInteractiveServices, let state {
            let controller = StatusMenuController(state: state, updater: self.updaterController)
            controller.start()
            self.statusMenuController = controller
        }
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
        self.statusMenuController?.stop()
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
