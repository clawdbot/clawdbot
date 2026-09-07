import Foundation

enum WebContentWorkspaceURL {
    /// Schemes web content may hand to NSWorkspace.open: http, https, mailto, tel.
    /// file://, smb://, and app URL handlers stay closed.
    static func isAllowed(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        if scheme == "http" || scheme == "https" {
            return url.host?.isEmpty == false
        }
        return scheme == "mailto" || scheme == "tel"
    }
}
