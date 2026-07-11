import AppKit
import Observation
import OpenClawChatUI
import OpenClawDiscovery
import OpenClawIPC
import SwiftUI

enum UIStrings {
    static let welcomeTitle = "Welcome to OpenClaw"
}

enum RemoteOnboardingProbeState: Equatable {
    case idle
    case checking
    case ok(RemoteGatewayProbeSuccess)
    case failed(String)
}

@MainActor
final class OnboardingController: NSObject, NSWindowDelegate {
    static let shared = OnboardingController()
    static let windowStyleMask: NSWindow.StyleMask = [.titled, .closable, .resizable, .fullSizeContentView]
    private var window: NSWindow?
    /// Human description of work in flight ("Installing the Gateway…").
    /// While set, closing the window asks for confirmation instead of quitting
    /// setup mid-operation.
    var busyReason: String?

    static func markComplete() {
        UserDefaults.standard.set(true, forKey: onboardingSeenKey)
        UserDefaults.standard.set(currentOnboardingVersion, forKey: onboardingVersionKey)
        AppStateStore.shared.onboardingSeen = true
    }

    func show() {
        if ProcessInfo.processInfo.isNixMode {
            // Nix mode is fully declarative; onboarding would suggest interactive setup that doesn't apply.
            Self.markComplete()
            return
        }
        if let window {
            DockIconManager.shared.temporarilyShowDock()
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let hosting = NSHostingController(rootView: OnboardingView())
        let window = NSWindow(contentViewController: hosting)
        window.title = UIStrings.welcomeTitle
        window.setContentSize(NSSize(width: OnboardingView.windowWidth, height: OnboardingView.windowHeight))
        window.styleMask = Self.windowStyleMask
        // Keep the focused dialog width while letting taller displays give setup more breathing room.
        window.contentMinSize = NSSize(width: OnboardingView.windowWidth, height: OnboardingView.windowHeight)
        window.contentMaxSize = NSSize(width: OnboardingView.windowWidth, height: .greatestFiniteMagnitude)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.delegate = self
        window.center()
        DockIconManager.shared.temporarilyShowDock()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
    }

    func close() {
        self.busyReason = nil
        self.window?.close()
        self.window = nil
    }

    func setWindowCloseEnabled(_ enabled: Bool) {
        self.window?.standardWindowButton(.closeButton)?.isEnabled = enabled
    }

    func restart() {
        self.close()
        self.show()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard let busyReason else { return true }
        let alert = NSAlert()
        alert.messageText = "Setup is still working"
        alert.informativeText =
            "\(busyReason)\n\nYou can keep this window open until it finishes, " +
            "or quit setup and pick it up again later from the menu bar."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Continue Setup")
        alert.addButton(withTitle: "Quit Setup")
        let response = alert.runModal()
        return response == .alertSecondButtonReturn
    }

    func windowWillClose(_ notification: Notification) {
        guard let closing = notification.object as? NSWindow, closing === self.window else { return }
        self.busyReason = nil
        self.window = nil
    }
}

struct OnboardingView: View {
    enum CLIInstallPhase {
        case idle
        case installing
        case startingService
    }

    @State var currentPage = 0
    @State var isRequesting = false
    @State var installingCLI = false
    @State var cliInstallPhase: CLIInstallPhase = .idle
    @State var cliStatus: String?
    @State var copied = false
    @State var monitoringPermissions = false
    @State var monitoringDiscovery = false
    @State var cliExecutableReady = false
    @State var cliInstalled = false
    @State var cliStatusKnown = false
    @State var onboardingVisible = false
    @State var cliInstallLocation: String?
    @State var workspacePath: String = ""
    @State var workspaceStatus: String?
    @State var workspaceApplying = false
    @State var needsBootstrap = false
    @State var didAutoKickoff = false
    @State var showAdvancedConnection = false
    @State var showRemoteChoices = false
    @State var preferredGatewayID: String?
    @State var remoteProbeState: RemoteOnboardingProbeState = .idle
    @State var remoteAuthIssue: RemoteGatewayAuthIssue?
    @State var suppressRemoteProbeReset = false
    @State var gatewayDiscovery: GatewayDiscoveryModel
    @State var onboardingChatModel: OpenClawChatViewModel
    @State var onboardingSkillsModel = SkillsSettingsModel()
    @State var crestodianState = OnboardingCrestodianChatState()
    @State var aiSetup = OnboardingAISetupModel()
    @State var didLoadOnboardingSkills = false
    @State var localGatewayProbe: LocalGatewayProbe?
    @State var defaultsToLocalGateway: Bool
    @Bindable var state: AppState
    var permissionMonitor: PermissionMonitor

    static let windowWidth: CGFloat = 630
    static let windowHeight: CGFloat = 752 // ~+10% to fit full onboarding content

    let pageWidth: CGFloat = Self.windowWidth
    let connectionPageIndex = 1
    let cliPageIndex = 2
    let aiPageIndex = 3
    let onboardingChatPageIndex = 8

    let permissionsPageIndex = 5

