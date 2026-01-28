import MoltbotIPC
import Foundation

extension OnboardingView {
    @MainActor
    func refreshPerms() async {
        await self.permissionMonitor.refreshNow()
    }

    @MainActor
    func request(_ cap: Capability) async {
        guard !self.isRequesting else { return }
        self.isRequesting = true
        defer { isRequesting = false }
        _ = await PermissionManager.ensure([cap], interactive: true)
        await self.refreshPerms()
    }

    func updatePermissionMonitoring(for pageIndex: Int) {
        let shouldMonitor = pageIndex == self.permissionsPageIndex
        if shouldMonitor, !self.monitoringPermissions {
            self.monitoringPermissions = true
            PermissionMonitor.shared.register()
        } else if !shouldMonitor, self.monitoringPermissions {
            self.monitoringPermissions = false
            PermissionMonitor.shared.unregister()
        }
    }

    func updateDiscoveryMonitoring(for pageIndex: Int) {
        let isConnectionPage = pageIndex == self.connectionPageIndex
        let shouldMonitor = isConnectionPage
        if shouldMonitor, !self.monitoringDiscovery {
            self.monitoringDiscovery = true
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 150_000_000)
                guard self.monitoringDiscovery else { return }
                self.gatewayDiscovery.start()
                await self.refreshLocalGatewayProbe()
            }
        } else if !shouldMonitor, self.monitoringDiscovery {
            self.monitoringDiscovery = false
            self.gatewayDiscovery.stop()
        }
    }

    func updateMonitoring(for pageIndex: Int) {
        self.updatePermissionMonitoring(for: pageIndex)
        self.updateDiscoveryMonitoring(for: pageIndex)
        self.updateAuthMonitoring(for: pageIndex)
        self.maybeKickoffOnboardingChat(for: pageIndex)
    }

    func stopPermissionMonitoring() {
        guard self.monitoringPermissions else { return }
        self.monitoringPermissions = false
        PermissionMonitor.shared.unregister()
    }

    func stopDiscovery() {
        guard self.monitoringDiscovery else { return }
        self.monitoringDiscovery = false
        self.gatewayDiscovery.stop()
    }

    func updateAuthMonitoring(for pageIndex: Int) {
        let shouldMonitor = pageIndex == self.anthropicAuthPageIndex && self.state.connectionMode == .local
        if shouldMonitor, !self.monitoringAuth {
            self.monitoringAuth = true
            self.startAuthMonitoring()
        } else if !shouldMonitor, self.monitoringAuth {
            self.stopAuthMonitoring()
        }
    }

    func startAuthMonitoring() {
        self.refreshAnthropicOAuthStatus()
        self.authMonitorTask?.cancel()
        self.authMonitorTask = Task {
            while !Task.isCancelled {
                await MainActor.run { self.refreshAnthropicOAuthStatus() }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    func stopAuthMonitoring() {
        self.monitoringAuth = false
        self.authMonitorTask?.cancel()
        self.authMonitorTask = nil
    }

    func installCLI() async {
        guard !self.installingCLI else { return }
        self.installingCLI = true
        defer { installingCLI = false }
        await CLIInstaller.install { message in
            self.cliStatus = message
        }
        self.refreshCLIStatus()
    }

    func refreshCLIStatus() {
        let installLocation = CLIInstaller.installedLocation()
        self.cliInstallLocation = installLocation
        self.cliInstalled = installLocation != nil
    }

    func refreshLocalGatewayProbe() async {
        let port = GatewayEnvironment.gatewayPort()
        let desc = await PortGuardian.shared.describe(port: port)
        await MainActor.run {
            guard let desc else {
                self.localGatewayProbe = nil
                return
            }
            let command = desc.command.trimmingCharacters(in: .whitespacesAndNewlines)
            let expectedTokens = ["node", "moltbot", "tsx", "pnpm", "bun"]
            let lower = command.lowercased()
            let expected = expectedTokens.contains { lower.contains($0) }
            self.localGatewayProbe = LocalGatewayProbe(
                port: port,
                pid: desc.pid,
                command: command,
                expected: expected)
        }
    }

    func refreshAnthropicOAuthStatus() {
        _ = MoltbotOAuthStore.importLegacyAnthropicOAuthIfNeeded()
        let previous = self.anthropicAuthDetectedStatus
        let status = MoltbotOAuthStore.anthropicOAuthStatus()
        self.anthropicAuthDetectedStatus = status
        self.anthropicAuthConnected = status.isConnected

        if previous != status {
            self.anthropicAuthVerified = false
            self.anthropicAuthVerificationAttempted = false
            self.anthropicAuthVerificationFailed = false
            self.anthropicAuthVerifiedAt = nil
        }
    }

    @MainActor
    func verifyAnthropicOAuthIfNeeded(force: Bool = false) async {
        guard self.state.connectionMode == .local else { return }
        guard self.anthropicAuthDetectedStatus.isConnected else { return }
        if self.anthropicAuthVerified, !force { return }
        if self.anthropicAuthVerifying { return }
        if self.anthropicAuthVerificationAttempted, !force { return }

        self.anthropicAuthVerificationAttempted = true
        self.anthropicAuthVerifying = true
        self.anthropicAuthVerificationFailed = false
        defer { self.anthropicAuthVerifying = false }

        guard let refresh = MoltbotOAuthStore.loadAnthropicOAuthRefreshToken(), !refresh.isEmpty else {
            self.anthropicAuthStatus = "OAuth verification failed: missing refresh token."
            self.anthropicAuthVerificationFailed = true
            return
        }

        do {
            let updated = try await AnthropicOAuth.refresh(refreshToken: refresh)
            try MoltbotOAuthStore.saveAnthropicOAuth(updated)
            self.refreshAnthropicOAuthStatus()
            self.anthropicAuthVerified = true
            self.anthropicAuthVerifiedAt = Date()
            self.anthropicAuthVerificationFailed = false
            self.anthropicAuthStatus = "OAuth detected and verified."
        } catch {
            self.anthropicAuthVerified = false
            self.anthropicAuthVerifiedAt = nil
            self.anthropicAuthVerificationFailed = true
            self.anthropicAuthStatus = "OAuth verification failed: \(error.localizedDescription)"
        }
    }
}
