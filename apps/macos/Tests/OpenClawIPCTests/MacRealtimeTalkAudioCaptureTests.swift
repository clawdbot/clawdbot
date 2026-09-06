@preconcurrency import AVFoundation
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

private final class SendableTapHandler: @unchecked Sendable {
    private let handler: AVAudioNodeTapBlock

    init(_ handler: @escaping AVAudioNodeTapBlock) {
        self.handler = handler
    }

    func callAsFunction(_ buffer: AVAudioPCMBuffer, _ time: AVAudioTime) {
        self.handler(buffer, time)
    }
}

struct MacRealtimeTalkAudioCaptureTests {
    @Test func `encoder downmixes resamples and emits little endian pcm16`() throws {
        let buffer = try makeFloatBuffer(
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
        let buffer = try makeFloatBuffer(
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
        let gate = TalkGenerationDeliveryGate()
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
        let buffer = try makeFloatBuffer(
            sampleRate: 48000,
            channels: [[0, 0.5, -0.5, 0]])
        let gate = TalkGenerationDeliveryGate()
        let token = gate.activate()
        let sink = RealtimeTalkFrameSink()
        let handler = SendableTapHandler(MacRealtimeTalkTapHandlerFactory.make(
            targetSampleRate: 24000,
            deliveryGate: gate,
            deliveryToken: token,
            onAudio: { sink.append($0) }))
        let finished = DispatchSemaphore(value: 0)

        DispatchQueue(label: "talk.realtime.tap-test").async {
            handler(buffer, AVAudioTime(sampleTime: 0, atRate: 48000))
            finished.signal()
        }

        #expect(finished.wait(timeout: .now() + 2) == .success)
        #expect(sink.count == 1)
    }

    @Test @MainActor func `capture rejects invalid target sample rate before touching hardware`() {
        let capture = MacRealtimeTalkAudioCapture(selectedInputUID: { nil })
        #expect(capture.suppressesInputDuringOutput)

        #expect(throws: MacRealtimeTalkAudioCaptureError.self) {
            try capture.start(
                targetSampleRate: 0,
                onAudio: { _ in },
                onFailure: { _ in })
        }
        #expect(capture.suppressesInputDuringOutput)
    }

    @Test @MainActor func `queued route callback is ignored after observation retires`() async throws {
        let capture = MacRealtimeTalkAudioCapture(selectedInputUID: { nil })
        let probe = capture._test_replaceOutputRouteObserver()

        probe.callback(self.headphonesRoute())
        capture.stop()
        try await self.waitForHandledCallback(probe.handled)

        #expect(capture.suppressesInputDuringOutput)
    }

    @Test @MainActor func `retired observer callback is ignored after replacement`() async throws {
        let capture = MacRealtimeTalkAudioCapture(selectedInputUID: { nil })
        let retired = capture._test_replaceOutputRouteObserver()
        _ = capture._test_replaceOutputRouteObserver()

        retired.callback(self.headphonesRoute())
        try await self.waitForHandledCallback(retired.handled)

        #expect(capture.suppressesInputDuringOutput)
    }

    @Test @MainActor func `current observer enables headphone barge in`() async throws {
        let capture = MacRealtimeTalkAudioCapture(selectedInputUID: { nil })
        let probe = capture._test_replaceOutputRouteObserver()

        probe.callback(self.headphonesRoute())
        try await self.waitForHandledCallback(probe.handled)

        #expect(!capture.suppressesInputDuringOutput)
    }

    @Test func `allowlisted transports preserve barge in only for headphones`() {
        let transports = [
            kAudioDeviceTransportTypeBuiltIn,
            kAudioDeviceTransportTypeUSB,
            kAudioDeviceTransportTypeBluetooth,
            kAudioDeviceTransportTypeBluetoothLE,
        ]

        for transport in transports {
            let decision = MacRealtimeTalkOutputRoutePolicy.decision(for: self.route(
                transport: transport,
                terminals: [kAudioStreamTerminalTypeHeadphones]))
            #expect(!decision.suppressesInputDuringOutput)
            #expect(decision.reason == .isolatedHeadphones)
        }
    }

    @Test func `non allowlisted transports fail closed even with headphone metadata`() {
        let transports = [
            kAudioDeviceTransportTypeAggregate,
            kAudioDeviceTransportTypeVirtual,
            kAudioDeviceTransportTypeUnknown,
            kAudioDeviceTransportTypeHDMI,
            kAudioDeviceTransportTypeDisplayPort,
        ]

        for transport in transports {
            let decision = MacRealtimeTalkOutputRoutePolicy.decision(for: self.route(
                transport: transport,
                terminals: [kAudioStreamTerminalTypeHeadphones]))
            #expect(decision.suppressesInputDuringOutput)
            #expect(decision.reason == .transportNotAllowlisted)
        }
    }

    @Test func `allowlisted routes fail closed for empty speaker and mixed kinds`() {
        let terminalTables: [([UInt32], MacRealtimeTalkOutputRouteDecisionReason)] = [
            ([], .outputKindUnavailable),
            ([kAudioStreamTerminalTypeSpeaker], .outputKindNotHeadphones),
            (
                [kAudioStreamTerminalTypeHeadphones, kAudioStreamTerminalTypeSpeaker],
                .outputKindNotHeadphones),
        ]

        for (terminals, reason) in terminalTables {
            let decision = MacRealtimeTalkOutputRoutePolicy.decision(for: self.route(
                transport: kAudioDeviceTransportTypeUSB,
                terminals: terminals))
            #expect(decision.suppressesInputDuringOutput)
            #expect(decision.reason == reason)
        }
    }

    @Test func `selected data source overrides stream terminal metadata both ways`() {
        let selectedHeadphones = self.route(
            transport: kAudioDeviceTransportTypeBuiltIn,
            terminals: [kAudioStreamTerminalTypeSpeaker],
            source: .selected(kinds: [kAudioStreamTerminalTypeHeadphones]))
        let selectedSpeaker = self.route(
            transport: kAudioDeviceTransportTypeBuiltIn,
            terminals: [kAudioStreamTerminalTypeHeadphones],
            source: .selected(kinds: [kAudioStreamTerminalTypeSpeaker]))

        let headphonesDecision = MacRealtimeTalkOutputRoutePolicy.decision(for: selectedHeadphones)
        let speakerDecision = MacRealtimeTalkOutputRoutePolicy.decision(for: selectedSpeaker)
        #expect(!headphonesDecision.suppressesInputDuringOutput)
        #expect(headphonesDecision.reason == .isolatedHeadphones)
        #expect(speakerDecision.suppressesInputDuringOutput)
        #expect(speakerDecision.reason == .outputKindNotHeadphones)
    }

    @Test func `supported data source read failure fails closed`() {
        let route = self.route(
            transport: kAudioDeviceTransportTypeBluetooth,
            terminals: [kAudioStreamTerminalTypeHeadphones],
            source: .failed)

        let decision = MacRealtimeTalkOutputRoutePolicy.decision(for: route)
        #expect(decision.suppressesInputDuringOutput)
        #expect(decision.reason == .dataSourceReadFailed)
        #expect(decision.effectiveKinds.isEmpty)
    }

    @Test func `missing route fails closed with a stable reason`() {
        let decision = MacRealtimeTalkOutputRoutePolicy.decision(for: nil)

        #expect(decision.suppressesInputDuringOutput)
        #expect(decision.reason == .routeUnavailable)
        #expect(decision.redactedDescription ==
            "transport=unavailable kinds=[] source=unavailable " +
            "suppression=true reason=route-unavailable")
    }

