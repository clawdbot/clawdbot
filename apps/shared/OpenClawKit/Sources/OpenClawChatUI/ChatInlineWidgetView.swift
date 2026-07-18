import CryptoKit
import Foundation
import OpenClawKit
import SwiftUI

#if canImport(WebKit) && (os(iOS) || os(macOS))
import Security
import WebKit
#endif

enum OpenClawChatWidgetSurfaceRole: Sendable, Hashable {
    case node
    case operatorSurface
    case legacy
}

public struct OpenClawChatWidgetResource: Sendable, Equatable {
    public let url: URL
    public let tlsFingerprintSHA256: String?
    let surfaceRole: OpenClawChatWidgetSurfaceRole
    let attemptedSurfaceRoles: Set<OpenClawChatWidgetSurfaceRole>

    public init(url: URL, tlsFingerprintSHA256: String? = nil) {
        self.url = url
        self.tlsFingerprintSHA256 = tlsFingerprintSHA256
        self.surfaceRole = .legacy
        self.attemptedSurfaceRoles = []
    }

    init(
        url: URL,
        tlsFingerprintSHA256: String?,
        surfaceRole: OpenClawChatWidgetSurfaceRole,
        attemptedSurfaceRoles: Set<OpenClawChatWidgetSurfaceRole>)
    {
        self.url = url
        self.tlsFingerprintSHA256 = tlsFingerprintSHA256
        self.surfaceRole = surfaceRole
        self.attemptedSurfaceRoles = attemptedSurfaceRoles
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.url == rhs.url && lhs.tlsFingerprintSHA256 == rhs.tlsFingerprintSHA256
    }
}

public enum OpenClawChatWidgetURLResolver {
    private static let documentsPath = "/__openclaw__/canvas/documents"

    public static func resolve(surfaceURL rawSurfaceURL: String?, target rawTarget: String) -> URL? {
        guard let target = self.relativeWidgetTarget(rawTarget),
              var surface = self.capabilitySurface(rawSurfaceURL)
        else { return nil }

        var surfacePath = surface.percentEncodedPath
        while surfacePath.hasSuffix("/") {
            surfacePath.removeLast()
        }
        surface.percentEncodedPath = surfacePath + target.percentEncodedPath
        surface.percentEncodedQuery = target.percentEncodedQuery
        surface.fragment = target.fragment
        return surface.url
    }

    public static func supportsTarget(_ rawTarget: String) -> Bool {
        self.relativeWidgetTarget(rawTarget) != nil
    }

    public static func resolveResource(
        target: String,
        replacing failedResource: OpenClawChatWidgetResource?,
        currentSurfaceRoutes: @Sendable () async -> (
            node: GatewayCanvasHostRoute?,
            operatorSurface: GatewayCanvasHostRoute?),
        refreshNodeSurfaceRoute: @Sendable (GatewayCanvasHostRoute?) async -> GatewayCanvasHostRoute?,
        refreshOperatorSurfaceRoute: @Sendable (GatewayCanvasHostRoute?) async -> GatewayCanvasHostRoute?) async
        -> OpenClawChatWidgetResource?
    {
        let observed = await currentSurfaceRoutes()
        guard let failedResource else {
            return self.resolvePreferred(
                surfaces: observed,
                target: target,
                excluding: nil,
                blockedRoles: [],
                attemptedRoles: [])
        }
        let blockedRoles = failedResource.attemptedSurfaceRoles
        if failedResource.surfaceRole == .legacy,
           blockedRoles.contains(.legacy)
        {
            return nil
        }
        let attemptedRoles = blockedRoles.union([failedResource.surfaceRole])
        if !blockedRoles.contains(.node),
           let nodeSurface = observed.node,
           let currentNode = self.resolve(
               surface: nodeSurface,
               role: .node,
               target: target,
               attemptedRoles: attemptedRoles),
           self.isReplacement(currentNode, for: failedResource)
        {
            return currentNode
        }

        if !blockedRoles.contains(.node),
           let refreshedSurface = await refreshNodeSurfaceRoute(observed.node),
           let refreshed = resolve(
               surface: refreshedSurface,
               role: .node,
               target: target,
               attemptedRoles: attemptedRoles),
           self.isReplacement(refreshed, for: failedResource)
        {
            return refreshed
        }

        // A nil refresh can mean its route lease lost a reconnect race. Re-read
        // both roles so a replacement connection and its TLS pin win together.
        let afterNodeRefresh = await currentSurfaceRoutes()
        if let replacement = self.resolvePreferred(
            surfaces: afterNodeRefresh,
            target: target,
            excluding: failedResource,
            blockedRoles: blockedRoles,
            attemptedRoles: attemptedRoles)
        {
            return replacement
        }

        if !blockedRoles.contains(.operatorSurface),
           let refreshedSurface = await refreshOperatorSurfaceRoute(afterNodeRefresh.operatorSurface),
           let refreshed = resolve(
               surface: refreshedSurface,
               role: .operatorSurface,
               target: target,
               attemptedRoles: attemptedRoles),
           self.isReplacement(refreshed, for: failedResource)
        {
            return refreshed
        }

        return await self.resolvePreferred(
            surfaces: currentSurfaceRoutes(),
            target: target,
            excluding: failedResource,
            blockedRoles: blockedRoles,
            attemptedRoles: attemptedRoles)
    }

