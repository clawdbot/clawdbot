import AppKit
import Darwin
import Foundation
import MenuBarExtraAccess
import Observation
import OSLog
import Security
import SwiftUI

@main
struct MoltbotApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var state: AppState
    private static let logger = Logger(subsystem: "bot.molt", category: "app")
    private let gatewayManager = GatewayProcessManager.shared
    private let controlChannel = ControlChannel.shared
    private let activityStore = WorkActivityStore.shared
    private let connectivityCoordinator = GatewayConnectivityCoordinator.shared
    @State private var statusItem: NSStatusItem?
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
        MoltbotLogging.bootstrapIfNeeded()
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
                iconState: self.effectiveIconState)
        }
        .menuBarExtraStyle(.menu)
        .menuBarExtraAccess(isPresented: self.$isMenuPresented) { item in
            self.statusItem = item
            MenuSessionsInjector.shared.install(into: item)
            self.applyStatusItemAppearance(paused: self.state.isPaused, sleeping: self.isGatewaySleeping)
            self.installStatusItemMouseHandler(for: item)
            self.updateHoverHUDSuppression()
        }
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
        .onChange(of: self.state.connectionMode) { _, mode in
            Task { await ConnectionModeCoordinator.shared.apply(mode: mode, paused: self.state.isPaused) }
            CLIInstallPrompter.shared.checkAndPromptIfNeeded(reason: "connection-mode")
        }

        Settings {
            SettingsRootView(state: self.state, updater: self.delegate.updaterController)
                .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight, alignment: .topLeading)
                .environment(self.tailscaleService)
        }
        .defaultSize(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
        .windowResizability(.contentSize)
        .onChange(of: self.isMenuPresented) { _, _ in
            self.updateStatusHighlight()
            self.updateHoverHUDSuppression()
        }
    }

    private func applyStatusItemAppearance(paused: Bool, sleeping: Bool) {
        self.statusItem?.button?.appearsDisabled = paused || sleeping
    }

    private static func applyAttachOnlyOverrideIfNeeded() {
        let args = CommandLine.arguments
        guard args.contains("--attach-only") || args.contains("--no-launchd") else { return }
        if let error = GatewayLaunchAgentManager.setLaunchAgentWriteDisabled(true) {
            Self.logger.error("attach-only flag failed: \(error, privacy: .public)")
            return
        }
        Task {
            _ = await GatewayLaunchAgentManager.set(
                enabled: false,
                bundlePath: Bundle.main.bundlePath,
                port: GatewayEnvironment.gatewayPort())
        }
        Self.logger.info("attach-only flag enabled")
    }

    private var isGatewaySleeping: Bool {
        if self.state.isPaused { return false }
        switch self.state.connectionMode {
        case .unconfigured:
            return true
        case .remote:
            if case .connected = self.controlChannel.state { return false }
            return true
        case .local:
            switch self.gatewayManager.status {
            case .running, .starting, .attachedExisting:
                if case .connected = self.controlChannel.state { return false }
                return true
            case .failed, .stopped:
                return true
            }
        }
    }

    @MainActor
    private func installStatusItemMouseHandler(for item: NSStatusItem) {
        guard let button = item.button else { return }
        if button.subviews.contains(where: { $0 is StatusItemMouseHandlerView }) { return }

        WebChatManager.shared.onPanelVisibilityChanged = { [self] visible in
            self.isPanelVisible = visible
            self.updateStatusHighlight()
            self.updateHoverHUDSuppression()
        }
        CanvasManager.shared.onPanelVisibilityChanged = { [self] visible in
            self.state.canvasPanelVisible = visible
        }
        CanvasManager.shared.defaultAnchorProvider = { [self] in self.statusButtonScreenFrame() }

        let handler = StatusItemMouseHandlerView()
        handler.translatesAutoresizingMaskIntoConstraints = false
        handler.onLeftClick = { [self] in
            HoverHUDController.shared.dismiss(reason: "statusItemClick")
            self.toggleWebChatPanel()
        }
        handler.onRightClick = { [self] in
            HoverHUDController.shared.dismiss(reason: "statusItemRightClick")
            WebChatManager.shared.closePanel()
            self.isMenuPresented = true
            self.updateStatusHighlight()
        }
        handler.onHoverChanged = { [self] inside in
            HoverHUDController.shared.statusItemHoverChanged(
                inside: inside,
                anchorProvider: { [self] in self.statusButtonScreenFrame() })
        }

        button.addSubview(handler)
        NSLayoutConstraint.activate([
            handler.leadingAnchor.constraint(equalTo: button.leadingAnchor),
            handler.trailingAnchor.constraint(equalTo: button.trailingAnchor),
            handler.topAnchor.constraint(equalTo: button.topAnchor),
            handler.bottomAnchor.constraint(equalTo: button.bottomAnchor),
        ])
    }

    @MainActor
    private func toggleWebChatPanel() {
        HoverHUDController.shared.setSuppressed(true)
        self.isMenuPresented = false
        Task { @MainActor in
            let sessionKey = await WebChatManager.shared.preferredSessionKey()
            WebChatManager.shared.togglePanel(
                sessionKey: sessionKey,
                anchorProvider: { [self] in self.statusButtonScreenFrame() })
        }
    }

    @MainActor
    private func statusButtonScreenFrame() -> NSRect? {
        guard let button = self.statusItem?.button, let window = button.window else { return nil }
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

/// Transparent overlay that intercepts clicks without stealing MenuBarExtra ownership.
private final class StatusItemMouseHandlerView: NSView {
    var onLeftClick: (() -> Void)?
    var onRightClick: (() -> Void)?
    var onHoverChanged: ((Bool) -> Void)?
    private var tracking: NSTrackingArea?

    override func mouseDown(with event: NSEvent) {
        if let onLeftClick {
            onLeftClick()
        } else {
            super.mouseDown(with: event)
        }
    }

    override func rightMouseDown(with event: NSEvent) {
        self.onRightClick?()
        // Do not call super; menu will be driven by isMenuPresented binding.
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking {
            self.removeTrackingArea(tracking)
        }
        let options: NSTrackingArea.Options = [
            .mouseEnteredAndExited,
            .activeAlways,
            .inVisibleRect,
        ]
        let area = NSTrackingArea(rect: self.bounds, options: options, owner: self, userInfo: nil)
        self.addTrackingArea(area)
        self.tracking = area
    }

    override func mouseEntered(with event: NSEvent) {
        self.onHoverChanged?(true)
    }

    override func mouseExited(with event: NSEvent) {
        self.onHoverChanged?(false)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var state: AppState?
    private let webChatAutoLogger = Logger(subsystem: "bot.molt", category: "Chat")
    let updaterController: UpdaterProviding = makeUpdaterController()

    func application(_: NSApplication, open urls: [URL]) {
        Task { @MainActor in
            for url in urls {
                await DeepLinkHandler.shared.handle(url: url)
            }
        }
    }

    @MainActor
    func applicationDidFinishLaunching(_ notification: Notification) {
        if self.isDuplicateInstance() {
            NSApp.terminate(nil)
            return
        }
        self.state = AppStateStore.shared
        AppActivationPolicy.apply(showDockIcon: self.state?.showDockIcon ?? false)
        if let state {
            Task { await ConnectionModeCoordinator.shared.apply(mode: state.connectionMode, paused: state.isPaused) }
        }
        TerminationSignalWatcher.shared.start()
        NodePairingApprovalPrompter.shared.start()
        DevicePairingApprovalPrompter.shared.start()
        ExecApprovalsPromptServer.shared.start()
        ExecApprovalsGatewayPrompter.shared.start()
        MacNodeModeCoordinator.shared.start()
        VoiceWakeGlobalSettingsSync.shared.start()
        Task { PresenceReporter.shared.start() }
        Task { await HealthStore.shared.refresh(onDemand: true) }
        Task { await PortGuardian.shared.sweep(mode: AppStateStore.shared.connectionMode) }
        Task { await PeekabooBridgeHostCoordinator.shared.setEnabled(AppStateStore.shared.peekabooBridgeEnabled) }
        self.scheduleFirstRunOnboardingIfNeeded()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            CLIInstallPrompter.shared.checkAndPromptIfNeeded(reason: "launch")
        }

        // Developer/testing helper: auto-open chat when launched with --chat (or legacy --webchat).
        if CommandLine.arguments.contains("--chat") || CommandLine.arguments.contains("--webchat") {
            self.webChatAutoLogger.debug("Auto-opening chat via CLI flag")
            Task { @MainActor in
                let sessionKey = await WebChatManager.shared.preferredSessionKey()
                WebChatManager.shared.show(sessionKey: sessionKey)
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        PresenceReporter.shared.stop()
        NodePairingApprovalPrompter.shared.stop()
        DevicePairingApprovalPrompter.shared.stop()
        ExecApprovalsPromptServer.shared.stop()
        ExecApprovalsGatewayPrompter.shared.stop()
        MacNodeModeCoordinator.shared.stop()
        TerminationSignalWatcher.shared.stop()
        VoiceWakeGlobalSettingsSync.shared.stop()
        WebChatManager.shared.close()
        WebChatManager.shared.resetTunnels()
        Task { await RemoteTunnelManager.shared.stopAll() }
        Task { await GatewayConnection.shared.shutdown() }
        Task { await PeekabooBridgeHostCoordinator.shared.stop() }
    }

    @MainActor
    private func scheduleFirstRunOnboardingIfNeeded() {
        let seenVersion = UserDefaults.standard.integer(forKey: onboardingVersionKey)
        let shouldShow = seenVersion < currentOnboardingVersion || !AppStateStore.shared.onboardingSeen
        guard shouldShow else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
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
    func checkForUpdates(_ sender: Any?)
}

// No-op updater used for debug/dev runs to suppress Sparkle dialogs.
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

    init(savedAutoUpdate: Bool) {
        super.init()
        let updater = self.controller.updater
        updater.automaticallyChecksForUpdates = savedAutoUpdate
        updater.automaticallyDownloadsUpdates = savedAutoUpdate
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

    var isAvailable: Bool { true }

    func checkForUpdates(_ sender: Any?) {
        self.controller.checkForUpdates(sender)
    }

    func updater(_ updater: SPUUpdater, didDownloadUpdate item: SUAppcastItem) {
        self.updateStatus.isUpdateReady = true
    }

    func updater(_ updater: SPUUpdater, failedToDownloadUpdate item: SUAppcastItem, error: Error) {
        self.updateStatus.isUpdateReady = false
    }

    func userDidCancelDownload(_ updater: SPUUpdater) {
        self.updateStatus.isUpdateReady = false
    }

    func updater(
        _ updater: SPUUpdater,
        userDidMakeChoice choice: SPUUserUpdateChoice,
        forUpdate updateItem: SUAppcastItem,
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

extension SparkleUpdaterController: @preconcurrency SPUUpdaterDelegate {}

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
