import Foundation
import OpenClawKit

enum TalkModeExecutionMode {
    case native
    case realtimeClient
    case realtimeRelay
}

struct TalkRuntimeIssue: Equatable {
    enum Code: String {
        case realtimeUnavailable = "realtime_unavailable"
    }

    let code: Code
    let message: String
    let provider: String?
    let model: String?
    let transport: String?
    let phase: String?
    let occurredAt: Date

    init(
        code: Code,
        message: String,
        provider: String? = nil,
        model: String? = nil,
        transport: String? = nil,
        phase: String? = nil,
        occurredAt: Date = Date())
    {
        self.code = code
        self.message = message.trimmingCharacters(in: .whitespacesAndNewlines)
        self.provider = provider?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.model = model?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.transport = transport?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.phase = phase?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.occurredAt = occurredAt
    }

    var displayMessage: String {
        if !self.message.isEmpty { return self.message }
        return "Realtime voice did not start."
    }

    var fallbackStatusText: String {
        "Listening (iOS Speech fallback)"
    }

    var fallbackBannerTitle: String {
        "Using iOS Speech fallback"
    }

    var fallbackBannerOwnerLabel: String {
        "Fallback active"
    }

    var fallbackBannerMessage: String {
        "Realtime voice did not start. Talk is running with iOS speech recognition and TTS."
    }

    var technicalDetails: String {
        var lines = [
            "code: \(self.code.rawValue)",
            "message: \(self.displayMessage)",
        ]
        if let provider, !provider.isEmpty { lines.append("provider: \(provider)") }
        if let model, !model.isEmpty { lines.append("model: \(model)") }
        if let transport, !transport.isEmpty { lines.append("transport: \(transport)") }
        if let phase, !phase.isEmpty { lines.append("phase: \(phase)") }
        return lines.joined(separator: "\n")
    }

    var diagnosticSummary: String {
        var parts = [self.displayMessage]
        if let provider, !provider.isEmpty { parts.append("provider: \(provider)") }
        if let model, !model.isEmpty { parts.append("model: \(model)") }
        if let transport, !transport.isEmpty { parts.append("transport: \(transport)") }
        if let phase, !phase.isEmpty { parts.append("phase: \(phase)") }
        return parts.joined(separator: " • ")
    }

    static func realtimeUnavailable(
        message: String,
        provider: String? = nil,
        model: String? = nil,
        transport: String? = nil,
        phase: String? = nil) -> TalkRuntimeIssue
    {
        TalkRuntimeIssue(
            code: .realtimeUnavailable,
            message: message,
            provider: provider,
            model: model,
            transport: transport,
            phase: phase)
    }
}

struct TalkVoiceModeDescriptor: Equatable {
    let title: String
    let subtitle: String?
    let providerId: String?
    let modelId: String?
    let voiceId: String?
    let transport: String?
    let isRealtime: Bool

    var accessibilityValue: String {
        if let subtitle, !subtitle.isEmpty {
            return "\(self.title), \(subtitle)"
        }
        return self.title
    }
}

enum TalkVoiceModeDescriptorBuilder {
    static func build(
        providerId: String,
        providerLabel: String,
        modelId: String?,
        voiceId: String?,
        transport: String?,
        isRealtime: Bool) -> TalkVoiceModeDescriptor
    {
        let normalizedProvider = providerId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let trimmedModel = Self.trimmed(modelId)
        let trimmedVoice = Self.trimmed(voiceId)
        let trimmedTransport = Self.trimmed(transport)
        let title = if isRealtime, normalizedProvider == "openai", trimmedModel == "gpt-realtime-2" {
            "GPT Realtime 2.0"
        } else if isRealtime, normalizedProvider == "openai" {
            "OpenAI Realtime"
        } else if isRealtime {
            providerLabel.isEmpty ? "Realtime Voice" : providerLabel
        } else if normalizedProvider == "system" {
            "iOS System Voice"
        } else {
            providerLabel.isEmpty ? "Talk Voice" : providerLabel
        }

        var details: [String] = []
        if isRealtime, normalizedProvider != "openai", !providerLabel.isEmpty, providerLabel != title {
            details.append(providerLabel)
        }
        if let trimmedTransport {
            details.append(Self.transportLabel(trimmedTransport))
        }
        if let trimmedModel, title != "GPT Realtime 2.0" || trimmedModel != "gpt-realtime-2" {
            details.append(trimmedModel)
        }
        if let trimmedVoice {
            details.append(Self.voiceLabel(trimmedVoice))
        }

        return TalkVoiceModeDescriptor(
            title: title,
            subtitle: details.isEmpty ? nil : details.joined(separator: " • "),
            providerId: normalizedProvider.isEmpty ? nil : normalizedProvider,
            modelId: trimmedModel,
            voiceId: trimmedVoice,
            transport: trimmedTransport,
            isRealtime: isRealtime)
    }

    private static func trimmed(_ value: String?) -> String? {
        let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func voiceLabel(_ voice: String) -> String {
        TalkModeRealtimeVoiceSelection.voices.contains(voice)
            ? TalkModeRealtimeVoiceSelection.label(for: voice)
            : voice
    }

    private static func transportLabel(_ transport: String) -> String {
        switch transport.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "webrtc":
            "Native WebRTC"
        case "gateway-relay":
            "Gateway Relay"
        case "provider-websocket":
            "Provider WebSocket"
        case "managed-room":
            "Managed Room"
        case "native":
            "Native"
        case let value where !value.isEmpty:
            value
        default:
            "Native"
        }
    }
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
        let realtimeProviders = realtime?["providers"]?.dictionaryValue
        let realtimeProvider = Self.firstString(realtime, keys: ["provider"])
            ?? Self.singleRealtimeProviderId(realtimeProviders)
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
        guard mode == "realtime" else {
            return .native
        }
        if transport == "managed-room" {
            return .native
        }
        if brain != nil, brain != "agent-consult" {
            return .native
        }
        return .realtimeRelay
    }

    private static func singleRealtimeProviderId(_ providers: [String: AnyCodable]?) -> String? {
        guard let providers, providers.count == 1 else { return nil }
        let provider = providers.keys.first?.trimmingCharacters(in: .whitespacesAndNewlines)
        return provider?.isEmpty == false ? provider : nil
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
