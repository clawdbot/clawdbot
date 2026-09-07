import Foundation
import OpenClawKit

extension TalkModeRuntime {
    typealias RealtimeTalkBootstrapProvider =
        @Sendable () async throws -> GatewayConnection.RealtimeTalkBootstrap

    enum PlaybackPlan: Equatable {
        case elevenLabsThenSystemVoice(apiKey: String, voiceId: String)
        case gatewayTalkSpeakThenSystemVoice
        case mlxThenSystemVoice
        case systemVoiceOnly
    }

    enum MLXFailureDisposition: Equatable {
        case canceled
        case fallback
    }

    static func makeTalkSpeakParams(
        text: String,
        voiceId: String?,
        modelId: String?,
        outputFormat: String?,
        directive: TalkDirective?) -> [String: AnyCodable]
    {
        var params: [String: AnyCodable] = ["text": AnyCodable(text)]

        func addString(_ key: String, _ value: String?) {
            let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !trimmed.isEmpty else { return }
            params[key] = AnyCodable(trimmed)
        }

        addString("voiceId", voiceId)
        addString("modelId", directive?.modelId ?? modelId)
        addString("outputFormat", directive?.outputFormat ?? outputFormat)
        if let speed = directive?.speed {
            params["speed"] = AnyCodable(speed)
        }
        if let rateWPM = directive?.rateWPM {
            params["rateWpm"] = AnyCodable(rateWPM)
        }
        if let stability = directive?.stability {
            params["stability"] = AnyCodable(stability)
        }
        if let similarity = directive?.similarity {
            params["similarity"] = AnyCodable(similarity)
        }
        if let style = directive?.style {
            params["style"] = AnyCodable(style)
        }
        if let speakerBoost = directive?.speakerBoost {
            params["speakerBoost"] = AnyCodable(speakerBoost)
        }
        if let seed = directive?.seed {
            params["seed"] = AnyCodable(seed)
        }
        addString("normalize", directive?.normalize)
        addString("language", directive?.language)
        if let latencyTier = directive?.latencyTier {
            params["latencyTier"] = AnyCodable(latencyTier)
        }

        return params
    }
}
