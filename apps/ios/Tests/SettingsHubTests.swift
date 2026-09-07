import Foundation
import Network
import OpenClawKit
import SwiftUI
import Testing
import UIKit
import WebKit
import XCTest
@testable import OpenClaw

@MainActor
struct SettingsHubTests {
    @Test func `Dashboard settings require an active admin session outside demo and screenshots`() {
        let cases: [(connected: Bool, admin: Bool, demo: Bool, screenshot: Bool, dashboard: Bool)] = [
            (true, true, false, false, true),
            (false, true, false, false, false),
            (true, false, false, false, false),
            (false, false, false, false, false),
            (true, true, true, false, false),
            (true, true, false, true, false),
        ]
        for testCase in cases {
            #expect(SettingsHubScreen.usesDashboard(
                isOperatorConnected: testCase.connected,
                hasOperatorAdminScope: testCase.admin,
                isDemoMode: testCase.demo,
                isScreenshotMode: testCase.screenshot) == testCase.dashboard)
        }
    }

    @Test func `device panels reach their native iOS destinations`() {
        let routes: [(DeviceSettingsPanel, SettingsRoute)] = [
            (.connection, .gateway),
            (.gateways, .gateway),
            (.watch, .appleWatch),
            (.diagnostics, .diagnostics),
            (.licenses, .licenses),
            (.about, .about),
        ]
        for (panel, route) in routes {
            #expect(SettingsHubScreen.route(for: panel) == route)
        }
        for panel in [DeviceSettingsPanel.quickChatShortcut, .microphoneTest, .browserImport, .debug] {
            #expect(SettingsHubScreen.route(for: panel) == nil)
        }
    }

    @Test(arguments: [false, true], [false, true])
    func `loaded settings require both embed support and an admitted status request`(
        hasEmbedMarker: Bool,
        receivesStatus: Bool) async throws
    {
        let fixture = DashboardDocumentFixture()
        let navigation = try await fixture.load(hasEmbedMarker: hasEmbedMarker)
        let compatibility = DashboardEmbedCompatibility()
        let coordinator = AuthenticatedControlUIWebViewCoordinator(
            url: fixture.url, tls: nil, usesNativeEmbed: true, embedCompatibility: compatibility)
        defer { AuthenticatedControlUIWebView.dismantleUIView(fixture.webView, coordinator: coordinator) }

        coordinator.webView(fixture.webView, didStartProvisionalNavigation: navigation)
        coordinator.webView(fixture.webView, didCommit: navigation)
        if receivesStatus {
            compatibility.didReceiveStatusRequest()
        }
        coordinator.webView(fixture.webView, didFinish: navigation)
        #expect(!compatibility.needsGatewayUpgrade)

        if hasEmbedMarker, receivesStatus {
            try await Task.sleep(for: .seconds(6))
        } else {
            try await waitForDashboardCondition { compatibility.needsGatewayUpgrade }
        }
        #expect(compatibility.needsGatewayUpgrade == !(hasEmbedMarker && receivesStatus))
    }

    @Test func `retired settings documents cannot suppress the replacement Gateway upgrade banner`() async throws {
        let oldFixture = DashboardDocumentFixture()
        let oldNavigation = try await oldFixture.load(hasEmbedMarker: true)
        let newFixture = DashboardDocumentFixture()
        let newNavigation = try await newFixture.load(hasEmbedMarker: false)
        let compatibility = DashboardEmbedCompatibility()
        let oldCoordinator = AuthenticatedControlUIWebViewCoordinator(
            url: oldFixture.url, tls: nil, usesNativeEmbed: true, embedCompatibility: compatibility)
        let newCoordinator = AuthenticatedControlUIWebViewCoordinator(
            url: newFixture.url, tls: nil, usesNativeEmbed: true, embedCompatibility: compatibility)
        defer { AuthenticatedControlUIWebView.dismantleUIView(newFixture.webView, coordinator: newCoordinator) }

        oldCoordinator.webView(oldFixture.webView, didStartProvisionalNavigation: oldNavigation)
        oldCoordinator.webView(oldFixture.webView, didCommit: oldNavigation)
        compatibility.didReceiveStatusRequest()
        oldCoordinator.webView(oldFixture.webView, didFinish: oldNavigation)

        newCoordinator.webView(newFixture.webView, didStartProvisionalNavigation: newNavigation)
        newCoordinator.webView(newFixture.webView, didCommit: newNavigation)
        newCoordinator.webView(newFixture.webView, didFinish: newNavigation)
        oldCoordinator.webView(oldFixture.webView, didFinish: oldNavigation)
        AuthenticatedControlUIWebView.dismantleUIView(oldFixture.webView, coordinator: oldCoordinator)

        try await waitForDashboardCondition { compatibility.needsGatewayUpgrade }
        #expect(compatibility.needsGatewayUpgrade)
        newCoordinator.webViewWebContentProcessDidTerminate(newFixture.webView)
        #expect(!compatibility.needsGatewayUpgrade)
    }

    @Test func `failed settings navigation cancels its pending upgrade warning`() async throws {
        let fixture = DashboardDocumentFixture()
        let navigation = try await fixture.load(hasEmbedMarker: false)
        let compatibility = DashboardEmbedCompatibility()
        let coordinator = AuthenticatedControlUIWebViewCoordinator(
            url: fixture.url, tls: nil, usesNativeEmbed: true, embedCompatibility: compatibility)
        defer { AuthenticatedControlUIWebView.dismantleUIView(fixture.webView, coordinator: coordinator) }

        coordinator.webView(fixture.webView, didStartProvisionalNavigation: navigation)
        coordinator.webView(fixture.webView, didCommit: navigation)
        coordinator.webView(fixture.webView, didFinish: navigation)
        coordinator.webView(fixture.webView, didFail: navigation, withError: URLError(.networkConnectionLost))
        coordinator.webView(fixture.webView, didFinish: navigation)

        try await Task.sleep(for: .seconds(6))
        #expect(!compatibility.needsGatewayUpgrade)
    }

    @Test func `failed provisional navigation preserves the committed settings upgrade warning`() async throws {
        let fixture = DashboardDocumentFixture()
        let navigation = try await fixture.load(hasEmbedMarker: false)
        let compatibility = DashboardEmbedCompatibility()
        let coordinator = AuthenticatedControlUIWebViewCoordinator(
            url: fixture.url, tls: nil, usesNativeEmbed: true, embedCompatibility: compatibility)
        defer { AuthenticatedControlUIWebView.dismantleUIView(fixture.webView, coordinator: coordinator) }

        coordinator.webView(fixture.webView, didStartProvisionalNavigation: navigation)
        coordinator.webView(fixture.webView, didCommit: navigation)
        coordinator.webView(fixture.webView, didFinish: navigation)
        try await waitForDashboardCondition { compatibility.needsGatewayUpgrade }

        let provisionalFixture = DashboardDocumentFixture()
        let provisionalNavigation = try await provisionalFixture.load(hasEmbedMarker: false)
        defer { withExtendedLifetime(provisionalFixture) {} }
        coordinator.webView(fixture.webView, didStartProvisionalNavigation: provisionalNavigation)
        #expect(compatibility.needsGatewayUpgrade)
        coordinator.webView(
            fixture.webView,
            didFailProvisionalNavigation: provisionalNavigation,
            withError: URLError(.cannotConnectToHost))
        #expect(compatibility.needsGatewayUpgrade)
    }

    @Test func `late embed support and status clear the current settings upgrade warning`() async throws {
        let fixture = DashboardDocumentFixture()
        let navigation = try await fixture.load(hasEmbedMarker: false)
        let compatibility = DashboardEmbedCompatibility()
        let coordinator = AuthenticatedControlUIWebViewCoordinator(
            url: fixture.url, tls: nil, usesNativeEmbed: true, embedCompatibility: compatibility)
        defer { AuthenticatedControlUIWebView.dismantleUIView(fixture.webView, coordinator: coordinator) }

        coordinator.webView(fixture.webView, didStartProvisionalNavigation: navigation)
        coordinator.webView(fixture.webView, didCommit: navigation)
        coordinator.webView(fixture.webView, didFinish: navigation)
        try await waitForDashboardCondition { compatibility.needsGatewayUpgrade }
        await Task.yield()
        _ = try await fixture.webView.evaluateJavaScript("document.readyState")
        _ = try await fixture.webView.evaluateJavaScript(
            "document.querySelector('main').classList.add('openclaw-native-embed')")
        compatibility.didReceiveStatusRequest()

        try await waitForDashboardCondition { !compatibility.needsGatewayUpgrade }
        #expect(!compatibility.needsGatewayUpgrade)
    }
}

