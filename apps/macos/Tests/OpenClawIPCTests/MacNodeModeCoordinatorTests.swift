import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct MacNodeModeCoordinatorTests {
    @Test @MainActor func `fresh node uses durable dedicated identity for local auto approval`() throws {
        let defaults = try #require(UserDefaults(suiteName: "MacNodeModeCoordinatorTests.fresh.\(UUID().uuidString)"))

        #expect(MacNodeModeCoordinator.resolveNodeIdentityProfile(
            defaults: defaults,
            isExistingInstallation: false) == .node)
        #expect(MacNodeModeCoordinator.resolveNodeIdentityProfile(
            defaults: defaults,
            isExistingInstallation: true) == .node)
    }

    @Test @MainActor func `upgraded node durably preserves its shipped primary identity`() throws {
        let defaults = try #require(UserDefaults(suiteName: "MacNodeModeCoordinatorTests.upgrade.\(UUID().uuidString)"))

        #expect(MacNodeModeCoordinator.resolveNodeIdentityProfile(
            defaults: defaults,
            isExistingInstallation: true) == .primary)
        #expect(MacNodeModeCoordinator.resolveNodeIdentityProfile(
            defaults: defaults,
            isExistingInstallation: false) == .primary)
    }

    @Test func `remote mode does not advertise browser proxy`() {
        let caps = MacNodeModeCoordinator.resolvedCaps(
            browserControlEnabled: true,
            cameraEnabled: false,
            computerControlEnabled: false,
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
            computerControlEnabled: false,
            locationMode: .off,
            connectionMode: .local)
        let commands = MacNodeModeCoordinator.resolvedCommands(caps: caps)

        #expect(caps.contains(OpenClawCapability.browser.rawValue))
        #expect(commands.contains(OpenClawBrowserCommand.proxy.rawValue))
    }

    @Test func `codex supervisor config advertises native thread catalog`() {
        let caps = MacNodeModeCoordinator.resolvedCaps(
            browserControlEnabled: false,
            cameraEnabled: false,
            computerControlEnabled: false,
            locationMode: .off,
            connectionMode: .remote,
            codexThreadCatalogEnabled: true)
        let commands = MacNodeModeCoordinator.resolvedCommands(caps: caps)

        #expect(caps.contains(MacNodeCodexThreadCatalogContract.capability))
        #expect(commands.contains(MacNodeCodexThreadCatalogContract.listCommand))
    }

    @Test func `codex supervisor plugin activation respects global policy`() {
        let enabled: [String: Any] = [
            "plugins": [
                "entries": ["codex-supervisor": ["enabled": true]],
            ],
        ]
        #expect(OpenClawConfigFile.explicitlyEnabledPlugin("codex-supervisor", root: enabled))

        let denied: [String: Any] = [
            "plugins": [
                "deny": ["codex-supervisor"],
                "entries": ["codex-supervisor": ["enabled": true]],
            ],
        ]
        #expect(!OpenClawConfigFile.explicitlyEnabledPlugin("codex-supervisor", root: denied))

        let omittedByAllowlist: [String: Any] = [
            "plugins": [
                "allow": ["other-plugin"],
                "entries": ["codex-supervisor": ["enabled": true]],
            ],
        ]
        #expect(!OpenClawConfigFile.explicitlyEnabledPlugin(
            "codex-supervisor",
            root: omittedByAllowlist))

        let paddedIds: [String: Any] = [
            "plugins": [
                "allow": [" codex-supervisor "],
                "entries": [" codex-supervisor ": ["enabled": true]],
            ],
        ]
        #expect(OpenClawConfigFile.explicitlyEnabledPlugin(
            "codex-supervisor",
            root: paddedIds))

        let paddedDeny: [String: Any] = [
            "plugins": [
                "deny": [" codex-supervisor "],
                "entries": ["codex-supervisor": ["enabled": true]],
            ],
        ]
        #expect(!OpenClawConfigFile.explicitlyEnabledPlugin(
            "codex-supervisor",
            root: paddedDeny))
    }

    @Test func `computer control cap gates the computer.act command`() {
        let enabledCaps = MacNodeModeCoordinator.resolvedCaps(
            browserControlEnabled: false,
            cameraEnabled: false,
            computerControlEnabled: true,
            locationMode: .off,
            connectionMode: .local)
        let enabledCommands = MacNodeModeCoordinator.resolvedCommands(caps: enabledCaps)
        #expect(enabledCaps.contains(OpenClawCapability.computer.rawValue))
        #expect(enabledCommands.contains(OpenClawComputerCommand.act.rawValue))

        let disabledCaps = MacNodeModeCoordinator.resolvedCaps(
            browserControlEnabled: false,
            cameraEnabled: false,
            computerControlEnabled: false,
            locationMode: .off,
            connectionMode: .local)
        let disabledCommands = MacNodeModeCoordinator.resolvedCommands(caps: disabledCaps)
        #expect(!disabledCaps.contains(OpenClawCapability.computer.rawValue))
        #expect(!disabledCommands.contains(OpenClawComputerCommand.act.rawValue))
    }

    @Test func `tls pin store key uses default wss port`() throws {
        let url = try #require(URL(string: "wss://gateway.example.ts.net"))
        #expect(MacNodeModeCoordinator.tlsPinStoreKey(for: url) == "gateway.example.ts.net:443")
    }

    @Test func `remote tls params prefer configured fingerprint over stored pin`() throws {
        let url = try #require(URL(string: "wss://gateway.example.com"))
        let root: [String: Any] = [
            "gateway": [
                "remote": [
                    "tlsFingerprint": "sha256:configured",
                ],
            ],
        ]

        let params = try #require(MacNodeModeCoordinator.tlsParams(
            for: url,
            connectionMode: .remote,
            root: root,
            storedFingerprint: "stored"))

        #expect(params.expectedFingerprint == "sha256:configured")
        #expect(params.allowTOFU == false)
        #expect(params.storeKey == "gateway.example.com:443")
    }

    @Test func `remote tls params allow first use only when no configured or stored pin exists`() throws {
        let url = try #require(URL(string: "wss://gateway.example.com"))

        let params = try #require(MacNodeModeCoordinator.tlsParams(
            for: url,
            connectionMode: .remote,
            root: [:],
            storedFingerprint: nil))

        #expect(params.expectedFingerprint == nil)
        #expect(params.allowTOFU == true)
    }

    @Test func `local tls params ignore remote configured fingerprint`() throws {
        let url = try #require(URL(string: "wss://127.0.0.1:18789"))
        let root: [String: Any] = [
            "gateway": [
                "remote": [
                    "tlsFingerprint": "sha256:remote",
                ],
            ],
        ]

        let params = try #require(MacNodeModeCoordinator.tlsParams(
            for: url,
            connectionMode: .local,
            root: root,
            storedFingerprint: "stored-local"))

        #expect(params.expectedFingerprint == "stored-local")
        #expect(params.allowTOFU == false)
    }

    @Test func `tls session cache reuses session box for unchanged params`() throws {
        let url = try #require(URL(string: "wss://gateway.example.com"))
        var cache = MacNodeGatewayTLSSessionCache()
        let params = try #require(MacNodeModeCoordinator.tlsParams(
            for: url,
            connectionMode: .remote,
            root: ["gateway": ["remote": ["tlsFingerprint": "sha256:configured"]]],
            storedFingerprint: "stored"))

        let first = cache.sessionBox(url: url, params: params)
        let second = cache.sessionBox(url: url, params: params)

        #expect(ObjectIdentifier(first.session) == ObjectIdentifier(second.session))
    }

    @Test func `tls session cache rebuilds session box when params change`() throws {
        let url = try #require(URL(string: "wss://gateway.example.com"))
        var cache = MacNodeGatewayTLSSessionCache()
        let firstParams = try #require(MacNodeModeCoordinator.tlsParams(
            for: url,
            connectionMode: .remote,
            root: ["gateway": ["remote": ["tlsFingerprint": "sha256:configured"]]],
            storedFingerprint: "stored"))
        let secondParams = try #require(MacNodeModeCoordinator.tlsParams(
            for: url,
            connectionMode: .remote,
            root: ["gateway": ["remote": ["tlsFingerprint": "sha256:rotated"]]],
            storedFingerprint: "stored"))

        let first = cache.sessionBox(url: url, params: firstParams)
        let second = cache.sessionBox(url: url, params: secondParams)

        #expect(ObjectIdentifier(first.session) != ObjectIdentifier(second.session))
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
