import Testing
@testable import OpenClaw

@MainActor
struct DeviceSettingsRequestQueueTests {
    @Test func `requests wait for the active confirmation before running in order`() async {
        let queue = DeviceSettingsRequestQueue()
        let events = AsyncStream<Void>.makeStream()
        var iterator = events.stream.makeAsyncIterator()
        var release: CheckedContinuation<Void, Never>?
        var order: [Int] = []
        queue.enqueue {
            order.append(1)
            await withCheckedContinuation { continuation in
                release = continuation
                events.continuation.yield(())
            }
            order.append(2)
        }
        await iterator.next()
        queue.enqueue {
            order.append(3)
            events.continuation.yield(())
        }
        #expect(order == [1])
        release?.resume()
        await iterator.next()
        #expect(order == [1, 2, 3])
        queue.cancel()
        events.continuation.finish()
    }

    @Test func `closing cancels the active request and drops queued work before reopening`() async {
        let queue = DeviceSettingsRequestQueue()
        let started = AsyncStream<Void>.makeStream()
        let completed = AsyncStream<Void>.makeStream()
        var starts = started.stream.makeAsyncIterator()
        var completions = completed.stream.makeAsyncIterator()
        var releaseActive: CheckedContinuation<Void, Never>?
        var activeWasCancelled = false
        var queuedRequestRan = false
        queue.enqueue {
            await withCheckedContinuation { continuation in
                releaseActive = continuation
                started.continuation.yield(())
            }
            activeWasCancelled = Task.isCancelled
            completed.continuation.yield(())
        }
        await starts.next()
        queue.enqueue { queuedRequestRan = true }

        queue.cancel()
        releaseActive?.resume()
        await completions.next()
        #expect(activeWasCancelled)

        queue.enqueue { completed.continuation.yield(()) }
        await completions.next()
        #expect(!queuedRequestRan)
        queue.cancel()
        started.continuation.finish()
        completed.continuation.finish()
    }
}
