import AppKit
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct DashboardGatewayCatalogTests {
    @Test func `catalog deduplicates active profile and adopts its name`() throws {
        let primaryURL = try #require(URL(string: "wss://studio.example/control"))
        let duplicate = MacGatewayCatalogProfile(
            profile: MacGatewayProfile(id: "studio", name: "My Studio", url: primaryURL),
            canPromote: true)
        let other = try MacGatewayCatalogProfile(
            profile: MacGatewayProfile(
                id: "backup",
                name: "Backup",
                url: #require(URL(string: "wss://backup.example"))),
            canPromote: false)

        let entries = DashboardGatewayCatalog.entries(
            mode: .remote,
            primaryRemoteURL: primaryURL,
            resolvedRemoteURL: nil,
            resolvedRemoteHostLabel: "studio.example:443",
            profiles: [duplicate, other],
            primaryHealth: .ok)

        #expect(entries.map(\.id) == ["primary", "profile:backup"])
        #expect(entries[0].name == "My Studio")
        #expect(entries[0].kind == "remote")
        #expect(entries[0].health == .ok)
        #expect(!entries[0].canPromote)
        #expect(!entries[1].canPromote)
        #expect(entries[1].health == .unknown)
    }

    @Test func `catalog deduplicates profile matching resolved SSH endpoint`() throws {
        let tunnelURL = try #require(URL(string: "ws://127.0.0.1:18789"))
        let profile = MacGatewayCatalogProfile(
            profile: MacGatewayProfile(id: "loopback", name: "127.0.0.1", url: tunnelURL),
            canPromote: true)

        let entries = DashboardGatewayCatalog.entries(
            mode: .remote,
            primaryRemoteURL: nil,
            resolvedRemoteURL: tunnelURL,
            resolvedRemoteHostLabel: "127.0.0.1:18789",
            profiles: [profile],
            primaryHealth: .ok)

        #expect(entries.map(\.id) == ["primary"])
        #expect(entries[0].name == "127.0.0.1")
    }

    @Test func `catalog deduplicates configured SSH endpoint before resolution`() throws {
        let tunnelURL = try #require(URL(string: "ws://127.0.0.1:18789"))
        let profile = MacGatewayCatalogProfile(
            profile: MacGatewayProfile(id: "loopback", name: "127.0.0.1", url: tunnelURL),
            canPromote: true)

        let entries = DashboardGatewayCatalog.entries(
            mode: .remote,
            primaryRemoteURL: tunnelURL,
            resolvedRemoteURL: nil,
            resolvedRemoteHostLabel: nil,
            profiles: [profile],
            primaryHealth: .unknown)

        #expect(entries.map(\.id) == ["primary"])
        #expect(entries[0].name == "127.0.0.1")
    }

    @Test @MainActor func `catalog maps live control health`() {
        #expect(DashboardGatewayCatalog.primaryHealth(for: .connected) == .ok)
        #expect(DashboardGatewayCatalog.primaryHealth(for: .disconnected) == .unknown)
        #expect(DashboardGatewayCatalog.primaryHealth(for: .connecting) == .unknown)
        #expect(DashboardGatewayCatalog.primaryHealth(for: .degraded("offline")) == .error)
    }

    @Test func `local catalog does not deduplicate a retained remote profile`() throws {
        let url = try #require(URL(string: "wss://studio.example"))
        let entries = DashboardGatewayCatalog.entries(
            mode: .local,
            primaryRemoteURL: url,
            resolvedRemoteURL: nil,
            resolvedRemoteHostLabel: "127.0.0.1:18789",
            profiles: [.init(
                profile: .init(id: "studio", name: "Studio", url: url),
                canPromote: true)],
            primaryHealth: .ok)

        #expect(entries.map(\.id) == ["primary", "profile:studio"])
        #expect(entries[0].name == "Local Gateway")
    }
}

@MainActor
struct DashboardGatewaysBridgeTests {
    @Test func `parses gateway bridge requests with role based ids`() {
        #expect(DashboardWindowController.gatewaysRequest(
            from: ["type": "select", "id": "primary"]) == .select(.primary))
        #expect(DashboardWindowController.gatewaysRequest(
            from: ["type": "open-window", "id": "profile:studio"]) == .openWindow(.profile("studio")))
        #expect(DashboardWindowController.gatewaysRequest(
            from: ["type": "set-primary", "id": "profile:studio"]) == .setPrimary(.profile("studio")))
        #expect(DashboardWindowController.gatewaysRequest(
            from: ["type": "open-settings"]) == .openSettings)
        #expect(DashboardWindowController.gatewaysRequest(
            from: ["type": "select", "id": "https://secret.example"]) == nil)
    }

    @Test func `gateway script contains metadata and no credentials`() {
        let snapshot = DashboardGatewaySnapshot(
            gateways: [.init(
                id: "primary",
                name: "Local Gateway",
                kind: "local",
                isPrimary: true,
                canPromote: false,
                health: .ok)],
            currentId: "primary")
        let script = DashboardWindowController.nativeGatewaysScriptSource(snapshot: snapshot, dispatch: true)
        #expect(script.contains("__OPENCLAW_NATIVE_GATEWAYS__"))
        #expect(script.contains("openclaw:native-gateways-changed"))
        #expect(!script.contains("token"))
        #expect(!script.contains("password"))
    }

    @Test func `dashboard controller retains profile TLS policy`() throws {
        let url = try #require(URL(string: "https://gateway.example/control/"))
        let params = GatewayTLSParams(
            required: true,
            expectedFingerprint: String(repeating: "a", count: 64),
            allowTOFU: false,
            storeKey: "profile:studio")
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            tlsParams: params,
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)")

        #expect(controller._testTLSParams == params)
        #expect(DashboardWindowController.isExpectedTLSAuthority(
            host: "gateway.example",
            port: 0,
            dashboardURL: url))
        #expect(DashboardWindowController.isExpectedTLSAuthority(
            host: "gateway.example",
            port: 443,
            dashboardURL: url))
        #expect(!DashboardWindowController.isExpectedTLSAuthority(
            host: "gateway.example",
            port: 8443,
            dashboardURL: url))
        #expect(!DashboardWindowController.isExpectedTLSAuthority(
            host: "other.example",
            port: 443,
            dashboardURL: url))
    }

    @Test func `media capture trust requires the dashboard origin`() throws {
        let url = try #require(URL(string: "https://gateway.example/control/"))
        #expect(DashboardWindowController.isTrustedMediaCaptureOrigin(
            protocol: "https",
            host: "gateway.example",
            port: 443,
            dashboardURL: url))
        #expect(!DashboardWindowController.isTrustedMediaCaptureOrigin(
            protocol: "https",
            host: "other.example",
            port: 443,
            dashboardURL: url))
        #expect(!DashboardWindowController.isTrustedMediaCaptureOrigin(
            protocol: "http",
            host: "gateway.example",
            port: 80,
            dashboardURL: url))
    }
}

