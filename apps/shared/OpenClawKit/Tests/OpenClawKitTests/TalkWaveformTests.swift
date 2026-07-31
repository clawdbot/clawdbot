import AVFoundation
import Foundation
import Testing
@testable import OpenClawChatUI
@testable import OpenClawKit

struct TalkWaveformMathTests {
    @Test
    func `idle is A flat floor`() {
        #expect(TalkWaveformMath.power(for: .idle, time: 0) == 0.05)
        #expect(TalkWaveformMath.power(for: .idle, time: 12.7) == 0.05)
    }

    @Test
    func `thinking breathes inside its band`() {
        for time in stride(from: 0.0, through: 10.0, by: 0.25) {
            let power = TalkWaveformMath.power(for: .thinking, time: time)
            #expect(power >= 0.16)
            #expect(power <= 0.26 + 1e-9)
        }
    }

    @Test
    func `listening follows the mic level and clamps`() {
        #expect(TalkWaveformMath.power(for: .listening(level: 0, speechActive: false), time: 1) == 0.30)
        #expect(TalkWaveformMath.power(for: .listening(level: 1, speechActive: false), time: 1) == 0.95)
        #expect(TalkWaveformMath.power(for: .listening(level: 2.5, speechActive: false), time: 1) == 0.95)
        #expect(TalkWaveformMath.power(for: .listening(level: -1, speechActive: false), time: 1) == 0.30)
    }

    @Test
    func `detected speech raises the floor but stays level driven`() {
        let quiet = TalkWaveformMath.power(for: .listening(level: 0, speechActive: true), time: 1)
        let loud = TalkWaveformMath.power(for: .listening(level: 1, speechActive: true), time: 1)
        #expect(quiet == 0.55)
        #expect(loud == 1.0)
    }

    @Test
    func `speaking follows the playback envelope`() {
        #expect(TalkWaveformMath.power(for: .speaking(level: 0), time: 1) == 0.25)
        #expect(TalkWaveformMath.power(for: .speaking(level: 1), time: 1) == 1.0)
        #expect(TalkWaveformMath.power(for: .speaking(level: 3), time: 1) == 1.0)
    }

    @Test
    func `speaking without an envelope pulses synthetically`() {
        var seen: Set<Int> = []
        for time in stride(from: 0.0, through: 3.0, by: 0.05) {
            let power = TalkWaveformMath.power(for: .speaking(level: nil), time: time)
            #expect(power >= 0.70 * 0.55 - 1e-9)
            #expect(power <= 0.70 + 1e-9)
            seen.insert(Int(power * 1000))
        }
        // The fallback must move over time, not freeze.
        #expect(seen.count > 5)
    }

    @Test
    func `avatar contour remains outside the avatar and inside its amplitude`() {
        let baseRadius = 20.0
        let amplitude = 8.0

        for time in stride(from: 0.0, through: 3.0, by: 0.2) {
            for angle in stride(from: 0.0, through: 2 * Double.pi, by: 0.1) {
                let radius = TalkWaveformMath.radialRadius(
                    angle: angle,
                    baseRadius: baseRadius,
                    amplitude: amplitude,
                    time: time,
                    seed: 0.4)
                #expect(radius >= baseRadius)
                #expect(radius <= baseRadius + amplitude)
            }
        }
    }

    @Test
    func `avatar contour evolves without radial spokes`() {
        let first = TalkWaveformMath.radialRadius(
            angle: 0.7,
            baseRadius: 20,
            amplitude: 8,
            time: 0,
            seed: 0.4)
        let later = TalkWaveformMath.radialRadius(
            angle: 0.7,
            baseRadius: 20,
            amplitude: 8,
            time: 0.4,
            seed: 0.4)

        #expect(abs(first - later) > 0.01)
    }

    @Test
    func `avatar audio contour is bounded by measured samples`() {
        let samples = [0.12, 0.48, 0.9]
        for progress in stride(from: 0.0, through: 1.0, by: 0.01) {
            let magnitude = TalkWaveformMath.radialEnvelopeMagnitude(progress: progress, samples: samples)
            #expect(magnitude >= 0.08)
            #expect(magnitude <= 1)
        }
    }

