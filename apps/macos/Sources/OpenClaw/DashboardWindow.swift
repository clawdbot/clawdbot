import AppKit
import Foundation
import OSLog

let dashboardWindowLogger = Logger(subsystem: "ai.openclaw", category: "DashboardWindow")

enum DashboardWindowLayout {
    static let windowSize = NSSize(width: 1240, height: 860)
    static let windowMinSize = NSSize(width: 922, height: 620)
    static let windowFrameAutosaveName = "OpenClawDashboardWindow"
}

/// Raw values are window event names the Control UI handles. `newSession`
/// reuses the shipped pre-web-chrome event; `commandPalette` gets a dedicated
/// toggle event because the legacy `native-open-search` contract is open-only.
enum DashboardNativeCommand: String {
    case newSession = "openclaw:native-new-session"
    case commandPalette = "openclaw:native-toggle-search"

    /// Older gateway bundles lack the toggle listener; dispatch degrades to the
    /// open-only legacy event when the primary event goes unhandled.
    var legacyFallbackEventName: String? {
        switch self {
        case .newSession: nil
        case .commandPalette: "openclaw:native-open-search"
        }
    }

    var supersedesPendingNavigation: Bool {
        self == .newSession
    }
}

struct DashboardNativeNavigation: Equatable {
    let path: String
    var search: String?
    let fallbackURL: URL
}

enum DashboardLinkTarget: String, Equatable {
    case inline
    case external
}

enum DashboardTargetlessNavigationAction: Equatable {
    case allow
    case openExternal
    case cancel
}

enum DashboardNewWindowAction: Equatable {
    case openTab(URL)
    case openExternal(URL)
    case ignore
}

struct DashboardLinkRequest: Equatable {
    let url: URL
    let target: DashboardLinkTarget
}

enum DashboardWindowAuth: Equatable {
    case sharedCredentials(gatewayUrl: String?, token: String?, password: String?)
    case browserIdentity(gatewayUrl: String)

    init(gatewayUrl: String?, token: String?, password: String?) {
        self = .sharedCredentials(gatewayUrl: gatewayUrl, token: token, password: password)
    }

    var gatewayUrl: String? {
        switch self {
        case let .sharedCredentials(gatewayUrl, _, _): gatewayUrl
        case let .browserIdentity(gatewayUrl): gatewayUrl
        }
    }

    var token: String? {
        guard case let .sharedCredentials(_, token, _) = self else { return nil }
        return token
    }

    var password: String? {
        guard case let .sharedCredentials(_, _, password) = self else { return nil }
        return password
    }

    var usesBrowserIdentity: Bool {
        if case .browserIdentity = self { return true }
        return false
    }

    var hasCredential: Bool {
        self.token?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ||
            self.password?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    }
}
