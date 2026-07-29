import Foundation
import Testing
@testable import OpenClawKit

private final class CameraSessionLifecycleProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var starts = 0
    private var stops = 0
    private var operations = 0

    func start() {
        self.lock.withLock { self.starts += 1 }
    }

    func stop() {
        self.lock.withLock { self.stops += 1 }
    }

    func operate() {
        self.lock.withLock { self.operations += 1 }
    }

    func counts() -> (starts: Int, stops: Int, operations: Int) {
        self.lock.withLock { (self.starts, self.stops, self.operations) }
    }
}

struct CameraCapturePipelineSupportTests {
    @Test func `warm-up cancellation stops the started session`() async {
        let probe = CameraSessionLifecycleProbe()

        do {
            let _: Bool = try await CameraCapturePipelineSupport.withCaptureSessionLifecycle(
                start: { probe.start() },
                stop: { probe.stop() },
                warmUp: { throw CancellationError() },
                operation: {
                    probe.operate()
                    return true
                })
            Issue.record("Expected cancellation")
        } catch is CancellationError {
            // Expected.
        } catch {
            Issue.record("Unexpected error: \(error)")
        }

        let counts = probe.counts()
        #expect(counts.starts == 1)
        #expect(counts.stops == 1)
        #expect(counts.operations == 0)
    }

    @Test func `operation cancellation stops the session`() async {
        let probe = CameraSessionLifecycleProbe()

        do {
            _ = try await CameraCapturePipelineSupport.withCaptureSessionLifecycle(
                start: { probe.start() },
                stop: { probe.stop() },
                warmUp: {},
                operation: {
                    probe.operate()
                    throw CancellationError()
                })
            Issue.record("Expected cancellation")
        } catch is CancellationError {
            // Expected.
        } catch {
            Issue.record("Unexpected error: \(error)")
        }

        let counts = probe.counts()
        #expect(counts.starts == 1)
        #expect(counts.stops == 1)
        #expect(counts.operations == 1)
    }

    @Test func `successful operation owns one complete session lifecycle`() async throws {
        let probe = CameraSessionLifecycleProbe()

        let result = try await CameraCapturePipelineSupport.withCaptureSessionLifecycle(
            start: { probe.start() },
            stop: { probe.stop() },
            warmUp: {},
            operation: {
                probe.operate()
                return 42
            })

        #expect(result == 42)
        let counts = probe.counts()
        #expect(counts.starts == 1)
        #expect(counts.stops == 1)
        #expect(counts.operations == 1)
    }
}
