import AppKit
import Foundation
import OpenClawKit
import OSLog
import Security

private let deepLinkLogger = Logger(subsystem: "ai.openclaw", category: "DeepLink")

enum DeepLinkAgentPolicy {
    static let maxMessageChars = 20000
    static let maxUnkeyedConfirmChars = 240

    enum ValidationError: Error, Equatable, LocalizedError {
        case messageTooLongForConfirmation(max: Int, actual: Int)

        var errorDescription: String? {
            switch self {
            case let .messageTooLongForConfirmation(max, actual):
                "Message is too long to confirm safely (\(actual) chars; max \(max) without key)."
            }
        }
    }

    static func validateMessageForHandle(message: String, allowUnattended: Bool) -> Result<Void, ValidationError> {
        if !allowUnattended, message.count > self.maxUnkeyedConfirmChars {
            return .failure(.messageTooLongForConfirmation(max: self.maxUnkeyedConfirmChars, actual: message.count))
        }
        return .success(())
    }

    static func effectiveDelivery(
        link: AgentDeepLink,
        allowUnattended: Bool) -> (deliver: Bool, to: String?, channel: GatewayAgentChannel)
    {
        if !allowUnattended {
            // Without the unattended key, ignore delivery/routing knobs to reduce exfiltration risk.
            return (deliver: false, to: nil, channel: .last)
        }
        let channel = GatewayAgentChannel(raw: link.channel)
        let deliver = channel.shouldDeliver(link.deliver)
        let to = link.to?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        return (deliver: deliver, to: to, channel: channel)
    }
}

@MainActor
final class DeepLinkHandler {
    static let shared = DeepLinkHandler()

    private var lastPromptAt: Date = .distantPast

    /// Ephemeral, in-memory key used for unattended deep links originating from the in-app Canvas.
    /// This avoids blocking Canvas init on UserDefaults and doesn't weaken the external deep-link prompt:
    /// outside callers can't know this randomly generated key.
    private nonisolated static let canvasUnattendedKey: String = DeepLinkHandler.generateRandomKey()

    func handle(url: URL) async {
        guard let route = DeepLinkParser.parse(url) else {
            deepLinkLogger.debug("ignored url \(url.absoluteString, privacy: .public)")
            return
        }
        guard !AppStateStore.shared.isPaused else {
            self.presentAlert(title: "OpenClaw is paused", message: "Unpause OpenClaw to run agent actions.")
            return
        }

        switch route {
        case let .agent(link):
            await self.handleAgent(link: link, originalURL: url)
        case .gateway:
            break
        case .dashboard:
            await self.openDashboard()
        }
    }

    private func handleAgent(link: AgentDeepLink, originalURL: URL) async {
        let messagePreview = link.message.trimmingCharacters(in: .whitespacesAndNewlines)
        if messagePreview.count > DeepLinkAgentPolicy.maxMessageChars {
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

            if case let .failure(error) = DeepLinkAgentPolicy.validateMessageForHandle(
                message: messagePreview,
                allowUnattended: allowUnattended)
            {
                self.presentAlert(title: "Deep link blocked", message: error.localizedDescription)
                return
            }

            let urlText = originalURL.absoluteString
            let urlPreview = urlText.count > 500 ? "\(urlText.prefix(500))…" : urlText
            let body =
                "Run the agent with this message?\n\n\(messagePreview)\n\nURL:\n\(urlPreview)"
            guard self.confirm(title: "Run OpenClaw agent?", message: body) else { return }
        }

        if AppStateStore.shared.connectionMode == .local {
            GatewayProcessManager.shared.setActive(true)
        }

        do {
            let effectiveDelivery = DeepLinkAgentPolicy.effectiveDelivery(link: link, allowUnattended: allowUnattended)
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
                deliver: effectiveDelivery.deliver,
                to: effectiveDelivery.to,
                channel: effectiveDelivery.channel,
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

    private func openDashboard() async {
        do {
            try await DashboardManager.shared.show()
        } catch {
            DashboardManager.shared.showFailure(error)
        }
    }

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
