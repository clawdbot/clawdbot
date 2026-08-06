import AVFoundation
import Foundation
import Testing
@testable import OpenClaw

private final class ScreenRecordServiceProbe: @unchecked Sendable {
    private let lock = NSLock()
    private let sampleBuffer: CMSampleBuffer?
    private var captureHandler: ScreenRecordService.CaptureHandler?
    private var startCompletion: ScreenRecordService.CaptureCompletion?
    private var stopCompletion: ScreenRecordService.CaptureCompletion?
    private var taskFinished = false
    private(set) var startCount = 0
    private(set) var stopCount = 0

    init(sampleBuffer: CMSampleBuffer? = nil) {
        self.sampleBuffer = sampleBuffer
    }

    func recordStart(
        handler: ScreenRecordService.CaptureHandler? = nil,
        completion: ScreenRecordService.CaptureCompletion? = nil)
    {
        self.lock.lock()
        self.startCount += 1
        self.captureHandler = handler
        self.startCompletion = completion
        self.lock.unlock()
    }

    func recordStop(completion: ScreenRecordService.CaptureCompletion? = nil) {
        self.lock.lock()
        self.stopCount += 1
        self.stopCompletion = completion
        self.lock.unlock()
    }

    func completeStart(error: Error? = nil) -> Bool {
        self.lock.lock()
        let completion = self.startCompletion
        self.startCompletion = nil
        self.lock.unlock()
        completion?(error)
        return completion != nil
    }

    func completeStop(error: Error? = nil) -> Bool {
        self.lock.lock()
        let completion = self.stopCompletion
        self.stopCompletion = nil
        self.lock.unlock()
        completion?(error)
        return completion != nil
    }

    func counts() -> (start: Int, stop: Int) {
        self.lock.lock()
        defer { self.lock.unlock() }
        return (self.startCount, self.stopCount)
    }

    func markTaskFinished() {
        self.lock.lock()
        self.taskFinished = true
        self.lock.unlock()
    }

    func hasTaskFinished() -> Bool {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.taskFinished
    }

    func emitVideoSample() {
        self.lock.lock()
        let sampleBuffer = self.sampleBuffer
        let captureHandler = self.captureHandler
        self.lock.unlock()
        if let sampleBuffer, let captureHandler {
            captureHandler(sampleBuffer, .video, nil)
        }
    }
}

private func makeVideoSampleBuffer() throws -> CMSampleBuffer {
    var pixelBuffer: CVPixelBuffer?
    let pixelStatus = CVPixelBufferCreate(
        kCFAllocatorDefault,
        64,
        64,
        kCVPixelFormatType_32BGRA,
        nil,
        &pixelBuffer)
    guard pixelStatus == kCVReturnSuccess, let pixelBuffer else {
        throw ScreenRecordService.ScreenRecordError.captureFailed("Failed to create test pixel buffer")
    }

    var formatDescription: CMVideoFormatDescription?
    let formatStatus = CMVideoFormatDescriptionCreateForImageBuffer(
        allocator: kCFAllocatorDefault,
        imageBuffer: pixelBuffer,
        formatDescriptionOut: &formatDescription)
    guard formatStatus == noErr, let formatDescription else {
        throw ScreenRecordService.ScreenRecordError.captureFailed("Failed to create test format")
    }

    var timing = CMSampleTimingInfo(
        duration: CMTime(value: 1, timescale: 30),
        presentationTimeStamp: .zero,
        decodeTimeStamp: .invalid)
    var sampleBuffer: CMSampleBuffer?
    let sampleStatus = CMSampleBufferCreateReadyWithImageBuffer(
        allocator: kCFAllocatorDefault,
        imageBuffer: pixelBuffer,
        formatDescription: formatDescription,
        sampleTiming: &timing,
        sampleBufferOut: &sampleBuffer)
    guard sampleStatus == noErr, let sampleBuffer else {
        throw ScreenRecordService.ScreenRecordError.captureFailed("Failed to create test sample")
    }
    return sampleBuffer
}

