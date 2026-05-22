import Foundation
import OpenClawKit

enum TalkModeExecutionMode {
    case native
    case realtimeRelay
}

enum TalkModeProviderSelection: String, CaseIterable, Identifiable {
    case gatewayDefault = "gateway"
    case nativeElevenLabs = "elevenlabs"
    case openAIRealtime = "openai-realtime"

    static let storageKey = "talk.providerSelection"

    var id: String {
        self.rawValue
    }

    var label: String {
        switch self {
        case .gatewayDefault:
            "Gateway Default"
        case .nativeElevenLabs:
            "ElevenLabs"
        case .openAIRealtime:
            "Realtime-2 (OpenAI)"
        }
    }

    static func resolved(_ raw: String?) -> TalkModeProviderSelection {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return TalkModeProviderSelection(rawValue: trimmed) ?? .gatewayDefault
    }
}

enum TalkModeRealtimeVoiceSelection {
    static let storageKey = "talk.realtime.voiceSelection"
    static let voices = [
        "alloy",
        "ash",
        "ballad",
        "coral",
        "echo",
        "sage",
        "shimmer",
        "verse",
        "marin",
        "cedar",
    ]

    static func resolvedOverride(_ raw: String?) -> String? {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !trimmed.isEmpty else { return nil }
        return Self.voices.contains(trimmed) ? trimmed : nil
    }

    static func label(for voice: String) -> String {
        voice.prefix(1).uppercased() + String(voice.dropFirst())
    }
}

struct TalkModeGatewayConfigState {
    let activeProvider: String
    let normalizedPayload: Bool
    let missingResolvedPayload: Bool
    let executionMode: TalkModeExecutionMode
    let defaultVoiceId: String?
    let voiceAliases: [String: String]
    let defaultModelId: String
    let defaultOutputFormat: String?
    let realtimeProvider: String?
    let realtimeModelId: String?
    let realtimeVoiceId: String?
    let rawConfigApiKey: String?
    let interruptOnSpeech: Bool?
    let silenceTimeoutMs: Int
    let speechLocaleID: String?
}

enum TalkModeGatewayConfigParser {
    static func parse(
        config: [String: Any],
        defaultProvider: String,
        defaultModelIdFallback: String,
        defaultRealtimeModelIdFallback: String,
        defaultSilenceTimeoutMs: Int) -> TalkModeGatewayConfigState
    {
        let talk = TalkConfigParsing.bridgeFoundationDictionary(config["talk"] as? [String: Any])
        let selection = TalkConfigParsing.selectProviderConfig(
            talk,
            defaultProvider: defaultProvider,
            allowLegacyFallback: false)
        let activeProvider = selection?.provider ?? defaultProvider
        let activeConfig = selection?.config
        let voiceAliases: [String: String]
        if let aliases = activeConfig?["voiceAliases"]?.dictionaryValue {
            var resolved: [String: String] = [:]
            for (key, value) in aliases {
                guard let id = value.stringValue else { continue }
                let normalizedKey = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                let trimmedId = id.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !normalizedKey.isEmpty, !trimmedId.isEmpty else { continue }
                resolved[normalizedKey] = trimmedId
            }
            voiceAliases = resolved
        } else {
            voiceAliases = [:]
        }
        let model = Self.firstString(activeConfig, keys: ["modelId", "model"])
        let defaultModelId = (model?.isEmpty == false) ? model! : defaultModelIdFallback
        let defaultVoiceId = Self.firstString(activeConfig, keys: ["voiceId", "voice"])
        let defaultOutputFormat = Self.firstString(activeConfig, keys: ["outputFormat"])
        let realtime = talk?["realtime"]?.dictionaryValue
        let realtimeProvider = Self.firstString(realtime, keys: ["provider"])
        let realtimeProviders = realtime?["providers"]?.dictionaryValue
        let realtimeProviderConfig = Self.realtimeProviderConfig(
            providers: realtimeProviders,
            provider: realtimeProvider)
        let realtimeModel = Self.firstString(realtime, keys: ["model"])
            ?? Self.firstString(realtimeProviderConfig, keys: ["model"])
        let realtimeModelId = realtimeModel ?? defaultRealtimeModelIdFallback
        let realtimeVoiceId = Self.firstString(realtime, keys: ["voice"])
            ?? Self.firstString(realtimeProviderConfig, keys: ["voice"])
        let executionMode = Self.resolvedExecutionMode(realtime)
        let rawConfigApiKey = activeConfig?["apiKey"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
        let interruptOnSpeech = talk?["interruptOnSpeech"]?.boolValue
        let silenceTimeoutMs = TalkConfigParsing.resolvedSilenceTimeoutMs(
            talk,
            fallback: defaultSilenceTimeoutMs)
        let speechLocaleID = TalkConfigParsing.resolvedSpeechLocaleID(talk)

        return TalkModeGatewayConfigState(
            activeProvider: activeProvider,
            normalizedPayload: selection?.normalizedPayload == true,
            missingResolvedPayload: talk != nil && selection == nil,
            executionMode: executionMode,
            defaultVoiceId: defaultVoiceId,
            voiceAliases: voiceAliases,
            defaultModelId: defaultModelId,
            defaultOutputFormat: defaultOutputFormat,
            realtimeProvider: realtimeProvider,
            realtimeModelId: realtimeModelId,
            realtimeVoiceId: realtimeVoiceId,
            rawConfigApiKey: rawConfigApiKey,
            interruptOnSpeech: interruptOnSpeech,
            silenceTimeoutMs: silenceTimeoutMs,
            speechLocaleID: speechLocaleID)
    }

    private static func firstString(_ config: [String: AnyCodable]?, keys: [String]) -> String? {
        guard let config else { return nil }
        for key in keys {
            let value = config[key]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
            if value?.isEmpty == false {
                return value
            }
        }
        return nil
    }

    private static func resolvedExecutionMode(_ realtime: [String: AnyCodable]?) -> TalkModeExecutionMode {
        guard let realtime else { return .native }
        let mode = Self.firstString(realtime, keys: ["mode"])?.lowercased()
        let transport = Self.firstString(realtime, keys: ["transport"])?.lowercased()
        let brain = Self.firstString(realtime, keys: ["brain"])?.lowercased()
        if mode == "realtime", transport == "gateway-relay", brain == nil || brain == "agent-consult" {
            return .realtimeRelay
        }
        return .native
    }

    private static func realtimeProviderConfig(
        providers: [String: AnyCodable]?,
        provider: String?) -> [String: AnyCodable]?
    {
        guard let providers else { return nil }
        if let provider {
            return providers[provider]?.dictionaryValue
        }
        if providers.count == 1 {
            return providers.values.first?.dictionaryValue
        }
        return nil
    }
}
