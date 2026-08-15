import Foundation

enum CanvasScheme {
    static let scheme = "openclaw-canvas"
    static let allSchemes = [scheme]

    static func makeURL(session: String, path: String? = nil) -> URL? {
        var comps = URLComponents()
        comps.scheme = Self.scheme
        comps.host = session
        let p = (path ?? "/").trimmingCharacters(in: .whitespacesAndNewlines)
        if p.isEmpty || p == "/" {
            comps.path = "/"
        } else if p.hasPrefix("/") {
            comps.path = p
        } else {
            comps.path = "/" + p
        }
        return comps.url
    }

    static func mimeType(forExtension ext: String) -> String {
        switch ext.lowercased() {
        // Note: WKURLSchemeHandler uses URLResponse(mimeType:), which expects a bare MIME type
        // (no `; charset=...`). Encoding is provided via URLResponse(textEncodingName:).
        case "html", "htm": "text/html"
        case "js", "mjs": "application/javascript"
        case "css": "text/css"
        case "json", "map": "application/json"
        case "svg": "image/svg+xml"
        case "png": "image/png"
        case "jpg", "jpeg": "image/jpeg"
        case "gif": "image/gif"
        case "ico": "image/x-icon"
        case "woff2": "font/woff2"
        case "woff": "font/woff"
        case "ttf": "font/ttf"
        case "wasm": "application/wasm"
        default: "application/octet-stream"
        }
    }
}
