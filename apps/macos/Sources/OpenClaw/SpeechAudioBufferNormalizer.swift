@preconcurrency import AVFoundation

enum SpeechAudioBufferNormalizer {
    static func speechCompatibleBuffer(from buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer {
        let format = buffer.format
        guard format.channelCount > 2, format.sampleRate > 0 else {
            return buffer
        }
        return self.downmixFloatBuffer(buffer) ?? self.convertBuffer(buffer) ?? buffer
    }

    private static func downmixFloatBuffer(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        let format = buffer.format
        guard format.commonFormat == .pcmFormatFloat32,
              !format.isInterleaved,
              let source = buffer.floatChannelData,
              let targetFormat = AVAudioFormat(
                  commonFormat: .pcmFormatFloat32,
                  sampleRate: format.sampleRate,
                  channels: 1,
                  interleaved: false),
              let output = AVAudioPCMBuffer(
                  pcmFormat: targetFormat,
                  frameCapacity: buffer.frameCapacity),
              let target = output.floatChannelData?[0]
        else {
            return nil
        }

        output.frameLength = buffer.frameLength
        let channelCount = Int(format.channelCount)
        let frameCount = Int(buffer.frameLength)
        guard channelCount > 0, frameCount > 0 else { return output }

        let scale = 1.0 / Float(channelCount)
        for frame in 0..<frameCount {
            var sum: Float = 0
            for channel in 0..<channelCount {
                sum += source[channel][frame]
            }
            target[frame] = sum * scale
        }
        return output
    }

    private static func convertBuffer(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: buffer.format.sampleRate,
            channels: 1,
            interleaved: false),
            let converter = AVAudioConverter(from: buffer.format, to: targetFormat)
        else {
            return nil
        }

        let frameCapacity = AVAudioFrameCount(
            max(1, ceil(Double(buffer.frameLength) * targetFormat.sampleRate / buffer.format.sampleRate)))
        guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: frameCapacity) else {
            return nil
        }

        let input = ConverterInput(buffer)
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, outStatus in
            if input.didProvide {
                outStatus.pointee = .noDataNow
                return nil
            }
            input.didProvide = true
            outStatus.pointee = .haveData
            return input.buffer
        }
        guard status != .error else { return nil }
        return output
    }

    private final class ConverterInput: @unchecked Sendable {
        let buffer: AVAudioPCMBuffer
        var didProvide = false

        init(_ buffer: AVAudioPCMBuffer) {
            self.buffer = buffer
        }
    }
}
