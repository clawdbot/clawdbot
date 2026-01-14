import AppKit
import ClawdbotKit
import Foundation
import OSLog
import Security

private let deepLinkLogger = Logger(subsystem: "com.clawdbot", category: "DeepLink")

@MainActor
final class DeepLinkHandler {
    static let shared = DeepLinkHandler()

    private var lastPromptAt: Date = .distantPast

    // Ephemeral, in-memory key used for unattended deep links originating from the in-app Canvas.
    // This avoids blocking Canvas init on UserDefaults and doesn't weaken the external deep-link prompt:
    // outside callers can't know this randomly generated key.
    private nonisolated static let canvasUnattendedKey: String = DeepLinkHandler.generateRandomKey()

    func handle(url: URL) async {
        guard let route = DeepLinkParser.parse(url) else {
            deepLinkLogger.debug("ignored url \(url.absoluteString, privacy: .public)")
            return
        }
        guard !AppStateStore.shared.isPaused else {
            self.presentAlert(title: "Clawdbot is paused", message: "Unpause Clawdbot to run agent actions.")
            return
        }

        switch route {
        case let .agent(link):
            await self.handleAgent(link: link, originalURL: url)
        }
    }

    private func handleAgent(link: AgentDeepLink, originalURL: URL) async {
        let messagePreview = link.message.trimmingCharacters(in: .whitespacesAndNewlines)
        if messagePreview.count > 20000 {
            self.presentAlert(title: "Deep link too large", message: "Message exceeds 20,000 characters.")
            return
        }

        let allowUnattended = link.key == Self.canvasUnattendedKey || link.key == Self.expectedKey()
        if !allowUnattended {
            if Date().timeIntervalSince(self.lastPromptAt) < 1.0 {
                deepLinkLogger.debug("throttling deep link prompt")
                return
            }
            self.lastPromptAt = Date()

            let trimmed = messagePreview.count > 240 ? "\(messagePreview.prefix(240))…" : messagePreview
            let body =
                "Run the agent with this message?\n\n\(trimmed)\n\nURL:\n\(originalURL.absoluteString)"
            guard self.confirm(title: "Run Clawdbot agent?", message: body) else { return }
        }

        if AppStateStore.shared.connectionMode == .local {
            GatewayProcessManager.shared.setActive(true)
        }

        do {
            let channel = GatewayAgentChannel(raw: link.channel)
            let explicitSessionKey = link.sessionKey?
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .nonEmpty
            let resolvedSessionKey: String = if let explicitSessionKey {
                explicitSessionKey
            } else {
                await GatewayConnection.shared.mainSessionKey()
            }
            let invocation = GatewayAgentInvocation(
                message: messagePreview,
                sessionKey: resolvedSessionKey,
                thinking: link.thinking?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty,
                deliver: channel.shouldDeliver(link.deliver),
                to: link.to?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty,
                channel: channel,
                timeoutSeconds: link.timeoutSeconds,
                idempotencyKey: UUID().uuidString)

            let res = await GatewayConnection.shared.sendAgent(invocation)
            if !res.ok {
                throw NSError(
                    domain: "DeepLink",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: res.error ?? "agent request failed"])
            }
        } catch {
            self.presentAlert(title: "Agent request failed", message: error.localizedDescription)
        }
    }

    // MARK: - Auth

    static func currentKey() -> String {
        self.expectedKey()
    }

    static func currentCanvasKey() -> String {
        self.canvasUnattendedKey
    }

    private static func expectedKey() -> String {
        let defaults = UserDefaults.standard
        if let key = defaults.string(forKey: deepLinkKeyKey), !key.isEmpty {
            return key
        }
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let data = Data(bytes)
        let key = data
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        defaults.set(key, forKey: deepLinkKeyKey)
        return key
    }

    private nonisolated static func generateRandomKey() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let data = Data(bytes)
        return data
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    // MARK: - UI

    private func confirm(title: String, message: String) -> Bool {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "Run")
        alert.addButton(withTitle: "Cancel")
        alert.alertStyle = .warning
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func presentAlert(title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.alertStyle = .informational
        alert.runModal()
    }
}
