@preconcurrency import AVFoundation
import Foundation

final class BufferConverter {
    private final class Box<T>: @unchecked Sendable { var value: T; init(_ value: T) { self.value = value } }
    enum ConverterError: Swift.Error {
        case failedToCreateConverter
        case failedToCreateConversionBuffer
        case conversionFailed(NSError?)
    }

    private var converter: AVAudioConverter?

    func convert(_ buffer: AVAudioPCMBuffer, to format: AVAudioFormat) throws -> AVAudioPCMBuffer {
        let inputFormat = buffer.format
        if inputFormat == format {
            return buffer
        }
        if converter == nil || converter?.outputFormat != format {
            converter = AVAudioConverter(from: inputFormat, to: format)
            converter?.primeMethod = .none
        }
        guard let converter else { throw ConverterError.failedToCreateConverter }

        let sampleRateRatio = converter.outputFormat.sampleRate / converter.inputFormat.sampleRate
        let scaledInputFrameLength = Double(buffer.frameLength) * sampleRateRatio
        let frameCapacity = AVAudioFrameCount(scaledInputFrameLength.rounded(.up))
        guard let conversionBuffer = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: frameCapacity)
        else {
            throw ConverterError.failedToCreateConversionBuffer
        }

        var nsError: NSError?
        let consumed = Box(false)
        let inputBuffer = buffer
        let status = converter.convert(to: conversionBuffer, error: &nsError) { _, statusPtr in
            if consumed.value {
                statusPtr.pointee = .noDataNow
                return nil
            }
            consumed.value = true
            statusPtr.pointee = .haveData
            return inputBuffer
        }
        if status == .error {
            throw ConverterError.conversionFailed(nsError)
        }
        return conversionBuffer
    }
}
