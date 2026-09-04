#if canImport(WebKit) && (os(iOS) || os(macOS))
import Foundation
import WebKit

@MainActor
enum ChatMermaidResources {
    static let scheme = "openclaw-mermaid"
    static let documentURL = URL(string: "openclaw-mermaid://renderer/index.html")!

    static func directory() -> URL? {
        #if os(macOS)
        if Bundle.main.bundleURL.pathExtension == "app" {
            // The signed macOS package keeps SwiftPM sidecars in Contents/Resources.
            // Bundle.module may trap when searching beside the app executable.
            guard let url = Bundle.main.url(forResource: "OpenClawKit_OpenClawChatUI", withExtension: "bundle"),
                  let bundle = Bundle(url: url)
            else { return nil }
            return bundle.url(forResource: "Mermaid", withExtension: nil)
        }
        #endif
        return Bundle.module.url(forResource: "Mermaid", withExtension: nil)
    }
}

@MainActor
final class ChatMermaidSchemeHandler: NSObject, WKURLSchemeHandler {
    private struct Resource {
        let data: Data
        let mime: String
    }

    private let resources: [String: Resource]

    init(directory: URL) throws {
        var resources: [String: Resource] = [:]
        for filename in ["index.html", "native.js", "frame.js", "mermaid.min.js"] {
            let url = directory.appendingPathComponent(filename, isDirectory: false)
            resources["openclaw-mermaid://renderer/\(filename)"] = try Resource(
                data: Data(contentsOf: url, options: .mappedIfSafe),
                mime: filename == "index.html" ? "text/html" : "application/javascript")
        }
        self.resources = resources
        super.init()
    }

    func webView(_: WKWebView, start task: WKURLSchemeTask) {
        guard task.request.httpMethod == "GET",
              let url = task.request.url,
              let resource = self.resources[url.absoluteString]
        else {
            task.didFailWithError(URLError(.unsupportedURL))
            return
        }
        task.didReceive(URLResponse(
            url: url,
            mimeType: resource.mime,
            expectedContentLength: resource.data.count,
            textEncodingName: "utf-8"))
        task.didReceive(resource.data)
        task.didFinish()
    }

    func webView(_: WKWebView, stop _: WKURLSchemeTask) {
        // All four immutable resources complete synchronously on the main actor.
    }
}
#endif
