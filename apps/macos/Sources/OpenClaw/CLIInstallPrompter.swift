import AppKit
import Foundation
import OSLog

@MainActor
final class CLIInstallPrompter {
    static let shared = CLIInstallPrompter()
    private let logger = Logger(subsystem: "ai.openclaw", category: "cli.prompt")
    private var isPrompting = false

    func checkAndPromptIfNeeded(reason: String) {
        guard !self.isPrompting else { return }
        self.isPrompting = true
        Task { @MainActor in
            await self.checkAndPromptIfNeededAsync(reason: reason)
            self.isPrompting = false
        }
    }

    private func checkAndPromptIfNeededAsync(reason: String) async {
        guard AppStateStore.shared.onboardingSeen else { return }
        let connectionMode = AppStateStore.shared.connectionMode
        guard Self.shouldManageCLI(connectionMode: connectionMode) else { return }
        guard let version = Self.appVersion() else { return }
        let status = await CLIInstaller.status()
        let managedStatus = await CLIInstaller.managedStatus()
        guard AppStateStore.shared.onboardingSeen else { return }
        let shouldRepairManaged = Self.shouldAutomaticallyRepair(
            status: managedStatus,
            launchAgentUsesManagedCLI: Self.launchAgentUsesManagedCLI(
                programArguments: GatewayLaunchAgentManager.launchdConfigSnapshot()?.programArguments ?? []),
            gatewayUpdateChannel: OpenClawConfigFile.gatewayUpdateChannel(),
            installPolicy: CLIInstallPolicy.storedPolicy(),
            launchAgentWriteDisabled: GatewayLaunchAgentManager.isLaunchAgentWriteDisabled())
        if await self.completePendingManagedRestartIfNeeded(managedStatus: managedStatus) {
            return
        }
        if shouldRepairManaged {
            // Only repair the app-owned install; external package-manager installs
            // remain under their owner's control. Repair restores the exact pin
            // that produced the incompatible status (channel policies never pin,
            // so they never reach this branch). No persisted attempt marker:
            // a transient failure must retry on the next launch/mode change, and
            // success clears the incompatible status that gates this branch.
            if await self.installCLI(
                target: .exact(version),
                showCompletionAlert: false,
                restartManagedGateway: Self.shouldRestartManagedGateway(
                    requested: !AppStateStore.shared.isPaused,
                    connectionMode: connectionMode))
            {
                return
            }
            // A completed install with an unverified restart owns recovery on
            // the next trigger; the stale pre-install status must not prompt again.
            if Self.hasPendingManagedRestart() { return }
        }
        guard !status.isReady else { return }
        let lastPrompt = UserDefaults.standard.string(forKey: cliInstallPromptedVersionKey)
        guard lastPrompt != version else { return }
        UserDefaults.standard.set(version, forKey: cliInstallPromptedVersionKey)

        if let target = self.installTargetForCurrentBuild(confirmStable: true) {
            Task { _ = await self.installCLI(target: target) }
        }

        self.logger.debug("cli install prompt handled reason=\(reason, privacy: .public)")
    }

    func installTargetForCurrentBuild(confirmStable: Bool = false) -> CLIInstaller.InstallTarget? {
        let appVersion = Self.appVersion()
        if let target = CLIInstaller.automaticInstallTarget(
            appVersion: appVersion,
            isDebug: CLIInstallBuild.isDebug)
        {
            guard confirmStable else { return target }
            let alert = NSAlert()
            alert.messageText = "Install OpenClaw CLI?"
            alert.informativeText = "The Mac node needs the matching CLI runtime."
            alert.addButton(withTitle: "Install CLI")
            alert.addButton(withTitle: "Not Now")
            alert.addButton(withTitle: "Open Settings")
            switch alert.runModal() {
            case .alertFirstButtonReturn:
                return target
            case .alertThirdButtonReturn:
                self.openSettings(tab: .connection)
                return nil
            default:
                return nil
            }
        }

        return self.chooseChannel(
            suggested: CLIInstaller.suggestedChannel(
                appVersion: appVersion,
                isDebug: CLIInstallBuild.isDebug))
            .map(CLIInstaller.InstallTarget.channel)
    }

