import AppKit
import Foundation
import OSLog

let dashboardWindowLogger = Logger(subsystem: "ai.openclaw", category: "DashboardWindow")

enum DashboardWindowLayout {
    static let windowSize = NSSize(width: 1240, height: 860)
    static let mainBrowserMinWidth: CGFloat = 601
    static let linkBrowserMinWidth: CGFloat = 320
    static let windowMinSize = NSSize(
        width: DashboardWindowLayout.mainBrowserMinWidth + DashboardWindowLayout.linkBrowserMinWidth + 1,
        height: 620)
    static let linkBrowserPreferredFraction: CGFloat = 0.5
    static let linkBrowserTabBarHeight: CGFloat = 30
    static let linkBrowserToolbarHeight: CGFloat = 52
    static let linkBrowserToolbarWithTabsHeight: CGFloat = 78
    static let linkBrowserWidthDefaultsKey = "OpenClawDashboardLinkBrowserWidth"
    static let windowFrameAutosaveName = "OpenClawDashboardWindow"

    static func linkBrowserWidth(
        splitWidth: CGFloat,
        dividerThickness: CGFloat,
        persistedWidth: CGFloat?) -> CGFloat
    {
        let availableWidth = max(0, splitWidth - dividerThickness)
        let maximumWidth = max(0, availableWidth - self.mainBrowserMinWidth)
        guard maximumWidth >= self.linkBrowserMinWidth else { return maximumWidth }
        let preferredWidth = if let persistedWidth, persistedWidth.isFinite, persistedWidth > 0 {
            persistedWidth
        } else {
            availableWidth * self.linkBrowserPreferredFraction
        }
        return min(max(preferredWidth, self.linkBrowserMinWidth), maximumWidth)
    }

    static func dividerMoved(from originalPosition: CGFloat?, to finalPosition: CGFloat?) -> Bool {
        guard let originalPosition, let finalPosition else { return false }
        return abs(finalPosition - originalPosition) >= 0.5
    }
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
