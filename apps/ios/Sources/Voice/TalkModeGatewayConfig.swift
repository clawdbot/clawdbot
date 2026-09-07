import Foundation
import OpenClawKit

enum TalkModeExecutionMode: Equatable {
    case native
    case realtimeWebRTC
    case realtimeRelay
}

struct TalkRuntimeIssue: Equatable {
    enum Code: String {
        case audioInputUnavailable = "audio_input_unavailable"
        case realtimeOutputCancelFailed = "realtime_output_cancel_failed"
        case realtimeUnavailable = "realtime_unavailable"
    }

    let code: Code
    let message: String
    let provider: String?
    let model: String?
    let transport: String?
    let phase: String?

    init(
        code: Code,
        message: String,
        provider: String? = nil,
        model: String? = nil,
        transport: String? = nil,
        phase: String? = nil)
    {
        self.code = code
        self.message = message.trimmingCharacters(in: .whitespacesAndNewlines)
        self.provider = provider?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.model = model?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.transport = transport?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.phase = phase?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var displayMessage: String {
        if !self.message.isEmpty { return self.message }
        return String(localized: "Realtime voice did not start.")
    }

    var fallbackStatusText: String {
        String(localized: "Listening (iOS Speech fallback)")
    }

    var diagnosticSummary: String {
        var parts = [displayMessage]
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
        switch voice {
        case "alloy", "ash", "ballad", "cedar", "coral", "echo", "marin", "sage", "shimmer", "verse":
            voice.prefix(1).uppercased() + String(voice.dropFirst())
        default:
            voice
        }
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

enum TalkModeRuntimeRoute: Equatable {
    case localElevenLabs
    case gatewayTalkSpeak
    case realtimeWebRTC
    case realtimeRelay

    var usesRealtime: Bool {
        self == .realtimeRelay || self == .realtimeWebRTC
    }

    var usesGatewayTalkSpeak: Bool {
        self == .gatewayTalkSpeak
    }

    var gatewayOwnsCredentials: Bool {
        self != .localElevenLabs
    }
}

struct TalkModeResolvedRouting: Equatable {
    let activeProvider: String
    let executionMode: TalkModeExecutionMode
    let realtimeProvider: String?
    let realtimeModelId: String?
    let route: TalkModeRuntimeRoute
}

enum TalkModeRoutingResolver {
    static func resolve(
        parsed: TalkModeGatewayConfigState,
        defaultProvider: String) -> TalkModeResolvedRouting
    {
        let route: TalkModeRuntimeRoute
            // Only explicit Gateway realtime config selects a realtime transport. Other
            // speech providers synthesize through talk.speak, except the shipped local ElevenLabs path.
            = if parsed.executionMode == .realtimeWebRTC
        {
            .realtimeWebRTC
        } else if parsed.executionMode == .realtimeRelay {
            .realtimeRelay
        } else if Self.normalized(parsed.snapshot.activeProvider) == Self.normalized(defaultProvider) {
            .localElevenLabs
        } else {
            .gatewayTalkSpeak
        }

        return TalkModeResolvedRouting(
            activeProvider: parsed.snapshot.activeProvider,
            executionMode: Self.executionMode(for: route),
            realtimeProvider: parsed.snapshot.realtime.provider,
            realtimeModelId: parsed.realtimeModelId,
            route: route)
    }

    private static func executionMode(for route: TalkModeRuntimeRoute) -> TalkModeExecutionMode {
        switch route {
        case .localElevenLabs, .gatewayTalkSpeak:
            .native
        case .realtimeWebRTC:
            .realtimeWebRTC
        case .realtimeRelay:
            .realtimeRelay
        }
    }

    private static func normalized(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

struct TalkModeGatewayConfigState {
    let snapshot: TalkConfigSnapshot
    let executionMode: TalkModeExecutionMode
    let requiresGatewayRealtimeTransport: Bool
    let defaultVoiceId: String?
    let configuredModelId: String?
    let defaultModelId: String
    let defaultOutputFormat: String?
    let realtimeModelId: String?
    let rawConfigApiKey: String?
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
        let snapshot = TalkConfigSnapshot(
            talk,
            defaultProvider: defaultProvider,
            defaultSilenceTimeoutMs: defaultSilenceTimeoutMs,
            allowLegacyFallback: false)
        let activeConfig = snapshot.providerConfig
        let model = TalkConfigParsing.firstNonEmptyString(activeConfig, keys: ["modelId", "model"])
        let defaultModelId = (model?.isEmpty == false) ? model! : defaultModelIdFallback
        let defaultVoiceId = TalkConfigParsing.firstNonEmptyString(activeConfig, keys: ["voiceId", "voice"])
        let defaultOutputFormat = TalkConfigParsing.firstNonEmptyString(activeConfig, keys: ["outputFormat"])
        let realtime = snapshot.realtime
        let realtimeClientHints = TalkConfigParsing.bridgeFoundationDictionary(
            (config["clientHints"] as? [String: Any])?["realtime"] as? [String: Any])
        let gatewayOwnsRealtimeModel =
            TalkConfigParsing.firstNonEmptyString(realtimeClientHints, keys: ["modelSource"]) == "gateway"
        let realtimeModelId = gatewayOwnsRealtimeModel
            ? realtime.modelId
            : (realtime.modelId ?? defaultRealtimeModelIdFallback)
        // Direct provider WebRTC can answer before consulting the agent, so this explicit
        // policy must stay on the relay that enforces final-transcript consultations.
        let requiresForcedAgentConsultRelay = realtime.consultRouting == "force-agent-consult"
        let requiresGatewayRealtimeTransport = requiresForcedAgentConsultRelay
            || realtime.transport == "gateway-relay"
            || realtime.transport == "provider-websocket"
            || Self.usesAzureOpenAI(provider: realtime.provider, config: realtime.providerConfig)
        let executionMode = Self.resolvedExecutionMode(
            realtime,
            requiresGatewayRealtimeTransport: requiresGatewayRealtimeTransport)
        let rawConfigApiKey = activeConfig?["apiKey"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)

        return TalkModeGatewayConfigState(
            snapshot: snapshot,
            executionMode: executionMode,
            requiresGatewayRealtimeTransport: requiresGatewayRealtimeTransport,
            defaultVoiceId: defaultVoiceId,
            configuredModelId: model,
            defaultModelId: defaultModelId,
            defaultOutputFormat: defaultOutputFormat,
            realtimeModelId: realtimeModelId,
            rawConfigApiKey: rawConfigApiKey)
    }

    private static func resolvedExecutionMode(
        _ realtime: TalkRealtimeConfigSnapshot,
        requiresGatewayRealtimeTransport: Bool) -> TalkModeExecutionMode
    {
        guard realtime.mode == "realtime" else { return .native }
        if realtime.brain != nil, realtime.brain != "agent-consult" {
            return .native
        }
        if requiresGatewayRealtimeTransport {
            return .realtimeRelay
        }
        switch realtime.transport {
        case "managed-room":
            return .native
        case "gateway-relay":
            return .realtimeRelay
        case "provider-websocket":
            return .realtimeRelay
        case "webrtc":
            if realtime.provider?.lowercased() != "openai" {
                return .realtimeRelay
            }
        case nil:
            if realtime.provider?.lowercased() != "openai" {
                return .realtimeRelay
            }
        default:
            return .realtimeRelay
        }
        return .realtimeWebRTC
    }

    private static func usesAzureOpenAI(
        provider: String?,
        config: [String: AnyCodable]?) -> Bool
    {
        guard provider?.caseInsensitiveCompare("openai") == .orderedSame else { return false }
        return TalkConfigParsing.firstNonEmptyString(config, keys: ["azureEndpoint", "azureDeployment"]) != nil
    }
}
