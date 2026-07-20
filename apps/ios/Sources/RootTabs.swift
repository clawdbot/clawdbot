import OpenClawKit
import OpenClawProtocol
import SwiftUI
import UIKit

struct RootTabs: View {
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
    @AppStorage("canvas.debugStatusEnabled") private var canvasDebugStatusEnabled: Bool = false
    @State private var selectedSidebarDestination: SidebarDestination = Self.initialSidebarDestination
    @State private var selectedSettingsRoute: SettingsRoute? = Self.initialSidebarDestination.settingsRoute
    @State private var activeSettingsRoute: SettingsRoute? = Self.initialSidebarDestination.settingsRoute
    @State private var selectedSettingsRouteRequestID: Int = 0
    @State private var sidebarModel = RootSidebarModel()
    // Embedded Settings rows push onto the sidebar stack; clear it before
    // changing sidebar roots so stale settings detail screens cannot survive.
    @State private var sidebarNavigationPath: [SettingsRoute] = []
    @State private var isSidebarVisible: Bool = Self.initialSidebarVisibility ?? false
    @State private var sidebarVisibilityUserOverridden: Bool = Self.initialSidebarVisibility != nil
    @State private var isSidebarDrawerLayout: Bool = false
    @State private var didResolveSidebarLayout: Bool = false
    @State private var sidebarContentDragOffset: CGFloat = 0
    @State private var voiceWakeToastText: String?
    @State private var toastDismissTask: Task<Void, Never>?
    @State private var presentedSheet: PresentedSheet?
    @State private var showGatewayProblemDetails: Bool = false
    @State private var gatewayToastDragOffset: CGFloat = 0
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

    static func initialDestination(arguments: [String]) -> SidebarDestination {
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

        var id: Int {
            switch self {
            case .quickSetup: 0
            }
        }
    }

    var body: some View {
        self.rootPresentation(
            self.rootLifecycle(
                self.rootOverlays(
                    self.sidebarSplitContent
                        .tint(OpenClawBrand.accent))))
    }

