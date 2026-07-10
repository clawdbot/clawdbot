import Foundation
import Testing

extension RootTabsSourceGuardTests {
    static func assertGatewaySettingsSurfaceGuards() throws {
        let settingsSource = try String(contentsOf: self.settingsProTabSourceURL(), encoding: .utf8)
        let sectionsSource = try String(contentsOf: self.settingsProTabSectionsSourceURL(), encoding: .utf8)
        let actionsSource = try String(contentsOf: self.settingsProTabActionsSourceURL(), encoding: .utf8)
        let trustSource = try String(contentsOf: self.gatewayTrustPromptAlertSourceURL(), encoding: .utf8)
        let controllerSource = try self.gatewayConnectionControllerSource()
        let rootSource = try String(contentsOf: self.rootTabsSourceURL(), encoding: .utf8)
        let scannerSource = try String(contentsOf: self.qrScannerSourceURL(), encoding: .utf8)
        let settingsScannerSheet = try self.extract(
            settingsSource,
            from: "isPresented: self.$showQRScanner,",
            to: ".sheet(isPresented: self.$showNotificationRelayDisclosure)")
        let settingsOnDismiss = try #require(settingsScannerSheet.range(of: "onDismiss: {"))
        let settingsProcessing = try #require(settingsScannerSheet.range(of: "self.processQueuedScannerResult()"))
        let settingsContent = try #require(settingsScannerSheet.range(of: "content: {"))
        let settingsPendingSetupHandler = try self.extract(
            actionsSource,
            from: "func applyGatewaySetupLink(_ link: GatewayConnectDeepLink)",
            to: "@discardableResult\n    func applySetupCode(attemptID: UUID)")
        let settingsScannerCancel = try #require(
            settingsPendingSetupHandler.range(of: "self.scannerResultHandoff.cancel()"))
        let settingsSetupStaging = try #require(
            settingsPendingSetupHandler.range(of: "self.stagedGatewaySetupLink = link"))
        let scannerMake = try self.extract(
            scannerSource,
            from: "func makeUIViewController",
            to: "func updateUIViewController")
        let scannerLifecycle = try self.extract(
            scannerSource,
            from: "final class QRScannerContainerViewController",
            to: "final class Coordinator")
        let scannerDelivery = try self.extract(
            scannerSource,
            from: "private func deliver(_ result: QRScannerResult",
            to: "func dataScanner(_: DataScannerViewController, didRemove")
        let stopScanning = try #require(scannerDelivery.range(of: "scanner.stopScanning()"))
        let deliverResult = try #require(scannerDelivery.range(of: "self.parent.onResult(result)"))
        let activeProblemToast = try self.extract(
            rootSource,
            from: "private var activeGatewayProblemToast: GatewayConnectionProblem?",
            to: "private var gatewayToastAnimation: Animation?")
        let gatewaySetupSource = try self.extract(
            rootSource,
            from: "private func maybeOpenSettingsForGatewaySetup()",
            to: "private func maybeRequestLocalNetworkAccess")
        let consumedGatewaySetup = try #require(
            gatewaySetupSource.range(of: "appModel.consumePendingGatewaySetupLink()"))
        let onboardingSetupOwnerGuard = try #require(
            gatewaySetupSource.range(of: "guard !self.showOnboarding else { return }"))
        let deliveredGatewaySetup = try #require(
            gatewaySetupSource.range(of: "self.gatewaySetupRequest = GatewaySetupRequest"))

        #expect(scannerSource.contains("static let defaultSettlingNanoseconds: UInt64 = 1_200_000_000"))
        #expect(scannerSource.contains("QRScannerContainerViewController(coordinator: context.coordinator)"))
        #expect(!scannerMake.contains("startScanning()"))
        #expect(scannerLifecycle.contains("override func viewDidAppear"))
        #expect(scannerLifecycle.contains("try self.scanner.startScanning()"))
        #expect(scannerLifecycle.contains("override func viewWillDisappear"))
        #expect(scannerLifecycle.contains("self.stopScannerCapture()"))

        #expect(sectionsSource.contains("var gatewayDestination: some View"))
        #expect(sectionsSource.contains("self.gatewayActions"))
        #expect(sectionsSource.contains("self.manualGatewayCard"))
        #expect(sectionsSource.contains("self.gatewaySetupCard"))
        #expect(sectionsSource.contains("self.discoveredGatewaysCard"))
        #expect(sectionsSource.contains("self.gatewayAdvancedCard"))
        #expect(sectionsSource.contains("title: \"Reconnect\""))
        #expect(sectionsSource.contains("Task { await self.reconnectGateway() }"))
        #expect(sectionsSource.contains("title: \"Diagnose\""))
        #expect(sectionsSource.contains("Task { await self.runDiagnostics() }"))
        #expect(sectionsSource.contains("title: \"Scan QR\""))
        #expect(sectionsSource.contains("self.openGatewayQRScanner()"))
        #expect(sectionsSource.contains("title: \"Connect\""))
        #expect(sectionsSource.contains("Task { await self.applySetupCodeAndConnect() }"))
        #expect(sectionsSource.contains("Task { await self.connect(gateway) }"))
        #expect(sectionsSource.contains("tailnetWarningText"))
        // Gateway problems surface once, as the root toast; the settings page must not
        // embed a second copy of the banner.
        #expect(!sectionsSource.contains("GatewayProblemBanner("))
        #expect(rootSource.contains("GatewayProblemBanner("))
        #expect(rootSource.contains(".gesture(self.gatewayToastSwipeGesture)"))
        // Operator auth/pairing problems can coexist with a connected node, so the
        // root's only remediation surface must not depend on aggregate status.
        #expect(activeProblemToast.contains("appModel.lastGatewayProblem"))
        #expect(!activeProblemToast.contains("gatewayStatus"))
        // Every problem report re-surfaces a swiped-away toast or shakes the
        // visible one; value equality alone must not keep the toast hidden.
        #expect(rootSource.contains("self.appModel.gatewayProblemReportCount"))
        #expect(rootSource.contains("GatewayToastShakeEffect"))

        #expect(actionsSource.contains("await self.gatewayController.connectActiveGateway()"))
        #expect(actionsSource.contains("self.gatewayController.refreshActiveGatewayRegistrationFromSettings()"))
        #expect(actionsSource.contains("self.gatewayController.restartDiscovery()"))
        #expect(actionsSource.contains("await self.appModel.refreshGatewayOverviewIfConnected()"))
        #expect(actionsSource
            .contains("self.gatewayController.requestLocalNetworkAccess(reason: \"settings_preflight\")"))
        #expect(controllerSource.contains("await self.tcpReachabilityProbe("))
        #expect(controllerSource.contains("Check Tailscale or LAN."))
        #expect(actionsSource.contains("Tailscale is off on this device. Turn it on, then try again."))
        #expect(actionsSource.contains("Run /pair approve in your OpenClaw chat"))
        #expect(settingsSource.contains("self.resetOnboarding()"))
        #expect(settingsSource.contains(".onChange(of: self.onboardingRequestID)"))
        #expect(settingsSource.contains("self.syncAfterOnboardingReset()"))
        #expect(settingsSource.contains("let acceptsGatewaySetupRequests: Bool"))
        #expect(settingsSource.contains("guard self.acceptsGatewaySetupRequests else { return }"))
        #expect(settingsSource.contains(".onChange(of: self.acceptsGatewaySetupRequests)"))
        #expect(rootSource.matches(of: /acceptsGatewaySetupRequests: !self\.showOnboarding/).count == 2)
        #expect(actionsSource.contains("func syncAfterOnboardingReset()"))
        #expect(actionsSource.contains("self.pendingManualAuthOverride = nil"))
        // The root toast is the only gateway problem surface outside covers, so it
        // must keep the reset-onboarding primary action the settings banner had.
        #expect(rootSource.contains("resetTitle: \"Reset onboarding\""))
        #expect(rootSource.contains("GatewayOnboardingReset.reset(appModel: self.appModel, instanceId: instanceId)"))
        #expect(rootSource.contains("self.gatewayController.trustRotatedGatewayCertificate(from: problem)"))
        #expect(rootSource.contains("GatewayProblemPrimaryAction.handleProtocolMismatchIfNeeded(problem)"))
        #expect(rootSource.contains("await self.gatewayController.connectActiveGateway()"))

        #expect(rootSource.contains("GatewayProblemDetailsSheet("))
        #expect(onboardingSetupOwnerGuard.lowerBound < consumedGatewaySetup.lowerBound)
        #expect(consumedGatewaySetup.lowerBound < deliveredGatewaySetup.lowerBound)
        #expect(settingsSource.contains("QRScannerView("))
        #expect(settingsOnDismiss.lowerBound < settingsProcessing.lowerBound)
        #expect(settingsProcessing.lowerBound < settingsContent.lowerBound)
        #expect(settingsPendingSetupHandler.contains("self.showQRScanner = false"))
        #expect(settingsScannerCancel.lowerBound < settingsSetupStaging.lowerBound)
        #expect(settingsPendingSetupHandler.contains(
            "self.gatewayController.cancelPendingConnectionAttempts()"))
        #expect(!settingsSource.contains(".onChange(of: self.showQRScanner)"))
        #expect(actionsSource.contains("case let .gatewayLink(link):"))
        #expect(actionsSource.contains("case let .setupCode(code):"))
        #expect(stopScanning.lowerBound < deliverResult.lowerBound)
        #expect(trustSource.contains("Trust this gateway?"))
        #expect(trustSource.contains("Trust and connect"))
        #expect(trustSource.contains("let isEnabled: Bool"))
        #expect(rootSource.contains(".gatewayTrustPromptAlert(isEnabled: !self.showOnboarding)"))
    }

    static func assertGatewayOnboardingFlowGuards() throws {
        let onboardingSource = try self.onboardingWizardSource()
        let actionsSource = try String(contentsOf: self.settingsProTabActionsSourceURL(), encoding: .utf8)
        let controllerSource = try self.gatewayConnectionControllerSource()
        let pendingSetupHandler = try self.extract(
            onboardingSource,
            from: "private func applyPendingGatewaySetupLinkIfNeeded()",
            to: "private func connectStagedGatewaySetupLink()")
        let stagedSetupConnect = try self.extract(
            onboardingSource,
            from: "private func connectStagedGatewaySetupLink()",
            to: "private func clearStagedGatewaySetupLink()")
        let stagedSetupClear = try self.extract(
            onboardingSource,
            from: "private func clearStagedGatewaySetupLink()",
            to: "private func applyGatewayLink(")
        let connectionFailure = try self.extract(
            onboardingSource,
            from: "private func setConnectionFailure(_ message: String)",
            to: "var body: some View")
        let stagedValidation = try #require(stagedSetupConnect.range(of: "guard link.isValidEndpoint"))
        let stagedConsumption = try #require(stagedSetupConnect.range(of: "self.setupLinkStaging.take()"))
        let stagedReset = try #require(
            stagedSetupConnect.range(of: "await self.appModel.resetGatewaySessionsForTargetSwitch()"))
        let onboardingGatewayLink = try self.extract(
            onboardingSource,
            from: "private func applyGatewayLink(",
            to: "private func handleScannedSetupCode(")
        let settingsGatewayLink = try self.extract(
            actionsSource,
            from: "func applyGatewayLink(",
            to: "func openGatewayQRScanner()")
        let onboardingManualConnect = try self.extract(
            onboardingSource,
            from: "private func connectCurrentManualGateway(",
            to: "private func retryLastAttempt(")
        let onboardingRetry = try self.extract(
            onboardingSource,
            from: "private func retryLastAttempt(",
            to: "private func gatewayProblemPrimaryActionTitle(")
        let settingsManualConnect = try self.extract(
            actionsSource,
            from: "func connectManual(setupAttemptID: UUID? = nil) async",
            to: "func preflightGateway(host: String)")

        #expect(onboardingSource.contains(".gatewayTrustPromptAlert()"))
        #expect(onboardingSource.contains("self.applyPendingGatewaySetupLinkIfNeeded()"))
        #expect(onboardingSource.contains(".onChange(of: self.appModel.gatewaySetupRequestID)"))
        #expect(onboardingSource.contains("self.appModel.consumePendingGatewaySetupLink()"))
        #expect(onboardingSource.contains("self.scannerResultHandoff.cancel()"))
        #expect(!onboardingSource.contains("pendingScannerResult"))
        #expect(onboardingSource.contains("self.setupLinkStaging.stage(link)"))
        #expect(pendingSetupHandler.contains("self.gatewayController.cancelPendingConnectionAttempts()"))
        #expect(pendingSetupHandler.contains("if self.selectedMode == nil"))
        #expect(onboardingSource.contains("Tap Connect to apply."))
        #expect(onboardingSource.contains("self.connectStagedGatewaySetupLink()"))
        #expect(onboardingSource.contains("Credentials are applied only after you tap Connect."))
        #expect(onboardingSource.contains("Plaintext (local network)"))
        #expect(onboardingSource.contains("self.statusLine = message"))
        #expect(!pendingSetupHandler.contains("self.manualHost ="))
        #expect(!pendingSetupHandler.contains("self.manualPort ="))
        #expect(!pendingSetupHandler.contains("self.manualTLS ="))
        #expect(!pendingSetupHandler.contains("self.applyGatewayLink(link)"))
        #expect(!pendingSetupHandler.contains("self.handleScannedLink(link)"))
        #expect(!pendingSetupHandler.contains("self.connectManual()"))
        #expect(stagedValidation.lowerBound < stagedConsumption.lowerBound)
        #expect(stagedReset.lowerBound < stagedConsumption.lowerBound)
        #expect(!stagedSetupConnect.contains("self.appModel.disconnectGateway()"))
        #expect(stagedSetupConnect.contains(
            "self.applyGatewayLink(link, disconnectExistingGatewayForBootstrap: false)"))
        #expect(stagedSetupConnect.contains("guard self.connectingGatewayID == nil else { return }"))
        #expect(stagedSetupConnect.contains("self.setConnectionFailure(message)"))
        #expect(connectionFailure.contains("self.localConnectionFailure = message"))
        #expect(!connectionFailure.contains("self.connectMessage = message"))
        #expect(connectionFailure.contains("self.statusLine = message"))
        #expect(onboardingSource.contains(".failedStatus(message: message, allowsRetry: false)"))
        #expect(onboardingSource.contains("primaryActionTitle: allowsRetry ? \"Retry\" : nil"))
        #expect(onboardingSource.contains("onPrimaryAction: allowsRetry ? self.onRetry : nil"))
        #expect(stagedSetupClear.contains("self.localConnectionFailure = nil"))
        #expect(onboardingRetry.contains("self.localConnectionFailure = nil"))
        #expect(onboardingRetry.contains(
            "self.setConnectionFailure(\"No connection to retry. Check the gateway host and port.\")"))
        #expect(onboardingSource.contains("self.setupLinkStaging.link == nil else { return }"))
        #expect(onboardingGatewayLink.contains("self.gatewayToken = setupAuth.token"))
        #expect(onboardingGatewayLink.contains("self.gatewayPassword = setupAuth.password"))
        #expect(settingsGatewayLink.contains("self.gatewayToken = setupAuth.token"))
        #expect(settingsGatewayLink.contains("self.gatewayPassword = setupAuth.password"))
        #expect(onboardingManualConnect.contains("nodeOptions.allowStoredDeviceAuth == true"))
        #expect(onboardingManualConnect.contains("self.pendingManualAuthOverride = nil"))
        #expect(onboardingManualConnect.contains("targetStableID: stableID"))
        #expect(settingsManualConnect.contains("nodeOptions.allowStoredDeviceAuth == true"))
        #expect(settingsManualConnect.contains("self.pendingManualAuthOverride = nil"))
        #expect(settingsManualConnect.contains("targetStableID: stableID"))
        #expect(!controllerSource.contains("shouldApplyTokenField"))
        #expect(!controllerSource.contains("shouldApplyPasswordField"))
        #expect(controllerSource.contains("allowStoredDeviceAuth: !suppressStoredDeviceAuth"))
        #expect(controllerSource.contains(
            "deviceAuthGatewayID: GatewaySettingsStore.authenticationOwnerID("))
        #expect(controllerSource.contains("DeviceAuthStore.migrateUnscopedToken("))
        #expect(controllerSource.contains("DeviceAuthStore.discardUnscopedTokens("))
        #expect(onboardingSource.contains(
            "self.selectGatewayCredentialTarget(gateway.stableID, allowManualOverride: false)"))
        #expect(actionsSource.contains(
            "self.selectGatewayCredentialTarget(gateway.stableID, allowManualOverride: false)"))
        #expect(onboardingSource.contains(
            "self.gatewayCredentialFieldStableID ?? self.currentManualGatewayStableID"))
        #expect(actionsSource.contains(
            "self.gatewayCredentialFieldStableID ?? self.currentManualGatewayStableID"))
    }

    static func assertGatewayReconnectGuards() throws {
        let modelSource = try String(contentsOf: self.nodeAppModelSourceURL(), encoding: .utf8)
        let controllerSource = try self.gatewayConnectionControllerSource()
        let backgroundReconnect = try self.extract(
            modelSource,
            from: "private func performBackgroundAliveBeaconIfNeeded(",
            to: "private func publishBackgroundAliveBeacon(")
        let disconnectGateway = try self.extract(
            modelSource,
            from: "func disconnectGateway()",
            to: "private func disableGatewayAutoReconnect()")
        let operatorGatewayLoop = try self.extract(
            modelSource,
            from: "private func startOperatorGatewayLoop(",
            to: "private func startNodeGatewayLoop(")
        let nodeGatewayLoop = try self.extract(
            modelSource,
            from: "private func startNodeGatewayLoop(",
            to: "private func makeOperatorConnectOptions(")
        let wakeWordRefresh = try self.extract(
            modelSource,
            from: "private func refreshWakeWordsFromGateway(",
            to: "private func isGatewayHealthMonitorDisabled()")

        #expect(disconnectGateway.contains("self.beginGatewaySessionReset(chainingAfterExisting: true)"))
        #expect(!disconnectGateway.contains("Task {"))
        #expect(modelSource.contains(
            "private func isCurrentGatewayRoute(generation: UInt64, stableID: String) -> Bool"))
        #expect(modelSource.matches(
            of: /self\.isCurrentGatewayRoute\(generation: routeGeneration, stableID: stableID\)/).count >= 2)
        #expect(operatorGatewayLoop.contains("gatewayReconnectLoopDelay(source: \"operator_loop\")"))
        #expect(nodeGatewayLoop.contains("gatewayReconnectLoopDelay(source: \"node_loop\")"))
        #expect(modelSource.contains("refreshWakeWordsFromGateway(shouldApply: shouldContinue)"))
        #expect(wakeWordRefresh.matches(of: /guard shouldApply\(\) else \{ return \}/).count >= 2)
        #expect(modelSource.contains("if !self.gatewayAutoReconnectEnabled || self.gatewayPairingPaused"))
        #expect(controllerSource.contains("acceptPendingTrustPrompt()"))
        #expect(controllerSource.contains("trustRotatedGatewayCertificate(from problem: GatewayConnectionProblem)"))
        #expect(controllerSource.contains("allowAutoReconnect: false"))
        #expect(controllerSource.contains("guard allowAutoReconnect else { return }"))
        #expect(controllerSource.contains("guard self.autoConnectSuppressionGeneration == nil else { return }"))
        #expect(backgroundReconnect.contains("let generation = self.gatewayConnectGeneration"))
        #expect(backgroundReconnect.contains("await self.resetGatewaySessionsForForcedReconnect()"))
        #expect(backgroundReconnect.contains("expectedGeneration: generation"))
        #expect(modelSource.contains("expectedGeneration: UInt64)"))
        #expect(!modelSource.contains("expectedGeneration: UInt64?"))
    }
}
