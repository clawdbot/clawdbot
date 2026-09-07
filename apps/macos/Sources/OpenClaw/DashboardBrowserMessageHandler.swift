import CoreFoundation
import Foundation
import WebKit

/// Wire keys are owned by ui/src/app/native-browser-bridge.ts.
struct DashboardBrowserRect: Codable, Equatable, Sendable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

enum DashboardBrowserAction: String, Equatable, Sendable {
    case back, forward, reload, stop, close, snapshot
}

enum DashboardBrowserRequest: Equatable, Sendable {
    case open(tabId: String, url: URL, activate: Bool)
    case navigate(tabId: String, url: URL)
    case action(DashboardBrowserAction, tabId: String)
    case present(scope: String, tabId: String?, rect: DashboardBrowserRect?, visible: Bool)
    case releaseScope(String)
    case inspect(tabId: String, x: Double, y: Double)
}

enum DashboardBrowserError: Error, LocalizedError {
    case invalidRequest
    case unknownTab
    case duplicateTab
    case unavailable
    case captureFailed

    var errorDescription: String? {
        switch self {
        case .invalidRequest: "Invalid native browser request."
        case .unknownTab: "This Mac tab has been closed."
        case .duplicateTab: "This Mac tab already exists."
        case .unavailable: "The native browser is no longer available."
        case .captureFailed: "Could not capture this Mac tab. Try again after the page loads."
        }
    }
}

@MainActor
final class DashboardBrowserMessageHandler: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "openclawBrowser"
    typealias ReplyHandler = @MainActor (Any?, String?) -> Void
    weak var owner: DashboardWindowController?

    func userContentController(
        _: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping ReplyHandler)
    {
        guard let owner = self.owner else {
            replyHandler(["ok": false, "error": DashboardBrowserError.unavailable.localizedDescription], nil)
            return
        }
        owner.receiveBrowserMessage(message, replyHandler: replyHandler)
    }

    nonisolated static func decode(_ body: Any) throws -> DashboardBrowserRequest {
        guard let payload = body as? [String: Any], let type = payload["type"] as? String else {
            throw DashboardBrowserError.invalidRequest
        }
        switch type {
        case "open":
            let activate = try Self.boolean(payload["activate"] ?? true)
            return try .open(
                tabId: Self.identifier(payload["tabId"]), url: Self.url(payload["url"]), activate: activate)
        case "navigate":
            return try .navigate(tabId: Self.identifier(payload["tabId"]), url: Self.url(payload["url"]))
        case "present":
            let tabId: String? = if let raw = payload["tabId"], !(raw is NSNull) {
                try Self.identifier(raw)
            } else {
                nil
            }
            let rect: DashboardBrowserRect?
            if payload["rect"] is NSNull {
                rect = nil
            } else {
                guard let raw = payload["rect"] as? [String: Any] else {
                    throw DashboardBrowserError.invalidRequest
                }
                let width = try Self.number(raw["width"])
                let height = try Self.number(raw["height"])
                guard width >= 0, height >= 0 else { throw DashboardBrowserError.invalidRequest }
                rect = try DashboardBrowserRect(
                    x: Self.number(raw["x"]), y: Self.number(raw["y"]), width: width, height: height)
            }
            guard payload["tabId"] != nil else { throw DashboardBrowserError.invalidRequest }
            return try .present(
                scope: Self.identifier(payload["scope"]),
                tabId: tabId,
                rect: rect,
                visible: Self.boolean(payload["visible"]))
        case "release-scope":
            return try .releaseScope(Self.identifier(payload["scope"]))
        case "inspect":
            let x = try Self.number(payload["x"])
            let y = try Self.number(payload["y"])
            guard x >= 0, y >= 0 else { throw DashboardBrowserError.invalidRequest }
            return try .inspect(tabId: Self.identifier(payload["tabId"]), x: x, y: y)
        default:
            guard let action = DashboardBrowserAction(rawValue: type) else {
                throw DashboardBrowserError.invalidRequest
            }
            return try .action(action, tabId: Self.identifier(payload["tabId"]))
        }
    }

    nonisolated static func url(_ value: Any?) throws -> URL {
        guard let string = value as? String, let url = URL(string: string),
              string == "about:blank" ||
              ((url.scheme?.lowercased() == "http" || url.scheme?.lowercased() == "https") &&
                  url.host?.isEmpty == false)
        else { throw DashboardBrowserError.invalidRequest }
        return url
    }

    private nonisolated static func identifier(_ value: Any?) throws -> String {
        guard let value = value as? String, !value.isEmpty,
              value == value.trimmingCharacters(in: .whitespacesAndNewlines)
        else { throw DashboardBrowserError.invalidRequest }
        return value
    }

    private nonisolated static func number(_ value: Any?) throws -> Double {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(),
              value.doubleValue.isFinite
        else { throw DashboardBrowserError.invalidRequest }
        return value.doubleValue
    }

    private nonisolated static func boolean(_ value: Any?) throws -> Bool {
        guard let value = value as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else {
            throw DashboardBrowserError.invalidRequest
        }
        return value.boolValue
    }
}