    private var sidebarSplitContent: some View {
        GeometryReader { proxy in
            let isDrawerLayout = self.shouldUseSidebarDrawer(containerSize: proxy.size)
            let sidebarWidth = self.sidebarWidth(containerWidth: proxy.size.width, isDrawerLayout: isDrawerLayout)
            Group {
                if isDrawerLayout {
                    self.sidebarDrawerContent(
                        sidebarWidth: sidebarWidth,
                        safeAreaInsets: proxy.safeAreaInsets)
                } else {
                    self.sidebarNavigationSplitContent(sidebarWidth: sidebarWidth)
                }
            }
            .animation(self.sidebarAnimation, value: self.isSidebarVisible)
            .onAppear {
                self.updateSidebarLayout(containerSize: proxy.size, force: false)
            }
            .onChange(of: proxy.size) { _, size in
                self.updateSidebarLayout(containerSize: size, force: false)
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
        }
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
    }

    private func sidebarDrawerContent(
        sidebarWidth: CGFloat,
        safeAreaInsets: EdgeInsets) -> some View
    {
        ZStack(alignment: .leading) {
            // Occluded layers stay out of the accessibility tree: closed = content
            // only, open = sidebar only (the card is not interactive while open).
            self.sidebarDrawerLayer(sidebarWidth: sidebarWidth, safeAreaInsets: safeAreaInsets)
                .opacity(self.reduceMotion && !self.isSidebarVisible ? 0 : 1)
                .accessibilityHidden(!self.isSidebarVisible)

            // Keep the full-height surface outside NavigationStack so it can
            // cover the sidebar in safe areas without changing content insets.
            self.sidebarDrawerContentSurface(sidebarWidth: sidebarWidth)
                .opacity(self.reduceMotion && self.isSidebarVisible ? 0 : 1)
                .accessibilityHidden(true)

            self.sidebarDrawerContentCard(sidebarWidth: sidebarWidth)
                .opacity(self.reduceMotion && self.isSidebarVisible ? 0 : 1)
                .accessibilityHidden(self.isSidebarVisible)
                .zIndex(1)
        }
    }

    private func sidebarDrawerLayer(
        sidebarWidth: CGFloat,
        safeAreaInsets: EdgeInsets) -> some View
    {
        self.sidebarColumn(drawerSafeAreaInsets: safeAreaInsets)
            .frame(width: sidebarWidth, alignment: .topLeading)
            .frame(maxHeight: .infinity, alignment: .topLeading)
            .background(OpenClawSidebarPalette.background)
            .ignoresSafeArea(.container, edges: .vertical)
    }

    private func sidebarDrawerContentSurface(sidebarWidth: CGFloat) -> some View {
        let progress = self.sidebarContentRevealProgress(sidebarWidth: sidebarWidth)
        return RoundedRectangle(
            cornerRadius: OpenClawProMetric.drawerRadius * progress,
            style: .continuous)
            .fill(Color(uiColor: .systemGroupedBackground))
            .overlay(
                RoundedRectangle(
                    cornerRadius: OpenClawProMetric.drawerRadius * progress,
                    style: .continuous)
                    .strokeBorder(OpenClawSidebarPalette.hairline.opacity(Double(progress)), lineWidth: 1))
            .shadow(
                color: .black.opacity(0.28 * progress),
                radius: 20 * progress,
                x: -4 * progress,
                y: 0)
            .ignoresSafeArea(.container, edges: .vertical)
            .offset(x: Self.sidebarContentOffset(
                sidebarWidth: sidebarWidth,
                isVisible: self.isSidebarVisible,
                dragOffset: self.sidebarContentDragOffset,
                reduceMotion: self.reduceMotion))
    }

    private func sidebarDrawerContentCard(sidebarWidth: CGFloat) -> some View {
        let progress = self.sidebarContentRevealProgress(sidebarWidth: sidebarWidth)
        return ZStack {
            self.sidebarDetailNavigationShell
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .allowsHitTesting(!self.isSidebarVisible)

            // Tap-to-close stays available under Reduce Motion (the drags are
            // gated); otherwise the header X would be the only exit.
            if self.isSidebarVisible {
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture {
                        self.hideSidebar()
                    }
            }

            // Edge-open is chat-root only: pushed screens own the system
            // back-swipe on this edge, and other destinations push internally.
            if !self.isSidebarVisible, !self.reduceMotion,
               self.selectedSidebarDestination == .chat, self.sidebarNavigationPath.isEmpty
            {
                HStack(spacing: 0) {
                    Color.clear
                        .frame(width: 24)
                        .contentShape(Rectangle())
                        .gesture(self.sidebarEdgeOpenGesture(sidebarWidth: sidebarWidth))
                    Spacer(minLength: 0)
                }
            }
        }
        .contentShape(Rectangle())
        .gesture(
            self.sidebarContentDismissGesture(sidebarWidth: sidebarWidth),
            isEnabled: self.isSidebarVisible && !self.reduceMotion)
        .clipShape(RoundedRectangle(
            cornerRadius: OpenClawProMetric.drawerRadius * progress,
            style: .continuous))
        .offset(x: Self.sidebarContentOffset(
            sidebarWidth: sidebarWidth,
            isVisible: self.isSidebarVisible,
            dragOffset: self.sidebarContentDragOffset,
            reduceMotion: self.reduceMotion))
    }

    private var sidebarDetailShell: some View {
        self.sidebarDetail
            .id(self.sidebarDetailShellID)
    }

    /// RootSidebar owns its dark surface; this wrapper only restores vertical
    /// insets. Drawer mode goes full-bleed (ignoresSafeArea) so the captured
    /// insets are re-applied manually; split mode keeps system safe areas.
    private func sidebarColumn(drawerSafeAreaInsets: EdgeInsets? = nil) -> some View {
        RootSidebar(
            model: self.sidebarModel,
            selectedDestination: self.selectedSidebarDestination,
            isDrawerLayout: self.isSidebarDrawerLayout,
            selectDestination: self.selectSidebarDestination,
            selectSettingsRoute: self.selectSettingsRoute,
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
                ownsNavigationStack: false,
                openSettings: { self.selectSidebarDestination(.gateway) })
        case .overview:
            CommandCenterTab(
                ownsNavigationStack: false,
                headerTitle: "Overview",
                headerSidebarAction: self.sidebarHeaderAction,
                dashboardModel: self.sidebarModel,
                showsHeaderMark: false,
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
                    ownsNavigationStack: false,
                    navigateToRoute: pushSidebarSettingsRoute,
                    onRouteChange: handleSettingsRouteChange,
                    onApprovalNotificationsRoute: suppressExecApprovalPromptForNotificationSettings,
                    gatewaySetupRequest: self.gatewaySetupRequest,
                    onGatewaySetupRequestHandled: handleGatewaySetupRequest)
            } else {
                SettingsProTab(
                    headerSidebarAction: self.sidebarHeaderAction,
                    ownsNavigationStack: false,
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
                ownsNavigationStack: false,
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
        .clipped()
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

    private func sidebarContentRevealProgress(sidebarWidth: CGFloat) -> CGFloat {
        guard sidebarWidth > 0 else { return 0 }
        return Self.sidebarContentOffset(
            sidebarWidth: sidebarWidth,
            isVisible: self.isSidebarVisible,
            dragOffset: self.sidebarContentDragOffset,
            reduceMotion: self.reduceMotion) / sidebarWidth
    }

    private func sidebarContentDismissGesture(sidebarWidth: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                self.sidebarContentDragOffset = max(-sidebarWidth, min(0, value.translation.width))
            }
            .onEnded { value in
                let shouldDismiss = value.translation.width < -80 ||
                    value.predictedEndTranslation.width < -160
                withAnimation(self.sidebarAnimation) {
                    self.sidebarContentDragOffset = 0
                    if shouldDismiss {
                        self.sidebarVisibilityUserOverridden = true
                        self.setSidebarVisible(false)
                    }
                }
            }
    }

    private func sidebarEdgeOpenGesture(sidebarWidth: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                self.sidebarContentDragOffset = max(0, min(sidebarWidth, value.translation.width))
            }
            .onEnded { value in
                let shouldOpen = value.translation.width > 80 ||
                    value.predictedEndTranslation.width > 160
                withAnimation(self.sidebarAnimation) {
                    self.sidebarContentDragOffset = 0
                    if shouldOpen {
                        self.sidebarVisibilityUserOverridden = true
                        self.setSidebarVisible(true)
                    }
                }
            }
    }

    private func shouldUseSidebarDrawer(containerSize: CGSize) -> Bool {
        Self.sidebarLayoutMode(containerSize: containerSize) == .drawer
    }

    private func sidebarWidth(containerWidth: CGFloat, isDrawerLayout: Bool) -> CGFloat {
        Self.sidebarWidth(containerWidth: containerWidth, isDrawerLayout: isDrawerLayout)
    }

    private func rootOverlays(_ content: some View) -> some View {
        content
            .overlay(alignment: .top) {
                // Stable container so the toast's move/opacity transition animates
                // when the gateway problem appears or clears outside withAnimation.
                ZStack(alignment: .top) {
                    if let gatewayProblem = self.activeGatewayProblemToast {
                        self.gatewayProblemToast(gatewayProblem)
                    }
                }
                .animation(self.gatewayToastAnimation, value: self.activeGatewayProblemToast)
            }
            .overlay(alignment: .topLeading) {
                if let voiceWakeToastText, !voiceWakeToastText.isEmpty {
                    VoiceWakeToast(command: voiceWakeToastText)
                        .padding(.leading, 10)
                        .safeAreaPadding(.top, self.activeGatewayProblemToast == nil ? 58 : 132)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }

            .overlay {
                if self.appModel.cameraFlashNonce != 0 {
                    RootCameraFlashOverlay(nonce: self.appModel.cameraFlashNonce)
                }
            }
            .overlay {
                if self.appModel.screen.isCanvasPresented {
                    self.canvasPresentationOverlay
                        .transition(.opacity)
                        .zIndex(20)
                }
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

    private var canvasPresentationOverlay: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            ScreenWebView(controller: self.appModel.screen)
                .ignoresSafeArea()
            Button {
                self.appModel.screen.hideCanvas()
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 30, weight: .semibold))
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(.white)
                    .shadow(color: .black.opacity(0.32), radius: 8, y: 2)
                    .frame(width: 48, height: 48)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close canvas")
            .safeAreaPadding(.top, 8)
            .padding(.trailing, 12)
        }
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

                self.toastDismissTask?.cancel()
                withAnimation(self.reduceMotion ? .none : .spring(response: 0.25, dampingFraction: 0.85)) {
                    self.voiceWakeToastText = trimmed
                }

                self.toastDismissTask = Task {
                    try? await Task.sleep(nanoseconds: 2_300_000_000)
                    await MainActor.run {
                        withAnimation(self.reduceMotion ? .none : .easeOut(duration: 0.25)) {
                            self.voiceWakeToastText = nil
                        }
                    }
                }
            }
    }

