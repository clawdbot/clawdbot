import AppKit
import Foundation
import OSLog

let dashboardWindowLogger = Logger(subsystem: "ai.openclaw", category: "DashboardWindow")

enum DashboardWindowLayout {
    static let windowSize = NSSize(width: 1240, height: 860)
    static let windowMinSize = NSSize(width: 900, height: 620)
    static let mainBrowserMinWidth: CGFloat = 520
    static let linkBrowserMinWidth: CGFloat = 320
    static let linkBrowserMaxWidth: CGFloat = 760
    static let linkBrowserPreferredFraction: CGFloat = 0.4
    static let linkBrowserTabBarHeight: CGFloat = 30
    static let linkBrowserSplitAutosaveName = "OpenClawDashboardLinkBrowserSplit"
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

struct DashboardWindowAuth: Equatable {
    var gatewayUrl: String?
    var token: String?
    var password: String?

    var hasCredential: Bool {
        self.token?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ||
            self.password?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
    }
}

/// Dashboard URLs carry the auth token in the `#token=...` fragment; strip the
/// fragment before logging so credentials never land in unified logs.
func dashboardLogString(for url: URL) -> String {
    guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
        return "<unparseable-url>"
    }
    components.fragment = nil
    return components.url?.absoluteString ?? "<unparseable-url>"
}