    private static func relativeWidgetTarget(_ rawTarget: String) -> URLComponents? {
        let target = rawTarget.trimmingCharacters(in: .whitespacesAndNewlines)
        guard target.hasPrefix("/"),
              let components = URLComponents(string: target),
              components.scheme == nil,
              components.host == nil,
              components.user == nil,
              components.password == nil,
              self.isCanonicalPath(components.percentEncodedPath),
              components.percentEncodedPath.hasPrefix("\(self.documentsPath)/")
        else { return nil }
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
        else { return nil }

        let segments = components.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: true)
        guard segments.count >= 3,
              segments[segments.count - 3] == "__openclaw__",
              segments[segments.count - 2] == "cap",
              let capability = String(segments[segments.count - 1]).removingPercentEncoding,
              !capability.isEmpty
        else { return nil }
        return components
    }

    private static func resolve(
        surface: GatewayCanvasHostRoute,
        role: OpenClawChatWidgetSurfaceRole,
        target: String,
        attemptedRoles: Set<OpenClawChatWidgetSurfaceRole>) -> OpenClawChatWidgetResource?
    {
        guard let url = resolve(surfaceURL: surface.url, target: target) else { return nil }
        let resource = OpenClawChatWidgetResource(
            url: url,
            tlsFingerprintSHA256: surface.tlsFingerprintSHA256,
            surfaceRole: role,
            attemptedSurfaceRoles: attemptedRoles)
        return resource.hasValidTLSBinding ? resource : nil
    }

    private static func resolvePreferred(
        surfaces: (node: GatewayCanvasHostRoute?, operatorSurface: GatewayCanvasHostRoute?),
        target: String,
        excluding failedResource: OpenClawChatWidgetResource?,
        blockedRoles: Set<OpenClawChatWidgetSurfaceRole>,
        attemptedRoles: Set<OpenClawChatWidgetSurfaceRole>) -> OpenClawChatWidgetResource?
    {
        [
            (role: OpenClawChatWidgetSurfaceRole.node, surface: surfaces.node),
            (role: OpenClawChatWidgetSurfaceRole.operatorSurface, surface: surfaces.operatorSurface),
        ]
            .lazy
            .filter { !blockedRoles.contains($0.role) }
            .compactMap { candidate in
                candidate.surface.flatMap {
                    self.resolve(
                        surface: $0,
                        role: candidate.role,
                        target: target,
                        attemptedRoles: attemptedRoles)
                }
            }
            .first { self.isReplacement($0, for: failedResource) }
    }

    private static func isReplacement(
        _ candidate: OpenClawChatWidgetResource,
        for failedResource: OpenClawChatWidgetResource?) -> Bool
    {
        guard let failedResource else { return true }
        // Legacy URL-only callers cannot express trust identity, so retain
        // their URL-only exclusion while resource-aware callers compare both.
        if failedResource.surfaceRole == .legacy,
           failedResource.tlsFingerprintSHA256 == nil
        {
            return candidate.url != failedResource.url
        }
        return candidate.url != failedResource.url ||
            candidate.tlsFingerprintSHA256 != failedResource.tlsFingerprintSHA256
    }

    private static func isWebURL(_ components: URLComponents) -> Bool {
        let scheme = components.scheme?.lowercased()
        return (scheme == "http" || scheme == "https") && components.host?.isEmpty == false
    }

    private static func isCanonicalPath(_ path: String) -> Bool {
        let segments = path.split(separator: "/", omittingEmptySubsequences: false)
        guard segments.first?.isEmpty == true else { return false }
        for (index, encodedSegment) in segments.enumerated() {
            if index == 0 || (index == segments.count - 1 && encodedSegment.isEmpty) {
                continue
            }
            guard !encodedSegment.isEmpty else { return false }
            guard let segment = self.decodeRepeatedly(String(encodedSegment)) else { return false }
            if segment == "." || segment == ".." || segment.contains("/") || segment.contains("\\") {
                return false
            }
        }
        return true
    }

    private static func decodeRepeatedly(_ encoded: String) -> String? {
        var value = encoded
        for _ in 0..<8 {
            guard let decoded = value.removingPercentEncoding else { return nil }
            if decoded == value { return decoded }
            value = decoded
        }
        return nil
    }
}