    private func rootAppearLifecycle(_ content: some View) -> some View {
        content
            .onAppear { self.updateIdleTimer() }
            .onAppear { self.updateCanvasState() }
            .onAppear { self.evaluateOnboardingPresentation(force: false) }
            .onAppear { self.maybeAutoOpenSettings() }
            .onAppear { self.maybeOpenSettingsForGatewaySetup() }
            .onAppear { self.maybeShowQuickSetup() }
            .onAppear { self.applyInitialChatSessionIfNeeded() }
            .onChange(of: self.preventSleep) { _, _ in self.updateIdleTimer() }
            .onChange(of: self.appModel.talkMode.isEnabled) { _, _ in self.updateIdleTimer() }
            .onChange(of: self.scenePhase) { _, newValue in
                self.updateIdleTimer()
                self.updateHomeCanvasState()
                guard newValue == .active else { return }
                self.maybeRequestLocalNetworkAccess(reason: "scene_active")
                Task {
                    await self.appModel.refreshGatewayOverviewIfConnected()
                    await MainActor.run {
                        self.updateHomeCanvasState()
                    }
                }
            }
            .onDisappear {
                UIApplication.shared.isIdleTimerDisabled = false
                self.toastDismissTask?.cancel()
                self.toastDismissTask = nil
            }
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
            .onChange(of: self.canvasDebugStatusEnabled) { _, _ in self.updateCanvasDebugStatus() }
            .onChange(of: self.gatewayController.gateways.count) { _, _ in self.maybeShowQuickSetup() }
            .onChange(of: self.appModel.gatewayServerName) { _, newValue in
                if newValue != nil {
                    self.onboardingComplete = true
                    self.hasConnectedOnce = true
                    OnboardingStateStore.markCompleted(mode: nil)
                }
                self.maybeAutoOpenSettings()
                self.maybeShowQuickSetup()
                self.updateCanvasState()
            }
            .onChange(of: self.appModel.gatewayStatusText) { _, _ in self.updateCanvasState() }
            .onChange(of: self.appModel.gatewayRemoteAddress) { _, _ in self.updateCanvasState() }
            .onChange(of: self.appModel.gatewayDisplayStatusText) { _, _ in self.updateCanvasState() }
            .onChange(of: self.appModel.homeCanvasRevision) { _, _ in self.updateHomeCanvasState() }
            .onChange(of: self.appModel.gatewayAgents.count) { _, _ in self.updateHomeCanvasState() }
            .onChange(of: self.appModel.selectedAgentId) { _, _ in self.updateHomeCanvasState() }
            .onChange(of: self.appModel.gatewayDefaultAgentId) { _, _ in self.updateHomeCanvasState() }
            .onChange(of: self.appModel.activeAgentName) { _, _ in self.updateHomeCanvasState() }
            .onChange(of: self.appModel.connectedGatewayID) { _, _ in
                self.updateCanvasState()
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

    private var gatewayStatus: GatewayDisplayState {
        GatewayStatusBuilder.build(appModel: self.appModel)
    }

    private func updateIdleTimer() {
        UIApplication.shared.isIdleTimerDisabled =
            self.scenePhase == .active && (self.preventSleep || self.appModel.talkMode.isEnabled)
    }
}

extension RootTabs {
    private func updateCanvasState() {
        self.updateHomeCanvasState()
        self.updateCanvasDebugStatus()
    }

    private func updateCanvasDebugStatus() {
        self.appModel.screen.setDebugStatusEnabled(self.canvasDebugStatusEnabled)
        guard self.canvasDebugStatusEnabled else { return }
        let title = self.appModel.gatewayDisplayStatusText.trimmingCharacters(in: .whitespacesAndNewlines)
        let subtitle = self.appModel.gatewayServerName ?? self.appModel.gatewayRemoteAddress
        self.appModel.screen.updateDebugStatus(title: title, subtitle: subtitle)
    }

    private func updateHomeCanvasState() {
        let payload = self.makeHomeCanvasPayload()
        guard let data = try? JSONEncoder().encode(payload),
              let json = String(data: data, encoding: .utf8)
        else {
            self.appModel.screen.updateHomeCanvasState(json: nil)
            return
        }
        self.appModel.screen.updateHomeCanvasState(json: json)
    }

    private func makeHomeCanvasPayload() -> RootTabsHomeCanvasPayload {
        let gatewayName = normalized(appModel.gatewayServerName)
        let gatewayAddress = normalized(appModel.gatewayRemoteAddress)
        let gatewayLabel = gatewayName ?? gatewayAddress ?? "Gateway"
        let activeAgentID = self.resolveActiveAgentID()
        let agents = self.homeCanvasAgents(activeAgentID: activeAgentID)

        switch self.gatewayStatus {
        case .connected:
            return RootTabsHomeCanvasPayload(
                gatewayState: "connected",
                eyebrow: "\(gatewayLabel) online",
                title: "Command center",
                subtitle:
                "Use Chat for code work or realtime voice, plus gateway tools for approved device actions.",
                gatewayLabel: gatewayLabel,
                activeAgentName: self.appModel.activeAgentName,
                activeAgentBadge: agents.first(where: { $0.isActive })?.badge ?? "OC",
                activeAgentCaption: "Routes chat and voice",
                agentCount: agents.count,
                agents: Array(agents.prefix(6)),
                footer: "OpenClaw only runs phone-side capabilities while the app is connected and permitted.")
        case .connecting:
            return RootTabsHomeCanvasPayload(
                gatewayState: "connecting",
                eyebrow: "Gateway handshake",
                title: "Reconnecting",
                subtitle:
                "Restoring the local node session, agent list, voice config, and device capability state.",
                gatewayLabel: gatewayLabel,
                activeAgentName: self.appModel.activeAgentName,
                activeAgentBadge: "OC",
                activeAgentCaption: "Session in progress",
                agentCount: agents.count,
                agents: Array(agents.prefix(4)),
                footer: "If the gateway is reachable, the local node should recover without re-pairing.")
        case .error, .disconnected:
            return RootTabsHomeCanvasPayload(
                gatewayState: self.gatewayStatus == .error ? "error" : "offline",
                eyebrow: self.gatewayStatus == .error ? "Gateway needs attention" : "OpenClaw iOS",
                title: "Pair a gateway",
                subtitle:
                "Connect this phone as a local node for chat, realtime voice, share intake, and approved device tools.",
                gatewayLabel: gatewayLabel,
                activeAgentName: "Main",
                activeAgentBadge: "OC",
                activeAgentCaption: "Connect to load your agents",
                agentCount: agents.count,
                agents: Array(agents.prefix(4)),
                footer:
                "Use Settings to scan a pairing QR code or paste a setup code from your OpenClaw gateway.")
        }
    }

    private func resolveActiveAgentID() -> String {
        let selected = normalized(appModel.selectedAgentId) ?? ""
        if !selected.isEmpty {
            return selected
        }
        return self.resolveDefaultAgentID()
    }

    private func resolveDefaultAgentID() -> String {
        normalized(self.appModel.gatewayDefaultAgentId) ?? ""
    }

    private func homeCanvasAgents(activeAgentID: String) -> [RootTabsHomeCanvasAgentCard] {
        let defaultAgentID = self.resolveDefaultAgentID()
        let cards = self.appModel.gatewayAgents.map { agent -> RootTabsHomeCanvasAgentCard in
            let isActive = !activeAgentID.isEmpty && agent.id == activeAgentID
            let isDefault = !defaultAgentID.isEmpty && agent.id == defaultAgentID
            return RootTabsHomeCanvasAgentCard(
                id: agent.id,
                name: self.homeCanvasName(for: agent),
                badge: self.homeCanvasBadge(for: agent),
                caption: isActive ? "Routed on this phone" : (isDefault ? "Gateway default" : "Available"),
                isActive: isActive)
        }

        return cards.sorted { lhs, rhs in
            if lhs.isActive != rhs.isActive {
                return lhs.isActive
            }
            return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }
    }

    private func homeCanvasName(for agent: AgentSummary) -> String {
        normalized(agent.name) ?? agent.id
    }
}

extension RootTabs {
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
        self.sidebarContentDragOffset = 0
        self.isSidebarVisible = isVisible
    }

    private func homeCanvasBadge(for agent: AgentSummary) -> String {
        if let identity = agent.identity,
           let emoji = identity["emoji"]?.value as? String,
           let normalizedEmoji = normalized(emoji)
        {
            return normalizedEmoji
        }
        let words = self.homeCanvasName(for: agent)
            .split(whereSeparator: { $0.isWhitespace || $0 == "-" || $0 == "_" })
            .prefix(2)
        let initials = words.compactMap(\.first).map(String.init).joined()
        if !initials.isEmpty {
            return initials.uppercased()
        }
        return "OC"
    }

    private func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
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
            Task { await self.gatewayController.connectActiveGateway() }
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
    var nonce: Int

    @State private var opacity: CGFloat = 0
    @State private var task: Task<Void, Never>?

    var body: some View {
        Color.white
            .opacity(self.opacity)
            .ignoresSafeArea()
            .allowsHitTesting(false)
            .onChange(of: self.nonce) { _, _ in
                self.task?.cancel()
                self.task = Task { @MainActor in
                    withAnimation(.easeOut(duration: 0.08)) {
                        self.opacity = 0.85
                    }
                    try? await Task.sleep(nanoseconds: 110_000_000)
                    withAnimation(.easeOut(duration: 0.32)) {
                        self.opacity = 0
                    }
                }
            }
            .onDisappear {
                self.task?.cancel()
                self.task = nil
            }
    }
}

#if DEBUG
#Preview(
    "Shell iPhone portrait",
    traits: .fixedLayout(width: 393, height: 852),
    .portrait)
{
    RootTabsPreviewHost(idiom: .phone)
}

