import Foundation

enum CanvasHostedURLResolver {
    private static let canvasPath = "/__openclaw__/canvas"

    static func resolve(surfaceURL rawSurfaceURL: String?, target rawTarget: String) -> URL? {
        guard let target = relativeHostedTarget(rawTarget),
              var surface = capabilitySurface(rawSurfaceURL)
        else {
            return nil
        }

        var surfacePath = surface.percentEncodedPath
        while surfacePath.hasSuffix("/") {
            surfacePath.removeLast()
        }
        surface.percentEncodedPath = surfacePath + target.percentEncodedPath
        surface.percentEncodedQuery = target.percentEncodedQuery
        surface.fragment = target.fragment
        return surface.url
    }

    static func isHostedTarget(_ rawTarget: String) -> Bool {
        self.relativeHostedTarget(rawTarget) != nil
    }

    static func isAppLocalTarget(_ rawTarget: String) -> Bool {
        let target = rawTarget.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: target),
              components.scheme?.lowercased() == CanvasScheme.scheme,
              components.host?.isEmpty == false,
              components.user == nil,
              components.password == nil,
              components.port == nil,
              components.percentEncodedPath.isEmpty ||
              isCanonicalHostedPath(components.percentEncodedPath)
        else {
            return false
        }
        return true
    }

    private static func relativeHostedTarget(_ rawTarget: String) -> URLComponents? {
        let target = rawTarget.trimmingCharacters(in: .whitespacesAndNewlines)
        guard target.hasPrefix("/"),
              let components = URLComponents(string: target),
              components.scheme == nil,
              components.host == nil,
              components.user == nil,
              components.password == nil,
              isCanonicalHostedPath(components.percentEncodedPath),
              isCanvasPath(components.percentEncodedPath)
        else {
            return nil
        }
        return components
    }

    private static func capabilitySurface(_ rawSurfaceURL: String?) -> URLComponents? {
        let raw = rawSurfaceURL?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !raw.isEmpty,
              let components = URLComponents(string: raw),
              isWebURL(components),
              components.user == nil,
              components.password == nil,
              components.percentEncodedQuery == nil,
              components.fragment == nil
        else {
            return nil
        }

        let segments = components.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: true)
        guard segments.count >= 3,
              segments[segments.count - 3] == "__openclaw__",
              segments[segments.count - 2] == "cap",
              let capability = String(segments[segments.count - 1]).removingPercentEncoding,
              !capability.isEmpty
        else {
            return nil
        }
        return components
    }

    private static func isWebURL(_ components: URLComponents) -> Bool {
        let scheme = components.scheme?.lowercased()
        return (scheme == "http" || scheme == "https") && components.host?.isEmpty == false
    }

    private static func isCanonicalHostedPath(_ path: String) -> Bool {
        let segments = path.split(separator: "/", omittingEmptySubsequences: false)
        guard segments.first?.isEmpty == true else { return false }

        for (index, encodedSegment) in segments.enumerated() {
            if index == 0 || (index == segments.count - 1 && encodedSegment.isEmpty) {
                continue
            }
            guard !encodedSegment.isEmpty else { return false }
            var segment = String(encodedSegment)
            while true {
                guard let decoded = segment.removingPercentEncoding else { return false }
                if decoded == segment {
                    break
                }
                segment = decoded
            }
            if segment == "." || segment == ".." || segment.contains("/") || segment.contains("\\") {
                return false
            }
        }
        return true
    }

    private static func isCanvasPath(_ path: String) -> Bool {
        path == self.canvasPath || path.hasPrefix("\(self.canvasPath)/")
    }
}
