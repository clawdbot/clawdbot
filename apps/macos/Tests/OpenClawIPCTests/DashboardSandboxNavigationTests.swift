import AppKit
import Foundation
import Testing
import WebKit
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct DashboardSandboxNavigationTests {
    @Test(arguments: [
        "https://widgets.example/mcp-app-sandbox?csp=encoded",
        "http://127.0.0.1:18790/mcp-app-sandbox?csp=encoded",
    ])
    func `sandbox navigation requires a trusted dashboard subframe`(_ address: String) throws {
        let dashboard = try #require(URL(string: "https://openclaw.example/control/"))
        let sandbox = try #require(URL(string: address))
        #expect(DashboardWindowController.shouldAllowNavigation(
            to: sandbox, dashboardURL: dashboard, isMainFrame: false, isTrustedDashboardSource: true))
        #expect(!DashboardWindowController.shouldAllowNavigation(
            to: sandbox, dashboardURL: dashboard, isMainFrame: true, isTrustedDashboardSource: true))
        #expect(!DashboardWindowController.shouldAllowNavigation(
            to: sandbox, dashboardURL: dashboard, isMainFrame: false, isTrustedDashboardSource: false))
    }

    @Test(arguments: [
        "https://widgets.example/mcp-app",
        "https://widgets.example/mcp-app-sandbox/",
        "https://widgets.example//mcp-app-sandbox",
        "https://widgets.example/%6dcp-app-sandbox",
        "https://widgets.example/mcp-app-sandbox%2f",
        "file:///mcp-app-sandbox",
        "custom://widgets.example/mcp-app-sandbox",
    ])
    func `sandbox navigation rejects noncanonical or unsafe URLs`(_ address: String) throws {
        let dashboard = try #require(URL(string: "https://openclaw.example/control/"))
        let sandbox = try #require(URL(string: address))
        #expect(!DashboardWindowController.shouldAllowNavigation(
            to: sandbox, dashboardURL: dashboard, isMainFrame: false, isTrustedDashboardSource: true))
    }

    @Test func `sandbox navigation rejects user information`() throws {
        let dashboard = try #require(URL(string: "https://openclaw.example/control/"))
        var sandbox = try #require(URLComponents(string: "https://widgets.example/mcp-app-sandbox"))
        sandbox.user = "fixture-user"
        #expect(try !DashboardWindowController.shouldAllowNavigation(
            to: #require(sandbox.url), dashboardURL: dashboard, isMainFrame: false, isTrustedDashboardSource: true))
        sandbox.user = nil
        sandbox.password = "fixture-password"
        #expect(try !DashboardWindowController.shouldAllowNavigation(
            to: #require(sandbox.url), dashboardURL: dashboard, isMainFrame: false, isTrustedDashboardSource: true))
    }

    @Test(arguments: ["/control/", "/team%20space/"])
    func `dashboard source trust preserves the browser pathname`(_ mountPath: String) throws {
        let dashboard = try #require(URL(string: "https://openclaw.example\(mountPath)"))
        let descendant = try #require(URL(string: "chat", relativeTo: dashboard)?.absoluteURL)
        #expect(DashboardWindowController.allowedPath(for: dashboard) == mountPath)
        #expect(DashboardWindowController.isTrustedLinkSource(dashboard, dashboardURL: dashboard))
        #expect(DashboardWindowController.isTrustedLinkSource(descendant, dashboardURL: dashboard))
        let encodedSeparator = try #require(URL(string: "https://openclaw.example\(mountPath.dropLast())%2Fchat"))
        #expect(!DashboardWindowController.isTrustedLinkSource(encodedSeparator, dashboardURL: dashboard))
    }

    @Test func `dashboard WebKit loads the isolated sandbox and its inner document`() async throws {
        let sandbox = try await DashboardHTTPFixture.start(
            html: """
            <!doctype html><body><script>
            addEventListener('message', event => {
              if (event.source !== parent || event.data !== 'load-app') return;
              const inner = document.createElement('iframe');
              inner.sandbox = 'allow-scripts';
              inner.srcdoc = '<body>MCP App rendered<script>parent.postMessage("app-ready", "*")<\\/script>';
              addEventListener('message', reply => {
                if (reply.source === inner.contentWindow && reply.data === 'app-ready') {
                  parent.postMessage({ready: true, nativeAuth: !!window.__OPENCLAW_NATIVE_CONTROL_AUTH__}, '*');
                }
              });
              document.body.append(inner);
            });
            parent.postMessage('proxy-ready', '*');
            </script>
            """,
            contentSecurityPolicy: "default-src 'none'; script-src 'unsafe-inline'; frame-src 'self'")
        defer { sandbox.stop() }
        let sandboxURL = sandbox.url("/mcp-app-sandbox?csp=encoded")
        let dashboard = try await DashboardHTTPFixture.start(
            html: """
            <!doctype html><body><h1>Dashboard</h1><script>
            const frame = document.createElement('iframe');
            frame.sandbox = 'allow-scripts allow-same-origin allow-forms';
            frame.referrerPolicy = 'origin';
            document.body.append(frame);
            addEventListener('message', event => {
              if (event.source !== frame.contentWindow) return;
              if (event.data === 'proxy-ready') frame.contentWindow.postMessage('load-app', '*');
              else if (event.data.ready) {
                document.body.dataset.appReady = String(!event.data.nativeAuth);
              }
            });
            frame.src = '\(sandboxURL.absoluteString)';
            </script>
            """,
            contentSecurityPolicy:
            "default-src 'none'; script-src 'unsafe-inline'; frame-src http://127.0.0.1:\(sandbox.port)")
        defer { dashboard.stop() }
        let dashboardURL = dashboard.url("/control/")
        let controller = DashboardWindowController(
            url: dashboardURL,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: "fixture-only", password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        controller.loadInBackground(url: dashboardURL, auth: controller.auth)
        let deadline = ContinuousClock.now + .seconds(10)
        var rendered = false
        while ContinuousClock.now < deadline {
            if await (try? controller.webView.evaluateJavaScript("document.body.dataset.appReady")) as? String ==
                "true"
            {
                rendered = true
                break
            }
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(rendered, "The real navigation delegate must admit the outer sandbox and nested srcdoc handshake")
        #expect(controller.webView.url == dashboardURL)
    }
}