@Suite(.serialized) struct ScreenRecordServiceTests {
    @Test func `clamp defaults and bounds`() {
        #expect(ScreenRecordService._test_clampDurationMs(nil) == 10000)
        #expect(ScreenRecordService._test_clampDurationMs(0) == 250)
        #expect(ScreenRecordService._test_clampDurationMs(60001) == 60000)

        #expect(ScreenRecordService._test_clampFps(nil) == 10)
        #expect(ScreenRecordService._test_clampFps(0) == 1)
        #expect(ScreenRecordService._test_clampFps(120) == 30)
        #expect(ScreenRecordService._test_clampFps(.infinity) == 10)
    }

    @Test @MainActor func `record rejects invalid screen index`() async {
        let recorder = ScreenRecordService()
        do {
            _ = try await recorder.record(
                screenIndex: 1,
                durationMs: 250,
                fps: 5,
                includeAudio: false,
                outPath: nil)
            Issue.record("Expected invalid screen index to throw")
        } catch let error as ScreenRecordService.ScreenRecordError {
            #expect(error.localizedDescription.contains("Invalid screen index") == true)
        } catch {
            Issue.record("Unexpected error type: \(error)")
        }
    }

    @Test func `record stops capture when sleep is cancelled`() async {
        let probe = ScreenRecordServiceProbe()
        let started = AsyncStream<Void>.makeStream()
        let recorder = ScreenRecordService(
            startReplayKitCaptureAction: { _, _, completion in
                probe.recordStart()
                started.continuation.yield()
                started.continuation.finish()
                completion(nil)
            },
            stopReplayKitCaptureAction: { completion in
                probe.recordStop()
                completion(nil)
            })

        let recordingTask = Task {
            try await recorder.record(
                screenIndex: nil,
                durationMs: 60000,
                fps: 5,
                includeAudio: false,
                outPath: nil)
        }
        for await _ in started.stream {
            break
        }
        recordingTask.cancel()

        do {
            _ = try await recordingTask.value
            Issue.record("Expected cancellation to throw")
        } catch is CancellationError {
            // Expected; cleanup should stop ReplayKit before preserving cancellation.
        } catch {
            Issue.record("Unexpected error type: \(error)")
        }

        let counts = probe.counts()
        #expect(counts.start == 1)
        #expect(counts.stop == 1)
    }

    @Test func `cancelled pending start stops after late success`() async {
        let probe = ScreenRecordServiceProbe()
        let started = AsyncStream<Void>.makeStream()
        let stopped = AsyncStream<Void>.makeStream()
        let recorder = ScreenRecordService(
            startReplayKitCaptureAction: { _, _, completion in
                probe.recordStart(completion: completion)
                started.continuation.yield()
                started.continuation.finish()
            },
            stopReplayKitCaptureAction: { completion in
                probe.recordStop(completion: completion)
                stopped.continuation.yield()
                stopped.continuation.finish()
            })

        let recordingTask = Task {
            defer { probe.markTaskFinished() }
            return try await recorder.record(
                screenIndex: nil,
                durationMs: 60000,
                fps: 5,
                includeAudio: true,
                outPath: nil)
        }
        for await _ in started.stream {
            break
        }
        recordingTask.cancel()
        recordingTask.cancel()

        #expect(probe.counts().stop == 0)
        #expect(probe.completeStart())
        for await _ in stopped.stream {
            break
        }
        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(!probe.hasTaskFinished())
        #expect(probe.completeStop())

        do {
            _ = try await recordingTask.value
            Issue.record("Expected cancellation to throw")
        } catch is CancellationError {
            // Startup ownership stays live until ReplayKit's one stop completes.
        } catch {
            Issue.record("Unexpected error type: \(error)")
        }
        let counts = probe.counts()
        #expect(counts.start == 1)
        #expect(counts.stop == 1)
    }

