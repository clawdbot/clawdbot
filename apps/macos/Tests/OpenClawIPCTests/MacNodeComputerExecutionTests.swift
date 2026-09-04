import Foundation
import OpenClawKit
import os
import Testing
@testable import OpenClaw

@MainActor
struct MacNodeComputerExecutionTests {
    private typealias Fixture = MacNodeComputerExecutionFixture

    private func expectClose(_ response: Fixture.Response, resourcesClosed: Bool) throws {
        #expect(response.ok)
        let payload = try #require(response.payloadJSON)
        let result = try JSONDecoder().decode(OpenClawComputerActResult.self, from: Data(payload.utf8))
        #expect(result.ok)
        #expect(result.details?["executionClosed"]?.value as? Bool == resourcesClosed)
    }

    @Test(arguments: [false, true])
    func `close without admission reports no resources and retires late first actions`(
        deniedBeforeAdmission: Bool) async throws
    {
        try await Fixture().run { fixture in
            let enabled = OSAllocatedUnfairLock(initialState: !deniedBeforeAdmission)
            let runtime = MacNodeRuntime(
                makeMainActorServices: { [services = fixture.services] queue in
                    await services.setQueue(queue)
                    await services.initialize()
                    return services
                },
                computerControlEnabled: { enabled.withLock { $0 } },
                computerControlProvider: { .peekaboo })
            try await fixture.connect(runtime: runtime)
            if deniedBeforeAdmission {
                try await fixture.sendAction("denied", execution: Fixture.firstExecution, label: "denied")
                let denied = try await fixture.response("denied")
                #expect(!denied.ok)
                #expect(denied.error?.message == "COMPUTER_DISABLED: enable Computer Control in Settings")
            }
            // Gateway also sends this exact close when policy denies before node dispatch.
            try await fixture.sendClose("unowned", execution: Fixture.firstExecution)
            try await self.expectClose(fixture.response("unowned"), resourcesClosed: false)
            #expect(!fixture.services.initializationStarted)
            #expect(fixture.services.releaseAttempts == 0)
            #expect(fixture.services.invalidationCount == 0)
            enabled.withLock { $0 = true }
            try await fixture.sendAction("late", execution: Fixture.firstExecution, label: "late")
            #expect(try await !fixture.response("late").ok)
            try await fixture.sendSnapshot("late-snapshot", execution: Fixture.firstExecution)
            #expect(try await !fixture.response("late-snapshot").ok)
            #expect(!fixture.services.initializationStarted)
            try await fixture.sendAction("successor", execution: Fixture.secondExecution, label: "successor")
            #expect(try await fixture.response("successor").ok)
            try await fixture.sendClose("close-successor", execution: Fixture.secondExecution)
            try await self.expectClose(fixture.response("close-successor"), resourcesClosed: true)
            #expect(fixture.services.heldInput == nil)
        }
    }

    @Test func `managed close releases only its execution`() async throws {
        try await Fixture().run { fixture in
            try await fixture.connect()
            try await fixture.sendAction("first", execution: Fixture.firstExecution, label: "first")
            #expect(try await fixture.response("first").ok)
            #expect(fixture.services.heldInput == "first")

            try await fixture.sendAction("intruder", execution: Fixture.secondExecution, label: "intruder")
            #expect(try await !fixture.response("intruder").ok)
            #expect(fixture.services.heldInput == "first")
            #expect(!fixture.services.events.contains("start:intruder"))

            try await fixture.sendClose("wrong", execution: Fixture.unknownExecution)
            try await self.expectClose(fixture.response("wrong"), resourcesClosed: false)
            #expect(fixture.services.heldInput == "first")
            #expect(fixture.services.releaseAttempts == 0)

            try await fixture.sendClose("close-first", execution: Fixture.firstExecution)
            let firstClose = try await fixture.response("close-first")
            try self.expectClose(firstClose, resourcesClosed: true)
            #expect(fixture.services.heldInput == nil)
            #expect(fixture.responseEvents["close-first"]?.last == "release:first")
            try await fixture.sendClose("already-closed", execution: Fixture.firstExecution)
            try await self.expectClose(fixture.response("already-closed"), resourcesClosed: false)
            #expect(fixture.services.invalidationCount == 1)
            try await fixture.sendAction("late-wrong", execution: Fixture.unknownExecution, label: "late-wrong")
            #expect(try await !fixture.response("late-wrong").ok)

            try await fixture.sendAction("second", execution: Fixture.secondExecution, label: "second")
            #expect(try await fixture.response("second").ok)
            let releasesBeforeStaleClose = fixture.services.releaseAttempts
            try await fixture.sendClose("stale", execution: Fixture.firstExecution)
            try await self.expectClose(fixture.response("stale"), resourcesClosed: false)
            #expect(fixture.services.heldInput == "second")
            #expect(fixture.services.releaseAttempts == releasesBeforeStaleClose)

            try await fixture.sendClose("close-second", execution: Fixture.secondExecution)
            try await self.expectClose(fixture.response("close-second"), resourcesClosed: true)
            #expect(fixture.services.heldInput == nil)
            #expect(fixture.responseEvents["close-second"]?.last == "release:second")
        }
    }

