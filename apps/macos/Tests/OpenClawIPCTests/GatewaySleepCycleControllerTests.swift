import Testing
@testable import OpenClaw

private struct PrepareFailure: Error {}

@Suite(.serialized)
@MainActor
struct GatewaySleepCycleControllerTests {
    @Test func `ready preparation resumes its suspension once and refreshes`() async {
        var preparedRequestIDs: [String] = []
        var resumedIDs: [String] = []
        var refreshCount = 0
        let route = "ws://127.0.0.1:18789"
        let controller = GatewaySleepCycleController(
            requestID: "macos-sleep-test-run",
            currentRoute: { route },
            prepare: { requestID in
                preparedRequestIDs.append(requestID)
                return .ready(suspensionID: "suspension-1")
            },
            resume: { resumedIDs.append($0) },
            refresh: { refreshCount += 1 },
            log: { _ in })

        await controller.willSleep(mode: .local)
        await controller.didWake(mode: .local)
        await controller.didWake(mode: .local)

        #expect(preparedRequestIDs == ["macos-sleep-test-run"])
        #expect(resumedIDs == ["suspension-1"])
        #expect(refreshCount == 2)
    }

    @Test func `prepare response arriving after wake resumes the late lease immediately`() async {
        var resumedIDs: [String] = []
        var releasePrepare: CheckedContinuation<Void, Never>?
        let controller = GatewaySleepCycleController(
            requestID: "macos-sleep-test-run",
            currentRoute: { "ws://127.0.0.1:18789" },
            prepare: { _ in
                await withCheckedContinuation { releasePrepare = $0 }
                return .ready(suspensionID: "late-suspension")
            },
            resume: { resumedIDs.append($0) },
            refresh: {},
            log: { _ in })

        let sleepTask = Task { await controller.willSleep(mode: .local) }
        // Let willSleep reach the suspended prepare before waking.
        while releasePrepare == nil {
            await Task.yield()
        }
        await controller.didWake(mode: .local)
        releasePrepare?.resume()
        await sleepTask.value
        await controller.didWake(mode: .local)

        #expect(resumedIDs == ["late-suspension"])
    }

    @Test func `resume retries after a transport failure and succeeds`() async {
        var resumeAttempts = 0
        var delays = 0
        let controller = GatewaySleepCycleController(
            requestID: "macos-sleep-test-run",
            currentRoute: { "ws://127.0.0.1:18789" },
            prepare: { _ in .ready(suspensionID: "suspension-retry") },
            resume: { _ in
                resumeAttempts += 1
                if resumeAttempts == 1 { throw PrepareFailure() }
            },
            refresh: {},
            retryDelay: { _ in delays += 1 },
            log: { _ in })

        await controller.willSleep(mode: .local)
        await controller.didWake(mode: .local)

        #expect(resumeAttempts == 2)
        #expect(delays == 1)
    }

    @Test func `resume gives up after exhausting retries`() async {
        var resumeAttempts = 0
        var logs: [String] = []
        let controller = GatewaySleepCycleController(
            requestID: "macos-sleep-test-run",
            currentRoute: { "ws://127.0.0.1:18789" },
            prepare: { _ in .ready(suspensionID: "suspension-exhaust") },
            resume: { _ in
                resumeAttempts += 1
                throw PrepareFailure()
            },
            refresh: {},
            retryDelay: { _ in },
            log: { logs.append($0) })

        await controller.willSleep(mode: .local)
        await controller.didWake(mode: .local)

        #expect(resumeAttempts == 3)
        #expect(logs.contains { $0.contains("giving up") })
    }

    @Test func `a new sleep cycle aborts in-flight resume retries`() async {
        var resumeAttempts = 0
        var beginNextSleep: (() async -> Void)?
        let controller = GatewaySleepCycleController(
            requestID: "macos-sleep-test-run",
            currentRoute: { "ws://127.0.0.1:18789" },
            prepare: { _ in .ready(suspensionID: "suspension-abort") },
            resume: { _ in
                resumeAttempts += 1
                throw PrepareFailure()
            },
            refresh: {},
            retryDelay: { _ in await beginNextSleep?() },
            log: { _ in })

        await controller.willSleep(mode: .local)
        beginNextSleep = { await controller.willSleep(mode: .local) }
        await controller.didWake(mode: .local)

        #expect(resumeAttempts == 1)
    }

