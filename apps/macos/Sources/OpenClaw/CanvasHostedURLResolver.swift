import Foundation

struct CanvasHostedTarget: Equatable {
    let url: URL
    let allowsA2UIActions: Bool
}

enum CanvasHostedURLResolver {
    private static let canvasPath = "/__openclaw__/canvas"
    private static let a2uiPath = "/__openclaw__/a2ui"
    private static let capabilityMarker = "/__openclaw__/cap/"

    static func resolve(surfaceURL rawSurfaceURL: String?, target rawTarget: String) -> CanvasHostedTarget? {
        guard let target = self.relativeHostedTarget(rawTarget),
              var surface = self.capabilitySurface(rawSurfaceURL)
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
        guard let url = surface.url else { return nil }
        return CanvasHostedTarget(
            url: url,
            allowsA2UIActions: self.isA2UIPath(target.percentEncodedPath))
    }

    static func resolveA2UIURL(surfaceURL: String?) -> String? {
        self.resolve(
            surfaceURL: surfaceURL,
            target: "\(self.a2uiPath)/?platform=macos")?.url.absoluteString
    }

    static func isHostedTarget(_ rawTarget: String) -> Bool {
        self.relativeHostedTarget(rawTarget) != nil
    }

    static func isCapabilityScopedA2UIURL(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              self.isWebURL(components),
              let marker = components.percentEncodedPath.range(of: self.capabilityMarker)
        else {
            return false
        }
        let suffix = components.percentEncodedPath[marker.upperBound...]
        guard let separator = suffix.firstIndex(of: "/"), separator != suffix.startIndex else {
            return false
        }
        let encodedCapability = String(suffix[..<separator])
        guard let capability = encodedCapability.removingPercentEncoding, !capability.isEmpty else {
            return false
        }
        let hostedPath = String(suffix[separator...])
        return self.isCanonicalHostedPath(hostedPath) && self.isA2UIPath(hostedPath)
    }

    private static func relativeHostedTarget(_ rawTarget: String) -> URLComponents? {
        let target = rawTarget.trimmingCharacters(in: .whitespacesAndNewlines)
        guard target.hasPrefix("/"),
              let components = URLComponents(string: target),
              components.scheme == nil,
              components.host == nil,
              components.user == nil,
              components.password == nil,
              self.isCanonicalHostedPath(components.percentEncodedPath),
              self.isCanvasPath(components.percentEncodedPath) || self.isA2UIPath(components.percentEncodedPath)
        else {
            return nil
        }
        return components
    }

    private static func capabilitySurface(_ rawSurfaceURL: String?) -> URLComponents? {
        let raw = rawSurfaceURL?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !raw.isEmpty,
              let components = URLComponents(string: raw),
              self.isWebURL(components),
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
                if decoded == segment { break }
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

    private static func isA2UIPath(_ path: String) -> Bool {
        path == self.a2uiPath || path.hasPrefix("\(self.a2uiPath)/")
    }
}
