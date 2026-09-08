import Foundation
import Testing
@testable import OpenClaw

struct GatewayBrowserSignInCoordinatorTests {
    @Test(arguments: [
        ("gateway.example", "wss://gateway.example:443/"),
        ("https://another.example/workspace", "wss://another.example:443/workspace"),
        ("wss://gateway.example:9443/proxy/a%2Fb", "wss://gateway.example:9443/proxy/a%2Fb"),
        ("http://localhost:18789", "ws://localhost:18789/"),
        ("ws://192.168.1.20:18789/", "ws://192.168.1.20:18789/"),
    ])
    func `address entry preserves gateway authority and base path`(address: String, expected: String) throws {
        #expect(try GatewayBrowserSignInCoordinator.gatewayURL(from: address).absoluteString == expected)
    }

    @Test(arguments: [
        "", "https://", "http://public.example", "ws://public.example", "ftp://gateway.example",
        "https://fixture-user@gateway.example", "https://gateway.example?token=secret",
        "https://gateway.example#secret", "https://gateway.example:0", "https://gateway.example:65536",
        "openclaw://gateway?host=gateway.example&tls=1&token=secret",
    ])
    func `address entry rejects credential links and insecure public gateways`(address: String) {
        #expect(throws: MacGatewayProfileError.self) {
            try GatewayBrowserSignInCoordinator.gatewayURL(from: address)
        }
    }
}