    /// Only the full-page chat shrinks the mascot so the conversation gets the room.
    var usesCompactHero: Bool {
        Self.shouldUseCompactHero(
            activePageIndex: self.activePageIndex,
            onboardingChatPageIndex: self.onboardingChatPageIndex)
    }

    static func shouldUseCompactHero(activePageIndex: Int, onboardingChatPageIndex: Int) -> Bool {
        activePageIndex == onboardingChatPageIndex
    }

    var heroFrameHeight: CGFloat {
        self.usesCompactHero ? 78 : 145
    }

    var heroSize: CGFloat {
        self.usesCompactHero ? 64 : 130
    }

    /// The baseline fits every setup control. Taller windows donate all extra room
    /// to the active page instead of leaving the content pinned to a fixed canvas.
    func contentHeight(for windowHeight: CGFloat) -> CGFloat {
        Self.contentHeight(for: windowHeight, usesCompactHero: self.usesCompactHero)
    }

    static func contentHeight(for windowHeight: CGFloat, usesCompactHero: Bool) -> CGFloat {
        let availableHeight = max(Self.windowHeight, windowHeight)
        let heroHeight: CGFloat = usesCompactHero ? 78 : 145
        return availableHeight - heroHeight - 72
    }

    static func pageOrder(
        for mode: AppState.ConnectionMode,
        showOnboardingChat: Bool,
        requiresCLIInstall: Bool) -> [Int]
    {
        switch mode {
        case .remote:
            // Remote setup doesn't need local gateway/CLI/workspace setup pages,
            // but the AI check runs against the remote gateway so a broken
            // remote model surfaces here, not in the first chat.
            return showOnboardingChat ? [0, 1, 3, 5, 8, 9] : [0, 1, 3, 5, 9]
        case .unconfigured:
            return showOnboardingChat ? [0, 1, 8, 9] : [0, 1, 9]
        case .local:
            let setupPages = requiresCLIInstall ? [0, 1, 2, 3, 5] : [0, 1, 3, 5]
            return showOnboardingChat ? setupPages + [8, 9] : setupPages + [9]
        }
    }

    var showOnboardingChat: Bool {
        self.state.connectionMode == .local && self.needsBootstrap
    }

    var selectedConnectionMode: AppState.ConnectionMode {
        if self.isConnectionSelectionBlocking {
            return .local
        }
        return self.state.connectionMode
    }

    var isConnectionSelectionBlocking: Bool {
        self.defaultsToLocalGateway && self.state.connectionMode == .unconfigured
    }

    var pageOrder: [Int] {
        Self.pageOrder(
            for: self.state.connectionMode,
            showOnboardingChat: self.showOnboardingChat,
            requiresCLIInstall: self.state.connectionMode == .local && !self.cliInstalled)
    }

    var pageCount: Int {
        self.pageOrder.count
    }

    var activePageIndex: Int {
        self.activePageIndex(for: self.currentPage)
    }

    var buttonTitle: String {
        self.currentPage == self.pageCount - 1 ? "Finish" : "Next"
    }

    var isCLIBlocking: Bool {
        self.activePageIndex == self.cliPageIndex && !self.cliInstalled
    }

    /// Onboarding must not finish without working inference: the AI page
    /// blocks Next until a candidate passed its live test (config is authored
    /// server-side on that success). "Configure later" on the connection page
    /// remains the explicit skip path.
    var isAISetupBlocking: Bool {
        Self.shouldBlockAISetup(
            currentPage: self.currentPage,
            pageOrder: self.pageOrder,
            aiPageIndex: self.aiPageIndex,
            connectionMode: self.state.connectionMode,
            connected: self.aiSetup.connected)
    }

    static func shouldBlockAISetup(
        currentPage: Int,
        pageOrder: [Int],
        aiPageIndex: Int,
        connectionMode: AppState.ConnectionMode,
        connected: Bool) -> Bool
    {
        guard connectionMode != .unconfigured,
              !connected,
              let aiPageCursor = pageOrder.firstIndex(of: aiPageIndex)
        else {
            return false
        }
        return currentPage >= aiPageCursor
    }

    var canAdvance: Bool {
        !self.isCLIBlocking && !self.isAISetupBlocking
    }

    struct LocalGatewayProbe: Equatable {
        let port: Int
        let pid: Int32
        let command: String
        let expected: Bool
    }

    init(
        state: AppState = AppStateStore.shared,
        permissionMonitor: PermissionMonitor = .shared,
        discoveryModel: GatewayDiscoveryModel = GatewayDiscoveryModel(
            localDisplayName: InstanceIdentity.displayName,
            filterLocalGateways: false))
    {
        self.state = state
        self.permissionMonitor = permissionMonitor
        self._defaultsToLocalGateway = State(
            initialValue: !state.onboardingSeen && state.connectionMode == .unconfigured)
        self._gatewayDiscovery = State(initialValue: discoveryModel)
        self._onboardingChatModel = State(
            initialValue: OpenClawChatViewModel(
                sessionKey: "onboarding",
                transport: MacGatewayChatTransport()))
    }
}
