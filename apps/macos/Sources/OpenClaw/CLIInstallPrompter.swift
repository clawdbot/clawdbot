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
        guard AppStateStore.shared.connectionMode == .local else { return }
        guard let version = Self.appVersion() else { return }
        let status = await CLIInstaller.status()
        guard AppStateStore.shared.onboardingSeen else { return }
        guard AppStateStore.shared.connectionMode == .local else { return }
        guard !status.isReady else { return }
        let lastPrompt = UserDefaults.standard.string(forKey: cliInstallPromptedVersionKey)
        guard lastPrompt != version else { return }
        UserDefaults.standard.set(version, forKey: cliInstallPromptedVersionKey)

        if let target = self.installTargetForCurrentBuild(confirmStable: true) {
            Task { await self.installCLI(target: target) }
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
            alert.informativeText = "Local mode needs the CLI so launchd can run the Gateway."
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

    private func installCLI(target: CLIInstaller.InstallTarget) async {
        let status = StatusBox()
        let installed = await CLIInstaller.install(target: target) { message in
            await status.set(message)
        }
        if installed {
            await status.set("Starting OpenClaw Gateway…")
            let activation = await CLIInstaller.activateLocalGateway()
            let message = switch activation {
            case .ready:
                "OpenClaw Gateway is ready."
            case .deferred:
                "OpenClaw is installed. The Gateway will start when This Mac is active and resumed."
            case .failed:
                "OpenClaw was installed, but the Gateway did not start. Open Settings to retry."
            }
            await status.set(message)
        }
        if let message = await status.get() {
            let alert = NSAlert()
            alert.messageText = installed ? "CLI install finished" : "CLI install failed"
            alert.informativeText = message
            alert.runModal()
        }
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
