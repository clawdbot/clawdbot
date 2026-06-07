import Combine
import CoreImage
import OpenClawKit
import PhotosUI
import SwiftUI
import UIKit

private enum OnboardingStep: Int, CaseIterable {
    case intro
    case welcome
    case mode
    case connect
    case auth
    case success

    var previous: Self? {
        Self(rawValue: self.rawValue - 1)
    }

    var next: Self? {
        Self(rawValue: self.rawValue + 1)
    }

    /// Progress label for the manual setup flow (mode → connect → auth → success).
    var manualProgressTitle: String {
        let manualSteps: [OnboardingStep] = [.mode, .connect, .auth, .success]
        guard let idx = manualSteps.firstIndex(of: self) else { return "" }
        return "Step \(idx + 1) of \(manualSteps.count)"
    }

    var title: String {
        switch self {
        case .intro: "Welcome"
        case .welcome: "Connect Gateway"
        case .mode: "Connection Mode"
        case .connect: "Connect"
        case .auth: "Authentication"
        case .success: "Connected"
        }
    }

    var canGoBack: Bool {
        self != .intro && self != .welcome && self != .success
    }
}

struct OnboardingWizardView: View {
    @Environment(NodeAppModel.self) private var appModel: NodeAppModel
    @Environment(GatewayConnectionController.self) private var gatewayController: GatewayConnectionController
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("node.instanceId") private var instanceId: String = UUID().uuidString
    @AppStorage("gateway.discovery.domain") private var discoveryDomain: String = ""
    @AppStorage("onboarding.developerMode") private var developerModeEnabled: Bool = false
    @State private var step: OnboardingStep
    @State private var selectedMode: OnboardingConnectionMode?
    @State private var manualHost: String = ""
    @State private var manualPort: Int = 18789
    @State private var manualPortText: String = "18789"
    @State private var manualTLS: Bool = true
    @State private var gatewayToken: String = ""
    @State private var gatewayPassword: String = ""
    @State private var connectMessage: String?
    @State private var statusLine: String = "In your OpenClaw chat, run /pair qr, then scan the code here."
    @State private var connectingGatewayID: String?
    @State private var issue: GatewayConnectionIssue = .none
    @State private var didMarkCompleted = false
    @State private var pairingRequestId: String?
    @State private var discoveryRestartTask: Task<Void, Never>?
    @State private var showQRScanner: Bool = false
    @State private var scannerError: String?
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var showGatewayProblemDetails: Bool = false
    @State private var lastPairingAutoResumeAttemptAt: Date?
    @State private var pendingManualAuthOverride: GatewayConnectionController.ManualAuthOverride?
    @State private var setupCode: String = ""
    @State private var setupCodeStatus: String?
    private static let pairingAutoResumeTicker = Timer.publish(every: 2.0, on: .main, in: .common).autoconnect()

    let allowSkip: Bool
    let onClose: () -> Void

    init(allowSkip: Bool, onClose: @escaping () -> Void) {
        self.allowSkip = allowSkip
        self.onClose = onClose
        _step = State(
            initialValue: OnboardingStateStore.shouldPresentFirstRunIntro() ? .intro : .welcome)
    }

    private var isFullScreenStep: Bool {
        self.step == .intro || self.step == .welcome || self.step == .success
    }

    private var currentProblem: GatewayConnectionProblem? {
        self.appModel.lastGatewayProblem
    }