    private func chooseChannel(suggested: CLIInstaller.Channel) -> CLIInstaller.Channel? {
        let channels = [suggested] + CLIInstaller.Channel.allCases.filter { $0 != suggested }
        let alert = NSAlert()
        alert.messageText = "Choose OpenClaw CLI channel"
        alert.informativeText =
            "This is an unreleased OpenClaw build. " +
            "Local mode can use Stable, Beta, or Dev from Git main."
        for channel in channels {
            alert.addButton(withTitle: channel.label)
        }
        alert.addButton(withTitle: "Not Now")
        let response = alert.runModal()
        let index = response.rawValue - NSApplication.ModalResponse.alertFirstButtonReturn.rawValue
        guard channels.indices.contains(index) else { return nil }
        return channels[index]
    }

    private func installCLI(
        target: CLIInstaller.InstallTarget,
        showCompletionAlert: Bool = true,
        restartManagedGateway: Bool = false) async -> Bool
    {
        let status = StatusBox()
        let usesLocalGateway = AppStateStore.shared.connectionMode == .local
        let shouldRestartManagedGateway = Self.shouldRestartManagedGateway(
            requested: restartManagedGateway,
            connectionMode: AppStateStore.shared.connectionMode)
        let previousPID = shouldRestartManagedGateway
            ? await GatewayLaunchAgentManager.runningGatewayPID()
            : nil
        let installed = await CLIInstaller.install(target: target) { message in
            await status.set(message)
            if !showCompletionAlert {
                self.logger.info("managed CLI repair: \(message, privacy: .public)")
            }
        }
        var activated = false
        if installed {
            if shouldRestartManagedGateway {
                let restarted = await self.ensureManagedGatewayRestarted(
                    previousPID: previousPID,
                    status: status)
                guard restarted else {
                    // The on-disk CLI is already replaced, so the incompatible
                    // status that gates auto-repair will read ready next launch.
                    // Persist the unfinished restart or the old gateway process
                    // would keep running the previous version indefinitely.
                    Self.setPendingManagedRestart()
                    return false
                }
            }
            let activation: CLIInstaller.LocalGatewayActivation?
            if usesLocalGateway {
                await status.set("Starting OpenClaw Gateway…")
                if !showCompletionAlert {
                    self.logger.info("managed CLI repair: Starting OpenClaw Gateway…")
                }
                activation = await CLIInstaller.activateLocalGateway()
            } else {
                activation = nil
            }
            activated = activation != .failed
            if shouldRestartManagedGateway {
                // Only proven gateway health closes the recovery loop; the
                // on-disk CLI already reads ready, so a lost marker here means
                // no later trigger would ever restart a failed gateway.
                if activated {
                    Self.clearPendingManagedRestart()
                } else {
                    Self.setPendingManagedRestart()
                }
            }
            let message = switch activation {
            case .ready:
                "OpenClaw Gateway is ready."
            case .deferred:
                "OpenClaw is installed. The Gateway will start when This Mac is active and resumed."
            case .failed:
                "OpenClaw was installed, but the Gateway did not start. Open Settings to retry."
            case nil:
                "OpenClaw CLI is ready for the Mac node."
            }
            await status.set(message)
            if !showCompletionAlert {
                self.logger.info("managed CLI repair: \(message, privacy: .public)")
            }
        }
        if showCompletionAlert, let message = await status.get() {
            let alert = NSAlert()
            alert.messageText = installed ? "CLI install finished" : "CLI install failed"
            alert.informativeText = message
            alert.runModal()
        }
        return installed && activated
    }

