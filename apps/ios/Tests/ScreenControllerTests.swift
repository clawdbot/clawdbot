import Testing
import WebKit
@testable import OpenClaw

@MainActor
private func mountScreen(_ screen: ScreenController) throws -> (ScreenWebViewCoordinator, WKWebView) {
    let coordinator = ScreenWebViewCoordinator(controller: screen)
    _ = coordinator.makeContainerView()
    let webView = try #require(coordinator.managedWebView)
    return (coordinator, webView)
}

@Suite struct ScreenControllerTests {
    @Test @MainActor func canvasModeConfiguresWebViewForTouch() throws {
        let screen = ScreenController()
        let (coordinator, webView) = try mountScreen(screen)
        defer { coordinator.teardown() }

        #expect(webView.isOpaque == true)
        #expect(webView.backgroundColor == .black)

        let scrollView = webView.scrollView
        #expect(scrollView.backgroundColor == .black)
        #expect(scrollView.contentInsetAdjustmentBehavior == .never)
        #expect(scrollView.isScrollEnabled == false)
        #expect(scrollView.bounces == false)
    }

    @Test @MainActor func navigateEnablesScrollForWebPages() throws {
        let screen = ScreenController()
        let (coordinator, webView) = try mountScreen(screen)
        defer { coordinator.teardown() }

        screen.navigate(to: "https://example.com")

        let scrollView = webView.scrollView
        #expect(scrollView.isScrollEnabled == true)
        #expect(scrollView.bounces == true)
    }

    @Test @MainActor func navigateSlashShowsDefaultCanvas() {
        let screen = ScreenController()
        screen.navigate(to: "/")

        #expect(screen.urlString.isEmpty)
    }

    @Test @MainActor func canvasPresentationTracksExplicitPresentAndHide() {
        let screen = ScreenController()

        #expect(screen.isCanvasPresented == false)

        screen.showDefaultCanvas()
        #expect(screen.isCanvasPresented == false)

        screen.presentDefaultCanvas()
        #expect(screen.isCanvasPresented == true)
        #expect(screen.urlString.isEmpty)

        screen.hideCanvas()
        #expect(screen.isCanvasPresented == false)
        #expect(screen.urlString.isEmpty)
    }

    @Test @MainActor func evalExecutesJavaScript() async throws {
        let screen = ScreenController()
        let (coordinator, _) = try mountScreen(screen)
        defer { coordinator.teardown() }

        let deadline = ContinuousClock().now.advanced(by: .seconds(3))

        while true {
            do {
                let result = try await screen.eval(javaScript: "1+1")
                #expect(result == "2")
                return
            } catch {
                if ContinuousClock().now >= deadline {
                    throw error
                }
                try? await Task.sleep(nanoseconds: 100_000_000)
            }
        }
    }

    @Test("remote A2UI URL is not trusted for native actions")
    @MainActor func remoteA2UIURLIsNotTrustedForNativeActions() throws {
        let screen = ScreenController()
        let trusted = "https://node.ts.net:18789/__openclaw__/a2ui/?platform=ios"
        screen.navigate(to: trusted, trustA2UIActions: true)

        #expect(screen.isShowingLocalA2UI() == false)

        let urls = try [
            trusted,
            "https://node.ts.net:18789/__openclaw__/a2ui/?platform=ios#step2",
            "http://192.168.0.10:18789/__openclaw__/a2ui/?platform=ios",
            "https://node.ts.net:18789/__openclaw__/a2ui/?platform=android",
            "https://node.ts.net:18789/__openclaw__/canvas/",
            "https://evil.ts.net:18789/__openclaw__/a2ui/?platform=ios",
        ].map { try #require(URL(string: $0)) }

        for url in urls {
            #expect(screen.isTrustedCanvasUIURL(url) == false)
        }
    }

    @Test("local A2UI URL is trusted for native actions")
    @MainActor func localA2UIURLIsTrustedForNativeActions() throws {
        let screen = ScreenController()
        screen.showLocalA2UI()

        let url = try #require(URL(string: screen.urlString))
        #expect(url.isFileURL)
        #expect(screen.isShowingLocalA2UI() == true)
        #expect(screen.isTrustedCanvasUIURL(url) == true)
    }

    @Test func parseA2UIActionBodyAcceptsJSONString() throws {
        let body = ScreenController.parseA2UIActionBody("{\"userAction\":{\"name\":\"hello\"}}")
        let userAction = try #require(body?["userAction"] as? [String: Any])
        #expect(userAction["name"] as? String == "hello")
    }
}
