import AppKit
import WebKit

extension CanvasWindowController {
    // MARK: - WKUIDelegate

    /// Bridges `<input type="file">` clicks in canvas HTML to a native `NSOpenPanel`.
    /// Without a `WKUIDelegate`, WebKit silently drops the request and file-picker
    /// buttons in canvas pages do nothing.
    @MainActor
    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void)
    {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.resolvesAliases = true
        if let window = self.window {
            panel.beginSheetModal(for: window) { response in
                completionHandler(response == .OK ? panel.urls : nil)
            }
            return
        }
        panel.begin { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }
}
