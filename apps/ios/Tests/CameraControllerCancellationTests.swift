import Foundation
import Testing
@testable import OpenClaw

private final class CameraCancellationProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var photoStarts = 0
    private var photoCancels = 0
    private var movieStarts = 0
    private var movieStops = 0
    private var exports = 0
    private var photoStartReturned = false
    private var photoCancelledBeforeStartReturned = false
    private var movieStartReturned = false
    private var movieStoppedBeforeStartReturned = false

    func startPhoto() {
        self.lock.withLock { self.photoStarts += 1 }
    }

    func startMovie() {
        self.lock.withLock { self.movieStarts += 1 }
    }

    func cancelPhoto() {
        self.lock.withLock {
            self.photoCancels += 1
            if !self.photoStartReturned {
                self.photoCancelledBeforeStartReturned = true
            }
        }
    }

    func stopMovie() {
        self.lock.withLock {
            self.movieStops += 1
            if !self.movieStartReturned {
                self.movieStoppedBeforeStartReturned = true
            }
        }
    }

    func finishPhotoStart() {
        self.lock.withLock { self.photoStartReturned = true }
    }

    func finishMovieStart() {
        self.lock.withLock { self.movieStartReturned = true }
    }

    func recordExport() {
        self.lock.withLock { self.exports += 1 }
    }

    func counts() -> (photoStarts: Int, photoCancels: Int, movieStarts: Int, movieStops: Int, exports: Int) {
        self.lock.withLock {
            (self.photoStarts, self.photoCancels, self.movieStarts, self.movieStops, self.exports)
        }
    }

    func stoppedBeforeStartReturned() -> (photo: Bool, movie: Bool) {
        self.lock.withLock {
            (self.photoCancelledBeforeStartReturned, self.movieStoppedBeforeStartReturned)
        }
    }
}

private func expectCancellation(_ operation: () async throws -> Void) async {
    do {
        _ = try await operation()
        Issue.record("Expected cancellation")
    } catch is CancellationError {
        // Expected.
    } catch {
        Issue.record("Unexpected error: \(error)")
    }
}

struct CameraControllerCancellationTests {
    @Test func `pre-cancelled photo never starts`() async {
        let probe = CameraCancellationProbe()
        let capture = CameraPhotoCaptureOperation(startAction: { _ in probe.startPhoto() })
        capture.cancel()

        await expectCancellation { _ = try await capture.run() }

        #expect(probe.counts().photoStarts == 0)
    }

    @Test func `photo cancellation resumes once and ignores late completion`() async {
        let probe = CameraCancellationProbe()
        let started = AsyncStream<Void>.makeStream()
        let cancelled = AsyncStream<Void>.makeStream()
        let capture = CameraPhotoCaptureOperation(
            startAction: { _ in
                probe.startPhoto()
                started.continuation.yield()
                started.continuation.finish()
            },
            cancelAction: {
                probe.cancelPhoto()
                cancelled.continuation.yield()
                cancelled.continuation.finish()
            })
        let task = Task { try await capture.run() }
        for await _ in started.stream {
            break
        }

        task.cancel()
        for await _ in cancelled.stream {
            break
        }
        capture.processingDidFinish(.success(Data([1])))
        capture.captureDidFinish(error: nil)

        await expectCancellation { _ = try await task.value }
        #expect(probe.counts().photoStarts == 1)
        #expect(probe.counts().photoCancels == 1)
    }

    @Test func `photo cancellation during start waits until capture request returns`() async {
        let probe = CameraCancellationProbe()
        let startEntered = AsyncStream<Void>.makeStream()
        let cancelled = AsyncStream<Void>.makeStream()
        let releaseStart = DispatchSemaphore(value: 0)
        let capture = CameraPhotoCaptureOperation(
            startAction: { _ in
                probe.startPhoto()
                startEntered.continuation.yield()
                startEntered.continuation.finish()
                releaseStart.wait()
                probe.finishPhotoStart()
            },
            cancelAction: {
                probe.cancelPhoto()
                cancelled.continuation.yield()
                cancelled.continuation.finish()
            })
        let task = Task { try await capture.run() }
        for await _ in startEntered.stream {
            break
        }

        task.cancel()
        releaseStart.signal()
        for await _ in cancelled.stream {
            break
        }
        capture.captureDidFinish(error: nil)

        await expectCancellation { _ = try await task.value }
        #expect(probe.counts().photoStarts == 1)
        #expect(probe.counts().photoCancels == 1)
        #expect(!probe.stoppedBeforeStartReturned().photo)
    }

