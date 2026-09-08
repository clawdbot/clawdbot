#if Talk && canImport(ElevenLabsKit)
@_exported import ElevenLabsKit

public typealias ElevenLabsTTSRequest = ElevenLabsKit.ElevenLabsTTSRequest
public typealias ElevenLabsTTSClient = ElevenLabsKit.ElevenLabsTTSClient
public typealias TalkTTSValidation = ElevenLabsKit.TalkTTSValidation
public typealias StreamingAudioPlayer = ElevenLabsKit.StreamingAudioPlayer
public typealias PCMStreamingAudioPlayer = ElevenLabsKit.PCMStreamingAudioPlayer
public typealias StreamingPlaybackResult = ElevenLabsKit.StreamingPlaybackResult

extension ElevenLabsTTSRequest {
    public init(
        text: String,
        directive: TalkDirective?,
        modelId: String?,
        outputFormat: String?,
        language: String?)
    {
        self.init(
            text: text,
            modelId: modelId,
            outputFormat: outputFormat,
            speed: TalkTTSValidation.resolveSpeed(speed: directive?.speed, rateWPM: directive?.rateWPM),
            stability: TalkTTSValidation.validatedStability(directive?.stability, modelId: modelId),
            similarity: TalkTTSValidation.validatedUnit(directive?.similarity),
            style: TalkTTSValidation.validatedUnit(directive?.style),
            speakerBoost: directive?.speakerBoost,
            seed: TalkTTSValidation.validatedSeed(directive?.seed),
            normalize: ElevenLabsTTSClient.validatedNormalize(directive?.normalize),
            language: language,
            latencyTier: TalkTTSValidation.validatedLatencyTier(directive?.latencyTier))
    }
}
#endif