@MainActor
private func waitForDashboardCondition(_ condition: () -> Bool) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(10))
    while !condition() {
        guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
        try await Task.sleep(for: .milliseconds(50))
    }
}

@MainActor
final class SettingsHubVisualProofTests: XCTestCase {
    func testOlderDashboardShowsNativeGatewayUpgradeBanner() async throws {
        let html = """
        <!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1">
        <body style="font: 17px -apple-system; padding: 24px; color: #222; background: white">
        <h1>Settings</h1><p>Manage your Gateway preferences.</p></body></html>
        """
        let fixture = try DashboardHTTPFixture(html: html)
        defer { fixture.stop() }
        let fixtureURL = try await fixture.start()

        let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
        let gatewayController = GatewayConnectionController(appModel: model, startDiscovery: false)
        let compatibility = DashboardEmbedCompatibility()
        let root = NavigationStack {
            EmbeddedDashboardContent(
                appModel: model,
                appearanceModel: AppAppearanceModel(),
                gatewayController: gatewayController,
                url: fixtureURL,
                config: nil,
                openPanel: { _ in },
                embedCompatibility: compatibility,
                openGateway: {})
                .navigationTitle("Settings")
                .navigationBarTitleDisplayMode(.inline)
        }
        .preferredColorScheme(.light)
        let controller = UIHostingController(rootView: root)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            previousKeyWindow?.makeKeyAndVisible()
        }
        controller.view.setNeedsLayout()
        controller.view.layoutIfNeeded()

