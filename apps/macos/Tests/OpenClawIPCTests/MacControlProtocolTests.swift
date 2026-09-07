import Foundation
import OpenClawIPC
import Testing

struct MacControlProtocolTests {
    @Test func `authenticated request survives the JSONL wire and rejects tampering or stale timestamp`() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        var request = MacControlRequest(operation: "gateway.add")
        request.name = "Demo"
        request.url = "wss://gateway.example"
        request.token = "synthetic-gateway-credential"
        let signed = try MacControlEnvelope(request: request, token: "synthetic-control-credential", now: now)
        let received = try JSONDecoder().decode(MacControlEnvelope.self, from: JSONEncoder().encode(signed))
        #expect(received.authenticated(token: "synthetic-control-credential", now: now))
        #expect(!received.authenticated(token: "wrong-token", now: now))
        #expect(!received.authenticated(token: "", now: now))
        #expect(!received.authenticated(token: "synthetic-control-credential", now: now.addingTimeInterval(16)))
        #expect(!received.authenticated(token: "synthetic-control-credential", now: now.addingTimeInterval(-16)))
        var tampered = received
        tampered.requestJson = #"{"operation":"primary.clear"}"#
        #expect(!tampered.authenticated(token: "synthetic-control-credential", now: now))
        let decoded = try JSONDecoder().decode(MacControlRequest.self, from: Data(received.requestJson.utf8))
        #expect(decoded.operation == "gateway.add")
        #expect(decoded.name == "Demo")
        #expect(decoded.token == "synthetic-gateway-credential")
    }

    @Test func `status wire always includes nullable transport and only public connection metadata`() throws {
        let primary = MacControlPrimaryStatus(
            mode: "unconfigured", transport: nil, url: "",
            tunnel: MacControlTunnelStatus(running: false),
            connection: MacControlConnectionStatus(state: "disconnected"))
        let gateway = MacControlGatewayStatus(
            id: "demo", name: "Demo", url: "wss://gateway.example", auth: "browser",
            identity: MacControlIdentity(subject: "operator@example.test", expiresAt: "2026-09-06T00:00:00Z"),
            connection: MacControlConnectionStatus(state: "connected"))
        let status = MacControlStatus(
            primary: primary, gateways: [gateway], app: MacControlAppStatus(
                version: "1",
                build: "2",
                profile: "default"))
        let data = try JSONEncoder().encode(MacControlResponse(result: status))
        let object = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let result = try #require(object["result"] as? [String: Any])
        #expect((result["primary"] as? [String: Any])?["transport"] is NSNull)
        let publicGateway = try #require((result["gateways"] as? [[String: Any]])?.first)
        #expect(publicGateway["token"] == nil)
        #expect(publicGateway["password"] == nil)
        #expect((publicGateway["identity"] as? [String: Any])?["subject"] as? String == "operator@example.test")
    }
}
