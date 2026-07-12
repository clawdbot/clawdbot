import OpenClawKit
import OpenClawProtocol
import SwiftUI
import UIKit

struct RootTabs: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(VoiceWakeManager.self) private var voiceWake
    @Environment(GatewayConnectionController.self) private var gatewayController
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.rootTabsUserInterfaceIdiomOverride) private var userInterfaceIdiomOverride
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
    @State private var selectedTab: AppTab = Self.initialTab
    @State private var selectedSidebarDestination: SidebarDestination = Self.initialSidebarDestination
    @State private var selectedSettingsRoute: SettingsRoute? = Self.initialSidebarDestination.settingsRoute
    @State private var activeSettingsRoute: SettingsRoute? = Self.initialSidebarDestination.settingsRoute
    @State private var selectedSettingsRouteRequestID: Int = 0
    @State private var phoneControlNavigationRequest: PhoneControlNavigationRequest?
    @State private var phoneChatReturn: PhoneChatReturn?
    @State private var phoneChatSettingsResetRequestID: Int = 0
    // Embedded Settings rows push onto the sidebar stack; clear it before
    // changing sidebar roots so stale settings detail screens cannot survive.
    @State private var sidebarNavigationPath: [SettingsRoute] = []
    @State private var isSidebarVisible: Bool = Self.initialSidebarVisibility ?? false
    @State private var sidebarVisibilityUserOverridden: Bool = Self.initialSidebarVisibility != nil
    @State private var isSidebarDrawerLayout: Bool = false
    @State private var didResolveSidebarLayout: Bool = false
    @State private var voiceWakeToastText: String?
    @State private var toastDismissTask: Task<Void, Never>?
    @State private var presentedSheet: PresentedSheet?
    @State private var showGatewayProblemDetails: Bool = false
    @State private var gatewayToastDragOffset: CGFloat = 0
    // Swipe-up hides the toast only until the next problem report; every report
    // (even an equal problem) must re-surface it or shake the visible toast.
    @State private var isGatewayToastSwipeDismissed: Bool = false
    @State private var gatewayToastShake: CGFloat = 0
    // Mirror of the problem at the last handled report, used to tell a first
    // appearance (animate in) from a re-report while visible (shake).
    @State private var lastReportedGatewayProblem: GatewayConnectionProblem?
    @State private var showOnboarding: Bool = false
    @State private var onboardingAllowSkip: Bool = true
    @State private var didEvaluateOnboarding: Bool = false
    @State private var didAutoOpenSettings: Bool = false
    @State private var didApplyInitialChatSession: Bool = false
    @State private var gatewaySetupRequest: GatewaySetupRequest?
    @State private var suppressedExecApprovalForNotificationSettings: NodeAppModel.ExecApprovalInboxKey?

    private static var initialTab: AppTab {
        Self.initialTab(arguments: ProcessInfo.processInfo.arguments)
    }

    static func initialTab(arguments: [String]) -> AppTab {
        guard let flagIndex = arguments.firstIndex(of: "--openclaw-initial-tab") else {
            return self.fallbackInitialTab(arguments: arguments)
        }
        let valueIndex = arguments.index(after: flagIndex)
        guard arguments.indices.contains(valueIndex) else {
            return Self.fallbackInitialTab(arguments: arguments)
        }

        switch arguments[valueIndex].lowercased() {
        case "control", "overview":
            return .control
        case "chat":
            return .chat
        case "talk", "voice":
            return .talk
        case "agent", "agents":
            return .agent
        case "settings":
            return .settings
        default:
            return Self.fallbackInitialTab(arguments: arguments)
        }
    }

    private static func fallbackInitialTab(arguments: [String]) -> AppTab {
        self.requestedInitialSidebarDestination(arguments: arguments)?.appTab ?? .chat
    }

    private static var initialSidebarDestination: SidebarDestination {
        if let requested = requestedInitialSidebarDestination {
            return requested
        }
        return Self.defaultSidebarDestination(for: initialTab)
    }

    private static var requestedInitialSidebarDestination: SidebarDestination? {
        Self.requestedInitialSidebarDestination(arguments: ProcessInfo.processInfo.arguments)
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

    static func shouldUseSidebarTabs(
        idiom: UIUserInterfaceIdiom,
        horizontalSizeClass _: UserInterfaceSizeClass?) -> Bool
    {
        idiom == .pad
    }

    var body: some View {
        self.rootPresentation(
            self.rootLifecycle(
                self.rootOverlays(
                    self.tabContent
                        .tint(OpenClawBrand.accent))))
    }

    @ViewBuilder
    private var tabContent: some View {
        if self.usesSidebarTabs {
            self.sidebarSplitContent
        } else {
            self.phoneTabContent
        }
    }

    private var phoneTabContent: some View {
        TabView(selection: self.phoneTabSelection) {
            PhoneTabSettingsHost(resetRequestID: self.phoneChatSettingsResetRequestID) { openSettingsRoute in
                ChatProTab(
                    headerLeadingAction: self.phoneChatReturnAction,
                    ownsNavigationStack: false,
                    openSettings: { openSettingsRoute(.gateway) })
            }
            .tabItem { Label("Chat", systemImage: "bubble.left.fill") }
            .tag(AppTab.chat)

            PhoneTabSettingsHost { openSettingsRoute in
                TalkProTab(
                    ownsNavigationStack: false,
                    openSettings: { openSettingsRoute(.gateway) },
                    openVoiceSettings: { openSettingsRoute(.voice) })
            }
            .tabItem {
                Label(
                    "Talk",
                    systemImage: self.appModel.talkMode.isEnabled ? "waveform.circle.fill" : "waveform.circle")
                    .font(OpenClawType.captionSemiBold)
            }
            .tag(AppTab.talk)

            RootTabsPhoneControlHub(
                groups: Self.phoneControlGroups,
                initialDestination: Self.requestedInitialSidebarDestination,
                navigationRequest: self.phoneControlNavigationRequest,
                openRootDestination: { self.selectSidebarDestination($0) },
                openChatFromControlDetail: { self.openChatFromControlDetail($0) })
                .tabItem { Label("Control", systemImage: "square.grid.2x2") }
                .badge(self.appModel.pendingExecApprovalCount)
                .tag(AppTab.control)

            PhoneTabSettingsHost { openSettingsRoute in
                AgentProTab(
                    directRoute: .agents,
                    openSettings: { openSettingsRoute(.gateway) })
            }
            .tabItem { Label("Agent", systemImage: "person.2.fill") }
            .tag(AppTab.agent)

            SettingsProTab(
                initialRoute: self.selectedSettingsRoute,
                acceptsGatewaySetupRequests: !self.showOnboarding &&
                    self.selectedTab == .settings &&
                    self.selectedSettingsRoute == .gateway,
                onRouteChange: self.handleSettingsRouteChange,
                onApprovalNotificationsRoute: self.suppressExecApprovalPromptForNotificationSettings,
                gatewaySetupRequest: self.gatewaySetupRequest,
                onGatewaySetupRequestHandled: self.handleGatewaySetupRequest)
                .id(self.settingsTabViewID)
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
                .tag(AppTab.settings)
        }
        .openClawTabBarBehavior()
    }

    private var sidebarSplitContent: some View {
        GeometryReader { proxy in
            let isDrawerLayout = self.shouldUseSidebarDrawer(containerSize: proxy.size)
            let sidebarWidth = self.sidebarWidth(containerWidth: proxy.size.width, isDrawerLayout: isDrawerLayout)
            Group {
                if isDrawerLayout {
                    self.sidebarDrawerContent(sidebarWidth: sidebarWidth)
                } else {
                    self.sidebarNavigationSplitContent(sidebarWidth: sidebarWidth)
                }
            }
            .animation(.easeInOut(duration: 0.22), value: self.isSidebarVisible)
            .onAppear {
                self.updateSidebarLayout(containerSize: proxy.size, force: false)
            }
            .onChange(of: proxy.size) { _, size in
                self.updateSidebarLayout(containerSize: size, force: false)
            }
        }
    }

    private func sidebarNavigationSplitContent(sidebarWidth: CGFloat) -> some View {
        HStack(spacing: 0) {
            if self.isSidebarVisible {
                self.sidebarColumn
                    .frame(width: sidebarWidth, alignment: .topLeading)
                    .frame(maxHeight: .infinity, alignment: .topLeading)
                    .overlay(alignment: .trailing) {
                        self.sidebarVerticalSeparator
                    }
                    .transition(.move(edge: .leading).combined(with: .opacity))
            }

            self.sidebarDetailNavigationShell
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .background(OpenClawProBackground())
    }

    private func sidebarDrawerContent(sidebarWidth: CGFloat) -> some View {
        ZStack(alignment: .topLeading) {
            self.sidebarDetailNavigationShell
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            if self.isSidebarVisible {
                HStack(spacing: 0) {
                    Color.clear
                        .frame(width: sidebarWidth)
                        .allowsHitTesting(false)
                    Color.black.opacity(0.28)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            self.hideSidebar()
                        }
                }
                .ignoresSafeArea()
                .transition(.opacity)
                .zIndex(0)

                self.sidebarColumn
                    .frame(width: sidebarWidth, alignment: .topLeading)
                    .frame(maxHeight: .infinity, alignment: .topLeading)
                    .overlay(alignment: .trailing) {
                        self.sidebarVerticalSeparator
                    }
                    .shadow(color: .black.opacity(0.26), radius: 18, x: 8, y: 0)
                    .transition(.move(edge: .leading).combined(with: .opacity))
                    .zIndex(1)
            }
        }
    }

    private var sidebarDetailShell: some View {
        self.sidebarDetail
            .id(self.sidebarDetailShellID)
    }

    private var sidebarColumn: some View {
        VStack(spacing: 0) {
            self.sidebarIdentityHeader
            self.sidebarList
        }
        .safeAreaPadding(.top, 8)
        .safeAreaPadding(.bottom, 8)
        .background(Color(uiColor: .systemBackground))
    }

    private var sidebarIdentityHeader: some View {
        HStack(spacing: 10) {
            OpenClawProMark(size: 30, shadowRadius: 3)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text("OpenClaw")
                    .font(OpenClawType.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(1)

                HStack(spacing: 4) {
                    Image(systemName: "circle.fill")
                        .font(.system(size: 7, weight: .bold))
                        .foregroundStyle(self.sidebarGatewayStatusColor)
                    Text(self.sidebarGatewayStatusTitle)
                        .font(OpenClawType.captionMedium)
                        .lineLimit(1)
                }
                .font(OpenClawType.captionMedium)
                .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)

            if self.isSidebarDrawerLayout {
                self.sidebarHideButton
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(Color(uiColor: .systemBackground))
        .overlay(alignment: .bottom) {
            self.sidebarHorizontalSeparator
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            String(
                format: String(localized: "OpenClaw %@"),
                self.sidebarGatewayStatusTitle))
    }

    private var sidebarGatewayStatusTitle: String {
        switch self.gatewayStatus {
        case .connected:
            String(localized: "Online")
        case .connecting:
            String(localized: "Connecting")
        case .error:
            String(localized: "Needs attention")
        case .disconnected:
            String(localized: "Offline")
        }
    }

    private var sidebarList: some View {
        List {
            ForEach(Self.sidebarGroups) { group in
                Section(group.title.capitalized) {
                    ForEach(group.destinations) { destination in
                        self.sidebarDestinationButton(destination)
                    }
                }
                .listSectionSeparator(.hidden, edges: .all)
            }
        }
        .listStyle(.sidebar)
        .tint(OpenClawBrand.accent)
        .scrollContentBackground(.hidden)
        .background(Color(uiColor: .systemBackground))
    }

    private var sidebarHorizontalSeparator: some View {
        Rectangle()
            .fill(Color(uiColor: .separator))
            .frame(height: 1 / UIScreen.main.scale)
    }

    private var sidebarVerticalSeparator: some View {
        Rectangle()
            .fill(Color(uiColor: .separator))
            .frame(width: 1 / UIScreen.main.scale)
    }

    private var sidebarGatewayStatusColor: Color {
        switch self.gatewayStatus {
        case .connected:
            OpenClawBrand.ok
        case .connecting:
            OpenClawBrand.accent
        case .error:
            OpenClawBrand.warn
        case .disconnected:
            .secondary
        }
    }

    private func sidebarDestinationButton(
        _ destination: SidebarDestination,
        title: String? = nil) -> some View
    {
        Button {
            self.selectSidebarDestination(destination)
        } label: {
            Label(title ?? destination.sidebarTitle, systemImage: destination.systemImage)
                .font(OpenClawType.subheadSemiBold)
                .lineLimit(1)
                .minimumScaleFactor(0.82)
                .truncationMode(.tail)
                .padding(.vertical, 8)
                .padding(.horizontal, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
        }
        .font(OpenClawType.subheadSemiBold)
        .buttonStyle(.plain)
        .foregroundStyle(destination == self.selectedSidebarDestination ? OpenClawBrand.accent : .primary)
        .listRowBackground(
            destination == self.selectedSidebarDestination
                ? OpenClawBrand.accent.opacity(0.12)
                : Color.clear)
        .listRowSeparator(.hidden, edges: .all)
    }

    @ViewBuilder
    private var sidebarDetail: some View {
        switch self.selectedSidebarDestination {
        case .chat:
            ChatProTab(
                headerLeadingAction: self.sidebarHeaderLeadingAction,
                headerTitle: "Chat",
                showsAgentBadge: false,
                ownsNavigationStack: false,
                openSettings: { self.selectSidebarDestination(.gateway) })
        case .talk:
            TalkProTab(
                headerLeadingAction: self.sidebarHeaderLeadingAction,
                ownsNavigationStack: false,
                openSettings: { self.selectSidebarDestination(.gateway) },
                openVoiceSettings: { self.selectSettingsRoute(.voice) })
        case .overview:
            CommandCenterTab(
                ownsNavigationStack: false,
                headerTitle: "Overview",
                headerLeadingAction: self.sidebarHeaderLeadingAction,
                showsHeaderMark: false,
                openChat: { self.selectSidebarDestination(.chat) },
                openSettings: { self.selectSidebarDestination(.gateway) },
                openSessions: { self.selectSidebarDestination(.sessions) })
        case .activity:
            IPadActivityScreen(
                headerLeadingAction: self.sidebarHeaderLeadingAction,
                openChat: { self.selectSidebarDestination(.chat) },
                openSettings: { self.selectSidebarDestination(.gateway) })
        case .workboard:
            IPadWorkboardScreen(
                headerLeadingAction: self.sidebarHeaderLeadingAction,
                openChat: { self.selectSidebarDestination(.chat) },
                openSettings: { self.selectSidebarDestination(.gateway) })
        case .skillWorkshop:
            IPadSkillWorkshopScreen(
                headerLeadingAction: self.sidebarHeaderLeadingAction,
                openSettings: { self.selectSidebarDestination(.gateway) })
        case .agents:
            AgentProTab(
                directRoute: .agents,
                headerLeadingAction: self.sidebarHeaderLeadingAction,
                headerTitle: "Agents",
                openSettings: { self.selectSidebarDestination(.gateway) })
                .id(self.selectedSidebarDestination.id)
        case .instances:
            AgentProTab(
                directRoute: .instances,
                headerLeadingAction: self.sidebarHeaderLeadingAction,
                headerTitle: "Instances",
                openSettings: { self.selectSidebarDestination(.gateway) })
                .id(self.selectedSidebarDestination.id)
        case .sessions:
            CommandSessionsScreen(
                headerLeadingAction: self.sidebarHeaderLeadingAction,
                openChat: { self.selectSidebarDestination(.chat) })
        case .files:
            AgentProTab(
                directRoute: .files,
                headerLeadingAction: self.sidebarHeaderLeadingAction,
                headerTitle: "Files",
                openSettings: { self.selectSidebarDestination(.gateway) })
                .id(self.selectedSidebarDestination.id)
        case .dreaming:
            AgentProTab(
                directRoute: .dreaming,
                headerLeadingAction: self.sidebarHeaderLeadingAction,
                headerTitle: "Dreaming",
                openSettings: { self.selectSidebarDestination(.gateway) })
                .id(self.selectedSidebarDestination.id)
        case .usage:
            AgentProTab(
                directRoute: .usage,
                headerLeadingAction: self.sidebarHeaderLeadingAction,
                headerTitle: "Usage",
                openSettings: { self.selectSidebarDestination(.gateway) })
                .id(self.selectedSidebarDestination.id)
        case .cron:
            AgentProTab(
                directRoute: .cron,
                headerLeadingAction: self.sidebarHeaderLeadingAction,
                headerTitle: "Cron Jobs",
                openSettings: { self.selectSidebarDestination(.gateway) })
                .id(self.selectedSidebarDestination.id)
        case .terminal:
            TerminalHubScreen(
                gatewayAction: { self.selectSidebarDestination(.gateway) })
        case .docs:
            OpenClawDocsScreen(
                headerLeadingAction: self.sidebarHeaderLeadingAction,
                gatewayAction: { self.selectSidebarDestination(.gateway) })
        case .settings:
            if let selectedSettingsRoute {
                SettingsProTab(
                    directRoute: selectedSettingsRoute,
                    headerLeadingAction: self.sidebarHeaderLeadingAction,
                    ownsNavigationStack: false,
                    navigateToRoute: pushSidebarSettingsRoute,
                    onRouteChange: handleSettingsRouteChange,
                    onApprovalNotificationsRoute: suppressExecApprovalPromptForNotificationSettings,
                    gatewaySetupRequest: self.gatewaySetupRequest,
                    onGatewaySetupRequestHandled: handleGatewaySetupRequest)
            } else {
                SettingsProTab(
                    headerLeadingAction: self.sidebarHeaderLeadingAction,
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
                headerLeadingAction: self.sidebarHeaderLeadingAction,
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

    private var usesSidebarTabs: Bool {
        Self.shouldUseSidebarTabs(
            idiom: self.userInterfaceIdiom,
            horizontalSizeClass: self.horizontalSizeClass)
    }

    private var userInterfaceIdiom: UIUserInterfaceIdiom {
        if let userInterfaceIdiomOverride {
            return userInterfaceIdiomOverride
        }
        return UIDevice.current.userInterfaceIdiom
    }

    private var sidebarDetailShellID: String {
        let routeID = self.selectedSettingsRoute.map { "\($0)" } ?? "root"
        return "\(self.selectedSidebarDestination.id):\(routeID):\(self.selectedSettingsRouteRequestID)"
    }

    private var settingsTabViewID: String {
        let routeID = self.selectedSettingsRoute.map { "\($0)" } ?? "settings"
        return "\(routeID):\(self.selectedSettingsRouteRequestID)"
    }

    private var activeExecApprovalPromptSuppression: NodeAppModel.ExecApprovalInboxKey? {
        guard self.selectedTab == .settings else { return nil }
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

    private var sidebarHeaderLeadingAction: OpenClawSidebarHeaderAction? {
        guard Self.shouldShowSidebarRevealInDestinationHeader(
            isSidebarVisible: self.isSidebarVisible,
            layoutMode: self.isSidebarDrawerLayout ? .drawer : .split)
        else {
            return nil
        }
        if self.isSidebarVisible {
            return OpenClawSidebarHeaderAction(
                systemName: "sidebar.left",
                accessibilityLabel: .localized("Hide Sidebar"),
                accessibilityIdentifier: Self.sidebarHideButtonAccessibilityIdentifier,
                action: { self.hideSidebar() })
        }
        return OpenClawSidebarHeaderAction(
            systemName: "sidebar.left",
            accessibilityLabel: .localized("Show Sidebar"),
            accessibilityIdentifier: Self.sidebarShowButtonAccessibilityIdentifier,
            action: { self.showSidebar() })
    }

    private var phoneChatReturnAction: OpenClawSidebarHeaderAction? {
        guard !self.usesSidebarTabs, let phoneChatReturn else { return nil }
        return OpenClawSidebarHeaderAction(
            systemName: "chevron.left",
            accessibilityLabel: .verbatim(
                String(
                    format: String(localized: "Back to %@"),
                    phoneChatReturn.destination.title)),
            accessibilityIdentifier: "OpenClawChatBackToControlDetailButton",
            action: { self.openPhoneControlDetail(phoneChatReturn.destination) })
    }

    /// TabView writes through this binding; internal routing writes selectedTab directly.
    /// That distinction keeps only a user-selected Control tab responsible for resetting its child stack.
    private var phoneTabSelection: Binding<AppTab> {
        Binding(
            get: { self.selectedTab },
            set: { self.handlePhoneTabSelection($0) })
    }

    private var sidebarHideButton: some View {
        Button {
            self.hideSidebar()
        } label: {
            Image(systemName: self.isSidebarDrawerLayout ? "xmark" : "sidebar.left")
                .font(OpenClawType.subheadSemiBold)
        }
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
        .buttonStyle(.plain)
        .foregroundStyle(OpenClawBrand.accent)
        .accessibilityLabel("Hide Sidebar")
        .accessibilityIdentifier(Self.sidebarHideButtonAccessibilityIdentifier)
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
            .modifier(GatewayToastShakeEffect(animatableData: self.gatewayToastShake))
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
        let toastWasVisible = self.lastReportedGatewayProblem != nil && !self.isGatewayToastSwipeDismissed
        self.lastReportedGatewayProblem = self.appModel.lastGatewayProblem
        if self.isGatewayToastSwipeDismissed {
            self.isGatewayToastSwipeDismissed = false
            return
        }
        guard toastWasVisible, self.activeGatewayProblemToast != nil else { return }
        withAnimation(self.reduceMotion ? nil : .linear(duration: 0.4)) {
            self.gatewayToastShake += 1
        }
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
            .onAppear { self.lastReportedGatewayProblem = self.appModel.lastGatewayProblem }
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
                    self.lastReportedGatewayProblem = nil
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
            .onChange(of: self.appModel.gatewaySetupRequestID) { _, _ in
                self.maybeOpenSettingsForGatewaySetup()
            }
            .onChange(of: NodeAppModel.execApprovalInboxKey(self.appModel.pendingExecApprovalPrompt)) { _, newValue in
                if newValue != self.suppressedExecApprovalForNotificationSettings {
                    self.suppressedExecApprovalForNotificationSettings = nil
                }
            }
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
                "Use Chat for code work, Talk for realtime voice, and gateway tools for approved device actions.",
                gatewayLabel: gatewayLabel,
                activeAgentName: self.appModel.activeAgentName,
                activeAgentBadge: agents.first(where: { $0.isActive })?.badge ?? "OC",
                activeAgentCaption: "Routes chat and talk",
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
    private func selectSidebarDestination(
        _ destination: SidebarDestination,
        preservingChatReturn: Bool = false)
    {
        if destination != .chat || !preservingChatReturn {
            self.phoneChatReturn = nil
        }
        self.sidebarNavigationPath.removeAll()
        if destination.settingsRoute != .notifications {
            self.suppressedExecApprovalForNotificationSettings = nil
        }
        self.selectedSidebarDestination = destination
        self.selectedSettingsRoute = destination.settingsRoute
        self.activeSettingsRoute = destination.settingsRoute
        self.selectedTab = destination.appTab
        self.requestPhoneControlDestinationIfNeeded(destination)
        guard self.usesSidebarTabs, self.shouldCollapseSidebarAfterSelection else { return }
        withAnimation(.easeInOut(duration: 0.22)) {
            self.setSidebarVisible(false)
        }
    }

    private func openChatFromControlDetail(_ returnDestination: SidebarDestination) {
        // Detail screens focus a session before invoking this route callback. Remember that
        // synchronous request so its later observation cannot erase the contextual return.
        self.phoneChatReturn = PhoneChatReturn(
            destination: returnDestination,
            openChatRequestID: self.appModel.openChatRequestID)
        // Chat owns an embedded Settings stack. Pop it before routing so the requested
        // session and contextual return action cannot remain hidden behind Settings.
        self.phoneChatSettingsResetRequestID &+= 1
        self.selectSidebarDestination(.chat, preservingChatReturn: true)
    }

    private func handleOpenChatRequest(_ requestID: Int) {
        guard requestID != self.phoneChatReturn?.openChatRequestID else { return }
        self.selectSidebarDestination(.chat)
    }

    private func openPhoneControlDetail(_ destination: SidebarDestination) {
        self.selectSidebarDestination(destination)
        if destination == .overview {
            self.requestPhoneControlDestinationIfNeeded(destination, force: true)
        }
    }

    private func handlePhoneTabSelection(_ selectedTab: AppTab) {
        if selectedTab != .chat {
            self.phoneChatReturn = nil
        }
        if selectedTab == .control {
            self.requestPhoneControlNavigation(.root)
        }
        self.selectedTab = selectedTab
    }

    private func requestPhoneControlDestinationIfNeeded(
        _ destination: SidebarDestination,
        force: Bool = false)
    {
        guard !self.usesSidebarTabs else { return }
        guard destination.appTab == .control else { return }
        guard force || destination != .overview else { return }
        self.requestPhoneControlNavigation(.detail(destination))
    }

    private func requestPhoneControlNavigation(_ target: PhoneControlNavigationRequest.Target) {
        let requestID = (phoneControlNavigationRequest?.id ?? 0) &+ 1
        self.phoneControlNavigationRequest = PhoneControlNavigationRequest(id: requestID, target: target)
    }

    private func selectSettingsRoute(_ route: SettingsRoute) {
        self.phoneChatReturn = nil
        self.sidebarNavigationPath.removeAll()
        if route != .notifications {
            self.suppressedExecApprovalForNotificationSettings = nil
        }
        self.selectedSettingsRoute = route
        self.activeSettingsRoute = route
        self.selectedSettingsRouteRequestID &+= 1
        self.selectedSidebarDestination = .settings
        self.selectedTab = .settings
        guard self.usesSidebarTabs, self.shouldCollapseSidebarAfterSelection else { return }
        withAnimation(.easeInOut(duration: 0.22)) {
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
            if self.selectedTab == .settings {
                self.selectedSidebarDestination = .settings
            }
        }
        self.suppressedExecApprovalForNotificationSettings = nil
    }

    private func handleSidebarSettingsNavigationPathChange(_ navigationPath: [SettingsRoute]) {
        guard self.selectedTab == .settings else { return }
        let baseRoute = self.selectedSettingsRoute ?? self.selectedSidebarDestination.settingsRoute
        let route = Self.visibleSettingsRoute(
            navigationPath: navigationPath,
            baseRoute: baseRoute)
        self.handleSettingsRouteChange(route)
    }

    private func showSidebar() {
        self.sidebarVisibilityUserOverridden = true
        withAnimation(.easeInOut(duration: 0.22)) {
            self.setSidebarVisible(true)
        }
    }

    private func hideSidebar() {
        self.sidebarVisibilityUserOverridden = true
        withAnimation(.easeInOut(duration: 0.22)) {
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

/// Phone tabs push Settings routes (gateway, voice) onto their own stack so
/// Back returns to the tab content the user navigated from; only global flows
/// (deep links, onboarding, problem banner) jump to the canonical Settings tab.
private struct PhoneTabSettingsHost<Content: View>: View {
    @State private var settingsPath: [SettingsRoute] = []
    private let resetRequestID: Int
    private let content: (_ openSettingsRoute: @escaping (SettingsRoute) -> Void) -> Content

    init(
        resetRequestID: Int = 0,
        @ViewBuilder content: @escaping (_ openSettingsRoute: @escaping (SettingsRoute) -> Void) -> Content)
    {
        self.resetRequestID = resetRequestID
        self.content = content
    }

    var body: some View {
        NavigationStack(path: self.$settingsPath) {
            self.content { route in
                self.settingsPath.append(route)
            }
            .navigationDestination(for: SettingsRoute.self) { route in
                SettingsProTab(directRoute: route)
            }
        }
        .onChange(of: self.resetRequestID) { _, _ in
            self.settingsPath.removeAll()
        }
    }
}

private struct RootTabsHomeCanvasPayload: Codable {
    var gatewayState: String
    var eyebrow: String
    var title: String
    var subtitle: String
    var gatewayLabel: String
    var activeAgentName: String
    var activeAgentBadge: String
    var activeAgentCaption: String
    var agentCount: Int
    var agents: [RootTabsHomeCanvasAgentCard]
    var footer: String
}

private struct RootTabsHomeCanvasAgentCard: Codable {
    var id: String
    var name: String
    var badge: String
    var caption: String
    var isActive: Bool
}

/// Horizontal shake for re-reported gateway problems: three oscillations that
/// settle back to identity at integer trigger values.
private struct GatewayToastShakeEffect: GeometryEffect {
    var animatableData: CGFloat

    func effectValue(size _: CGSize) -> ProjectionTransform {
        ProjectionTransform(CGAffineTransform(translationX: 7 * sin(self.animatableData * 6 * .pi), y: 0))
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

extension EnvironmentValues {
    @Entry var rootTabsUserInterfaceIdiomOverride: UIUserInterfaceIdiom?
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

    init(idiom: UIUserInterfaceIdiom, gatewayState: RootTabsPreviewGatewayState = .offline) {
        let appModel = NodeAppModel()
        gatewayState.apply(to: appModel)
        self.idiom = idiom
        _appModel = State(initialValue: appModel)
        _gatewayController = State(
            initialValue: GatewayConnectionController(appModel: appModel, startDiscovery: false))
    }

    var body: some View {
        RootTabs()
            .environment(self.appearanceModel)
            .environment(self.appModel)
            .environment(self.appModel.voiceWake)
            .environment(self.gatewayController)
            .environment(\.rootTabsUserInterfaceIdiomOverride, self.idiom)
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