@MainActor
struct ChatInlineWidgetView: View {
    let preview: OpenClawChatCanvasPreview
    let resolverReady: Bool
    let resolveResource: @MainActor @Sendable (
        String,
        OpenClawChatWidgetResource?) async -> OpenClawChatWidgetResource?

    @State private var resolvedResource: OpenClawChatWidgetResource?
    @State private var recoveryAttempts = 0
    @State private var refreshInFlight = false
    @State private var unavailable = false
    @State private var activePath: String?
    /// A reset can keep the same path while installing a new connection route.
    /// Its generation prevents older resolver completions from restoring stale trust state.
    @State private var loadGeneration = UUID()

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let title = self.preview.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
                Text(title)
                    .font(OpenClawChatTypography.footnote)
                    .fontWeight(.semibold)
                    .foregroundStyle(OpenClawChatTheme.muted)
            }

            #if canImport(WebKit) && (os(iOS) || os(macOS))
            if let resolvedResource {
                ChatInlineWidgetWebView(
                    resource: resolvedResource,
                    allowsScripts: self.preview.sandbox == "scripts",
                    onFailure: { self.handleLoadFailure(resource: resolvedResource) })
                    .id([
                        resolvedResource.url.absoluteString,
                        resolvedResource.tlsFingerprintSHA256 ?? "",
                        self.preview.sandbox ?? "",
                    ].joined(separator: "\u{0}"))
                    .frame(height: self.preview.inlineWidgetHeight)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(OpenClawChatTheme.muted.opacity(0.24), lineWidth: 1)
                    }
            } else if self.unavailable {
                Text("Widget unavailable")
                    .font(OpenClawChatTypography.footnote)
                    .foregroundStyle(OpenClawChatTheme.muted)
            } else {
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity, minHeight: 44)
            }
            #else
            Text("Widget unavailable")
                .font(OpenClawChatTypography.footnote)
                .foregroundStyle(OpenClawChatTheme.muted)
            #endif
        }
        .task(id: LoadID(path: self.preview.inlineWidgetPath, resolverReady: self.resolverReady)) {
            let path = self.preview.inlineWidgetPath
            if self.activePath != path {
                self.reset(path: path)
            }
            guard self.resolverReady else { return }
            self.reset(path: path)
            guard let path else {
                self.unavailable = true
                return
            }
            await self.load(path: path, replacing: nil, generation: self.loadGeneration)
        }
    }

    private struct LoadID: Hashable {
        let path: String?
        let resolverReady: Bool
    }

    private func reset(path: String?) {
        self.loadGeneration = UUID()
        self.activePath = path
        self.resolvedResource = nil
        self.recoveryAttempts = 0
        self.refreshInFlight = false
        self.unavailable = false
    }

    private func load(
        path: String,
        replacing failedResource: OpenClawChatWidgetResource?,
        generation: UUID) async
    {
        let candidate = await self.resolveResource(path, failedResource)
        guard !Task.isCancelled,
              self.activePath == path,
              self.loadGeneration == generation
        else { return }
        let resource = candidate?.hasValidTLSBinding == true ? candidate : nil
        self.resolvedResource = resource
        self.unavailable = resource == nil
    }

    private func handleLoadFailure(resource: OpenClawChatWidgetResource) {
        guard self.resolvedResource == resource,
              let path = self.activePath,
              !self.refreshInFlight
        else { return }
        guard self.recoveryAttempts < 3 else {
            self.resolvedResource = nil
            self.unavailable = true
            return
        }
        self.recoveryAttempts += 1
        self.refreshInFlight = true
        let generation = self.loadGeneration
        Task { @MainActor in
            await self.load(path: path, replacing: resource, generation: generation)
            guard self.activePath == path, self.loadGeneration == generation else { return }
            self.refreshInFlight = false
        }
    }
}

