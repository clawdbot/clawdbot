import ConcurrencyExtras
import Foundation
import Observation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@Suite(.serialized)
@MainActor
struct CronJobsStoreTests {
    @Test func `count-only refreshes notify observers without changing preview rows`() async throws {
        let fixture = CronSourceFixture()
        fixture.catalogTotal.setValue(9)
        let store = CronJobsStore(gateway: fixture.gateway)
        do {
            await store.refreshJobs()
            try #require(store.summary.total == 9)
            let previewIDs = store.summary.jobs.map(\.id)
            try #require(previewIDs.count == 8)
            let changed = LockIsolated(false)
            withObservationTracking {
                _ = store.summary
            } onChange: {
                changed.setValue(true)
            }

            fixture.catalogTotal.setValue(10)
            await store.refreshJobs()

            #expect(changed.value)
            #expect(store.summary.total == 10)
            #expect(store.summary.jobs.map(\.id) == previewIDs)
        } catch {
            store.stop()
            await fixture.gateway.shutdown()
            throw error
        }
        store.stop()
        await fixture.gateway.shutdown()
    }

    @Test(arguments: [false, true], ["menu", "caller"])
    func `stopping a refresh rejects a late job list completion`(succeeds: Bool, owner: String) async throws {
        let fixture = CronSourceFixture(holding: "cron.list")
        let store = CronJobsStore(gateway: fixture.gateway)
        let refresh = Task { await store.refreshJobs() }
        do {
            try await self.waitUntil { fixture.requests.value.contains { $0.method == "cron.list" } }
            let pending = try #require(fixture.requests.value.first { $0.method == "cron.list" })
            if owner == "menu" {
                store.stop()
            } else {
                refresh.cancel()
            }
            if succeeds {
                CronSourceFixture.respond(pending)
            } else {
                CronSourceFixture.fail(pending, message: "closed menu failure")
            }
            await refresh.value
            #expect(store.summary.jobs.isEmpty)
        } catch {
            store.stop()
            refresh.cancel()
            await fixture.gateway.shutdown()
            await refresh.value
            throw error
        }
        await fixture.gateway.shutdown()
    }

    @Test(arguments: [false, true])
    func `opening the menu loads jobs and closing it stops event refresh`(lateHello: Bool) async throws {
        let fixture = CronSourceFixture()
        let store = CronJobsStore(gateway: fixture.gateway)
        do {
            store.start()
            try await self.waitUntil { store.summary.jobs.count == 1 }
            #expect(store.summary.jobs.first?.name == "Gateway A")
            if lateHello {
                let count = fixture.requests.value.count { $0.method == "cron.list" }
                let snapshot = try #require(await fixture.gateway.lastSnapshot)
                let lease = try #require(await fixture.gateway.captureServerLease())
                await fixture.gateway._test_handlePush(.snapshot(snapshot), socketGeneration: lease.socketGeneration)
                try await Task.sleep(for: .milliseconds(350))
                #expect(fixture.requests.value.count { $0.method == "cron.list" } == count)
            }
            store.stop()
            let count = fixture.requests.value.count
            try self.sendCronEvent(fixture, sequence: 1)
            try await Task.sleep(for: .milliseconds(350))
            #expect(fixture.requests.value.count == count)
        } catch {
            store.stop()
            await fixture.gateway.shutdown()
            throw error
        }
        await fixture.gateway.shutdown()
    }

    @Test(arguments: ["event", "manual"])
    func `replacement refresh waits for its canceled predecessor to drain`(replacement: String) async throws {
        let (lookups, entered) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        let (releases, release) = AsyncStream<Void>.makeStream()
        let cancelled = AsyncTestGate()
        let heldLookup = Task { for await _ in releases {} }
        let holdNextLookup = LockIsolated(false)
        let fixture = CronSourceFixture(beforeEndpointLookup: {
            guard holdNextLookup.withValue({ value in
                defer { value = false }
                return value
            }) else { return }
            await withTaskCancellationHandler {
                entered.yield(())
                await heldLookup.value
            } onCancel: {
                cancelled.open()
            }
        })
        let store = CronJobsStore(gateway: fixture.gateway)
        var manualRefresh: Task<Void, Never>?
        func cleanup() async {
            release.finish()
            entered.finish()
            store.stop()
            manualRefresh?.cancel()
            await heldLookup.value
            await fixture.gateway.shutdown()
            await manualRefresh?.value
        }
        do {
            store.start()
            try await self.waitUntil { store.summary.jobs.count == 1 }
            fixture.catalogTotal.setValue(0)
            holdNextLookup.setValue(true)
            try self.sendCronEvent(fixture, sequence: 1)
            let reachedGate = try await AsyncTimeout.withTimeout(
                seconds: 2,
                onTimeout: { URLError(.timedOut) },
                operation: {
                    for await _ in lookups {
                        return true
                    }
                    return false
                })
            try #require(reachedGate)
            let count = fixture.requests.value.count { $0.method == "cron.list" }
            if replacement == "event" {
                try self.sendCronEvent(fixture, sequence: 2)
            } else {
                manualRefresh = Task { await store.refreshJobs() }
            }
            try await AsyncTimeout.withTimeout(
                seconds: 2,
                onTimeout: { URLError(.timedOut) },
                operation: { await cancelled.wait() })
            try await Task.sleep(for: .milliseconds(350))
            #expect(fixture.requests.value.count { $0.method == "cron.list" } == count)
            release.finish()
            try await self.waitUntil { store.summary.jobs.isEmpty }
            #expect(fixture.requests.value.count { $0.method == "cron.list" } > count)
        } catch {
            await cleanup()
            throw error
        }
        await cleanup()
    }

    private func sendCronEvent(_ fixture: CronSourceFixture, sequence: Int) throws {
        let request = try #require(fixture.requests.value.last)
        let event = #"""
        {"type":"event","event":"cron","seq":\#(sequence),"payload":{"jobId":"shared-job","action":"finished"}}
        """#
        request.socket.emitReceiveSuccess(.string(event))
    }

    private func waitUntil(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(2)
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(2))
        }
        try #require(condition())
    }
}
