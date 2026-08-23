import AppKit
import Foundation
import OpenClawKit
import WebKit

enum DashboardGatewaysRequest: Equatable {
    case select(DashboardGatewayTarget)
    case openWindow(DashboardGatewayTarget)
    case setPrimary(DashboardGatewayTarget)
    case openSettings
}

@MainActor
final class DashboardGatewaysMessageHandler: NSObject, WKScriptMessageHandler {
    weak var owner: DashboardWindowController?

    func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
        self.owner?.receiveGatewaysMessage(message)
    }
}

extension DashboardWindowController {
    static let gatewaysMessageHandlerName = "openclawGateways"

    func hasTLSParams(_ params: GatewayTLSParams?) -> Bool {
        self.tlsParams == params
    }

    func webView(
        _ webView: WKWebView,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping @MainActor @Sendable (
            URLSession.AuthChallengeDisposition,
            URLCredential?) -> Void)
    {
        guard webView === self.webView,
              challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        guard let params = self.tlsParams else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        guard Self.isExpectedTLSAuthority(
            host: challenge.protectionSpace.host,
            port: challenge.protectionSpace.port,
            dashboardURL: self.currentURL)
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        guard let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        switch GatewayTLSServerTrust.evaluate(
            trust: trust,
            host: challenge.protectionSpace.host,
            port: challenge.protectionSpace.port,
            params: params)
        {
        case .accept:
            completionHandler(.useCredential, URLCredential(trust: trust))
        case .reject:
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    static func isExpectedTLSAuthority(host: String, port: Int, dashboardURL: URL) -> Bool {
        let expectedHost = dashboardURL.host?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let challengedHost = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let expectedPort = dashboardURL.port ?? (dashboardURL.scheme?.lowercased() == "https" ? 443 : 80)
        return expectedHost?.isEmpty == false && challengedHost == expectedHost && port == expectedPort
    }

    static func gatewaysRequest(from body: Any) -> DashboardGatewaysRequest? {
        guard let payload = body as? [String: Any], let type = payload["type"] as? String else {
            return nil
        }
        if type == "open-settings" { return .openSettings }
        guard let id = payload["id"] as? String,
              let target = DashboardGatewayTarget(bridgeID: id)
        else {
            return nil
        }
        return switch type {
        case "select": .select(target)
        case "open-window": .openWindow(target)
        case "set-primary": .setPrimary(target)
        default: nil
        }
    }

    func receiveGatewaysMessage(_ message: WKScriptMessage) {
        guard message.name == Self.gatewaysMessageHandlerName,
              message.webView === self.webView,
              message.frameInfo.isMainFrame,
              Self.isTrustedLinkSource(message.frameInfo.request.url, dashboardURL: self.currentURL),
              let request = Self.gatewaysRequest(from: message.body)
        else {
            return
        }
        DashboardManager.shared.handleGatewayRequest(request, from: self)
    }

    func updateGatewaySnapshot(_ snapshot: DashboardGatewaySnapshot) {
        self.gatewaySnapshot = snapshot
        let controller = self.webView.configuration.userContentController
        controller.removeAllUserScripts()
        Self.installNativeChromeScript(into: controller)
        Self.installNativeGatewaysScript(into: controller, snapshot: snapshot)
        Self.installNativeAuthScript(into: controller, url: self.currentURL, auth: self.auth)
        self.webView.evaluateJavaScript(Self.nativeGatewaysScriptSource(snapshot: snapshot, dispatch: true))
    }

    static func installNativeGatewaysScript(
        into userContentController: WKUserContentController,
        snapshot: DashboardGatewaySnapshot?)
    {
        guard let snapshot else { return }
        userContentController.addUserScript(WKUserScript(
            source: self.nativeGatewaysScriptSource(snapshot: snapshot, dispatch: false),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true))
    }

    static func nativeGatewaysScriptSource(
        snapshot: DashboardGatewaySnapshot,
        dispatch: Bool) -> String
    {
        guard let data = try? JSONEncoder().encode(snapshot),
              let json = String(data: data, encoding: .utf8)
        else {
            return ""
        }
        let event = dispatch
            ? "window.dispatchEvent(new CustomEvent('openclaw:native-gateways-changed'," +
            "{detail:window.__OPENCLAW_NATIVE_GATEWAYS__}));"
            : ""
        return "window.__OPENCLAW_NATIVE_GATEWAYS__=\(json);\(event)"
    }

    static func makeSetPrimaryAlert(gatewayName: String) -> NSAlert {
        let alert = NSAlert()
        alert.messageText = "Set \(gatewayName) as primary?"
        alert.informativeText =
            "This changes the Mac app's primary Gateway and resets Talk Mode, canvas, and chat connections."
        alert.addButton(withTitle: "Set as Primary")
        alert.addButton(withTitle: "Cancel")
        return alert
    }
}
