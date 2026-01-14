import AppKit
import ClawdbotIPC
import ClawdbotKit
import Foundation
import WebKit

final class CanvasA2UIActionMessageHandler: NSObject, WKScriptMessageHandler {
    static let messageName = "clawdbotCanvasA2UIAction"

    private let sessionKey: String

    init(sessionKey: String) {
        self.sessionKey = sessionKey
        super.init()
    }

    func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.messageName else { return }

        // Only accept actions from local Canvas content (not arbitrary web pages).
        guard let webView = message.webView, let url = webView.url else { return }
        if url.scheme == CanvasScheme.scheme {
            // ok
        } else if Self.isLocalNetworkCanvasURL(url) {
            // ok
        } else {
            return
        }

        let body: [String: Any] = {
            if let dict = message.body as? [String: Any] { return dict }
            if let dict = message.body as? [AnyHashable: Any] {
                return dict.reduce(into: [String: Any]()) { acc, pair in
                    guard let key = pair.key as? String else { return }
                    acc[key] = pair.value
                }
            }
            return [:]
        }()
        guard !body.isEmpty else { return }

        let userActionAny = body["userAction"] ?? body
        let userAction: [String: Any] = {
            if let dict = userActionAny as? [String: Any] { return dict }
            if let dict = userActionAny as? [AnyHashable: Any] {
                return dict.reduce(into: [String: Any]()) { acc, pair in
                    guard let key = pair.key as? String else { return }
                    acc[key] = pair.value
                }
            }
            return [:]
        }()
        guard !userAction.isEmpty else { return }

        guard let name = ClawdbotCanvasA2UIAction.extractActionName(userAction) else { return }
        let actionId =
            (userAction["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
                ?? UUID().uuidString

        canvasWindowLogger.info("A2UI action \(name, privacy: .public) session=\(self.sessionKey, privacy: .public)")

        let surfaceId = (userAction["surfaceId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            .nonEmpty ?? "main"
        let sourceComponentId = (userAction["sourceComponentId"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? "-"
        let instanceId = InstanceIdentity.instanceId.lowercased()
        let contextJSON = ClawdbotCanvasA2UIAction.compactJSON(userAction["context"])

        // Token-efficient and unambiguous. The agent should treat this as a UI event and (by default) update Canvas.
        let messageContext = ClawdbotCanvasA2UIAction.AgentMessageContext(
            actionName: name,
            session: .init(key: self.sessionKey, surfaceId: surfaceId),
            component: .init(id: sourceComponentId, host: InstanceIdentity.displayName, instanceId: instanceId),
            contextJSON: contextJSON)
        let text = ClawdbotCanvasA2UIAction.formatAgentMessage(messageContext)

        Task { [weak webView] in
            if AppStateStore.shared.connectionMode == .local {
                GatewayProcessManager.shared.setActive(true)
            }

            let result = await GatewayConnection.shared.sendAgent(
                GatewayAgentInvocation(
                    message: text,
                    sessionKey: self.sessionKey,
                    thinking: "low",
                    deliver: false,
                    to: nil,
                    channel: .last,
                    idempotencyKey: actionId))

            await MainActor.run {
                guard let webView else { return }
                let js = ClawdbotCanvasA2UIAction.jsDispatchA2UIActionStatus(
                    actionId: actionId,
                    ok: result.ok,
                    error: result.error)
                webView.evaluateJavaScript(js) { _, _ in }
            }
            if !result.ok {
                canvasWindowLogger.error(
                    """
                    A2UI action send failed name=\(name, privacy: .public) \
                    error=\(result.error ?? "unknown", privacy: .public)
                    """)
            }
        }
    }

    static func isLocalNetworkCanvasURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            return false
        }
        guard let host = url.host?.trimmingCharacters(in: .whitespacesAndNewlines), !host.isEmpty else {
            return false
        }
        if host == "localhost" { return true }
        if host.hasSuffix(".local") { return true }
        if host.hasSuffix(".ts.net") { return true }
        if host.hasSuffix(".tailscale.net") { return true }
        if !host.contains("."), !host.contains(":") { return true }
        if let ipv4 = Self.parseIPv4(host) {
            return Self.isLocalNetworkIPv4(ipv4)
        }
        return false
    }

    static func parseIPv4(_ host: String) -> (UInt8, UInt8, UInt8, UInt8)? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        let bytes: [UInt8] = parts.compactMap { UInt8($0) }
        guard bytes.count == 4 else { return nil }
        return (bytes[0], bytes[1], bytes[2], bytes[3])
    }

    static func isLocalNetworkIPv4(_ ip: (UInt8, UInt8, UInt8, UInt8)) -> Bool {
        let (a, b, _, _) = ip
        if a == 10 { return true }
        if a == 172, (16...31).contains(Int(b)) { return true }
        if a == 192, b == 168 { return true }
        if a == 127 { return true }
        if a == 169, b == 254 { return true }
        if a == 100, (64...127).contains(Int(b)) { return true }
        return false
    }

    // Formatting helpers live in ClawdbotKit (`ClawdbotCanvasA2UIAction`).
}
