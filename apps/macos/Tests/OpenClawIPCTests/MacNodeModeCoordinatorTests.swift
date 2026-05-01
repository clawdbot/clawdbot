import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct MacNodeModeCoordinatorTests {
    @Test func `remote mode does not advertise browser proxy`() {
        let caps = MacNodeModeCoordinator.resolvedCaps(
            browserControlEnabled: true,
            cameraEnabled: false,
            locationMode: .off,
            connectionMode: .remote)
        let commands = MacNodeModeCoordinator.resolvedCommands(caps: caps)

        #expect(!caps.contains(OpenClawCapability.browser.rawValue))
        #expect(!commands.contains(OpenClawBrowserCommand.proxy.rawValue))
        #expect(commands.contains(OpenClawCanvasCommand.present.rawValue))
        #expect(commands.contains(OpenClawSystemCommand.notify.rawValue))
    }

    @Test func `local mode advertises browser proxy when enabled`() {
        let caps = MacNodeModeCoordinator.resolvedCaps(
            browserControlEnabled: true,
            cameraEnabled: false,
            locationMode: .off,
            connectionMode: .local)
        let commands = MacNodeModeCoordinator.resolvedCommands(caps: caps)

        #expect(caps.contains(OpenClawCapability.browser.rawValue))
        #expect(commands.contains(OpenClawBrowserCommand.proxy.rawValue))
    }

    @Test func `tls pin store key uses default wss port`() throws {
        let url = try #require(URL(string: "wss://gateway.example.ts.net"))
        #expect(MacNodeModeCoordinator.tlsPinStoreKey(for: url) == "gateway.example.ts.net:443")
    }

    @Test func `auto repairs trusted tailscale serve pin mismatch`() throws {
        let url = try #require(URL(string: "wss://gateway.example.ts.net"))
        let failure = GatewayTLSValidationFailure(
            kind: .pinMismatch,
            host: "gateway.example.ts.net",
            storeKey: "gateway.example.ts.net:443",
            expectedFingerprint: "old",
            observedFingerprint: "new",
            systemTrustOk: true)

        #expect(MacNodeModeCoordinator.shouldAutoRepairStaleTLSPin(url: url, failure: failure))
    }

    @Test func `does not auto repair untrusted remote pin mismatch`() throws {
        let url = try #require(URL(string: "wss://gateway.example.com"))
        let failure = GatewayTLSValidationFailure(
            kind: .pinMismatch,
            host: "gateway.example.com",
            storeKey: "gateway.example.com:443",
            expectedFingerprint: "old",
            observedFingerprint: "new",
            systemTrustOk: true)

        #expect(!MacNodeModeCoordinator.shouldAutoRepairStaleTLSPin(url: url, failure: failure))
    }

    @Test func `auto repairs trusted loopback pin mismatch`() throws {
        let url = try #require(URL(string: "wss://127.0.0.1:18789"))
        let failure = GatewayTLSValidationFailure(
            kind: .pinMismatch,
            host: "127.0.0.1",
            storeKey: "127.0.0.1:18789",
            expectedFingerprint: "old",
            observedFingerprint: "new",
            systemTrustOk: true)

        #expect(MacNodeModeCoordinator.shouldAutoRepairStaleTLSPin(url: url, failure: failure))
    }

    @Test func `does not auto repair untrusted loopback pin mismatch`() throws {
        let url = try #require(URL(string: "wss://127.0.0.1:18789"))
        let failure = GatewayTLSValidationFailure(
            kind: .pinMismatch,
            host: "127.0.0.1",
            storeKey: "127.0.0.1:18789",
            expectedFingerprint: "old",
            observedFingerprint: "new",
            systemTrustOk: false)

        #expect(!MacNodeModeCoordinator.shouldAutoRepairStaleTLSPin(url: url, failure: failure))
    }
}