@Suite(.serialized)
@MainActor
struct DashboardManagerGatewayTargetTests {
    @Test func `background configuration keeps the gateway profile registry cold`() async {
        var catalogReads = 0
        let manager = DashboardManager._testMake(
            observeGatewayChanges: true,
            automaticGatewayProfileRefreshEnabled: false,
            gatewayEntriesProvider: {
                catalogReads += 1
                return []
            })

        manager.configure(updater: DashboardGatewayTestUpdater())
        NotificationCenter.default.post(name: MacGatewayProfileStore.didChangeNotification, object: nil)
        for _ in 0..<20 {
            await Task.yield()
        }

        #expect(catalogReads == 0)
        #expect(manager._testGatewayRefreshObserverCount() == 0)
    }

    @Test func `interactive configuration retains the gateway profile refresh`() async {
        var catalogReads = 0
        let manager = DashboardManager._testMake(
            gatewayEntriesProvider: {
                catalogReads += 1
                return []
            })

        manager.configure(updater: DashboardGatewayTestUpdater())
        for _ in 0..<20 where catalogReads == 0 {
            await Task.yield()
        }

        #expect(catalogReads == 1)
    }

    @Test func `primary window configuration retains resolved TLS policy`() async throws {
        let state = AppStateStore.shared
        let originalMode = state.connectionMode
        state.connectionMode = .remote
        defer { state.connectionMode = originalMode }
        let url = try #require(URL(string: "wss://studio.example:443/"))
        let params = GatewayTLSParams(
            required: true,
            expectedFingerprint: String(repeating: "a", count: 64),
            allowTOFU: false,
            storeKey: "primary")
        let manager = DashboardManager._testMake(primaryEndpointProvider: { _ in
            GatewayConnection.EndpointSnapshot(
                config: (url: url, token: "primary-token", password: nil),
                tls: GatewayTLSRoute(params: params, allowsTrustedPinReplacement: false),
                routeAuthority: nil)
        })

        #expect(try await manager._testWindowTLSParams(for: .primary) == params)
    }

