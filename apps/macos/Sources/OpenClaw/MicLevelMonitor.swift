import AVFoundation
import OpenClawKit
import OSLog
import SwiftUI

actor MicLevelMonitor {
    private let logger = Logger(subsystem: "ai.openclaw", category: "voicewake.meter")
    private var engine: AVAudioEngine?
    private var update: (@Sendable (Double) -> Void)?
    private var running = false
    private var smoothedLevel: Double = 0
    private var lastUpdate = ContinuousClock.now
    private var lastPublishedLevel: Double = 0
    private let minimumUpdateInterval: Duration = .milliseconds(125)
    private let minimumLevelDelta = 0.02

    func start(onLevel: @Sendable @escaping (Double) -> Void) async throws {
        self.update = onLevel
        if self.running {
            return
        }
        self.logger.info(
            "mic level monitor start (\(AudioInputDeviceObserver.defaultInputDeviceSummary(), privacy: .public))")
        self.lastUpdate = .now
        self.lastPublishedLevel = self.smoothedLevel
        guard AudioInputDeviceObserver.hasUsableDefaultInputDevice() else {
            self.engine = nil
            throw NSError(
                domain: "MicLevelMonitor",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "No usable audio input device available"])
        }
        let engine = AVAudioEngine()
        self.engine = engine
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.channelCount > 0, format.sampleRate > 0 else {
            self.engine = nil
            throw NSError(
                domain: "MicLevelMonitor",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "No audio input available"])
        }
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 512, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            let level = TalkAudioLevel.normalized(rms: TalkAudioLevel.rms(buffer: buffer))
            Task { await self.push(level: level) }
        }
        engine.prepare()
        try engine.start()
        self.running = true
    }

    func stop() {
        guard self.running else { return }
        if let engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
        self.engine = nil
        self.running = false
    }

    private func push(level: Double) {
        self.smoothedLevel = (self.smoothedLevel * 0.45) + (level * 0.55)
        guard let update else { return }
        let now = ContinuousClock.now
        guard now - self.lastUpdate >= self.minimumUpdateInterval ||
            abs(self.smoothedLevel - self.lastPublishedLevel) >= self.minimumLevelDelta
        else { return }
        self.lastUpdate = now
        let value = self.smoothedLevel
        self.lastPublishedLevel = value
        Task { @MainActor in update(value) }
    }
}

struct MicLevelBar: View {
    let level: Double
    let segments: Int = 12

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<self.segments, id: \.self) { idx in
                let fill = self.level * Double(self.segments) > Double(idx)
                RoundedRectangle(cornerRadius: 2)
                    .fill(fill ? self.segmentColor(for: idx) : Color.gray.opacity(0.35))
                    .frame(width: 14, height: 10)
            }
        }
        .padding(4)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .stroke(Color.gray.opacity(0.25), lineWidth: 1))
    }

    private func segmentColor(for idx: Int) -> Color {
        let fraction = Double(idx + 1) / Double(self.segments)
        if fraction < 0.65 {
            return .green
        }
        if fraction < 0.85 {
            return .yellow
        }
        return .red
    }
}