    @Test func `route decision log contains only redacted mechanical metadata`() {
        let decision = MacRealtimeTalkOutputRoutePolicy.decision(for: self.route(
            transport: kAudioDeviceTransportTypeBuiltIn,
            terminals: [kAudioStreamTerminalTypeSpeaker],
            source: .selected(kinds: [kAudioStreamTerminalTypeHeadphones])))

        #expect(decision.redactedDescription ==
            "transport='bltn' kinds=['hdph'] source=selected:['hdph'] " +
            "suppression=false reason=isolated-headphones")
    }

    @Test func `route decision state deduplicates and recomputes changes`() {
        var state = MacRealtimeTalkOutputRouteDecisionState()
        let headphones = self.route(
            transport: kAudioDeviceTransportTypeUSB,
            terminals: [kAudioStreamTerminalTypeHeadphones])
        let speakers = self.route(
            transport: kAudioDeviceTransportTypeUSB,
            terminals: [kAudioStreamTerminalTypeSpeaker])

        let initial = state.update(route: headphones)
        #expect(initial?.suppressesInputDuringOutput == false)
        #expect(state.update(route: headphones) == nil)
        let changed = state.update(route: speakers)
        #expect(changed?.suppressesInputDuringOutput == true)
        #expect(changed?.reason == .outputKindNotHeadphones)
        state.reset()
        #expect(state.current == nil)

        let mixedKinds = [kAudioStreamTerminalTypeSpeaker, kAudioStreamTerminalTypeHeadphones]
        let firstOrder = self.route(
            transport: kAudioDeviceTransportTypeUSB,
            terminals: [],
            source: .selected(kinds: mixedKinds))
        let reversedOrder = self.route(
            transport: kAudioDeviceTransportTypeUSB,
            terminals: [],
            source: .selected(kinds: Array(mixedKinds.reversed())))
        #expect(state.update(route: firstOrder) != nil)
        #expect(state.update(route: reversedOrder) == nil)
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

    private func route(
        transport: UInt32,
        terminals: [UInt32],
        source: MacRealtimeTalkOutputDataSource = .unsupported) -> MacRealtimeTalkOutputRoute
    {
        MacRealtimeTalkOutputRoute(
            transportType: transport,
            terminalTypes: terminals,
            selectedDataSource: source)
    }

    private func headphonesRoute() -> MacRealtimeTalkOutputRoute {
        self.route(
            transport: kAudioDeviceTransportTypeBuiltIn,
            terminals: [kAudioStreamTerminalTypeHeadphones])
    }

    @MainActor
    private func waitForHandledCallback(_ stream: AsyncStream<Void>) async throws {
        // Delivery and its watchdog share the callback's executor. A busy MainActor
        // must not let a detached timeout outrun an already queued callback.
        let delivery = Task { @MainActor in
            var iterator = stream.makeAsyncIterator()
            return await iterator.next() != nil
        }
        let watchdog = Task { @MainActor in
            try await Task.sleep(for: .seconds(1))
            delivery.cancel()
        }
        defer {
            watchdog.cancel()
            delivery.cancel()
        }
        let handled = await withTaskCancellationHandler {
            await delivery.value
        } onCancel: {
            delivery.cancel()
        }
        #expect(handled)
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
