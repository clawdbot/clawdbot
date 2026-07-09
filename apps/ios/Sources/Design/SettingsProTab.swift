import OpenClawKit
import SwiftUI

struct GatewaySetupRequest {
    let id: Int
    let link: GatewayConnectDeepLink
}

struct SettingsProTab: View {
    @Environment(NodeAppModel.self) var appModel
    @Environment(VoiceWakeManager.self) var voiceWake
    @Environment(GatewayConnectionController.self) var gatewayController
    @Environment(\.scenePhase) var scenePhase
    @AppStorage("node.displayName") var displayName: String = "iOS Node"
    @AppStorage("node.instanceId") var instanceId: String = UUID().uuidString
    @AppStorage("camera.enabled") var cameraEnabled: Bool = true
    @AppStorage("location.enabledMode") var locationModeRaw: String = OpenClawLocationMode.off.rawValue
    @AppStorage("screen.preventSleep") var preventSleep: Bool = true
    @AppStorage("talk.enabled") var talkEnabled: Bool = false
    @AppStorage(TalkModeProviderSelection.storageKey) var talkProviderSelectionRaw: String =
        TalkModeProviderSelection.gatewayDefault.rawValue
    @AppStorage(TalkModeRealtimeVoiceSelection.storageKey) var talkRealtimeVoiceSelectionRaw: String = ""
    @AppStorage(TalkSpeechLocale.storageKey) var talkSpeechLocale: String = TalkSpeechLocale.automaticID
    @AppStorage("talk.button.enabled") var talkButtonEnabled: Bool = true
    @AppStorage("talk.background.enabled") var talkBackgroundEnabled: Bool = false
    @AppStorage(TalkDefaults.speakerphoneEnabledKey) var talkSpeakerphoneEnabled: Bool =
        TalkDefaults.speakerphoneEnabledByDefault
    @AppStorage(VoiceWakePreferences.enabledKey) var voiceWakeEnabled: Bool = false
    @AppStorage("gateway.autoconnect") var gatewayAutoConnect: Bool = false
    @AppStorage("gateway.manual.enabled") var manualGatewayEnabled: Bool = false
    @AppStorage("gateway.manual.host") var manualGatewayHost: String = ""
    @AppStorage("gateway.manual.port") var manualGatewayPort: Int = 18789
    @AppStorage("gateway.manual.tls") var manualGatewayTLS: Bool = true
    @AppStorage("gateway.discovery.debugLogs") var discoveryDebugLogsEnabled: Bool = false
    @AppStorage("canvas.debugStatusEnabled") var canvasDebugStatusEnabled: Bool = false
    @AppStorage("gateway.setupCode") var setupCode: String = ""
    @AppStorage("gateway.onboardingComplete") var onboardingComplete: Bool = false
    @AppStorage("gateway.hasConnectedOnce") var hasConnectedOnce: Bool = false
    @AppStorage("onboarding.requestID") var onboardingRequestID: Int = 0
    @AppStorage(NotificationServingPreference.storageKey) var notificationServingEnabled: Bool =
        NotificationServingPreference.defaultEnabled
    @State var isReconnectingGateway = false
    @State var isRefreshingGateway = false
    @State var isChangingLocationMode = false
    @State var connectingGatewayID: String?
    @State var gatewayRegistry = GatewaySettingsStore.GatewayRegistry.empty
    @State var pendingForgetGateway: GatewaySettingsStore.GatewayRegistryEntry?
    @State var selectedAgentPickerId = ""
    @State var gatewayToken = ""
    @State var gatewayPassword = ""
    @State var gatewayCredentialFieldStableID: String?
    @State var manualGatewayPortText = ""
    @State var setupStatusText: String?
    @State var setupAttemptID: UUID?
    @State var stagedGatewaySetupLink: GatewayConnectDeepLink?
    @State var pendingManualAuthOverride: GatewayConnectionController.ManualAuthOverride?
    @State var scannerResultHandoff = QRScannerResultHandoff()
    @State var scannerScanID: UInt64 = 0
    @State var pendingTargetSuppression = GatewayPendingTargetSuppression()
    @State var defaultShareInstruction = ""
    @State var showQRScanner = false
    @State var scannerError: String?
    @State var showResetOnboardingAlert = false
    @State var suppressCredentialPersist = false
    @State var locationStatusText: String?
    @State var watchDirectSetupStatusText: String?
    @State var isSendingWatchDirectSetup = false
    @State var locationPermissionSummary = LocationPermissionSummary(
        desiredMode: .off,
        locationServicesEnabled: true,
        authorizationStatus: .notDetermined,
        accuracyAuthorization: .fullAccuracy)
    @State var locationPermissionRefreshID = 0
    @State var previousLocationModeRaw: String = OpenClawLocationMode.off.rawValue
    @State var notificationStatus: SettingsNotificationStatus = .checking
    @State var isRequestingNotificationAuthorization = false
    @State var showNotificationRelayDisclosure = false
    @State var diagnosticsLastRunText = "Not run"
    @State var diagnosticsIssueCount: Int?
    @State var showTalkIssueDetails = false
    @State private var navigationPath: [SettingsRoute] = []
    let initialRoute: SettingsRoute?
    let directRoute: SettingsRoute?
    let acceptsGatewaySetupRequests: Bool
    let headerLeadingAction: OpenClawSidebarHeaderAction?
    let ownsNavigationStack: Bool
    let navigateToRoute: ((SettingsRoute) -> Void)?
    let onRouteChange: ((SettingsRoute?) -> Void)?
    let gatewaySetupRequest: GatewaySetupRequest?
    let onGatewaySetupRequestHandled: ((Int) -> Void)?

