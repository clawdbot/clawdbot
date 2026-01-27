import Testing
import WebKit
@testable import Moltbot

@Suite struct ScreenControllerTests {
    @Test @MainActor func canvasModeConfiguresWebViewForTouch() {
        let screen = ScreenController()

        #expect(screen.webView.isOpaque == true)
        #expect(screen.webView.backgroundColor == .black)

        let scrollView = screen.webView.scrollView
        #expect(scrollView.backgroundColor == .black)
        #expect(scrollView.contentInsetAdjustmentBehavior == .never)
        #expect(scrollView.isScrollEnabled == false)
        #expect(scrollView.bounces == false)
    }

    @Test @MainActor func navigateEnablesScrollForWebPages() {
        let screen = ScreenController()
        screen.navigate(to: "https://example.com")

        let scrollView = screen.webView.scrollView
        #expect(scrollView.isScrollEnabled == true)
        #expect(scrollView.bounces == true)
    }

    @Test @MainActor func navigateSlashShowsDefaultCanvas() {
        let screen = ScreenController()
        screen.navigate(to: "/")

        #expect(screen.urlString.isEmpty)
    }

    @Test @MainActor func evalExecutesJavaScript() async throws {
        let screen = ScreenController()
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

    @Test @MainActor func localNetworkCanvasURLsAreAllowed() {
        let screen = ScreenController()
        #expect(screen.isLocalNetworkCanvasURL(URL(string: "http://localhost:18789/")!) == true)
        #expect(screen.isLocalNetworkCanvasURL(URL(string: "http://clawd.local:18789/")!) == true)
        #expect(screen.isLocalNetworkCanvasURL(URL(string: "http://peters-mac-studio-1:18789/")!) == true)
        #expect(screen.isLocalNetworkCanvasURL(URL(string: "https://peters-mac-studio-1.ts.net:18789/")!) == true)
        #expect(screen.isLocalNetworkCanvasURL(URL(string: "http://192.168.0.10:18789/")!) == true)
        #expect(screen.isLocalNetworkCanvasURL(URL(string: "http://10.0.0.10:18789/")!) == true)
        #expect(screen.isLocalNetworkCanvasURL(URL(string: "http://100.123.224.76:18789/")!) == true) // Tailscale CGNAT
        #expect(screen.isLocalNetworkCanvasURL(URL(string: "https://example.com/")!) == false)
        #expect(screen.isLocalNetworkCanvasURL(URL(string: "http://8.8.8.8/")!) == false)
    }

    @Test func parseA2UIActionBodyAcceptsJSONString() throws {
        let body = ScreenController.parseA2UIActionBody("{\"userAction\":{\"name\":\"hello\"}}")
        let userAction = try #require(body?["userAction"] as? [String: Any])
        #expect(userAction["name"] as? String == "hello")
    }
}