#Preview(
    "Shell iPhone drawer open",
    traits: .fixedLayout(width: 393, height: 852),
    .portrait)
{
    RootTabsPreviewHost(idiom: .phone, sidebarVisible: true)
}

#Preview(
    "Shell iPhone connected",
    traits: .fixedLayout(width: 393, height: 852),
    .portrait)
{
    RootTabsPreviewHost(idiom: .phone, gatewayState: .connected)
}

#Preview(
    "Shell iPhone gateway error",
    traits: .fixedLayout(width: 393, height: 852),
    .portrait)
{
    RootTabsPreviewHost(idiom: .phone, gatewayState: .error)
}

#Preview(
    "Shell iPhone landscape",
    traits: .fixedLayout(width: 852, height: 393),
    .landscapeLeft)
{
    RootTabsPreviewHost(idiom: .phone)
        .environment(\.horizontalSizeClass, .regular)
        .environment(\.verticalSizeClass, .compact)
}

#Preview(
    "Shell iPad portrait drawer",
    traits: .fixedLayout(width: 1024, height: 1366),
    .portrait)
{
    RootTabsPreviewHost(idiom: .pad)
}

#Preview(
    "Shell iPad landscape split",
    traits: .fixedLayout(width: 1366, height: 1024),
    .landscapeLeft)
{
    RootTabsPreviewHost(idiom: .pad, gatewayState: .connected)
}

#Preview(
    "Shell iPad connecting",
    traits: .fixedLayout(width: 1366, height: 1024),
    .landscapeLeft)
{
    RootTabsPreviewHost(idiom: .pad, gatewayState: .connecting)
}

#Preview(
    "Shell iPad gateway error",
    traits: .fixedLayout(width: 1366, height: 1024),
    .landscapeLeft)
{
    RootTabsPreviewHost(idiom: .pad, gatewayState: .error)
}

private struct RootTabsPreviewHost: View {
    @State private var appearanceModel = AppAppearanceModel()
    @State private var appModel: NodeAppModel
    @State private var gatewayController: GatewayConnectionController
    private let idiom: UIUserInterfaceIdiom
    private let sidebarVisible: Bool?

    init(
        idiom: UIUserInterfaceIdiom,
        gatewayState: RootTabsPreviewGatewayState = .offline,
        sidebarVisible: Bool? = nil)
    {
        let appModel = NodeAppModel()
        gatewayState.apply(to: appModel)
        self.idiom = idiom
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