    init(
        initialRoute: SettingsRoute? = nil,
        directRoute: SettingsRoute? = nil,
        acceptsGatewaySetupRequests: Bool = false,
        headerLeadingAction: OpenClawSidebarHeaderAction? = nil,
        ownsNavigationStack: Bool = true,
        navigateToRoute: ((SettingsRoute) -> Void)? = nil,
        onRouteChange: ((SettingsRoute?) -> Void)? = nil,
        gatewaySetupRequest: GatewaySetupRequest? = nil,
        onGatewaySetupRequestHandled: ((Int) -> Void)? = nil)
    {
        self.initialRoute = initialRoute
        self.directRoute = directRoute
        self.acceptsGatewaySetupRequests = acceptsGatewaySetupRequests
        self.headerLeadingAction = headerLeadingAction
        self.ownsNavigationStack = ownsNavigationStack
        self.navigateToRoute = navigateToRoute
        self.onRouteChange = onRouteChange
        self.gatewaySetupRequest = gatewaySetupRequest
        self.onGatewaySetupRequestHandled = onGatewaySetupRequestHandled
    }

    var body: some View {
        self.settingsModalPresentation(
            self.settingsLifecycle(
                self.settingsContent))
    }

    @ViewBuilder
    private var settingsContent: some View {
        if let directRoute {
            self.destination(for: directRoute)
        } else {
            if self.ownsNavigationStack {
                self.settingsNavigationStack
            } else {
                self.settingsNavigationContent
            }
        }
    }

    private var settingsNavigationStack: some View {
        NavigationStack(path: self.$navigationPath) {
            self.settingsNavigationContent
        }
    }

    private var settingsNavigationContent: some View {
        List {
            self.gatewaySection
            self.settingsListSection
        }
        .font(OpenClawType.body)
        .navigationTitle("Settings")
        .navigationDestination(for: SettingsRoute.self) { route in
            self.destination(for: route)
        }
        .toolbar {
            if let headerLeadingAction {
                ToolbarItem(placement: .topBarLeading) {
                    OpenClawSidebarRevealButton(action: headerLeadingAction)
                }
            }
        }
    }

