import AppKit
import Foundation
import OSLog

@MainActor
final class CLIInstallPrompter {
    static let shared = CLIInstallPrompter()
    private let logger = Logger(subsystem: "bot.molt", category: "cli.prompt")
    private var isPrompting = false

    func checkAndPromptIfNeeded(reason: String) {
        guard self.shouldPrompt() else { return }
        guard let version = Self.appVersion() else { return }
        self.isPrompting = true
        UserDefaults.standard.set(version, forKey: cliInstallPromptedVersionKey)

        let alert = NSAlert()
        alert.messageText = "Install Moltbot CLI?"
        alert.informativeText = "Local mode needs the CLI so launchd can run the gateway."
        alert.addButton(withTitle: "Install CLI")
        alert.addButton(withTitle: "Not now")
        alert.addButton(withTitle: "Open Settings")
        let response = alert.runModal()

        switch response {
        case .alertFirstButtonReturn:
            Task { await self.installCLI() }
        case .alertThirdButtonReturn:
            self.openSettings(tab: .general)
        default:
            break
        }

        self.logger.debug("cli install prompt handled reason=\(reason, privacy: .public)")
        self.isPrompting = false
    }

    private func shouldPrompt() -> Bool {
        guard !self.isPrompting else { return false }
        guard AppStateStore.shared.onboardingSeen else { return false }
        guard AppStateStore.shared.connectionMode == .local else { return false }
        guard CLIInstaller.installedLocation() == nil else { return false }
        guard let version = Self.appVersion() else { return false }
        let lastPrompt = UserDefaults.standard.string(forKey: cliInstallPromptedVersionKey)
        return lastPrompt != version
    }

    private func installCLI() async {
        let status = StatusBox()
        await CLIInstaller.install { message in
            await status.set(message)
        }
        if let message = await status.get() {
            let alert = NSAlert()
            alert.messageText = "CLI install finished"
            alert.informativeText = message
            alert.runModal()
        }
    }

    private func openSettings(tab: SettingsTab) {
        SettingsTabRouter.request(tab)
        SettingsWindowOpener.shared.open()
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: .moltbotSelectSettingsTab, object: tab)
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
