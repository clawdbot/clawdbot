import AVFoundation
import Foundation
import OpenClawKit
import OpenClawProtocol
import OSLog

struct TalkGatewaySpeechAudio: Equatable {
    enum PlaybackMode: Equatable {
        case pcm(sampleRate: Double)
        case buffered
        case unsupportedRaw(codec: String)
    }

    let data: Data
    let provider: String
    let outputFormat: String?

    var playbackMode: PlaybackMode {
        if let sampleRate = TalkTTSValidation.pcmSampleRate(from: self.outputFormat) {
            return .pcm(sampleRate: sampleRate)
        }
        let outputFormat = self.outputFormat?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let isHeaderlessAudio = if let outputFormat {
            outputFormat.hasPrefix("raw-") ||
                outputFormat.hasPrefix("raw_") ||
                outputFormat == "pcm" ||
                outputFormat == "mulaw" ||
                outputFormat == "alaw" ||
                outputFormat.hasPrefix("mulaw_") ||
                outputFormat.hasPrefix("ulaw_") ||
                outputFormat.hasPrefix("alaw_")
        } else {
            false
        }
        if let outputFormat, isHeaderlessAudio {
            // talk.speak does not expose the sample rate needed to play headerless audio.
            // Keep these codecs out of AVAudioPlayer until that protocol metadata exists.
            return .unsupportedRaw(codec: outputFormat)
        }
        // Gateway providers return complete audio files (for example MP3, WAV, or FLAC).
        // AVAudioPlayer performs container detection; raw PCM keeps its sample-rate path above.
        return .buffered
    }
}

struct TalkGatewaySpeechRequest {
    let text: String
    // These are talk.speak protocol inputs; each Gateway speech provider owns which overrides it honors.
    let voiceId: String?
    let modelId: String?
    let outputFormat: String?
    let directive: TalkDirective?
}

@MainActor
protocol TalkGatewaySpeechSynthesizing {
    func synthesize(_ request: TalkGatewaySpeechRequest) async throws -> TalkGatewaySpeechAudio
}

@MainActor
final class TalkGatewaySpeechClient: TalkGatewaySpeechSynthesizing {
    typealias Request = (_ method: String, _ paramsJSON: String?, _ timeoutSeconds: Int) async throws -> Data
    private static let requestTimeoutSeconds = 125

    private let request: Request

    init(gateway: GatewayNodeSession) {
        self.request = { method, paramsJSON, timeoutSeconds in
            try await gateway.request(
                method: method,
                paramsJSON: paramsJSON,
                timeoutSeconds: timeoutSeconds)
        }
    }

    init(request: @escaping Request) {
        self.request = request
    }

    func synthesize(_ speechRequest: TalkGatewaySpeechRequest) async throws -> TalkGatewaySpeechAudio {
        let directive = speechRequest.directive
        let params = TalkSpeakParams(
            text: speechRequest.text,
            voiceid: speechRequest.voiceId,
            modelid: speechRequest.modelId,
            outputformat: speechRequest.outputFormat,
            speed: directive?.speed,
            ratewpm: directive?.rateWPM,
            stability: directive?.stability,
            similarity: directive?.similarity,
            style: directive?.style,
            speakerboost: directive?.speakerBoost,
            seed: directive?.seed,
            normalize: directive?.normalize,
            language: directive?.language,
            latencytier: directive?.latencyTier)
        let paramsData = try JSONEncoder().encode(params)
        guard let paramsJSON = String(data: paramsData, encoding: .utf8) else {
            throw TalkGatewaySpeechError.invalidRequest
        }
        let responseData = try await request(
            "talk.speak",
            paramsJSON,
            Self.requestTimeoutSeconds)
        let response = try JSONDecoder().decode(TalkSpeakResult.self, from: responseData)
        guard let audioData = Data(base64Encoded: response.audiobase64), !audioData.isEmpty else {
            throw TalkGatewaySpeechError.emptyAudio
        }
        return TalkGatewaySpeechAudio(
            data: audioData,
            provider: response.provider,
            outputFormat: response.outputformat)
    }
}

@MainActor
protocol TalkBufferedAudioPlaying {
    func play(data: Data) async -> StreamingPlaybackResult
    func stop() -> Double?
    func setLevelHandler(_ handler: (@MainActor (Double?) -> Void)?)
}

extension TalkBufferedAudioPlaying {
    /// Level metering is a UI nicety; test doubles and future players may skip it.
    func setLevelHandler(_: (@MainActor (Double?) -> Void)?) {}
}

/// Playback lives in OpenClawKit's TalkBufferedAudioPlayer, shared with the
/// macOS talk runtime; this file keeps only the iOS test seam conformance.
extension TalkBufferedAudioPlayer: TalkBufferedAudioPlaying {}

private enum TalkGatewaySpeechError: LocalizedError {
    case invalidRequest
    case emptyAudio

    var errorDescription: String? {
        switch self {
        case .invalidRequest:
            "Failed to encode talk.speak request"
        case .emptyAudio:
            "Gateway talk.speak returned empty audio"
        }
    }
}