        var originalFrame: CGRect?
        var originalView: WKWebView?
        var bodyText = "not evaluated"
        do {
            try await waitForDashboardCondition {
                guard let webView = Self.findWebView(in: controller.view) else { return false }
                return webView.url == fixtureURL && !webView.isLoading
            }
            let webView = try XCTUnwrap(Self.findWebView(in: controller.view))
            originalView = webView
            let frame = webView.convert(webView.bounds, to: controller.view)
            originalFrame = frame
            bodyText = try await webView.evaluateJavaScript("document.body.textContent") as? String ?? ""
            guard bodyText.contains("Manage your Gateway preferences.") else {
                throw URLError(.cannotParseResponse)
            }
            XCTAssertFalse(compatibility.needsGatewayUpgrade)
            try await self.attach(
                controller.view, named: "settings-older-dashboard-before-upgrade-banner", webView: webView)

            try await waitForDashboardCondition {
                controller.view.setNeedsLayout()
                controller.view.layoutIfNeeded()
                return compatibility.needsGatewayUpgrade &&
                    webView.convert(webView.bounds, to: controller.view).minY > frame.minY + 40
            }
            try await self.attach(
                controller.view, named: "settings-older-dashboard-after-native-upgrade-banner", webView: webView)
            XCTAssertGreaterThan(webView.convert(webView.bounds, to: controller.view).minY, frame.minY + 40)
        } catch {
            let currentView = Self.findWebView(in: controller.view)
            let currentFrame = currentView.map { $0.convert($0.bounds, to: controller.view) }
            let diagnostics = [
                "needsGatewayUpgrade=\(compatibility.needsGatewayUpgrade)",
                "originalFrame=\(String(describing: originalFrame))",
                "currentFrame=\(String(describing: currentFrame))",
                "originalWebView=\(String(describing: originalView.map(ObjectIdentifier.init)))",
                "currentWebView=\(String(describing: currentView.map(ObjectIdentifier.init)))",
                "url=\(currentView?.url?.absoluteString ?? "nil")",
                "loading=\(currentView?.isLoading == true)",
                "HTTP requests=\(fixture.requestCount)",
                "body=\(bodyText.prefix(300))",
            ].joined(separator: "; ")
            try? await self.attach(controller.view, named: "settings-older-dashboard-native-banner-failure")
            XCTFail("Dashboard visual proof failed: \(error). \(diagnostics)")
        }
    }

    private func attach(_ view: UIView, named name: String, webView: WKWebView? = nil) async throws {
        view.setNeedsLayout()
        view.layoutIfNeeded()
        let webSnapshot = try await webView?.takeSnapshot(configuration: nil)
        let image = UIGraphicsImageRenderer(size: view.bounds.size).image { _ in
            view.drawHierarchy(in: view.bounds, afterScreenUpdates: true)
            // WebKit draws in a remote layer; composite its real snapshot over the native hierarchy.
            if let webSnapshot, let webView {
                webSnapshot.draw(in: webView.convert(webView.bounds, to: view))
            }
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private static func findWebView(in view: UIView) -> WKWebView? {
        if let webView = view as? WKWebView {
            return webView
        }
        return view.subviews.lazy.compactMap { Self.findWebView(in: $0) }.first
    }
}

@MainActor
private final class DashboardHTTPFixture {
    private struct Client {
        let connection: NWConnection
        var request = Data()
    }

    private let listener: NWListener
    private let response: Data
    private var clients: [UUID: Client] = [:]
    private var stopped = false
    private(set) var requestCount = 0

    init(html: String) throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        self.listener = try NWListener(using: parameters, on: .any)
        let body = Data(html.utf8)
        let header = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n" +
            "Content-Length: \(body.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
        self.response = Data(header.utf8) + body
        self.listener.newConnectionHandler = { [weak self] connection in
            Task { @MainActor [weak self] in
                guard let self, !self.stopped, self.clients.count < 8 else {
                    connection.cancel()
                    return
                }
                let id = UUID()
                self.clients[id] = Client(connection: connection)
                connection.start(queue: .main)
                self.receive(id)
            }
        }
    }

    func start() async throws -> URL {
        self.listener.start(queue: .main)
        try await waitForDashboardCondition {
            switch self.listener.state {
            case .ready, .failed, .cancelled: true
            default: false
            }
        }
        if case let .failed(error) = listener.state {
            throw error
        }
        let port = try XCTUnwrap(listener.port)
        return try XCTUnwrap(URL(string: "http://127.0.0.1:\(port.rawValue)/settings"))
    }

    func stop() {
        self.stopped = true
        self.listener.cancel()
        for client in self.clients.values {
            client.connection.cancel()
        }
        self.clients.removeAll()
    }

    private func receive(_ id: UUID) {
        guard let client = clients[id] else { return }
        client.connection.receive(minimumIncompleteLength: 1, maximumLength: 8192 - client.request.count) {
            [weak self] data, _, complete, error in
            Task { @MainActor [weak self] in
                guard let self, var client = self.clients[id] else { return }
                if let data {
                    client.request.append(data)
                }
                self.clients[id] = client
                if client.request.range(of: Data("\r\n\r\n".utf8)) != nil {
                    self.requestCount += 1
                    client.connection.send(content: self.response, completion: .contentProcessed { [weak self] _ in
                        Task { @MainActor [weak self] in self?.close(id) }
                    })
                } else if complete || error != nil || client.request.count >= 8192 {
                    self.close(id)
                } else {
                    self.receive(id)
                }
            }
        }
    }

    private func close(_ id: UUID) {
        self.clients.removeValue(forKey: id)?.connection.cancel()
    }
}

