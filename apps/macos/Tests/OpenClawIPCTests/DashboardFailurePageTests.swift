import Foundation
import Testing
@testable import OpenClaw

struct DashboardFailurePageTests {
    @Test(arguments: [false, true], [false, true])
    func `dashboard diagnostics omit authentication while retaining the endpoint`(
        fragmentAuth: Bool,
        userInfoAuth: Bool) throws
    {
        let token = UUID().uuidString
        let username = UUID().uuidString
        let password = UUID().uuidString
        var endpoint = try #require(URLComponents(string: "wss://gateway.example.invalid:443/control"))
        endpoint.user = userInfoAuth ? username : nil
        endpoint.password = userInfoAuth ? password : nil
        let endpointURL = try #require(endpoint.url)
        let url = try GatewayEndpointStore.dashboardURL(
            for: (endpointURL, fragmentAuth ? token : nil, nil),
            mode: .remote)
        let html = DashboardFailurePage.html(
            title: "Dashboard unavailable",
            message: "Could not connect to the server.",
            detail: nil,
            url: url)
        let displayedEndpoint = "https://gateway.example.invalid:443/control/"

        // Boolean assertions keep even synthetic credential values out of failure diagnostics.
        let pageHasEndpoint = html.contains("<code>\(displayedEndpoint)</code>")
        let pageHasCredential = [token, username, password].contains { html.contains($0) }
        let logHasOnlyEndpoint = GatewayEndpointStore.diagnosticURLString(for: url) == displayedEndpoint
        #expect(pageHasEndpoint)
        #expect(!pageHasCredential)
        #expect(logHasOnlyEndpoint)

        let retainsFragment = (url.fragment?.contains(token) == true) == fragmentAuth
        let retainsUserInfo = (url.user == username && url.password == password) == userInfoAuth
        #expect(retainsFragment)
        #expect(retainsUserInfo)
    }

    @Test(arguments: ["ws", "wss"])
    func `gateway diagnostics preserve websocket schemes`(scheme: String) throws {
        let address = "\(scheme)://127.0.0.1:18789/control/"
        let url = try #require(URL(string: address))
        #expect(GatewayEndpointStore.diagnosticURLString(for: url) == address)
    }
}
