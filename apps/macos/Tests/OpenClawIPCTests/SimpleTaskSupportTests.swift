@testable import OpenClaw
import Testing

private actor SimpleTaskSignal {
    private var signaled = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func signal() {
        signaled = true
        let waiters = self.waiters
        self.waiters.removeAll()
        for waiter in waiters {
            waiter.resume()
        }
    }

    func wait() async {
        if signaled {
            return
        }
        await withCheckedContinuation { continuation in
            self.waiters.append(continuation)
        }
    }
}

private actor SimpleTaskOperationProbe {
    private var callCount = 0

    func recordCall() {
        callCount += 1
    }

    func calls() -> Int {
        callCount
    }
}

struct SimpleTaskSupportTests {
    @Test
    @MainActor
    func `cancelling during sleep does not run another operation`() async {
        let sleepStarted = SimpleTaskSignal()
        let operation = SimpleTaskOperationProbe()
        var task: Task<Void, Never>?

        SimpleTaskSupport.startDetachedLoop(
            task: &task,
            interval: 60,
            sleep: { nanoseconds in
                await sleepStarted.signal()
                try await Task.sleep(nanoseconds: nanoseconds)
            },
            operation: {
                await operation.recordCall()
            }
        )

        await sleepStarted.wait()
        guard let runningTask = task else {
            Issue.record("detached loop did not start")
            return
        }

        SimpleTaskSupport.stop(task: &task)
        await runningTask.value

        #expect(await operation.calls() == 1)
        #expect(task == nil)
    }
}