    @Test func `busy preparation does not resume but still refreshes`() async {
        var resumeCount = 0
        var refreshCount = 0
        let controller = GatewaySleepCycleController(
            requestID: "macos-sleep-test-run",
            currentRoute: { "ws://127.0.0.1:18789" },
            prepare: { _ in .busy },
            resume: { _ in resumeCount += 1 },
            refresh: { refreshCount += 1 },
            log: { _ in })

        await controller.willSleep(mode: .local)
        await controller.didWake(mode: .local)

        #expect(resumeCount == 0)
        #expect(refreshCount == 1)
    }

    @Test func `failed preparation does not resume but still refreshes`() async {
        var resumeCount = 0
        var refreshCount = 0
        let controller = GatewaySleepCycleController(
            requestID: "macos-sleep-test-run",
            currentRoute: { "ws://127.0.0.1:18789" },
            prepare: { _ in throw PrepareFailure() },
            resume: { _ in resumeCount += 1 },
            refresh: { refreshCount += 1 },
            log: { _ in })

        await controller.willSleep(mode: .local)
        await controller.didWake(mode: .local)

        #expect(resumeCount == 0)
        #expect(refreshCount == 1)
    }

    @Test func `remote mode performs no sleep or wake work`() async {
        var prepareCount = 0
        var resumeCount = 0
        var refreshCount = 0
        let controller = GatewaySleepCycleController(
            requestID: "macos-sleep-test-run",
            currentRoute: { "ws://127.0.0.1:18789" },
            prepare: { _ in
                prepareCount += 1
                return .ready(suspensionID: "unused")
            },
            resume: { _ in resumeCount += 1 },
            refresh: { refreshCount += 1 },
            log: { _ in })

        await controller.willSleep(mode: .remote)
        await controller.didWake(mode: .remote)

        #expect(prepareCount == 0)
        #expect(resumeCount == 0)
        #expect(refreshCount == 0)
    }

    @Test func `changed route drops the suspension and still refreshes`() async {
        var route = "ws://127.0.0.1:18789"
        var resumedIDs: [String] = []
        var refreshCount = 0
        var logs: [String] = []
        let controller = GatewaySleepCycleController(
            requestID: "macos-sleep-test-run",
            currentRoute: { route },
            prepare: { _ in .ready(suspensionID: "suspension-1") },
            resume: { resumedIDs.append($0) },
            refresh: { refreshCount += 1 },
            log: { logs.append($0) })

        await controller.willSleep(mode: .local)
        route = "ws://127.0.0.1:19001"
        await controller.didWake(mode: .local)
        route = "ws://127.0.0.1:18789"
        await controller.didWake(mode: .local)

        #expect(resumedIDs.isEmpty)
        #expect(refreshCount == 2)
        #expect(logs == ["dropping gateway sleep lease: route/mode changed across sleep; lease will self-expire"])
    }

    @Test func `remote wake clears a held local suspension`() async {
        var resumedIDs: [String] = []
        var refreshCount = 0
        var logs: [String] = []
        let controller = GatewaySleepCycleController(
            requestID: "macos-sleep-test-run",
            currentRoute: { "ws://127.0.0.1:18789" },
            prepare: { _ in .ready(suspensionID: "suspension-1") },
            resume: { resumedIDs.append($0) },
            refresh: { refreshCount += 1 },
            log: { logs.append($0) })

        await controller.willSleep(mode: .local)
        await controller.didWake(mode: .remote)
        await controller.didWake(mode: .local)

        #expect(resumedIDs.isEmpty)
        #expect(refreshCount == 1)
        #expect(logs == ["dropping gateway sleep lease: route/mode changed across sleep; lease will self-expire"])
    }
}