extension OpenClawChatWidgetResource {
    fileprivate var hasValidTLSBinding: Bool {
        self.tlsFingerprintSHA256 == nil || self.url.scheme?.lowercased() == "https"
    }
}

#if canImport(WebKit) && (os(iOS) || os(macOS))
enum ChatInlineWidgetTLSPin {
    static func normalize(_ raw: String) -> String? {
        let stripped = raw.replacingOccurrences(
            of: #"(?i)^sha-?256\s*:?\s*"#,
            with: "",
            options: .regularExpression)
        let normalized = stripped.lowercased().filter(\.isHexDigit)
        return normalized.count == 64 ? normalized : nil
    }

    static func fingerprint(certificateData: Data) -> String {
        SHA256.hash(data: certificateData).map { String(format: "%02x", $0) }.joined()
    }

    static func matches(_ expected: String, trust: SecTrust) -> Bool {
        guard let expected = normalize(expected),
              let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let certificate = chain.first
        else { return false }
        return self.fingerprint(certificateData: SecCertificateCopyData(certificate) as Data) == expected
    }
}

struct ChatInlineWidgetContentProcessRecovery {
    enum Action: Equatable {
        case reload
        case fail
    }

    private var didReload = false

    mutating func nextAction() -> Action {
        guard !self.didReload else { return .fail }
        self.didReload = true
        return .reload
    }

    mutating func reset() {
        self.didReload = false
    }
}

@MainActor
private final class ChatInlineWidgetNavigationDelegate: NSObject, WKNavigationDelegate {
    var resource: OpenClawChatWidgetResource {
        didSet {
            if self.resource != oldValue {
                self.contentProcessRecovery.reset()
            }
        }
    }

    let onFailure: @MainActor @Sendable () -> Void
    private var contentProcessRecovery = ChatInlineWidgetContentProcessRecovery()

    init(resource: OpenClawChatWidgetResource, onFailure: @escaping @MainActor @Sendable () -> Void) {
        self.resource = resource
        self.onFailure = onFailure
    }

