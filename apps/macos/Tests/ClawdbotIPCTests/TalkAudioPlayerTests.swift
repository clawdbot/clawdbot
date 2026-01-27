import Foundation
import Testing
@testable import Moltbot

@Suite(.serialized) struct TalkAudioPlayerTests {
    @MainActor
    @Test func playDoesNotHangWhenPlaybackEndsOrFails() async throws {
        let wav = makeWav16Mono(sampleRate: 8000, samples: 80)
        defer { _ = TalkAudioPlayer.shared.stop() }

        _ = try await withTimeout(seconds: 4.0) {
            await TalkAudioPlayer.shared.play(data: wav)
        }

        #expect(true)
    }

    @MainActor
    @Test func playDoesNotHangWhenPlayIsCalledTwice() async throws {
        let wav = makeWav16Mono(sampleRate: 8000, samples: 800)
        defer { _ = TalkAudioPlayer.shared.stop() }

        let first = Task { @MainActor in
            await TalkAudioPlayer.shared.play(data: wav)
        }

        await Task.yield()
        _ = await TalkAudioPlayer.shared.play(data: wav)

        _ = try await withTimeout(seconds: 4.0) {
            await first.value
        }
        #expect(true)
    }
}

private struct TimeoutError: Error {}

private func withTimeout<T: Sendable>(
    seconds: Double,
    _ work: @escaping @Sendable () async throws -> T) async throws -> T
{
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask {
            try await work()
        }
        group.addTask {
            try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            throw TimeoutError()
        }
        let result = try await group.next()
        group.cancelAll()
        guard let result else { throw TimeoutError() }
        return result
    }
}

private func makeWav16Mono(sampleRate: UInt32, samples: Int) -> Data {
    let channels: UInt16 = 1
    let bitsPerSample: UInt16 = 16
    let blockAlign = channels * (bitsPerSample / 8)
    let byteRate = sampleRate * UInt32(blockAlign)
    let dataSize = UInt32(samples) * UInt32(blockAlign)

    var data = Data()
    data.append(contentsOf: [0x52, 0x49, 0x46, 0x46]) // RIFF
    data.appendLEUInt32(36 + dataSize)
    data.append(contentsOf: [0x57, 0x41, 0x56, 0x45]) // WAVE

    data.append(contentsOf: [0x66, 0x6D, 0x74, 0x20]) // fmt
    data.appendLEUInt32(16) // PCM
    data.appendLEUInt16(1) // audioFormat
    data.appendLEUInt16(channels)
    data.appendLEUInt32(sampleRate)
    data.appendLEUInt32(byteRate)
    data.appendLEUInt16(blockAlign)
    data.appendLEUInt16(bitsPerSample)

    data.append(contentsOf: [0x64, 0x61, 0x74, 0x61]) // data
    data.appendLEUInt32(dataSize)

    // Silence samples.
    data.append(Data(repeating: 0, count: Int(dataSize)))
    return data
}

extension Data {
    fileprivate mutating func appendLEUInt16(_ value: UInt16) {
        var v = value.littleEndian
        Swift.withUnsafeBytes(of: &v) { append(contentsOf: $0) }
    }

    fileprivate mutating func appendLEUInt32(_ value: UInt32) {
        var v = value.littleEndian
        Swift.withUnsafeBytes(of: &v) { append(contentsOf: $0) }
    }
}
