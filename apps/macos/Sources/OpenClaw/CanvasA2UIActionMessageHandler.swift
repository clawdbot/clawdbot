import AppKit
import Foundation
import OpenClawKit
import WebKit

final class CanvasA2UIActionMessageHandler: NSObject, WKScriptMessageHandler {
    static let messageName = "openclawCanvasA2UIAction"
    static let allMessageNames = [messageName]

    private let sessionKey: String
    private var expectedRemoteURL: URL?

    init(sessionKey: String) {
        self.sessionKey = sessionKey
        super.init()
    }

    func setTrustedRemoteURL(_ url: URL?) {
        self.expectedRemoteURL = url.flatMap {
            CanvasHostedURLResolver.isCapabilityScopedA2UIURL($0) ? $0 : nil
        }
    }

    func updateTrustForMainFrameNavigation(to url: URL) {
        guard let expectedRemoteURL = self.expectedRemoteURL else { return }
        // Hosted action trust is load-scoped. Once the main frame leaves the
        // selected A2UI request, page navigation must never re-arm it.
        if !Self.isExactRemoteSourceURL(url, expectedRemoteURL: expectedRemoteURL) {
            self.expectedRemoteURL = nil
        }
    }

    func isTrustedSourceURL(_ url: URL) -> Bool {
        Self.isTrustedSourceURL(url, expectedRemoteURL: self.expectedRemoteURL)
    }

    static func isTrustedSourceURL(_ url: URL, expectedRemoteURL: URL?) -> Bool {
        if let scheme = url.scheme?.lowercased(), CanvasScheme.allSchemes.contains(scheme) {
            return true
        }
        return self.isExactRemoteSourceURL(url, expectedRemoteURL: expectedRemoteURL)
    }

    private static func isExactRemoteSourceURL(_ url: URL, expectedRemoteURL: URL?) -> Bool {
        guard let expectedRemoteURL,
              CanvasHostedURLResolver.isCapabilityScopedA2UIURL(expectedRemoteURL),
              let actual = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let expected = URLComponents(url: expectedRemoteURL, resolvingAgainstBaseURL: false),
              let actualScheme = actual.scheme?.lowercased(),
              let expectedScheme = expected.scheme?.lowercased(),
              actualScheme == expectedScheme,
              actual.host?.lowercased() == expected.host?.lowercased(),
              self.effectivePort(actual) == self.effectivePort(expected),
              actual.user == nil,
              actual.password == nil,
              expected.user == nil,
              expected.password == nil
        else {
            return false
        }
        return actual.percentEncodedPath == expected.percentEncodedPath &&
            actual.percentEncodedQuery == expected.percentEncodedQuery
    }

    func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
        guard Self.allMessageNames.contains(message.name) else { return }

        // Only the main in-app document or the exact capability-scoped A2UI
        // document may dispatch. Other web content remains render-only.
        guard message.frameInfo.isMainFrame else { return }
        guard let webView = message.webView, let url = message.frameInfo.request.url else { return }
        guard self.isTrustedSourceURL(url) else {
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

        guard let name = OpenClawCanvasA2UIAction.extractActionName(userAction) else { return }
        let actionId =
            (userAction["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
                ?? UUID().uuidString

        canvasWindowLogger.info("A2UI action \(name, privacy: .public) session=\(self.sessionKey, privacy: .public)")

        let surfaceId = (userAction["surfaceId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            .nonEmpty ?? "main"
        let sourceComponentId = (userAction["sourceComponentId"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty ?? "-"
        let instanceId = InstanceIdentity.instanceId.lowercased()
        let contextJSON = OpenClawCanvasA2UIAction.compactJSON(userAction["context"])

        // Token-efficient and unambiguous. The agent should treat this as a UI event and (by default) update Canvas.
        let messageContext = OpenClawCanvasA2UIAction.AgentMessageContext(
            actionName: name,
            session: .init(key: self.sessionKey, surfaceId: surfaceId),
            component: .init(id: sourceComponentId, host: InstanceIdentity.displayName, instanceId: instanceId),
            contextJSON: contextJSON)
        let text = OpenClawCanvasA2UIAction.formatAgentMessage(messageContext)

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
                let js = OpenClawCanvasA2UIAction.jsDispatchA2UIActionStatus(
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

    private static func effectivePort(_ components: URLComponents) -> Int? {
        if let port = components.port { return port }
        return switch components.scheme?.lowercased() {
        case "http": 80
        case "https": 443
        default: nil
        }
    }
    // Formatting helpers live in OpenClawKit (`OpenClawCanvasA2UIAction`).
}
