import Foundation
import WebKit

extension DashboardWindowController {
    static func isTrustedLinkSource(_ sourceURL: URL?, dashboardURL: URL) -> Bool {
        guard let sourceURL, sameOrigin(sourceURL, dashboardURL) else { return false }
        let allowedPath = Self.allowedPath(for: dashboardURL)
        return allowedPath == "/" || sourceURL.path(percentEncoded: true).hasPrefix(allowedPath)
    }

    static func shouldAllowEditorURLLaunch(
        from sourceURL: URL?,
        isMainFrame: Bool,
        dashboardURL: URL) -> Bool
    {
        isMainFrame && self.isTrustedLinkSource(sourceURL, dashboardURL: dashboardURL)
    }

    static func isHTTPURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              url.host?.isEmpty == false
        else {
            return false
        }
        return true
    }

    static func isExternalURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        if scheme == "http" || scheme == "https" {
            return self.isHTTPURL(url)
        }
        return scheme == "mailto" || scheme == "tel"
    }

    static func isEditorURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(),
              url.host?.lowercased() == "file",
              !url.path.isEmpty
        else {
            return false
        }
        return scheme == "cursor" || scheme == "vscode" || scheme == "windsurf" || scheme == "zed"
    }

    static func shouldAllowNavigation(
        to url: URL,
        dashboardURL: URL,
        isMainFrame: Bool,
        isTrustedDashboardSource: Bool = false) -> Bool
    {
        guard let scheme = url.scheme?.lowercased() else { return true }
        if scheme == "about" || scheme == "blob" || scheme == "data" {
            return true
        }
        guard scheme == "http" || scheme == "https", url.user == nil, url.password == nil else { return false }
        let host = url.host?.lowercased()
        if self.sameOrigin(url, dashboardURL) {
            return true
        }
        guard !isMainFrame,
              isTrustedDashboardSource,
              host?.isEmpty == false,
              url.user == nil,
              url.password == nil
        else {
            return false
        }
        let components = url.path.split(separator: "/", omittingEmptySubsequences: true)
        return url.path(percentEncoded: true) == "/mcp-app-sandbox" || (components.count == 4 &&
            components[0] == "embed" &&
            (components[1] == "channel" || components[1] == "thread"))
    }

    static func shouldAllowBrowserNavigation(to url: URL, isMainFrame: Bool) -> Bool {
        if isMainFrame {
            return self.isHTTPURL(url)
        }
        guard let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "about" || scheme == "blob" || scheme == "data" || self.isHTTPURL(url)
    }

    static func shouldAllowIdentityNavigation(
        to url: URL,
        auth: DashboardWindowAuth,
        isMainFrame: Bool,
        sourceIsDashboard: Bool,
        navigationType: WKNavigationType) -> Bool
    {
        guard auth.usesBrowserIdentity, url.scheme?.lowercased() == "https",
              url.host?.isEmpty == false, url.user == nil, url.password == nil else { return false }
        // Dashboard links keep their browser handoff. Redirects and the identity
        // provider's links/forms stay here so its cookies authenticate the returning page.
        return sourceIsDashboard ? isMainFrame && navigationType != .linkActivated : true
    }

    static func shouldOpenExternalDashboardNavigation(
        _ url: URL,
        navigationType: WKNavigationType,
        buttonNumber: Int) -> Bool
    {
        // WebKit also labels synthetic anchor.click() as linkActivated. Its
        // action reports button 0; a physical primary click reports 1 here.
        navigationType == .linkActivated && buttonNumber > 0 && self.isExternalURL(url)
    }

    static func targetlessNavigationAction(
        for url: URL,
        navigationType: WKNavigationType,
        buttonNumber: Int,
        allowEditorURLs: Bool) -> DashboardTargetlessNavigationAction
    {
        if self.isHTTPURL(url) {
            return .allow
        }
        // The trusted Control UI's file sidebar opens these explicit editor URLs
        // with window.open(); never grant the same synthetic-launch path to web content.
        if allowEditorURLs, self.isEditorURL(url) {
            return .openExternal
        }
        if self.shouldOpenExternalDashboardNavigation(
            url,
            navigationType: navigationType,
            buttonNumber: buttonNumber)
        {
            return .openExternal
        }
        return .cancel
    }

    static func newWindowAction(for url: URL?, sourceIsLinkBrowser: Bool) -> DashboardNewWindowAction {
        guard let url, self.isHTTPURL(url) else { return .ignore }
        return sourceIsLinkBrowser ? .openTab(url) : .openExternal(url)
    }

    private static func sameOrigin(_ lhs: URL, _ rhs: URL) -> Bool {
        self.isHTTPURL(lhs) && self.isHTTPURL(rhs) &&
            self.originString(for: lhs) == self.originString(for: rhs)
    }

    static func isTrustedMediaCaptureOrigin(
        protocol scheme: String,
        host: String,
        port: Int,
        dashboardURL: URL) -> Bool
    {
        guard scheme.caseInsensitiveCompare(dashboardURL.scheme ?? "") == .orderedSame,
              host.caseInsensitiveCompare(dashboardURL.host ?? "") == .orderedSame
        else {
            return false
        }
        let requestedPort = port == 0 ? Self.defaultPort(for: scheme) : port
        let dashboardPort = dashboardURL.port ?? Self.defaultPort(for: dashboardURL.scheme)
        return requestedPort == dashboardPort
    }

    static func defaultPort(for scheme: String?) -> Int? {
        switch scheme?.lowercased() {
        case "http": 80
        case "https": 443
        default: nil
        }
    }
}