    @Test func `primary endpoint subscription does not mutate profile targeted main window`() async throws {
        let url = try #require(URL(string: "http://127.0.0.1:60001/#token=current"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: "ws://127.0.0.1:60001/",
                token: "current",
                password: nil),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)")
        controller.show()
        defer { controller.closeDashboard() }
        let entries = DashboardGatewayTestEntries.withProfiles(["studio"])
        let manager = DashboardManager._testMake(gatewayEntriesProvider: { entries })
        manager._testSetController(controller)
        manager._testSetMainTarget(.profile("studio"))

        try await manager.handleEndpointState(.ready(
            mode: .remote,
            url: #require(URL(string: "ws://127.0.0.1:60002")),
            token: "replacement",
            password: nil,
            routeRevision: 2))

        #expect(manager._testController() === controller)
        #expect(controller.currentURL == url)

        try await manager.show()
        #expect(manager._testController() === controller)
        #expect(manager._testMainTarget() == .profile("studio"))
        #expect(!manager.showConfiguredWindowIfPossible())
    }

    @Test func `profile dashboard autosave name is target specific`() {
        #expect(DashboardManager._testAutosaveName(for: .profile("studio")) ==
            "OpenClawDashboardWindow-studio")
    }

    @Test func `removed current profile requires target reconciliation`() {
        let primary = DashboardGatewayEntry(
            id: "primary",
            name: "Local Gateway",
            kind: "local",
            isPrimary: true,
            canPromote: false,
            health: .ok)

        #expect(DashboardManager._testTargetIsAvailable(.primary, in: [primary]))
        #expect(!DashboardManager._testTargetIsAvailable(.profile("removed"), in: [primary]))
    }

    @Test func `opening primary creates isolated auxiliary window`() async throws {
        let state = AppStateStore.shared
        let originalMode = state.connectionMode
        state.connectionMode = .local
        defer { state.connectionMode = originalMode }
        let url = try #require(URL(string: "http://127.0.0.1:60001/#token=current"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: "ws://127.0.0.1:60001/",
                token: "current",
                password: nil),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)")
        let frame = NSRect(x: 180, y: 180, width: 960, height: 720)
        controller.window?.setFrame(frame, display: false)
        controller.show()
        // CI display bounds clamp window frames during show, so preserve the post-clamp source frame.
        let sourceFrame = try #require(controller.window).frame
        let entries = DashboardGatewayTestEntries.withProfiles(["studio"])
        let manager = DashboardManager._testMake(gatewayEntriesProvider: { entries })
        manager.configure(updater: DashboardGatewayTestUpdater())
        manager._testSetController(controller)
        manager._testSetMainTarget(.profile("studio"))
        defer { manager.close() }

        await manager._testOpenWindow(for: .primary)

        #expect(manager._testController() === controller)
        #expect(manager._testMainTarget() == .profile("studio"))
        #expect(controller.window?.frame == sourceFrame)
        let auxiliaryWindows = manager._testAuxiliaryWindows()
        #expect(auxiliaryWindows.count == 1)
        let auxiliary = try #require(auxiliaryWindows.first)
        #expect(auxiliary.target == .primary)
        #expect(auxiliary.controller !== controller)
        #expect(auxiliary.controller.window !== controller.window)
        #expect(auxiliary.controller.window?.frameAutosaveName != controller.window?.frameAutosaveName)
        #expect(!auxiliary.controller._testUpdateBridgeAvailable)
    }

    @Test func `concurrent switches keep the latest selection for one window`() async throws {
        let gate = DashboardSwitchEndpointGate()
        let sourceURL = try #require(URL(string: "http://127.0.0.1:60001/#token=current"))
        let controller = DashboardWindowController(
            url: sourceURL,
            auth: DashboardWindowAuth(
                gatewayUrl: "ws://127.0.0.1:60001/",
                token: "current",
                password: nil),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)")
        let originalWindow = try #require(controller.window)
        let entries = DashboardGatewayTestEntries.withProfiles(["first", "second"])
        let manager = DashboardManager._testMake(
            profileEndpointProvider: { profileID in
                try await gate.endpoint(profileID)
            },
            gatewayEntriesProvider: { entries })
        manager._testSetController(controller)
        defer { manager.close() }

        let first = Task { @MainActor in
            await manager._testSwitchTarget(.profile("first"), in: controller)
        }
        await gate.waitUntilFirstRequested()
        let second = Task { @MainActor in
            await manager._testSwitchTarget(.profile("second"), in: controller)
        }
        await second.value
        await gate.releaseFirst()
        await first.value

        #expect(manager._testMainTarget() == .profile("second"))
        #expect(manager._testController()?.currentURL.port == 60003)
        #expect(manager._testController()?.window === originalWindow)
    }

    @Test func `main menu switch replaces the frontmost dashboard in place`() async throws {
        let sourceURL = try #require(URL(string: "http://127.0.0.1:60001/#token=current"))
        let controller = DashboardWindowController(
            url: sourceURL,
            auth: DashboardWindowAuth(
                gatewayUrl: "ws://127.0.0.1:60001/",
                token: "current",
                password: nil),
            windowAutosaveName: "OpenClawDashboardWindow-Test-\(UUID().uuidString)")
        let frame = NSRect(x: 190, y: 190, width: 940, height: 700)
        controller.window?.setFrame(frame, display: false)
        controller.show()
        // CI display bounds clamp window frames during show, so compare replacement against the actual source frame.
        let originalWindow = try #require(controller.window)
        let sourceFrame = originalWindow.frame
        let entries = DashboardGatewayTestEntries.withProfiles(["studio"])
        let manager = DashboardManager._testMake(
            profileEndpointProvider: { profileID in
                let url = try #require(URL(string: "ws://127.0.0.1:60002"))
                return GatewayConnection.EndpointSnapshot(
                    config: (url: url, token: profileID, password: nil),
                    routeAuthority: nil)
            },
            gatewayEntriesProvider: { entries })
        manager._testSetController(controller)
        defer { manager.close() }

        await manager._testSwitchFrontmostDashboard(to: .profile("studio"))

        #expect(manager._testMainTarget() == .profile("studio"))
        #expect(manager.frontmostDashboardTarget == .profile("studio"))
        #expect(manager._testController() !== controller)
        #expect(manager._testController()?.currentURL.port == 60002)
        #expect(manager._testController()?.window === originalWindow)
        #expect(manager._testController()?.window?.frame == sourceFrame)
    }

    @Test func `main menu switch opens requested gateway when no dashboard exists`() async {
        let entries = DashboardGatewayTestEntries.withProfiles(["studio"])
        let manager = DashboardManager._testMake(
            profileEndpointProvider: { profileID in
                let url = try #require(URL(string: "ws://127.0.0.1:60002"))
                return GatewayConnection.EndpointSnapshot(
                    config: (url: url, token: profileID, password: nil),
                    routeAuthority: nil)
            },
            gatewayEntriesProvider: { entries })
        defer { manager.close() }

        await manager._testSwitchFrontmostDashboard(to: .profile("studio"))

        let windows = manager._testAuxiliaryWindows()
        #expect(windows.count == 1)
        #expect(windows.first?.target == .profile("studio"))
        #expect(windows.first?.controller.isWindowOpen == true)
        #expect(manager.frontmostDashboardTarget == .profile("studio"))
    }
}