    @Test
    func `avatar audio contour puts the newest level opposite the seam`() {
        let samples = [0.1, 0.9]
        let seam = TalkWaveformMath.radialEnvelopeMagnitude(progress: 0, samples: samples)
        let opposite = TalkWaveformMath.radialEnvelopeMagnitude(progress: 0.5, samples: samples)
        #expect(opposite > seam)
        #expect(abs(seam - TalkWaveformMath.radialEnvelopeMagnitude(progress: 1, samples: samples)) < 1e-9)
    }

    @Test
    func `compact audio envelope tapers cleanly at both edges`() {
        let samples = [0.15, 0.48, 0.82]
        #expect(TalkWaveformMath.traceEnvelopeMagnitude(progress: 0, samples: samples) == 0)
        #expect(abs(TalkWaveformMath.traceEnvelopeMagnitude(progress: 1, samples: samples)) < 1e-9)
    }

    @Test
    func `compact audio envelope breathes from newest real sample at center`() {
        let quiet = TalkWaveformMath.traceEnvelopeMagnitude(progress: 0.5, samples: [0.2, 0.1])
        let loud = TalkWaveformMath.traceEnvelopeMagnitude(progress: 0.5, samples: [0.2, 0.9])

        #expect(loud > quiet)
        #expect(loud <= 1)
        let left = TalkWaveformMath.traceEnvelopeMagnitude(progress: 0.32, samples: [0.2, 0.9])
        let right = TalkWaveformMath.traceEnvelopeMagnitude(progress: 0.68, samples: [0.2, 0.9])
        #expect(abs(left - right) < 1e-9)
    }

    @Test
    func `compact audio envelope interpolation is bounded by the measured scale`() {
        let samples = [-4, 0.1, 0.8, 3]
        for position in stride(from: -2.0, through: 8.0, by: 0.05) {
            let value = TalkWaveformMath.interpolatedEnvelopeSample(at: position, samples: samples)
            #expect(value >= 0)
            #expect(value <= 1)
        }
    }
}

struct TalkAudioLevelTests {
    @Test
    func `full scale RMS normalizes to one`() {
        #expect(TalkAudioLevel.normalized(rms: 1.0) == 1.0)
    }

    @Test
    func `silence normalizes to zero`() {
        #expect(TalkAudioLevel.normalized(rms: 0) == 0)
        #expect(TalkAudioLevel.normalized(rms: 1e-9) == 0)
    }

    @Test
    func `pcm 16 RMS measures real samples`() {
        let silence = Data(repeating: 0, count: 512)
        #expect(TalkAudioLevel.pcm16RMS(silence) == 0)

        var fullScale = Data()
        for _ in 0..<256 {
            withUnsafeBytes(of: Int16.max.littleEndian) { fullScale.append(contentsOf: $0) }
        }
        let rms = TalkAudioLevel.pcm16RMS(fullScale)
        #expect(abs(rms - 1.0) < 0.001)
        #expect(TalkAudioLevel.normalized(rms: rms) > 0.99)
    }

    @Test
    func `pcm 16 RMS ignores empty and odd data`() {
        #expect(TalkAudioLevel.pcm16RMS(Data()) == 0)
        #expect(TalkAudioLevel.pcm16RMS(Data([0x7F])) == 0)
    }

    @Test
    func `buffer RMS averages float samples across channels`() throws {
        let format = try #require(AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16000,
            channels: 2,
            interleaved: false))
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 128))
        buffer.frameLength = 128
        let channels = try #require(buffer.floatChannelData)
        for index in 0..<128 {
            channels[0][index] = 0.5
            channels[1][index] = -0.5
        }
        #expect(abs(TalkAudioLevel.rms(buffer: buffer) - 0.5) < 1e-6)

        buffer.frameLength = 0
        #expect(TalkAudioLevel.rms(buffer: buffer) == 0)
    }
}
