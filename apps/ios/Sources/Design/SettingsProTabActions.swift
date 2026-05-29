import OpenClawKit
import SwiftUI
import UIKit
import UserNotifications

extension SettingsProTab {
    func detailStatusCard(
        icon: String,
        title: String,
        detail: String,
        value: String,
        color: Color) -> some View
    {
        ProCard(radius: SettingsLayout.cardRadius) {
            HStack(spacing: 12) {
                ProIconBadge(systemName: icon, color: color)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.headline)
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                ProValuePill(value: value, color: color)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    var diagnosticChecksCard: some View {
        ProCard(padding: 0, radius: SettingsLayout.cardRadius) {
            VStack(spacing: 0) {
                self.diagnosticCheckRow(
                    icon: "stethoscope",
                    title: "Last Run",
                    detail: self.diagnosticsLastRunText,
                    value: self.diagnosticsRunValue,
                    color: self.diagnosticsRunColor)
                Divider().padding(.leading, 60)
                self.diagnosticCheckRow(
                    icon: "antenna.radiowaves.left.and.right",
                    title: "Gateway Link",
                    detail: self.appModel.gatewayDisplayStatusText,
                    value: self.gatewayConnected ? "online" : "offline",
                    color: self.gatewayConnected ? OpenClawBrand.ok : .secondary)
                Divider().padding(.leading, 60)
                self.diagnosticCheckRow(
                    icon: "dot.radiowaves.left.and.right",
                    title: "Discovery",
                    detail: self.gatewayController.discoveryStatusText,
                    value: "\(self.gatewayController.gateways.count)",
                    color: self.gatewayController.gateways.isEmpty ? .secondary : OpenClawBrand.accent)
                Divider().padding(.leading, 60)
                self.diagnosticCheckRow(
                    icon: "waveform",
                    title: "Talk Config",
                    detail: self.appModel.talkMode.gatewayTalkTransportLabel,
                    value: self.appModel.talkMode.gatewayTalkConfigLoaded ? "loaded" : "missing",
                    color: self.appModel.talkMode.gatewayTalkConfigLoaded ? OpenClawBrand.ok : .secondary)
                Divider().padding(.leading, 60)
                self.diagnosticCheckRow(
                    icon: "bell",
                    title: "Notifications",
                    detail: "Approval and event alert channel",
                    value: self.notificationStatusText,
                    color: self.notificationStatusText == "Allowed" ? OpenClawBrand.ok : .secondary)
                Divider().padding(.leading, 60)
                self.diagnosticCheckRow(
                    icon: "rectangle.on.rectangle",
                    title: "Screen Capture",
                    detail: "Live foreground capture state",
                    value: self.appModel.screenRecordActive ? "live" : "idle",
                    color: self.appModel.screenRecordActive ? OpenClawBrand.ok : .secondary)
                Divider().padding(.leading, 60)
                self.diagnosticCheckRow(
                    icon: "mic",
                    title: "Voice Wake",
                    detail: self.appModel.voiceWake.statusText,
                    value: self.voiceWakeEnabled ? "on" : "off",
                    color: self.voiceWakeEnabled ? OpenClawBrand.ok : .secondary)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    func diagnosticCheckRow(
        icon: String,
        title: String,
        detail: String,
        value: String,
        color: Color) -> some View
    {
        HStack(spacing: 12) {
            ProIconBadge(systemName: icon, color: color)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            ProValuePill(value: value, color: color)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    func detailListCard(@ViewBuilder content: () -> some View) -> some View {
        ProCard(padding: 0, radius: SettingsLayout.cardRadius) {
            VStack(spacing: 0, content: content)
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    func detailRow(_ label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Text(value)
                .font(.caption)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.horizontal, 14)
        .frame(height: 42)
    }

    func reconnectGateway() async {
        guard !self.isReconnectingGateway else { return }
        self.isReconnectingGateway = true
        defer { self.isReconnectingGateway = false }
        await self.gatewayController.connectLastKnown()
    }

    func refreshGateway() async {
        guard !self.isRefreshingGateway else { return }
        self.isRefreshingGateway = true
        defer { self.isRefreshingGateway = false }
        self.gatewayController.refreshActiveGatewayRegistrationFromSettings()
        self.gatewayController.restartDiscovery()
        await self.appModel.refreshGatewayOverviewIfConnected()
    }

    @MainActor
    func runDiagnostics() async {
        guard !self.isRefreshingGateway else { return }
        self.isRefreshingGateway = true
        defer { self.isRefreshingGateway = false }

        self.gatewayController.refreshActiveGatewayRegistrationFromSettings()
        self.gatewayController.restartDiscovery()
        await self.appModel.refreshGatewayOverviewIfConnected()
        let notificationSettings = await UNUserNotificationCenter.current().notificationSettings()
        self.applyNotificationStatus(notificationSettings.authorizationStatus)

        let issueCount = SettingsDiagnostics.issueCount(
            gatewayConnected: self.gatewayConnected,
            discoveredGatewayCount: self.gatewayController.gateways.count,
            talkConfigLoaded: self.appModel.talkMode.gatewayTalkConfigLoaded,
            notificationStatusText: self.notificationStatusText)
        self.diagnosticsIssueCount = issueCount
        self.diagnosticsLastRunText = SettingsDiagnostics.timestamp(Date())
    }

    func syncSettingsState() {
        self.manualGatewayPortText = self.manualGatewayPort > 0 ? String(self.manualGatewayPort) : ""
        self.selectedAgentPickerId = self.appModel.selectedAgentId ?? ""
        self.defaultShareInstruction = ShareToAgentSettings.loadDefaultInstruction()
        let trimmedInstanceId = self.instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedInstanceId.isEmpty else { return }
        self.gatewayToken = GatewaySettingsStore.loadGatewayToken(instanceId: trimmedInstanceId) ?? ""
        self.gatewayPassword = GatewaySettingsStore.loadGatewayPassword(instanceId: trimmedInstanceId) ?? ""
    }

    func connect(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) async {
        self.connectingGatewayID = gateway.id
        defer { self.connectingGatewayID = nil }
        self.manualGatewayEnabled = false
        GatewaySettingsStore.savePreferredGatewayStableID(gateway.stableID)
        GatewaySettingsStore.saveLastDiscoveredGatewayStableID(gateway.stableID)
        if let err = await self.gatewayController.connectWithDiagnostics(gateway) {
            self.setupStatusText = err
        }
    }

    func applySetupCodeAndConnect() async {
        self.setupStatusText = nil
        guard self.applySetupCode() else { return }
        let host = self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let port = self.resolvedManualPort(host: host) else {
            self.setupStatusText = "Failed: invalid port"
            return
        }
        guard await self.preflightGateway(host: host, port: port, useTLS: self.manualGatewayTLS) else { return }
        self.setupStatusText = "Setup code applied. Connecting..."
        await self.connectManual()
    }

    @discardableResult
    func applySetupCode() -> Bool {
        let raw = self.setupCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else {
            self.setupStatusText = "Paste a setup code to continue."
            return false
        }
        guard let link = GatewayConnectDeepLink.fromSetupInput(raw) else {
            self.setupStatusText = "Setup code not recognized or uses an insecure ws:// gateway URL."
            return false
        }
        self.applyGatewayLink(link)
        return true
    }

    func applyGatewayLink(_ link: GatewayConnectDeepLink) {
        self.manualGatewayHost = link.host
        self.manualGatewayPort = link.port
        self.manualGatewayPortText = String(link.port)
        self.manualGatewayTLS = link.tls
        let instanceId = GatewaySettingsStore.currentInstanceID()
        let setupAuth = GatewayConnectionController.ManualAuthOverride.setupAuth(from: link)
        if setupAuth.hasBootstrapToken {
            GatewayOnboardingReset.prepareForBootstrapPairing(appModel: self.appModel, instanceId: instanceId)
        }
        if !instanceId.isEmpty {
            GatewaySettingsStore.saveGatewayBootstrapToken(setupAuth.bootstrapToken, instanceId: instanceId)
        }
        if setupAuth.shouldApplyTokenField {
            self.gatewayToken = setupAuth.token
            if !instanceId.isEmpty {
                GatewaySettingsStore.saveGatewayToken(setupAuth.token, instanceId: instanceId)
            }
        }
        if setupAuth.shouldApplyPasswordField {
            self.gatewayPassword = setupAuth.password
            if !instanceId.isEmpty {
                GatewaySettingsStore.saveGatewayPassword(setupAuth.password, instanceId: instanceId)
            }
        }
        self.pendingManualAuthOverride = setupAuth.manualAuthOverride
    }

    func openGatewayQRScanner() {
        self.appModel.disconnectGateway()
        self.connectingGatewayID = nil
        self.setupStatusText = "Opening QR scanner..."
        self.showQRScanner = true
    }

    func handleScannedGatewayLink(_ link: GatewayConnectDeepLink) {
        self.showQRScanner = false
        self.setupCode = ""
        self.applyGatewayLink(link)
        self.setupStatusText = "QR loaded. Connecting to \(link.host):\(link.port)..."
        Task { await self.connectAfterScannedGatewayLink() }
    }

    func connectAfterScannedGatewayLink() async {
        let host = self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let port = self.resolvedManualPort(host: host) else {
            self.setupStatusText = "Failed: invalid port"
            return
        }
        guard await self.preflightGateway(host: host, port: port, useTLS: self.manualGatewayTLS) else { return }
        await self.connectManual()
    }

    func connectManual() async {
        let host = self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty else {
            self.setupStatusText = "Failed: host required"
            return
        }
        guard self.manualPortIsValid else {
            self.setupStatusText = "Failed: invalid port"
            return
        }
        self.connectingGatewayID = "manual"
        self.manualGatewayEnabled = true
        defer { self.connectingGatewayID = nil }
        let authOverride = GatewayConnectionController.ManualAuthOverride.currentManualInput(
            token: self.gatewayToken,
            pendingOverride: self.pendingManualAuthOverride,
            password: self.gatewayPassword)
        self.pendingManualAuthOverride = nil
        await self.gatewayController.connectManual(
            host: host,
            port: self.manualGatewayPort,
            useTLS: self.manualGatewayTLS,
            authOverride: authOverride)
    }

    func preflightGateway(host: String, port: Int, useTLS: Bool) async -> Bool {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        if Self.isTailnetHostOrIP(trimmed), !Self.hasTailnetIPv4() {
            self.setupStatusText = "Tailscale is off on this iPhone. Turn it on, then try again."
            return false
        }
        self.setupStatusText = "Checking gateway reachability..."
        let ok = await TCPProbe.probe(host: trimmed, port: port, timeoutSeconds: 3, queueLabel: "gateway.preflight")
        if !ok {
            self.setupStatusText = "Can't reach gateway at \(trimmed):\(port). Check Tailscale or LAN."
        }
        return ok
    }

    func resetOnboarding() {
        self.connectingGatewayID = nil
        self.setupStatusText = nil
        self.setupCode = ""
        self.gatewayAutoConnect = false
        self.suppressCredentialPersist = true
        defer { self.suppressCredentialPersist = false }
        self.gatewayToken = ""
        self.gatewayPassword = ""
        GatewayOnboardingReset.reset(appModel: self.appModel, instanceId: self.instanceId)
        self.onboardingComplete = false
        self.hasConnectedOnce = false
        self.manualGatewayEnabled = false
        self.manualGatewayHost = ""
        self.onboardingRequestID += 1
    }

    func retryGatewayConnectionFromProblem() async {
        if self.manualGatewayEnabled || self.connectingGatewayID == "manual" {
            await self.connectManual()
        } else {
            await self.gatewayController.connectLastKnown()
        }
    }

    func gatewayProblemPrimaryActionTitle(_ problem: GatewayConnectionProblem) -> String {
        if problem.suggestsOnboardingReset { return "Reset onboarding" }
        return problem.canTrustRotatedCertificate ? "Trust certificate" : "Retry connection"
    }

    func handleGatewayProblemPrimaryAction(_ problem: GatewayConnectionProblem) async {
        if problem.suggestsOnboardingReset {
            self.resetOnboarding()
            return
        }
        if problem.canTrustRotatedCertificate {
            _ = await self.gatewayController.trustRotatedGatewayCertificate(from: problem)
            return
        }
        await self.retryGatewayConnectionFromProblem()
    }

    func handleLocationModeChange(_ newValue: String) {
        guard !self.isChangingLocationMode else { return }
        guard newValue != self.previousLocationModeRaw else { return }
        guard let mode = OpenClawLocationMode(rawValue: newValue) else { return }
        let previous = self.previousLocationModeRaw
        Task {
            await self.applyLocationMode(mode, rawValue: newValue, previous: previous)
        }
    }

    @MainActor
    func applyLocationMode(
        _ mode: OpenClawLocationMode,
        rawValue: String,
        previous: String) async
    {
        self.isChangingLocationMode = true
        self.locationStatusText = nil
        defer { self.isChangingLocationMode = false }

        if mode == .off {
            self.previousLocationModeRaw = rawValue
            self.gatewayController.refreshActiveGatewayRegistrationFromSettings()
            return
        }

        let granted = await self.appModel.requestLocationPermissions(mode: mode)
        if granted {
            self.previousLocationModeRaw = rawValue
            self.gatewayController.refreshActiveGatewayRegistrationFromSettings()
        } else {
            self.locationModeRaw = previous
            self.previousLocationModeRaw = previous
            self.locationStatusText = "Location permission was not granted."
        }
    }

    func refreshNotificationSettings() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let status = settings.authorizationStatus
            Task { @MainActor in
                self.applyNotificationStatus(status)
            }
        }
    }

    func handleNotificationAction() {
        if self.notificationStatusText == "Allowed" || self.notificationStatusText == "Not Allowed" {
            self.openSystemSettings()
            return
        }

        Task {
            let granted = await (try? UNUserNotificationCenter.current().requestAuthorization(options: [
                .alert,
                .badge,
                .sound,
            ])) ?? false
            await MainActor.run {
                self.notificationStatusText = granted ? "Allowed" : "Not Allowed"
                self.notificationActionText = granted ? "Open System Settings" : "Open System Settings"
            }
        }
    }

    @MainActor
    func applyNotificationStatus(_ status: UNAuthorizationStatus) {
        switch status {
        case .authorized, .provisional, .ephemeral:
            self.notificationStatusText = "Allowed"
            self.notificationActionText = "Open System Settings"
        case .denied:
            self.notificationStatusText = "Not Allowed"
            self.notificationActionText = "Open System Settings"
        case .notDetermined:
            self.notificationStatusText = "Not Set"
            self.notificationActionText = "Request Access"
        @unknown default:
            self.notificationStatusText = "Unknown"
            self.notificationActionText = "Open System Settings"
        }
    }

    func persistGatewayToken(_ value: String) {
        guard !self.suppressCredentialPersist else { return }
        let instanceId = self.instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !instanceId.isEmpty else { return }
        GatewaySettingsStore.saveGatewayToken(
            value.trimmingCharacters(in: .whitespacesAndNewlines),
            instanceId: instanceId)
    }

    func persistGatewayPassword(_ value: String) {
        guard !self.suppressCredentialPersist else { return }
        let instanceId = self.instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !instanceId.isEmpty else { return }
        GatewaySettingsStore.saveGatewayPassword(
            value.trimmingCharacters(in: .whitespacesAndNewlines),
            instanceId: instanceId)
    }

    func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    func title(for route: SettingsRoute) -> String {
        switch route {
        case .gateway: "Gateway"
        case .permissions: "Permissions"
        case .voice: "Voice & Talk"
        case .diagnostics: "Diagnostics"
        case .privacy: "Privacy"
        case .notifications: "Notifications"
        case .about: "About"
        }
    }

    var manualPortBinding: Binding<String> {
        Binding(
            get: { self.manualGatewayPortText },
            set: { newValue in
                let filtered = newValue.filter(\.isNumber)
                self.manualGatewayPortText = filtered
                self.manualGatewayPort = Int(filtered) ?? 0
            })
    }

    var manualPortIsValid: Bool {
        if self.manualGatewayPortText.isEmpty { return true }
        return self.manualGatewayPort >= 1 && self.manualGatewayPort <= 65535
    }

    func resolvedManualPort(host: String) -> Int? {
        if self.manualGatewayPort > 0 {
            return self.manualGatewayPort <= 65535 ? self.manualGatewayPort : nil
        }
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if self.manualGatewayTLS, trimmed.lowercased().hasSuffix(".ts.net") {
            return 443
        }
        return 18789
    }

    var setupStatusLine: String? {
        if let problem = self.appModel.lastGatewayProblem {
            return problem.message
        }
        let trimmedSetup = self.setupStatusText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let gatewayStatus = self.appModel.gatewayStatusText.trimmingCharacters(in: .whitespacesAndNewlines)
        if let friendly = self.friendlyGatewayMessage(from: gatewayStatus) { return friendly }
        if let friendly = self.friendlyGatewayMessage(from: trimmedSetup) { return friendly }
        if !trimmedSetup.isEmpty { return trimmedSetup }
        if gatewayStatus.isEmpty || gatewayStatus == "Offline" { return nil }
        return gatewayStatus
    }

    var tailnetWarningText: String? {
        let host = self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty, Self.isTailnetHostOrIP(host), !Self.hasTailnetIPv4() else { return nil }
        return "This gateway is on your tailnet. Turn on Tailscale on this iPhone, then tap Connect."
    }

    func friendlyGatewayMessage(from raw: String) -> String? {
        let lower = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if lower.contains("pairing required") {
            return "Pairing required. Run /pair approve in your OpenClaw chat, then connect again."
        }
        if lower.contains("device nonce required") || lower.contains("device nonce mismatch") {
            return "Secure handshake failed. Check Tailscale, then connect again."
        }
        if lower.contains("timed out") {
            return "Connection timed out. Make sure Tailscale is connected, then try again."
        }
        if lower.contains("unauthorized role") {
            return "Connected, but some controls are restricted for nodes. This is expected."
        }
        return nil
    }

    var shouldShowRealtimeVoicePicker: Bool {
        let providerSelection = TalkModeProviderSelection.resolved(self.talkProviderSelectionRaw)
        return providerSelection == .openAIRealtime || self.appModel.talkMode.gatewayTalkUsesRealtime
    }

    var talkProviderSelectionBinding: Binding<String> {
        Binding(
            get: { self.talkProviderSelectionRaw },
            set: { newValue in
                let selection = TalkModeProviderSelection.resolved(newValue)
                self.talkProviderSelectionRaw = selection.rawValue
                self.appModel.setTalkProviderSelection(selection.rawValue)
            })
    }

    var talkRealtimeVoiceSelectionBinding: Binding<String> {
        Binding(
            get: { self.talkRealtimeVoiceSelectionRaw },
            set: { newValue in
                let voice = TalkModeRealtimeVoiceSelection.resolvedOverride(newValue) ?? ""
                self.talkRealtimeVoiceSelectionRaw = voice
                self.appModel.setTalkRealtimeVoiceSelection(voice)
            })
    }

    var talkSpeakerphoneBinding: Binding<Bool> {
        Binding(
            get: { self.talkSpeakerphoneEnabled },
            set: { newValue in
                self.talkSpeakerphoneEnabled = newValue
                self.appModel.setTalkSpeakerphoneEnabled(newValue)
            })
    }

    var talkApiKeyStatus: String {
        guard self.appModel.talkMode.gatewayTalkConfigLoaded else { return "Not loaded" }
        return self.appModel.talkMode.gatewayTalkApiKeyConfigured ? "Configured" : "Not configured"
    }

    func gatewayDetailLines(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) -> [String] {
        var lines: [String] = []
        if let lanHost = gateway.lanHost { lines.append("LAN: \(lanHost)") }
        if let tailnet = gateway.tailnetDns { lines.append("Tailnet: \(tailnet)") }
        let gw = gateway.gatewayPort.map(String.init)
        let canvas = gateway.canvasPort.map(String.init)
        if gw != nil || canvas != nil {
            lines.append("Ports: gateway \(gw ?? "-") / canvas \(canvas ?? "-")")
        }
        return lines.isEmpty ? [gateway.debugID] : lines
    }

    var gatewayConnected: Bool {
        GatewayStatusBuilder.build(appModel: self.appModel) == .connected
    }

    var gatewayAddress: String {
        self.appModel.gatewayRemoteAddress ?? "Waiting for gateway"
    }

    var gatewayServer: String {
        self.appModel.gatewayServerName ?? "OpenClaw Gateway"
    }

    var permissionsDetail: String {
        var enabled = 0
        if self.cameraEnabled { enabled += 1 }
        if self.locationModeRaw != OpenClawLocationMode.off.rawValue { enabled += 1 }
        if self.preventSleep { enabled += 1 }
        return "\(enabled) enabled"
    }

    var voiceDetail: String {
        if self.talkEnabled, self.voiceWakeEnabled { return "Talk + Wake" }
        if self.talkEnabled { return "Talk on" }
        if self.voiceWakeEnabled { return "Wake on" }
        return "Off"
    }

    var diagnosticsDetail: String {
        "System checks"
    }

    var diagnosticsHealthValue: String {
        if self.gatewayConnected { return "ready" }
        if self.gatewayController.gateways.isEmpty { return "check" }
        return "partial"
    }

    var diagnosticsRunValue: String {
        guard let diagnosticsIssueCount else { return "pending" }
        return diagnosticsIssueCount == 0 ? "pass" : "\(diagnosticsIssueCount)"
    }

    var diagnosticsRunColor: Color {
        guard let diagnosticsIssueCount else { return .secondary }
        return diagnosticsIssueCount == 0 ? OpenClawBrand.ok : OpenClawBrand.warn
    }

    var privacyDetail: String {
        let location = OpenClawLocationMode(rawValue: self.locationModeRaw) ?? .off
        return location == .off ? "Location off" : "Location \(self.locationLabel)"
    }

    var locationLabel: String {
        switch OpenClawLocationMode(rawValue: self.locationModeRaw) ?? .off {
        case .off: "Off"
        case .whileUsing: "While Using"
        case .always: "Always"
        }
    }
}
