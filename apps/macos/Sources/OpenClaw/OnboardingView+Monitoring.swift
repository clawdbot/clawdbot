import Foundation

extension OnboardingView {
    func updateDiscoveryMonitoring(for pageIndex: Int) {
        let isConnectionPage = pageIndex == connectionPageIndex
        let shouldMonitor = isConnectionPage
        if shouldMonitor, !monitoringDiscovery {
            monitoringDiscovery = true
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 150_000_000)
                guard self.monitoringDiscovery else { return }
                self.gatewayDiscovery.start()
                await self.refreshLocalGatewayProbe()
            }
        } else if !shouldMonitor, monitoringDiscovery {
            monitoringDiscovery = false
            gatewayDiscovery.stop()
        }
    }

    func updateMonitoring(for pageIndex: Int) {
        self.updateDiscoveryMonitoring(for: pageIndex)
        self.maybeInstallCLI(for: pageIndex)
        self.maybeStartAISetup(for: pageIndex)
    }

    func maybeInstallCLI(for pageIndex: Int) {
        guard self.requiresLocalCLI else { return }
        if pageIndex == cliPageIndex, cliExecutableReady {
            self.startExistingCLIActivationIfNeeded()
            return
        }
        guard Self.shouldAutoInstallCLI(
            onCLIPage: pageIndex == cliPageIndex,
            visible: onboardingVisible,
            statusKnown: cliStatusKnown,
            executableReady: cliExecutableReady,
            installed: cliInstalled,
            installing: installingCLI)
        else { return }
        self.startCLIInstall()
    }

    static func shouldAutoInstallCLI(
        onCLIPage: Bool,
        visible: Bool,
        statusKnown: Bool,
        executableReady: Bool,
        installed: Bool,
        installing: Bool) -> Bool
    {
        onCLIPage && visible && statusKnown && !executableReady && !installed && !installing
    }

    func startExistingCLIActivationIfNeeded() {
        guard state.connectionMode == .local,
              GatewayProcessManager.shared.installation == .managed,
              cliExecutableReady, !installingCLI
        else { return }
        // Keep the CLI setup gate in the page order until its Gateway is reachable.
        cliInstalled = false
        installingCLI = true
        cliInstallPhase = .startingService
        OnboardingController.shared.setWindowCloseEnabled(false)
        OnboardingController.shared.busyReason = "OpenClaw is starting the Gateway service."
        cliStatus = "Starting OpenClaw Gateway…"
        Task { @MainActor in await self.finishExistingCLIActivation() }
    }

    static func shouldReviseCLIActivationFailure(
        gatewayStatus: GatewayProcessManager.Status,
        isLocal: Bool,
        executableReady: Bool,
        installed: Bool) -> Bool
    {
        guard isLocal, executableReady, !installed else { return false }
        return switch gatewayStatus {
        case .running, .attachedExisting: true
        case .stopped, .starting, .failed: false
        }
    }

    static func shouldResolveInstallPromptForRunningGateway(
        gatewayStatus: GatewayProcessManager.Status,
        isLocal: Bool,
        phase: CLIInstallPhase) -> Bool
    {
        guard isLocal, phase == .choosingTarget else { return false }
        return switch gatewayStatus {
        case .running, .attachedExisting: true
        case .stopped, .starting, .failed: false
        }
    }

    func reviseCLIActivationFailureIfGatewayReady(_ status: GatewayProcessManager.Status) {
        guard self.requiresLocalCLI else {
            if self.cliInstallPhase == .choosingTarget { OnboardingController.shared.dismissAttachedSheet() }
            return
        }
        let resolvesInstallPrompt = Self.shouldResolveInstallPromptForRunningGateway(
            gatewayStatus: status,
            isLocal: state.connectionMode == .local,
            phase: cliInstallPhase)
        guard resolvesInstallPrompt || Self.shouldReviseCLIActivationFailure(
            gatewayStatus: status,
            isLocal: state.connectionMode == .local,
            executableReady: cliExecutableReady,
            installed: cliInstalled)
        else { return }
        cliInstalled = true
        cliStatusKnown = true
        cliStatus = nil
        if resolvesInstallPrompt {
            // A running local gateway already fulfills the pending install prompt.
            OnboardingController.shared.dismissAttachedSheet()
        }
    }

    /// LocalGatewayActivation.failed carries the reason bound to that specific activation
    /// attempt. Append it here so onboarding does not fall back to a generic retry message
    /// with no diagnosable cause.
    static func gatewayStartFailureMessage(prefix: String, reason: String?) -> String {
        guard let reason, !reason.isEmpty else { return prefix }
        return "\(prefix) (\(reason))"
    }

    func finishExistingCLIActivation() async {
        defer {
            installingCLI = false
            cliInstallPhase = .idle
            OnboardingController.shared.setWindowCloseEnabled(true)
            OnboardingController.shared.busyReason = nil
        }

        let result = await CLIInstaller.activateLocalGateway()
        guard self.requiresLocalCLI else { return }

        (cliInstalled, cliStatus) = Self.localGatewayActivationOutcome(result, afterFreshInstall: false)
    }

    static func localGatewayActivationOutcome(
        _ result: CLIInstaller.LocalGatewayActivation,
        afterFreshInstall: Bool) -> (ready: Bool, status: String)
    {
        switch result {
        case .ready:
            (true, "OpenClaw Gateway is ready.")
        case .deferred:
            (false, "OpenClaw is paused. Resume it, then retry setup to start the Gateway.")
        case let .failed(reason):
            (false, Self.gatewayStartFailureMessage(
                prefix: "OpenClaw \(afterFreshInstall ? "was" : "is") installed, " +
                    "but the Gateway did not start. Retry setup.",
                reason: reason))
        }
    }

    func startCLIInstall() {
        guard self.onboardingVisible, self.requiresLocalCLI, !installingCLI else { return }
        installingCLI = true
        Task { @MainActor in await self.runCLIInstall() }
    }

    func stopDiscovery() {
        guard monitoringDiscovery else { return }
        monitoringDiscovery = false
        gatewayDiscovery.stop()
    }

    func runCLIInstall() async {
        await GatewayProcessManager.shared.waitForStartupAttempt()
        self.cliInstallPhase = .choosingTarget
        defer {
            self.installingCLI = false
            self.cliInstallPhase = .idle
            OnboardingController.shared.setWindowCloseEnabled(true)
            OnboardingController.shared.busyReason = nil
        }
        guard self.requiresLocalCLI else { return }
        guard GatewayProcessManager.shared.installation == .managed else {
            self.cliStatus = GatewayProcessManager.Installation.ownershipFailure
            return
        }
        // Choosing a target is not installation: keep its spinner and close/busy guards inactive.
        guard let target = await CLIInstallPrompter.shared.installTargetForCurrentBuild(
            presentingSheetOn: OnboardingController.shared.sheetPresentationWindow)
        else {
            // Gateway readiness can resolve onboarding while this sheet is open.
            guard !cliInstalled else { return }
            cliStatus = "CLI installation cancelled."
            return
        }
        guard self.requiresLocalCLI, GatewayProcessManager.shared.installation == .managed else { return }
        self.cliInstallPhase = .installing
        OnboardingController.shared.setWindowCloseEnabled(false)
        // Cmd-W bypasses the disabled close button; the delegate asks first.
        OnboardingController.shared.busyReason = "OpenClaw is installing the Gateway service."
        let installed = await CLIInstaller.install(target: target) { message in
            self.cliStatus = message
        }
        guard installed else { return }
        cliExecutableReady = true
        cliInstallLocation = CLIInstaller.managedExecutableLocation()
        guard self.requiresLocalCLI else { return }
        cliStatus = "Starting OpenClaw Gateway…"
        // The step checklist shows one spinner at a time: install first,
        // then the service start.
        self.cliInstallPhase = .startingService
        (cliInstalled, cliStatus) = await Self.localGatewayActivationOutcome(
            CLIInstaller.activateLocalGateway(),
            afterFreshInstall: true)
    }

    func refreshCLIStatus() async {
        guard self.requiresLocalCLI else { return }
        await GatewayProcessManager.shared.waitForStartupAttempt()
        guard self.requiresLocalCLI else { return }
        guard GatewayProcessManager.shared.installation == .managed else {
            self.cliStatusKnown = true
            self.cliStatus = GatewayProcessManager.Installation.ownershipFailure
            return
        }
        let status = await CLIInstaller.status()
        // A startup probe may still be running when the user reaches the install page.
        // Never let that stale result replace live installation progress.
        guard self.onboardingVisible, self.requiresLocalCLI, !Task.isCancelled, !installingCLI else { return }
        cliInstallLocation = status.location
        cliExecutableReady = status.isReady
        cliInstalled = status.isReady
        cliStatusKnown = true
        cliStatus = status.message
        self.startExistingCLIActivationIfNeeded()
        self.maybeInstallCLI(for: self.activePageIndex)
    }

    func refreshLocalGatewayProbe() async {
        let port = GatewayEnvironment.gatewayPort()
        let desc = await PortGuardian.shared.describe(port: port)
        let managedServicePID: Int32? = if AppProfile.current.isActive, desc != nil {
            await GatewayLaunchAgentManager.runningGatewayPID()
        } else {
            nil
        }
        await MainActor.run {
            guard let desc else {
                self.localGatewayProbe = nil
                return
            }
            let command = desc.command.trimmingCharacters(in: .whitespacesAndNewlines)
            self.localGatewayProbe = LocalGatewayProbe(
                port: port,
                pid: desc.pid,
                command: command,
                profile: .current,
                managedServicePID: managedServicePID)
        }
    }
}
