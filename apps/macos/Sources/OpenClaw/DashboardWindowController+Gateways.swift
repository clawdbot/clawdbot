import AppKit
import Foundation
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
            ? "window.dispatchEvent(new CustomEvent('openclaw:native-gateways-changed',{detail:window.__OPENCLAW_NATIVE_GATEWAYS__}));"
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
