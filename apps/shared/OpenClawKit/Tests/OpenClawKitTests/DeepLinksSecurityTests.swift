import Foundation
import OpenClawKit
import OpenClawProtocol
import Testing

private func setupCode(from payload: String) -> String {
    Data(payload.utf8)
        .base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

private func gatewayLink(from raw: String) -> GatewayConnectDeepLink? {
    guard let url = URL(string: raw),
          case let .gateway(link)? = DeepLinkParser.parse(url)
    else { return nil }
    return link
}

@Suite struct DeepLinksSecurityTests {
    @Test func setupResultInitializerDefaultsOptionalFields() {
        let result = DevicePairSetupCodeResult(
            setupid: "setup-1",
            setupcode: "code",
            qrdataurl: nil,
            gatewayurl: "wss://gateway.example.com",
            auth: AnyCodable("token"),
            urlsource: "config",
            expiresatms: 1_700_000_000_000)

        #expect(result.gatewayurls == nil)
        #expect(result.accessdowngraded == nil)
    }

    @Test func dashboardDeepLinkParses() {
        let url = URL(string: "openclaw://dashboard")!
        #expect(DeepLinkParser.parse(url) == .dashboard)
    }

    @Test func debugDashboardDeepLinkParses() {
        let url = URL(string: "openclaw-debug://dashboard")!
        #expect(DeepLinkParser.parse(url) == .dashboard)
    }

    @Test(arguments: ["openclaw", "openclaw-debug"])
    func gatewayAddDeepLinkPreservesAddressAndLabel(scheme: String) throws {
        var components = URLComponents(string: "\(scheme)://gateway/add")!
        components.queryItems = [
            URLQueryItem(name: "url", value: "HTTPS://Gateway.Example:8443/openclaw%20gateway/"),
            URLQueryItem(name: "name", value: " Research & Design "),
        ]
        let route = DeepLinkParser.parse(try #require(components.url))
        guard case let .gatewayAdd(link) = route else {
            Issue.record("Expected a gateway-add intent")
            return
        }
        #expect(link.url.absoluteString == "https://gateway.example:8443/openclaw%20gateway/")
        #expect(link.name == "Research & Design")
        #expect(GatewayConnectDeepLink.fromSetupInput(components.url!.absoluteString) == nil)
    }

    @Test(arguments: [
        "https://gateway.example/",
        "https://127.0.0.1:8443/",
        "https://openclaw.local/gateway",
        "https://gateway.example/operator%2Fteam",
    ])
    func gatewayAddDeepLinkDoesNotRequireADeploymentHostname(address: String) throws {
        var components = URLComponents(string: "openclaw://gateway/add")!
        components.queryItems = [URLQueryItem(name: "url", value: address)]
        guard case let .gatewayAdd(link) = DeepLinkParser.parse(try #require(components.url)) else {
            Issue.record("Expected a gateway-add intent")
            return
        }
        #expect(link.url.absoluteString == address)
        #expect(link.name == nil)
    }

    @Test(arguments: [
        "http://gateway.example/",
        "http://127.0.0.1:18789/",
        "wss://gateway.example/",
        "file:///tmp/gateway",
        "https://user@gateway.example/",
        "https://gateway.example/?token=secret",
        "https://gateway.example/#secret",
        "https://gateway.example/?",
        "https://gateway.example/#",
        "https://gateway.example:0/",
        "https://gateway.example:65536/",
    ])
    func gatewayAddDeepLinkRejectsNonAddressMetadata(address: String) throws {
        var components = URLComponents(string: "openclaw://gateway/add")!
        components.queryItems = [URLQueryItem(name: "url", value: address)]
        #expect(DeepLinkParser.parse(try #require(components.url)) == nil)
    }

    @Test func gatewayAddDeepLinkRejectsPasswordCredentials() throws {
        var address = try #require(URLComponents(string: "https://gateway.example/"))
        address.user = "fixture-user"
        address.password = "fixture-password"
        var link = try #require(URLComponents(string: "openclaw://gateway/add"))
        link.queryItems = [URLQueryItem(name: "url", value: try #require(address.url).absoluteString)]
        #expect(DeepLinkParser.parse(try #require(link.url)) == nil)
    }

    @Test(arguments: [
        "openclaw://gateway/add?url=https%3A%2F%2Fgateway.example&token=secret",
        "openclaw://gateway/add?url=https%3A%2F%2Fgateway.example&password=secret",
        "openclaw://gateway/add?url=https%3A%2F%2Fgateway.example&url=https%3A%2F%2Fother.example",
        "openclaw://gateway/add?url=https%3A%2F%2Fgateway.example&name=One&name=Two",
        "openclaw://gateway/add?url=https%3A%2F%2Fgateway.example#secret",
        "openclaw://user@gateway/add?url=https%3A%2F%2Fgateway.example",
        "openclaw://gateway:443/add?url=https%3A%2F%2Fgateway.example",
        "openclaw://gateway/add?host=gateway.example&tls=1&token=secret",
    ])
    func gatewayAddDeepLinkRejectsCredentialsAndAmbiguousParameters(raw: String) throws {
        #expect(DeepLinkParser.parse(try #require(URL(string: raw))) == nil)
    }

    @Test func gatewayDeepLinkUsesTlsDefaultPortWhenPortMissing() {
        let link = gatewayLink(from: "openclaw://gateway?host=gateway.example.com&tls=1")
        #expect(link?.port == 443)
        #expect(link?.tls == true)
    }

    @Test func gatewayDeepLinkUsesPlaintextDefaultPortWhenPortMissing() {
        let link = gatewayLink(from: "openclaw://gateway?host=127.0.0.1&tls=0")
        #expect(link?.port == 18789)
        #expect(link?.tls == false)
    }

    @Test func gatewayDeepLinkPreservesExplicitTlsPort() {
        let link = gatewayLink(from: "openclaw://gateway?host=gateway.example.com&port=18789&tls=1")
        #expect(link?.port == 18789)
        #expect(link?.tls == true)
    }

    @Test func gatewayDeepLinkRejectsInsecureNonLoopbackWs() {
        let url = URL(
            string: "openclaw://gateway?host=attacker.example&port=18789&tls=0&token=abc")!
        #expect(DeepLinkParser.parse(url) == nil)
    }

    @Test func gatewayDeepLinkRejectsInsecurePrefixBypassHost() {
        let url = URL(
            string: "openclaw://gateway?host=127.attacker.example&port=18789&tls=0&token=abc")!
        #expect(DeepLinkParser.parse(url) == nil)
    }

    @Test func gatewayDeepLinkAllowsLoopbackWs() {
        let url = URL(
            string: "openclaw://gateway?host=127.0.0.1&port=18789&tls=0&token=abc")!
        #expect(
            DeepLinkParser.parse(url) == .gateway(
                .init(
                    host: "127.0.0.1",
                    port: 18789,
                    tls: false,
                    bootstrapToken: nil,
                    token: "abc",
                    password: nil)))
    }

    @Test func setupCodeRejectsInsecureNonLoopbackWs() {
        let payload = #"{"url":"ws://attacker.example:18789","bootstrapToken":"tok"}"#
        #expect(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == nil)
    }

    @Test func setupCodeRejectsInsecurePrefixBypassHost() {
        let payload = #"{"url":"ws://127.attacker.example:18789","bootstrapToken":"tok"}"#
        #expect(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == nil)
    }

    @Test func setupCodeAllowsLoopbackWs() {
        let payload = #"{"url":"ws://127.0.0.1:18789","bootstrapToken":"tok"}"#
        #expect(
            GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == .init(
                host: "127.0.0.1",
                port: 18789,
                tls: false,
                bootstrapToken: "tok",
                token: nil,
                password: nil))
    }

    @Test func setupCodeAcceptsPairingURLWrapperWithoutLowercasingPayload() {
        let payload = #"{"url":"wss://gateway.example:8443","bootstrapToken":"Bootstrap-AbC123"}"#
        let code = setupCode(from: payload)

        #expect(
            GatewayConnectDeepLink.fromSetupCode("oc-pair://\(code)") ==
                GatewayConnectDeepLink.fromSetupCode(code))
    }

    @Test func setupCodePreservesPrimaryGatewayContextPath() {
        let payload = #"{"url":"wss://gateway.example/openclaw-gw","bootstrapToken":"tok"}"#
        let link = GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload))

        #expect(link?.contextPath == "/openclaw-gw")
        #expect(link?.websocketURL?.absoluteString == "wss://gateway.example:443/openclaw-gw")
    }

    @Test func setupCodeDecodesGatewayContextPathExactlyOnce() {
        let payload = #"{"url":"wss://gateway.example/openclaw%20gateway","bootstrapToken":"tok"}"#
        let link = GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload))

        #expect(link?.contextPath == "/openclaw%20gateway")
        #expect(link?.websocketURL?.absoluteString == "wss://gateway.example:443/openclaw%20gateway")
    }

    @Test func setupCodePreservesEscapedGatewayPathDelimiter() {
        let payload = #"{"url":"wss://gateway.example/openclaw%2Fgateway","bootstrapToken":"tok"}"#
        let link = GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload))

        #expect(link?.contextPath == "/openclaw%2Fgateway")
        #expect(link?.websocketURL?.absoluteString == "wss://gateway.example:443/openclaw%2Fgateway")
    }

    @Test func setupCodePreservesNonUTF8GatewayPathOctet() {
        let payload = #"{"url":"wss://gateway.example/openclaw%FFgateway","bootstrapToken":"tok"}"#
        let link = GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload))

        #expect(link?.contextPath == "/openclaw%FFgateway")
        #expect(link?.websocketURL?.absoluteString == "wss://gateway.example:443/openclaw%FFgateway")
    }

    @Test func setupCodeAllowsPrivateLanWs() {
        let payload = #"{"url":"ws://192.168.1.20:18789","bootstrapToken":"tok"}"#
        #expect(
            GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == .init(
                host: "192.168.1.20",
                port: 18789,
                tls: false,
                bootstrapToken: "tok",
                token: nil,
                password: nil))
    }

    @Test func setupCodeAllowsMDNSWs() {
        let payload = #"{"url":"ws://openclaw.local:18789","bootstrapToken":"tok"}"#
        #expect(
            GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == .init(
                host: "openclaw.local",
                port: 18789,
                tls: false,
                bootstrapToken: "tok",
                token: nil,
                password: nil))
    }

    @Test func setupCodeParsesOrderedGatewayFallbacks() throws {
        let payload = #"{"url":"ws://192.168.1.20:18789/lan-gw","urls":["ws://192.168.1.20:18789/lan-gw","wss://gateway.tailnet.ts.net:8443/tailnet-gw"],"bootstrapToken":"tok"}"#
        let link = GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload))

        #expect(link?.connectionEndpoints == [
            .init(host: "192.168.1.20", port: 18789, tls: false, contextPath: "/lan-gw"),
            .init(host: "gateway.tailnet.ts.net", port: 8443, tls: true, contextPath: "/tailnet-gw"),
        ])
        #expect(try link?.selectingEndpoint(#require(link?.connectionEndpoints[1])) == .init(
            host: "gateway.tailnet.ts.net",
            port: 8443,
            tls: true,
            contextPath: "/tailnet-gw",
            bootstrapToken: "tok",
            token: nil,
            password: nil))
    }

    @Test func setupCodeCarriesNormalizedTLSFingerprint() {
        let fingerprint = (0..<32).map { _ in "AB" }.joined(separator: ":")
        let payload = #"{"url":"wss://gateway.example.com","tlsFingerprint":"SHA256:\#(fingerprint)"}"#
        let link = GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload))

        #expect(link?.tlsFingerprintSha256 == fingerprint.replacingOccurrences(of: ":", with: "").lowercased())
    }

    @Test func setupCodeRejectsInvalidTLSFingerprint() {
        let payload = #"{"url":"wss://gateway.example.com","tlsFingerprint":"not-a-fingerprint"}"#

        #expect(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == nil)
    }

    @Test func setupCodeRejectsExpiredPayload() {
        let payload = #"{"url":"wss://gateway.example.com","expiresAtMs":1}"#

        #expect(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == nil)
    }

    @Test func publicInitializerRejectsMalformedTLSFingerprint() {
        let link = GatewayConnectDeepLink(
            host: "gateway.example.com",
            port: 443,
            tls: true,
            tlsFingerprintSha256: "not-a-fingerprint",
            bootstrapToken: nil,
            token: nil,
            password: nil)

        #expect(!link.isValidEndpoint)
    }

    @Test func setupCodeRejectsTLSFingerprintOnPlaintextEndpoint() {
        let fingerprint = String(repeating: "ab", count: 32)
        let payload = #"{"url":"ws://127.0.0.1:18789","tlsFingerprint":"\#(fingerprint)"}"#

        #expect(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == nil)
    }

    @Test func fallbackEndpointDoesNotInheritPrimaryTLSFingerprint() throws {
        let fingerprint = String(repeating: "ab", count: 32)
        let expiresAtMs: Int64 = 4_102_444_800_000
        let payload = #"{"url":"wss://direct.example.com","urls":["wss://direct.example.com","wss://proxy.example.com"],"tlsFingerprint":"\#(fingerprint)","expiresAtMs":\#(expiresAtMs)}"#
        let link = try #require(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)))
        let fallback = try #require(link.fallbackEndpoints.first)
        let selectedFallback = link.selectingEndpoint(fallback)

        #expect(link.tlsFingerprintSha256 == fingerprint)
        #expect(link.expiresAtMs == expiresAtMs)
        #expect(selectedFallback.tlsFingerprintSha256 == nil)
        #expect(selectedFallback.expiresAtMs == expiresAtMs)
    }

    @Test func rejectedPrimaryDoesNotTransferTLSFingerprintToFallback() throws {
        let fingerprint = String(repeating: "ab", count: 32)
        let payload = #"{"url":"ws://127.0.0.1:18789","urls":["wss://proxy.example.com"],"tlsFingerprint":"\#(fingerprint)"}"#
        let link = try #require(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)))

        #expect(link.host == "proxy.example.com")
        #expect(link.tlsFingerprintSha256 == nil)
    }

    @Test func legacyEncodedGatewayLinkDecodesWithoutFallbacks() throws {
        let payload = #"{"host":"gateway.tailnet.ts.net","port":443,"tls":true}"#

        let link = try JSONDecoder().decode(
            GatewayConnectDeepLink.self,
            from: Data(payload.utf8))

        #expect(link.contextPath == nil)
        #expect(link.fallbackEndpoints.isEmpty)
    }

    @Test func legacyEncodedFallbackEndpointDecodesWithoutContextPath() throws {
        let payload = #"{"host":"gateway.example","port":443,"tls":true,"fallbackEndpoints":[{"host":"fallback.example","port":443,"tls":true}]}"#

        let link = try JSONDecoder().decode(
            GatewayConnectDeepLink.self,
            from: Data(payload.utf8))

        #expect(link.fallbackEndpoints == [
            .init(host: "fallback.example", port: 443, tls: true),
        ])
    }

    @Test func setupCodeRejectsGatewayURLMetadata() {
        let urls = [
            "wss://user@gateway.example/openclaw-gw",
            "wss://gateway.example/openclaw-gw?mode=setup",
            "wss://gateway.example/openclaw-gw#fragment",
        ]

        for url in urls {
            let payload = #"{"url":"\#(url)","bootstrapToken":"tok"}"#
            #expect(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == nil)
        }
    }

    @Test func setupCodeDropsInsecureGatewayFallbacks() {
        let payload = #"{"url":"ws://attacker.example:18789","urls":["ws://attacker.example:18789","wss://gateway.tailnet.ts.net"],"bootstrapToken":"tok"}"#

        #expect(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == .init(
            host: "gateway.tailnet.ts.net",
            port: 443,
            tls: true,
            bootstrapToken: "tok",
            token: nil,
            password: nil))
    }

    @Test func setupCodeCapsGatewayEndpoints() throws {
        let urls = (0..<10).map { "wss://gateway-\($0).example.com" }
        let data = try JSONSerialization.data(withJSONObject: ["url": urls[0], "urls": urls])
        let payload = try #require(String(data: data, encoding: .utf8))

        let link = GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload))

        #expect(link?.connectionEndpoints.count == 8)
        #expect(link?.connectionEndpoints.last?.host == "gateway-7.example.com")
    }

    @Test func setupCodeRejectsTailnetPlaintextWs() {
        let payload = #"{"url":"ws://gateway.tailnet.ts.net:18789","bootstrapToken":"tok"}"#
        #expect(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == nil)
    }

    @Test func setupCodeRejectsCgnatPlaintextWs() {
        let payload = #"{"url":"ws://100.64.0.9:18789","bootstrapToken":"tok"}"#
        #expect(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == nil)
    }

    @Test func setupCodeParsesHostPayload() {
        let payload = #"{"host":"gateway.tailnet.ts.net","port":443,"tls":true,"bootstrapToken":"tok"}"#
        #expect(
            GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == .init(
                host: "gateway.tailnet.ts.net",
                port: 443,
                tls: true,
                bootstrapToken: "tok",
                token: nil,
                password: nil))
    }

    @Test func setupCodeParsesHostPayloadWithTLSDefaultPort() {
        let payload = #"{"host":"gateway.tailnet.ts.net","tls":true,"bootstrapToken":"tok"}"#
        #expect(
            GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == .init(
                host: "gateway.tailnet.ts.net",
                port: 443,
                tls: true,
                bootstrapToken: "tok",
                token: nil,
                password: nil))
    }

    @Test func setupCodeRejectsInsecureHostPayload() {
        let payload = #"{"host":"gateway.tailnet.ts.net","port":18789,"tls":false,"bootstrapToken":"tok"}"#
        #expect(GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == nil)
    }

    @Test func setupCodeAllowsPrivateLanHostPayload() {
        let payload = #"{"host":"openclaw.local","port":18789,"tls":false,"bootstrapToken":"tok"}"#
        #expect(
            GatewayConnectDeepLink.fromSetupCode(setupCode(from: payload)) == .init(
                host: "openclaw.local",
                port: 18789,
                tls: false,
                bootstrapToken: "tok",
                token: nil,
                password: nil))
    }

    @Test func setupInputParsesFullCopiedSetupMessage() {
        let payload = #"{"url":"wss://gateway.tailnet.ts.net","bootstrapToken":"tok"}"#
        let message = """
        Pairing setup code generated.

        Setup code:
        \(setupCode(from: payload))
        """
        #expect(
            GatewayConnectDeepLink.fromSetupInput(message) == .init(
                host: "gateway.tailnet.ts.net",
                port: 443,
                tls: true,
                bootstrapToken: "tok",
                token: nil,
                password: nil))
    }

    @Test func setupInputParsesRawGatewayURL() {
        #expect(
            GatewayConnectDeepLink.fromSetupInput("wss://gateway.example.com:444") == .init(
                host: "gateway.example.com",
                port: 444,
                tls: true,
                bootstrapToken: nil,
                token: nil,
                password: nil))
    }
}