private enum DashboardGatewayTestEntries {
    static func withProfiles(_ profileIDs: [String]) -> [DashboardGatewayEntry] {
        [
            DashboardGatewayEntry(
                id: "primary",
                name: "Local Gateway",
                kind: "local",
                isPrimary: true,
                canPromote: false,
                health: .ok),
        ] + profileIDs.map { profileID in
            DashboardGatewayEntry(
                id: "profile:\(profileID)",
                name: profileID.capitalized,
                kind: "remote",
                isPrimary: false,
                canPromote: true,
                health: .unknown)
        }
    }
}

private actor DashboardSwitchEndpointGate {
    private var firstRequested = false
    private var firstContinuation: CheckedContinuation<Void, Never>?

    func endpoint(_ profileID: String) async throws -> GatewayConnection.EndpointSnapshot {
        if profileID == "first" {
            self.firstRequested = true
            await withCheckedContinuation { continuation in
                self.firstContinuation = continuation
            }
        }
        let port = profileID == "first" ? 60002 : 60003
        let url = try #require(URL(string: "ws://127.0.0.1:\(port)"))
        return GatewayConnection.EndpointSnapshot(
            config: (url: url, token: profileID, password: nil),
            routeAuthority: nil)
    }

    func waitUntilFirstRequested() async {
        while !self.firstRequested {
            await Task.yield()
        }
    }

    func releaseFirst() {
        self.firstContinuation?.resume()
        self.firstContinuation = nil
    }
}

