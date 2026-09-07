import Foundation

public struct TalkConfigSnapshot: Sendable {
    public let activeProvider: String
    public let providerConfig: [String: AnyCodable]?
    public let normalizedPayload: Bool
    public let missingResolvedPayload: Bool
    public let voiceAliases: [String: String]
    public let interruptOnSpeech: Bool?
    public let silenceTimeoutMs: Int
    public let speechLocaleID: String?
    public let realtime: TalkRealtimeConfigSnapshot

    public init(
        _ talk: [String: AnyCodable]?,
        defaultProvider: String,
        defaultSilenceTimeoutMs: Int,
        allowLegacyFallback: Bool = true)
    {
        let selection = TalkConfigParsing.selectProviderConfig(
            talk, defaultProvider: defaultProvider, allowLegacyFallback: allowLegacyFallback)
        self.activeProvider = selection?.provider ?? defaultProvider
        self.providerConfig = selection?.config
        self.normalizedPayload = selection?.normalizedPayload == true
        self.missingResolvedPayload = talk != nil && selection == nil
        self.voiceAliases = TalkVoiceAliases.normalizedMap(selection?.config["voiceAliases"])
        self.interruptOnSpeech = talk?["interruptOnSpeech"]?.boolValue
        self.silenceTimeoutMs = TalkConfigParsing.resolvedSilenceTimeoutMs(talk, fallback: defaultSilenceTimeoutMs)
        self.speechLocaleID = TalkConfigParsing.resolvedSpeechLocaleID(talk)
        self.realtime = TalkRealtimeConfigSnapshot(talk?["realtime"]?.dictionaryValue)
    }
}

public struct TalkRealtimeConfigSnapshot: Sendable {
    public let provider: String?
    public let providerConfig: [String: AnyCodable]?
    public let modelId: String?
    public let voice: String?
    public let speakerVoice: String?
    public let mode: String?
    public let transport: String?
    public let brain: String?
    public let consultRouting: String?

    init(_ realtime: [String: AnyCodable]?) {
        let providers = realtime?["providers"]?.dictionaryValue
        let provider = TalkConfigParsing.firstNonEmptyString(realtime, keys: ["provider"])
            ?? TalkConfigParsing.singleRealtimeProviderID(providers)
        let providerConfig = TalkConfigParsing.realtimeProviderConfig(providers: providers, provider: provider)
        self.provider = provider
        self.providerConfig = providerConfig
        self.modelId = TalkConfigParsing.firstNonEmptyString(realtime, keys: ["model"])
            ?? TalkConfigParsing.firstNonEmptyString(providerConfig, keys: ["model"])
        self.voice = TalkConfigParsing.firstNonEmptyString(realtime, keys: ["voice"])
            ?? TalkConfigParsing.firstNonEmptyString(providerConfig, keys: ["voice"])
        // macOS accepts speakerVoice; iOS consumes only voice. Keep both projections.
        self.speakerVoice = TalkConfigParsing.firstNonEmptyString(realtime, keys: ["speakerVoice", "voice"])
            ?? TalkConfigParsing.firstNonEmptyString(providerConfig, keys: ["speakerVoice", "voice"])
        self.mode = TalkConfigParsing.firstNonEmptyString(realtime, keys: ["mode"])?.lowercased()
        self.transport = TalkConfigParsing.firstNonEmptyString(realtime, keys: ["transport"])?.lowercased()
        self.brain = TalkConfigParsing.firstNonEmptyString(realtime, keys: ["brain"])?.lowercased()
        self.consultRouting = TalkConfigParsing.firstNonEmptyString(realtime, keys: ["consultRouting"])?.lowercased()
    }
}
