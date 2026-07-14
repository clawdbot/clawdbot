import CoreLocation
import OpenClawKit
import SwiftUI
import UIKit
import UserNotifications

extension SettingsProTab {
    func detailStatusCard(
        icon: String,
        title: OpenClawTextValue,
        detail: OpenClawTextValue,
        value: OpenClawTextValue,
        color: Color,
        actionTitle: LocalizedStringKey? = nil,
        actionSystemImage: String = "arrow.right",
        action: (() -> Void)? = nil) -> some View
    {
        Section {
            HStack(spacing: 12) {
                SettingsIcon(systemName: icon, color: color)
                VStack(alignment: .leading, spacing: 2) {
                    title.text
                        .font(OpenClawType.headline)
                    detail.text
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                value.text
                    .font(OpenClawType.subheadMedium)
                    .foregroundStyle(color)
            }
            if let action, let actionTitle {
                Button(action: action) {
                    Label(actionTitle, systemImage: actionSystemImage)
                        .font(OpenClawType.subheadSemiBold)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(OpenClawBrand.accent)
            }
        }
    }

    var diagnosticChecksCard: some View {
        Section("Checks") {
            self.diagnosticCheckRow(
                icon: "stethoscope",
                title: "Last Run",
                detail: .verbatim(self.diagnosticsLastRunText),
                value: .verbatim(self.diagnosticsRunValue),
                color: self.diagnosticsRunColor)
            self.diagnosticCheckRow(
                icon: "antenna.radiowaves.left.and.right",
                title: "Gateway Link",
                detail: .verbatim(self.gatewayStatusDetail),
                value: .verbatim(self.gatewayStatusValue),
                color: self.gatewayStatusColor)
            self.diagnosticCheckRow(
                icon: "dot.radiowaves.left.and.right",
                title: "Discovery",
                detail: .verbatim(self.gatewayController.discoveryStatusText),
                value: .verbatim(self.gatewayController.gateways.count.formatted()),
                color: self.gatewayController.gateways.isEmpty ? .secondary : OpenClawBrand.accent)
            self.diagnosticCheckRow(
                icon: "waveform",
                title: "Talk Config",
                detail: .verbatim(self.gatewayTalkConfigDetail),
                value: .verbatim(self.gatewayTalkConfigValue),
                color: self.gatewayTalkConfigColor)
            self.diagnosticCheckRow(
                icon: "bell",
                title: "Notifications",
                detail: "Approval and event alert channel",
                value: .verbatim(self.notificationStatusText),
                color: self.notificationStatusColor)
            self.diagnosticCheckRow(
                icon: "rectangle.on.rectangle",
                title: "Screen Capture",
                detail: "Live foreground capture state",
                value: .verbatim(self.appModel.screenRecordActive
                    ? String(localized: "live")
                    : String(localized: "idle")),
                color: self.appModel.screenRecordActive ? OpenClawBrand.ok : .secondary)
            self.diagnosticCheckRow(
                icon: "mic",
                title: "Voice Wake",
                detail: .verbatim(self.appModel.voiceWake.statusText),
                value: .verbatim(self.voiceWakeEnabled
                    ? String(localized: "on")
                    : String(localized: "off")),
                color: self.voiceWakeEnabled ? OpenClawBrand.ok : .secondary)
        }
    }

    func diagnosticCheckRow(
        icon: String,
        title: OpenClawTextValue,
        detail: OpenClawTextValue,
        value: OpenClawTextValue,
        color: Color) -> some View
    {
        HStack(spacing: 12) {
            SettingsIcon(systemName: icon, color: color)
            VStack(alignment: .leading, spacing: 2) {
                title.text
                    .font(OpenClawType.subheadSemiBold)
                detail.text
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            value.text
                .font(OpenClawType.subhead)
                .foregroundStyle(.secondary)
        }
    }

    func detailListCard(@ViewBuilder content: () -> some View) -> some View {
        Section {
            content()
        }
    }

    func reconnectGateway() async {
        guard !self.appModel.isAppleReviewDemoModeEnabled else { return }
        guard !self.isReconnectingGateway else { return }
        self.isReconnectingGateway = true
        defer { self.isReconnectingGateway = false }
        await self.gatewayController.connectActiveGateway()
    }

    func switchGateway(to entry: GatewaySettingsStore.GatewayRegistryEntry) async {
        guard self.connectingGateway == nil else { return }
        self.connectingGateway = .gateway(entry.id)
        self.setupStatusText = String(
            format: String(localized: "Switching to %@…"),
            entry.name)
        defer {
            self.connectingGateway = nil
            self.refreshGatewayRegistry()
        }
        if let failure = await self.gatewayController.switchToGateway(stableID: entry.stableID) {
            self.setupStatusText = failure
            return
        }
        self.selectGatewayCredentialTarget(entry.stableID, allowManualOverride: false)
    }

    func forgetPendingGateway() {
        guard let entry = self.pendingForgetGateway else { return }
        self.pendingForgetGateway = nil
        guard self.gatewayController.forgetGateway(stableID: entry.stableID) else {
            self.setupStatusText = String(
                format: String(localized: "Could not forget %@."),
                entry.name)
            self.refreshGatewayRegistry()
            return
        }
        if GatewayStableIdentifier.matches(self.gatewayCredentialFieldStableID, entry.stableID) {
            self.clearManualCredentialFields()
        }
        self.setupStatusText = String(
            format: String(localized: "Forgot %@."),
            entry.name)
        self.refreshGatewayRegistry()
    }

    func refreshGatewayRegistry() {
        self.gatewayRegistry = GatewaySettingsStore.loadGatewayRegistry()
    }

    func gatewayEndpointSummary(_ entry: GatewaySettingsStore.GatewayRegistryEntry) -> String {
        switch entry.kind {
        case .manual:
            let endpoint = if let host = entry.host, let port = entry.port {
                "\(host):\(port)"
            } else {
                String(localized: "Saved endpoint unavailable")
            }
            return entry.useTLS ? "\(endpoint) • TLS" : endpoint
        case .discovered:
            return entry.useTLS
                ? String(localized: "Discovered • TLS")
                : String(localized: "Discovered")
        }
    }

    @MainActor
    func runDiagnostics() async {
        guard !self.isRefreshingGateway else { return }
        self.isRefreshingGateway = true
        defer { self.isRefreshingGateway = false }

        if !self.appModel.isAppleReviewDemoModeEnabled {
            self.gatewayController.refreshActiveGatewayRegistrationFromSettings()
            self.gatewayController.restartDiscovery()
            await self.appModel.refreshGatewayOverviewIfConnected()
        }
        let notificationSettings = await UNUserNotificationCenter.current().notificationSettings()
        self.applyNotificationStatus(notificationSettings.authorizationStatus)
        self.registerForRemoteNotificationsIfEnrollmentReady()

        let issueCount = SettingsDiagnostics.issueCount(
            gatewayConnected: self.gatewayDiagnosticConnected,
            discoveredGatewayCount: self.gatewayController.gateways.count,
            talkConfigLoaded: self.gatewayDiagnosticTalkConfigLoaded,
            notificationsAllowed: self.notificationServingActive)
        self.diagnosticsIssueCount = issueCount
        self.diagnosticsLastRunText = SettingsDiagnostics.timestamp(Date())
    }

    func syncSettingsState() {
        self.refreshGatewayRegistry()
        self.manualGatewayPortText = self.manualGatewayPort > 0 ? String(self.manualGatewayPort) : ""
        self.selectedAgentPickerId = self.appModel.selectedAgentId ?? ""
        self.defaultShareInstruction = ShareToAgentSettings.loadDefaultInstruction()
        self.refreshLocationPermissionSummary()
        let trimmedInstanceId = self.instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedInstanceId.isEmpty else { return }
        guard let stableID = self.currentManualGatewayStableID else {
            self.gatewayCredentialFieldStableID = nil
            self.gatewayToken = ""
            self.gatewayPassword = ""
            self.pendingManualAuthOverride = nil
            return
        }
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

    func refreshLocationPermissionSummary(desiredMode modeOverride: OpenClawLocationMode? = nil) {
        let mode = modeOverride ?? OpenClawLocationMode(rawValue: self.locationModeRaw) ?? .off
        let manager = CLLocationManager()
        self.locationPermissionRefreshID &+= 1
        let refreshID = self.locationPermissionRefreshID
        let currentSummary = self.locationPermissionSummary
        self.locationPermissionSummary = LocationPermissionSummary(
            desiredMode: mode,
            locationServicesEnabled: currentSummary.locationServicesEnabled,
            authorizationStatus: manager.authorizationStatus,
            accuracyAuthorization: manager.accuracyAuthorization)
        Task {
            let locationServicesEnabled = await Self.locationServicesEnabled()
            guard refreshID == self.locationPermissionRefreshID else { return }
            let latestManager = CLLocationManager()
            let latestMode = modeOverride ?? OpenClawLocationMode(rawValue: self.locationModeRaw) ?? .off
            self.locationPermissionSummary = LocationPermissionSummary(
                desiredMode: latestMode,
                locationServicesEnabled: locationServicesEnabled,
                authorizationStatus: latestManager.authorizationStatus,
                accuracyAuthorization: latestManager.accuracyAuthorization)
        }
    }

    private static func locationServicesEnabled() async -> Bool {
        await Task.detached(priority: .utility) {
            CLLocationManager.locationServicesEnabled()
        }.value
    }

    func syncAfterOnboardingReset() {
        self.invalidateGatewaySetupAttempt()
        self.setupStatusText = nil
        self.stagedGatewaySetupLink = nil
        self.pendingManualAuthOverride = nil
        self.syncSettingsState()
        self.pendingTargetSuppression.releaseAutoConnect(controller: self.gatewayController)
    }

    func connect(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) async {
        let supersededSetupLease = self.takeStagedGatewaySetupSuppression()
        defer {
            if let supersededSetupLease {
                self.gatewayController.resumeAutoConnect(after: supersededSetupLease)
            }
        }
        self.connectingGateway = .gateway(gateway.id)
        defer {
            self.connectingGateway = nil
            self.refreshGatewayRegistry()
        }
        self.manualGatewayEnabled = false
        self.selectGatewayCredentialTarget(gateway.stableID, allowManualOverride: false)
        GatewaySettingsStore.savePreferredGatewayStableID(gateway.stableID)
        GatewaySettingsStore.saveLastDiscoveredGatewayStableID(gateway.stableID)
        if let err = await self.gatewayController.connectWithDiagnostics(gateway) {
            self.setupStatusText = err
        }
    }

    func applySetupCodeAndConnect() async {
        guard let attemptID = self.beginGatewaySetupAttempt() else { return }
        defer {
            self.finishGatewaySetupAttempt(attemptID)
            self.pendingTargetSuppression.resumeAutoConnect(.setupLink, controller: self.gatewayController)
        }
        self.setupStatusText = nil
        guard await self.applySetupCode(attemptID: attemptID) else { return }
        let host = self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard self.resolvedManualPort(host: host) != nil else {
            self.setupStatusText = String(localized: "Failed: invalid port")
            return
        }
        guard await self.preflightGateway(host: host) else { return }
        self.setupStatusText = String(localized: "Setup code applied. Connecting...")
        await self.connectManual(setupAttemptID: attemptID)
    }

    func applyGatewaySetupLink(_ link: GatewayConnectDeepLink) {
        // Only the root-selected Gateway destination may destructively claim a
        // setup link; other Settings views can remain mounted behind onboarding.
        self.showQRScanner = false
        self.scannerResultHandoff.cancel()
        let lease = self.gatewayController.cancelPendingConnectionAttempts()
        self.pendingTargetSuppression.replace(owner: .setupLink, lease: lease)
        self.setupCode = ""
        self.setupStatusText = nil
        self.stagedGatewaySetupLink = link
        let security = link.tls ? String(localized: "TLS") : String(localized: "plain")
        self.setupStatusText = String(
            format: String(
                localized: "Setup link loaded for %@:%@ (%@). Tap Connect to apply."),
            link.host,
            link.port.formatted(),
            security)
    }

    @discardableResult
    func applySetupCode(attemptID: UUID) async -> Bool {
        let raw = self.setupCode.trimmingCharacters(in: .whitespacesAndNewlines)
        let stagedLink = self.stagedGatewaySetupLink
        guard !raw.isEmpty || stagedLink != nil else {
            self.setupStatusText = String(localized: "Paste a setup code to continue.")
            return false
        }

        if AppleReviewDemoMode.isSetupCode(raw) {
            self.stagedGatewaySetupLink = nil
            self.setupCode = ""
            self.setupStatusText = String(localized: "Apple Review demo mode enabled.")
            self.appModel.enterAppleReviewDemoMode()
            self.pendingTargetSuppression.releaseAutoConnect(.setupLink, controller: self.gatewayController)
            return false
        }

        guard let parsedLink = raw.isEmpty ? stagedLink : GatewayConnectDeepLink.fromSetupInput(raw) else {
            self.setupStatusText = String(
                localized: "Setup code not recognized or uses an insecure ws:// gateway URL.")
            return false
        }
        let link = await self.gatewayController.selectReachableSetupLink(parsedLink)
        guard self.setupAttemptID == attemptID else { return false }
        self.stagedGatewaySetupLink = nil
        await self.applyGatewayLink(link)
        return true
    }

    func applyGatewayLink(_ link: GatewayConnectDeepLink) async {
        self.manualGatewayHost = link.host
        self.manualGatewayPort = link.port
        self.manualGatewayPortText = String(link.port)
        self.manualGatewayTLS = link.tls
        let instanceId = GatewaySettingsStore.currentInstanceID()
        let setupAuth = GatewayConnectionController.ManualAuthOverride.setupAuth(from: link)
        self.gatewayCredentialFieldStableID = setupAuth.targetStableID
        if setupAuth.hasBootstrapToken {
            await GatewayOnboardingReset.prepareForBootstrapPairing(
                appModel: self.appModel,
                instanceId: instanceId,
                gatewayStableID: setupAuth.targetStableID)
        }
        if !instanceId.isEmpty {
            GatewaySettingsStore.saveGatewayCredentials(
                token: setupAuth.token,
                bootstrapToken: setupAuth.bootstrapToken,
                password: setupAuth.password,
                gatewayStableID: setupAuth.targetStableID,
                suppressStoredDeviceAuth: true,
                instanceId: instanceId)
        }
        self.gatewayToken = setupAuth.token
        self.gatewayPassword = setupAuth.password
        self.pendingManualAuthOverride = setupAuth.manualAuthOverride
    }

    func openGatewayQRScanner() {
        self.invalidateGatewaySetupAttempt()
        let lease = self.gatewayController.cancelPendingConnectionAttempts(suspendCurrentGateway: true)
        self.stagedGatewaySetupLink = nil
        self.pendingTargetSuppression.replace(owner: .qrScanner, lease: lease)
        self.scannerScanID = self.scannerResultHandoff.beginScan()
        self.connectingGateway = nil
        self.setupStatusText = String(localized: "Opening QR scanner...")
        self.showQRScanner = true
    }

    func queueScannedResult(_ result: QRScannerResult, scanID: UInt64) {
        guard self.scannerResultHandoff.queue(result, scanID: scanID) else { return }
        self.setupStatusText = String(localized: "QR loaded. Closing scanner...")
        self.showQRScanner = false
    }

    func processQueuedScannerResult() {
        let delivery = self.scannerResultHandoff.processAfterDismissal { result in
            switch result {
            case let .gatewayLink(link):
                self.handleScannedGatewayLink(link)
            case let .setupCode(code):
                self.handleScannedSetupCode(code)
            }
        }
        if delivery == nil {
            self.pendingTargetSuppression.resumeAutoConnect(.qrScanner, controller: self.gatewayController)
        }
    }

    func handleScannedGatewayLink(_ link: GatewayConnectDeepLink) {
        self.showQRScanner = false
        guard let attemptID = self.beginGatewaySetupAttempt() else { return }
        self.setupCode = ""
        Task { await self.connectAfterScannedGatewayLink(link, attemptID: attemptID) }
    }

    func handleScannedSetupCode(_ code: String) {
        guard AppleReviewDemoMode.isSetupCode(code) else { return }
        self.showQRScanner = false
        self.setupCode = ""
        self.stagedGatewaySetupLink = nil
        self.setupStatusText = String(localized: "Apple Review demo mode enabled.")
        self.appModel.enterAppleReviewDemoMode()
        self.pendingTargetSuppression.releaseAutoConnect(.qrScanner, controller: self.gatewayController)
    }

    func clearStagedGatewaySetupLink() {
        guard self.stagedGatewaySetupLink != nil else { return }
        self.stagedGatewaySetupLink = nil
        self.pendingTargetSuppression.resumeAutoConnect(.setupLink, controller: self.gatewayController)
    }

    private func takeStagedGatewaySetupSuppression() -> GatewayConnectionController.AutoConnectSuppressionLease? {
        self.stagedGatewaySetupLink = nil
        return self.pendingTargetSuppression.take(ifOwnedBy: .setupLink)
    }

    func connectAfterScannedGatewayLink(_ parsedLink: GatewayConnectDeepLink, attemptID: UUID) async {
        defer {
            self.finishGatewaySetupAttempt(attemptID)
            self.pendingTargetSuppression.resumeAutoConnect(.qrScanner, controller: self.gatewayController)
        }
        let link = await self.gatewayController.selectReachableSetupLink(parsedLink)
        guard self.setupAttemptID == attemptID else { return }
        await self.applyGatewayLink(link)
        self.setupStatusText = String(
            format: String(localized: "QR loaded. Connecting to %@:%@..."),
            link.host,
            link.port.formatted())
        let host = self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard self.resolvedManualPort(host: host) != nil else {
            self.setupStatusText = String(localized: "Failed: invalid port")
            return
        }
        guard await self.preflightGateway(host: host) else { return }
        await self.connectManual(setupAttemptID: attemptID)
    }

    func connectManual(setupAttemptID: UUID? = nil) async {
        if let setupAttemptID {
            guard self.setupAttemptID == setupAttemptID else { return }
        } else {
            self.invalidateGatewaySetupAttempt()
        }
        let supersededSetupLease = self.takeStagedGatewaySetupSuppression()
        defer {
            if let supersededSetupLease {
                self.gatewayController.resumeAutoConnect(after: supersededSetupLease)
            }
        }
        let host = self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty else {
            self.setupStatusText = String(localized: "Failed: host required")
            return
        }
        guard self.manualPortIsValid else {
            self.setupStatusText = String(localized: "Failed: invalid port")
            return
        }
        guard let port = self.resolvedManualPort(host: host) else {
            self.setupStatusText = String(localized: "Failed: invalid port")
            return
        }
        self.connectingGateway = .manual
        self.manualGatewayEnabled = true
        defer {
            self.connectingGateway = nil
            self.refreshGatewayRegistry()
        }
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
            useTLS: self.manualGatewayTLS,
            authOverride: authOverride)
        // The controller now owns this attempt's immutable override. A later retry must reload
        // durable state so a spent bootstrap token cannot be resurrected from the live view.
        self.pendingManualAuthOverride = nil
    }

    func preflightGateway(host: String) async -> Bool {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        if Self.isTailnetHostOrIP(trimmed), !Self.hasTailnetIPv4() {
            self.setupStatusText = String(
                localized: "Tailscale is off on this device. Turn it on, then try again.")
            return false
        }
        self.gatewayController.requestLocalNetworkAccess(reason: "settings_preflight")
        return true
    }

    func resetOnboarding() async {
        self.invalidateGatewaySetupAttempt()
        self.setupStatusText = nil
        self.setupCode = ""
        self.gatewayAutoConnect = false
        self.suppressCredentialPersist = true
        defer { self.suppressCredentialPersist = false }
        self.gatewayToken = ""
        self.gatewayPassword = ""
        self.gatewayCredentialFieldStableID = nil
        self.pendingManualAuthOverride = nil
        await GatewayOnboardingReset.reset(appModel: self.appModel, instanceId: self.instanceId)
        self.onboardingComplete = false
        self.hasConnectedOnce = false
        self.manualGatewayEnabled = false
        self.manualGatewayHost = ""
        self.onboardingRequestID += 1
    }

    func beginGatewaySetupAttempt() -> UUID? {
        guard self.connectingGateway == nil else { return nil }
        let attemptID = UUID()
        self.setupAttemptID = attemptID
        self.connectingGateway = .setupCode
        return attemptID
    }

    func finishGatewaySetupAttempt(_ attemptID: UUID) {
        guard self.setupAttemptID == attemptID else { return }
        self.invalidateGatewaySetupAttempt()
    }

    func invalidateGatewaySetupAttempt() {
        self.setupAttemptID = nil
        self.connectingGateway = nil
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
        self.refreshLocationPermissionSummary(desiredMode: mode)
        defer { self.isChangingLocationMode = false }

        if mode == .off {
            _ = await self.appModel.requestLocationPermissions(mode: mode)
            self.pendingLocationMode = nil
            self.locationModeRaw = rawValue
            self.previousLocationModeRaw = rawValue
            self.refreshLocationPermissionSummary(desiredMode: mode)
            self.gatewayController.refreshActiveGatewayRegistrationFromSettings()
            return
        }

        let granted = await self.appModel.requestLocationPermissions(mode: mode)
        self.refreshLocationPermissionSummary(desiredMode: mode)
        if granted {
            self.pendingLocationMode = nil
            self.locationModeRaw = rawValue
            self.previousLocationModeRaw = rawValue
            self.gatewayController.refreshActiveGatewayRegistrationFromSettings()
        } else {
            self.locationModeRaw = previous
            self.previousLocationModeRaw = previous
            self.refreshLocationPermissionSummary(
                desiredMode: OpenClawLocationMode(rawValue: previous) ?? .off)
            let presentation = self.locationSettingsPresentation(selectedMode: mode)
            self.locationStatusText = presentation.statusText
        }
    }

    var selectedLocationMode: OpenClawLocationMode {
        OpenClawLocationMode(rawValue: self.locationModeRaw) ?? .off
    }

    var displayedLocationMode: OpenClawLocationMode {
        self.pendingLocationMode ?? self.selectedLocationMode
    }

    var locationSettingsPresentation: LocationSettingsPresentation {
        self.locationSettingsPresentation(selectedMode: self.displayedLocationMode)
    }

    func locationSettingsPresentation(selectedMode: OpenClawLocationMode) -> LocationSettingsPresentation {
        var summary = self.locationPermissionSummary
        summary.desiredMode = selectedMode
        return LocationSettingsPresentation(selectedMode: selectedMode, summary: summary)
    }

    func handleLocationSharingTap() {
        guard !self.isChangingLocationMode else { return }
        self.performLocationSettingsAction(self.locationSettingsPresentation.toggleAction())
    }

    func selectLocationAccessLevel(_ mode: OpenClawLocationMode) {
        guard mode != .off else { return }
        guard !self.isChangingLocationMode else { return }
        let presentation = self.locationSettingsPresentation(selectedMode: mode)
        self.performLocationSettingsAction(presentation.accessLevelAction(mode: mode))
    }

    func performLocationSettingsAction(_ action: LocationSettingsAction) {
        switch action {
        case let .setMode(mode):
            self.setLocationMode(mode)
        case let .openAppSettings(mode):
            self.pendingLocationMode = mode
            self.locationStatusText = self.locationSettingsPresentation(selectedMode: mode).statusText
            self.openLocationSettings()
        }
    }

    func setLocationMode(_ mode: OpenClawLocationMode) {
        let rawValue = mode.rawValue
        let previous = self.previousLocationModeRaw
        if self.locationModeRaw != rawValue {
            self.locationModeRaw = rawValue
            return
        }
        Task {
            await self.applyLocationMode(mode, rawValue: rawValue, previous: previous)
        }
    }

    func applyPendingLocationModeIfAvailable() {
        guard let mode = self.pendingLocationMode else { return }
        Task {
            let locationServicesEnabled = await Self.locationServicesEnabled()
            let manager = CLLocationManager()
            let summary = LocationPermissionSummary(
                desiredMode: mode,
                locationServicesEnabled: locationServicesEnabled,
                authorizationStatus: manager.authorizationStatus,
                accuracyAuthorization: manager.accuracyAuthorization)
            self.locationPermissionSummary = summary
            let unavailableStatus = self.locationSettingsPresentation(selectedMode: mode).statusText
            self.pendingLocationMode = nil
            guard summary.effectiveMode != .off else {
                self.locationStatusText = unavailableStatus
                return
            }
            self.setLocationMode(mode)
        }
    }

    func openLocationSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    func refreshNotificationSettings() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let status = settings.authorizationStatus
            Task { @MainActor in
                self.applyNotificationStatus(status)
                self.registerForRemoteNotificationsIfEnrollmentReady()
            }
        }
    }

    func handleNotificationServingToggleChange(_ isOn: Bool) {
        guard isOn else {
            self.notificationServingEnabled = false
            // UIKit stops APNs delivery here; re-enabling registers again and the
            // app delegate republishes the current token to the active gateway.
            UIApplication.shared.unregisterForRemoteNotifications()
            return
        }

        switch self.notificationStatus {
        case .allowed:
            self.enableNotificationServing()
        case .notSet:
            guard self.prepareNotificationEnrollment() else { return }
            self.requestNotificationAuthorizationFromSettings()
        case .notAllowed, .unknown:
            self.notificationServingEnabled = true
            self.openNotificationSettings()
        case .checking:
            break
        }
    }

    private func prepareNotificationEnrollment() -> Bool {
        if PushBuildConfig.current.usesOpenClawHostedRelay,
           !PushEnrollmentConsent.disclosureAccepted
        {
            self.showNotificationRelayDisclosure = true
            return false
        }
        return true
    }

    private func enableNotificationServing() {
        guard self.prepareNotificationEnrollment() else { return }
        self.notificationServingEnabled = true
        self.registerForRemoteNotificationsIfEnrollmentReady()
    }

    func acceptNotificationRelayDisclosure() {
        PushEnrollmentConsent.markDisclosureAccepted()
        switch self.notificationStatus {
        case .allowed:
            self.enableNotificationServing()
        case .notSet:
            self.requestNotificationAuthorizationFromSettings()
        case .notAllowed, .unknown:
            self.notificationServingEnabled = true
            self.openNotificationSettings()
        case .checking:
            self.notificationServingEnabled = false
        }
    }

    func requestNotificationAuthorizationFromSettings() {
        guard !self.isRequestingNotificationAuthorization else { return }
        PushEnrollmentConsent.markDisclosureAccepted()
        self.isRequestingNotificationAuthorization = true
        Task {
            let granted = await (try? UNUserNotificationCenter.current().requestAuthorization(options: [
                .alert,
                .badge,
                .sound,
            ])) ?? false
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            await MainActor.run {
                self.isRequestingNotificationAuthorization = false
                self.notificationStatus = SettingsNotificationStatus(settings.authorizationStatus)
                self.notificationServingEnabled = granted && self.notificationStatus.allowsNotifications
                guard self.notificationServingEnabled else { return }
                self.registerForRemoteNotificationsIfEnrollmentReady()
            }
        }
    }

    @MainActor
    func registerForRemoteNotificationsIfEnrollmentReady() {
        guard self.notificationServingEnabled else { return }
        guard !PushBuildConfig.current.usesOpenClawHostedRelay
            || PushEnrollmentConsent.disclosureAccepted
        else { return }
        guard self.notificationStatus.allowsNotifications else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    @MainActor
    func applyNotificationStatus(_ status: UNAuthorizationStatus) {
        self.notificationStatus = SettingsNotificationStatus(status)
    }

    var currentManualGatewayStableID: String? {
        let host = self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty, let port = self.resolvedManualPort(host: host) else { return nil }
        return GatewayConnectionController.ManualAuthOverride.manualStableID(
            host: host,
            port: port)
    }

    var gatewayCredentialTargetStableID: String? {
        // Auth fields follow the selected route. Otherwise a discovered-gateway retry can save
        // credentials under the unrelated manual endpoint and immediately reload an empty bundle.
        self.gatewayCredentialFieldStableID ?? self.currentManualGatewayStableID
    }

    var gatewayCustomHeadersTargetStableID: String? {
        guard let stableID = self.gatewayCredentialTargetStableID else { return nil }
        if GatewayStableIdentifier.matches(self.currentManualGatewayStableID, stableID) {
            return self.manualGatewayTLS ? stableID : nil
        }
        if let active = self.appModel.activeGatewayConnectConfig,
           GatewayStableIdentifier.matches(active.effectiveStableID, stableID)
        {
            return active.url.scheme?.lowercased() == "wss" ? stableID : nil
        }
        return nil
    }

    var manualGatewayEnabledBinding: Binding<Bool> {
        Binding(
            get: { self.manualGatewayEnabled },
            set: { enabled in
                self.manualGatewayEnabled = enabled
                guard enabled, let stableID = self.currentManualGatewayStableID else { return }
                self.selectGatewayCredentialTarget(stableID, allowManualOverride: true)
            })
    }

    var gatewayTokenBinding: Binding<String> {
        Binding(
            get: { self.gatewayToken },
            set: { self.persistGatewayToken($0) })
    }

    var gatewayPasswordBinding: Binding<String> {
        Binding(
            get: { self.gatewayPassword },
            set: { self.persistGatewayPassword($0) })
    }

    var manualHostBinding: Binding<String> {
        Binding(
            get: { self.manualGatewayHost },
            set: { value in
                let previousStableID = self.currentManualGatewayStableID
                self.manualGatewayHost = value
                if GatewayStableIdentifier.key(previousStableID) !=
                    GatewayStableIdentifier.key(self.currentManualGatewayStableID)
                {
                    self.clearManualCredentialFields()
                }
            })
    }

    func persistGatewayToken(_ value: String) {
        self.gatewayToken = value
        guard !self.suppressCredentialPersist else { return }
        let instanceId = self.instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
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

    func persistGatewayPassword(_ value: String) {
        self.gatewayPassword = value
        guard !self.suppressCredentialPersist else { return }
        let instanceId = self.instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
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

    func openNotificationSettings() {
        guard let url = URL(string: UIApplication.openNotificationSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    func title(for route: SettingsRoute) -> String {
        switch route {
        case .gateway: String(localized: "Gateway")
        case .appleWatch: String(localized: "Apple Watch")
        case .approvals: String(localized: "Approvals")
        case .permissions: String(localized: "Permissions")
        case .channels: String(localized: "Channels")
        case .skills: String(localized: "Skills")
        case .voice: String(localized: "Voice & Talk")
        case .diagnostics: String(localized: "Diagnostics")
        case .privacy: String(localized: "Privacy")
        case .notifications: String(localized: "Notifications")
        case .licenses: String(localized: "Licenses")
        case .about: String(localized: "About")
        }
    }

    func sendDirectWatchSetup() async {
        guard !self.isSendingWatchDirectSetup else { return }
        self.isSendingWatchDirectSetup = true
        self.watchDirectSetupStatusText = String(localized: "Preparing one-time setup…")
        defer { self.isSendingWatchDirectSetup = false }
        do {
            let result = try await self.appModel.sendDirectWatchSetup()
            self.watchDirectSetupStatusText = result.deliveredImmediately
                ? String(localized: "Setup sent. Open OpenClaw on the watch to connect.")
                : String(
                    localized: "Setup queued for the watch. Open OpenClaw before the code expires.")
        } catch {
            self.watchDirectSetupStatusText = error.localizedDescription
        }
    }

    var manualPortBinding: Binding<String> {
        Binding(
            get: { self.manualGatewayPortText },
            set: { newValue in
                let previousStableID = self.currentManualGatewayStableID
                let filtered = newValue.filter(\.isNumber)
                self.manualGatewayPortText = filtered
                self.manualGatewayPort = Int(filtered) ?? 0
                if GatewayStableIdentifier.key(previousStableID) !=
                    GatewayStableIdentifier.key(self.currentManualGatewayStableID)
                {
                    self.clearManualCredentialFields()
                }
            })
    }

    private func clearManualCredentialFields() {
        self.gatewayToken = ""
        self.gatewayPassword = ""
        self.gatewayCredentialFieldStableID = nil
        self.pendingManualAuthOverride = nil
    }

    private func selectGatewayCredentialTarget(_ stableID: String, allowManualOverride: Bool) {
        let instanceId = self.instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
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

    var manualPortIsValid: Bool {
        if self.manualGatewayPortText.isEmpty { return true }
        return self.manualGatewayPort >= 1 && self.manualGatewayPort <= 65535
    }

    func resolvedManualPort(host: String) -> Int? {
        guard self.manualGatewayPortText.isEmpty || self.manualGatewayPort > 0 else { return nil }
        return GatewayConnectionController.resolvedManualPort(
            host: host,
            port: self.manualGatewayPort)
    }

    var setupStatusLine: String? {
        if let problem = self.appModel.lastGatewayProblem {
            return problem.localizedMessage
        }
        let trimmedSetup = self.setupStatusText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let gatewayStatus = self.appModel.gatewayStatusText.trimmingCharacters(in: .whitespacesAndNewlines)
        if let friendly = self.friendlyGatewayMessage(from: gatewayStatus) { return friendly }
        if let friendly = self.friendlyGatewayMessage(from: trimmedSetup) { return friendly }
        if self.isTransientSetupStatus(trimmedSetup),
           !gatewayStatus.isEmpty,
           gatewayStatus != "Offline"
        {
            return gatewayStatus
        }
        if !trimmedSetup.isEmpty { return trimmedSetup }
        if gatewayStatus.isEmpty || gatewayStatus == "Offline" { return nil }
        return gatewayStatus
    }

    var canApplyGatewaySetup: Bool {
        !self.setupCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || self.stagedGatewaySetupLink != nil
    }

    var tailnetWarningText: String? {
        let host = self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty, Self.isTailnetHostOrIP(host), !Self.hasTailnetIPv4() else { return nil }
        return String(
            localized: "This gateway is on your tailnet. Turn on Tailscale on this device, then tap Connect.")
    }

    func friendlyGatewayMessage(from raw: String) -> String? {
        let lower = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if lower.contains("pairing required") {
            return String(
                localized: "Pairing required. Run /pair approve in your OpenClaw chat, then connect again.")
        }
        if lower.contains("device nonce required") || lower.contains("device nonce mismatch") {
            return String(localized: "Secure handshake failed. Check Tailscale, then connect again.")
        }
        if lower.contains("tls fingerprint verification timed out")
            || lower.contains("no tls endpoint detected")
        {
            return raw.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if lower.contains("timed out") {
            return String(
                localized: "Connection timed out. Make sure Tailscale is connected, then try again.")
        }
        if lower.contains("unauthorized role") {
            return String(
                localized: "Connected, but some controls are restricted for nodes. This is expected.")
        }
        return nil
    }

    func isTransientSetupStatus(_ raw: String) -> Bool {
        let lower = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let setupApplied = String(localized: "Setup code applied. Connecting...").lowercased()
        let checkingReachability = String(localized: "Checking gateway reachability...").lowercased()
        let qrFormat = String(localized: "QR loaded. Connecting to %@:%@...").lowercased()
        return lower == setupApplied
            || Self.localizedFormat(qrFormat, matches: lower)
            || lower == checkingReachability
    }

    static func localizedFormat(_ format: String, matches value: String) -> Bool {
        guard let placeholder = try? NSRegularExpression(pattern: #"%(\d+\$)?@"#) else {
            return format == value
        }
        let formatRange = NSRange(format.startIndex..., in: format)
        let matches = placeholder.matches(in: format, range: formatRange)
        guard !matches.isEmpty else { return format == value }

        var pattern = "^"
        var cursor = format.startIndex
        for match in matches {
            guard let range = Range(match.range, in: format) else { return false }
            pattern += NSRegularExpression.escapedPattern(for: String(format[cursor..<range.lowerBound]))
            pattern += #"[\s\S]+?"#
            cursor = range.upperBound
        }
        pattern += NSRegularExpression.escapedPattern(for: String(format[cursor...]))
        pattern += "$"
        return value.range(of: pattern, options: .regularExpression) != nil
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
        guard self.appModel.talkMode.gatewayTalkConfigLoaded else {
            return String(localized: "Not loaded")
        }
        return self.appModel.talkMode.gatewayTalkApiKeyConfigured
            ? String(localized: "Configured")
            : String(localized: "Not configured")
    }

    var gatewayTalkActiveVoiceDetail: String {
        let title = self.appModel.talkMode.gatewayTalkActiveModeTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let subtitle = (self.appModel.talkMode.gatewayTalkActiveModeSubtitle ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if title.isEmpty { return String(localized: "Not active") }
        if subtitle.isEmpty { return title }
        return "\(title) • \(subtitle)"
    }

    var gatewayTalkLastIssueDetail: String? {
        let detail = (self.appModel.talkMode.gatewayTalkLastIssueText ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return detail.isEmpty ? nil : detail
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
        !self.appModel.isAppleReviewDemoModeEnabled &&
            GatewayStatusBuilder.build(appModel: self.appModel) == .connected
    }

    /// First-run state: no paired gateways yet (demo mode fakes a pairing), so
    /// the status card surfaces Scan QR as the primary action.
    var gatewayNeedsPairing: Bool {
        self.gatewayRegistry.entries.isEmpty && !self.appModel.isAppleReviewDemoModeEnabled
    }

    var gatewayStatusDetail: String {
        if self.appModel.isAppleReviewDemoModeEnabled {
            return String(localized: "Apple Review demo mode")
        }
        return self.gatewayConnected
            ? String(localized: "Connected")
            : self.appModel.gatewayDisplayStatusText
    }

    var gatewayStatusValue: String {
        if self.appModel.isAppleReviewDemoModeEnabled { return String(localized: "demo") }
        return self.gatewayConnected ? String(localized: "online") : String(localized: "offline")
    }

    var gatewayStatusColor: Color {
        if self.appModel.isAppleReviewDemoModeEnabled { return OpenClawBrand.accent }
        return self.gatewayConnected ? OpenClawBrand.ok : .secondary
    }

    var gatewayDiagnosticConnected: Bool {
        self.appModel.isAppleReviewDemoModeEnabled || self.gatewayConnected
    }

    var gatewayDiagnosticTalkConfigLoaded: Bool {
        self.appModel.isAppleReviewDemoModeEnabled || self.appModel.talkMode.gatewayTalkConfigLoaded
    }

    var approvalEmptyDetail: String {
        if self.appModel.isAppleReviewDemoModeEnabled {
            return String(localized: "Live gateway requests are disabled in demo mode.")
        }
        if self.notificationsNeedAttention {
            return String(
                localized: "Foreground approvals still appear while OpenClaw is connected.")
        }
        return self.gatewayConnected
            ? String(localized: "Gateway requests will appear here.")
            : String(localized: "Connect to the gateway.")
    }

    var gatewayTalkConfigDetail: String {
        if self.appModel.isAppleReviewDemoModeEnabled { return String(localized: "Demo mode only") }
        return self.appModel.talkMode.gatewayTalkTransportLabel
    }

    var gatewayTalkConfigValue: String {
        if self.appModel.isAppleReviewDemoModeEnabled { return String(localized: "demo") }
        return self.appModel.talkMode.gatewayTalkConfigLoaded
            ? String(localized: "loaded")
            : String(localized: "missing")
    }

    var gatewayTalkConfigColor: Color {
        if self.appModel.isAppleReviewDemoModeEnabled { return .secondary }
        return self.appModel.talkMode.gatewayTalkConfigLoaded ? OpenClawBrand.ok : .secondary
    }

    var gatewayAddress: String {
        self.appModel.gatewayRemoteAddress ?? String(localized: "Waiting for gateway")
    }

    var gatewayServer: String {
        self.appModel.gatewayServerName ?? "OpenClaw Gateway"
    }

    var pendingApproval: NodeAppModel.ExecApprovalPrompt? {
        self.appModel.pendingExecApprovalPrompt
    }

    var pendingApprovalCount: Int {
        self.appModel.pendingExecApprovalCount
    }

    var approvalWaitingText: String {
        if self.pendingApprovalCount == 1 {
            return String(localized: "1 waiting")
        }
        return String(
            format: String(localized: "%@ waiting"),
            self.pendingApprovalCount.formatted())
    }

    var notificationsNeedAttention: Bool {
        self.notificationPresentation.needsAttention
    }

    var approvalItems: [SettingsApprovalItem] {
        guard let pendingApproval else { return [] }
        let pendingTitle = pendingApproval.commandPreview.map(OpenClawTextValue.verbatim)
            ?? OpenClawTextValue.localized("Review gateway action")
        let agentDetail = String(
            format: String(localized: "Agent: %@"),
            self.appModel.activeAgentName)
        return [
            SettingsApprovalItem(
                id: "pending-real",
                icon: "terminal.fill",
                title: pendingTitle,
                detail: .verbatim(agentDetail),
                priority: self.appModel.pendingExecApprovalPromptResolving
                    ? .localized("Resolving")
                    : .localized("High"),
                color: OpenClawBrand.danger),
            SettingsApprovalItem(
                id: "pending-context",
                icon: "doc.text.fill",
                title: pendingApproval.allowsAllowAlways
                    ? .localized("Permission can be saved")
                    : .localized("One-time approval"),
                detail: "Gateway request",
                priority: pendingApproval.allowsAllowAlways
                    ? .localized("Medium")
                    : .localized("Review"),
                color: OpenClawBrand.warn),
        ]
    }

    var voiceDetail: String {
        if self.talkEnabled, self.voiceWakeEnabled { return String(localized: "Talk + Wake") }
        if self.talkEnabled { return String(localized: "Talk on") }
        if self.voiceWakeEnabled { return String(localized: "Wake on") }
        return String(localized: "Off")
    }

    var diagnosticsHealthValue: String {
        if self.appModel.isAppleReviewDemoModeEnabled { return String(localized: "demo") }
        if self.gatewayConnected { return String(localized: "ready") }
        if self.gatewayController.gateways.isEmpty { return String(localized: "check") }
        return String(localized: "partial")
    }

    var diagnosticsRunValue: String {
        guard let diagnosticsIssueCount else { return String(localized: "pending") }
        return diagnosticsIssueCount == 0
            ? String(localized: "pass")
            : diagnosticsIssueCount.formatted()
    }

    var diagnosticsRunColor: Color {
        guard let diagnosticsIssueCount else { return .secondary }
        return diagnosticsIssueCount == 0 ? OpenClawBrand.ok : OpenClawBrand.warn
    }

    var locationPermissionDetailText: String? {
        if self.isChangingLocationMode {
            return String(localized: "Requesting iOS location permission…")
        }
        return self.locationSettingsPresentation.statusText
    }

    var locationPermissionWarningText: String? {
        guard let locationStatusText else { return nil }
        guard locationStatusText != self.locationPermissionDetailText else { return nil }
        return locationStatusText
    }

    var notificationStatusText: String {
        self.notificationPresentation.text
    }

    var notificationStatusColor: Color {
        self.notificationPresentation.color
    }

    var notificationServingActive: Bool {
        self.notificationPresentation.isActive
    }

    var notificationDisclosureAccepted: Bool {
        !PushBuildConfig.current.usesOpenClawHostedRelay
            || PushEnrollmentConsent.disclosureAccepted
    }

    var notificationToggleBinding: Binding<Bool> {
        Binding(
            get: { self.notificationServingActive },
            set: { self.handleNotificationServingToggleChange($0) })
    }

    var notificationPresentation: SettingsNotificationPresentation {
        switch self.notificationStatus {
        case .checking:
            return .checking
        case .allowed:
            if !self.notificationServingEnabled {
                return .off
            }
            if !self.notificationDisclosureAccepted {
                return .setup
            }
            return .enabled
        case .notAllowed:
            return .denied
        case .notSet:
            return .notSet
        case .unknown:
            return .unknown
        }
    }

    var notificationStatusDetail: String {
        self.notificationPresentation.detail
    }

    var notificationRelayDetail: String {
        if PushBuildConfig.current.usesOpenClawHostedRelay {
            let host = PushBuildConfig.current.relayBaseURL.flatMap {
                URLComponents(url: $0, resolvingAgainstBaseURL: false)?.host
            } ?? "ios-push-relay.openclaw.ai"
            return String(
                format: String(
                    localized: "This build uses OpenClaw's hosted push relay at %@ for notification delivery data."),
                host)
        }
        return String(
            localized: "This build is not configured to use OpenClaw's hosted push relay.")
    }

    var notificationRelayDisclosureMessage: String {
        String(
            localized: "Enabling this sends delivery data through OpenClaw's hosted push relay.")
    }
}