@MainActor
private final class DashboardGatewayTestUpdater: UpdaterProviding {
    var automaticallyChecksForUpdates = false
    var automaticallyDownloadsUpdates = false
    let isAvailable = true
    let updateStatus = UpdateStatus()

    func checkForUpdates(_: Any?) {}
}

@MainActor
struct DashboardPrimaryGatewayAdapterTests {
    @Test func `token profile promotion carries its TLS pin`() async throws {
        let state = AppState(preview: true)
        let url = try #require(URL(string: "wss://studio.example:443/"))
        let fingerprint = String(repeating: "a", count: 64)
        var persistedFingerprints: [String?] = []
        let adapter = DashboardPrimaryGatewayAdapter(
            state: state,
            endpoint: { _ in
                GatewayConnection.EndpointSnapshot(
                    config: (url: url, token: "profile-token", password: nil),
                    tls: DashboardGatewayTestTLS.route(fingerprint: fingerprint),
                    routeAuthority: nil)
            },
            persist: { _, fingerprint in
                persistedFingerprints.append(fingerprint)
                return true
            })

        try await adapter.apply(profileID: "studio")

        #expect(state.remoteTransport == .direct)
        #expect(state.remoteUrl == url.absoluteString)
        #expect(state.remoteToken == "profile-token")
        #expect(state.connectionMode == .remote)
        #expect(persistedFingerprints == [fingerprint])
    }

    @Test func `token profile without a pin clears the previous primary pin`() async throws {
        let state = AppState(preview: true)
        let url = try #require(URL(string: "wss://studio.example:443/"))
        var persistedFingerprints: [String?] = []
        let adapter = DashboardPrimaryGatewayAdapter(
            state: state,
            endpoint: { _ in
                GatewayConnection.EndpointSnapshot(
                    config: (url: url, token: "profile-token", password: nil),
                    tls: DashboardGatewayTestTLS.route(fingerprint: nil),
                    routeAuthority: nil)
            },
            currentTLSFingerprint: { String(repeating: "b", count: 64) },
            persist: { _, fingerprint in
                persistedFingerprints.append(fingerprint)
                return true
            })

        try await adapter.apply(profileID: "studio")

        #expect(persistedFingerprints.count == 1)
        #expect(persistedFingerprints[0] == nil)
    }