    var body: some View {
        NavigationStack {
            Group {
                switch self.step {
                case .intro:
                    self.introStep
                case .welcome:
                    self.welcomeStep
                case .success:
                    self.successStep
                default:
                    Form {
                        switch self.step {
                        case .mode:
                            self.modeStep
                        case .connect:
                            self.connectStep
                        case .auth:
                            self.authStep
                        default:
                            EmptyView()
                        }
                    }
                    .scrollDismissesKeyboard(.interactively)
                }
            }
            .navigationTitle(self.isFullScreenStep ? "" : self.step.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if !self.isFullScreenStep {
                    ToolbarItem(placement: .principal) {
                        VStack(spacing: 2) {
                            Text(self.step.title)
                                .font(.headline)
                            Text(self.step.manualProgressTitle)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                ToolbarItem(placement: .topBarLeading) {
                    if self.step.canGoBack {
                        Button {
                            self.navigateBack()
                        } label: {
                            Label("Back", systemImage: "chevron.left")
                        }
                    } else if self.allowSkip {
                        Button("Close") {
                            self.onClose()
                        }
                    }
                }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") {
                        UIApplication.shared.sendAction(
                            #selector(UIResponder.resignFirstResponder),
                            to: nil,
                            from: nil,
                            for: nil)
                    }
                }
            }
        }
        .gatewayTrustPromptAlert()
        .alert("QR Scanner Unavailable", isPresented: Binding(
            get: { self.scannerError != nil },
            set: { if !$0 { self.scannerError = nil } }))
        {
            Button("OK", role: .cancel) {}
        } message: {
            Text(self.scannerError ?? "")
        }
        .sheet(isPresented: self.$showQRScanner) {
                NavigationStack {
                    QRScannerView(
                        onGatewayLink: { link in
                            self.handleScannedLink(link)
                        },
                        onSetupCode: { code in
                            self.handleScannedSetupCode(code)
                        },
                        onError: { error in
                            self.showQRScanner = false
                            self.statusLine = "Scanner error: \(error)"
                            self.scannerError = error
                        },
                        onDismiss: {
                            self.showQRScanner = false
                        })
                        .ignoresSafeArea()
                        .navigationTitle("Scan QR Code")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .topBarLeading) {
                                Button("Cancel") { self.showQRScanner = false }
                            }
                            ToolbarItem(placement: .topBarTrailing) {
                                PhotosPicker(selection: self.$selectedPhoto, matching: .images) {
                                    Label("Photos", systemImage: "photo")
                                }
                            }
                        }
                }
                .onChange(of: self.selectedPhoto) { _, newValue in
                    guard let item = newValue else { return }
                    self.selectedPhoto = nil
                    Task {
                        guard let data = try? await item.loadTransferable(type: Data.self) else {
                            self.showQRScanner = false
                            self.scannerError = "Could not load the selected image."
                            return
                        }
                        if let message = self.detectQRCode(from: data) {
                            if let link = GatewayConnectDeepLink.fromSetupInput(message) {
                                self.handleScannedLink(link)
                                return
                            }
                            if AppleReviewDemoMode.isSetupCode(message) {
                                self.handleScannedSetupCode(message)
                                return
                            }
                        }
                        self.showQRScanner = false
                        self.scannerError = "No valid QR code found in the selected image."
                    }
                }
            }
            .sheet(isPresented: self.$showGatewayProblemDetails) {
                if let currentProblem = self.currentProblem {
                    GatewayProblemDetailsSheet(
                        problem: currentProblem,
                        primaryActionTitle: self.gatewayProblemPrimaryActionTitle(currentProblem),
                        onPrimaryAction: {
                            Task { await self.handleGatewayProblemPrimaryAction(currentProblem) }
                        })
                }
            }
            .onAppear {
                self.initializeState()
            }
            .onDisappear {
                self.discoveryRestartTask?.cancel()
                self.discoveryRestartTask = nil
            }
            .onChange(of: self.discoveryDomain) { _, _ in
                self.scheduleDiscoveryRestart()
            }
            .onChange(of: self.manualPortText) { _, newValue in
                let digits = newValue.filter(\.isNumber)
                if digits != newValue {
                    self.manualPortText = digits
                    return
                }
                guard let parsed = Int(digits), parsed > 0 else {
                    self.manualPort = 0
                    return
                }
                self.manualPort = min(parsed, 65535)
            }
            .onChange(of: self.manualPort) { _, newValue in
                let normalized = newValue > 0 ? String(newValue) : ""
                if self.manualPortText != normalized {
                    self.manualPortText = normalized
                }
            }
            .onChange(of: self.gatewayToken) { _, newValue in
                self.saveGatewayCredentials(token: newValue, password: self.gatewayPassword)
            }
            .onChange(of: self.gatewayPassword) { _, newValue in
                self.saveGatewayCredentials(token: self.gatewayToken, password: newValue)
            }
            .onChange(of: self.appModel.lastGatewayProblem) { _, newValue in
                self.updateConnectionIssue(problem: newValue, statusText: self.appModel.gatewayStatusText)
            }
            .onChange(of: self.appModel.gatewayStatusText) { _, newValue in
                self.updateConnectionIssue(problem: self.appModel.lastGatewayProblem, statusText: newValue)
            }
            .onChange(of: self.appModel.gatewayServerName) { _, newValue in
                guard newValue != nil else { return }
                self.showQRScanner = false
                self.statusLine = "Connected."
                if !self.didMarkCompleted, let selectedMode {
                    OnboardingStateStore.markCompleted(mode: selectedMode)
                    self.didMarkCompleted = true
                }
                self.step = .success
            }
            .onChange(of: self.scenePhase) { _, newValue in
                guard newValue == .active else { return }
                self.attemptAutomaticPairingResumeIfNeeded()
            }
            .onReceive(Self.pairingAutoResumeTicker) { _ in
                self.attemptAutomaticPairingResumeIfNeeded()
            }
    }

    private var introStep: some View {
        OnboardingIntroStep(onContinue: self.advanceFromIntro)
    }

    private var welcomeStep: some View {
        OnboardingWelcomeStep(
            statusLine: self.statusLine,
            onScanQRCode: {
                self.statusLine = "Opening QR scanner…"
                self.showQRScanner = true
            },
            onManualSetup: {
                self.step = .mode
            })
    }

    @ViewBuilder
    private var modeStep: some View {
        self.setupCodeSection

        Section("Connection Mode") {
            OnboardingModeRow(
                title: OnboardingConnectionMode.homeNetwork.title,
                subtitle: "LAN or Tailscale host",
                selected: self.selectedMode == .homeNetwork)
            {
                self.selectMode(.homeNetwork)
            }

            OnboardingModeRow(
                title: OnboardingConnectionMode.remoteDomain.title,
                subtitle: "VPS with domain",
                selected: self.selectedMode == .remoteDomain)
            {
                self.selectMode(.remoteDomain)
            }

            self.developerModeToggleRow

            if self.developerModeEnabled {
                OnboardingModeRow(
                    title: OnboardingConnectionMode.developerLocal.title,
                    subtitle: "For local iOS app development",
                    selected: self.selectedMode == .developerLocal)
                {
                    self.selectMode(.developerLocal)
                }
            }
        }

        Section {
            Button("Continue") {
                self.step = .connect
            }
            .disabled(self.selectedMode == nil)
        }
    }

    private var developerModeToggleRow: some View {
        self.onboardingButtonToggle(
            "Developer mode",
            isOn: Binding(
                get: { self.developerModeEnabled },
                set: { enabled in
                    self.developerModeEnabled = enabled
                    if !enabled, self.selectedMode == .developerLocal {
                        self.selectedMode = nil
                    }
                }))
    }

    private func onboardingButtonToggle(_ title: String, isOn: Binding<Bool>) -> some View {
        // Onboarding Form switch rows need full-width taps; native Toggle only hits the switch edge on iOS 26.
        Button {
            isOn.wrappedValue.toggle()
        } label: {
            HStack {
                Text(title)
                Spacer(minLength: 8)
                self.onboardingSwitchIndicator(isOn: isOn.wrappedValue)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityValue(isOn.wrappedValue ? "On" : "Off")
    }

    private func onboardingSwitchIndicator(isOn: Bool) -> some View {
        Capsule()
            .fill(isOn ? Color.accentColor : Color.secondary.opacity(0.35))
            .frame(width: 52, height: 32)
            .overlay(alignment: isOn ? .trailing : .leading) {
                Circle()
                    .fill(Color.white)
                    .frame(width: 28, height: 28)
                    .padding(2)
                    .shadow(color: Color.black.opacity(0.14), radius: 1, x: 0, y: 1)
            }
    }

    @ViewBuilder
    private var connectStep: some View {
        if let selectedMode {
            Section {
                LabeledContent("Mode", value: selectedMode.title)
                LabeledContent("Discovery", value: self.gatewayController.discoveryStatusText)
                LabeledContent("Status", value: self.appModel.gatewayDisplayStatusText)
                LabeledContent("Progress", value: self.statusLine)
            } header: {
                Text("Status")
            } footer: {
                if let connectMessage {
                    Text(connectMessage)
                }
            }

            switch selectedMode {
            case .homeNetwork:
                self.homeNetworkConnectSection
            case .remoteDomain:
                self.remoteDomainConnectSection
            case .developerLocal:
                self.developerConnectSection
            }
        } else {
            Section {
                Text("Choose a mode first.")
                Button("Back to Mode Selection") {
                    self.step = .mode
                }
            }
        }
    }

    private var homeNetworkConnectSection: some View {
        Group {
            Section("Discovered Gateways") {
                if self.gatewayController.gateways.isEmpty {
                    Text("No gateways found yet.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(self.gatewayController.gateways) { gateway in
                        let hasHost = self.gatewayHasResolvableHost(gateway)

                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(gateway.name)
                                if let host = gateway.lanHost ?? gateway.tailnetDns {
                                    Text(host)
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            Button {
                                Task { await self.connectDiscoveredGateway(gateway) }
                            } label: {
                                if self.connectingGatewayID == gateway.id {
                                    ProgressView()
                                        .progressViewStyle(.circular)
                                } else if !hasHost {
                                    Text("Resolving…")
                                } else {
                                    Text("Connect")
                                }
                            }
                            .disabled(self.connectingGatewayID != nil || !hasHost)
                        }
                    }
                }

                Button("Restart Discovery") {
                    self.gatewayController.restartDiscovery()
                }
                .disabled(self.connectingGatewayID != nil)
            }

            self.manualConnectionFieldsSection(title: "Manual Fallback")
        }
    }

    private var remoteDomainConnectSection: some View {
        self.manualConnectionFieldsSection(title: "Domain Settings")
    }

    private var developerConnectSection: some View {
        Section {
            TextField("Host", text: self.$manualHost)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            TextField("Port", text: self.$manualPortText)
                .keyboardType(.numberPad)
            self.onboardingButtonToggle("Use TLS", isOn: self.$manualTLS)
            self.manualConnectButton
        } header: {
            Text("Developer Local")
        } footer: {
            Text("Default host is localhost. Use your Mac LAN IP if simulator networking requires it.")
        }
    }

    private var authStep: some View {
        Group {
            Section("Authentication") {
                SecureField("Gateway Auth Token", text: self.$gatewayToken)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("Gateway Password", text: self.$gatewayPassword)

                if let problem = self.currentProblem {
                    GatewayProblemBanner(
                        problem: problem,
                        primaryActionTitle: self.gatewayProblemPrimaryActionTitle(problem),
                        onPrimaryAction: {
                            Task { await self.handleGatewayProblemPrimaryAction(problem) }
                        },
                        onShowDetails: {
                            self.showGatewayProblemDetails = true
                        })
                } else if self.issue.needsAuthToken {
                    Text("Gateway rejected credentials. Scan a fresh QR code or update token/password.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    Text("Auth token looks valid.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            if self.issue.needsPairing {
                Section {
                    Button {
                        self.resumeAfterPairingApproval()
                    } label: {
                        Label("Resume After Approval", systemImage: "arrow.clockwise")
                    }
                    .disabled(self.connectingGatewayID != nil)
                } header: {
                    Text("Pairing Approval")
                } footer: {
                    let requestLine: String = {
                        if let id = self.currentProblem?.requestId ?? self.issue.requestId, !id.isEmpty {
                            return "Request ID: \(id)"
                        }
                        return "Request ID: check `openclaw devices list`."
                    }()
                    let commandLine = self.currentProblem?.actionCommand ?? "openclaw devices approve <requestId>"
                    Text(
                        "Approve this device on the gateway.\n"
                            + "1) `\(commandLine)`\n"
                            + "2) `/pair approve` in your OpenClaw chat\n"
                            + "\(requestLine)\n"
                            + "OpenClaw will also retry automatically when you return to this app.")
                }
            }

            Section {
                Button {
                    self.openQRScannerFromOnboarding()
                } label: {
                    Label("Scan QR Code Again", systemImage: "qrcode.viewfinder")
                }
                .disabled(self.connectingGatewayID != nil)

                Button {
                    Task { await self.retryLastAttempt() }
                } label: {
                    if self.connectingGatewayID == "retry" {
                        ProgressView()
                            .progressViewStyle(.circular)
                    } else {
                        Text("Retry Connection")
                    }
                }
                .disabled(self.connectingGatewayID != nil)
            }
        }
    }

    private var successStep: some View {
        VStack(spacing: 0) {
            Spacer()

            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 64))
                .foregroundStyle(.green)
                .padding(.bottom, 20)

            Text("Connected")
                .font(.largeTitle.weight(.bold))
                .padding(.bottom, 8)

            let server = self.appModel.gatewayServerName ?? "gateway"
            Text(server)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.bottom, 4)

            if let addr = self.appModel.gatewayRemoteAddress {
                Text(addr)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Button {
                self.onClose()
            } label: {
                Text("Open OpenClaw")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .padding(.horizontal, 24)
            .padding(.bottom, 48)
        }
    }
}

extension OnboardingWizardView {
    private var setupCodeSection: some View {
        Section {
            TextField("Paste setup code", text: self.$setupCode)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .onSubmit {
                    Task { await self.applySetupCodeAndConnect() }
                }

            Button {
                Task { await self.applySetupCodeAndConnect() }
            } label: {
                if self.connectingGatewayID == "setup-code" {
                    HStack(spacing: 8) {
                        ProgressView()
                            .progressViewStyle(.circular)
                        Text("Applying...")
                    }
                } else {
                    Text("Apply Setup Code")
                }
            }
            .disabled(
                self.setupCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || self.connectingGatewayID != nil)

            if let setupCodeStatus, !setupCodeStatus.isEmpty {
                Text(setupCodeStatus)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Setup Code")
        } footer: {
            Text("Use this if you received a setup code instead of a QR code.")
        }
    }

    private func manualConnectionFieldsSection(title: String) -> some View {
        Section(title) {
            TextField("Host", text: self.$manualHost)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            TextField("Port", text: self.$manualPortText)
                .keyboardType(.numberPad)
            self.onboardingButtonToggle("Use TLS", isOn: self.$manualTLS)
            TextField("Discovery Domain (optional)", text: self.$discoveryDomain)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            if self.selectedMode == .remoteDomain {
                SecureField("Gateway Auth Token", text: self.$gatewayToken)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("Gateway Password", text: self.$gatewayPassword)
            }
            self.manualConnectButton
        }
    }

    private var manualConnectButton: some View {
        Button {
            Task { await self.connectManual() }
        } label: {
            if self.connectingGatewayID == "manual" {
                HStack(spacing: 8) {
                    ProgressView()
                        .progressViewStyle(.circular)
                    Text("Connecting…")
                }
            } else {
                Text("Connect")
            }
        }
        .disabled(!self.canConnectManual || self.connectingGatewayID != nil)
    }

    private func applySetupCodeAndConnect() async {
        self.setupCodeStatus = nil
        let raw = self.setupCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else {
            self.setupCodeStatus = "Paste a setup code to continue."
            return
        }

        if AppleReviewDemoMode.isSetupCode(raw) {
            self.setupCode = ""
            self.setupCodeStatus = "Apple Review demo mode enabled."
            self.handleScannedSetupCode(raw)
            return
        }

        guard let link = GatewayConnectDeepLink.fromSetupInput(raw) else {
            self.setupCodeStatus = "Setup code not recognized or uses an insecure ws:// gateway URL."
            return
        }

        self.connectingGatewayID = "setup-code"
        self.applyGatewayLink(link)
        self.setupCode = ""
        self.setupCodeStatus = "Setup code applied. Connecting..."
        self.connectMessage = "Connecting via setup code..."
        self.statusLine = "Setup code loaded. Connecting to \(link.host):\(link.port)..."
        self.step = .connect
        await self.connectManual()
    }

    private func handleScannedLink(_ link: GatewayConnectDeepLink) {
        self.applyGatewayLink(link)
        self.setupCodeStatus = nil
        self.showQRScanner = false
        self.connectMessage = "Connecting via QR code..."
        self.statusLine = "QR loaded. Connecting to \(link.host):\(link.port)..."
        Task { await self.connectManual() }
    }

    private func applyGatewayLink(_ link: GatewayConnectDeepLink) {
        self.manualHost = link.host
        self.manualPort = link.port
        self.manualPortText = String(link.port)
        self.manualTLS = link.tls
        let setupAuth = GatewayConnectionController.ManualAuthOverride.setupAuth(from: link)
        if setupAuth.hasBootstrapToken {
            GatewayOnboardingReset.prepareForBootstrapPairing(
                appModel: self.appModel,
                instanceId: GatewaySettingsStore.currentInstanceID())
        }
        self.saveGatewayBootstrapToken(setupAuth.bootstrapToken)
        if setupAuth.shouldApplyTokenField {
            self.gatewayToken = setupAuth.token
        }
        if setupAuth.shouldApplyPasswordField {
            self.gatewayPassword = setupAuth.password
        }
        self.pendingManualAuthOverride = setupAuth.manualAuthOverride
        self.saveGatewayCredentials(token: self.gatewayToken, password: self.gatewayPassword)
        if self.selectedMode == nil {
            self.selectedMode = link.tls ? .remoteDomain : .homeNetwork
        }
    }

    private func handleScannedSetupCode(_ code: String) {
        guard AppleReviewDemoMode.isSetupCode(code) else { return }
        self.showQRScanner = false
        self.connectingGatewayID = nil
        self.connectMessage = "Apple Review demo mode enabled."
        self.statusLine = "Apple Review demo mode enabled."
        self.selectedMode = .homeNetwork
        self.appModel.enterAppleReviewDemoMode()
    }

    private func openQRScannerFromOnboarding() {
        // Stop active reconnect loops before scanning new credentials.
        self.appModel.disconnectGateway()
        self.connectingGatewayID = nil
        self.connectMessage = nil
        self.issue = .none
        self.pairingRequestId = nil
        self.statusLine = "Opening QR scanner…"
        self.showQRScanner = true
    }

    private func resumeAfterPairingApproval() {
        // We intentionally stop reconnect churn while unpaired to avoid generating multiple pending requests.
        self.appModel.gatewayAutoReconnectEnabled = true
        self.appModel.gatewayPairingPaused = false
        self.appModel.gatewayPairingRequestId = nil
        // Pairing state is sticky to prevent UI flip-flop during reconnect churn.
        // Once the user explicitly resumes after approving, clear the sticky issue
        // so new status/auth errors can surface instead of being masked as pairing.
        self.issue = .none
        self.connectMessage = "Retrying after approval…"
        self.statusLine = "Retrying after approval…"
        Task { await self.retryLastAttempt() }
    }

    private func resumeAfterPairingApprovalInBackground() {
        // Keep the pairing issue sticky to avoid visual flicker while we probe for approval.
        self.appModel.gatewayAutoReconnectEnabled = true
        self.appModel.gatewayPairingPaused = false
        self.appModel.gatewayPairingRequestId = nil
        Task { await self.retryLastAttempt(silent: true) }
    }

    private func attemptAutomaticPairingResumeIfNeeded() {
        guard self.scenePhase == .active else { return }
        guard self.step == .auth else { return }
        guard self.issue.needsPairing else { return }
        guard self.connectingGatewayID == nil else { return }

        let now = Date()
        if let last = self.lastPairingAutoResumeAttemptAt, now.timeIntervalSince(last) < 6 {
            return
        }
        self.lastPairingAutoResumeAttemptAt = now
        self.resumeAfterPairingApprovalInBackground()
    }

    private func updateConnectionIssue(problem: GatewayConnectionProblem?, statusText: String) {
        let next = GatewayConnectionIssue.detect(problem: problem)
        let fallback = next == .none ? GatewayConnectionIssue.detect(from: statusText) : next

        // Avoid "flip-flopping" the UI by clearing actionable issues when the underlying connection
        // transitions through intermediate statuses (e.g. Offline/Connecting while reconnect churns).
        if self.issue.needsPairing, fallback.needsPairing {
            let mergedRequestId = fallback.requestId ?? self.issue.requestId ?? self.pairingRequestId
            self.issue = .pairingRequired(requestId: mergedRequestId)
        } else if self.issue.needsPairing, !fallback.needsPairing {
            // Ignore non-pairing statuses until the user explicitly retries/scans again, or we connect.
        } else if self.issue.needsAuthToken, !fallback.needsAuthToken, !fallback.needsPairing {
            // Same idea for auth: once we learn credentials are missing/rejected, keep that sticky until
            // the user retries/scans again or we successfully connect.
        } else {
            self.issue = fallback
        }

        if let requestId = problem?.requestId ?? fallback.requestId, !requestId.isEmpty {
            self.pairingRequestId = requestId
        }

        if self.issue.needsAuthToken || self.issue.needsPairing || problem?.pauseReconnect == true {
            self.step = .auth
        }

        if let problem {
            self.connectMessage = problem.message
            self.statusLine = problem.message
            return
        }

        let trimmedStatus = statusText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedStatus.isEmpty {
            self.connectMessage = trimmedStatus
            self.statusLine = trimmedStatus
        }
    }

    private func detectQRCode(from data: Data) -> String? {
        guard let ciImage = CIImage(data: data) else { return nil }
        let detector = CIDetector(
            ofType: CIDetectorTypeQRCode,
            context: nil,
            options: [CIDetectorAccuracy: CIDetectorAccuracyHigh])
        let features = detector?.features(in: ciImage) ?? []
        for feature in features {
            if let qr = feature as? CIQRCodeFeature, let message = qr.messageString {
                return message
            }
        }
        return nil
    }

    private func advanceFromIntro() {
        OnboardingStateStore.markFirstRunIntroSeen()
        self.statusLine = "In your OpenClaw chat, run /pair qr, then scan the code here."
        self.step = .welcome
    }

    private func navigateBack() {
        guard let target = self.step.previous else { return }
        self.connectingGatewayID = nil
        self.connectMessage = nil
        self.step = target
    }

    private var canConnectManual: Bool {
        let host = self.manualHost.trimmingCharacters(in: .whitespacesAndNewlines)
        return !host.isEmpty && self.manualPort > 0 && self.manualPort <= 65535
    }

    private func initializeState() {
        if self.manualHost.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            if let last = GatewaySettingsStore.loadLastGatewayConnection() {
                switch last {
                case let .manual(host, port, useTLS, _):
                    self.manualHost = host
                    self.manualPort = port
                    self.manualTLS = useTLS
                case .discovered:
                    self.manualHost = "openclaw.local"
                    self.manualPort = 18789
                    self.manualTLS = true
                }
            } else {
                self.manualHost = "openclaw.local"
                self.manualPort = 18789
                self.manualTLS = true
            }
        }
        self.manualPortText = self.manualPort > 0 ? String(self.manualPort) : ""
        if self.selectedMode == nil {
            self.selectedMode = OnboardingStateStore.lastMode()
        }
        if self.selectedMode == .developerLocal, self.manualHost == "openclaw.local" {
            self.manualHost = "localhost"
            self.manualTLS = false
        }

        let trimmedInstanceId = self.instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedInstanceId.isEmpty {
            self.gatewayToken = GatewaySettingsStore.loadGatewayToken(instanceId: trimmedInstanceId) ?? ""
            self.gatewayPassword = GatewaySettingsStore.loadGatewayPassword(instanceId: trimmedInstanceId) ?? ""
        }

        let hasSavedGateway = GatewaySettingsStore.loadLastGatewayConnection() != nil
        let hasToken = !self.gatewayToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let hasPassword = !self.gatewayPassword.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if !hasSavedGateway, !hasToken, !hasPassword {
            self.statusLine = "No saved pairing found. In your OpenClaw chat, run /pair qr, then scan the code here."
        }
    }

    private func scheduleDiscoveryRestart() {
        self.discoveryRestartTask?.cancel()
        self.discoveryRestartTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 350_000_000)
            guard !Task.isCancelled else { return }
            self.gatewayController.restartDiscovery()
        }
    }

    private func saveGatewayCredentials(token: String, password: String) {
        let trimmedInstanceId = GatewaySettingsStore.currentInstanceID()
        guard !trimmedInstanceId.isEmpty else { return }
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        GatewaySettingsStore.saveGatewayToken(trimmedToken, instanceId: trimmedInstanceId)
        let trimmedPassword = password.trimmingCharacters(in: .whitespacesAndNewlines)
        GatewaySettingsStore.saveGatewayPassword(trimmedPassword, instanceId: trimmedInstanceId)
    }

    private func saveGatewayBootstrapToken(_ token: String?) {
        let trimmedInstanceId = GatewaySettingsStore.currentInstanceID()
        guard !trimmedInstanceId.isEmpty else { return }
        let trimmedToken = token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        GatewaySettingsStore.saveGatewayBootstrapToken(trimmedToken, instanceId: trimmedInstanceId)
    }

    private func connectDiscoveredGateway(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) async {
        self.connectingGatewayID = gateway.id
        self.issue = .none
        self.connectMessage = "Connecting to \(gateway.name)…"
        self.statusLine = "Connecting to \(gateway.name)…"
        defer { self.connectingGatewayID = nil }
        await self.gatewayController.connect(gateway)
    }

    private func selectMode(_ mode: OnboardingConnectionMode) {
        self.selectedMode = mode
        self.applyModeDefaults(mode)
    }

    private func applyModeDefaults(_ mode: OnboardingConnectionMode) {
        let host = self.manualHost.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let hostIsDefaultLike = host.isEmpty || host == "openclaw.local" || host == "localhost"

        switch mode {
        case .homeNetwork:
            if hostIsDefaultLike { self.manualHost = "openclaw.local" }
            self.manualTLS = true
            if self.manualPort <= 0 || self.manualPort > 65535 { self.manualPort = 18789 }
        case .remoteDomain:
            if host == "openclaw.local" || host == "localhost" { self.manualHost = "" }
            self.manualTLS = true
            if self.manualPort <= 0 || self.manualPort > 65535 { self.manualPort = 18789 }
        case .developerLocal:
            if hostIsDefaultLike { self.manualHost = "localhost" }
            self.manualTLS = false
            if self.manualPort <= 0 || self.manualPort > 65535 { self.manualPort = 18789 }
        }
    }

    private func gatewayHasResolvableHost(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) -> Bool {
        let lanHost = gateway.lanHost?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !lanHost.isEmpty { return true }
        let tailnetDns = gateway.tailnetDns?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return !tailnetDns.isEmpty
    }

    private func connectManual() async {
        let host = self.manualHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty, self.manualPort > 0, self.manualPort <= 65535 else { return }
        self.connectingGatewayID = "manual"
        self.issue = .none
        self.connectMessage = "Connecting to \(host)…"
        self.statusLine = "Connecting to \(host):\(self.manualPort)…"
        defer { self.connectingGatewayID = nil }
        let authOverride = GatewayConnectionController.ManualAuthOverride.currentManualInput(
            token: self.gatewayToken,
            pendingOverride: self.pendingManualAuthOverride,
            password: self.gatewayPassword)
        self.pendingManualAuthOverride = nil
        await self.gatewayController.connectManual(
            host: host,
            port: self.manualPort,
            useTLS: self.manualTLS,
            authOverride: authOverride)
    }

    private func retryLastAttempt(silent: Bool = false) async {
        self.connectingGatewayID = silent ? "retry-auto" : "retry"
        // Keep current auth/pairing issue sticky while retrying to avoid Step 3 UI flip-flop.
        if !silent {
            self.connectMessage = "Retrying…"
            self.statusLine = "Retrying last connection…"
        }
        defer { self.connectingGatewayID = nil }
        await self.gatewayController.connectLastKnown()
    }

    private func gatewayProblemPrimaryActionTitle(_ problem: GatewayConnectionProblem) -> String {
        if problem.suggestsOnboardingReset { return "Scan QR again" }
        return problem.canTrustRotatedCertificate ? "Trust certificate" : "Retry connection"
    }

    private func handleGatewayProblemPrimaryAction(_ problem: GatewayConnectionProblem) async {
        if problem.suggestsOnboardingReset {
            GatewayOnboardingReset.reset(appModel: self.appModel, instanceId: self.instanceId)
            self.gatewayToken = ""
            self.gatewayPassword = ""
            self.connectingGatewayID = nil
            self.connectMessage = nil
            self.issue = .none
            self.pairingRequestId = nil
            self.statusLine = "Scan a fresh setup QR code from this gateway."
            self.step = .connect
            self.showQRScanner = true
            return
        }
        if problem.canTrustRotatedCertificate {
            self.connectingGatewayID = "trust-certificate"
            self.connectMessage = "Updating gateway certificate…"
            self.statusLine = "Updating gateway certificate…"
            defer { self.connectingGatewayID = nil }
            _ = await self.gatewayController.trustRotatedGatewayCertificate(from: problem)
            return
        }
        await self.retryLastAttempt()
    }
}
