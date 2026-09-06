import Foundation
import Testing
@testable import OpenClaw

private enum GatewayMenuProbeError: Error {
    case unreachable
}

@MainActor
private final class GatewayMenuPendingProbe {
    let started = AsyncTestGate()
    var windowCount = 0
    private var continuation: CheckedContinuation<GatewayMenuStatusStore.Probe, Never>?

    func run() async -> GatewayMenuStatusStore.Probe {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            self.started.open()
        }
    }

    func complete() {
        self.continuation?.resume(returning: ("2026.9.1", "abc1234", 12))
        self.continuation = nil
    }
}

@MainActor
@Suite(.timeLimit(.minutes(1)))
struct GatewayMenuStatusStoreTests {
    @Test func `probes run concurrently and publish each target without waiting for siblings`() async {
        let primaryStarted = AsyncTestGate()
        let profileStarted = AsyncTestGate()
        let primaryRelease = AsyncTestGate()
        let profileRelease = AsyncTestGate()
        let firstChange = AsyncTestGate()
        let allChanges = AsyncTestGate()
        var primaryCalls = 0
        var profileCalls = 0
        var changes = 0
        let store = GatewayMenuStatusStore(
            primaryProbe: {
                primaryCalls += 1
                primaryStarted.open()
                await primaryRelease.wait()
                return ("2026.9.1", "abc1234", 12)
            },
            profileProbe: { profileID in
                #expect(profileID == "saved")
                profileCalls += 1
                profileStarted.open()
                await profileRelease.wait()
                return ("2026.8.31", "def5678", 25)
            },
            disconnectProfile: { _ in })
        let targets: [DashboardGatewayTarget] = [.primary, .profile("saved")]
        store.beginProbing(targets: targets) {
            changes += 1
            if changes == 1 { firstChange.open() }
            if changes == 2 { allChanges.open() }
        }
        store.beginProbing(targets: targets) { Issue.record("Repeated begin replaced the active callback") }
        await primaryStarted.wait()
        await profileStarted.wait()
        #expect(store.isProbing(.primary))
        #expect(store.isProbing(.profile("saved")))

        profileRelease.open()
        await firstChange.wait()
        #expect(store.facts[.primary] == nil)
        #expect(store.facts[.profile("saved")]?.version == "2026.8.31")
        #expect(store.facts[.profile("saved")]?.health == .ok)
        #expect(!store.isProbing(.profile("saved")))
        #expect(store.isProbing(.primary))

        primaryRelease.open()
        await allChanges.wait()
        #expect(store.facts[.primary]?.latencyMs == 12)
        #expect(store.facts[.primary]?.buildId == "abc1234")
        #expect(store.facts[.primary]?.lastSeen != nil)
        #expect(primaryCalls == 1)
        #expect(profileCalls == 1)
        #expect(changes == 2)
        store.endProbing { _ in 1 }
    }

    @Test func `failed refresh preserves the last successful identity and last seen`() async throws {
        var attempts = 0
        let (changes, continuation) = AsyncStream<Void>.makeStream()
        defer { continuation.finish() }
        var iterator = changes.makeAsyncIterator()
        let store = GatewayMenuStatusStore(
            primaryProbe: {
                attempts += 1
                if attempts > 1 { throw GatewayMenuProbeError.unreachable }
                return ("2026.9.1", "abc1234", 12)
            },
            profileProbe: { _ in throw GatewayMenuProbeError.unreachable },
            disconnectProfile: { _ in Issue.record("Primary cleanup disconnected a saved Gateway") })
        store.beginProbing(targets: [.primary]) { continuation.yield(()) }
        _ = await iterator.next()
        let cached = try #require(store.facts[.primary])
        store.endProbing { _ in 0 }

        store.beginProbing(targets: [.primary]) { continuation.yield(()) }
        _ = await iterator.next()
        let failed = try #require(store.facts[.primary])
        #expect(failed.health == .error)
        #expect(failed.version == cached.version)
        #expect(failed.buildId == cached.buildId)
        #expect(failed.lastSeen == cached.lastSeen)
        #expect(try #require(failed.probedAt) >= #require(cached.probedAt))
        #expect(failed.latencyMs == nil)
        #expect(!store.isProbing(.primary))
        store.endProbing { _ in 0 }
    }

    @Test func `closing cancels in flight probes without publishing cancellation as a failure`() async {
        let primaryStarted = AsyncTestGate()
        let profileStarted = AsyncTestGate()
        let release = AsyncTestGate()
        let disconnected = AsyncTestGate()
        var cancellations = 0
        let probe: @MainActor @Sendable (AsyncTestGate) async throws -> GatewayMenuStatusStore.Probe = { started in
            started.open()
            await release.wait()
            if Task.isCancelled { cancellations += 1 }
            try Task.checkCancellation()
            return (nil, nil, 0)
        }
        let store = GatewayMenuStatusStore(
            primaryProbe: { try await probe(primaryStarted) },
            profileProbe: { _ in try await probe(profileStarted) },
            disconnectProfile: { profileID in
                #expect(profileID == "saved")
                disconnected.open()
            })
        store.beginProbing(targets: [.primary, .profile("saved")]) {
            Issue.record("Canceled probes published a menu change")
        }
        await primaryStarted.wait()
        await profileStarted.wait()
        store.endProbing { _ in 0 }
        await disconnected.wait()

        #expect(cancellations == 2)
        #expect(store.facts.isEmpty)
        #expect(!store.isProbing(.primary))
        #expect(!store.isProbing(.profile("saved")))
    }

    @Test func `closing disconnects only probed profiles without dashboard windows including failed probes`() async {
        let allChanges = AsyncTestGate()
        let cleanedUp = AsyncTestGate()
        var changes = 0
        var disconnected: Set<String> = []
        let store = GatewayMenuStatusStore(
            primaryProbe: { (nil, nil, 10) },
            profileProbe: { profileID in
                if profileID == "unreachable" { throw GatewayMenuProbeError.unreachable }
                return (nil, nil, 20)
            },
            disconnectProfile: { profileID in
                disconnected.insert(profileID)
                if disconnected.count == 2 { cleanedUp.open() }
            })
        store.beginProbing(targets: [.primary, .profile("idle"), .profile("open"), .profile("unreachable")]) {
            changes += 1
            if changes == 4 { allChanges.open() }
        }
        await allChanges.wait()
        store.endProbing { $0 == .profile("open") ? 1 : 0 }
        await cleanedUp.wait()

        #expect(disconnected == ["idle", "unreachable"])
        #expect(store.facts[.profile("unreachable")]?.health == .error)
    }

    @Test func `cleanup rechecks windows after a canceled probe finishes and rejects its late result`() async {
        let pending = GatewayMenuPendingProbe()
        let countChecked = AsyncTestGate()
        var disconnected: [String] = []
        let store = GatewayMenuStatusStore(
            primaryProbe: { (nil, nil, 0) },
            profileProbe: { _ in await pending.run() },
            disconnectProfile: { disconnected.append($0) })
        store.beginProbing(targets: [.profile("saved")]) {
            Issue.record("Late probe completion published after the menu closed")
        }
        await pending.started.wait()
        store.endProbing { _ in
            countChecked.open()
            return pending.windowCount
        }
        pending.windowCount = 1
        pending.complete()
        await countChecked.wait()

        #expect(store.facts.isEmpty)
        #expect(disconnected.isEmpty)
    }
}
