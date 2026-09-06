import OpenClawChatUI
import OpenClawKit
import SwiftUI
import UIKit

struct RootTabs: View {
    struct SessionObserverTaskIdentity: Equatable {
        let sidebarRefreshID: String
        let isSceneActive: Bool
        let isSidebarVisible: Bool

        var isObserverVisible: Bool {
            self.isSceneActive && self.isSidebarVisible
        }
    }

    @Environment(NodeAppModel.self) private var appModel
    @Environment(VoiceWakeManager.self) private var voiceWake
    @Environment(GatewayConnectionController.self) private var gatewayController
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.displayScale) private var displayScale
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("screen.preventSleep") private var preventSleep: Bool = true
    @AppStorage("onboarding.requestID") private var onboardingRequestID: Int = 0
    @AppStorage("gateway.onboardingComplete") private var onboardingComplete: Bool = false
    @AppStorage("gateway.hasConnectedOnce") private var hasConnectedOnce: Bool = false
    @AppStorage("gateway.preferredStableID") private var preferredGatewayStableID: String = ""
    @AppStorage("gateway.manual.enabled") private var manualGatewayEnabled: Bool = false
    @AppStorage("gateway.manual.host") private var manualGatewayHost: String = ""
    @AppStorage("onboarding.quickSetupDismissed") private var quickSetupDismissed: Bool = false
    @State private var selectedSidebarDestination: SidebarDestination = Self.initialSidebarDestination
    @State private var selectedSettingsRoute: SettingsRoute? =
        Self.initialSettingsRoute ?? Self.initialSidebarDestination.settingsRoute
    @State private var activeSettingsRoute: SettingsRoute? =
        Self.initialSettingsRoute ?? Self.initialSidebarDestination.settingsRoute
    @State private var selectedSettingsRouteRequestID: Int = 0
    @State private var sidebarModel = RootSidebarModel()
    // Embedded Settings rows push onto the sidebar stack; clear it before
    // changing sidebar roots so stale settings detail screens cannot survive.
    @State private var sidebarNavigationPath: [SettingsRoute] = []
    @State private var isSidebarDetailRootVisible: Bool = true
    @State private var isSidebarVisible: Bool = Self.initialSidebarVisibility ?? false
    @State private var sidebarVisibilityUserOverridden: Bool = Self.initialSidebarVisibility != nil
    @State private var isSidebarDrawerLayout: Bool = false
    @State private var didResolveSidebarLayout: Bool = false
    @State private var voiceWakeToastText: String?
    @State private var toastDismissGate = DelayedActionGate()
    @State private var presentedSheet: PresentedSheet?
    @State private var showGatewayProblemDetails: Bool = false
    @State private var gatewayToastDragOffset: CGFloat = 0
    @State private var gatewayRetryFailure: String?
    // Swipe-up hides the toast only until the next problem report.
    @State private var isGatewayToastSwipeDismissed: Bool = false
    @State private var showOnboarding: Bool = false
    @State private var onboardingAllowSkip: Bool = true
    @State private var didEvaluateOnboarding: Bool = false
    @State private var didAutoOpenSettings: Bool = false
    @State private var didApplyInitialChatSession: Bool = false
    @State private var gatewaySetupRequest: GatewaySetupRequest?
    @State private var suppressedExecApprovalForNotificationSettings: NodeAppModel.ExecApprovalInboxKey?

    init(initialSidebarVisibility: Bool? = nil) {
        let resolvedVisibility = initialSidebarVisibility ?? Self.initialSidebarVisibility
        _isSidebarVisible = State(initialValue: resolvedVisibility ?? false)
        _sidebarVisibilityUserOverridden = State(initialValue: resolvedVisibility != nil)
    }

    private static var initialSidebarDestination: SidebarDestination {
        initialDestination(arguments: ProcessInfo.processInfo.arguments)
    }

    private static var initialSettingsRoute: SettingsRoute? {
        requestedInitialSettingsRoute(arguments: ProcessInfo.processInfo.arguments)
    }

    static func initialDestination(arguments: [String]) -> SidebarDestination {
        if self.requestedInitialSettingsRoute(arguments: arguments) != nil {
            return .settings
        }
        if let requested = self.requestedInitialSidebarDestination(arguments: arguments) {
            return requested
        }
        guard let flagIndex = arguments.firstIndex(of: "--openclaw-initial-tab") else { return .chat }
        let valueIndex = arguments.index(after: flagIndex)
        guard arguments.indices.contains(valueIndex) else { return .chat }
        return switch arguments[valueIndex].trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "control", "overview": .overview
        case "chat", "talk", "voice": .chat
        case "agent", "agents": .agents
        case "settings": .settings
        default: .chat
        }
    }

    static func requestedInitialSettingsRoute(arguments: [String]) -> SettingsRoute? {
        guard let flagIndex = arguments.firstIndex(of: "--openclaw-settings-route") else {
            return nil
        }
        let valueIndex = arguments.index(after: flagIndex)
        guard arguments.indices.contains(valueIndex) else { return nil }
        return switch arguments[valueIndex].trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "openclaw", "system-agent": .systemAgent
        default: nil
        }
    }

    static func requestedInitialSidebarDestination(arguments: [String]) -> SidebarDestination? {
        guard let flagIndex = arguments.firstIndex(of: "--openclaw-initial-destination") else {
            return nil
        }
        let valueIndex = arguments.index(after: flagIndex)
        guard arguments.indices.contains(valueIndex) else { return nil }
        let requested = arguments[valueIndex].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return SidebarDestination.allCases.first { $0.rawValue.lowercased() == requested }
    }

    private static var initialSidebarVisibility: Bool? {
        requestedInitialSidebarVisibility(arguments: ProcessInfo.processInfo.arguments)
    }

    private static var initialChatSessionKey: String? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let flagIndex = arguments.firstIndex(of: "--openclaw-chat-session") else {
            return nil
        }
        let valueIndex = arguments.index(after: flagIndex)
        guard arguments.indices.contains(valueIndex) else { return nil }
        let trimmed = arguments[valueIndex].trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private enum PresentedSheet: Identifiable {
        case quickSetup
        case sessionDashboard(sessionKey: String, agentId: String?)

        var id: String {
            switch self {
            case .quickSetup: "quick-setup"
            case let .sessionDashboard(sessionKey, agentId):
                "session-dashboard:\(agentId ?? ""):\(sessionKey)"
            }
        }
    }

    var body: some View {
        self.rootPresentation(
            self.rootLifecycle(
                self.rootOverlays(
                    self.sidebarSplitContent
                        .tint(OpenClawBrand.accent))))
            .overlay(alignment: .topLeading) {
                self.uiTestReadinessMarker
            }
    }

    @ViewBuilder
    private var uiTestReadinessMarker: some View {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--openclaw-ui-test-readiness") {
            Color.clear
                .frame(width: 1, height: 1)
                .allowsHitTesting(false)
                .accessibilityElement(children: .ignore)
                .accessibilityIdentifier("RootTabs.Ready")
                .accessibilityLabel(Text(verbatim: "OpenClaw test readiness"))
                .accessibilityValue(
                    "\(self.scenePhase == .active ? "ready" : "inactive"):\(self.selectedSidebarDestination.rawValue)")
        }
        #endif
    }

    private var sidebarSplitContent: some View {
        GeometryReader { proxy in
            // Keyboard safe-area changes must not masquerade as window/orientation changes;
            // switching layouts destroys the focused detail subtree.
            let layoutContainerSize = Self.sidebarLayoutContainerSize(
                contentSize: proxy.size,
                windowSize: self.foregroundKeyWindowSize())
            let isDrawerLayout = self.shouldUseSidebarDrawer(containerSize: layoutContainerSize)
            let sidebarWidth = self.sidebarWidth(
                containerWidth: layoutContainerSize.width,
                isDrawerLayout: isDrawerLayout)
            Group {
                if isDrawerLayout {
                    self.sidebarDrawerContent(
                        sidebarWidth: sidebarWidth,
                        safeAreaInsets: proxy.safeAreaInsets)
                } else {
                    self.sidebarNavigationSplitContent(sidebarWidth: sidebarWidth)
                }
            }
            .onAppear {
                self.updateSidebarLayout(containerSize: layoutContainerSize, force: false)
            }
            .onChange(of: proxy.size) { _, size in
                let layoutContainerSize = Self.sidebarLayoutContainerSize(
                    contentSize: size,
                    windowSize: self.foregroundKeyWindowSize())
                self.updateSidebarLayout(containerSize: layoutContainerSize, force: false)
            }
            // Single refresh owner: identity/session changes, scene activation,
            // and the periodic attention refresh all land here.
            .task(id: self.sidebarRefreshID) {
                guard self.scenePhase == .active else { return }
                await self.sidebarModel.refresh(appModel: self.appModel)
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(600))
                    guard !Task.isCancelled else { return }
                    await self.sidebarModel.refresh(appModel: self.appModel)
                }
            }
            .task(id: "\(self.sidebarRefreshID):events") {
                guard self.scenePhase == .active else { return }
                await self.sidebarModel.observeSessionEvents(appModel: self.appModel)
            }
            .task(id: self.sessionObserverTaskIdentity) {
                await self.sidebarModel.setSessionObserverVisibility(
                    appModel: self.appModel,
                    visible: self.sessionObserverTaskIdentity.isObserverVisible)
            }
        }
    }

    private var sessionObserverTaskIdentity: SessionObserverTaskIdentity {
        SessionObserverTaskIdentity(
            sidebarRefreshID: self.sidebarRefreshID,
            isSceneActive: self.scenePhase == .active,
            isSidebarVisible: self.isSidebarVisible)
    }

    private var sidebarRefreshID: String {
        [
            self.appModel.chatViewModelIdentityID,
            self.appModel.chatSessionKey,
            self.scenePhase == .active ? "active" : "inactive",
        ].joined(separator: ":")
    }

    private func sidebarNavigationSplitContent(sidebarWidth: CGFloat) -> some View {
        HStack(spacing: 0) {
            if self.isSidebarVisible {
                self.sidebarColumn()
                    .frame(width: sidebarWidth, alignment: .topLeading)
                    .frame(maxHeight: .infinity, alignment: .topLeading)
                    .overlay(alignment: .trailing) {
                        self.sidebarVerticalSeparator
                    }
                    .transition(self.sidebarTransition)
            }

            self.sidebarDetailNavigationShell
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .background(OpenClawProBackground())
        .animation(self.sidebarAnimation, value: self.isSidebarVisible)
    }

    private func sidebarDrawerContent(
        sidebarWidth: CGFloat,
        safeAreaInsets: EdgeInsets) -> some View
    {
        RootSidebarDrawer(
            sidebarWidth: sidebarWidth,
            isPresented: self.isSidebarVisible,
            canOpenFromEdge: self.isSidebarDetailRootVisible && self.sidebarNavigationPath.isEmpty,
            reduceMotion: self.reduceMotion,
            animation: self.sidebarAnimation,
            onShow: self.showSidebar,
            onHide: self.hideSidebar,
            sidebar: self.sidebarColumn(drawerSafeAreaInsets: safeAreaInsets),
            detail: self.sidebarDetailNavigationShell)
    }

    private var sidebarDetailShell: some View {
        let shellID = self.sidebarDetailShellID
        return self.sidebarDetail
            .id(shellID)
            // RootTabs disables destination-owned stacks at its call sites. A
            // destination-style NavigationLink therefore replaces this shared
            // root, so visibility guards its native back-swipe without relying
            // on the typed Settings path.
            .onAppear {
                guard self.sidebarDetailShellID == shellID else { return }
                self.isSidebarDetailRootVisible = true
            }
            .onDisappear {
                guard self.sidebarDetailShellID == shellID else { return }
                self.isSidebarDetailRootVisible = false
            }
    }

    /// RootSidebar owns its dark surface; this wrapper only restores vertical
    /// insets. Drawer mode goes full-bleed (ignoresSafeArea) so the captured
    /// insets are re-applied manually; split mode keeps system safe areas.
    private func sidebarColumn(drawerSafeAreaInsets: EdgeInsets? = nil) -> some View {
        RootSidebar(
            model: self.sidebarModel,
            selectedDestination: self.selectedSidebarDestination,
            isDrawerLayout: self.isSidebarDrawerLayout,
            isDismissButtonEnabled: self.isSidebarVisible,
            selectDestination: self.selectSidebarDestination,
            selectSession: self.selectSidebarSession,
            hideSidebar: self.hideSidebar)
            .padding(.top, drawerSafeAreaInsets.map { $0.top + 8 } ?? 0)
            .padding(.bottom, drawerSafeAreaInsets.map { $0.bottom + 8 } ?? 0)
            .safeAreaPadding(.top, drawerSafeAreaInsets == nil ? 8 : 0)
            .safeAreaPadding(.bottom, drawerSafeAreaInsets == nil ? 8 : 0)
            // Paints the wrapper's inset strips; RootSidebar's own background
            // stops at its bounds.
            .background(OpenClawSidebarPalette.background)
    }

    private var sidebarVerticalSeparator: some View {
        Rectangle()
            .fill(OpenClawSidebarPalette.hairline)
            .frame(width: 1 / self.displayScale)
    }

    @ViewBuilder
    private var sidebarDetail: some View {
        switch self.selectedSidebarDestination {
        case .chat:
            // Agent identity pill owns the chat header (prototype parity).
            ChatProTab(
                headerSidebarAction: self.sidebarHeaderAction,
                openSettings: { self.selectSidebarDestination(.gateway) })
        case .overview:
            CommandCenterTab(
                headerTitle: "Overview",
                headerSidebarAction: self.sidebarHeaderAction,
                dashboardModel: self.sidebarModel,
                openChat: { self.selectSidebarDestination(.chat) },
                openSettings: { self.selectSidebarDestination(.gateway) },
                openSessions: { self.selectSidebarDestination(.sessions) },
                openApprovals: { self.selectSettingsRoute(.approvals) },
                openAutomations: { self.selectSidebarDestination(.cron) },
                openUsage: { self.selectSidebarDestination(.usage) })
        case .activity:
            IPadActivityScreen(
                headerSidebarAction: self.sidebarHeaderAction,
                openChat: { self.selectSidebarDestination(.chat) },
                openSettings: { self.selectSidebarDestination(.gateway) })
        case .workboard:
            IPadWorkboardScreen(
                headerSidebarAction: self.sidebarHeaderAction,
                openChat: { self.selectSidebarDestination(.chat) },
                openSettings: { self.selectSidebarDestination(.gateway) })
        case .skillWorkshop:
            IPadSkillWorkshopScreen(
                headerSidebarAction: self.sidebarHeaderAction,
                openSettings: { self.selectSidebarDestination(.gateway) })
        case .agents:
            AgentProTab(
                directRoute: .agents,
                headerSidebarAction: self.sidebarHeaderAction,
                headerTitle: "Agents",
                openSettings: { self.selectSidebarDestination(.gateway) })
                .id(self.selectedSidebarDestination.id)
        case .instances:
            AgentProTab(
                directRoute: .instances,
                headerSidebarAction: self.sidebarHeaderAction,
                headerTitle: "Instances",
                openSettings: { self.selectSidebarDestination(.gateway) })
                .id(self.selectedSidebarDestination.id)
        case .sessions:
            CommandSessionsScreen(
                headerSidebarAction: self.sidebarHeaderAction,
                openChat: { self.selectSidebarDestination(.chat) })
        case .files:
            AgentProTab(
                directRoute: .files,
                headerSidebarAction: self.sidebarHeaderAction,
                headerTitle: "Files",
                openSettings: { self.selectSidebarDestination(.gateway) })
                .id(self.selectedSidebarDestination.id)
        case .dreaming:
            AgentProTab(
                directRoute: .dreaming,
                headerSidebarAction: self.sidebarHeaderAction,
                headerTitle: "Dreaming",
                openSettings: { self.selectSidebarDestination(.gateway) })
                .id(self.selectedSidebarDestination.id)
        case .usage:
            AgentProTab(
                directRoute: .usage,
                headerSidebarAction: self.sidebarHeaderAction,
                headerTitle: "Usage",
                openSettings: { self.selectSidebarDestination(.gateway) })
                .id(self.selectedSidebarDestination.id)
        case .cron:
            AgentProTab(
                directRoute: .cron,
                headerSidebarAction: self.sidebarHeaderAction,
                headerTitle: "Automations",
                openSettings: { self.selectSidebarDestination(.gateway) })
                .id(self.selectedSidebarDestination.id)
        case .desktop:
            DesktopHubScreen(
                headerSidebarAction: self.sidebarHeaderAction,
                gatewayAction: { self.selectSidebarDestination(.gateway) })
        case .terminal:
            TerminalHubScreen(
                headerSidebarAction: self.sidebarHeaderAction,
                gatewayAction: { self.selectSidebarDestination(.gateway) })
        case .docs:
            OpenClawDocsScreen(
                headerSidebarAction: self.sidebarHeaderAction,
                gatewayAction: { self.selectSidebarDestination(.gateway) })
        case .settings:
            if let selectedSettingsRoute {
                SettingsProTab(
                    directRoute: selectedSettingsRoute,
                    headerSidebarAction: self.sidebarHeaderAction,
                    navigateToRoute: pushSidebarSettingsRoute,
                    onRouteChange: handleSettingsRouteChange,
                    onApprovalNotificationsRoute: suppressExecApprovalPromptForNotificationSettings,
                    gatewaySetupRequest: self.gatewaySetupRequest,
                    onGatewaySetupRequestHandled: handleGatewaySetupRequest)
            } else {
                SettingsProTab(
                    headerSidebarAction: self.sidebarHeaderAction,
                    navigateToRoute: pushSidebarSettingsRoute,
                    onRouteChange: handleSettingsRouteChange,
                    onApprovalNotificationsRoute: suppressExecApprovalPromptForNotificationSettings,
                    gatewaySetupRequest: self.gatewaySetupRequest,
                    onGatewaySetupRequestHandled: handleGatewaySetupRequest)
            }
        case .gateway:
            SettingsProTab(
                directRoute: self.selectedSettingsRoute ?? self.selectedSidebarDestination.settingsRoute ?? .gateway,
                acceptsGatewaySetupRequests: !self.showOnboarding,
                headerSidebarAction: self.sidebarHeaderAction,
                navigateToRoute: pushSidebarSettingsRoute,
                onRouteChange: handleSettingsRouteChange,
                onApprovalNotificationsRoute: suppressExecApprovalPromptForNotificationSettings,
                gatewaySetupRequest: self.gatewaySetupRequest,
                onGatewaySetupRequestHandled: handleGatewaySetupRequest)
        }
    }

    private var sidebarDetailNavigationShell: some View {
        NavigationStack(path: self.$sidebarNavigationPath) {
            self.sidebarDetailShell
        }
        .onChange(of: self.sidebarNavigationPath) { _, navigationPath in
            self.handleSidebarSettingsNavigationPathChange(navigationPath)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var sidebarDetailShellID: String {
        let routeID = self.selectedSettingsRoute.map { "\($0)" } ?? "root"
        return "\(self.selectedSidebarDestination.id):\(routeID):\(self.selectedSettingsRouteRequestID)"
    }

    private var activeExecApprovalPromptSuppression: NodeAppModel.ExecApprovalInboxKey? {
        guard self.selectedSidebarDestination == .settings || self.selectedSidebarDestination == .gateway else {
            return nil
        }
        switch self.activeSettingsRoute {
        case .approvals:
            return NodeAppModel.execApprovalInboxKey(self.appModel.pendingExecApprovalPrompt)
        case .notifications:
            return self.suppressedExecApprovalForNotificationSettings
        default:
            return nil
        }
    }

    private var shouldCollapseSidebarAfterSelection: Bool {
        Self.shouldCollapseSidebarAfterSelection(
            layoutMode: self.isSidebarDrawerLayout ? .drawer : .split)
    }

    private var sidebarHeaderAction: OpenClawSidebarHeaderAction? {
        guard Self.shouldShowSidebarRevealInDestinationHeader(
            isSidebarVisible: self.isSidebarVisible,
            layoutMode: self.isSidebarDrawerLayout ? .drawer : .split)
        else {
            return nil
        }
        if self.isSidebarVisible {
            return OpenClawSidebarHeaderAction(
                systemName: "line.3.horizontal",
                accessibilityLabel: .localized("Hide Sidebar"),
                accessibilityIdentifier: Self.sidebarHideButtonAccessibilityIdentifier,
                action: { self.hideSidebar() })
        }
        return OpenClawSidebarHeaderAction(
            systemName: "line.3.horizontal",
            accessibilityLabel: .localized("Show Sidebar"),
            accessibilityIdentifier: Self.sidebarShowButtonAccessibilityIdentifier,
            action: { self.showSidebar() })
    }

    private var sidebarAnimation: Animation? {
        self.reduceMotion ? .easeOut(duration: 0.16) : .spring(response: 0.35, dampingFraction: 0.86)
    }

    private var sidebarTransition: AnyTransition {
        self.reduceMotion ? .opacity : .move(edge: .leading).combined(with: .opacity)
    }

    private func shouldUseSidebarDrawer(containerSize: CGSize) -> Bool {
        Self.sidebarLayoutMode(containerSize: containerSize) == .drawer
    }

    private func sidebarWidth(containerWidth: CGFloat, isDrawerLayout: Bool) -> CGFloat {
        Self.sidebarWidth(containerWidth: containerWidth, isDrawerLayout: isDrawerLayout)
    }

    private func foregroundKeyWindowSize() -> CGSize? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first(where: { $0.activationState == .foregroundActive })?
            .windows
            .first(where: \.isKeyWindow)?
            .bounds.size
    }

    private func rootOverlays(_ content: some View) -> some View {
        content
            .overlay(alignment: .top) {
                // Stable container so the toast's move/opacity transition animates
                // when the gateway problem appears or clears outside withAnimation.
                ZStack(alignment: .top) {
                    if let gatewayRetryFailure {
                        OpenClawNoticeBanner(
                            icon: "wifi.exclamationmark",
                            title: "Gateway reconnect failed",
                            message: .verbatim(gatewayRetryFailure),
                            ownerLabel: "Needs attention",
                            tint: OpenClawBrand.warn,
                            secondaryActionTitle: "Dismiss",
                            onSecondaryAction: { self.gatewayRetryFailure = nil })
                            .padding(.horizontal, 12)
                            .safeAreaPadding(.top, 10)
                            .transition(.move(edge: .top).combined(with: .opacity))
                    } else if let gatewayProblem = self.activeGatewayProblemToast {
                        self.gatewayProblemToast(gatewayProblem)
                    }
                }
                .animation(self.gatewayToastAnimation, value: self.gatewayRetryFailure)
                .animation(self.gatewayToastAnimation, value: self.activeGatewayProblemToast)
            }
            .overlay(alignment: .topLeading) {
                if let voiceWakeToastText, !voiceWakeToastText.isEmpty {
                    VoiceWakeToast(command: voiceWakeToastText)
                        .padding(.leading, 10)
                        .safeAreaPadding(
                            .top,
                            self.activeGatewayProblemToast == nil && self.gatewayRetryFailure == nil ? 58 : 132)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }

            .overlay {
                // Keep the observer mounted so the first 0 -> 1 capture transition
                // flashes without treating a later remount as a new capture.
                RootCameraFlashOverlay(nonce: self.appModel.cameraFlashNonce)
            }
    }

    private var activeGatewayProblemToast: GatewayConnectionProblem? {
        // Operator-scope auth/pairing failures can coexist with a connected node.
        // The problem itself, not aggregate gateway status, owns toast visibility.
        guard let problem = appModel.lastGatewayProblem,
              !self.isGatewayToastSwipeDismissed
        else { return nil }
        return problem
    }

    private var gatewayToastAnimation: Animation? {
        self.reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.85)
    }

    private func gatewayProblemToast(_ problem: GatewayConnectionProblem) -> some View {
        GatewayProblemBanner(
            problem: problem,
            primaryActionTitle: gatewayProblemPrimaryActionTitle(problem),
            onPrimaryAction: {
                self.handleGatewayProblemPrimaryAction(problem)
            },
            onShowDetails: {
                self.showGatewayProblemDetails = true
            })
            .padding(.horizontal, 12)
            .safeAreaPadding(.top, 10)
            .offset(y: min(self.gatewayToastDragOffset, 0))
            .gesture(self.gatewayToastSwipeGesture)
            // A drag cancelled by toast removal never fires onEnded; clear the
            // offset so the next toast doesn't render shifted up.
            .onDisappear { self.gatewayToastDragOffset = 0 }
            .transition(.move(edge: .top).combined(with: .opacity))
    }

    private var gatewayToastSwipeGesture: some Gesture {
        DragGesture(minimumDistance: 12)
            .onChanged { value in
                self.gatewayToastDragOffset = value.translation.height
            }
            .onEnded { value in
                let swipedUp = value.translation.height < -32 || value.predictedEndTranslation.height < -80
                withAnimation(self.gatewayToastAnimation) {
                    if swipedUp {
                        self.isGatewayToastSwipeDismissed = true
                    }
                    self.gatewayToastDragOffset = 0
                }
            }
    }

    private func handleGatewayProblemReport() {
        guard self.isGatewayToastSwipeDismissed else { return }
        self.isGatewayToastSwipeDismissed = false
    }

    private func rootLifecycle(_ content: some View) -> some View {
        self.rootRequestLifecycle(
            self.rootGatewayLifecycle(
                self.rootAppearLifecycle(
                    self.rootVoiceWakeLifecycle(content))))
    }

    private func rootVoiceWakeLifecycle(_ content: some View) -> some View {
        content
            .onChange(of: self.voiceWake.lastTriggeredCommand) { _, newValue in
                guard let newValue else { return }
                let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { return }

                withAnimation(self.reduceMotion ? .none : .spring(response: 0.25, dampingFraction: 0.85)) {
                    self.voiceWakeToastText = trimmed
                }

                self.toastDismissGate.schedule(after: .milliseconds(2300)) {
                    withAnimation(self.reduceMotion ? .none : .easeOut(duration: 0.25)) {
                        self.voiceWakeToastText = nil
                    }
                }
            }
    }

    private func rootAppearLifecycle(_ content: some View) -> some View {
        content
            .onAppear { self.updateIdleTimer() }
            .onAppear { self.evaluateOnboardingPresentation(force: false) }
            .onAppear { self.maybeAutoOpenSettings() }
            .onAppear { self.maybeOpenSettingsForGatewaySetup() }
            .onAppear { self.maybeShowQuickSetup() }
            .onAppear { self.applyInitialChatSessionIfNeeded() }
            .onChange(of: self.preventSleep) { _, _ in self.updateIdleTimer() }
            .onChange(of: self.appModel.talkMode.isEnabled) { _, _ in self.updateIdleTimer() }
            .onChange(of: self.scenePhase) { _, newValue in
                self.updateIdleTimer()
                guard newValue == .active else {
                    self.clearVoiceWakeToast()
                    return
                }
                self.maybeRequestLocalNetworkAccess(reason: "scene_active")
                Task {
                    await self.appModel.refreshGatewayOverviewIfConnected()
                }
            }
            .onDisappear {
                UIApplication.shared.isIdleTimerDisabled = false
                self.clearVoiceWakeToast()
            }
    }

    private func clearVoiceWakeToast() {
        self.voiceWakeToastText = nil
        self.toastDismissGate.cancel()
    }

    private func rootGatewayProblemLifecycle(_ content: some View) -> some View {
        content
            .onChange(of: self.appModel.lastGatewayProblem) { _, newValue in
                if newValue == nil {
                    self.isGatewayToastSwipeDismissed = false
                }
            }
            .onChange(of: self.appModel.gatewayProblemReportCount) { _, _ in
                self.handleGatewayProblemReport()
            }
    }

    private func rootGatewayLifecycle(_ content: some View) -> some View {
        self.rootGatewayProblemLifecycle(content)
            .onChange(of: self.gatewayController.gateways.count) { _, _ in self.maybeShowQuickSetup() }
            .onChange(of: self.appModel.gatewayServerName) { _, newValue in
                if newValue != nil {
                    self.onboardingComplete = true
                    self.hasConnectedOnce = true
                    OnboardingStateStore.markCompleted(mode: nil)
                }
                self.maybeAutoOpenSettings()
                self.maybeShowQuickSetup()
            }
    }

    private func rootRequestLifecycle(_ content: some View) -> some View {
        content
            .onAppear {
                self.handleDashboardNavigationRequest(self.appModel.dashboardNavigationRequestID)
            }
            .onChange(of: self.onboardingRequestID) { _, _ in
                self.evaluateOnboardingPresentation(force: true)
            }
            .onChange(of: self.showOnboarding) { _, newValue in
                guard !newValue else { return }
                self.maybeRequestLocalNetworkAccess(reason: "onboarding_dismissed")
            }
            .onChange(of: self.appModel.openChatRequestID) { _, newValue in
                self.handleOpenChatRequest(newValue)
            }
            .onChange(of: self.appModel.dashboardNavigationRequestID) { _, requestID in
                self.handleDashboardNavigationRequest(requestID)
            }
            .onChange(of: self.appModel.gatewaySetupRequestID) { _, _ in
                self.maybeOpenSettingsForGatewaySetup()
            }
            .onChange(of: NodeAppModel.execApprovalInboxKey(self.appModel.pendingExecApprovalPrompt)) { _, newValue in
                if newValue != self.suppressedExecApprovalForNotificationSettings {
                    self.suppressedExecApprovalForNotificationSettings = nil
                }
            }
    }

    private func handleDashboardNavigationRequest(_ requestID: Int) {
        guard self.appModel.consumeDashboardNavigationRequest(requestID) else { return }
        self.selectSidebarDestination(.overview)
    }

    private func rootPresentation(_ content: some View) -> some View {
        content
            .sheet(isPresented: self.$showGatewayProblemDetails) {
                if let gatewayProblem = self.appModel.lastGatewayProblem {
                    GatewayProblemDetailsSheet(
                        problem: gatewayProblem,
                        primaryActionTitle: self.gatewayProblemPrimaryActionTitle(gatewayProblem),
                        onPrimaryAction: {
                            self.handleGatewayProblemPrimaryAction(gatewayProblem)
                        })
                }
            }
            .sheet(item: self.$presentedSheet) { sheet in
                switch sheet {
                case .quickSetup:
                    GatewayQuickSetupSheet(onUseManualSetup: {
                        self.presentedSheet = nil
                        self.selectSettingsRoute(.gateway)
                    })
                    .environment(self.appModel)
                    .environment(self.gatewayController)
                    .openClawSheetChrome()
                case let .sessionDashboard(sessionKey, agentId):
                    NavigationStack {
                        SessionDashboardScreen(sessionKey: sessionKey, agentId: agentId)
                    }
                }
            }
            .fullScreenCover(isPresented: self.$showOnboarding) {
                OnboardingWizardView(
                    allowSkip: self.onboardingAllowSkip,
                    onRequestLocalNetworkAccess: { reason in
                        self.requestLocalNetworkAccess(reason: reason)
                    },
                    onClose: {
                        self.showOnboarding = false
                    },
                    onComplete: {
                        self.showOnboarding = false
                        self.selectSidebarDestination(.chat)
                    })
                    .environment(self.appModel)
                    .environment(self.voiceWake)
                    .environment(self.gatewayController)
            }
            .gatewayTrustPromptAlert(isEnabled: !self.showOnboarding)
            .deepLinkAgentPromptAlert()
            .execApprovalPromptDialog(
                suppressedApproval: self.activeExecApprovalPromptSuppression)
            .notificationPermissionGuidanceDialog(openNotifications: { approvalId in
                self.suppressExecApprovalPromptForNotificationSettings(approvalId)
                self.selectSettingsRoute(.notifications)
            })
    }

    private func updateIdleTimer() {
        UIApplication.shared.isIdleTimerDisabled =
            self.scenePhase == .active && (self.preventSleep || self.appModel.talkMode.isEnabled)
    }
}

extension RootTabs {
    private func selectSidebarSession(_ session: OpenClawChatSessionEntry) {
        switch Self.sidebarPresentation(for: session) {
        case .chat:
            self.appModel.openChat(sessionKey: session.key)
            self.selectSidebarDestination(.chat)
        case .dashboard:
            let target = Self.sidebarDashboardTarget(for: session)
            self.presentedSheet = .sessionDashboard(
                sessionKey: target.sessionKey,
                agentId: target.agentId)
            guard self.shouldCollapseSidebarAfterSelection else { return }
            withAnimation(self.sidebarAnimation) {
                self.setSidebarVisible(false)
            }
        }
    }

    private func selectSidebarDestination(_ destination: SidebarDestination) {
        self.sidebarNavigationPath.removeAll()
        if destination.settingsRoute != .notifications {
            self.suppressedExecApprovalForNotificationSettings = nil
        }
        self.selectedSidebarDestination = destination
        self.selectedSettingsRoute = destination.settingsRoute
        self.activeSettingsRoute = destination.settingsRoute
        guard self.shouldCollapseSidebarAfterSelection else { return }
        withAnimation(self.sidebarAnimation) {
            self.setSidebarVisible(false)
        }
    }

    private func handleOpenChatRequest(_: Int) {
        self.selectSidebarDestination(.chat)
    }

    private func selectSettingsRoute(_ route: SettingsRoute) {
        self.sidebarNavigationPath.removeAll()
        if route != .notifications {
            self.suppressedExecApprovalForNotificationSettings = nil
        }
        self.selectedSettingsRoute = route
        self.activeSettingsRoute = route
        self.selectedSettingsRouteRequestID &+= 1
        self.selectedSidebarDestination = .settings
        guard self.shouldCollapseSidebarAfterSelection else { return }
        withAnimation(self.sidebarAnimation) {
            self.setSidebarVisible(false)
        }
    }

    private func pushSidebarSettingsRoute(_ route: SettingsRoute) {
        // Push, don't replace: Back must return to the settings screen the
        // user came from (e.g. Approvals -> Notifications -> back -> Approvals).
        self.sidebarNavigationPath.append(route)
        self.handleSettingsRouteChange(route)
    }

    private func suppressExecApprovalPromptForNotificationSettings(_ approvalID: String) {
        guard let approvalID = ExecApprovalIdentifier.key(approvalID),
              let prompt = self.appModel.pendingExecApprovalPrompt,
              ExecApprovalIdentifier.key(prompt.id) == approvalID
        else { return }
        self.suppressedExecApprovalForNotificationSettings = NodeAppModel.execApprovalInboxKey(prompt)
    }

    private func handleSettingsRouteChange(_ route: SettingsRoute?) {
        self.activeSettingsRoute = route
        guard route != .notifications else { return }
        if route == nil {
            self.selectedSettingsRoute = nil
            if self.selectedSidebarDestination == .settings {
                self.selectedSidebarDestination = .settings
            }
        }
        self.suppressedExecApprovalForNotificationSettings = nil
    }

    private func handleSidebarSettingsNavigationPathChange(_ navigationPath: [SettingsRoute]) {
        guard self.selectedSidebarDestination == .settings || self.selectedSidebarDestination == .gateway else {
            return
        }
        let baseRoute = self.selectedSettingsRoute ?? self.selectedSidebarDestination.settingsRoute
        let route = Self.visibleSettingsRoute(
            navigationPath: navigationPath,
            baseRoute: baseRoute)
        self.handleSettingsRouteChange(route)
    }

    private func showSidebar() {
        self.sidebarVisibilityUserOverridden = true
        withAnimation(self.sidebarAnimation) {
            self.setSidebarVisible(true)
        }
    }

    private func hideSidebar() {
        self.sidebarVisibilityUserOverridden = true
        withAnimation(self.sidebarAnimation) {
            self.setSidebarVisible(false)
        }
    }

    private func updateSidebarLayout(containerSize: CGSize, force: Bool) {
        let layoutMode = Self.sidebarLayoutMode(containerSize: containerSize)
        let previousLayoutMode: SidebarLayoutMode = self.isSidebarDrawerLayout ? .drawer : .split
        let didResolvePreviousLayout = self.didResolveSidebarLayout
        let layoutModeDidChange = layoutMode != previousLayoutMode
        self.didResolveSidebarLayout = true
        self.isSidebarDrawerLayout = layoutMode == .drawer
        if layoutModeDidChange && didResolvePreviousLayout {
            self.sidebarVisibilityUserOverridden = false
        }
        guard force || !self.sidebarVisibilityUserOverridden else { return }

        let preferredVisibility = Self.preferredSidebarVisibility(layoutMode: layoutMode)
        guard self.isSidebarVisible != preferredVisibility else { return }
        self.setSidebarVisible(preferredVisibility)
    }

    private func setSidebarVisible(_ isVisible: Bool) {
        self.isSidebarVisible = isVisible
    }

    private func gatewayProblemPrimaryActionTitle(_ problem: GatewayConnectionProblem) -> String? {
        GatewayProblemPrimaryAction.title(
            for: problem,
            retryTitle: "Retry",
            resetTitle: "Reset onboarding",
            nonRetryableTitle: "Open Settings")
    }

    private func handleGatewayProblemPrimaryAction(_ problem: GatewayConnectionProblem) {
        if problem.suggestsOnboardingReset {
            // Reset bumps onboarding.requestID, which re-presents the wizard.
            let instanceId = UserDefaults.standard.string(forKey: "node.instanceId") ?? ""
            Task {
                await GatewayOnboardingReset.reset(appModel: self.appModel, instanceId: instanceId)
            }
        } else if problem.canTrustRotatedCertificate {
            Task { await self.gatewayController.trustRotatedGatewayCertificate(from: problem) }
        } else if GatewayProblemPrimaryAction.handleProtocolMismatchIfNeeded(problem) {
            return
        } else if problem.retryable {
            self.gatewayRetryFailure = nil
            Task {
                if case let .failed(message) = await self.gatewayController.connectActiveGateway() {
                    self.gatewayRetryFailure = message
                }
            }
        } else {
            self.selectSidebarDestination(.gateway)
        }
    }

    private func evaluateOnboardingPresentation(force: Bool) {
        if force {
            self.onboardingAllowSkip = true
            self.showOnboarding = true
            return
        }

        guard !self.didEvaluateOnboarding else { return }
        self.didEvaluateOnboarding = true
        let route = Self.startupPresentationRoute(
            gatewayConnected: self.appModel.gatewayServerName != nil,
            hasConnectedOnce: self.hasConnectedOnce,
            onboardingComplete: self.onboardingComplete,
            hasExistingGatewayConfig: self.hasExistingGatewayConfig(),
            shouldPresentOnLaunch: OnboardingStateStore.shouldPresentOnLaunch(appModel: self.appModel))
        switch route {
        case .none:
            self.maybeRequestLocalNetworkAccess(reason: "root_appear")
        case .onboarding:
            self.onboardingAllowSkip = true
            self.showOnboarding = true
        case .settings:
            self.didAutoOpenSettings = true
            self.selectSidebarDestination(.gateway)
            self.maybeRequestLocalNetworkAccess(reason: "root_appear")
        }
    }

    private func hasExistingGatewayConfig() -> Bool {
        if self.appModel.activeGatewayConnectConfig != nil { return true }
        if GatewaySettingsStore.activeGatewayEntry() != nil { return true }

        let preferredStableID = self.preferredGatewayStableID.trimmingCharacters(in: .whitespacesAndNewlines)
        if !preferredStableID.isEmpty { return true }

        let manualHost = self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        return self.manualGatewayEnabled && !manualHost.isEmpty
    }

    private func maybeAutoOpenSettings() {
        guard !self.didAutoOpenSettings else { return }
        guard !self.showOnboarding else { return }
        let route = Self.startupPresentationRoute(
            gatewayConnected: self.appModel.gatewayServerName != nil,
            hasConnectedOnce: self.hasConnectedOnce,
            onboardingComplete: self.onboardingComplete,
            hasExistingGatewayConfig: self.hasExistingGatewayConfig(),
            shouldPresentOnLaunch: false)
        guard route == .settings else { return }
        self.didAutoOpenSettings = true
        self.selectSidebarDestination(.gateway)
        self.maybeRequestLocalNetworkAccess(reason: "auto_open_settings")
    }

    private func maybeOpenSettingsForGatewaySetup() {
        let requestID = self.appModel.gatewaySetupRequestID
        guard requestID != 0, requestID != self.gatewaySetupRequest?.id else { return }
        // The presented onboarding flow owns setup-link staging until it dismisses.
        guard !self.showOnboarding else { return }
        guard let link = appModel.consumePendingGatewaySetupLink() else { return }
        self.showOnboarding = false
        self.presentedSheet = nil
        self.didAutoOpenSettings = true
        self.selectSidebarDestination(.gateway)
        // Root owns delivery so embedded Settings views cannot consume the one-shot link.
        self.gatewaySetupRequest = GatewaySetupRequest(id: requestID, link: link)
        self.requestLocalNetworkAccess(reason: "gateway_setup_deeplink")
    }

    private func handleGatewaySetupRequest(_ requestID: Int) {
        guard self.gatewaySetupRequest?.id == requestID else { return }
        self.gatewaySetupRequest = nil
    }

    private func maybeRequestLocalNetworkAccess(reason: String) {
        guard self.didEvaluateOnboarding else { return }
        guard self.scenePhase == .active else { return }
        guard !self.showOnboarding else { return }
        self.requestLocalNetworkAccess(reason: reason)
    }

    private func requestLocalNetworkAccess(reason: String) {
        guard !self.appModel.isAppleReviewDemoModeEnabled else { return }
        self.gatewayController.requestLocalNetworkAccess(reason: reason)
    }

    private func applyInitialChatSessionIfNeeded() {
        guard !self.didApplyInitialChatSession else { return }
        self.didApplyInitialChatSession = true
        self.appModel.focusChatSession(Self.initialChatSessionKey)
    }

    private func maybeShowQuickSetup() {
        let shouldPresent = Self.shouldPresentQuickSetup(
            quickSetupDismissed: self.quickSetupDismissed,
            showOnboarding: self.showOnboarding,
            hasPresentedSheet: self.presentedSheet != nil,
            gatewayConnected: self.appModel.gatewayServerName != nil,
            hasExistingGatewayConfig: self.hasExistingGatewayConfig(),
            discoveredGatewayCount: self.gatewayController.gateways.count)
        guard shouldPresent else { return }
        self.presentedSheet = .quickSetup
    }
}

private struct RootCameraFlashOverlay: View {
    @Environment(\.scenePhase) private var scenePhase

    var nonce: Int

    @State private var opacity: CGFloat = 0
    @State private var dismissGate = DelayedActionGate()

    var body: some View {
        Color.white
            .opacity(self.opacity)
            .ignoresSafeArea()
            .allowsHitTesting(false)
            .onChange(of: self.nonce) { _, _ in
                guard self.scenePhase == .active else {
                    self.clearFlash()
                    return
                }
                self.showFlash()
            }
            .onChange(of: self.scenePhase) { _, newValue in
                guard newValue != .active else { return }
                self.clearFlash()
            }
            .onDisappear { self.clearFlash() }
    }

    private func showFlash() {
        withAnimation(.easeOut(duration: 0.08)) {
            self.opacity = 0.85
        }
        self.dismissGate.schedule(after: .milliseconds(110)) {
            withAnimation(.easeOut(duration: 0.32)) {
                self.opacity = 0
            }
        }
    }

    private func clearFlash() {
        self.opacity = 0
        self.dismissGate.cancel()
    }
}

#if DEBUG
#Preview(
    "Shell iPhone portrait",
    traits: .fixedLayout(width: 393, height: 852),
    .portrait)
{
    RootTabsPreviewHost()
}

