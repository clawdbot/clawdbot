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
final class OnboardingController {
    static let shared = OnboardingController()
    private var window: NSWindow?

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
        window.styleMask = [.titled, .closable, .fullSizeContentView]
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.center()
        DockIconManager.shared.temporarilyShowDock()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
    }

    func close() {
        self.window?.close()
        self.window = nil
    }

    func restart() {
        self.close()
        self.show()
    }
}

struct OnboardingView: View {
    @Environment(\.openSettings) var openSettings
    @State var currentPage = 0
    @State var isRequesting = false
    @State var installingCLI = false
    @State var cliStatus: String?
    @State var copied = false
    @State var monitoringPermissions = false
    @State var monitoringDiscovery = false
    @State var cliInstalled = false
    @State var cliInstallLocation: String?
    @State var workspacePath: String = ""
    @State var workspaceStatus: String?
    @State var workspaceApplying = false
    @State var needsBootstrap = false
    @State var didAutoKickoff = false
    @State var showAdvancedConnection = false
    @State var preferredGatewayID: String?
    @State var remoteProbeState: RemoteOnboardingProbeState = .idle
    @State var remoteAuthIssue: RemoteGatewayAuthIssue?
    @State var suppressRemoteProbeReset = false
    @State var gatewayDiscovery: GatewayDiscoveryModel
    @State var onboardingChatModel: OpenClawChatViewModel
    @State var onboardingSkillsModel = SkillsSettingsModel()
    @State var onboardingWizard = OnboardingWizardModel()
    @State var didLoadOnboardingSkills = false
    @State var localGatewayProbe: LocalGatewayProbe?
    @Bindable var state: AppState
    var permissionMonitor: PermissionMonitor

    static let windowWidth: CGFloat = 630
    static let windowHeight: CGFloat = 752 // ~+10% to fit full onboarding content

    let pageWidth: CGFloat = Self.windowWidth
    let contentHeight: CGFloat = 460
    let connectionPageIndex = 1
    let wizardPageIndex = 3
    let onboardingChatPageIndex = 8

    let permissionsPageIndex = 5
    static func pageOrder(
        for mode: AppState.ConnectionMode,
        showOnboardingChat: Bool) -> [Int]
    {
        switch mode {
        case .remote:
            // Remote setup doesn't need local gateway/CLI/workspace setup pages,
            // and WhatsApp/Telegram setup is optional.
            showOnboardingChat ? [0, 1, 5, 8, 9] : [0, 1, 5, 9]
        case .unconfigured:
            showOnboardingChat ? [0, 1, 8, 9] : [0, 1, 9]
        case .local:
            showOnboardingChat ? [0, 1, 3, 5, 8, 9] : [0, 1, 3, 5, 9]
        }
    }

    var showOnboardingChat: Bool {
        self.state.connectionMode == .local && self.needsBootstrap
    }

    var pageOrder: [Int] {
        Self.pageOrder(for: self.state.connectionMode, showOnboardingChat: self.showOnboardingChat)
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

    var wizardPageOrderIndex: Int? {
        self.pageOrder.firstIndex(of: self.wizardPageIndex)
    }

    var isWizardBlocking: Bool {
        self.activePageIndex == self.wizardPageIndex && !self.onboardingWizard.isComplete
    }

    var canAdvance: Bool {
        !self.isWizardBlocking
    }

    var devLinkCommand: String {
        let version = GatewayEnvironment.expectedGatewayVersionString() ?? "latest"
        return "npm install -g openclaw@\(version)"
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
        self._gatewayDiscovery = State(initialValue: discoveryModel)
        self._onboardingChatModel = State(
            initialValue: OpenClawChatViewModel(
                sessionKey: "onboarding",
                transport: MacGatewayChatTransport()))
    }
}
