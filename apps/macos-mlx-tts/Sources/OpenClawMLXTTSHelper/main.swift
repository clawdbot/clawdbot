import Foundation
import MLXAudioTTS

// swiftformat:disable wrap wrapMultilineStatementBraces trailingCommas redundantSelf extensionAccessControl
@main
enum OpenClawMLXTTSHelper {
    static func main() async {
        do {
            let options = try Options.parse(CommandLine.arguments.dropFirst())
            let data = try await synthesize(options)
            try data.write(to: options.outputURL, options: [.atomic])
        } catch {
            FileHandle.standardError.write(Data("openclaw-mlx-tts: \(error)\n".utf8))
            exit(1)
        }
    }

    private static func synthesize(_ options: Options) async throws -> Data {
        let model = try await TTS.loadModel(modelRepo: options.modelRepo)
        let audio = try await UncheckedSpeechModel(raw: model).generateAudio(
            text: options.text,
            voice: options.voice,
            language: options.language)
        return makeWavData(samples: audio, sampleRate: Double(model.sampleRate))
    }

    private struct Options {
        let text: String
        let modelRepo: String
        let outputURL: URL
        let language: String?
        let voice: String?

        static func parse(_ rawArguments: ArraySlice<String>) throws -> Options {
            var text: String?
            var modelRepo = "mlx-community/Soprano-80M-bf16"
            var outputPath: String?
            var language: String?
            var voice: String?
            var iterator = rawArguments.makeIterator()

            while let argument = iterator.next() {
                switch argument {
                case "--text", "-t":
                    text = try nextValue(&iterator, argument)
                case "--model":
                    modelRepo = try nextValue(&iterator, argument)
                case "--output", "-o":
                    outputPath = try nextValue(&iterator, argument)
                case "--language":
                    language = try nextValue(&iterator, argument)
                case "--voice", "-v":
                    voice = try nextValue(&iterator, argument)
                case "--help", "-h":
                    throw Usage.requested
                default:
                    if text == nil, !argument.hasPrefix("-") {
                        text = argument
                    } else {
                        throw Usage.invalid("unknown option \(argument)")
                    }
                }
            }

            guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
                throw Usage.invalid("missing --text")
            }
            guard let outputPath, !outputPath.isEmpty else {
                throw Usage.invalid("missing --output")
            }

            return Options(
                text: text,
                modelRepo: modelRepo,
                outputURL: URL(fileURLWithPath: outputPath),
                language: language?.nilIfBlank,
                voice: voice?.nilIfBlank)
        }

        private static func nextValue(
            _ iterator: inout ArraySlice<String>.Iterator,
            _ option: String) throws -> String
        {
            guard let value = iterator.next(), !value.isEmpty else {
                throw Usage.invalid("missing value for \(option)")
            }
            return value
        }
    }

    private enum Usage: Error, CustomStringConvertible {
        case requested
        case invalid(String)

        var description: String {
            switch self {
            case .requested:
                "usage: openclaw-mlx-tts --text <text> --output <wav> [--model <hf-repo>] [--language <id>] [--voice <name>]"
            case let .invalid(message):
                "\(message)\nusage: openclaw-mlx-tts --text <text> --output <wav> [--model <hf-repo>] [--language <id>] [--voice <name>]"
            }
        }
    }

    private static func makeWavData(samples: [Float], sampleRate: Double) -> Data {
        let channels: UInt16 = 1
        let bitsPerSample: UInt16 = 16
        let blockAlign = channels * (bitsPerSample / 8)
        let sampleRateInt = UInt32(sampleRate.rounded())
        let byteRate = sampleRateInt * UInt32(blockAlign)
        let dataSize = UInt32(samples.count) * UInt32(blockAlign)

        var data = Data(capacity: Int(44 + dataSize))
        data.append(contentsOf: [0x52, 0x49, 0x46, 0x46]) // RIFF
        data.appendLEUInt32(36 + dataSize)
        data.append(contentsOf: [0x57, 0x41, 0x56, 0x45]) // WAVE

        data.append(contentsOf: [0x66, 0x6D, 0x74, 0x20]) // fmt
        data.appendLEUInt32(16)
        data.appendLEUInt16(1)
        data.appendLEUInt16(channels)
        data.appendLEUInt32(sampleRateInt)
        data.appendLEUInt32(byteRate)
        data.appendLEUInt16(blockAlign)
        data.appendLEUInt16(bitsPerSample)

        data.append(contentsOf: [0x64, 0x61, 0x74, 0x61]) // data
        data.appendLEUInt32(dataSize)

        for sample in samples {
            let clamped = max(-1.0, min(1.0, sample))
            let scaled = Int16((clamped * Float(Int16.max)).rounded())
            data.appendLEInt16(scaled)
        }
        return data
    }
}

private struct UncheckedSpeechModel {
    let raw: any SpeechGenerationModel

    func generateAudio(
        text: String,
        voice: String?,
        language: String?) async throws -> [Float] {
        let generatedAudio = try await raw.generate(
            text: text,
            voice: voice,
            refAudio: nil,
            refText: nil,
            language: language)
        return generatedAudio.asArray(Float.self)
    }
}

extension UncheckedSpeechModel: @unchecked Sendable {}

private extension String {
    var nilIfBlank: String? {
        let trimmed = self.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

private extension Data {
    mutating func appendLEUInt16(_ value: UInt16) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { append(contentsOf: $0) }
    }

    mutating func appendLEUInt32(_ value: UInt32) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { append(contentsOf: $0) }
    }

    mutating func appendLEInt16(_ value: Int16) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { append(contentsOf: $0) }
    }
}

// swiftformat:enable wrap wrapMultilineStatementBraces trailingCommas redundantSelf extensionAccessControl
