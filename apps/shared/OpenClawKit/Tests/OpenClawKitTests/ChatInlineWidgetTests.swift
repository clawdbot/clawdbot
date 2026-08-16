import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

struct ChatInlineWidgetTests {
    @Test func `sanitizes widget export filenames`() {
        #expect(ChatInlineWidgetExport.filename(title: "  Sales / Q3\\Summary\u{0007}  ") ==
            "Sales  Q3Summary.png")
        #expect(ChatInlineWidgetExport.filename(title: "\n\t") == "widget.png")
        #expect(ChatInlineWidgetExport.filename(title: nil) == "widget.png")
    }

    @Test func `decodes projected canvas widget block`() throws {
        let data = Data(#"""
        {
          "role": "assistant",
          "content": [
            {"type": "text", "text": "Done"},
            {
              "type": "canvas",
              "preview": {
                "kind": "canvas",
                "surface": "assistant_message",
                "render": "url",
                "title": "Status",
                "preferredHeight": 240,
                "url": "/__openclaw__/canvas/documents/widget-1/index.html",
                "sandbox": "scripts"
              }
            }
          ]
        }
        """#.utf8)

        let message = try JSONDecoder().decode(OpenClawChatMessage.self, from: data)
        let preview = try #require(message.content.last?.preview)
        #expect(preview.inlineWidgetPath == "/__openclaw__/canvas/documents/widget-1/index.html")
        #expect(preview.inlineWidgetHeight == 240)

        let unsafe = OpenClawChatCanvasPreview(
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            title: nil,
            preferredHeight: nil,
            url: "https://attacker.example/widget.html",
            viewId: nil,
            sandbox: "scripts")
        #expect(unsafe.inlineWidgetPath == nil)
    }

    @Test func `resolves only capability scoped widget documents`() {
        let surface = "https://gateway.example/__openclaw__/cap/token"
        let target = "/__openclaw__/canvas/documents/widget-1/index.html"

        #expect(OpenClawChatWidgetURLResolver.resolve(
            surfaceURL: surface,
            target: target)?.absoluteString ==
            "https://gateway.example/__openclaw__/cap/token/__openclaw__/canvas/documents/widget-1/index.html")
        #expect(OpenClawChatWidgetURLResolver.resolve(surfaceURL: "https://gateway.example", target: target) == nil)
        #expect(OpenClawChatWidgetURLResolver.resolve(
            surfaceURL: surface,
            target: "https://attacker.example/widget.html") == nil)
        #expect(OpenClawChatWidgetURLResolver.resolve(
            surfaceURL: surface,
            target: "/__openclaw__/a2ui/index.html") == nil)
        #expect(OpenClawChatWidgetURLResolver.resolve(
            surfaceURL: surface,
            target: "/__openclaw__/canvas/documents/%252e%252e/index.html") == nil)
        #expect(OpenClawChatWidgetURLResolver.resolve(
            surfaceURL: surface,
            target: "/__openclaw__/canvas/documents/%2525252525252525252525252525252525/index.html") == nil)
    }

    @Test func `resource equality ignores internal recovery metadata`() throws {
        let url = try #require(URL(string: "https://gateway.example/widget"))
        let publicResource = OpenClawChatWidgetResource(url: url)
        let trackedResource = OpenClawChatWidgetResource(
            url: url,
            tlsFingerprintSHA256: nil,
            surfaceRole: .node,
            attemptedSurfaceRoles: [.node])

        #expect(publicResource == trackedResource)
    }

    @Test func `uses replacement route after capability refresh loses its lease`() async throws {
        let target = "/__openclaw__/canvas/documents/widget-1/index.html"
        let oldSurface = "https://gateway.example/__openclaw__/cap/old"
        let newSurface = "https://gateway.example/__openclaw__/cap/new"
        let failedURL = try #require(OpenClawChatWidgetURLResolver.resolve(
            surfaceURL: oldSurface,
            target: target))
        let failedResource = OpenClawChatWidgetResource(url: failedURL)
        let probe = ChatWidgetRouteReconnectProbe(
            route: GatewayCanvasHostRoute(url: oldSurface, tlsFingerprintSHA256: nil),
            replacement: GatewayCanvasHostRoute(url: newSurface, tlsFingerprintSHA256: nil))

        let resolved = await OpenClawChatWidgetURLResolver.resolveResource(
            target: target,
            replacing: failedResource,
            currentSurfaceRoutes: { await probe.current() },
            refreshNodeSurfaceRoute: { observed in await probe.reconnect(observed: observed) },
            refreshOperatorSurfaceRoute: { _ in nil })

        #expect(resolved?.url == OpenClawChatWidgetURLResolver.resolve(surfaceURL: newSurface, target: target))
        #expect(await probe.refreshCount == 1)
    }

    @Test func `accepts a same URL widget route when it acquires a TLS pin`() async throws {
        let target = "/__openclaw__/canvas/documents/widget-1/index.html"
        let surface = "https://gateway.example/__openclaw__/cap/token"
        let newPin = String(repeating: "bb", count: 32)
        let failedURL = try #require(OpenClawChatWidgetURLResolver.resolve(
            surfaceURL: surface,
            target: target))
        let probe = ChatWidgetRouteReconnectProbe(
            route: GatewayCanvasHostRoute(url: surface, tlsFingerprintSHA256: nil),
            replacement: GatewayCanvasHostRoute(url: surface, tlsFingerprintSHA256: newPin))
        let initialResource = await OpenClawChatWidgetURLResolver.resolveResource(
            target: target,
            replacing: nil,
            currentSurfaceRoutes: { await probe.current() },
            refreshNodeSurfaceRoute: { _ in nil },
            refreshOperatorSurfaceRoute: { _ in nil })

        let resolved = await OpenClawChatWidgetURLResolver.resolveResource(
            target: target,
            replacing: initialResource,
            currentSurfaceRoutes: { await probe.current() },
            refreshNodeSurfaceRoute: { observed in await probe.reconnect(observed: observed) },
            refreshOperatorSurfaceRoute: { _ in nil })

        #expect(resolved?.url == failedURL)
        #expect(resolved?.tlsFingerprintSHA256 == newPin)
        #expect(await probe.refreshCount == 1)
    }

    @Test func `refreshes node once before trying the operator fallback`() async {
        let target = "/__openclaw__/canvas/documents/widget-1/index.html"
        let oldSurface = "https://gateway.example/__openclaw__/cap/old"
        let newSurface = "https://gateway.example/__openclaw__/cap/new"
        let fallbackSurface = "https://operator.example/__openclaw__/cap/fallback"
        let probe = ChatWidgetRouteReconnectProbe(
            route: GatewayCanvasHostRoute(url: oldSurface, tlsFingerprintSHA256: nil),
            replacement: GatewayCanvasHostRoute(url: newSurface, tlsFingerprintSHA256: nil),
            operatorRoute: GatewayCanvasHostRoute(url: fallbackSurface, tlsFingerprintSHA256: nil))
        let initialNode = await OpenClawChatWidgetURLResolver.resolveResource(
            target: target,
            replacing: nil,
            currentSurfaceRoutes: { await probe.current() },
            refreshNodeSurfaceRoute: { _ in nil },
            refreshOperatorSurfaceRoute: { _ in nil })

        let refreshedNode = await OpenClawChatWidgetURLResolver.resolveResource(
            target: target,
            replacing: initialNode,
            currentSurfaceRoutes: { await probe.current() },
            refreshNodeSurfaceRoute: { observed in await probe.reconnect(observed: observed) },
            refreshOperatorSurfaceRoute: { _ in nil })

        #expect(refreshedNode?.url == OpenClawChatWidgetURLResolver.resolve(surfaceURL: newSurface, target: target))

        let fallback = await OpenClawChatWidgetURLResolver.resolveResource(
            target: target,
            replacing: refreshedNode,
            currentSurfaceRoutes: { await probe.current() },
            refreshNodeSurfaceRoute: { observed in await probe.reconnect(observed: observed) },
            refreshOperatorSurfaceRoute: { _ in nil })

        #expect(fallback?.url == OpenClawChatWidgetURLResolver.resolve(
            surfaceURL: fallbackSurface,
            target: target))
        #expect(await probe.refreshCount == 1)
    }

    @Test func `refreshes the operator capability when the node route is unavailable`() async throws {
        let target = "/__openclaw__/canvas/documents/widget-1/index.html"
        let oldSurface = "https://operator.example/__openclaw__/cap/old"
        let newSurface = "https://operator.example/__openclaw__/cap/new"
        let failedURL = try #require(OpenClawChatWidgetURLResolver.resolve(
            surfaceURL: oldSurface,
            target: target))
        let failedResource = OpenClawChatWidgetResource(url: failedURL)
        let probe = ChatWidgetOperatorRouteRefreshProbe(
            route: GatewayCanvasHostRoute(url: oldSurface, tlsFingerprintSHA256: nil),
            replacement: GatewayCanvasHostRoute(url: newSurface, tlsFingerprintSHA256: nil))

        let resolved = await OpenClawChatWidgetURLResolver.resolveResource(
            target: target,
            replacing: failedResource,
            currentSurfaceRoutes: { await probe.current() },
            refreshNodeSurfaceRoute: { _ in nil },
            refreshOperatorSurfaceRoute: { observed in await probe.refresh(observed: observed) })

        #expect(resolved?.url == OpenClawChatWidgetURLResolver.resolve(surfaceURL: newSurface, target: target))
        #expect(await probe.refreshCount == 1)
    }

    @Test func `rejects a TLS pin on a cleartext widget route`() async {
        let target = "/__openclaw__/canvas/documents/widget-1/index.html"
        let route = GatewayCanvasHostRoute(
            url: "http://gateway.example/__openclaw__/cap/token",
            tlsFingerprintSHA256: String(repeating: "aa", count: 32))

        let resolved = await OpenClawChatWidgetURLResolver.resolveResource(
            target: target,
            replacing: nil,
            currentSurfaceRoutes: { (node: route, operatorSurface: nil) },
            refreshNodeSurfaceRoute: { _ in nil },
            refreshOperatorSurfaceRoute: { _ in nil })

        #expect(resolved == nil)
    }

    #if canImport(WebKit) && (os(iOS) || os(macOS))
    @Test func `bounds WebKit content process recovery per document`() {
        var recovery = ChatInlineWidgetContentProcessRecovery()

        #expect(recovery.nextAction() == .reload)
        #expect(recovery.nextAction() == .fail)
        #expect(recovery.nextAction() == .fail)

        recovery.reset()
        #expect(recovery.nextAction() == .reload)
    }

    @Test func `normalizes exact SHA-256 widget certificate pins`() {
        let fingerprint = String(repeating: "aB", count: 32)
        #expect(ChatInlineWidgetTLSPin.normalize("SHA-256: \(fingerprint)") == fingerprint.lowercased())
        #expect(ChatInlineWidgetTLSPin.normalize("abc") == nil)
        #expect(ChatInlineWidgetTLSPin.fingerprint(certificateData: Data("abc".utf8)) ==
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }
    #endif
}

private actor ChatWidgetOperatorRouteRefreshProbe {
    private var route: GatewayCanvasHostRoute
    private let replacement: GatewayCanvasHostRoute
    private(set) var refreshCount = 0

    init(route: GatewayCanvasHostRoute, replacement: GatewayCanvasHostRoute) {
        self.route = route
        self.replacement = replacement
    }

    func current() -> (node: GatewayCanvasHostRoute?, operatorSurface: GatewayCanvasHostRoute?) {
        (node: nil, operatorSurface: self.route)
    }

    func refresh(observed _: GatewayCanvasHostRoute?) -> GatewayCanvasHostRoute? {
        self.refreshCount += 1
        self.route = self.replacement
        return self.replacement
    }
}

private actor ChatWidgetRouteReconnectProbe {
    private var route: GatewayCanvasHostRoute?
    private let replacement: GatewayCanvasHostRoute
    private let operatorRoute: GatewayCanvasHostRoute?
    private(set) var refreshCount = 0

    init(
        route: GatewayCanvasHostRoute,
        replacement: GatewayCanvasHostRoute,
        operatorRoute: GatewayCanvasHostRoute? = nil)
    {
        self.route = route
        self.replacement = replacement
        self.operatorRoute = operatorRoute
    }

    func current() -> (node: GatewayCanvasHostRoute?, operatorSurface: GatewayCanvasHostRoute?) {
        (node: self.route, operatorSurface: self.operatorRoute)
    }

    func reconnect(observed _: GatewayCanvasHostRoute?) -> GatewayCanvasHostRoute? {
        self.refreshCount += 1
        self.route = self.replacement
        return nil
    }
}
