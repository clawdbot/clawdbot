import Combine
import CoreImage
import OpenClawKit
import PhotosUI
import SwiftUI
import UIKit

private enum OnboardingFocusedField: Hashable {
    case setupCode
    case manualHost
    case manualPort
    case discoveryDomain
    case gatewayToken
    case gatewayPassword
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
    @State private var gatewayCredentialFieldStableID: String?
    @State private var connectMessage: String?
    @State private var localConnectionFailure: String?
    @State private var statusLine: String = ""
    @State private var connectingGateway: OnboardingGatewayConnectionAttempt?
    @State private var issue: GatewayConnectionIssue = .none
    @State private var didMarkCompleted = false
    @State private var pairingRequestId: String?
    @State private var discoveryRestartTask: Task<Void, Never>?
    @State private var showQRScanner: Bool = false
    @State private var scannerError: String?
    @State private var scannerResultHandoff = QRScannerResultHandoff()
    @State private var scannerScanID: UInt64 = 0
    @State private var pendingTargetSuppression = GatewayPendingTargetSuppression()
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var showGatewayProblemDetails: Bool = false
    @State private var lastPairingAutoResumeAttemptAt: Date?
    @State private var pendingManualAuthOverride: GatewayConnectionController.ManualAuthOverride?
    @State private var setupLinkStaging = GatewaySetupLinkStaging()
    @State private var setupCode: String = ""
    @State private var setupCodeStatus: String?
    @State private var setupAttemptID: UUID?
    @FocusState private var focusedField: OnboardingFocusedField?
    private static let pairingAutoResumeTicker = Timer.publish(every: 2.0, on: .main, in: .common).autoconnect()

    let allowSkip: Bool
    let onRequestLocalNetworkAccess: (String) -> Void
    let onClose: () -> Void
    let onComplete: () -> Void

    init(
        allowSkip: Bool,
        onRequestLocalNetworkAccess: @escaping (String) -> Void,
        onClose: @escaping () -> Void,
        onComplete: @escaping () -> Void)
    {
        self.allowSkip = allowSkip
        self.onRequestLocalNetworkAccess = onRequestLocalNetworkAccess
        self.onClose = onClose
        self.onComplete = onComplete
        _step = State(
            initialValue: OnboardingStateStore.shouldPresentFirstRunIntro() ? .intro : .welcome)
    }

    private var isFullScreenStep: Bool {
        self.step == .intro || self.step == .permissions || self.step == .welcome || self.step == .success
    }

    private var currentProblem: GatewayConnectionProblem? {
        self.appModel.lastGatewayProblem
    }

    private var connectPhase: OnboardingConnectPhase {
        let connectingDetail = self.connectingGateway == nil
            ? nil
            : (self.statusLine.isEmpty ? "Connecting…" : self.statusLine)
        let retryableFailure = self.issue == .none
            ? nil
            : self.connectMessage
            ?? (self.statusLine.isEmpty ? nil : self.statusLine)
            ?? self.issueFallbackMessage
        return OnboardingConnectPhase.resolve(
            problem: self.currentProblem,
            connectingDetail: connectingDetail,
            localFailure: self.localConnectionFailure,
            retryableFailure: retryableFailure)
    }

    private var issueFallbackMessage: String {
        switch self.issue {
        case .none:
            ""
        case .tokenMissing:
            "Gateway auth token is missing."
        case .passwordMissing:
            self.connectMessage ?? self.statusLine
        case .unauthorized:
            "Gateway rejected credentials."
        case let .pairingRequired(requestId):
            requestId.map { "Pairing required (request \($0))." } ?? "Pairing required."
        case .network:
            "Could not reach the gateway."
        case let .unknown(message):
            message
        }
    }

    private func setConnectionFailure(_ message: String) {
        self.localConnectionFailure = message
        self.statusLine = message
    }

    var body: some View {
        self.lifecycleContent
            .onChange(of: self.scenePhase) { _, newValue in
                guard newValue == ScenePhase.active else { return }
                self.applyPendingGatewaySetupLinkIfNeeded()
                self.attemptAutomaticPairingResumeIfNeeded()
            }
            .onReceive(Self.pairingAutoResumeTicker) { _ in
                self.attemptAutomaticPairingResumeIfNeeded()
            }
    }

