import AVFAudio
import Foundation

final class WatchOpusCodec {
    static let sampleRate = 48000.0
    static let frameCount: AVAudioFrameCount = 960
    let pcmFormat: AVAudioFormat
    private let opusFormat: AVAudioFormat
    private let encoder: AVAudioConverter
    private let decoder: AVAudioConverter

    init() throws {
        guard let pcm = AVAudioFormat(standardFormatWithSampleRate: Self.sampleRate, channels: 1),
              let opus = AVAudioFormat(settings: [
                  AVFormatIDKey: kAudioFormatOpus,
                  AVSampleRateKey: Self.sampleRate,
                  AVNumberOfChannelsKey: 1,
              ]),
              let encoder = AVAudioConverter(from: pcm, to: opus),
              let decoder = AVAudioConverter(from: opus, to: pcm)
        else {
            throw WatchRealtimeMediaError.unavailable(String(localized: "Opus audio is unavailable on this device."))
        }
        self.pcmFormat = pcm
        self.opusFormat = opus
        self.encoder = encoder
        self.decoder = decoder
        encoder.bitRate = 24000
        encoder.primeMethod = .none
        decoder.primeMethod = .none
    }

    func encode(_ pcm: AVAudioPCMBuffer) throws -> Data? {
        guard pcm.frameLength == Self.frameCount, pcm.format == self.pcmFormat else {
            throw WatchRealtimeMediaError
                .unavailable(String(localized: "Voice capture returned an unexpected audio format."))
        }
        let output = AVAudioCompressedBuffer(
            format: self.opusFormat, packetCapacity: 1, maximumPacketSize: self.encoder.maximumOutputPacketSize)
        var supplied = false
        var error: NSError?
        let result = self.encoder.convert(to: output, error: &error) { _, status in
            guard !supplied else { status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return pcm
        }
        if let error { throw error }
        guard result != .error
        else { throw WatchRealtimeMediaError.unavailable(String(localized: "Voice encoding failed.")) }
        guard output.packetCount == 1 else { return nil }
        return Data(bytes: output.data, count: Int(output.byteLength))
    }

    func decode(_ packet: Data) throws -> AVAudioPCMBuffer {
        guard !packet.isEmpty, packet.count <= 2000 else {
            throw WatchRealtimeMediaError.unavailable(String(localized: "Voice received an invalid Opus packet."))
        }
        let input = AVAudioCompressedBuffer(format: self.opusFormat, packetCapacity: 1, maximumPacketSize: packet.count)
        packet.copyBytes(to: input.data.assumingMemoryBound(to: UInt8.self), count: packet.count)
        input.byteLength = UInt32(packet.count)
        input.packetCount = 1
        // Incoming packets may aggregate frames. The native Opus decoder reads their TOC;
        // our 20 ms capture frame size is not a constraint on the remote packet duration.
        input.packetDescriptions?.pointee = AudioStreamPacketDescription(
            mStartOffset: 0, mVariableFramesInPacket: 0, mDataByteSize: UInt32(packet.count))
        guard let output = AVAudioPCMBuffer(pcmFormat: self.pcmFormat, frameCapacity: 5760) else {
            throw WatchRealtimeMediaError.unavailable(String(localized: "Voice playback could not allocate audio."))
        }
        var supplied = false
        var error: NSError?
        let result = self.decoder.convert(to: output, error: &error) { _, status in
            guard !supplied else { status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return input
        }
        if let error { throw error }
        guard result != .error
        else { throw WatchRealtimeMediaError.unavailable(String(localized: "Voice decoding failed.")) }
        return output
    }
}