    @Test func `password only profile cannot be promoted`() async throws {
        let state = AppState(preview: true)
        let url = try #require(URL(string: "wss://studio.example:443/"))
        let adapter = DashboardPrimaryGatewayAdapter(
            state: state,
            endpoint: { _ in
                GatewayConnection.EndpointSnapshot(
                    config: (url: url, token: nil, password: "secret"),
                    routeAuthority: nil)
            })
        await #expect(throws: DashboardPrimaryGatewayError.notPromotable) {
            try await adapter.apply(profileID: "studio")
        }
    }

    @Test func `failed promotion restores previous AppState fields`() async throws {
        let state = AppState(preview: true)
        state.remoteTransport = .ssh
        state.remoteUrl = "ws://127.0.0.1:18789"
        state.remoteToken = "previous-token"
        state.connectionMode = .local
        let url = try #require(URL(string: "wss://studio.example:443/"))
        let previousFingerprint = String(repeating: "b", count: 64)
        let profileFingerprint = String(repeating: "a", count: 64)
        var persistedFingerprints: [String?] = []
        let adapter = DashboardPrimaryGatewayAdapter(
            state: state,
            endpoint: { _ in
                GatewayConnection.EndpointSnapshot(
                    config: (url: url, token: "profile-token", password: nil),
                    tls: DashboardGatewayTestTLS.route(fingerprint: profileFingerprint),
                    routeAuthority: nil)
            },
            currentTLSFingerprint: { previousFingerprint },
            persist: { _, fingerprint in
                persistedFingerprints.append(fingerprint)
                return persistedFingerprints.count > 1
            })

        await #expect(throws: DashboardPrimaryGatewayError.notPromotable) {
            try await adapter.apply(profileID: "studio")
        }
        #expect(state.remoteTransport == .ssh)
        #expect(state.remoteUrl == "ws://127.0.0.1:18789")
        #expect(state.remoteToken == "previous-token")
        #expect(state.connectionMode == .local)
        #expect(persistedFingerprints == [profileFingerprint, previousFingerprint])
    }

    @Test func `deep link applies direct endpoint and clears omitted token and pin`() throws {
        let state = AppState(preview: true)
        state.remoteTransport = .ssh
        state.remoteUrl = "ws://127.0.0.1:18789"
        state.remoteToken = "stale-token"
        state.connectionMode = .local
        var persistedFingerprints: [String?] = []
        let adapter = DashboardPrimaryGatewayAdapter(
            state: state,
            currentTLSFingerprint: { String(repeating: "b", count: 64) },
            persist: { _, fingerprint in
                persistedFingerprints.append(fingerprint)
                return true
            })
        let link = GatewayConnectDeepLink(
            host: "gateway.example",
            port: 8443,
            tls: true,
            bootstrapToken: nil,
            token: nil,
            password: nil)

        try adapter.apply(link: link)

        #expect(state.remoteTransport == .direct)
        #expect(state.remoteUrl == "wss://gateway.example:8443")
        #expect(state.remoteToken.isEmpty)
        #expect(state.connectionMode == .remote)
        #expect(persistedFingerprints == [nil])
    }

    @Test func `deep link password is rejected without mutation`() throws {
        let state = AppState(preview: true)
        state.remoteTransport = .ssh
        state.remoteUrl = "wss://previous.example:443"
        state.remoteToken = "previous-token"
        state.connectionMode = .local
        let adapter = DashboardPrimaryGatewayAdapter(state: state)
        let link = GatewayConnectDeepLink(
            host: "gateway.example",
            port: 443,
            tls: true,
            bootstrapToken: nil,
            token: "fixture-token",
            password: "fixture-password")

        #expect(throws: DashboardPrimaryGatewayError.passwordUnsupported) {
            try adapter.apply(link: link)
        }
        #expect(state.remoteUrl == "wss://previous.example:443")
        #expect(state.remoteToken == "previous-token")
    }
}

