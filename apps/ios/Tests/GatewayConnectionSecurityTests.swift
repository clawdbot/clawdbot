import Foundation
import Network
import OpenClawKit
import os
import Testing
@testable import OpenClaw

@Suite(.serialized) struct GatewayConnectionSecurityTests {
    @MainActor
    private func makeController() -> GatewayConnectionController {
        GatewayConnectionController(appModel: NodeAppModel(), startDiscovery: false)
    }

    private func makeDiscoveredGateway(
        stableID: String,
        lanHost: String?,
        tailnetDns: String?,
        gatewayPort: Int?,
        fingerprint: String?,
        tlsEnabled: Bool = true) -> GatewayDiscoveryModel.DiscoveredGateway
    {
        let endpoint: NWEndpoint = .service(name: "Test", type: "_openclaw-gw._tcp", domain: "local.", interface: nil)
        return GatewayDiscoveryModel.DiscoveredGateway(
            name: "Test",
            endpoint: endpoint,
            stableID: stableID,
            debugID: "debug",
            lanHost: lanHost,
            tailnetDns: tailnetDns,
            gatewayPort: gatewayPort,
            canvasPort: nil,
            tlsEnabled: tlsEnabled,
            tlsFingerprintSha256: fingerprint,
            cliPath: nil)
    }

    private func clearTLSFingerprint(stableID: String) {
        GatewayTLSStore.clearFingerprint(stableID: stableID)
    }

    @Test @MainActor func `discovered TLS params prefers stored pin over advertised TXT`() {
        let stableID = "test|\(UUID().uuidString)"
        defer { clearTLSFingerprint(stableID: stableID) }
        self.clearTLSFingerprint(stableID: stableID)

        GatewayTLSStore.saveFingerprint("11", stableID: stableID)

        let gateway = self.makeDiscoveredGateway(
            stableID: stableID,
            lanHost: "evil.example.com",
            tailnetDns: "evil.example.com",
            gatewayPort: 12345,
            fingerprint: "22")
        let controller = self.makeController()

        let params = controller._test_resolveDiscoveredTLSParams(gateway: gateway)
        #expect(params?.expectedFingerprint == "11")
        #expect(params?.allowTOFU == false)
    }

    @Test @MainActor func `discovered TLS params does not trust advertised fingerprint`() {
        let stableID = "test|\(UUID().uuidString)"
        defer { clearTLSFingerprint(stableID: stableID) }
        self.clearTLSFingerprint(stableID: stableID)

        let gateway = self.makeDiscoveredGateway(
            stableID: stableID,
            lanHost: nil,
            tailnetDns: nil,
            gatewayPort: nil,
            fingerprint: "22")
        let controller = self.makeController()

        let params = controller._test_resolveDiscoveredTLSParams(gateway: gateway)
        #expect(params?.expectedFingerprint == nil)
        #expect(params?.allowTOFU == false)
    }

    @Test @MainActor func `discovered gateway availability requires advertised TLS or a stored pin`() {
        let unpinnedID = "test|\(UUID().uuidString)"
        let pinnedID = "test|\(UUID().uuidString)"
        defer {
            clearTLSFingerprint(stableID: unpinnedID)
            clearTLSFingerprint(stableID: pinnedID)
        }
        self.clearTLSFingerprint(stableID: unpinnedID)
        self.clearTLSFingerprint(stableID: pinnedID)

        let controller = self.makeController()
        let unavailable = self.makeDiscoveredGateway(
            stableID: unpinnedID,
            lanHost: "gateway.local",
            tailnetDns: nil,
            gatewayPort: 18789,
            fingerprint: "untrusted-txt-fingerprint",
            tlsEnabled: false)
        let advertisedTLS = self.makeDiscoveredGateway(
            stableID: unpinnedID,
            lanHost: "gateway.local",
            tailnetDns: nil,
            gatewayPort: 18789,
            fingerprint: nil)
        let pinned = self.makeDiscoveredGateway(
            stableID: pinnedID,
            lanHost: "gateway.local",
            tailnetDns: nil,
            gatewayPort: 18789,
            fingerprint: nil,
            tlsEnabled: false)

        #expect(controller.discoveredGatewayConnectionAvailability(unavailable) == .secureTransportRequired)
        #expect(controller.discoveredGatewayConnectionAvailability(unavailable).canConnect == false)
        #expect(controller.discoveredGatewayConnectionAvailability(unavailable).guidanceText?
            .contains("trusted private-LAN") == true)
        #expect(controller.discoveredGatewayConnectionAvailability(advertisedTLS) == .available)