    @Test func `cancelled pending start failure needs no stop`() async {
        let probe = ScreenRecordServiceProbe()
        let started = AsyncStream<Void>.makeStream()
        let recorder = ScreenRecordService(
            startReplayKitCaptureAction: { _, _, completion in
                probe.recordStart(completion: completion)
                started.continuation.yield()
                started.continuation.finish()
            },
            stopReplayKitCaptureAction: { completion in
                probe.recordStop(completion: completion)
                completion(nil)
            })

        let recordingTask = Task {
            try await recorder.record(
                screenIndex: nil,
                durationMs: 60000,
                fps: 5,
                includeAudio: true,
                outPath: nil)
        }
        for await _ in started.stream {
            break
        }
        recordingTask.cancel()
        #expect(probe.completeStart(error: CocoaError(.userCancelled)))

        do {
            _ = try await recordingTask.value
            Issue.record("Expected cancellation to throw")
        } catch is CancellationError {
            // A stop callback cannot release ownership before startup resolves.
        } catch {
            Issue.record("Unexpected error type: \(error)")
        }
        let counts = probe.counts()
        #expect(counts.start == 1)
        #expect(counts.stop == 0)
    }

    @Test func `cancelled capture drains queued samples before deleting output`() async throws {
        let probe = try ScreenRecordServiceProbe(sampleBuffer: makeVideoSampleBuffer())
        let recordQueue = DispatchQueue(label: "ScreenRecordServiceTests.cancelledQueue")
        let started = AsyncStream<Void>.makeStream()
        let stopped = AsyncStream<Void>.makeStream()
        let outputURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("screen-record-cancelled-\(UUID().uuidString).mp4")
        var queueIsSuspended = true
        recordQueue.suspend()
        defer {
            if queueIsSuspended {
                recordQueue.resume()
            }
            try? FileManager.default.removeItem(at: outputURL)
        }
        let recorder = ScreenRecordService(
            recordQueue: recordQueue,
            startReplayKitCaptureAction: { _, handler, completion in
                probe.recordStart(handler: handler)
                completion(nil)
                started.continuation.yield()
                started.continuation.finish()
            },
            stopReplayKitCaptureAction: { completion in
                probe.recordStop()
                completion(nil)
                stopped.continuation.yield()
                stopped.continuation.finish()
            })

        let recordingTask = Task {
            defer { probe.markTaskFinished() }
            return try await recorder.record(
                screenIndex: nil,
                durationMs: 60000,
                fps: 5,
                includeAudio: false,
                outPath: outputURL.path)
        }
        for await _ in started.stream {
            break
        }
        probe.emitVideoSample()
        recordingTask.cancel()
        for await _ in stopped.stream {
            break
        }

        try? await Task.sleep(nanoseconds: 50_000_000)
        #expect(!probe.hasTaskFinished())
        recordQueue.resume()
        queueIsSuspended = false

        do {
            _ = try await recordingTask.value
            Issue.record("Expected cancellation to throw")
        } catch is CancellationError {
            // Cleanup waits behind the queued writer work before returning.
        } catch {
            Issue.record("Unexpected error type: \(error)")
        }
        #expect(!FileManager.default.fileExists(atPath: outputURL.path))
        #expect(probe.counts() == (start: 1, stop: 1))
    }

    @Test func `record drains final sample before finishing writer`() async throws {
        let probe = try ScreenRecordServiceProbe(sampleBuffer: makeVideoSampleBuffer())
        let recordQueue = DispatchQueue(label: "ScreenRecordServiceTests.recordQueue")
        recordQueue.suspend()
        let stopped = AsyncStream<Void>.makeStream()
        let outputURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("screen-record-final-sample-\(UUID().uuidString).mp4")
        defer { try? FileManager.default.removeItem(at: outputURL) }

        let recorder = ScreenRecordService(
            recordQueue: recordQueue,
            startReplayKitCaptureAction: { _, handler, completion in
                probe.recordStart(handler: handler)
                completion(nil)
            },
            stopReplayKitCaptureAction: { completion in
                probe.recordStop()
                probe.emitVideoSample()
                completion(nil)
                stopped.continuation.yield()
                stopped.continuation.finish()
            })

        let recordingTask = Task {
            try await recorder.record(
                screenIndex: nil,
                durationMs: 250,
                fps: 5,
                includeAudio: false,
                outPath: outputURL.path)
        }
        for await _ in stopped.stream {
            break
        }
        recordQueue.resume()

        let path = try await recordingTask.value
        #expect(path == outputURL.path)
        #expect(try (Data(contentsOf: outputURL)).isEmpty == false)
    }
}