    private func settingsLifecycle(_ content: some View) -> some View {
        content
            .onDisappear {
                self.invalidateGatewaySetupAttempt()
            }
            .task {
                self.previousLocationModeRaw = self.locationModeRaw
                self.syncSettingsState()
                self.refreshNotificationSettings()
                self.applyGatewaySetupRequestIfNeeded()
                self.applyInitialRouteIfNeeded()
                self.notifyRouteChange()
            }
            .onDisappear {
                self.scannerResultHandoff.cancel()
                self.pendingTargetSuppression.resumeAutoConnect(controller: self.gatewayController)
            }
            .onChange(of: self.gatewaySetupRequest?.id) { _, _ in
                self.applyGatewaySetupRequestIfNeeded()
            }
            .onChange(of: self.scenePhase) { _, phase in
                if phase == .active {
                    self.syncSettingsState()
                    self.refreshNotificationSettings()
                }
            }
            .onChange(of: self.locationModeRaw) { _, newValue in
                self.handleLocationModeChange(newValue)
            }
            .onChange(of: self.selectedAgentPickerId) { _, newValue in
                let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
                self.appModel.setSelectedAgentId(trimmed.isEmpty ? nil : trimmed)
            }
            .onChange(of: self.appModel.selectedAgentId ?? "") { _, newValue in
                if newValue != self.selectedAgentPickerId {
                    self.selectedAgentPickerId = newValue
                }
            }
            .onChange(of: self.setupCode) { _, newValue in
                if !newValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    self.clearStagedGatewaySetupLink()
                }
            }
            .onChange(of: self.defaultShareInstruction) { _, newValue in
                ShareToAgentSettings.saveDefaultInstruction(newValue)
            }
            .onChange(of: self.acceptsGatewaySetupRequests) { _, acceptsRequests in
                guard acceptsRequests else { return }
                self.applyGatewaySetupRequestIfNeeded()
            }
            .onChange(of: self.onboardingRequestID) { _, _ in
                // Root-owned resets leave Settings mounted behind onboarding.
                // Reload cleared credentials before the view can persist stale state.
                self.syncAfterOnboardingReset()
            }
            .onChange(of: self.navigationPath) { _, _ in
                self.invalidateGatewaySetupAttempt()
                self.notifyRouteChange()
            }
    }

    private func settingsModalPresentation(_ content: some View) -> some View {
        let scanID = self.scannerScanID
        return content
            .sheet(isPresented: self.$showTalkIssueDetails) {
                if let issue = self.appModel.talkMode.gatewayTalkCurrentFallbackIssue {
                    TalkRuntimeIssueDetailsSheet(issue: issue)
                }
            }
            .sheet(
                isPresented: self.$showQRScanner,
                onDismiss: {
                    self.processQueuedScannerResult()
                },
                content: {
                    NavigationStack {
                        QRScannerView(
                            onResult: { result in
                                self.queueScannedResult(result, scanID: scanID)
                            },
                            onError: { error in
                                guard self.scannerResultHandoff.isActive(scanID: scanID) else { return }
                                self.showQRScanner = false
                                self.setupStatusText = "Scanner error: \(error)"
                                self.scannerError = error
                            },
                            onDismiss: {
                                guard self.scannerResultHandoff.isActive(scanID: scanID) else { return }
                                self.showQRScanner = false
                            })
                            .ignoresSafeArea()
                            .navigationTitle("Scan QR Code")
                            .navigationBarTitleDisplayMode(.inline)
                            .font(OpenClawType.body)
                            .toolbar {
                                ToolbarItem(placement: .topBarLeading) {
                                    Button {
                                        self.scannerResultHandoff.cancel()
                                        self.showQRScanner = false
                                    } label: {
                                        Text("Cancel")
                                            .font(OpenClawType.subheadSemiBold)
                                    }
                                    .font(OpenClawType.subheadSemiBold)
                                }
                            }
                    }
                })
            .sheet(isPresented: self.$showNotificationRelayDisclosure) {
                HostedPushRelayDisclosureSheet(
                    message: self.notificationRelayDisclosureMessage,
                    onContinue: self.acceptNotificationRelayDisclosure)
            }
            .alert("Reset Onboarding?", isPresented: self.$showResetOnboardingAlert) {
                Button(role: .destructive) {
                    Task { await self.resetOnboarding() }
                } label: {
                    Text("Reset")
                        .font(OpenClawType.subheadSemiBold)
                }
                Button(role: .cancel) {} label: {
                    Text("Cancel")
                        .font(OpenClawType.subheadSemiBold)
                }
            } message: {
                Text("This disconnects, clears saved gateway credentials, and reopens onboarding.")
                    .font(OpenClawType.subhead)
            }
            .alert(
                "QR Scanner Unavailable",
                isPresented: Binding(
                    get: { self.scannerError != nil },
                    set: { if !$0 { self.scannerError = nil } }))
            {
                Button(role: .cancel) {} label: {
                    Text("OK")
                        .font(OpenClawType.subheadSemiBold)
                }
            } message: {
                Text(self.scannerError ?? "")
                    .font(OpenClawType.subhead)
            }
            .confirmationDialog(
                    "Forget \(self.pendingForgetGateway?.name ?? "gateway")?",
                    isPresented: Binding(
                        get: { self.pendingForgetGateway != nil },
                        set: { if !$0 { self.pendingForgetGateway = nil } }),
                    titleVisibility: .visible)
            {
                Button(role: .destructive) {
                    self.forgetPendingGateway()
                } label: {
                    Text("Forget Gateway")
                        .font(OpenClawType.subheadSemiBold)
                }
                Button(role: .cancel) {
                    self.pendingForgetGateway = nil
                } label: {
                    Text("Cancel")
                        .font(OpenClawType.subheadSemiBold)
                }
                } message: {
                    Text("This removes saved credentials, device access, TLS trust, and cached chats for this gateway.")
                        .font(OpenClawType.subhead)
                }
    }

    private func applyGatewaySetupRequestIfNeeded() {
        guard self.acceptsGatewaySetupRequests else { return }
        guard let gatewaySetupRequest else { return }
        self.applyGatewaySetupLink(gatewaySetupRequest.link)
        self.onGatewaySetupRequestHandled?(gatewaySetupRequest.id)
    }

    func openNotificationsRouteFromApprovals() {
        guard self.directRoute == nil else { return }
        if !self.ownsNavigationStack, let navigateToRoute {
            navigateToRoute(.notifications)
            return
        }
        // Push, don't replace: Back from Notifications must return to the
        // Approvals screen the user came from, not reset to the Settings root.
        self.navigationPath.append(.notifications)
    }

    private func applyInitialRouteIfNeeded() {
        guard self.directRoute == nil else { return }
        guard let initialRoute else { return }
        guard self.navigationPath != [initialRoute] else { return }
        self.navigationPath = [initialRoute]
    }

    private func notifyRouteChange() {
        if let directRoute {
            self.onRouteChange?(directRoute)
            return
        }
        self.onRouteChange?(self.navigationPath.last)
    }
}

struct HostedPushRelayDisclosureSheet: View {
    @Environment(\.dismiss) private var dismiss
    let message: String
    let onContinue: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Image(systemName: "network")
                        .font(OpenClawType.title2SemiBold)
                        .foregroundStyle(OpenClawBrand.accentForeground)
                    Text("Enable OpenClaw Hosted Push Relay?")
                        .font(OpenClawType.title3SemiBold)
                    Text(self.message)
                        .font(OpenClawType.body)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .font(OpenClawType.body)
            }
            VStack(spacing: 10) {
                Button {
                    self.dismiss()
                    self.onContinue()
                } label: {
                    Text("Continue")
                        .font(OpenClawType.subheadSemiBold)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                Button(role: .cancel) {
                    self.dismiss()
                } label: {
                    Text("Not Now")
                        .font(OpenClawType.subheadSemiBold)
                }
                .buttonStyle(.bordered)
                .frame(maxWidth: .infinity)
            }
        }
        .tint(OpenClawBrand.accent)
        .padding(24)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}