@MainActor
struct DashboardGatewaySetupCoordinatorTests {
    @Test func `cancel prompts once and preserves primary state without credential disclosure`() {
        let state = AppState(preview: true)
        state.remoteTransport = .ssh
        state.remoteUrl = "wss://previous.example:443"
        state.remoteToken = "previous-token"
        state.connectionMode = .local
        let token = "fixture-token"
        let link = GatewayConnectDeepLink(
            host: "192.168.1.20",
            port: 18789,
            tls: false,
            bootstrapToken: nil,
            token: token,
            password: nil)
        var prompts: [(String, String)] = []
        var openedSettings = 0
        var persistCount = 0
        let coordinator = DashboardGatewaySetupCoordinator(
            adapter: DashboardPrimaryGatewayAdapter(
                state: state,
                currentTLSFingerprint: { String(repeating: "a", count: 64) },
                persist: { _, _ in
                    persistCount += 1
                    return true
                }),
            confirm: { title, message in
                prompts.append((title, message))
                return false
            },
            presentError: { _, _ in Issue.record("unexpected error") },
            openConnectionSettings: { openedSettings += 1 })

        coordinator.handle(link)

        #expect(prompts.count == 1)
        #expect(!prompts[0].0.contains(token))
        #expect(!prompts[0].1.contains(token))
        #expect(prompts[0].1.contains("unencrypted private-network connection"))
        #expect(!prompts[0].1.localizedCaseInsensitiveContains("loopback"))
        #expect(state.remoteTransport == .ssh)
        #expect(state.remoteUrl == "wss://previous.example:443")
        #expect(state.remoteToken == "previous-token")
        #expect(state.connectionMode == .local)
        #expect(persistCount == 0)
        #expect(openedSettings == 0)
    }

    @Test func `accept applies primary and opens connection settings`() {
        let state = AppState(preview: true)
        var persistedFingerprints: [String?] = []
        var openedSettings = 0
        let adapter = DashboardPrimaryGatewayAdapter(
            state: state,
            persist: { _, fingerprint in
                persistedFingerprints.append(fingerprint)
                return true
            })
        let coordinator = DashboardGatewaySetupCoordinator(
            adapter: adapter,
            confirm: { _, _ in true },
            presentError: { _, _ in Issue.record("unexpected error") },
            openConnectionSettings: { openedSettings += 1 })
        let link = GatewayConnectDeepLink(
            host: "gateway.example",
            port: 443,
            tls: true,
            bootstrapToken: nil,
            token: "fixture-token",
            password: nil)

        coordinator.handle(link)

        #expect(state.remoteUrl == "wss://gateway.example:443")
        #expect(state.remoteToken == "fixture-token")
        #expect(persistedFingerprints == [nil])
        #expect(openedSettings == 1)
    }

    @Test func `password route visibly rejects before prompting or mutation`() {
        let state = AppState(preview: true)
        state.remoteUrl = "wss://previous.example:443"
        var promptCount = 0
        var errors: [(String, String)] = []
        let coordinator = DashboardGatewaySetupCoordinator(
            adapter: DashboardPrimaryGatewayAdapter(state: state),
            confirm: { _, _ in
                promptCount += 1
                return true
            },
            presentError: { errors.append(($0, $1)) },
            openConnectionSettings: { Issue.record("unexpected settings open") })
        let password = "fixture-password"
        let link = GatewayConnectDeepLink(
            host: "gateway.example",
            port: 443,
            tls: true,
            bootstrapToken: nil,
            token: nil,
            password: password)

        coordinator.handle(link)

        #expect(promptCount == 0)
        #expect(errors.count == 1)
        #expect(!errors[0].0.contains(password))
        #expect(!errors[0].1.contains(password))
        #expect(state.remoteUrl == "wss://previous.example:443")
    }
}

private enum DashboardGatewayTestTLS {
    static func route(fingerprint: String?) -> GatewayTLSRoute {
        GatewayTLSRoute(
            params: GatewayTLSParams(
                required: true,
                expectedFingerprint: fingerprint,
                allowTOFU: fingerprint == nil,
                storeKey: nil),
            allowsTrustedPinReplacement: true)
    }
}