    func webView(
        _: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void)
    {
        if navigationAction.targetFrame?.isMainFrame == false {
            decisionHandler(.cancel)
            return
        }
        guard navigationAction.request.httpMethod?.caseInsensitiveCompare("GET") == .orderedSame,
              let url = navigationAction.request.url,
              self.matchesExpectedDocument(url)
        else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(
        _: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void)
    {
        if navigationResponse.isForMainFrame,
           let response = navigationResponse.response as? HTTPURLResponse,
           response.statusCode >= 400
        {
            self.onFailure()
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_: WKWebView, didFailProvisionalNavigation _: WKNavigation?, withError _: any Error) {
        self.onFailure()
    }

    func webView(_: WKWebView, didFail _: WKNavigation?, withError _: any Error) {
        self.onFailure()
    }

    func webView(
        _: WKWebView,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping @MainActor @Sendable (
            URLSession.AuthChallengeDisposition,
            URLCredential?) -> Void)
    {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let expectedFingerprint = resource.tlsFingerprintSHA256
        else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        guard self.matchesExpectedProtectionSpace(challenge.protectionSpace),
              let trust = challenge.protectionSpace.serverTrust,
              ChatInlineWidgetTLSPin.matches(expectedFingerprint, trust: trust)
        else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            self.onFailure()
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // One same-document recovery handles incidental process loss. A second
        // termination enters the view's bounded capability-refresh/failure path.
        switch self.contentProcessRecovery.nextAction() {
        case .reload:
            webView.load(URLRequest(url: self.resource.url, cachePolicy: .reloadIgnoringLocalCacheData))
        case .fail:
            self.onFailure()
        }
    }

    private func matchesExpectedDocument(_ candidate: URL) -> Bool {
        guard var expected = URLComponents(url: self.resource.url, resolvingAgainstBaseURL: false),
              var candidate = URLComponents(url: candidate, resolvingAgainstBaseURL: false)
        else { return false }
        expected.fragment = nil
        candidate.fragment = nil
        return expected == candidate
    }

    private func matchesExpectedProtectionSpace(_ protectionSpace: URLProtectionSpace) -> Bool {
        guard let expectedHost = self.resource.url.host,
              protectionSpace.host.caseInsensitiveCompare(expectedHost) == .orderedSame
        else { return false }
        let expectedPort = self.resource.url.port ?? (self.resource.url.scheme?.lowercased() == "https" ? 443 : 80)
        return protectionSpace.port == expectedPort
    }
}

@MainActor
private func makeChatInlineWidgetWebView(
    resource: OpenClawChatWidgetResource,
    allowsScripts: Bool,
    coordinator: ChatInlineWidgetNavigationDelegate) -> WKWebView
{
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.defaultWebpagePreferences.allowsContentJavaScript = allowsScripts
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = coordinator
    webView.allowsLinkPreview = false
    webView.load(URLRequest(url: resource.url, cachePolicy: .reloadIgnoringLocalCacheData))
    return webView
}

#if os(iOS)
private struct ChatInlineWidgetWebView: UIViewRepresentable {
    let resource: OpenClawChatWidgetResource
    let allowsScripts: Bool
    let onFailure: @MainActor @Sendable () -> Void

    func makeCoordinator() -> ChatInlineWidgetNavigationDelegate {
        ChatInlineWidgetNavigationDelegate(resource: self.resource, onFailure: self.onFailure)
    }

    func makeUIView(context: Context) -> WKWebView {
        makeChatInlineWidgetWebView(
            resource: self.resource,
            allowsScripts: self.allowsScripts,
            coordinator: context.coordinator)
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.resource != self.resource else { return }
        context.coordinator.resource = self.resource
        webView.load(URLRequest(url: self.resource.url, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: ChatInlineWidgetNavigationDelegate) {
        webView.stopLoading()
        webView.navigationDelegate = nil
    }
}
#elseif os(macOS)
private struct ChatInlineWidgetWebView: NSViewRepresentable {
    let resource: OpenClawChatWidgetResource
    let allowsScripts: Bool
    let onFailure: @MainActor @Sendable () -> Void

    func makeCoordinator() -> ChatInlineWidgetNavigationDelegate {
        ChatInlineWidgetNavigationDelegate(resource: self.resource, onFailure: self.onFailure)
    }

    func makeNSView(context: Context) -> WKWebView {
        makeChatInlineWidgetWebView(
            resource: self.resource,
            allowsScripts: self.allowsScripts,
            coordinator: context.coordinator)
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.resource != self.resource else { return }
        context.coordinator.resource = self.resource
        webView.load(URLRequest(url: self.resource.url, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    static func dismantleNSView(_ webView: WKWebView, coordinator: ChatInlineWidgetNavigationDelegate) {
        webView.stopLoading()
        webView.navigationDelegate = nil
    }
}
#endif
#endif
