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
        guard Self.shouldStartExistingCLIActivation(
            isLocal: state.connectionMode == .local,
            executableReady: cliExecutableReady,
            installing: installingCLI)
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

    static func shouldStartExistingCLIActivation(
        isLocal: Bool,
        executableReady: Bool,
        installing: Bool) -> Bool
    {
        isLocal && executableReady && !installing
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

    func reviseCLIActivationFailureIfGatewayReady(_ status: GatewayProcessManager.Status) {
        guard Self.shouldReviseCLIActivationFailure(
            gatewayStatus: status,
            isLocal: state.connectionMode == .local,
            executableReady: cliExecutableReady,
            installed: cliInstalled)
        else { return }
        cliInstalled = true
        cliStatusKnown = true
        cliStatus = nil
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
        guard state.connectionMode == .local else {
            cliInstalled = true
            return
        }

        switch result {
        case .ready:
            cliInstalled = true
            cliStatus = "OpenClaw Gateway is ready."
        case .deferred:
            cliInstalled = false
            cliStatus = "OpenClaw is paused. Resume it, then retry setup to start the Gateway."
        case let .failed(reason):
            cliInstalled = false
            cliStatus = Self.gatewayStartFailureMessage(
                prefix: "OpenClaw is installed, but the Gateway did not start. Retry setup.",
                reason: reason)
        }
    }

    func startCLIInstall() {
        guard self.onboardingVisible, !installingCLI else { return }
        installingCLI = true
        OnboardingController.shared.setWindowCloseEnabled(false)
        // Cmd-W bypasses the disabled close button; the delegate asks first.
        OnboardingController.shared.busyReason = "OpenClaw is installing the Gateway service."
        Task { @MainActor in await self.runCLIInstall() }
    }

    func stopDiscovery() {
        guard monitoringDiscovery else { return }
        monitoringDiscovery = false
        gatewayDiscovery.stop()
    }

    func runCLIInstall() async {
        self.cliInstallPhase = .installing
        defer {
            self.installingCLI = false
            self.cliInstallPhase = .idle
            OnboardingController.shared.setWindowCloseEnabled(true)
            OnboardingController.shared.busyReason = nil
        }
        guard let target = CLIInstallPrompter.shared.installTargetForCurrentBuild() else {
            cliStatus = "CLI installation cancelled."
            return
        }
        let installed = await CLIInstaller.install(target: target) { message in
            self.cliStatus = message
        }
        guard installed else { return }
        cliExecutableReady = true
        cliInstallLocation = CLIInstaller.managedExecutableLocation()
        if !Self.shouldActivateLocalGateway(afterCLIInstallFor: self.state.connectionMode) {
            cliStatus = "OpenClaw CLI is ready for the Mac node."
            cliInstalled = true
            return
        }
        cliStatus = "Starting OpenClaw Gateway…"
        // The step checklist shows one spinner at a time: install first,
        // then the service start.
        self.cliInstallPhase = .startingService
        switch await CLIInstaller.activateLocalGateway() {
        case .ready:
            cliStatus = "OpenClaw Gateway is ready."
        case .deferred:
            cliStatus = "OpenClaw is installed. The Gateway will start when This Mac is active and resumed."
        case let .failed(reason):
            cliStatus = Self.gatewayStartFailureMessage(
                prefix: "OpenClaw was installed, but the Gateway did not start. Retry setup.",
                reason: reason)
            return
        }
        cliInstalled = true
    }

    func refreshCLIStatus() async {
        let status = await CLIInstaller.status()
        // A startup probe may still be running when the user reaches the install page.
        // Never let that stale result replace live installation progress.
        guard self.onboardingVisible, !Task.isCancelled, !installingCLI else { return }
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