@MainActor
private final class DashboardDocumentFixture: NSObject, WKNavigationDelegate {
    let url = URL(string: "https://gateway.example/settings")!
    let webView: WKWebView
    private var loaded: CheckedContinuation<WKNavigation, any Error>?

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        self.webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        self.webView.navigationDelegate = self
    }

    func load(hasEmbedMarker: Bool) async throws -> WKNavigation {
        try await withCheckedThrowingContinuation { continuation in
            self.loaded = continuation
            let marker = hasEmbedMarker ? "openclaw-native-embed" : "legacy-dashboard"
            self.webView.loadHTMLString(
                "<html><body><main class='\(marker)'>Settings</main></body></html>",
                baseURL: self.url)
        }
    }

    func webView(_: WKWebView, didFinish navigation: WKNavigation!) {
        if let navigation {
            self.loaded?.resume(returning: navigation)
        } else {
            self.loaded?.resume(throwing: URLError(.unknown))
        }
        self.loaded = nil
    }

    func webView(_: WKWebView, didFail _: WKNavigation!, withError error: any Error) {
        self.loaded?.resume(throwing: error)
        self.loaded = nil
    }

    func webView(_: WKWebView, didFailProvisionalNavigation _: WKNavigation!, withError error: any Error) {
        self.loaded?.resume(throwing: error)
        self.loaded = nil
    }
}
