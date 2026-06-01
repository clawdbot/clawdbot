import OpenClawKit
import OpenClawProtocol
import SwiftUI
import UIKit

struct RootTabs: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(VoiceWakeManager.self) private var voiceWake
    @Environment(GatewayConnectionController.self) private var gatewayController
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
    @AppStorage(AppAppearancePreference.storageKey) private var appearancePreferenceRaw: String =
        AppAppearancePreference.system.rawValue
    @State private var selectedTab: AppTab = Self.initialTab
    @State private var voiceWakeToastText: String?
    @State private var toastDismissTask: Task<Void, Never>?
    @State private var presentedSheet: PresentedSheet?
    @State private var showGatewayActions: Bool = false
    @State private var showGatewayProblemDetails: Bool = false
    @State private var showOnboarding: Bool = false
    @State private var onboardingAllowSkip: Bool = true
    @State private var didEvaluateOnboarding: Bool = false
    @State private var didAutoOpenSettings: Bool = false
    @State private var didApplyInitialAppearance: Bool = false
    @State private var didApplyInitialChatSession: Bool = false
    @State private var handledGatewaySetupRequestID: Int = 0

    private enum AppTab: Hashable {
        case control
        case chat
        case talk
        case agent
        case settings
    }

    private static var initialTab: AppTab {
        let arguments = ProcessInfo.processInfo.arguments
        guard let flagIndex = arguments.firstIndex(of: "--openclaw-initial-tab") else {
            return .control
        }
        let valueIndex = arguments.index(after: flagIndex)
        guard arguments.indices.contains(valueIndex) else {
            return .control
        }

        switch arguments[valueIndex].lowercased() {
        case "chat":
            return .chat
        case "talk", "voice":
            return .talk
        case "agent", "agents":
            return .agent
        case "settings":
            return .settings
        default:
            return .control
        }
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

    enum StartupPresentationRoute: Equatable {
        case none
        case onboarding
        case settings
    }

    static func startupPresentationRoute(
        gatewayConnected: Bool,
        hasConnectedOnce: Bool,
        onboardingComplete: Bool,
        hasExistingGatewayConfig: Bool,
        shouldPresentOnLaunch: Bool) -> StartupPresentationRoute
    {
        if gatewayConnected {
            return .none
        }
        if shouldPresentOnLaunch || !hasConnectedOnce || !onboardingComplete {
            return .onboarding
        }
        if !hasExistingGatewayConfig {
            return .settings
        }
        return .none
    }

    static func shouldPresentQuickSetup(
        quickSetupDismissed: Bool,
        showOnboarding: Bool,
        hasPresentedSheet: Bool,
        gatewayConnected: Bool,
        hasExistingGatewayConfig: Bool,
        discoveredGatewayCount: Int) -> Bool
    {
        guard !quickSetupDismissed else { return false }
        guard !showOnboarding else { return false }
        guard !hasPresentedSheet else { return false }
        guard !gatewayConnected else { return false }
        guard !hasExistingGatewayConfig else { return false }
        return discoveredGatewayCount > 0
    }

    var body: some View {
        self.rootPresentation(
            self.rootLifecycle(
                self.rootOverlays(
                    self.tabContent
                        .tint(OpenClawBrand.accent))))
    }

    private var tabContent: some View {
        TabView(selection: self.$selectedTab) {
            CommandCenterTab(
                openChat: { self.selectedTab = .chat },
                openSettings: { self.selectedTab = .settings })
                .tabItem { Label("Command", systemImage: "target") }
                .badge(self.appModel.pendingExecApprovalPrompt == nil ? 0 : 1)
                .tag(AppTab.control)

            ChatProTab()
                .tabItem { Label("Chat", systemImage: "bubble.left.fill") }
                .tag(AppTab.chat)

            TalkProTab(openSettings: { self.selectedTab = .settings })
                .tabItem {
                    Label(
                        "Talk",
                        systemImage: self.appModel.talkMode.isEnabled ? "waveform.circle.fill" : "waveform.circle")
                }
                .tag(AppTab.talk)

            AgentProTab()
                .tabItem { Label("Agent", systemImage: "person.2.fill") }
                .tag(AppTab.agent)

            SettingsProTab()
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
                .tag(AppTab.settings)
        }
    }

    private func rootOverlays(_ content: some View) -> some View {
        content
            .overlay(alignment: .top) {
                if let gatewayProblem = self.appModel.lastGatewayProblem,
                   self.gatewayStatus != .connected
                {
                    GatewayProblemBanner(
                        problem: gatewayProblem,
                        primaryActionTitle: self.gatewayProblemPrimaryActionTitle(gatewayProblem),
                        onPrimaryAction: {
                            self.handleGatewayProblemPrimaryAction(gatewayProblem)
                        },
                        onShowDetails: {
                            self.showGatewayProblemDetails = true
                        })
                        .padding(.horizontal, 12)
                        .safeAreaPadding(.top, 10)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .overlay(alignment: .topLeading) {
                if let voiceWakeToastText, !voiceWakeToastText.isEmpty {
                    VoiceWakeToast(command: voiceWakeToastText)
                        .padding(.leading, 10)
                        .safeAreaPadding(.top, self.appModel.lastGatewayProblem == nil ? 58 : 132)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .overlay {
                if self.appModel.cameraFlashNonce != 0 {
                    RootCameraFlashOverlay(nonce: self.appModel.cameraFlashNonce)
                }
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
            .onAppear { self.applyInitialAppearanceIfNeeded() }
            .onAppear { self.applyInitialChatSessionIfNeeded() }
            .onChange(of: self.preventSleep) { _, _ in self.updateIdleTimer() }
            .onChange(of: self.appModel.talkMode.isEnabled) { _, _ in self.updateIdleTimer() }
            .onChange(of: self.scenePhase) { _, newValue in
                self.updateIdleTimer()
                self.updateHomeCanvasState()
                guard newValue == .active else { return }
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

    private func rootGatewayLifecycle(_ content: some View) -> some View {
        content
            .onChange(of: self.canvasDebugStatusEnabled) { _, _ in self.updateCanvasDebugStatus() }
            .onChange(of: self.gatewayController.gateways.count) { _, _ in self.maybeShowQuickSetup() }
            .onChange(of: self.appModel.gatewayServerName) { _, newValue in
                if newValue != nil {
                    self.showOnboarding = false
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
            .onChange(of: self.appModel.openChatRequestID) { _, _ in
                self.selectedTab = .chat
            }
            .onChange(of: self.appModel.gatewaySetupRequestID) { _, _ in
                self.maybeOpenSettingsForGatewaySetup()
            }
    }

    private func rootPresentation(_ content: some View) -> some View {
        content
            .gatewayActionsDialog(
                isPresented: self.$showGatewayActions,
                onDisconnect: { self.appModel.disconnectGateway() },
                onOpenSettings: { self.selectedTab = .settings })
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
                    GatewayQuickSetupSheet()
                        .environment(self.appModel)
                        .environment(self.gatewayController)
                        .openClawSheetChrome()
                        .preferredColorScheme(self.appearancePreference.colorScheme)
                }
            }
            .fullScreenCover(isPresented: self.$showOnboarding) {
                OnboardingWizardView(
                    allowSkip: self.onboardingAllowSkip,
                    onClose: {
                        self.showOnboarding = false
                    })
                    .environment(self.appModel)
                    .environment(self.voiceWake)
                    .environment(self.gatewayController)
                    .preferredColorScheme(self.appearancePreference.colorScheme)
            }
            .gatewayTrustPromptAlert()
            .deepLinkAgentPromptAlert()
            .execApprovalPromptDialog()
    }

    private var appearancePreference: AppAppearancePreference {
        AppAppearancePreference.launchArgumentPreference
            ?? AppAppearancePreference(rawValue: self.appearancePreferenceRaw)
            ?? .system
    }

    private var gatewayStatus: GatewayDisplayState {
        GatewayStatusBuilder.build(appModel: self.appModel)
    }

    private func updateIdleTimer() {
        UIApplication.shared.isIdleTimerDisabled =
            self.scenePhase == .active && (self.preventSleep || self.appModel.talkMode.isEnabled)
    }

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
        let gatewayName = self.normalized(self.appModel.gatewayServerName)
        let gatewayAddress = self.normalized(self.appModel.gatewayRemoteAddress)
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
        let selected = self.normalized(self.appModel.selectedAgentId) ?? ""
        if !selected.isEmpty {
            return selected
        }
        return self.resolveDefaultAgentID()
    }

    private func resolveDefaultAgentID() -> String {
        self.normalized(self.appModel.gatewayDefaultAgentId) ?? ""
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
        self.normalized(agent.name) ?? agent.id
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

    private func gatewayProblemPrimaryActionTitle(_ problem: GatewayConnectionProblem) -> String {
        if problem.canTrustRotatedCertificate { return "Trust certificate" }
        return problem.retryable ? "Retry" : "Open Settings"
    }

    private func handleGatewayProblemPrimaryAction(_ problem: GatewayConnectionProblem) {
        if problem.canTrustRotatedCertificate {
            Task { await self.gatewayController.trustRotatedGatewayCertificate(from: problem) }
        } else if problem.retryable {
            Task { await self.gatewayController.connectLastKnown() }
        } else {
            self.selectedTab = .settings
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
            break
        case .onboarding:
            self.onboardingAllowSkip = true
            self.showOnboarding = true
        case .settings:
            self.didAutoOpenSettings = true
            self.selectedTab = .settings
        }
    }

    private func hasExistingGatewayConfig() -> Bool {
        if self.appModel.activeGatewayConnectConfig != nil { return true }
        if GatewaySettingsStore.loadLastGatewayConnection() != nil { return true }

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
        self.selectedTab = .settings
    }

    private func maybeOpenSettingsForGatewaySetup() {
        let requestID = self.appModel.gatewaySetupRequestID
        guard requestID != 0, requestID != self.handledGatewaySetupRequestID else { return }
        self.handledGatewaySetupRequestID = requestID
        self.showOnboarding = false
        self.presentedSheet = nil
        self.didAutoOpenSettings = true
        self.selectedTab = .settings
    }

    private func applyInitialChatSessionIfNeeded() {
        guard !self.didApplyInitialChatSession else { return }
        self.didApplyInitialChatSession = true
        self.appModel.focusChatSession(Self.initialChatSessionKey)
    }

    private func applyInitialAppearanceIfNeeded() {
        guard !self.didApplyInitialAppearance else { return }
        self.didApplyInitialAppearance = true
        guard let preference = AppAppearancePreference.launchArgumentPreference else { return }
        self.appearancePreferenceRaw = preference.rawValue
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
