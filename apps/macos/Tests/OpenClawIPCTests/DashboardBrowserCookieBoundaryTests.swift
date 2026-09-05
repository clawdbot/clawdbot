import AppKit
import Foundation
import Security
import Testing
import WebKit
@testable import OpenClaw

@MainActor
private final class DashboardFixtureTrust: NSObject, WKNavigationDelegate {
    let certificate: Data
    let ports: Set<Int>

    init(certificate: Data, ports: Set<Int>) {
        self.certificate = certificate
        self.ports = ports
    }

    func webView(
        _: WKWebView,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping @MainActor @Sendable (
            URLSession.AuthChallengeDisposition, URLCredential?) -> Void)
    {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              challenge.protectionSpace.host == "127.0.0.1",
              self.ports.contains(challenge.protectionSpace.port),
              let trust = challenge.protectionSpace.serverTrust,
              let certificates = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let certificate = certificates.first,
              SecCertificateCopyData(certificate) as Data == self.certificate
        else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
}

@Suite(.serialized)
@MainActor
struct DashboardBrowserCookieBoundaryTests {
    @Test(arguments: [false, true])
    func `issuer cookies reach only their exact HTTPS and WebSocket authority`(_ protected: Bool) async throws {
        let tls = try DashboardTLSFixture()
        let token = "synthetic-browser-cookie"
        var requests: [String: String] = [:]
        let other = try await DashboardHTTPFixture.start(tlsIdentity: tls.identity, requestHandler: { request in
            let path = request.split(separator: " ").dropFirst().first.map(String.init) ?? ""
            requests[path] = request
            return Self.response("Ready")
        })
        defer { other.stop() }
        let html = """
        <!doctype html><script>
        async function probe() {
          await Promise.all([
            fetch('/same-fetch', {credentials:'include'}),
            fetch('\(other.url("/other-fetch"))', {credentials:'include', mode:'no-cors'}),
            fetch('/redirect', {credentials:'include', mode:'no-cors'})
          ]);
          new WebSocket(location.origin.replace('https:', 'wss:') + '/same-socket');
          new WebSocket('\(other.websocketURL("/other-socket"))');
          const image = new Image(); image.src = '\(other.url("/other-image"))';
          document.body.appendChild(image);
          const frame = document.createElement('iframe'); frame.src = '\(other.url("/other-frame"))';
          document.body.appendChild(frame);
          new Worker('/worker.js');
        }
        addEventListener('load', probe);
        </script><body>Cookie boundary</body>
        """
        let gateway = try await DashboardHTTPFixture.start(tlsIdentity: tls.identity, requestHandler: { request in
            let path = request.split(separator: " ").dropFirst().first.map(String.init) ?? ""
            requests[path] = request
            switch path {
            case "/":
                return Self.response(html)
            case "/redirect":
                return "HTTP/1.1 302 Found\r\nLocation: \(other.url("/other-redirect"))\r\nContent-Length: 0\r\n\r\n"
            case "/worker.js":
                return Self.response("""
                fetch('/same-worker', {credentials:'include'});
                fetch('\(other.url("/other-worker"))', {credentials:'include', mode:'no-cors'});
                """, type: "text/javascript")
            default:
                return Self.response("Ready")
            }
        })
        defer { gateway.stop() }
        let session = try GatewayBrowserSession(
            origin: gateway.url(),
            issuer: #require(URL(string: "https://issuer.example/")),
            audience: "fixture",
            subject: "fixture-account",
            token: token,
            expiresAt: Date().addingTimeInterval(300))
        let store = DashboardBrowserSessionStore(dataStore: .nonPersistent())
        let controller = DashboardWindowController(
            url: gateway.url(),
            auth: .browserIdentity(gatewayUrl: gateway.websocketURL().absoluteString),
            websiteDataStore: store.dataStore,
            browserSessionLease: protected ? store.lease(for: session) : nil,
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        let trust = DashboardFixtureTrust(
            certificate: tls.certificate, ports: [Int(gateway.port), Int(other.port)])
        controller.webView.navigationDelegate = trust
        if !protected { try await store.dataStore.httpCookieStore.setCookie(session.cookie()) }
        controller.show(url: gateway.url(), auth: controller.auth)

        let same = ["/", "/same-fetch", "/same-socket", "/same-worker"]
        let different = [
            "/other-fetch",
            "/other-socket",
            "/other-image",
            "/other-frame",
            "/other-redirect",
            "/other-worker",
        ]
        let expected = same + different
        let deadline = ContinuousClock.now + .seconds(10)
        while !expected.allSatisfy({ requests[$0] != nil }), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        for path in expected {
            try #require(requests[path] != nil, "Missing request: \(path)")
        }
        for path in same {
            #expect(requests[path]?.contains("CF_Authorization=\(token)") == true)
        }
        for path in different {
            // The unprotected control reproduces RFC 6265's lack of port isolation.
            #expect(requests[path]?.contains("CF_Authorization=\(token)") == !protected)
        }
    }

    private static func response(_ body: String, type: String = "text/html") -> String {
        "HTTP/1.1 200 OK\r\nContent-Type: \(type)\r\nContent-Length: \(body.utf8.count)\r\n" +
            "Connection: close\r\n\r\n\(body)"
    }

    @Test(arguments: [
        "https://gateway.example/", "https://gateway.example:443/", "https://gateway.example:8443/",
        "https://[::1]/", "https://[::1]:8443/",
    ])
    func `cookie policies compile for canonical HTTPS authorities`(_ origin: String) async throws {
        let session = try GatewayBrowserSession(
            origin: #require(URL(string: origin)),
            issuer: #require(URL(string: "https://issuer.example/")),
            audience: "fixture",
            subject: "fixture-account",
            token: "synthetic",
            expiresAt: Date().addingTimeInterval(300))
        let store = DashboardBrowserSessionStore(dataStore: .nonPersistent())
        try await store.lease(for: session).prepare(for: session.origin, in: WKUserContentController())
        #expect(await store.dataStore.httpCookieStore.allCookies().count == 1)
    }
}