    /// Finishes an update whose install succeeded but whose gateway restart did
    /// not verify: by then the on-disk CLI reads ready, so the auto-repair gate
    /// can never fire again for that version while the old process keeps running.
    private func completePendingManagedRestartIfNeeded(managedStatus: CLIInstaller.Status) async -> Bool {
        guard Self.hasPendingManagedRestart() else { return false }
        guard case .ready = managedStatus else {
            // A new incompatible/missing cycle owns the next repair.
            Self.clearPendingManagedRestart()
            return false
        }
        guard Self.launchAgentUsesManagedCLI(
            programArguments: GatewayLaunchAgentManager.launchdConfigSnapshot()?.programArguments ?? []),
            AppStateStore.shared.connectionMode == .local,
            !GatewayLaunchAgentManager.isLaunchAgentWriteDisabled(),
            !AppStateStore.shared.isPaused
        else { return false }
        if let error = await GatewayLaunchAgentManager.kickstart() {
            self.logger.error("pending managed Gateway restart failed: \(error, privacy: .public)")
            return false
        }
        await GatewayConnection.shared.shutdown()
        guard await CLIInstaller.activateLocalGateway() != .failed else { return false }
        Self.clearPendingManagedRestart()
        self.logger.info("pending managed Gateway restart completed")
        return true
    }

    static func hasPendingManagedRestart() -> Bool {
        UserDefaults.standard.bool(forKey: cliManagedRestartPendingKey)
    }

    static func setPendingManagedRestart() {
        UserDefaults.standard.set(true, forKey: cliManagedRestartPendingKey)
    }

    static func clearPendingManagedRestart() {
        UserDefaults.standard.removeObject(forKey: cliManagedRestartPendingKey)
    }

    static func shouldManageCLI(connectionMode: AppState.ConnectionMode) -> Bool {
        connectionMode == .local || connectionMode == .remote
    }

    static func shouldRestartManagedGateway(
        requested: Bool,
        connectionMode: AppState.ConnectionMode) -> Bool
    {
        requested && connectionMode == .local
    }

    private func ensureManagedGatewayRestarted(previousPID: Int32?, status: StatusBox) async -> Bool {
        guard previousPID != nil else {
            await GatewayConnection.shared.shutdown()
            return true
        }
        if await self.waitForManagedGatewayRestart(previousPID: previousPID) {
            await GatewayConnection.shared.shutdown()
            return true
        }
        if let error = await GatewayLaunchAgentManager.kickstart() {
            let message = "Managed Gateway restart failed: \(error)"
            await status.set(message)
            self.logger.error("\(message, privacy: .public)")
            return false
        }
        await GatewayConnection.shared.shutdown()
        guard await self.waitForManagedGatewayRestart(previousPID: previousPID) else {
            let message = "Managed Gateway restart could not be verified."
            await status.set(message)
            self.logger.error("\(message, privacy: .public)")
            return false
        }
        return true
    }

    private func waitForManagedGatewayRestart(previousPID: Int32?) async -> Bool {
        for _ in 0..<20 {
            let currentPID = await GatewayLaunchAgentManager.runningGatewayPID()
            if Self.didManagedGatewayRestart(previousPID: previousPID, currentPID: currentPID) {
                return true
            }
            try? await Task.sleep(nanoseconds: 150_000_000)
        }
        return false
    }