    @Test func `exact close receipt replay acknowledges observed cleanup without redispatch`() async throws {
        try await Fixture().run { fixture in
            try await fixture.connect()
            try await fixture.sendAction("held", execution: Fixture.firstExecution, label: "held")
            #expect(try await fixture.response("held").ok)
            let close = #"""
            {"action":"__close_execution","executionId":"11111111-1111-4111-8111-111111111111",
             "reason":"completed"}
            """#
            let first = try await fixture.invoke(BridgeInvokeRequest(
                id: "close", command: "computer.act", paramsJSON: close, idempotencyKey: "close-receipt"))
            #expect(first.ok)
            try await self.expectClose(fixture.response("close"), resourcesClosed: true)
            let releases = fixture.services.releaseAttempts
            let replay = try await fixture.invoke(BridgeInvokeRequest(
                id: "replay", command: "computer.act", paramsJSON: close, idempotencyKey: "close-receipt"))
            #expect(replay.ok)
            try await self.expectClose(fixture.response("replay"), resourcesClosed: true)
            #expect(!fixture.invocations.contains("replay"))
            #expect(fixture.services.releaseAttempts == releases)
            #expect(fixture.services.invalidationCount == 1)
        }
    }

    @Test func `managed close waits for running operation and drops queued input`() async throws {
        try await Fixture().run { fixture in
            let finish = Fixture.Gate()
            fixture.services.blockedActions["running"] = finish
            try await fixture.connect()
            try await fixture.sendAction("running", execution: Fixture.firstExecution, label: "running")
            try await fixture.waitUntil { fixture.services.heldInput == "running" }
            try await fixture.sendAction("queued", execution: Fixture.firstExecution, label: "queued")
            try await fixture.waitUntil { fixture.services.queue.pendingActionCountForTesting == 1 }

            try await fixture.sendClose("close", execution: Fixture.firstExecution)
            try await fixture.waitUntil {
                fixture.services.releaseAttempts > 0 || fixture.responses["close"] != nil
            }
            #expect(fixture.responses["close"] == nil, "Close must not acknowledge an undrained native operation")
            finish.open()

            let running = try await fixture.response("running")
            let queued = try await fixture.response("queued")
            let close = try await fixture.response("close")
            #expect(!running.ok)
            #expect(!queued.ok)
            try self.expectClose(close, resourcesClosed: true)
            #expect(!fixture.services.events.contains("start:queued"))
            #expect(fixture.services.heldInput == nil)
            #expect(fixture.responseEvents["close"]?.suffix(2) == ["finish:running", "release:running"])
        }
    }

    @Test func `cancelled running and queued requests still accept managed close`() async throws {
        try await Fixture().run { fixture in
            let finish = Fixture.Gate()
            fixture.services.blockedActions["running"] = finish
            try await fixture.connect()
            try await fixture.sendAction("running", execution: Fixture.firstExecution, label: "running")
            try await fixture.waitUntil { fixture.services.heldInput == "running" }
            try await fixture.sendAction("queued", execution: Fixture.firstExecution, label: "queued")
            try await fixture.waitUntil { fixture.services.queue.pendingActionCountForTesting == 1 }

            try await fixture.cancel("queued")
            #expect(try await !fixture.response("queued").ok)
            #expect(fixture.services.heldInput == "running")
            #expect(fixture.services.releaseAttempts == 0)
            try await fixture.cancel("running")
            try await fixture.waitUntil { fixture.services.releaseAttempts > 0 }
            #expect(fixture.responses["running"] == nil)
            finish.open()
            #expect(try await !fixture.response("running").ok)
            #expect(!fixture.services.events.contains("start:queued"))
            #expect(fixture.services.events.suffix(2) == ["finish:running", "release:running"])
            #expect(fixture.services.heldInput == nil)

            // Match the bound Gateway's order: cancel, settle invokes, then close.
            try await fixture.sendClose("close", execution: Fixture.firstExecution)
            let close = try await fixture.response("close")
            try self.expectClose(close, resourcesClosed: true)

            try await fixture.sendAction("successor", execution: Fixture.secondExecution, label: "successor")
            #expect(try await fixture.response("successor").ok)
            #expect(fixture.services.heldInput == "successor")
            await fixture.session.disconnect()
            #expect(fixture.services.heldInput == nil)
        }
    }

    @Test func `cancelled service initialization still accepts managed close`() async throws {
        try await Fixture().run { fixture in
            try await fixture.connect(suspendInitialization: true)
            try await fixture.sendAction("pending", execution: Fixture.firstExecution, label: "pending")
            try await fixture.waitUntil { fixture.services.initializationStarted }
            try await fixture.cancel("pending")
            fixture.services.initialization.open()

            let pending = try await fixture.response("pending")
            try await fixture.sendClose("close", execution: Fixture.firstExecution)
            let close = try await fixture.response("close")
            #expect(!pending.ok)
            try self.expectClose(close, resourcesClosed: true)
            #expect(!fixture.services.events.contains("start:pending"))
            #expect(fixture.services.heldInput == nil)

            try await fixture.sendAction("successor", execution: Fixture.secondExecution, label: "successor")
            #expect(try await fixture.response("successor").ok)
            #expect(fixture.services.heldInput == "successor")
        }
    }

    @Test func `close retires initialization and cannot reopen old queued execution`() async throws {
        try await Fixture().run { fixture in
            try await fixture.connect(suspendInitialization: true)
            try await fixture.sendAction("pending", execution: Fixture.firstExecution, label: "pending")
            try await fixture.waitUntil { fixture.services.initializationStarted }
            try await fixture.sendClose("close", execution: Fixture.firstExecution)
            try await fixture.waitUntil { fixture.invocations.contains("close") }
            try await fixture.sendAction("late", execution: Fixture.firstExecution, label: "late")
            #expect(try await !fixture.response("late").ok)
            #expect(fixture.responses["close"] == nil)
            fixture.services.initialization.open()
            #expect(try await !fixture.response("pending").ok)
            try await self.expectClose(fixture.response("close"), resourcesClosed: true)
            #expect(fixture.services.events.isEmpty)
            #expect(fixture.services.invalidationCount == 1)
            try await fixture.sendAction("reopen", execution: Fixture.firstExecution, label: "reopen")
            #expect(try await !fixture.response("reopen").ok)
            try await fixture.sendAction("successor", execution: Fixture.secondExecution, label: "successor")
            #expect(try await fixture.response("successor").ok)
        }
    }

    @Test func `failed owned release blocks close acknowledgement and successor`() async throws {
        try await Fixture().run { fixture in
            try await fixture.connect()
            try await fixture.sendAction("held", execution: Fixture.firstExecution, label: "held")
            #expect(try await fixture.response("held").ok)
            fixture.services.releaseAllowed = false
            try await fixture.sendClose("close", execution: Fixture.firstExecution)
            try await fixture.waitUntil { fixture.services.releaseAttempts > 0 }
            #expect(fixture.responses["close"] == nil)
            try await fixture.sendAction("blocked", execution: Fixture.secondExecution, label: "blocked")
            #expect(try await !fixture.response("blocked").ok)
            #expect(fixture.services.heldInput == "held")
            fixture.services.releaseAllowed = true
            try await self.expectClose(fixture.response("close"), resourcesClosed: true)
            #expect(fixture.services.heldInput == nil)
            #expect(fixture.responseEvents["close"]?.last == "release:held")
        }
    }

    @Test func `reference cleanup failure preserves cause and fences successors`() async throws {
        struct CleanupFailure: LocalizedError {
            var errorDescription: String? {
                "synthetic snapshot invalidation failed"
            }
        }
        try await Fixture().run { fixture in
            try await fixture.connect()
            try await fixture.sendAction("held", execution: Fixture.firstExecution, label: "held")
            #expect(try await fixture.response("held").ok)
            fixture.services.invalidationError = CleanupFailure()
            try await fixture.sendClose("close", execution: Fixture.firstExecution)
            let close = try await fixture.response("close")
            #expect(!close.ok)
            #expect(close.payloadJSON == nil)
            let message = try #require(close.error?.message)
            #expect(message.contains("synthetic snapshot invalidation failed"))
            #expect(message.count <= "UNAVAILABLE: native computer cleanup failed: ".count + 360)
            #expect(fixture.services.heldInput == nil)
            #expect(fixture.services.invalidationCount == 1)
            try await fixture.sendAction("successor", execution: Fixture.secondExecution, label: "successor")
            #expect(try await !fixture.response("successor").ok)
            try await fixture.sendClose("wrong", execution: Fixture.secondExecution)
            try await self.expectClose(fixture.response("wrong"), resourcesClosed: false)
            try await fixture.sendClose("repeat", execution: Fixture.firstExecution)
            #expect(try await !fixture.response("repeat").ok)
            #expect(fixture.services.invalidationCount == 1)
            #expect(!fixture.services.events.contains("start:successor"))
        }
    }

    @Test func `retired route callbacks cannot close same ID successor`() async throws {
        try await Fixture().run { fixture in
            try await fixture.connect()
            try await fixture.sendAction("old", execution: Fixture.firstExecution, label: "old")
            #expect(try await fixture.response("old").ok)
            let oldRoute = try #require(fixture.routes["old"])
            try await fixture.connect()
            #expect(!oldRoute.isActive)
            try await fixture.sendAction("new", execution: Fixture.firstExecution, label: "new")
            #expect(try await fixture.response("new").ok)
            let newRoute = try #require(fixture.routes["new"])
            #expect(newRoute !== oldRoute)
            let releases = fixture.services.releaseAttempts
            #expect(try await !fixture.staleClose("stale", execution: Fixture.firstExecution, route: oldRoute))
            await fixture.staleRelease(route: oldRoute)
            #expect(fixture.services.heldInput == "new")
            #expect(fixture.services.releaseAttempts == releases)
            try await fixture.sendClose("close-new", execution: Fixture.firstExecution)
            #expect(try await fixture.response("close-new").ok)
            #expect(fixture.services.heldInput == nil)
        }
    }

    @Test func `foreign active route cannot retire IDs or clear native tombstones`() async throws {
        try await Fixture().run { fixture in
            try await fixture.connect()
            try await fixture.sendClose("retire", execution: Fixture.firstExecution)
            try await self.expectClose(fixture.response("retire"), resourcesClosed: false)
            try await Fixture.runWithRoute { foreignRoute async throws in
                #expect(foreignRoute.isActive)
                #expect(try await !fixture.staleClose(
                    "foreign", execution: Fixture.secondExecution, route: foreignRoute))
            }
            try await fixture.sendAction("retired", execution: Fixture.firstExecution, label: "retired")
            #expect(try await !fixture.response("retired").ok)
            try await fixture.sendAction("legitimate", execution: Fixture.secondExecution, label: "legitimate")
            #expect(try await fixture.response("legitimate").ok)
        }
    }

    @Test func `scoped snapshot owns execution but standalone capture does not`() async throws {
        try await Fixture().run { fixture in
            try await fixture.connect()
            try await fixture.sendSnapshot("standalone")
            #expect(try await fixture.response("standalone").ok)
            try await fixture.sendSnapshot("scoped", execution: Fixture.firstExecution)
            #expect(try await fixture.response("scoped").ok)
            try await fixture.sendAction("busy", execution: Fixture.secondExecution, label: "busy")
            #expect(try await !fixture.response("busy").ok)
            try await fixture.sendClose("close", execution: Fixture.firstExecution)
            try await self.expectClose(fixture.response("close"), resourcesClosed: true)
            try await fixture.sendSnapshot("stale", execution: Fixture.firstExecution)
            #expect(try await !fixture.response("stale").ok)
            try await fixture.sendSnapshot("independent")
            #expect(try await fixture.response("independent").ok)
            #expect(fixture.services.snapshotCount == 3)
            try await fixture.sendAction("successor", execution: Fixture.secondExecution, label: "successor")
            #expect(try await fixture.response("successor").ok)
        }
    }

    @Test func `cancelled native input settles only after a failed release recovers`() async throws {
        try await Fixture().run { fixture in
            let finish = Fixture.Gate()
            fixture.services.blockedActions["running"] = finish
            try await fixture.connect()
            try await fixture.sendAction("running", execution: Fixture.firstExecution, label: "running")
            try await fixture.waitUntil { fixture.services.heldInput == "running" }
            fixture.services.releaseAllowed = false
            try await fixture.cancel("running")
            try await fixture.waitUntil { fixture.services.releaseAttempts > 0 }
            finish.open()
            try await fixture.waitUntil {
                fixture.services.releaseAttempts >= 4 || fixture.responses["running"] != nil
            }
            #expect(fixture.responses["running"] == nil)
            let retiredCheck = try #require(fixture.services.checks["running"])
            #expect(throws: CancellationError.self) { try retiredCheck() }
            #expect(fixture.services.heldInput == "running")
            fixture.services.releaseAllowed = true
            #expect(try await !fixture.response("running").ok)
            #expect(fixture.responseEvents["running"]?.last == "release:running")
            try await fixture.sendClose("close", execution: Fixture.firstExecution)
            try await self.expectClose(fixture.response("close"), resourcesClosed: true)
        }
    }

    @Test func `disconnect drains pending initialization before successor admission`() async throws {
        try await Fixture().run { fixture in
            try await fixture.connect(suspendInitialization: true)
            try await fixture.sendAction("pending", execution: Fixture.firstExecution, label: "pending")
            try await fixture.waitUntil { fixture.services.initializationStarted }
            let route = try #require(fixture.routes["pending"])
            let disconnect = Task { await fixture.session.disconnect() }
            try await fixture.waitUntil { !route.isActive }
            fixture.services.initialization.open()
            await disconnect.value
            #expect(fixture.services.events.isEmpty)
            try await fixture.connect()
            try await fixture.sendAction("successor", execution: Fixture.firstExecution, label: "successor")
            #expect(try await fixture.response("successor").ok)
        }
    }

    @Test func `disconnect cannot abandon a close waiting for input release`() async throws {
        try await Fixture().run { fixture in
            try await fixture.connect()
            try await fixture.sendAction("held", execution: Fixture.firstExecution, label: "held")
            #expect(try await fixture.response("held").ok)
            let route = try #require(fixture.routes["held"])
            fixture.services.releaseAllowed = false
            try await fixture.sendClose("close", execution: Fixture.firstExecution)
            try await fixture.waitUntil { fixture.services.releaseAttempts > 0 }
            let disconnect = Task { await fixture.session.disconnect() }
            try await fixture.waitUntil { !route.isActive }
            try await fixture.waitUntil { fixture.services.queue.lifecycleGenerationForTesting > 0 }
            fixture.services.releaseAllowed = true
            await disconnect.value
            #expect(fixture.services.heldInput == nil)
            try await fixture.connect()
            try await fixture.sendAction("successor", execution: Fixture.firstExecution, label: "successor")
            #expect(try await fixture.response("successor").ok)
        }
    }

    @Test func `retained native callback cannot borrow successor authority`() async throws {
        try await Fixture().run { fixture in
            try await fixture.connect()
            try await fixture.sendAction("first", execution: Fixture.firstExecution, label: "first")
            #expect(try await fixture.response("first").ok)
            let staleCheck = try #require(fixture.services.checks["first"])
            try await fixture.sendClose("close", execution: Fixture.firstExecution)
            try await self.expectClose(fixture.response("close"), resourcesClosed: true)
            let finish = Fixture.Gate()
            fixture.services.blockedActions["successor"] = finish
            try await fixture.sendAction("successor", execution: Fixture.secondExecution, label: "successor")
            try await fixture.waitUntil { fixture.services.heldInput == "successor" }
            #expect(throws: ComputerActionService.ComputerActionError.self) { try staleCheck() }
            finish.open()
            #expect(try await fixture.response("successor").ok)
        }
    }
}