    private var lifecycleContent: some View {
        NavigationStack {
            Group {
                switch self.step {
                case .intro:
                    self.introStep
                case .permissions:
                    self.permissionsStep
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
                    .formStyle(.grouped)
                    .scrollContentBackground(.hidden)
                    .background(Color(uiColor: .systemGroupedBackground))
                    .scrollDismissesKeyboard(.interactively)
                }
            }
            .navigationTitle(self.isFullScreenStep ? "" : self.step.title)
            .navigationBarTitleDisplayMode(.inline)
            .tint(OpenClawBrand.activationPrimaryAction)
            .toolbar {
                if !self.isFullScreenStep {
                    ToolbarItem(placement: .principal) {
                        VStack(spacing: 2) {
                            Text(self.step.title)
                                .font(OpenClawType.headline)
                            Text(self.step.manualProgressTitle)
                                .font(OpenClawType.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .safeAreaInset(edge: .bottom, alignment: .trailing, spacing: 0) {
            self.keyboardDismissControl
        }
        .overlay(alignment: .topLeading) {
            self.leadingChromeButton
                .padding(.leading, 16)
                .padding(.top, 10)
        }
        .gatewayTrustPromptAlert()
        .alert("QR Scanner Unavailable", isPresented: Binding(
            get: { self.scannerError != nil },
            set: {
                if !$0 { self.scannerError = nil }
            })) {
                Button(role: .cancel) {} label: {
                    Text("OK")
                        .font(OpenClawType.subheadSemiBold)
                }
        } message: {
            Text(self.scannerError ?? "")
                .font(OpenClawType.subhead)
        }
        .sheet(
            isPresented: self.$showQRScanner,
            onDismiss: {
                self.processQueuedScannerResult()
            },
            content: {
                self.qrScannerSheet
            })
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
            self.applyPendingGatewaySetupLinkIfNeeded()
            self.requestLocalNetworkAccessIfPastIntro(reason: "onboarding_appear")
        }
        .onDisappear {
            self.invalidateSetupAttempt()
            self.discoveryRestartTask?.cancel()
            self.discoveryRestartTask = nil
            self.scannerResultHandoff.cancel()
            self.pendingTargetSuppression.resumeAutoConnect(controller: self.gatewayController)
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
        .onChange(of: self.setupCode) { _, newValue in
            guard !newValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            self.clearStagedGatewaySetupLink()
        }
        .onChange(of: self.appModel.lastGatewayProblem) { _, newValue in
            self.updateConnectionIssue(problem: newValue, statusText: self.appModel.gatewayStatusText)
        }
        .onChange(of: self.appModel.gatewayStatusText) { _, newValue in
            self.updateConnectionIssue(problem: self.appModel.lastGatewayProblem, statusText: newValue)
        }
        .onChange(of: self.appModel.gatewaySetupRequestID) { _, _ in
            self.applyPendingGatewaySetupLinkIfNeeded()
        }
        .onChange(of: self.appModel.gatewayServerName) { _, newValue in
            guard newValue != nil, self.setupLinkStaging.link == nil else { return }
            self.showQRScanner = false
            self.statusLine = "Connected."
            if !self.didMarkCompleted, let selectedMode {
                OnboardingStateStore.markCompleted(mode: selectedMode)
                self.didMarkCompleted = true
            }
            self.navigate(to: .success)
        }
    }

    private var qrScannerSheet: some View {
        let scanID = self.scannerScanID
        return NavigationStack {
            QRScannerView(
                onResult: { result in
                    self.queueScannedResult(result, scanID: scanID)
                },
                onError: { error in
                    guard self.scannerResultHandoff.isActive(scanID: scanID) else { return }
                    self.showQRScanner = false
                    self.statusLine = "Scanner error: \(error)"
                    self.scannerError = error
                },
                onDismiss: {
                    guard self.scannerResultHandoff.isActive(scanID: scanID) else { return }
                    self.showQRScanner = false
                })
                .ignoresSafeArea()
                .navigationTitle("Scan Setup Code")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .principal) {
                        Text("Scan Setup Code")
                            .font(OpenClawType.headline)
                    }
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
                    ToolbarItem(placement: .topBarTrailing) {
                        PhotosPicker(selection: self.$selectedPhoto, matching: .images) {
                            Label("Photos", systemImage: "photo")
                                .font(OpenClawType.subheadSemiBold)
                        }
                    }
                }
        }
        .onChange(of: self.selectedPhoto) { _, newValue in
            guard let item = newValue else { return }
            self.selectedPhoto = nil
            Task {
                guard let data = try? await item.loadTransferable(type: Data.self) else {
                    guard self.scannerResultHandoff.isActive(scanID: scanID) else { return }
                    self.showQRScanner = false
                    self.scannerError = "Could not load the selected image."
                    return
                }
                guard self.scannerResultHandoff.isActive(scanID: scanID) else { return }
                if let message = self.detectQRCode(from: data) {
                    if let link = GatewayConnectDeepLink.fromSetupInput(message) {
                        self.queueScannedResult(.gatewayLink(link), scanID: scanID)
                        return
                    }
                    if AppleReviewDemoMode.isSetupCode(message) {
                        self.queueScannedResult(.setupCode(message), scanID: scanID)
                        return
                    }
                }
                self.showQRScanner = false
                self.scannerError = "No valid QR code found in the selected image."
            }
        }
    }

    @ViewBuilder
    private var leadingChromeButton: some View {
        if self.step.canGoBack {
            Button {
                self.navigateBack()
            } label: {
                Image(systemName: "chevron.left")
                    .font(OpenClawType.subheadSemiBold)
                    .accessibilityLabel("Back")
            }
            .buttonStyle(OpenClawCloseButtonStyle())
        } else if self.allowSkip {
            Button {
                self.invalidateSetupAttempt()
                self.onClose()
            } label: {
                Text("Close")
                    .font(OpenClawType.subheadSemiBold)
            }
            .buttonStyle(OpenClawCloseButtonStyle())
        }
    }

    @ViewBuilder
    private var keyboardDismissControl: some View {
        if self.focusedField != nil {
            Button {
                self.dismissKeyboard()
            } label: {
                Image(systemName: "keyboard.chevron.compact.down")
                    .font(OpenClawType.headline)
                    .frame(width: 50, height: 44)
                    .contentShape(Capsule(style: .continuous))
            }
            .buttonStyle(.plain)
            .foregroundStyle(OpenClawBrand.activationPrimaryAction)
            .background(.ultraThinMaterial, in: Capsule(style: .continuous))
            .overlay {
                Capsule(style: .continuous)
                    .stroke(OpenClawBrand.activationNeutralStroke, lineWidth: 0.6)
            }
            .shadow(color: Color.black.opacity(0.08), radius: 14, x: 0, y: 4)
            .accessibilityLabel("Dismiss Keyboard")
            .padding(.trailing, 20)
            .padding(.bottom, 10)
            .transition(.opacity.combined(with: .scale(scale: 0.96)))
            .animation(.smooth(duration: 0.16), value: self.focusedField)
        }
    }

    private var introStep: some View {
        OnboardingIntroStep(onContinue: self.advanceFromIntro)
    }

    private var permissionsStep: some View {
        OnboardingPermissionsStep(onContinue: self.advanceFromPermissions)
    }

    private var welcomeStep: some View {
        OnboardingWelcomeStep(
            statusLine: self.statusLine,
            isConnecting: self.connectingGateway != nil,
            onScanQRCode: {
                self.openQRScannerFromOnboarding()
            },
            onManualSetup: {
                self.invalidateSetupAttempt()
                self.statusLine = ""
                self.navigate(to: .mode)
            })
    }

    @ViewBuilder
    private var modeStep: some View {
        self.setupCodeSection
        OnboardingModeSelectionSections(
            selectedMode: self.selectedMode,
            developerModeEnabled: Binding(
                get: { self.developerModeEnabled },
                set: { enabled in
                    self.developerModeEnabled = enabled
                    if !enabled, self.selectedMode == .developerLocal {
                        self.selectedMode = nil
                    }
                }),
            isConnecting: self.connectingGateway != nil,
            onSelectMode: self.selectMode,
            onContinue: {
                self.navigate(to: .connect)
            })
    }

    @ViewBuilder
    private var connectStep: some View {
        if let selectedMode {
            Section {
                self.connectPhaseView
                self.onboardingLabeledContent("Mode", value: selectedMode.title)
                self.onboardingLabeledContent("Discovery", value: self.gatewayController.discoveryStatusText)
            } header: {
                Text("Status")
                    .font(OpenClawType.footnoteSemiBold)
            }

            if let stagedLink = self.setupLinkStaging.link {
                self.stagedGatewaySetupSection(stagedLink)
            } else {
                switch selectedMode {
                case .homeNetwork:
                    self.homeNetworkConnectSection
                case .remoteDomain:
                    self.remoteDomainConnectSection
                case .developerLocal:
                    self.developerConnectSection
                }
            }
        } else {
            Section {
                Text("Choose a mode first.")
                    .font(OpenClawType.body)
                Button {
                    self.navigate(to: .mode)
                } label: {
                    Text("Back to Mode Selection")
                        .font(OpenClawType.subheadSemiBold)
                }
            }
        }
    }

    private var connectPhaseView: some View {
        OnboardingConnectPhaseView(
            phase: self.connectPhase,
            primaryActionTitle: self.gatewayProblemPrimaryActionTitle,
            onHandleProblem: { problem in
                Task { await self.handleGatewayProblemPrimaryAction(problem) }
            },
            onRetry: {
                Task { await self.retryLastAttempt() }
            },
            onShowDetails: {
                self.showGatewayProblemDetails = true
            })
    }

    private func stagedGatewaySetupSection(_ link: GatewayConnectDeepLink) -> some View {
        OnboardingStagedGatewaySetupSection(
            link: link,
            isConnecting: self.connectingGateway == .manual,
            isBusy: self.connectingGateway != nil,
            onConnect: {
                Task { await self.connectStagedGatewaySetupLink() }
            },
            onUseManualSetup: self.clearStagedGatewaySetupLink)
    }

    @ViewBuilder
    private var homeNetworkConnectSection: some View {
        OnboardingDiscoveredGatewaysSection(
            gateways: self.gatewayController.gateways,
            gatewayController: self.gatewayController,
            connectingGateway: self.connectingGateway,
            onConnect: { gateway in
                Task { await self.connectDiscoveredGateway(gateway) }
            },
            onRestartDiscovery: self.gatewayController.restartDiscovery)

        self.manualConnectionFieldsSection(title: "Manual Fallback")
    }

    private var remoteDomainConnectSection: some View {
        self.manualConnectionFieldsSection(title: "Domain Settings")
    }

    private var developerConnectSection: some View {
        Section {
            self.onboardingTextField("Host", text: self.manualHostBinding, focusedField: .manualHost)
            self.onboardingTextField("Port", text: self.manualPortTextBinding, focusedField: .manualPort)
                .keyboardType(.numberPad)
            self.manualConnectionSecurityRows
            self.manualConnectButton
        } header: {
            Text("Developer Local")
                .font(OpenClawType.footnoteSemiBold)
        } footer: {
            Text("Default host is localhost. Use your Mac LAN IP if simulator networking requires it.")
                .font(OpenClawType.footnote)
        }
    }

    @ViewBuilder
    private var authStep: some View {
        Section {
            self.onboardingSecureField(
                "Gateway Auth Token",
                text: self.gatewayTokenBinding,
                focusedField: .gatewayToken)
            self.onboardingSecureField(
                "Gateway Password",
                text: self.gatewayPasswordBinding,
                focusedField: .gatewayPassword)

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
            } else if self.issue == .unauthorized {
                Text("Gateway rejected credentials. Scan a fresh setup code or update token/password.")
                    .font(OpenClawType.footnote)
                    .foregroundStyle(.secondary)
            } else if self.issue.needsAuthCredentials {
                Text(verbatim: self.connectMessage ?? self.statusLine)
                    .font(OpenClawType.footnote)
                    .foregroundStyle(.secondary)
            } else {
                Text("OpenClaw is checking gateway and node access.")
                    .font(OpenClawType.footnote)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text(self.gatewayStatusSectionTitle)
                .font(OpenClawType.footnoteSemiBold)
        }

        if self.issue.needsPairing {
            Section {
                Button {
                    self.resumeAfterPairingApproval()
                } label: {
                    Label("Resume After Approval", systemImage: "arrow.clockwise")
                        .font(OpenClawType.subheadSemiBold)
                }
                .font(OpenClawType.subheadSemiBold)
                .disabled(self.connectingGateway != nil)
            } header: {
                Text("Pairing Approval")
                    .font(OpenClawType.footnoteSemiBold)
            } footer: {
                let requestLine: String = {
                    if let id = self.currentProblem?.requestId ?? self.issue.requestId, !id.isEmpty {
                        return String(
                            format: String(localized: "Request ID: %@"),
                            id)
                    }
                    return String(localized: "Request ID: check `openclaw devices list`.")
                }()
                let commandLine = self.currentProblem?.actionCommand ?? "openclaw devices approve <requestId>"
                Text(verbatim: String(
                    format: String(localized: """
                    Approve this device on the gateway.
                    1) `%1$@`
                    2) `/pair approve` in your OpenClaw chat
                    %2$@
                    OpenClaw will also retry automatically when you return to this app.
                    """),
                    commandLine,
                    requestLine))
                    .font(OpenClawType.caption)
            }
        }

        Section {
            Button {
                self.openQRScannerFromOnboarding()
            } label: {
                Label("Scan Setup Code Again", systemImage: "qrcode.viewfinder")
                    .font(OpenClawType.subheadSemiBold)
            }
            .font(OpenClawType.subheadSemiBold)
            .disabled(self.connectingGateway != nil)

            Button {
                Task { await self.retryLastAttempt() }
            } label: {
                if self.connectingGateway == .retry {
                    ProgressView()
                        .progressViewStyle(.circular)
                } else {
                    Text("Retry Connection")
                        .font(OpenClawType.subheadSemiBold)
                }
            }
            .font(OpenClawType.subheadSemiBold)
            .disabled(self.connectingGateway != nil)
        }
    }

    private var successStep: some View {
        OnboardingSuccessStep(
            gatewayName: self.appModel.gatewayServerName ?? "gateway",
            gatewayAddress: self.appModel.gatewayRemoteAddress,
            onGetStarted: self.onComplete)
    }
}

extension OnboardingWizardView {
    private var gatewayStatusSectionTitle: String {
        if self.issue.needsPairing || self.currentProblem?.needsPairingApproval == true {
            return "Gateway Approval"
        }
        if self.issue.needsAuthCredentials || self.currentProblem != nil {
            return "Authentication"
        }
        return "Gateway Status"
    }

    private var setupCodeSection: some View {
        Section {
            HStack(spacing: 12) {
                self.onboardingTextField("Enter setup code", text: self.$setupCode, focusedField: .setupCode)
                    .lineLimit(1)
                    .submitLabel(.go)
                    .onSubmit {
                        guard self.canApplySetupCode else { return }
                        Task { await self.applySetupCodeAndConnect() }
                    }

                Button {
                    Task { await self.applySetupCodeAndConnect() }
                } label: {
                    if self.connectingGateway == .setupCode {
                        ProgressView()
                            .progressViewStyle(.circular)
                            .controlSize(.small)
                    } else {
                        Text("Apply")
                            .font(OpenClawType.subheadSemiBold)
                    }
                }
                .buttonStyle(.bordered)
                .buttonBorderShape(.capsule)
                .controlSize(.regular)
                .tint(OpenClawBrand.activationPrimaryAction)
                .disabled(!self.canApplySetupCode)
            }
            .frame(minHeight: 50)

            if let setupCodeStatus, !setupCodeStatus.isEmpty {
                Text(setupCodeStatus)
                    .font(OpenClawType.footnote)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Setup Code")
                .font(OpenClawType.footnoteSemiBold)
        } footer: {
            Text("Use this if you have a setup code instead of scanning.")
                .font(OpenClawType.footnote)
        }
    }

    private var canApplySetupCode: Bool {
        !self.setupCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && self.connectingGateway == nil
    }

    private func manualConnectionFieldsSection(title: LocalizedStringKey) -> some View {
        Section {
            self.onboardingTextField("Host", text: self.manualHostBinding, focusedField: .manualHost)
            self.onboardingTextField("Port", text: self.manualPortTextBinding, focusedField: .manualPort)
                .keyboardType(.numberPad)
            self.manualConnectionSecurityRows
            self.onboardingTextField(
                "Discovery Domain (optional)",
                text: self.$discoveryDomain,
                focusedField: .discoveryDomain)
            if self.selectedMode == .remoteDomain {
                self.onboardingSecureField(
                    "Gateway Auth Token",
                    text: self.gatewayTokenBinding,
                    focusedField: .gatewayToken)
                self.onboardingSecureField(
                    "Gateway Password",
                    text: self.gatewayPasswordBinding,
                    focusedField: .gatewayPassword)
            }
            self.manualConnectButton
        } header: {
            Text(title)
                .font(OpenClawType.footnoteSemiBold)
        }
    }

    private var manualTransport: GatewayManualTransportPresentation {
        GatewayConnectionController.manualTransportPresentation(
            host: self.manualHost,
            requestedTLS: self.manualTLS)
    }

    private var manualTLSBinding: Binding<Bool> {
        Binding(
            get: { self.manualTransport.effectiveTLS },
            set: { enabled in
                guard !self.manualTransport.requiresTLS else { return }
                self.manualTLS = enabled
            })
    }

    @ViewBuilder
    private var manualConnectionSecurityRows: some View {
        Picker(selection: self.manualTLSBinding) {
            Text("Unencrypted")
                .font(OpenClawType.captionSemiBold)
                .tag(false)
            Text("Secure (TLS)")
                .font(OpenClawType.captionSemiBold)
                .tag(true)
        } label: {
            Text("Connection security")
                .font(OpenClawType.captionSemiBold)
        }
        .pickerStyle(.segmented)
        .disabled(self.manualTransport.requiresTLS)

        if let helperText = self.manualTransport.helperText {
            Text(helperText)
                .font(OpenClawType.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private func onboardingLabeledContent(_ title: LocalizedStringKey, value: String) -> some View {
        LabeledContent {
            Text(verbatim: value)
                .font(OpenClawType.body)
        } label: {
            Text(title)
                .font(OpenClawType.body)
        }
    }

    private func onboardingTextField(
        _ placeholder: LocalizedStringKey,
        text: Binding<String>,
        focusedField: OnboardingFocusedField) -> some View
    {
        TextField(
            "",
            text: text,
            prompt: Text(placeholder)
                .font(OpenClawType.subhead)
                .foregroundStyle(.tertiary))
            .font(OpenClawType.subhead)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .focused(self.$focusedField, equals: focusedField)
            .accessibilityLabel(placeholder)
    }

    private func onboardingSecureField(
        _ placeholder: LocalizedStringKey,
        text: Binding<String>,
        focusedField: OnboardingFocusedField) -> some View
    {
        ZStack(alignment: .leading) {
            if text.wrappedValue.isEmpty {
                Text(placeholder)
                    .font(OpenClawType.subhead)
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            SecureField("", text: text)
                .font(OpenClawType.subhead)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused(self.$focusedField, equals: focusedField)
        }
        .accessibilityLabel(placeholder)
    }

    private var manualConnectButton: some View {
        Button {
            Task { await self.connectManual() }
        } label: {
            if self.connectingGateway == .manual {
                HStack(spacing: 8) {
                    ProgressView()
                        .progressViewStyle(.circular)
                    Text("Connecting…")
                        .font(OpenClawType.subheadSemiBold)
                }
            } else {
                Text("Connect")
                    .font(OpenClawType.subheadSemiBold)
            }
        }
        .font(OpenClawType.subheadSemiBold)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .disabled(!self.canConnectManual || self.connectingGateway != nil)
    }

    private func applySetupCodeAndConnect() async {
        self.setupCodeStatus = nil
        let raw = self.setupCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else {
            self.setupCodeStatus = "Paste a setup code to continue."
            return
        }
        self.clearStagedGatewaySetupLink()

        if AppleReviewDemoMode.isSetupCode(raw) {
            self.setupCode = ""
            self.setupCodeStatus = "Apple Review demo mode enabled."
            self.handleScannedSetupCode(raw)
            return
        }

        guard let parsedLink = GatewayConnectDeepLink.fromSetupInput(raw) else {
            self.setupCodeStatus = "Setup code not recognized or uses an insecure ws:// gateway URL."
            return
        }

        guard let attemptID = self.beginSetupAttempt() else { return }
        defer { self.finishSetupAttempt(attemptID) }
        let link = await self.gatewayController.selectReachableSetupLink(parsedLink)
        guard self.setupAttemptID == attemptID else { return }

        await self.applyGatewayLink(link)
        self.setupCode = ""
        self.setupCodeStatus = "Setup code applied. Connecting…"
        self.connectMessage = "Connecting via setup code…"
        self.statusLine = "Setup code loaded. Connecting to \(link.host):\(link.port)…"
        await self.prepareFocusedFieldForStepTransition()
        self.navigate(to: .connect)
        await self.connectManual(setupAttemptID: attemptID)
    }

    private func queueScannedResult(_ result: QRScannerResult, scanID: UInt64) {
        guard self.scannerResultHandoff.queue(result, scanID: scanID) else { return }
        self.statusLine = "QR loaded. Closing scanner..."
        self.showQRScanner = false
    }

    private func processQueuedScannerResult() {
        let delivery = self.scannerResultHandoff.processAfterDismissal { result in
            switch result {
            case let .gatewayLink(link):
                self.handleScannedLink(link)
            case let .setupCode(code):
                self.handleScannedSetupCode(code)
            }
        }
        if delivery == nil {
            self.pendingTargetSuppression.resumeAutoConnect(.qrScanner, controller: self.gatewayController)
        }
    }

    private func handleScannedLink(_ link: GatewayConnectDeepLink) {
        self.showQRScanner = false
        guard let attemptID = self.beginSetupAttempt() else { return }
        self.setupCodeStatus = nil
        Task { await self.connectScannedLink(link, attemptID: attemptID) }
    }

    private func connectScannedLink(_ parsedLink: GatewayConnectDeepLink, attemptID: UUID) async {
        defer {
            self.finishSetupAttempt(attemptID)
            self.pendingTargetSuppression.resumeAutoConnect(.qrScanner, controller: self.gatewayController)
        }
        let link = await self.gatewayController.selectReachableSetupLink(parsedLink)
        guard self.setupAttemptID == attemptID else { return }
        await self.applyGatewayLink(link)
        self.connectMessage = "Connecting via setup code…"
        self.statusLine = "Setup code loaded. Connecting to \(link.host):\(link.port)…"
        self.navigate(to: .connect)
        await self.connectManual(setupAttemptID: attemptID)
    }

    private func applyPendingGatewaySetupLinkIfNeeded() {
        guard let link = self.appModel.consumePendingGatewaySetupLink() else { return }
        self.showQRScanner = false
        self.scannerResultHandoff.cancel()
        self.showGatewayProblemDetails = false
        let lease = self.gatewayController.cancelPendingConnectionAttempts()
        self.pendingTargetSuppression.replace(owner: .setupLink, lease: lease)
        if self.selectedMode == nil {
            self.selectedMode = link.tls ? .remoteDomain : .homeNetwork
        }
        self.setupLinkStaging.stage(link)
        self.localConnectionFailure = nil
        self.setupCodeStatus = "Setup link loaded for \(link.host):\(link.port). Tap Connect to apply."
        self.connectMessage = nil
        self.statusLine = self.setupCodeStatus ?? ""
        self.navigate(to: .connect)
    }

    private func connectStagedGatewaySetupLink() async {
        guard self.connectingGateway == nil else { return }
        guard let link = self.setupLinkStaging.link else { return }
        guard link.isValidEndpoint else {
            let message = "Setup link has an invalid gateway endpoint."
            self.setupCodeStatus = message
            self.setConnectionFailure(message)
            return
        }
        self.connectingGateway = .manual
        self.localConnectionFailure = nil
        defer { self.connectingGateway = nil }
        let lease = self.gatewayController.cancelPendingConnectionAttempts()
        self.pendingTargetSuppression.replace(owner: .setupLink, lease: lease)
        defer { self.pendingTargetSuppression.resumeAutoConnect(.setupLink, controller: self.gatewayController) }
        await self.appModel.resetGatewaySessionsForTargetSwitch()
        guard self.setupLinkStaging.link == link else { return }
        _ = self.setupLinkStaging.take()
        await self.applyGatewayLink(link, disconnectExistingGatewayForBootstrap: false)
        self.setupCodeStatus = "Setup link applied. Connecting…"
        self.issue = .none
        self.connectMessage = "Connecting to \(link.host)…"
        self.statusLine = "Connecting to \(link.host):\(link.port)…"
        await self.connectCurrentManualGateway(host: link.host, port: link.port, forceReconnect: false)
    }

    private func clearStagedGatewaySetupLink() {
        guard self.setupLinkStaging.cancel() else { return }
        self.pendingTargetSuppression.resumeAutoConnect(.setupLink, controller: self.gatewayController)
        let message = "Setup link cleared."
        self.localConnectionFailure = nil
        self.setupCodeStatus = message
        self.statusLine = message
    }

    private func applyGatewayLink(
        _ link: GatewayConnectDeepLink,
        disconnectExistingGatewayForBootstrap: Bool = true) async
    {
        self.manualHost = link.host
        self.manualPort = link.port
        self.manualPortText = String(link.port)
        self.manualTLS = link.tls
        let setupAuth = GatewayConnectionController.ManualAuthOverride.setupAuth(from: link)
        self.gatewayCredentialFieldStableID = setupAuth.targetStableID
        if setupAuth.hasBootstrapToken {
            await GatewayOnboardingReset.prepareForBootstrapPairing(
                appModel: self.appModel,
                instanceId: GatewaySettingsStore.currentInstanceID(),
                gatewayStableID: setupAuth.targetStableID,
                disconnectGateway: disconnectExistingGatewayForBootstrap)
        }
        self.gatewayToken = setupAuth.token
        self.gatewayPassword = setupAuth.password
        self.pendingManualAuthOverride = setupAuth.manualAuthOverride
        let instanceId = GatewaySettingsStore.currentInstanceID()
        if !instanceId.isEmpty {
            GatewaySettingsStore.saveGatewayCredentials(
                token: setupAuth.token,
                bootstrapToken: setupAuth.bootstrapToken,
                password: setupAuth.password,
                gatewayStableID: setupAuth.targetStableID,
                suppressStoredDeviceAuth: true,
                instanceId: instanceId)
        }
        if self.selectedMode == nil {
            self.selectedMode = link.tls ? .remoteDomain : .homeNetwork
        }
    }

    private func handleScannedSetupCode(_ code: String) {
        guard AppleReviewDemoMode.isSetupCode(code) else { return }
        self.showQRScanner = false
        self.invalidateSetupAttempt()
        self.connectMessage = "Apple Review demo mode enabled."
        self.statusLine = "Apple Review demo mode enabled."
        self.selectedMode = .homeNetwork
        self.appModel.enterAppleReviewDemoMode()
        self.pendingTargetSuppression.releaseAutoConnect(.qrScanner, controller: self.gatewayController)
    }

    private func openQRScannerFromOnboarding(status: String = "Opening QR scanner…") {
        // Stop active reconnect loops before scanning new credentials.
        self.invalidateSetupAttempt()
        let lease = self.gatewayController.cancelPendingConnectionAttempts(suspendCurrentGateway: true)
        _ = self.setupLinkStaging.cancel()
        self.pendingTargetSuppression.replace(owner: .qrScanner, lease: lease)
        self.scannerScanID = self.scannerResultHandoff.beginScan()
        self.connectingGateway = nil
        self.localConnectionFailure = nil
        self.connectMessage = nil
        self.issue = .none
        self.pairingRequestId = nil
        self.statusLine = status
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
        guard self.connectingGateway == nil else { return }

        let now = Date()
        if let last = lastPairingAutoResumeAttemptAt, now.timeIntervalSince(last) < 6 {
            return
        }
        self.lastPairingAutoResumeAttemptAt = now
        self.resumeAfterPairingApprovalInBackground()
    }

    private func updateConnectionIssue(problem: GatewayConnectionProblem?, statusText: String) {
        let wasOnAuthStep = self.step == .auth
        let next = GatewayConnectionIssue.detect(problem: problem)
        let fallback = next == .none ? GatewayConnectionIssue.detect(from: statusText) : next

        // Avoid "flip-flopping" the UI by clearing actionable issues when the underlying connection
        // transitions through intermediate statuses (e.g. Offline/Connecting while reconnect churns).
        if self.issue.needsPairing, fallback.needsPairing {
            let mergedRequestId = fallback.requestId ?? self.issue.requestId ?? self.pairingRequestId
            self.issue = .pairingRequired(requestId: mergedRequestId)
        } else if self.issue.needsPairing, !fallback.needsPairing {
            // Ignore non-pairing statuses until the user explicitly retries/scans again, or we connect.
        } else if self.issue.needsAuthCredentials, !fallback.needsAuthCredentials, !fallback.needsPairing {
            // Same idea for auth: once we learn credentials are missing/rejected, keep that sticky until
            // the user retries/scans again or we successfully connect.
        } else {
            self.issue = fallback
        }

        if let requestId = problem?.requestId ?? fallback.requestId, !requestId.isEmpty {
            self.pairingRequestId = requestId
        }

        if self.issue.needsAuthCredentials || self.issue.needsPairing || problem?.pauseReconnect == true {
            self.step = .auth
            // Focus only on the transition; repeated status updates must not steal an edited field.
            if !wasOnAuthStep {
                switch self.issue {
                case .passwordMissing:
                    self.focusedField = .gatewayPassword
                case .tokenMissing:
                    self.focusedField = .gatewayToken
                default:
                    break
                }
            }
        }

        if let problem {
            self.connectMessage = problem.localizedMessage
            self.statusLine = problem.localizedMessage
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
        self.statusLine = ""
        self.navigate(to: .permissions)
    }

    private func advanceFromPermissions() {
        // Marked here, not on the intro Continue: an interrupted first run must
        // replay intro + permissions on relaunch instead of skipping them forever.
        OnboardingStateStore.markFirstRunIntroSeen()
        self.requestLocalNetworkAccess(reason: "onboarding_continue")
        self.statusLine = ""
        self.navigate(to: .welcome)
    }

    private func requestLocalNetworkAccessIfPastIntro(reason: String) {
        // The local-network prompt waits until pairing starts so it never stacks
        // on top of the permission prompts users trigger on the permissions step.
        guard self.step != .intro, self.step != .permissions else { return }
        self.requestLocalNetworkAccess(reason: reason)
    }

    private func requestLocalNetworkAccess(reason: String) {
        self.onRequestLocalNetworkAccess(reason)
    }

    private func navigateBack() {
        guard let target = step.previous else { return }
        self.invalidateSetupAttempt()
        self.localConnectionFailure = nil
        self.connectMessage = nil
        self.navigate(to: target)
    }

    private func prepareFocusedFieldForStepTransition() async {
        guard self.focusedField != nil else { return }
        self.dismissKeyboard()
        await Task.yield()
        try? await Task.sleep(nanoseconds: 120_000_000)
    }

    private func dismissKeyboard() {
        self.focusedField = nil
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil,
            from: nil,
            for: nil)
    }

    private func navigate(to target: OnboardingStep) {
        self.focusedField = nil
        self.step = target
    }

    private func beginSetupAttempt() -> UUID? {
        guard self.connectingGateway == nil else { return nil }
        let attemptID = UUID()
        self.setupAttemptID = attemptID
        self.connectingGateway = .setupCode
        return attemptID
    }

    private func finishSetupAttempt(_ attemptID: UUID) {
        guard self.setupAttemptID == attemptID else { return }
        self.invalidateSetupAttempt()
    }

    private func invalidateSetupAttempt() {
        self.setupAttemptID = nil
        self.connectingGateway = nil
    }

    private var canConnectManual: Bool {
        let host = self.manualHost.trimmingCharacters(in: .whitespacesAndNewlines)
        return !host.isEmpty && self.resolvedManualPort(host: host) != nil
    }

    private func initializeState() {
        if self.manualHost.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            if let active = GatewaySettingsStore.activeGatewayEntry(),
               active.kind == .manual,
               let host = active.host,
               let port = active.port
            {
                self.manualHost = host
                self.manualPort = port
                self.manualTLS = active.useTLS
            } else {
                self.manualHost = "openclaw.local"
                self.manualPort = 18789
                self.manualTLS = true
            }
        }
        self.manualPortText = self.manualPort > 0 ? String(self.manualPort) : ""
        if self.selectedMode == nil {
            let lastMode = OnboardingStateStore.lastMode()
            if lastMode == .developerLocal {
                self.developerModeEnabled = true
            }
            if self.developerModeEnabled || lastMode != .developerLocal {
                self.selectedMode = lastMode
            }
        }
        if self.selectedMode == .developerLocal, self.manualHost == "openclaw.local" {
            self.manualHost = "localhost"
            self.manualTLS = false
        }

        let trimmedInstanceId = self.instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedInstanceId.isEmpty,
           let stableID = self.currentManualGatewayStableID
        {
            let credentials = GatewaySettingsStore.loadGatewayCredentials(
                instanceId: trimmedInstanceId,
                gatewayStableID: stableID)
            let ownsFields = credentials.hasCredentials || credentials.suppressStoredDeviceAuth
            self.gatewayCredentialFieldStableID = ownsFields ? stableID : nil
            self.gatewayToken = credentials.token ?? ""
            self.gatewayPassword = credentials.password ?? ""
            self.pendingManualAuthOverride = GatewayConnectionController.ManualAuthOverride.persisted(
                instanceId: trimmedInstanceId,
                targetStableID: stableID)
        }

        let hasSavedGateway = GatewaySettingsStore.activeGatewayEntry() != nil
        let hasToken = !self.gatewayToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let hasPassword = !self.gatewayPassword.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if !hasSavedGateway, !hasToken, !hasPassword {
            self.statusLine = ""
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

    private var currentManualGatewayStableID: String? {
        let host = self.manualHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty, let port = self.resolvedManualPort(host: host) else { return nil }
        return GatewayConnectionController.ManualAuthOverride.manualStableID(
            host: host,
            port: port)
    }

    private var gatewayCredentialTargetStableID: String? {
        // Auth fields follow the selected route. Otherwise a discovered-gateway retry can save
        // credentials under the unrelated manual endpoint and immediately reload an empty bundle.
        self.gatewayCredentialFieldStableID ?? self.currentManualGatewayStableID
    }

    private func resolvedManualPort(host: String) -> Int? {
        guard self.manualPortText.isEmpty || self.manualPort > 0 else { return nil }
        return GatewayConnectionController.resolvedManualPort(
            host: host,
            port: self.manualPort)
    }

    private var gatewayTokenBinding: Binding<String> {
        Binding(
            get: { self.gatewayToken },
            set: { self.persistGatewayToken($0) })
    }

    private var gatewayPasswordBinding: Binding<String> {
        Binding(
            get: { self.gatewayPassword },
            set: { self.persistGatewayPassword($0) })
    }

    private var manualHostBinding: Binding<String> {
        Binding(
            get: { self.manualHost },
            set: { value in
                let previousStableID = self.currentManualGatewayStableID
                self.manualHost = value
                if GatewayStableIdentifier.key(previousStableID) !=
                    GatewayStableIdentifier.key(self.currentManualGatewayStableID)
                {
                    self.clearManualCredentialFields()
                }
            })
    }

    private var manualPortTextBinding: Binding<String> {
        Binding(
            get: { self.manualPortText },
            set: { value in
                let previousStableID = self.currentManualGatewayStableID
                let digits = value.filter(\.isNumber)
                self.manualPortText = digits
                self.manualPort = min(Int(digits) ?? 0, 65535)
                if GatewayStableIdentifier.key(previousStableID) !=
                    GatewayStableIdentifier.key(self.currentManualGatewayStableID)
                {
                    self.clearManualCredentialFields()
                }
            })
    }

    private func persistGatewayToken(_ value: String) {
        self.gatewayToken = value
        let instanceId = GatewaySettingsStore.currentInstanceID()
        guard !instanceId.isEmpty, let stableID = self.gatewayCredentialTargetStableID else { return }
        self.gatewayCredentialFieldStableID = stableID
        let saved = GatewaySettingsStore.updateGatewayCredentials(
            token: value,
            password: self.gatewayPassword,
            gatewayStableID: stableID,
            instanceId: instanceId)
        self.pendingManualAuthOverride = saved
            ? GatewayConnectionController.ManualAuthOverride.persisted(
                instanceId: instanceId,
                targetStableID: stableID)
            : nil
    }

    private func persistGatewayPassword(_ value: String) {
        self.gatewayPassword = value
        let instanceId = GatewaySettingsStore.currentInstanceID()
        guard !instanceId.isEmpty, let stableID = self.gatewayCredentialTargetStableID else { return }
        self.gatewayCredentialFieldStableID = stableID
        let saved = GatewaySettingsStore.updateGatewayCredentials(
            token: self.gatewayToken,
            password: value,
            gatewayStableID: stableID,
            instanceId: instanceId)
        self.pendingManualAuthOverride = saved
            ? GatewayConnectionController.ManualAuthOverride.persisted(
                instanceId: instanceId,
                targetStableID: stableID)
            : nil
    }

    private func clearManualCredentialFields() {
        self.gatewayToken = ""
        self.gatewayPassword = ""
        self.gatewayCredentialFieldStableID = nil
        self.pendingManualAuthOverride = nil
    }

    private func selectGatewayCredentialTarget(_ stableID: String, allowManualOverride: Bool) {
        let instanceId = GatewaySettingsStore.currentInstanceID()
        if !GatewayStableIdentifier.matches(self.gatewayCredentialFieldStableID, stableID) {
            let credentials = GatewaySettingsStore.loadGatewayCredentials(
                instanceId: instanceId,
                gatewayStableID: stableID)
            self.gatewayCredentialFieldStableID = stableID
            self.gatewayToken = credentials.token ?? ""
            self.gatewayPassword = credentials.password ?? ""
        }
        guard allowManualOverride else {
            self.pendingManualAuthOverride = nil
            return
        }
        // Each attempt consumes the in-memory override. Reload durable bootstrap auth even
        // when the endpoint fields did not change so retry never erases a one-time token.
        self.pendingManualAuthOverride = GatewayConnectionController.ManualAuthOverride.persisted(
            instanceId: instanceId,
            targetStableID: stableID)
    }

    private func connectDiscoveredGateway(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) async {
        self.selectGatewayCredentialTarget(gateway.stableID, allowManualOverride: false)
        self.connectingGateway = .gateway(gateway.id)
        self.localConnectionFailure = nil
        self.issue = .none
        self.connectMessage = "Connecting to \(gateway.name)…"
        self.statusLine = "Connecting to \(gateway.name)…"
        defer { self.connectingGateway = nil }
        if let message = await self.gatewayController.connectWithDiagnostics(gateway) {
            self.setConnectionFailure(message)
        }
    }

    private func selectMode(_ mode: OnboardingConnectionMode) {
        self.selectedMode = mode
        self.applyModeDefaults(mode)
    }

    private func applyModeDefaults(_ mode: OnboardingConnectionMode) {
        let previousStableID = self.currentManualGatewayStableID
        defer {
            if GatewayStableIdentifier.key(previousStableID) !=
                GatewayStableIdentifier.key(self.currentManualGatewayStableID)
            {
                self.clearManualCredentialFields()
            }
        }
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

    private func connectManual(setupAttemptID: UUID? = nil) async {
        if let setupAttemptID {
            guard self.setupAttemptID == setupAttemptID else { return }
        } else {
            self.invalidateSetupAttempt()
        }
        let host = self.manualHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty, let port = self.resolvedManualPort(host: host) else { return }
        self.connectingGateway = .manual
        self.localConnectionFailure = nil
        self.issue = .none
        self.connectMessage = "Connecting to \(host)…"
        self.statusLine = "Connecting to \(host):\(port)…"
        defer { self.connectingGateway = nil }
        await self.connectCurrentManualGateway(host: host, port: port, forceReconnect: false)
    }

    private func connectCurrentManualGateway(host: String, port: Int, forceReconnect: Bool) async {
        let stableID = GatewayConnectionController.ManualAuthOverride.manualStableID(
            host: host,
            port: port)
        self.selectGatewayCredentialTarget(stableID, allowManualOverride: true)
        if GatewayStableIdentifier.matches(
            self.appModel.activeGatewayConnectConfig?.effectiveStableID,
            stableID),
            self.appModel.activeGatewayConnectConfig?.nodeOptions.allowStoredDeviceAuth == true
        {
            self.pendingManualAuthOverride = nil
        }
        let fieldsMatchTarget = GatewayStableIdentifier.matches(
            self.gatewayCredentialFieldStableID,
            stableID)
        let pendingOverride = GatewayStableIdentifier.matches(
            self.pendingManualAuthOverride?.targetStableID,
            stableID)
            ? self.pendingManualAuthOverride
            : nil
        let authOverride = GatewayConnectionController.ManualAuthOverride.currentManualInput(
            token: fieldsMatchTarget ? self.gatewayToken : nil,
            pendingOverride: pendingOverride,
            password: fieldsMatchTarget ? self.gatewayPassword : nil,
            targetStableID: stableID)
        let instanceId = GatewaySettingsStore.currentInstanceID()
        if !instanceId.isEmpty, fieldsMatchTarget || pendingOverride != nil {
            GatewaySettingsStore.saveGatewayCredentials(
                token: authOverride?.token,
                bootstrapToken: authOverride?.bootstrapToken,
                password: authOverride?.password,
                gatewayStableID: stableID,
                suppressStoredDeviceAuth: authOverride?.suppressStoredDeviceAuth == true,
                instanceId: instanceId)
        }
        await self.gatewayController.connectManual(
            host: host,
            port: port,
            useTLS: self.manualTLS,
            authOverride: authOverride,
            forceReconnect: forceReconnect)
        // The controller now owns this attempt's immutable override. A later retry must reload
        // durable state so a spent bootstrap token cannot be resurrected from the live view.
        self.pendingManualAuthOverride = nil
    }

    private func retryLastAttempt(silent: Bool = false) async {
        self.connectingGateway = silent ? .retryAutomatically : .retry
        self.localConnectionFailure = nil
        // Keep current auth/pairing issue sticky while retrying to avoid Step 3 UI flip-flop.
        if !silent {
            self.connectMessage = "Retrying…"
            self.statusLine = "Retrying last connection…"
        }
        defer { self.connectingGateway = nil }

        switch GatewaySettingsStore.activeGatewayEntry()?.kind {
        case .discovered:
            await self.gatewayController.connectActiveGateway()
        case .manual, .none:
            // connectActiveGateway() replays the persisted endpoint and credentials,
            // so token/host/port edits made on this screen would be ignored and
            // a missing stored connection would silently do nothing. Manual
            // retries must dial the current form input instead.
            let host = self.manualHost.trimmingCharacters(in: .whitespacesAndNewlines)
            if !host.isEmpty, let port = self.resolvedManualPort(host: host) {
                await self.connectCurrentManualGateway(host: host, port: port, forceReconnect: true)
                return
            }
            if !silent {
                self.setConnectionFailure("No connection to retry. Check the gateway host and port.")
            }
        }
    }

    private func gatewayProblemPrimaryActionTitle(_ problem: GatewayConnectionProblem) -> String? {
        GatewayProblemPrimaryAction.title(
            for: problem,
            retryTitle: "Retry connection",
            resetTitle: "Scan QR again")
    }

    private func handleGatewayProblemPrimaryAction(_ problem: GatewayConnectionProblem) async {
        if problem.suggestsOnboardingReset {
            await GatewayOnboardingReset.reset(appModel: self.appModel, instanceId: self.instanceId)
            self.gatewayToken = ""
            self.gatewayPassword = ""
            self.gatewayCredentialFieldStableID = nil
            self.pendingManualAuthOverride = nil
            self.connectingGateway = nil
            self.connectMessage = nil
            self.issue = .none
            self.pairingRequestId = nil
            self.navigate(to: .connect)
            self.openQRScannerFromOnboarding(status: "Scan a fresh setup QR code from this gateway.")
            return
        }
        if problem.canTrustRotatedCertificate {
            self.connectingGateway = .trustCertificate
            self.connectMessage = "Updating gateway certificate…"
            self.statusLine = "Updating gateway certificate…"
            defer { self.connectingGateway = nil }
            _ = await self.gatewayController.trustRotatedGatewayCertificate(from: problem)
            return
        }
        if GatewayProblemPrimaryAction.handleProtocolMismatchIfNeeded(problem) {
            return
        }
        guard problem.retryable else { return }
        await self.retryLastAttempt()
    }
}