    private func openSettings(tab: SettingsTab) {
        SettingsTabRouter.request(tab)
        SettingsWindowOpener.shared.open()
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: .openclawSelectSettingsTab, object: tab)
        }
    }

    private static func appVersion() -> String? {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
    }

    /// Shared gate for auto-repair and the dashboard's native update bridge.
    /// If these drift apart, the card can route to Sparkle while the
    /// post-relaunch gateway repair refuses, stranding an old gateway.
    static func managedRepairGatesOpen(
        launchAgentUsesManagedCLI: Bool,
        gatewayUpdateChannel: String?,
        installPolicy: String?,
        launchAgentWriteDisabled: Bool) -> Bool
    {
        guard !launchAgentWriteDisabled else { return false }
        guard launchAgentUsesManagedCLI else { return false }
        // Exact pins make the app the Gateway version owner; channel policies
        // leave updates to gateway update.run instead of Sparkle repair.
        guard installPolicy == nil || installPolicy == "exact" else { return false }
        // Extended-stable pins an intentionally older gateway; moving it to the
        // app's newer stable version without consent keeps the prompt instead.
        return gatewayUpdateChannel != "extended-stable"
    }

    static func shouldAutomaticallyRepair(
        status: CLIInstaller.Status,
        launchAgentUsesManagedCLI: Bool,
        gatewayUpdateChannel: String? = nil,
        installPolicy: String? = nil,
        launchAgentWriteDisabled: Bool = GatewayLaunchAgentManager.isLaunchAgentWriteDisabled()) -> Bool
    {
        guard self.managedRepairGatesOpen(
            launchAgentUsesManagedCLI: launchAgentUsesManagedCLI,
            gatewayUpdateChannel: gatewayUpdateChannel,
            installPolicy: installPolicy,
            launchAgentWriteDisabled: launchAgentWriteDisabled)
        else { return false }
        guard case let .incompatible(location, found, required) = status else { return false }
        // Auto-repair only moves the managed install forward. A gateway newer
        // than the app (e.g. beta channel ahead of the app track) was a user
        // choice; silently downgrading it keeps the consent prompt instead.
        guard Self.isManagedUpgrade(found: found, required: required) else { return false }
        return location == CLIInstaller.managedExecutableLocation()
    }

    static func isManagedUpgrade(found: String, required: String) -> Bool {
        guard let foundVersion = Semver.parse(found),
              let requiredVersion = Semver.parse(required)
        else { return false }
        if foundVersion != requiredVersion { return foundVersion < requiredVersion }
        // Same numeric triple: a prerelease sorts below its release, so
        // beta -> stable is an upgrade and stable -> beta is a downgrade.
        switch (Self.prereleaseTail(found), Self.prereleaseTail(required)) {
        case (nil, nil), (nil, .some):
            return false
        case (.some, nil):
            return true
        case let (.some(foundTail), .some(requiredTail)):
            return foundTail.compare(requiredTail, options: .numeric) == .orderedAscending
        }
    }

    private static func prereleaseTail(_ version: String) -> String? {
        let trimmed = version.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let separator = trimmed.firstIndex(of: "-") else { return nil }
        let tail = String(trimmed[trimmed.index(after: separator)...])
        return tail.isEmpty ? nil : tail
    }

    static func launchAgentUsesManagedCLI(programArguments: [String]) -> Bool {
        var command = programArguments[...]
        if command.count >= 3,
           command[command.startIndex] == "/bin/sh",
           command[command.index(after: command.startIndex)].hasSuffix("-env-wrapper.sh")
        {
            command = command.dropFirst(3)
        } else if command.count >= 2,
                  command[command.startIndex].hasSuffix("-env-wrapper.sh")
        {
            command = command.dropFirst(2)
        }
        let managedRoot = URL(fileURLWithPath: CLIInstaller.managedExecutableLocation())
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .standardizedFileURL.path + "/"
        guard let executable = command.first else { return false }
        let executablePath = URL(fileURLWithPath: executable).standardizedFileURL.path
        let managedRuntimeRoot = managedRoot + "tools/node/"
        if executablePath.hasPrefix(managedRoot), !executablePath.hasPrefix(managedRuntimeRoot) {
            return true
        }
        guard command.count >= 2 else { return false }
        let entrypoint = command[command.index(after: command.startIndex)]
        return URL(fileURLWithPath: entrypoint).standardizedFileURL.path.hasPrefix(managedRoot)
    }

    static func didManagedGatewayRestart(previousPID: Int32?, currentPID: Int32?) -> Bool {
        guard let currentPID else { return false }
        guard let previousPID else { return true }
        return currentPID != previousPID
    }
}

private actor StatusBox {
    private var value: String?

    func set(_ value: String) {
        self.value = value
    }

    func get() -> String? {
        self.value
    }
}