    @Test func `photo session teardown runs once and concurrent callers wait for completion`() {
        let probe = CameraCancellationProbe()
        probe.finishPhotoStart()
        let stopEntered = DispatchSemaphore(value: 0)
        let allowStopToFinish = DispatchSemaphore(value: 0)
        let secondCallerReturned = DispatchSemaphore(value: 0)
        let stopper = CameraCaptureSessionStopper {
            probe.cancelPhoto()
            stopEntered.signal()
            allowStopToFinish.wait()
        }

        DispatchQueue.global().async {
            stopper.stop()
        }
        #expect(stopEntered.wait(timeout: .now() + 1) == .success)

        DispatchQueue.global().async {
            stopper.stop()
            secondCallerReturned.signal()
        }
        #expect(secondCallerReturned.wait(timeout: .now() + 0.05) == .timedOut)

        allowStopToFinish.signal()
        #expect(secondCallerReturned.wait(timeout: .now() + 1) == .success)

        #expect(probe.counts().photoCancels == 1)
    }

    @Test func `pre-cancelled movie never starts`() async {
        let probe = CameraCancellationProbe()
        let recording = CameraMovieRecordingOperation(
            startAction: { _ in probe.startMovie() },
            stopAction: { probe.stopMovie() })
        recording.cancel()

        await expectCancellation { _ = try await recording.run() }

        let counts = probe.counts()
        #expect(counts.movieStarts == 0)
        #expect(counts.movieStops == 0)
    }

    @Test func `cancellation before did-start requests one stop`() async {
        let probe = CameraCancellationProbe()
        let started = AsyncStream<Void>.makeStream()
        let recording = CameraMovieRecordingOperation(
            startAction: { _ in
                probe.startMovie()
                started.continuation.yield()
                started.continuation.finish()
            },
            stopAction: { probe.stopMovie() })
        let task = Task { try await recording.run() }
        for await _ in started.stream {
            break
        }

        recording.cancel()
        #expect(probe.counts().movieStops == 1)
        recording.recordingDidStart()
        recording.cancel()
        recording.recordingDidFinish(outputURL: URL(fileURLWithPath: "/tmp/cancelled.mov"), error: nil)

        await expectCancellation { _ = try await task.value }
        #expect(probe.counts().movieStops == 1)
    }

    @Test func `movie cancellation during start waits until recording request returns`() async {
        let probe = CameraCancellationProbe()
        let startEntered = AsyncStream<Void>.makeStream()
        let stopped = AsyncStream<Void>.makeStream()
        let releaseStart = DispatchSemaphore(value: 0)
        let outputURL = URL(fileURLWithPath: "/tmp/cancelled-during-start.mov")
        let recording = CameraMovieRecordingOperation(
            startAction: { _ in
                probe.startMovie()
                startEntered.continuation.yield()
                startEntered.continuation.finish()
                releaseStart.wait()
                probe.finishMovieStart()
            },
            stopAction: {
                probe.stopMovie()
                stopped.continuation.yield()
                stopped.continuation.finish()
            })
        let task = Task { try await recording.run() }
        for await _ in startEntered.stream {
            break
        }

        task.cancel()
        releaseStart.signal()
        for await _ in stopped.stream {
            break
        }
        recording.recordingDidStart()
        recording.recordingDidFinish(outputURL: outputURL, error: nil)

        await expectCancellation { _ = try await task.value }
        #expect(probe.counts().movieStops == 1)
        #expect(!probe.stoppedBeforeStartReturned().movie)
    }

    @Test func `task cancellation stops recording and never exports`() async {
        let probe = CameraCancellationProbe()
        let started = AsyncStream<Void>.makeStream()
        let stopped = AsyncStream<Void>.makeStream()
        let outputURL = URL(fileURLWithPath: "/tmp/cancelled.mov")
        let recording = CameraMovieRecordingOperation(
            startAction: { _ in
                probe.startMovie()
                started.continuation.yield()
                started.continuation.finish()
            },
            stopAction: {
                probe.stopMovie()
                stopped.continuation.yield()
                stopped.continuation.finish()
            })
        let task = Task {
            let recordedURL = try await recording.run()
            try Task.checkCancellation()
            probe.recordExport()
            return recordedURL
        }
        for await _ in started.stream {
            break
        }
        recording.recordingDidStart()

        task.cancel()
        for await _ in stopped.stream {
            break
        }
        recording.recordingDidFinish(outputURL: outputURL, error: nil)

        await expectCancellation { _ = try await task.value }
        let counts = probe.counts()
        #expect(counts.movieStops == 1)
        #expect(counts.exports == 0)
    }

    @Test func `completion before cancellation succeeds without stopping`() async throws {
        let probe = CameraCancellationProbe()
        let started = AsyncStream<Void>.makeStream()
        let outputURL = URL(fileURLWithPath: "/tmp/completed.mov")
        let recording = CameraMovieRecordingOperation(
            startAction: { _ in
                probe.startMovie()
                started.continuation.yield()
                started.continuation.finish()
            },
            stopAction: { probe.stopMovie() })
        let task = Task { try await recording.run() }
        for await _ in started.stream {
            break
        }
        recording.recordingDidStart()

        recording.recordingDidFinish(outputURL: outputURL, error: nil)
        let result = try await task.value
        #expect(result == outputURL)
        recording.cancel()
        recording.recordingDidFinish(outputURL: outputURL, error: nil)

        #expect(probe.counts().movieStops == 0)
    }
}
