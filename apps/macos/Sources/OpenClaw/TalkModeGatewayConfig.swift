import Foundation
import OpenClawKit

struct TalkModeGatewayConfigState {
    let activeProvider: String
    let normalizedPayload: Bool
    let missingResolvedPayload: Bool
    let voiceId: String?
    let voiceAliases: [String: String]
    let modelId: String?
    let outputFormat: String?
    let interruptOnSpeech: Bool
    let silenceTimeoutMs: Int
    let speechLocaleID: String?
    let apiKey: String?
    let referenceAudioPath: String?
    let referenceText: String?
    let seamColorHex: String?
    let realtimeProvider: String?
    let realtimeModelId: String?
    let realtimeSpeakerVoice: String?
    let realtimeMode: String?
    let realtimeTransport: String?
    let realtimeBrain: String?

    var hasGatewayRealtimeRelayTuple: Bool {
        self.realtimeMode == "realtime" &&
            self.realtimeTransport == "gateway-relay" &&
            self.realtimeBrain == "agent-consult"
    }
}

enum TalkModeGatewayConfigParser {
    static func parse(
        snapshot: ConfigSnapshot,
        defaultProvider: String,
        defaultModelIdFallback: String,
        defaultSilenceTimeoutMs: Int,
        envVoice: String?,
        sagVoice: String?,
        envApiKey: String?) -> TalkModeGatewayConfigState
    {
        let talk = snapshot.config?["talk"]?.dictionaryValue
        let selection = TalkConfigParsing.selectProviderConfig(talk, defaultProvider: defaultProvider)
        let activeProvider = selection?.provider ?? defaultProvider
        let activeConfig = selection?.config
        let silenceTimeoutMs = TalkConfigParsing.resolvedSilenceTimeoutMs(
            talk,
            fallback: defaultSilenceTimeoutMs)
        let ui = snapshot.config?["ui"]?.dictionaryValue
        let rawSeam = ui?["seamColor"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let voice = activeConfig?["voiceId"]?.stringValue
        let resolvedAliases = TalkVoiceAliases.normalizedMap(activeConfig?["voiceAliases"])
        let model = activeConfig?["modelId"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedModel: String? = if model?.isEmpty == false {
            model!
        } else if activeProvider == defaultProvider {
            defaultModelIdFallback
        } else {
            nil
        }
        let outputFormat = activeConfig?["outputFormat"]?.stringValue
        let interrupt = talk?["interruptOnSpeech"]?.boolValue
        let speechLocaleID = TalkConfigParsing.resolvedSpeechLocaleID(talk)
        let apiKey = activeConfig?["apiKey"]?.stringValue
        let referenceAudioPath = activeConfig?["referenceAudioPath"]?.stringValue?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let referenceText = activeConfig?["referenceText"]?.stringValue?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let realtime = talk?["realtime"]?.dictionaryValue
        let realtimeProviders = realtime?["providers"]?.dictionaryValue
        let realtimeProvider = TalkConfigParsing.firstNonEmptyString(realtime, keys: ["provider"])
            ?? TalkConfigParsing.singleRealtimeProviderID(realtimeProviders)
        let realtimeProviderConfig = TalkConfigParsing.realtimeProviderConfig(
            providers: realtimeProviders,
            provider: realtimeProvider)
        let realtimeModelId = TalkConfigParsing.firstNonEmptyString(realtime, keys: ["model"])
            ?? TalkConfigParsing.firstNonEmptyString(realtimeProviderConfig, keys: ["model"])
        let realtimeSpeakerVoice = TalkConfigParsing.firstNonEmptyString(
            realtime,
            keys: ["speakerVoice", "voice"])
            ?? TalkConfigParsing.firstNonEmptyString(
                realtimeProviderConfig,
                keys: ["speakerVoice", "voice"])
        let realtimeMode = TalkConfigParsing.firstNonEmptyString(realtime, keys: ["mode"])?.lowercased()
        let realtimeTransport =
            TalkConfigParsing.firstNonEmptyString(realtime, keys: ["transport"])?.lowercased()
        let realtimeBrain = TalkConfigParsing.firstNonEmptyString(realtime, keys: ["brain"])?.lowercased()
        let resolvedVoice: String? = if activeProvider == defaultProvider {
            (voice?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? voice : nil) ??
                (envVoice?.isEmpty == false ? envVoice : nil) ??
                (sagVoice?.isEmpty == false ? sagVoice : nil)
        } else {
            (voice?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? voice : nil)
        }
        let resolvedApiKey: String? = if activeProvider == defaultProvider {
            (envApiKey?.isEmpty == false ? envApiKey : nil) ??
                (apiKey?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? apiKey : nil)
        } else {
            nil
        }

        return TalkModeGatewayConfigState(
            activeProvider: activeProvider,
            normalizedPayload: selection?.normalizedPayload == true,
            missingResolvedPayload: talk != nil && selection == nil,
            voiceId: resolvedVoice,
            voiceAliases: resolvedAliases,
            modelId: resolvedModel,
            outputFormat: outputFormat,
            interruptOnSpeech: interrupt ?? true,
            silenceTimeoutMs: silenceTimeoutMs,
            speechLocaleID: speechLocaleID,
            apiKey: resolvedApiKey,
            referenceAudioPath: referenceAudioPath?.isEmpty == false ? referenceAudioPath : nil,
            referenceText: referenceText?.isEmpty == false ? referenceText : nil,
            seamColorHex: rawSeam.isEmpty ? nil : rawSeam,
            realtimeProvider: realtimeProvider,
            realtimeModelId: realtimeModelId,
            realtimeSpeakerVoice: realtimeSpeakerVoice,
            realtimeMode: realtimeMode,
            realtimeTransport: realtimeTransport,
            realtimeBrain: realtimeBrain)
    }

    static func fallback(
        defaultModelIdFallback: String,
        defaultSilenceTimeoutMs: Int,
        envVoice: String?,
        sagVoice: String?,
        envApiKey: String?) -> TalkModeGatewayConfigState
    {
        let resolvedVoice =
            (envVoice?.isEmpty == false ? envVoice : nil) ??
            (sagVoice?.isEmpty == false ? sagVoice : nil)
        let resolvedApiKey = envApiKey?.isEmpty == false ? envApiKey : nil

        return TalkModeGatewayConfigState(
            activeProvider: "elevenlabs",
            normalizedPayload: false,
            missingResolvedPayload: false,
            voiceId: resolvedVoice,
            voiceAliases: [:],
            modelId: defaultModelIdFallback,
            outputFormat: nil,
            interruptOnSpeech: true,
            silenceTimeoutMs: defaultSilenceTimeoutMs,
            speechLocaleID: nil,
            apiKey: resolvedApiKey,
            referenceAudioPath: nil,
            referenceText: nil,
            seamColorHex: nil,
            realtimeProvider: nil,
            realtimeModelId: nil,
            realtimeSpeakerVoice: nil,
            realtimeMode: nil,
            realtimeTransport: nil,
            realtimeBrain: nil)
    }
}
