import OpenClawKit
import Testing
@testable import OpenClaw

@MainActor
struct QRScannerResultHandoffTests {
    @Test func `queued result is delivered once after dismissal`() async throws {
        let handoff = QRScannerResultHandoff(settlingNanoseconds: 0)
        var deliveredResult: QRScannerResult?

        let scanID = handoff.beginScan()
        handoff.queue(.setupCode("review-demo"), scanID: scanID)
        let task = try #require(handoff.processAfterDismissal { deliveredResult = $0 })
        await task.value

        #expect(deliveredResult == .setupCode("review-demo"))
        #expect(handoff.processAfterDismissal { _ in } == nil)
    }

    @Test func `cancel prevents queued delivery`() async throws {
        let handoff = QRScannerResultHandoff(settlingNanoseconds: 1_000_000_000)
        var deliveredResult: QRScannerResult?

        let scanID = handoff.beginScan()
        handoff.queue(.setupCode("review-demo"), scanID: scanID)
        let task = try #require(handoff.processAfterDismissal { deliveredResult = $0 })
        handoff.cancel()
        await task.value

        #expect(deliveredResult == nil)
    }

    @Test func `beginning another scan clears stale result`() {
        let handoff = QRScannerResultHandoff(settlingNanoseconds: 0)

        let staleScanID = handoff.beginScan()
        handoff.queue(.setupCode("stale"), scanID: staleScanID)
        handoff.beginScan()

        #expect(handoff.processAfterDismissal { _ in } == nil)
    }

    @Test func `late result from cancelled scan cannot replace newer input`() async throws {
        let handoff = QRScannerResultHandoff(settlingNanoseconds: 0)
        let staleScanID = handoff.beginScan()
        handoff.cancel()
        let currentScanID = handoff.beginScan()
        var deliveredResult: QRScannerResult?

        #expect(!handoff.queue(.setupCode("stale"), scanID: staleScanID))
        #expect(handoff.queue(.setupCode("current"), scanID: currentScanID))
        let task = try #require(handoff.processAfterDismissal { deliveredResult = $0 })
        await task.value

        #expect(deliveredResult == .setupCode("current"))
    }

    @Test func `first producer claims the active scan`() async throws {
        let handoff = QRScannerResultHandoff(settlingNanoseconds: 0)
        let scanID = handoff.beginScan()
        var deliveredResult: QRScannerResult?

        #expect(handoff.queue(.setupCode("camera"), scanID: scanID))
        #expect(!handoff.isActive(scanID: scanID))
        #expect(!handoff.queue(.setupCode("photo"), scanID: scanID))
        let task = try #require(handoff.processAfterDismissal { deliveredResult = $0 })
        await task.value

        #expect(deliveredResult == .setupCode("camera"))
    }
}

struct GatewaySetupLinkStagingTests {
    private static func link() -> GatewayConnectDeepLink {
        GatewayConnectDeepLink(
            host: "gateway.example.com",
            port: 443,
            tls: true,
            bootstrapToken: "bootstrap",
            token: "token",
            password: "password")
    }

    @Test func `staged link is consumed once`() {
        var staging = GatewaySetupLinkStaging()
        let link = Self.link()

        staging.stage(link)

        #expect(staging.take() == link)
        #expect(staging.take() == nil)
    }

    @Test func `cancel discards staged credentials`() {
        var staging = GatewaySetupLinkStaging()
        staging.stage(Self.link())

        let cancelled = staging.cancel()

        #expect(cancelled)
        #expect(staging.link == nil)
        let cancelledAgain = staging.cancel()
        #expect(!cancelledAgain)
    }

    @Test func `new setup link replaces the pending candidate`() {
        var staging = GatewaySetupLinkStaging()
        let replacement = GatewayConnectDeepLink(
            host: "replacement.example.com",
            port: 8443,
            tls: true,
            bootstrapToken: nil,
            token: nil,
            password: nil)
        staging.stage(Self.link())
        staging.stage(replacement)

        #expect(staging.take() == replacement)
    }
}

@MainActor
struct GatewayPendingTargetSuppressionTests {
    @Test func `new setup target cannot be released by stale scanner dismissal`() {
        let appModel = NodeAppModel()
        let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
        var pending = GatewayPendingTargetSuppression()
        let scannerLease = controller.cancelPendingConnectionAttempts()
        pending.replace(owner: .qrScanner, lease: scannerLease)
        let setupLease = controller.cancelPendingConnectionAttempts()
        pending.replace(owner: .setupLink, lease: setupLease)

        #expect(pending.take(ifOwnedBy: .qrScanner) == nil)
        let activeLease = pending.take(ifOwnedBy: .setupLink)
        #expect(activeLease != nil)
        if let activeLease {
            controller.releaseAutoConnectSuppression(after: activeLease)
        }
        #expect(!controller._test_isAutoConnectSuppressed())
    }
}
