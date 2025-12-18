import Foundation
import OSLog
import WebKit

private let canvasLogger = Logger(subsystem: "com.steipete.clawdis", category: "Canvas")

final class CanvasSchemeHandler: NSObject, WKURLSchemeHandler {
    private let root: URL

    private static let builtinPrefix = "__clawdis__/a2ui"

    init(root: URL) {
        self.root = root
    }

    func webView(_: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(NSError(domain: "Canvas", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "missing url",
            ]))
            return
        }

        let response = self.response(for: url)
        let mime = response.mime
        let data = response.data
        let encoding = self.textEncodingName(forMimeType: mime)

        let urlResponse = URLResponse(
            url: url,
            mimeType: mime,
            expectedContentLength: data.count,
            textEncodingName: encoding)
        urlSchemeTask.didReceive(urlResponse)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_: WKWebView, stop _: WKURLSchemeTask) {
        // no-op
    }

    private struct CanvasResponse {
        let mime: String
        let data: Data
    }

    private func response(for url: URL) -> CanvasResponse {
        guard url.scheme == CanvasScheme.scheme else {
            return self.html("Invalid scheme.")
        }
        guard let session = url.host, !session.isEmpty else {
            return self.html("Missing session.")
        }

        // Keep session component safe; don't allow slashes or traversal.
        if session.contains("/") || session.contains("..") {
            return self.html("Invalid session.")
        }

        let sessionRoot = self.root.appendingPathComponent(session, isDirectory: true)

        // Path mapping: request path maps directly into the session dir.
        var path = url.path
        if let qIdx = path.firstIndex(of: "?") { path = String(path[..<qIdx]) }
        if path.hasPrefix("/") { path.removeFirst() }
        path = path.removingPercentEncoding ?? path

        if let builtin = self.builtinResponse(requestPath: path) {
            return builtin
        }

        // Special-case: welcome page when root index is missing.
        if path.isEmpty {
            let indexA = sessionRoot.appendingPathComponent("index.html", isDirectory: false)
            let indexB = sessionRoot.appendingPathComponent("index.htm", isDirectory: false)
            if !FileManager.default.fileExists(atPath: indexA.path),
               !FileManager.default.fileExists(atPath: indexB.path)
            {
                return self.a2uiShellPage(sessionRoot: sessionRoot)
            }
        }

        let resolved = self.resolveFileURL(sessionRoot: sessionRoot, requestPath: path)
        guard let fileURL = resolved else {
            return self.html("Not Found", title: "Canvas: 404")
        }

        // Directory traversal guard: served files must live under the session root.
        let standardizedRoot = sessionRoot.standardizedFileURL
        let standardizedFile = fileURL.standardizedFileURL
        guard standardizedFile.path.hasPrefix(standardizedRoot.path) else {
            return self.html("Forbidden", title: "Canvas: 403")
        }

        do {
            let data = try Data(contentsOf: standardizedFile)
            let mime = CanvasScheme.mimeType(forExtension: standardizedFile.pathExtension)
            let servedPath = standardizedFile.path
            canvasLogger.debug(
                "served \(session, privacy: .public)/\(path, privacy: .public) -> \(servedPath, privacy: .public)")
            return CanvasResponse(mime: mime, data: data)
        } catch {
            let failedPath = standardizedFile.path
            let errorText = error.localizedDescription
            canvasLogger
                .error(
                    "failed reading \(failedPath, privacy: .public): \(errorText, privacy: .public)")
            return self.html("Failed to read file.", title: "Canvas error")
        }
    }

    private func resolveFileURL(sessionRoot: URL, requestPath: String) -> URL? {
        let fm = FileManager.default
        var candidate = sessionRoot.appendingPathComponent(requestPath, isDirectory: false)

        var isDir: ObjCBool = false
        if fm.fileExists(atPath: candidate.path, isDirectory: &isDir) {
            if isDir.boolValue {
                if let idx = self.resolveIndex(in: candidate) { return idx }
                return nil
            }
            return candidate
        }

        // Directory index behavior:
        // - "/yolo" serves "<yolo>/index.html" if that directory exists.
        if !requestPath.isEmpty, !requestPath.hasSuffix("/") {
            candidate = sessionRoot.appendingPathComponent(requestPath, isDirectory: true)
            if fm.fileExists(atPath: candidate.path, isDirectory: &isDir), isDir.boolValue {
                if let idx = self.resolveIndex(in: candidate) { return idx }
            }
        }

        // Root fallback:
        // - "/" serves "<sessionRoot>/index.html" if present.
        if requestPath.isEmpty {
            return self.resolveIndex(in: sessionRoot)
        }

        return nil
    }

    private func resolveIndex(in dir: URL) -> URL? {
        let fm = FileManager.default
        let a = dir.appendingPathComponent("index.html", isDirectory: false)
        if fm.fileExists(atPath: a.path) { return a }
        let b = dir.appendingPathComponent("index.htm", isDirectory: false)
        if fm.fileExists(atPath: b.path) { return b }
        return nil
    }

    private func html(_ body: String, title: String = "Canvas") -> CanvasResponse {
        let html = """
        <!doctype html>
        <html>
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>\(title)</title>
            <style>
              :root { color-scheme: light; }
              html,body { height:100%; margin:0; }
              body {
                font: 13px -apple-system, system-ui;
                display:flex;
                align-items:center;
                justify-content:center;
                background: #fff;
                color:#111827;
              }
              .card {
                max-width: 520px;
                padding: 18px 18px;
                border-radius: 12px;
                border: 1px solid rgba(0,0,0,.08);
                box-shadow: 0 10px 30px rgba(0,0,0,.08);
              }
              .muted { color:#6b7280; margin-top:8px; }
              code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
            </style>
          </head>
          <body>
            <div class="card">
              <div>\(body)</div>
            </div>
          </body>
        </html>
        """
        return CanvasResponse(mime: "text/html", data: Data(html.utf8))
    }

    private func welcomePage(sessionRoot: URL) -> CanvasResponse {
        let escaped = sessionRoot.path
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
        let body = """
        <div style="font-weight:600; font-size:14px;">Canvas is ready.</div>
        <div class="muted">Create <code>index.html</code> in:</div>
        <div style="margin-top:10px;"><code>\(escaped)</code></div>
        """
        return self.html(body, title: "Canvas")
    }

    private func a2uiShellPage(sessionRoot: URL) -> CanvasResponse {
        // Default Canvas UX: when no index exists, show the built-in A2UI shell.
        if let data = self.loadBundledResourceData(subdirectory: "CanvasA2UI", relativePath: "index.html") {
            return CanvasResponse(mime: "text/html", data: data)
        }

        // Fallback for dev misconfiguration: show the classic welcome page.
        return self.welcomePage(sessionRoot: sessionRoot)
    }

    private func builtinResponse(requestPath: String) -> CanvasResponse? {
        let trimmed = requestPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        guard trimmed == Self.builtinPrefix
            || trimmed == Self.builtinPrefix + "/"
            || trimmed.hasPrefix(Self.builtinPrefix + "/")
        else { return nil }

        let relative = if trimmed == Self.builtinPrefix || trimmed == Self.builtinPrefix + "/" {
            "index.html"
        } else {
            String(trimmed.dropFirst((Self.builtinPrefix + "/").count))
        }

        if relative.isEmpty { return self.html("Not Found", title: "Canvas: 404") }
        if relative.contains("..") || relative.contains("\\") {
            return self.html("Forbidden", title: "Canvas: 403")
        }

        guard let data = self.loadBundledResourceData(subdirectory: "CanvasA2UI", relativePath: relative) else {
            return self.html("Not Found", title: "Canvas: 404")
        }

        let ext = (relative as NSString).pathExtension
        let mime = CanvasScheme.mimeType(forExtension: ext)
        return CanvasResponse(mime: mime, data: data)
    }

    private func loadBundledResourceData(subdirectory: String, relativePath: String) -> Data? {
        guard let base = Bundle.module.resourceURL?.appendingPathComponent(subdirectory, isDirectory: true) else {
            return nil
        }
        let url = base.appendingPathComponent(relativePath, isDirectory: false)
        return try? Data(contentsOf: url)
    }

    private func textEncodingName(forMimeType mimeType: String) -> String? {
        if mimeType.hasPrefix("text/") { return "utf-8" }
        switch mimeType {
        case "application/javascript", "application/json", "image/svg+xml":
            return "utf-8"
        default:
            return nil
        }
    }
}
