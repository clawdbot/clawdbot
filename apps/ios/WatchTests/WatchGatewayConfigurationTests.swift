import Foundation
import OpenClawKit
import Testing
@testable import OpenClawWatchApp

struct WatchGatewayConfigurationTests {
    @Test func `direct Watch setup retains the endpoint prefix across credential handoff`() throws {
        let link = GatewayConnectDeepLink(
            host: "watch.example.invalid",
            port: 443,
            tls: true,
            contextPath: "/gateways/team%2Fwatch",
            bootstrapToken: "one-time-setup",
            token: nil,
            password: nil)
        let configuration = try #require(WatchGatewayConfiguration(setupLink: link, sentAtMs: 1))
        let paired = configuration.withoutBootstrapToken()

        #expect(configuration.link.contextPath == "/gateways/team%2Fwatch")
        #expect(configuration.gatewayID == "watch-direct:https://watch.example.invalid:443/gateways/team%2Fwatch")
        #expect(WatchGatewayConfiguration.httpBaseURL(for: paired.link)?.absoluteString
            == "https://watch.example.invalid:443/gateways/team%2Fwatch")
        #expect(paired.voiceConnection.websocketURLs.first?.absoluteString
            == "wss://watch.example.invalid:443/gateways/team%2Fwatch")
        #expect(paired.link.bootstrapToken == nil)

        let restored = try JSONDecoder().decode(
            WatchGatewayConfiguration.self,
            from: JSONEncoder().encode(paired))
        #expect(restored.voiceConnection == paired.voiceConnection)
    }

    @Test func `direct Watch setup selects a secure endpoint without changing its namespace`() throws {
        let link = try #require(GatewayConnectDeepLink.fromSetupCode(
            #"{"url":"ws://192.168.1.2:18789","urls":["wss://watch.example.invalid/team-a","wss://backup.example.invalid/team-b"],"bootstrapToken":"one-time-setup"}"#))
        let configuration = try #require(WatchGatewayConfiguration(setupLink: link, sentAtMs: 2))
        #expect(configuration.link.contextPath == "/team-a")
        #expect(configuration.voiceConnection.websocketURLs.map(\.absoluteString)
            == ["wss://watch.example.invalid:443/team-a", "wss://backup.example.invalid:443/team-b"])
    }

    @Test func `voice connection ownership keeps exact gateway bytes and pairing generation`() {
        let owner = WatchVoiceConnection(gatewayID: "gateway-e\u{301}", websocketURLs: [], setupSentAtMs: 1)
        #expect(owner != WatchVoiceConnection(gatewayID: "gateway-\u{E9}", websocketURLs: [], setupSentAtMs: 1))
        #expect(owner != WatchVoiceConnection(gatewayID: owner.gatewayID, websocketURLs: [], setupSentAtMs: 2))
    }

    @Test func `voice setup accepts only the separate read and talk credential`() throws {
        let voice = try JSONDecoder().decode(WatchNodeConnectResponse.self, from: Data(
            #"""
            {"sessionToken":"http-session","deviceToken":"node-only","deviceTokens":[
              {"role":"operator","deviceToken":"voice-only",
               "scopes":["operator.talk","operator.read"],"issuedAtMs":1}
            ]}
            """#.utf8))
        #expect(voice.deviceToken == "node-only")
        #expect(voice.voiceCredential?.deviceToken == "voice-only")
        let node = try JSONDecoder().decode(WatchNodeConnectResponse.self, from: Data(
            #"{"sessionToken":"http-session","deviceToken":"node-only"}"#.utf8))
        #expect(node.voiceCredential == nil)
    }

    @Test(arguments: [
        ["operator.read"],
        ["operator.read", "operator.talk", "operator.write"],
        ["operator.admin"],
        ["operator.read", "operator.talk", "operator.talk.secrets"],
        ["operator.read", "operator.talk", "operator.talk"],
    ])
    func `voice setup rejects incomplete or broader grants`(scopes: [String]) throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "sessionToken": "http-session",
            "deviceToken": "node-only",
            "deviceTokens": [["role": "operator", "deviceToken": "voice", "scopes": scopes]],
        ])
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(WatchNodeConnectResponse.self, from: data)
        }
    }
}