#Preview(
    "Shell iPhone drawer open",
    traits: .fixedLayout(width: 393, height: 852),
    .portrait)
{
    RootTabsPreviewHost(sidebarVisible: true)
}

#Preview(
    "Shell iPhone connected",
    traits: .fixedLayout(width: 393, height: 852),
    .portrait)
{
    RootTabsPreviewHost(gatewayState: .connected)
}

#Preview(
    "Shell iPhone gateway error",
    traits: .fixedLayout(width: 393, height: 852),
    .portrait)
{
    RootTabsPreviewHost(gatewayState: .error)
}

#Preview(
    "Shell iPhone landscape",
    traits: .fixedLayout(width: 852, height: 393),
    .landscapeLeft)
{
    RootTabsPreviewHost()
        .environment(\.horizontalSizeClass, .regular)
        .environment(\.verticalSizeClass, .compact)
}

#Preview(
    "Shell iPad portrait drawer",
    traits: .fixedLayout(width: 1024, height: 1366),
    .portrait)
{
    RootTabsPreviewHost()
}

#Preview(
    "Shell iPad landscape split",
    traits: .fixedLayout(width: 1366, height: 1024),
    .landscapeLeft)
{
    RootTabsPreviewHost(gatewayState: .connected)
}

#Preview(
    "Shell iPad connecting",
    traits: .fixedLayout(width: 1366, height: 1024),
    .landscapeLeft)
{
    RootTabsPreviewHost(gatewayState: .connecting)
}

