@preconcurrency import AVFoundation
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct MacRealtimeTalkAudioCaptureTests {
    @Test func `encoder downmixes resamples and emits little endian pcm16`() throws {
        let buffer = try self.makeFloatBuffer(
            sampleRate: 48000,
            channels: [
                [0, 1, -1, 0.5],
                [0, 1, -1, -0.5],
            ])

        let frame = try #require(MacRealtimeTalkAudioFrameEncoder.encode(
            buffer: buffer,
            targetSampleRate: 24000,
            timestampMs: 1234))

        #expect(frame.timestampMs == 1234)
        #expect(frame.data.count == 4)
        #expect(self.samples(in: frame.data) == [0, -32767])
        #expect(abs(frame.rms - Float(1.0 / 2.0.squareRoot())) < 0.0001)
    }

    @Test func `encoder interpolates and clamps samples`() throws {
        let buffer = try self.makeFloatBuffer(
            sampleRate: 24000,
            channels: [[2, 0, -2]])

        let frame = try #require(MacRealtimeTalkAudioFrameEncoder.encode(
            buffer: buffer,
            targetSampleRate: 48000,
            timestampMs: 0))

        #expect(self.samples(in: frame.data) == [32767, 32767, 0, -32767, -32767, -32767])
    }

    @Test func `encoder rejects empty and invalid target buffers`() throws {
        let format = try #require(AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 48000,
            channels: 1,
            interleaved: false))
        let empty = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1))

        #expect(MacRealtimeTalkAudioFrameEncoder.encode(
            buffer: empty,
            targetSampleRate: 24000,
            timestampMs: 0) == nil)
        #expect(MacRealtimeTalkAudioFrameEncoder.encode(
            buffer: empty,
            targetSampleRate: 0,
            timestampMs: 0) == nil)
    }

    @Test func `delivery gate invalidates prior capture generations`() {
        let gate = MacRealtimeTalkCaptureDeliveryGate()
        let first = gate.activate()
        var deliveries = 0

        gate.deliver(ifActive: first) { deliveries += 1 }
        gate.deactivate()
        gate.deliver(ifActive: first) { deliveries += 1 }
        let second = gate.activate()
        gate.deliver(ifActive: first) { deliveries += 1 }
        gate.deliver(ifActive: second) { deliveries += 1 }

        #expect(deliveries == 2)
        #expect(!gate.isActive(first))
        #expect(gate.isActive(second))
    }

    @Test func `tap handler can run on a realtime audio queue`() throws {
        let buffer = try self.makeFloatBuffer(
            sampleRate: 48000,
            channels: [[0, 0.5, -0.5, 0]])
        let gate = MacRealtimeTalkCaptureDeliveryGate()
        let token = gate.activate()
        let sink = RealtimeTalkFrameSink()
        let handler = SendableAudioTapHandler(MacRealtimeTalkTapHandlerFactory.make(
            targetSampleRate: 24000,
            deliveryGate: gate,
            deliveryToken: token,
            onAudio: { sink.append($0) }))
        let finished = DispatchSemaphore(value: 0)

        DispatchQueue(label: "talk.realtime.tap-test").async {
            handler.value(buffer, AVAudioTime(sampleTime: 0, atRate: 48000))
            finished.signal()
        }

        #expect(finished.wait(timeout: .now() + 2) == .success)
        #expect(sink.count == 1)
    }

    @Test @MainActor func `capture rejects invalid target sample rate before touching hardware`() {
        let capture = MacRealtimeTalkAudioCapture(selectedInputUID: { nil })

        #expect(throws: MacRealtimeTalkAudioCaptureError.self) {
            try capture.start(targetSampleRate: 0) { _ in }
        }
        #expect(capture.suppressesInputDuringOutput)
    }

    @Test @MainActor func `capture reports a restart failure once`() {
        var failures: [String] = []
        let capture = MacRealtimeTalkAudioCapture(
            selectedInputUID: { nil },
            onFailure: { failures.append($0.localizedDescription) })
        let error = MacRealtimeTalkAudioCaptureError.inputUnavailable

        capture._test_reportFailure(error)
        capture._test_reportFailure(error)

        #expect(failures == [error.localizedDescription])
    }

    @Test func `capture can be released away from the main actor`() async {
        let holder = await MainActor.run {
            OffMainActorCaptureHolder(MacRealtimeTalkAudioCapture(selectedInputUID: { nil }))
        }

        await Task.detached {
            holder.releaseCapture()
        }.value
        await MainActor.run {}
    }

    private func makeFloatBuffer(
        sampleRate: Double,
        channels: [[Float]]) throws -> AVAudioPCMBuffer
    {
        let frameCount = try #require(channels.first?.count)
        #expect(channels.allSatisfy { $0.count == frameCount })
        let format = try #require(AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: sampleRate,
            channels: AVAudioChannelCount(channels.count),
            interleaved: false))
        let buffer = try #require(AVAudioPCMBuffer(
            pcmFormat: format,
            frameCapacity: AVAudioFrameCount(frameCount)))
        buffer.frameLength = AVAudioFrameCount(frameCount)
        let output = try #require(buffer.floatChannelData)
        for (channelIndex, samples) in channels.enumerated() {
            for (sampleIndex, sample) in samples.enumerated() {
                output[channelIndex][sampleIndex] = sample
            }
        }
        return buffer
    }

    private func samples(in data: Data) -> [Int16] {
        data.withUnsafeBytes { raw in
            raw.bindMemory(to: Int16.self).map { Int16(littleEndian: $0) }
        }
    }
}

/// AVFoundation does not annotate tap blocks as Sendable, but this test owns and
/// invokes the immutable callback once from its dedicated audio queue.
private struct SendableAudioTapHandler: @unchecked Sendable {
    let value: AVAudioNodeTapBlock

    init(_ value: @escaping AVAudioNodeTapBlock) {
        self.value = value
    }
}

private final class RealtimeTalkFrameSink: @unchecked Sendable {
    private let lock = NSLock()
    private var frames: [RealtimeTalkAudioFrame] = []

    var count: Int {
        self.lock.lock()
        defer { self.lock.unlock() }
        return self.frames.count
    }

    func append(_ frame: RealtimeTalkAudioFrame) {
        self.lock.lock()
        self.frames.append(frame)
        self.lock.unlock()
    }
}

private final class OffMainActorCaptureHolder: @unchecked Sendable {
    private var capture: MacRealtimeTalkAudioCapture?

    init(_ capture: MacRealtimeTalkAudioCapture) {
        self.capture = capture
    }

    func releaseCapture() {
        self.capture = nil
    }
}
