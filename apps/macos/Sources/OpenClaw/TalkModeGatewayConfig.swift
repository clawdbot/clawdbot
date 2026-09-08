import Foundation
import OpenClawKit

struct TalkModeGatewayConfigState {
    let snapshot: TalkConfigSnapshot
    let voiceId: String?
    let modelId: String?
    let outputFormat: String?
    let apiKey: String?
    let referenceAudioPath: String?
    let referenceText: String?
    let seamColorHex: String?

    var interruptOnSpeech: Bool {
        self.snapshot.interruptOnSpeech ?? true
    }

    var hasGatewayRealtimeRelayTuple: Bool {
        self.snapshot.realtime.mode == "realtime" &&
            self.snapshot.realtime.transport == "gateway-relay" &&
            self.snapshot.realtime.brain == "agent-consult"
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
        let common = TalkConfigSnapshot(
            talk, defaultProvider: defaultProvider, defaultSilenceTimeoutMs: defaultSilenceTimeoutMs)
        let activeProvider = common.activeProvider
        let activeConfig = common.providerConfig
        let ui = snapshot.config?["ui"]?.dictionaryValue
        let rawSeam = ui?["seamColor"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let voice = activeConfig?["voiceId"]?.stringValue
        let model = activeConfig?["modelId"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedModel: String? = if model?.isEmpty == false {
            model!
        } else if activeProvider == defaultProvider {
            defaultModelIdFallback
        } else {
            nil
        }
        let outputFormat = activeConfig?["outputFormat"]?.stringValue
        let apiKey = activeConfig?["apiKey"]?.stringValue
        let referenceAudioPath = activeConfig?["referenceAudioPath"]?.stringValue?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let referenceText = activeConfig?["referenceText"]?.stringValue?
            .trimmingCharacters(in: .whitespacesAndNewlines)
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
            snapshot: common,
            voiceId: resolvedVoice,
            modelId: resolvedModel,
            outputFormat: outputFormat,
            apiKey: resolvedApiKey,
            referenceAudioPath: referenceAudioPath?.isEmpty == false ? referenceAudioPath : nil,
            referenceText: referenceText?.isEmpty == false ? referenceText : nil,
            seamColorHex: rawSeam.isEmpty ? nil : rawSeam)
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
            snapshot: TalkConfigSnapshot(
                nil, defaultProvider: "elevenlabs", defaultSilenceTimeoutMs: defaultSilenceTimeoutMs),
            voiceId: resolvedVoice,
            modelId: defaultModelIdFallback,
            outputFormat: nil,
            apiKey: resolvedApiKey,
            referenceAudioPath: nil,
            referenceText: nil,
            seamColorHex: nil)
    }
}