        GatewayTLSStore.saveFingerprint("stored-pin", stableID: pinnedID)
        #expect(controller.discoveredGatewayConnectionAvailability(pinned) == .available)
    }

    @Test @MainActor func `blocked discovered gateway does no connection work`() async {
        let stableID = "test|\(UUID().uuidString)"
        defer { clearTLSFingerprint(stableID: stableID) }
        self.clearTLSFingerprint(stableID: stableID)
        let tcpCalls = OSAllocatedUnfairLock(initialState: 0)
        let tlsCalls = OSAllocatedUnfairLock(initialState: 0)
        let resolverCalls = OSAllocatedUnfairLock(initialState: 0)
        let appModel = NodeAppModel()
        let controller = GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in
                tcpCalls.withLock { $0 += 1 }
                return true
            },
            tlsFingerprintProbe: { _ in
                tlsCalls.withLock { $0 += 1 }
                return .fingerprint("unexpected")
            },
            serviceEndpointResolver: { _ in
                resolverCalls.withLock { $0 += 1 }
                return (host: "unexpected.example", port: 443)
            })
        let gateway = self.makeDiscoveredGateway(
            stableID: stableID,
            lanHost: "untrusted-txt.example",
            tailnetDns: nil,
            gatewayPort: 18789,
            fingerprint: "untrusted-txt-fingerprint",
            tlsEnabled: false)

        let message = await controller.connectWithDiagnostics(gateway)

        #expect(message?.contains("Manual Setup") == true)
        #expect(resolverCalls.withLock { $0 } == 0)
        #expect(tcpCalls.withLock { $0 } == 0)
        #expect(tlsCalls.withLock { $0 } == 0)
        #expect(controller.pendingTrustPrompt == nil)
        #expect(appModel.activeGatewayConnectConfig == nil)
    }

    @Test @MainActor func `quick setup prefers an eligible discovered gateway`() {
        let blockedID = "test|\(UUID().uuidString)"
        let eligibleID = "test|\(UUID().uuidString)"
        defer {
            clearTLSFingerprint(stableID: blockedID)
            clearTLSFingerprint(stableID: eligibleID)
        }
        self.clearTLSFingerprint(stableID: blockedID)
        self.clearTLSFingerprint(stableID: eligibleID)
        let controller = self.makeController()
        let blocked = self.makeDiscoveredGateway(
            stableID: blockedID,
            lanHost: nil,
            tailnetDns: nil,
            gatewayPort: nil,
            fingerprint: nil,
            tlsEnabled: false)
        let eligible = self.makeDiscoveredGateway(
            stableID: eligibleID,
            lanHost: nil,
            tailnetDns: nil,
            gatewayPort: nil,
            fingerprint: nil)
        controller._test_setGateways([blocked, eligible])

        #expect(controller.preferredDiscoveredGateway()?.stableID == eligibleID)
    }

    @Test @MainActor func `autoconnect requires stored pin for discovered gateways`() {
        let stableID = "test|\(UUID().uuidString)"
        defer { clearTLSFingerprint(stableID: stableID) }
        self.clearTLSFingerprint(stableID: stableID)

        let defaults = UserDefaults.standard
        defaults.set(true, forKey: "gateway.autoconnect")
        defaults.set(false, forKey: "gateway.manual.enabled")
        defaults.removeObject(forKey: "gateway.last.host")
        defaults.removeObject(forKey: "gateway.last.port")
        defaults.removeObject(forKey: "gateway.last.tls")
        defaults.removeObject(forKey: "gateway.last.stableID")
        defaults.removeObject(forKey: "gateway.last.kind")
        defaults.removeObject(forKey: "gateway.preferredStableID")
        defaults.set(stableID, forKey: "gateway.lastDiscoveredStableID")

        let gateway = self.makeDiscoveredGateway(
            stableID: stableID,
            lanHost: "test.local",
            tailnetDns: nil,
            gatewayPort: 18789,
            fingerprint: nil)
        let controller = self.makeController()
        controller._test_setGateways([gateway])
        controller._test_triggerAutoConnect()

        #expect(controller._test_didAutoConnect() == false)
    }

    @Test @MainActor func `manual connections force TLS for non loopback hosts`() {
        let controller = self.makeController()

        #expect(controller._test_resolveManualUseTLS(host: "gateway.example.com", useTLS: false) == true)
        #expect(controller._test_resolveManualUseTLS(host: "127.attacker.example", useTLS: false) == true)
        #expect(controller._test_resolveManualUseTLS(host: "gateway.ts.net", useTLS: false) == true)
        #expect(controller._test_resolveManualUseTLS(host: "100.64.0.9", useTLS: false) == true)

        #expect(controller._test_resolveManualUseTLS(host: "localhost", useTLS: false) == false)
        #expect(controller._test_resolveManualUseTLS(host: "127.0.0.1", useTLS: false) == false)
        #expect(controller._test_resolveManualUseTLS(host: "::1", useTLS: false) == false)
        #expect(controller._test_resolveManualUseTLS(host: "[::1]", useTLS: false) == false)
        #expect(controller._test_resolveManualUseTLS(host: "::ffff:127.0.0.1", useTLS: false) == false)
        #expect(controller._test_resolveManualUseTLS(host: "0.0.0.0", useTLS: false) == false)
    }

    @Test @MainActor func `manual transport presentation shows effective remote security`() {
        let presentation = GatewayConnectionController.manualTransportPresentation(
            host: "gateway.example.com",
            requestedTLS: false)

        #expect(presentation.requiresTLS)
        #expect(presentation.effectiveTLS)
        #expect(presentation.helperText == "Secure connection is required for this host.")
    }

    @Test @MainActor func `manual transport presentation allows unencrypted private LAN`() {
        let presentation = GatewayConnectionController.manualTransportPresentation(
            host: "192.168.1.20",
            requestedTLS: false)

        #expect(!presentation.requiresTLS)
        #expect(!presentation.effectiveTLS)
        #expect(presentation.helperText == "Use only on a trusted private network.")
    }

    @Test @MainActor func `manual transport presentation does not repeat selected private LAN TLS state`() {
        let presentation = GatewayConnectionController.manualTransportPresentation(
            host: "192.168.1.20",
            requestedTLS: true)

        #expect(!presentation.requiresTLS)
        #expect(presentation.effectiveTLS)
        #expect(presentation.helperText == nil)
    }

    @Test @MainActor func `manual connections allow private lan plaintext`() {
        let controller = self.makeController()

        #expect(controller._test_resolveManualUseTLS(host: "openclaw.local", useTLS: false) == false)
        #expect(controller._test_resolveManualUseTLS(host: "192.168.1.20", useTLS: false) == false)
        #expect(controller._test_resolveManualUseTLS(host: "10.0.0.5", useTLS: false) == false)
        #expect(controller._test_resolveManualUseTLS(host: "172.16.1.5", useTLS: false) == false)
        #expect(controller._test_resolveManualUseTLS(host: "169.254.1.5", useTLS: false) == false)
        #expect(controller._test_resolveManualUseTLS(host: "fd00::1", useTLS: false) == false)
    }

    @Test @MainActor func `manual default port uses 443 only for tailnet TLS hosts`() {
        let controller = self.makeController()

        #expect(controller._test_resolveManualPort(host: "gateway.example.com", port: 0, useTLS: true) == 18789)
        #expect(controller._test_resolveManualPort(host: "device.sample.ts.net", port: 0, useTLS: true) == 443)
        #expect(controller._test_resolveManualPort(host: "device.sample.ts.net.", port: 0, useTLS: true) == 443)
        #expect(controller._test_resolveManualPort(host: "device.sample.ts.net", port: 18789, useTLS: true) == 18789)
    }

    @Test @MainActor func `setup route selection falls back to reachable tailnet endpoint`() async {
        let probes = OSAllocatedUnfairLock(initialState: [(String, Int)]())
        let controller = GatewayConnectionController(
            appModel: NodeAppModel(),
            startDiscovery: false,
            tcpReachabilityProbe: { host, port, _, _ in
                probes.withLock { $0.append((host, port)) }
                return host.hasSuffix(".ts.net")
            })
        let link = GatewayConnectDeepLink(
            host: "192.168.139.3",
            port: 18789,
            tls: false,
            bootstrapToken: "boot",
            token: nil,
            password: nil,
            fallbackEndpoints: [
                .init(host: "clawmac.tail.ts.net", port: 8443, tls: true),
            ])

        let selected = await controller.selectReachableSetupLink(link)

        #expect(selected.host == "clawmac.tail.ts.net")
        #expect(selected.port == 8443)
        #expect(selected.tls)
        #expect(selected.bootstrapToken == "boot")
        #expect(probes.withLock { $0.map(\.0) } == ["192.168.139.3", "clawmac.tail.ts.net"])
    }

    @Test @MainActor func `setup route selection keeps legacy endpoint when every probe fails`() async {
        let controller = GatewayConnectionController(
            appModel: NodeAppModel(),
            startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in false })
        let link = GatewayConnectDeepLink(
            host: "192.168.139.3",
            port: 18789,
            tls: false,
            bootstrapToken: "boot",
            token: nil,
            password: nil,
            fallbackEndpoints: [
                .init(host: "clawmac.tail.ts.net", port: 8443, tls: true),
            ])

        #expect(await controller.selectReachableSetupLink(link) == link)
    }

    @Test @MainActor func `manual first use TLS probe shows trust prompt after fingerprint capture`() async {
        let host = "gateway-\(UUID().uuidString).example.com"
        let port = 18789
        let stableID = "manual|\(host.lowercased())|\(port)"
        defer { clearTLSFingerprint(stableID: stableID) }
        self.clearTLSFingerprint(stableID: stableID)

        let appModel = NodeAppModel()
        let controller = GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in true },
            tlsFingerprintProbe: { _ in .fingerprint("abc123") })

        await controller.connectManual(host: host, port: port, useTLS: true)

        #expect(controller.pendingTrustPrompt?.fingerprintSha256 == "abc123")
        #expect(controller.pendingTrustPrompt?.host == host)
        #expect(controller.pendingTrustPrompt?.port == port)
        #expect(appModel.gatewayStatusText == "Verify gateway TLS fingerprint")
    }

    @Test @MainActor func `stale trust acceptance releases auto connect suppression`() async {
        let host = "gateway-\(UUID().uuidString).example.com"
        let port = 18789
        let stableID = "manual|\(host.lowercased())|\(port)"
        defer { clearTLSFingerprint(stableID: stableID) }
        self.clearTLSFingerprint(stableID: stableID)

        let appModel = NodeAppModel()
        let controller = GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in true },
            tlsFingerprintProbe: { _ in .fingerprint("abc123") })

        await controller.connectManual(host: host, port: port, useTLS: true)
        _ = appModel.beginGatewayConnectAttempt()
        await controller.acceptPendingTrustPrompt()

        #expect(controller.pendingTrustPrompt == nil)
        #expect(appModel.activeGatewayConnectConfig == nil)
        #expect(!controller._test_isAutoConnectSuppressed())
    }

    @Test @MainActor func `manual first use TLS probe skips TLS when TCP is unreachable`() async {
        let host = "gateway-\(UUID().uuidString).example.com"
        let port = 18789
        let stableID = "manual|\(host.lowercased())|\(port)"
        let tlsProbeCalls = OSAllocatedUnfairLock(initialState: 0)
        defer { clearTLSFingerprint(stableID: stableID) }
        self.clearTLSFingerprint(stableID: stableID)

        let appModel = NodeAppModel()
        let controller = GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in false },
            tlsFingerprintProbe: { _ in
                tlsProbeCalls.withLock { $0 += 1 }
                return .fingerprint("abc123")
            })

        await controller.connectManual(host: host, port: port, useTLS: true)

        #expect(tlsProbeCalls.withLock { $0 } == 0)
        #expect(controller.pendingTrustPrompt == nil)
        #expect(appModel.gatewayStatusText == "Can't reach gateway at \(host):\(port). Check Tailscale or LAN.")
    }

    @Test @MainActor func `unreachable tailscale host explains serve publishing`() async {
        let host = "gateway-\(UUID().uuidString).example.ts.net"
        let port = 443
        let stableID = "manual|\(host.lowercased())|\(port)"
        defer { clearTLSFingerprint(stableID: stableID) }
        self.clearTLSFingerprint(stableID: stableID)
        let appModel = NodeAppModel()
        let controller = GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in false })

        await controller.connectManual(host: host, port: port, useTLS: true)

        #expect(appModel.gatewayStatusText ==
            "Can't reach gateway at \(host):\(port). Verify Tailscale Serve is enabled and publishes this Gateway.")
    }

    @Test @MainActor func `manual first use TLS probe reports handshake timeout without trust prompt`() async {
        let host = "gateway-\(UUID().uuidString).example.com"
        let port = 18789
        let stableID = "manual|\(host.lowercased())|\(port)"
        defer { clearTLSFingerprint(stableID: stableID) }
        self.clearTLSFingerprint(stableID: stableID)

        let appModel = NodeAppModel()
        let staleProblem = GatewayConnectionProblem(
            kind: .pairingRequired,
            owner: .gateway,
            title: "Pairing required",
            message: "Approve an old request.",
            requestId: "stale-request",
            retryable: true,
            pauseReconnect: true)
        appModel._test_applyOperatorGatewayConnectionProblem(staleProblem)
        let controller = GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in true },
            tlsFingerprintProbe: { _ in .failure(.tlsHandshakeTimeout) })

        await controller.connectManual(host: host, port: port, useTLS: true)

        #expect(controller.pendingTrustPrompt == nil)
        #expect(appModel.lastGatewayProblem == nil)
        #expect(appModel.gatewayStatusText.contains("TLS fingerprint verification timed out"))
        #expect(appModel.gatewayStatusText.contains("\(host):\(port)"))
    }

    @Test @MainActor func `discovered first use TLS probe failure clears stale trust prompt`() async {
        let staleHost = "stale-\(UUID().uuidString).example.com"
        let stalePort = 18789
        let staleStableID = "manual|\(staleHost.lowercased())|\(stalePort)"
        let discoveredStableID = "discovered|\(UUID().uuidString)"
        let discoveredHost = "gateway.tailnet.ts.net"
        let discoveredPort = 443
        defer {
            clearTLSFingerprint(stableID: staleStableID)
            clearTLSFingerprint(stableID: discoveredStableID)
        }
        self.clearTLSFingerprint(stableID: staleStableID)
        self.clearTLSFingerprint(stableID: discoveredStableID)

        let tlsResults = OSAllocatedUnfairLock(initialState: [
            GatewayTLSFingerprintProbeResult.fingerprint("abc123"),
            .failure(.tlsHandshakeTimeout),
        ])
        let resolverStarted = AsyncStream<Void>.makeStream()
        let resolverResults = AsyncStream<(host: String, port: Int)>.makeStream()
        let appModel = NodeAppModel()
        let controller = GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            tcpReachabilityProbe: { _, _, _, _ in true },
            tlsFingerprintProbe: { _ in tlsResults.withLock { $0.removeFirst() } },
            serviceEndpointResolver: { _ in
                resolverStarted.continuation.yield()
                for await result in resolverResults.stream {
                    return result
                }
                return nil
            })

        await controller.connectManual(host: staleHost, port: stalePort, useTLS: true)
        #expect(controller.pendingTrustPrompt?.fingerprintSha256 == "abc123")

        let gateway = self.makeDiscoveredGateway(
            stableID: discoveredStableID,
            lanHost: nil,
            tailnetDns: discoveredHost,
            gatewayPort: discoveredPort,
            fingerprint: nil)
        var startedIterator = resolverStarted.stream.makeAsyncIterator()
        let connectTask = Task { await controller.connectWithDiagnostics(gateway) }
        _ = await startedIterator.next()

        #expect(controller.pendingTrustPrompt == nil)
        resolverResults.continuation.yield((host: discoveredHost, port: discoveredPort))
        resolverResults.continuation.finish()
        let message = await connectTask.value

        #expect(message?.contains("TLS fingerprint verification timed out") == true)
        #expect(message?.contains("\(discoveredHost):\(discoveredPort)") == true)
        #expect(appModel.gatewayStatusText == message)
    }

    @Test @MainActor func `target switch cancels suspended discovery resolution`() async {
        let defaults = UserDefaults.standard
        let previousInstanceID = defaults.string(forKey: "node.instanceId")
        defer {
            if let previousInstanceID {
                defaults.set(previousInstanceID, forKey: "node.instanceId")
            } else {
                defaults.removeObject(forKey: "node.instanceId")
            }
        }
        defaults.set("ios-test", forKey: "node.instanceId")
        let resolverStarted = AsyncStream<Void>.makeStream()
        let resolverResults = AsyncStream<(host: String, port: Int)>.makeStream()
        let appModel = NodeAppModel()
        defer { appModel.disconnectGateway() }
        let controller = GatewayConnectionController(
            appModel: appModel,
            startDiscovery: false,
            serviceEndpointResolver: { _ in
                resolverStarted.continuation.yield()
                for await result in resolverResults.stream {
                    return result
                }
                return nil
            })
        let stableID = "discovered|\(UUID().uuidString)"
        defer { self.clearTLSFingerprint(stableID: stableID) }
        let gateway = self.makeDiscoveredGateway(
            stableID: stableID,
            lanHost: nil,
            tailnetDns: nil,
            gatewayPort: nil,
            fingerprint: nil)
        var startedIterator = resolverStarted.stream.makeAsyncIterator()

        let connectTask = Task { await controller.connectWithDiagnostics(gateway) }
        _ = await startedIterator.next()
        controller.cancelPendingConnectionAttempts()
        resolverResults.continuation.yield((host: "stale.gateway.invalid", port: 443))
        resolverResults.continuation.finish()
        let message = await connectTask.value

        #expect(message == nil)
        #expect(appModel.activeGatewayConnectConfig == nil)
        #expect(controller.pendingTrustPrompt == nil)
    }

    @Test @MainActor func `clear all TLS fingerprints removes stored pins`() {
        let stableID1 = "test|\(UUID().uuidString)"
        let stableID2 = "test|\(UUID().uuidString)"
        defer { GatewayTLSStore.clearAllFingerprints() }

        GatewayTLSStore.saveFingerprint("11", stableID: stableID1)
        GatewayTLSStore.saveFingerprint("22", stableID: stableID2)

        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID1) == "11")
        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID2) == "22")

        GatewayTLSStore.clearAllFingerprints()

        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID1) == nil)
        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID2) == nil)
    }

    @Test func `trusted pin mismatch can be recovered by replacing stored pin`() {
        let stableID = "test|\(UUID().uuidString)"
        defer { GatewayTLSStore.clearFingerprint(stableID: stableID) }
        GatewayTLSStore.saveFingerprint("old", stableID: stableID)

        let error = GatewayTLSValidationError(
            failure: GatewayTLSValidationFailure(
                kind: .pinMismatch,
                host: "gateway.tailnet.ts.net",
                storeKey: stableID,
                expectedFingerprint: "old",
                observedFingerprint: "new",
                systemTrustOk: true),
            context: "connect to gateway")

        let problem = GatewayConnectionProblemMapper.map(error: error)

        #expect(problem?.kind == .tlsPinMismatch)
        #expect(problem?.canTrustRotatedCertificate == true)
        #expect(problem?.tlsStoreKey == stableID)
        #expect(problem?.tlsExpectedFingerprint == "old")
        #expect(problem?.tlsObservedFingerprint == "new")

        #expect(GatewayTLSStore.replaceFingerprint(problem?.tlsObservedFingerprint ?? "", stableID: stableID))
        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "new")
    }

    @Test func `untrusted pin mismatch cannot be recovered in app`() {
        let error = GatewayTLSValidationError(
            failure: GatewayTLSValidationFailure(
                kind: .pinMismatch,
                host: "gateway.tailnet.ts.net",
                storeKey: "gateway",
                expectedFingerprint: "old",
                observedFingerprint: "new",
                systemTrustOk: false),
            context: "connect to gateway")

        let problem = GatewayConnectionProblemMapper.map(error: error)

        #expect(problem?.kind == .tlsPinMismatch)
        #expect(problem?.canTrustRotatedCertificate == false)
    }
}
