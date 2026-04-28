import OpenClawProtocol
import SwiftUI
import UIKit

struct RootCanvas: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(GatewayConnectionController.self) private var gatewayController
    @Environment(VoiceWakeManager.self) private var voiceWake
    @Environment(\.colorScheme) private var systemColorScheme
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(VoiceWakePreferences.enabledKey) private var voiceWakeEnabled: Bool = false
    @AppStorage("screen.preventSleep") private var preventSleep: Bool = true
    @AppStorage("canvas.debugStatusEnabled") private var canvasDebugStatusEnabled: Bool = false
    @AppStorage("onboarding.requestID") private var onboardingRequestID: Int = 0
    @AppStorage("gateway.onboardingComplete") private var onboardingComplete: Bool = false
    @AppStorage("gateway.hasConnectedOnce") private var hasConnectedOnce: Bool = false
    @AppStorage("gateway.preferredStableID") private var preferredGatewayStableID: String = ""
    @AppStorage("gateway.manual.enabled") private var manualGatewayEnabled: Bool = false
    @AppStorage("gateway.manual.host") private var manualGatewayHost: String = ""
    @AppStorage("onboarding.quickSetupDismissed") private var quickSetupDismissed: Bool = false
    @State private var presentedSheet: PresentedSheet?
    @State private var voiceWakeToastText: String?
    @State private var toastDismissTask: Task<Void, Never>?
    @State private var showOnboarding: Bool = false
    @State private var onboardingAllowSkip: Bool = true
    @State private var didEvaluateOnboarding: Bool = false
    @State private var didAutoOpenSettings: Bool = false

    private enum PresentedSheet: Identifiable {
        case settings
        case chat
        case quickSetup

        var id: Int {
            switch self {
            case .settings: 0
            case .chat: 1
            case .quickSetup: 2
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
        // On first run or explicit launch onboarding state, onboarding always wins.
        if shouldPresentOnLaunch || !hasConnectedOnce || !onboardingComplete {
            return .onboarding
        }
        // Settings auto-open is a recovery path for previously-connected installs only.
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
        // If a gateway target is already configured (manual or last-known), skip quick setup.
        guard !hasExistingGatewayConfig else { return false }
        return discoveredGatewayCount > 0
    }

    var body: some View {
        ZStack {
            CanvasContent(
                systemColorScheme: self.systemColorScheme,
                gatewayStatus: self.gatewayStatus,
                voiceWakeEnabled: self.voiceWakeEnabled,
                voiceWakeToastText: self.voiceWakeToastText,
                cameraHUDText: self.appModel.cameraHUDText,
                cameraHUDKind: self.appModel.cameraHUDKind,
                openChat: {
                    self.presentedSheet = .chat
                },
                openSettings: {
                    self.presentedSheet = .settings
                },
                retryGatewayConnection: {
                    Task { await self.gatewayController.connectLastKnown() }
                })
                .preferredColorScheme(.dark)

            if self.appModel.cameraFlashNonce != 0 {
                CameraFlashOverlay(nonce: self.appModel.cameraFlashNonce)
            }
        }
        .gatewayTrustPromptAlert()
        .deepLinkAgentPromptAlert()
        .execApprovalPromptDialog()
        .sheet(item: self.$presentedSheet) { sheet in
            switch sheet {
            case .settings:
                SettingsTab()
                    .environment(self.appModel)
                    .environment(self.appModel.voiceWake)
                    .environment(self.gatewayController)
            case .chat:
                ChatSheet(
                    // Chat RPCs run on the operator session (read/write scopes).
                    gateway: self.appModel.operatorSession,
                    sessionKey: self.appModel.chatSessionKey,
                    agentName: self.appModel.activeAgentName,
                    userAccent: self.appModel.seamColor)
            case .quickSetup:
                GatewayQuickSetupSheet()
                    .environment(self.appModel)
                    .environment(self.gatewayController)
            }
        }
        .fullScreenCover(isPresented: self.$showOnboarding) {
            OnboardingWizardView(
                allowSkip: self.onboardingAllowSkip,
                onClose: {
                    self.showOnboarding = false
                })
                .environment(self.appModel)
                .environment(self.appModel.voiceWake)
                .environment(self.gatewayController)
        }
        .onAppear { self.updateIdleTimer() }
        .onAppear { self.updateHomeCanvasState() }
        .onAppear { self.evaluateOnboardingPresentation(force: false) }
        .onAppear { self.maybeAutoOpenSettings() }
        .onChange(of: self.preventSleep) { _, _ in self.updateIdleTimer() }
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
        .onAppear { self.maybeShowQuickSetup() }
        .onChange(of: self.gatewayController.gateways.count) { _, _ in self.maybeShowQuickSetup() }
        .onAppear { self.updateCanvasDebugStatus() }
        .onChange(of: self.canvasDebugStatusEnabled) { _, _ in self.updateCanvasDebugStatus() }
        .onChange(of: self.appModel.gatewayStatusText) { _, _ in
            self.updateCanvasDebugStatus()
            self.updateHomeCanvasState()
        }
        .onChange(of: self.appModel.gatewayServerName) { _, _ in
            self.updateCanvasDebugStatus()
            self.updateHomeCanvasState()
        }
        .onChange(of: self.appModel.gatewayServerName) { _, newValue in
            if newValue != nil {
                self.showOnboarding = false
            }
        }
        .onChange(of: self.onboardingRequestID) { _, _ in
            self.evaluateOnboardingPresentation(force: true)
        }
        .onChange(of: self.appModel.gatewayRemoteAddress) { _, _ in
            self.updateCanvasDebugStatus()
            self.updateHomeCanvasState()
        }
        .onChange(of: self.appModel.homeCanvasRevision) { _, _ in
            self.updateHomeCanvasState()
        }
        .onChange(of: self.appModel.gatewayServerName) { _, newValue in
            if newValue != nil {
                self.onboardingComplete = true
                self.hasConnectedOnce = true
                OnboardingStateStore.markCompleted(mode: nil)
            }
            self.maybeAutoOpenSettings()
        }
        .onChange(of: self.appModel.openChatRequestID) { _, _ in
            self.presentedSheet = .chat
        }
        .onChange(of: self.voiceWake.lastTriggeredCommand) { _, newValue in
            guard let newValue else { return }
            let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return }

            self.toastDismissTask?.cancel()
            withAnimation(.spring(response: 0.25, dampingFraction: 0.85)) {
                self.voiceWakeToastText = trimmed
            }

            self.toastDismissTask = Task {
                try? await Task.sleep(nanoseconds: 2_300_000_000)
                await MainActor.run {
                    withAnimation(.easeOut(duration: 0.25)) {
                        self.voiceWakeToastText = nil
                    }
                }
            }
        }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
            self.toastDismissTask?.cancel()
            self.toastDismissTask = nil
        }
    }

    private var gatewayStatus: StatusPill.GatewayState {
        GatewayStatusBuilder.build(appModel: self.appModel)
    }

    private func updateIdleTimer() {
        UIApplication.shared.isIdleTimerDisabled = (self.scenePhase == .active && self.preventSleep)
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

    private func makeHomeCanvasPayload() -> HomeCanvasPayload {
        let gatewayName = self.normalized(self.appModel.gatewayServerName)
        let gatewayAddress = self.normalized(self.appModel.gatewayRemoteAddress)
        let gatewayLabel = gatewayName ?? gatewayAddress ?? "Gateway"
        let activeAgentID = self.resolveActiveAgentID()
        let agents = self.homeCanvasAgents(activeAgentID: activeAgentID)

        switch self.gatewayStatus {
        case .connected:
            return HomeCanvasPayload(
                gatewayState: "connected",
                eyebrow: "Connected to \(gatewayLabel)",
                title: "Your agents are ready",
                subtitle:
                "This phone stays dormant until the gateway needs it, then wakes, syncs, and goes back to sleep.",
                gatewayLabel: gatewayLabel,
                activeAgentName: self.appModel.activeAgentName,
                activeAgentBadge: agents.first(where: { $0.isActive })?.badge ?? "OC",
                activeAgentCaption: "Selected on this phone",
                agentCount: agents.count,
                agents: Array(agents.prefix(6)),
                footer: "The overview refreshes on reconnect and when the app returns to foreground.")
        case .connecting:
            return HomeCanvasPayload(
                gatewayState: "connecting",
                eyebrow: "Reconnecting",
                title: "OpenClaw is syncing back up",
                subtitle:
                "The gateway session is coming back online. "
                    + "Agent shortcuts should settle automatically in a moment.",
                gatewayLabel: gatewayLabel,
                activeAgentName: self.appModel.activeAgentName,
                activeAgentBadge: "OC",
                activeAgentCaption: "Gateway session in progress",
                agentCount: agents.count,
                agents: Array(agents.prefix(4)),
                footer: "If the gateway is reachable, reconnect should complete without intervention.")
        case .error, .disconnected:
            return HomeCanvasPayload(
                gatewayState: self.gatewayStatus == .error ? "error" : "offline",
                eyebrow: "Welcome to OpenClaw",
                title: "Your phone stays quiet until it is needed",
                subtitle:
                "Pair this device to your gateway to wake it only for real work, "
                    + "keep a live agent overview handy, and avoid battery-draining background loops.",
                gatewayLabel: gatewayLabel,
                activeAgentName: "Main",
                activeAgentBadge: "OC",
                activeAgentCaption: "Connect to load your agents",
                agentCount: agents.count,
                agents: Array(agents.prefix(4)),
                footer:
                "When connected, the gateway can wake the phone with a silent push "
                    + "instead of holding an always-on session.")
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

    private func homeCanvasAgents(activeAgentID: String) -> [HomeCanvasAgentCard] {
        let defaultAgentID = self.resolveDefaultAgentID()
        let cards = self.appModel.gatewayAgents.map { agent -> HomeCanvasAgentCard in
            let isActive = !activeAgentID.isEmpty && agent.id == activeAgentID
            let isDefault = !defaultAgentID.isEmpty && agent.id == defaultAgentID
            return HomeCanvasAgentCard(
                id: agent.id,
                name: self.homeCanvasName(for: agent),
                badge: self.homeCanvasBadge(for: agent),
                caption: isActive ? "Active on this phone" : (isDefault ? "Default agent" : "Ready"),
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
           let normalizedEmoji = self.normalized(emoji)
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
            self.presentedSheet = .settings
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
        self.presentedSheet = .settings
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

private struct HomeCanvasPayload: Codable {
    var gatewayState: String
    var eyebrow: String
    var title: String
    var subtitle: String
    var gatewayLabel: String
    var activeAgentName: String
    var activeAgentBadge: String
    var activeAgentCaption: String
    var agentCount: Int
    var agents: [HomeCanvasAgentCard]
    var footer: String
}

private struct HomeCanvasAgentCard: Codable {
    var id: String
    var name: String
    var badge: String
    var caption: String
    var isActive: Bool
}

private struct CanvasContent: View {
    @Environment(NodeAppModel.self) private var appModel
    @AppStorage("talk.enabled") private var talkEnabled: Bool = false
    @AppStorage("talk.button.enabled") private var talkButtonEnabled: Bool = true
    @State private var showGatewayActions: Bool = false
    @State private var showGatewayProblemDetails: Bool = false
    var systemColorScheme: ColorScheme
    var gatewayStatus: StatusPill.GatewayState
    var voiceWakeEnabled: Bool
    var voiceWakeToastText: String?
    var cameraHUDText: String?
    var cameraHUDKind: NodeAppModel.CameraHUDKind?
    var openChat: () -> Void
    var openSettings: () -> Void
    var retryGatewayConnection: () -> Void

    private var brightenButtons: Bool {
        self.systemColorScheme == .light
    }

    private var talkActive: Bool {
        self.appModel.talkMode.isEnabled || self.talkEnabled
    }

    var body: some View {
        ZStack {
            ScreenTab()
        }
        .overlay(alignment: .center) {
            if self.talkActive {
                TalkOrbOverlay()
                    .transition(.opacity)
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            HomeToolbar(
                gateway: self.gatewayStatus,
                voiceWakeEnabled: self.voiceWakeEnabled,
                activity: self.statusActivity,
                brighten: self.brightenButtons,
                talkButtonEnabled: self.talkButtonEnabled,
                talkActive: self.talkActive,
                talkTint: self.appModel.seamColor,
                onStatusTap: {
                    if self.gatewayStatus == .connected {
                        self.showGatewayActions = true
                    } else if self.appModel.lastGatewayProblem != nil {
                        self.showGatewayProblemDetails = true
                    } else {
                        self.openSettings()
                    }
                },
                onChatTap: {
                    self.openChat()
                },
                onTalkTap: {
                    let next = !self.talkActive
                    self.talkEnabled = next
                    self.appModel.setTalkEnabled(next)
                },
                onSettingsTap: {
                    self.openSettings()
                })
        }
        .overlay(alignment: .top) {
            if let gatewayProblem = self.appModel.lastGatewayProblem,
               self.gatewayStatus != .connected
            {
                GatewayProblemBanner(
                    problem: gatewayProblem,
                    primaryActionTitle: gatewayProblem.retryable ? "Retry" : "Open Settings",
                    onPrimaryAction: {
                        if gatewayProblem.retryable {
                            self.retryGatewayConnection()
                        } else {
                            self.openSettings()
                        }
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
                VoiceWakeToast(
                    command: voiceWakeToastText,
                    brighten: self.brightenButtons)
                    .padding(.leading, 10)
                    .safeAreaPadding(.top, self.appModel.lastGatewayProblem == nil ? 58 : 132)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .gatewayActionsDialog(
            isPresented: self.$showGatewayActions,
            onDisconnect: { self.appModel.disconnectGateway() },
            onOpenSettings: { self.openSettings() })
        .sheet(isPresented: self.$showGatewayProblemDetails) {
            if let gatewayProblem = self.appModel.lastGatewayProblem {
                GatewayProblemDetailsSheet(
                    problem: gatewayProblem,
                    primaryActionTitle: "Open Settings",
                    onPrimaryAction: {
                        self.openSettings()
                    })
            }
        }
        .onAppear {
            // Keep the runtime talk state aligned with persisted toggle state on cold launch.
            if self.talkEnabled != self.appModel.talkMode.isEnabled {
                self.appModel.setTalkEnabled(self.talkEnabled)
            }
        }
    }

    private var statusActivity: StatusPill.Activity? {
        StatusActivityBuilder.build(
            appModel: self.appModel,
            voiceWakeEnabled: self.voiceWakeEnabled,
            cameraHUDText: self.cameraHUDText,
            cameraHUDKind: self.cameraHUDKind)
    }
}

private struct CameraFlashOverlay: View {
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
    }
}