#Preview(
    "Shell iPad gateway error",
    traits: .fixedLayout(width: 1366, height: 1024),
    .landscapeLeft)
{
    RootTabsPreviewHost(gatewayState: .error)
}

private struct RootTabsPreviewHost: View {
    @State private var appearanceModel = AppAppearanceModel()
    @State private var appModel: NodeAppModel
    @State private var gatewayController: GatewayConnectionController
    private let sidebarVisible: Bool?

    init(
        gatewayState: RootTabsPreviewGatewayState = .offline,
        sidebarVisible: Bool? = nil)
    {
        let appModel = NodeAppModel()
        gatewayState.apply(to: appModel)
        self.sidebarVisible = sidebarVisible
        _appModel = State(initialValue: appModel)
        _gatewayController = State(
            initialValue: GatewayConnectionController(appModel: appModel, startDiscovery: false))
    }

    var body: some View {
        RootTabs(initialSidebarVisibility: self.sidebarVisible)
            .environment(self.appearanceModel)
            .environment(self.appModel)
            .environment(self.appModel.voiceWake)
            .environment(self.gatewayController)
    }
}

private enum RootTabsPreviewGatewayState {
    case offline
    case connecting
    case connected
    case error

    @MainActor
    func apply(to appModel: NodeAppModel) {
        switch self {
        case .offline:
            break
        case .connecting:
            appModel.gatewayStatusText = "Connecting..."
        case .connected:
            appModel.enterAppleReviewDemoMode()
        case .error:
            appModel.gatewayStatusText = "Gateway error: connection refused"
        }
    }
}

#endif
