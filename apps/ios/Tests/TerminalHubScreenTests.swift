import Foundation
import SwiftUI
import Testing
import WebKit
@testable import OpenClaw
@testable import OpenClawKit

@MainActor
struct TerminalHubScreenTests {
    private static func makeConfig(
        url: URL,
        token: String? = nil,
        password: String? = nil,
        tls: GatewayTLSParams? = nil,
        allowStoredDeviceAuth: Bool = true,
        deviceAuthGatewayID: String? = nil) -> GatewayConnectConfig
    {
        GatewayConnectConfig(
            url: url,
            stableID: "manual|gateway.example.com|443",
            tls: tls,
            token: token,
            bootstrapToken: nil,
            password: password,
            nodeOptions: GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "ios",
                clientMode: "node",
                clientDisplayName: "Phone",
                allowStoredDeviceAuth: allowStoredDeviceAuth,
                deviceAuthGatewayID: deviceAuthGatewayID))
    }

    @Test func `terminal URL flips scheme and preserves the Control UI base path`() throws {
        let config = try Self.makeConfig(
            url: #require(URL(string: "wss://gateway.example.com:8443/openclaw")),
            token: "secret-token")

        let url = TerminalHubScreen.terminalURL(config: config)

        #expect(url?.absoluteString == "https://gateway.example.com:8443/openclaw/?view=terminal")
        // Credentials must never ride in the page URL; they travel via the
        // document-start auth user script instead.
        #expect(url?.absoluteString.contains("secret-token") == false)
    }

    @Test func `terminal URL uses plain HTTP for insecure endpoints`() throws {
        let config = try Self.makeConfig(url: #require(URL(string: "ws://192.168.1.10:18789")))

        let url = TerminalHubScreen.terminalURL(config: config)

        #expect(url?.absoluteString == "http://192.168.1.10:18789/?view=terminal")
    }

    @Test func `auth user script carries credentials gated to the page origin`() throws {
        let config = try Self.makeConfig(
            url: #require(URL(string: "wss://gateway.example.com:8443")),
            token: " secret-token ",
            password: "fallback-password")

        let script = TerminalHubScreen.terminalAuthUserScript(config: config)

        #expect(script?.contains("__OPENCLAW_NATIVE_CONTROL_AUTH__") == true)
        // JSONSerialization escapes forward slashes, hence the `\/` literals.
        #expect(script?.contains("\"https:\\/\\/gateway.example.com:8443\"") == true)
        #expect(script?.contains("\"token\":\"secret-token\"") == true)
        #expect(script?.contains("\"password\":\"fallback-password\"") == true)
        #expect(script?.contains("\"gatewayUrl\":\"wss:\\/\\/gateway.example.com:8443\"") == true)
    }

    @Test func `auth user script canonicalizes an explicit default port`() throws {
        let config = try Self.makeConfig(
            url: #require(URL(string: "wss://gateway.example.com:443")),
            token: "secret-token")

        let script = TerminalHubScreen.terminalAuthUserScript(config: config)

        #expect(script?.contains("\"https:\\/\\/gateway.example.com\"") == true)
        #expect(script?.contains("\"https:\\/\\/gateway.example.com:443\"") == false)
    }

    @Test func `auth user script falls back to stored operator token`() throws {
        let config = try Self.makeConfig(
            url: #require(URL(string: "wss://gateway.example.com:8443")),
            token: nil,
            password: nil)

        let script = TerminalHubScreen.terminalAuthUserScript(
            config: config,
            storedOperatorToken: " stored-token ")

        #expect(script?.contains("\"token\":\"stored-token\"") == true)
    }

    @Test func `auth user script loads the active gateway scoped operator token`() throws {
        let gatewayID = "manual|terminal-\(UUID().uuidString)|443"
        let identity = DeviceIdentityStore.loadOrCreate()
        defer {
            DeviceAuthStore.clearToken(
                deviceId: identity.deviceId,
                role: "operator",
                gatewayID: gatewayID)
        }
        #expect(DeviceAuthStore.storeToken(
            deviceId: identity.deviceId,
            role: "operator",
            token: "scoped-terminal-token",
            gatewayID: gatewayID).token == "scoped-terminal-token")
        let config = try Self.makeConfig(
            url: #require(URL(string: "wss://gateway.example.com:8443")),
            deviceAuthGatewayID: gatewayID)

        let script = TerminalHubScreen.terminalAuthUserScript(config: config)

        #expect(script?.contains("\"token\":\"scoped-terminal-token\"") == true)
    }

    @Test func `auth user script honors stored device auth suppression`() throws {
        let gatewayID = "manual|terminal-suppressed-\(UUID().uuidString)|443"
        let identity = DeviceIdentityStore.loadOrCreate()
        defer {
            DeviceAuthStore.clearToken(
                deviceId: identity.deviceId,
                role: "operator",
                gatewayID: gatewayID)
        }
        #expect(DeviceAuthStore.storeToken(
            deviceId: identity.deviceId,
            role: "operator",
            token: "stale-terminal-token",
            gatewayID: gatewayID).token == "stale-terminal-token")
        let config = try Self.makeConfig(
            url: #require(URL(string: "wss://gateway.example.com:8443")),
            password: "replacement-password",
            allowStoredDeviceAuth: false,
            deviceAuthGatewayID: gatewayID)

        let script = TerminalHubScreen.terminalAuthUserScript(config: config)

        #expect(script?.contains("stale-terminal-token") == false)
        #expect(script?.contains("\"password\":\"replacement-password\"") == true)
    }

    @Test func `web content identity changes with stored operator token`() throws {
        let config = try Self.makeConfig(url: #require(URL(string: "wss://gateway.example.com")))

        #expect(
            TerminalHubScreen.webContentIdentity(config: config, storedOperatorToken: "token-a") !=
                TerminalHubScreen.webContentIdentity(config: config, storedOperatorToken: "token-b"))
    }

    @Test func `web content identity changes with the accepted TLS pin`() throws {
        let url = try #require(URL(string: "wss://gateway.example.com"))
        let first = Self.makeConfig(
            url: url,
            tls: GatewayTLSParams(
                required: true,
                expectedFingerprint: "first",
                allowTOFU: false,
                storeKey: "gateway"))
        let second = Self.makeConfig(
            url: url,
            tls: GatewayTLSParams(
                required: true,
                expectedFingerprint: "second",
                allowTOFU: false,
                storeKey: "gateway"))

        #expect(
            TerminalHubScreen.webContentIdentity(config: first, storedOperatorToken: nil) !=
                TerminalHubScreen.webContentIdentity(config: second, storedOperatorToken: nil))
    }

    @Test func `authenticated Control UI origin rejects authority changes`() throws {
        let controlURL = try #require(URL(string: "https://gateway.example.com/control"))
        let defaultPortURL = try #require(URL(string: "https://GATEWAY.example.com:443/chat"))
        let alternatePortURL = try #require(URL(string: "https://gateway.example.com:8443/chat"))
        let alternateHostURL = try #require(URL(string: "https://replacement.example.com/chat"))
        let insecureURL = try #require(URL(string: "http://gateway.example.com/chat"))
        let expected = try #require(GatewayTLSAuthority(url: controlURL))

        #expect(expected == GatewayTLSAuthority(url: defaultPortURL))
        #expect(expected != GatewayTLSAuthority(url: alternatePortURL))
        #expect(expected != GatewayTLSAuthority(url: alternateHostURL))
        #expect(expected != GatewayTLSAuthority(url: insecureURL))
    }

    @Test func `authenticated Control UI canonicalizes IPv6 authorities`() throws {
        let controlURL = try #require(URL(string: "https://[2001:db8::1]:8443/control"))
        let expected = try #require(GatewayTLSAuthority(url: controlURL))

        #expect(expected.serialized == "https://[2001:db8::1]:8443")
        #expect(expected.matches(host: "2001:DB8::1", port: 8443))
        #expect(expected.matches(host: "[2001:db8::1]", port: 8443))
        #expect(!expected.matches(host: "2001:db8::2", port: 8443))
        #expect(!expected.matches(host: "2001:db8::1", port: 443))
    }

    @Test func `authenticated Control UI navigation keeps the main frame on its origin`() throws {
        let controlURL = try #require(URL(string: "https://gateway.example.com/control"))
        let sameOriginURL = try #require(URL(string: "https://gateway.example.com/chat?session=main"))
        let alternateHostURL = try #require(URL(string: "https://replacement.example.com/chat"))
        let alternatePortURL = try #require(URL(string: "https://gateway.example.com:8443/chat"))
        let embeddedURL = try #require(URL(string: "https://discussion.example.com/embed/thread/a/b"))
        let unknownFrameURL = try #require(URL(string: "https://gateway.example.com/chat"))
        let coordinator = try AuthenticatedControlUIWebViewCoordinator(
            url: controlURL,
            tls: nil)

        #expect(coordinator.allowsNavigation(to: sameOriginURL, isMainFrame: true))
        #expect(!coordinator.allowsNavigation(to: alternateHostURL, isMainFrame: true))
        #expect(!coordinator.allowsNavigation(to: alternatePortURL, isMainFrame: true))
        #expect(coordinator.allowsNavigation(to: embeddedURL, isMainFrame: false))
        #expect(!coordinator.allowsNavigation(to: unknownFrameURL, isMainFrame: nil))
    }

    @Test func `authenticated Control UI TLS authority uses the normalized page authority`() throws {
        let controlURL = try #require(URL(string: "https://Gateway.Example.com/control"))
        let coordinator = try AuthenticatedControlUIWebViewCoordinator(
            url: controlURL,
            tls: nil)

        #expect(coordinator.matchesExpectedAuthority(host: "gateway.example.com", port: 0))
        #expect(coordinator.matchesExpectedAuthority(host: "gateway.example.com", port: 443))
        #expect(!coordinator.matchesExpectedAuthority(host: "gateway.example.com", port: 8443))
        #expect(!coordinator.matchesExpectedAuthority(host: "replacement.example.com", port: 443))
    }

    @Test func `auth user script is omitted without credentials`() throws {
        let config = try Self.makeConfig(url: #require(URL(string: "wss://gateway.example.com")), token: "   ")

        #expect(
            TerminalHubScreen.terminalAuthUserScript(config: config, storedOperatorToken: nil) == nil)
        #expect(
            TerminalHubScreen.terminalAuthUserScript(config: nil, storedOperatorToken: nil) == nil)
    }

    @Test func `authenticated Control UI follows the resolved app appearance`() async throws {
        let cases: [(AppAppearancePreference, UIUserInterfaceStyle, UIUserInterfaceStyle)] = [
            (.dark, .light, .dark),
            (.light, .dark, .light),
            (.system, .light, .light),
            (.system, .dark, .dark),
        ]

        for (preference, systemStyle, expectedStyle) in cases {
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
            window.overrideUserInterfaceStyle = systemStyle
            window.rootViewController = UIHostingController(rootView: Self.controlUIView(preference: preference))
            window.makeKeyAndVisible()
            window.rootViewController?.view.setNeedsLayout()
            window.rootViewController?.view.layoutIfNeeded()

            let webView = try await Self.webView(in: window)
            #expect(webView.overrideUserInterfaceStyle == expectedStyle)
            webView.stopLoading()
            window.isHidden = true
            window.rootViewController = nil
        }
    }

    private static func controlUIView(preference: AppAppearancePreference) -> AnyView {
        AnyView(
            AuthenticatedControlUIWebView(
                url: URL(fileURLWithPath: "/"),
                authScript: nil,
                tls: nil)
                .preferredColorScheme(preference.colorScheme))
    }

    private static func webView(in window: UIWindow) async throws -> WKWebView {
        for _ in 0..<50 {
            if let webView = self.findWebView(in: window) {
                return webView
            }
            try await Task.sleep(for: .milliseconds(10))
            window.rootViewController?.view.layoutIfNeeded()
        }
        throw ControlUIAppearanceTestError.webViewNotMounted
    }

    private static func findWebView(in view: UIView) -> WKWebView? {
        if let webView = view as? WKWebView {
            return webView
        }
        return view.subviews.lazy.compactMap { self.findWebView(in: $0) }.first
    }
}

private enum ControlUIAppearanceTestError: Error {
    case webViewNotMounted
}
