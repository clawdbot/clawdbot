import Foundation

public struct TalkDirective: Equatable, Sendable {
    public var voiceId: String?
    public var modelId: String?
    public var speed: Double?
    public var rateWPM: Int?
    public var stability: Double?
    public var similarity: Double?
    public var style: Double?
    public var speakerBoost: Bool?
    public var seed: Int?
    public var normalize: String?
    public var language: String?
    public var outputFormat: String?
    public var latencyTier: Int?
    public var once: Bool?

    public init(
        voiceId: String? = nil,
        modelId: String? = nil,
        speed: Double? = nil,
        rateWPM: Int? = nil,
        stability: Double? = nil,
        similarity: Double? = nil,
        style: Double? = nil,
        speakerBoost: Bool? = nil,
        seed: Int? = nil,
        normalize: String? = nil,
        language: String? = nil,
        outputFormat: String? = nil,
        latencyTier: Int? = nil,
        once: Bool? = nil)
    {
        self.voiceId = voiceId
        self.modelId = modelId
        self.speed = speed
        self.rateWPM = rateWPM
        self.stability = stability
        self.similarity = similarity
        self.style = style
        self.speakerBoost = speakerBoost
        self.seed = seed
        self.normalize = normalize
        self.language = language
        self.outputFormat = outputFormat
        self.latencyTier = latencyTier
        self.once = once
    }
}

public struct TalkDirectiveParseResult: Equatable, Sendable {
    public let directive: TalkDirective?
    public let stripped: String
    public let unknownKeys: [String]

    public init(directive: TalkDirective?, stripped: String, unknownKeys: [String]) {
        self.directive = directive
        self.stripped = stripped
        self.unknownKeys = unknownKeys
    }
}

public enum TalkDirectiveParser {
    public static func parse(_ text: String) -> TalkDirectiveParseResult {
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
        var lines = normalized.split(separator: "\n", omittingEmptySubsequences: false)
        guard !lines.isEmpty else { return TalkDirectiveParseResult(directive: nil, stripped: text, unknownKeys: []) }

        guard let firstNonEmptyIndex =
            lines.firstIndex(where: { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
        else {
            return TalkDirectiveParseResult(directive: nil, stripped: text, unknownKeys: [])
        }

        var firstNonEmpty = firstNonEmptyIndex
        if firstNonEmpty > 0 {
            lines.removeSubrange(0..<firstNonEmpty)
            firstNonEmpty = 0
        }

        let head = lines[firstNonEmpty].trimmingCharacters(in: .whitespacesAndNewlines)
        guard head.hasPrefix("{"), head.hasSuffix("}") else {
            return TalkDirectiveParseResult(directive: nil, stripped: text, unknownKeys: [])
        }

        guard let data = head.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return TalkDirectiveParseResult(directive: nil, stripped: text, unknownKeys: [])
        }

        let speakerBoost = self.boolValue(json, keys: ["speaker_boost", "speakerBoost"])
            ?? self.boolValue(json, keys: ["no_speaker_boost", "noSpeakerBoost"]).map { !$0 }

        let directive = TalkDirective(
            voiceId: stringValue(json, keys: ["voice", "voice_id", "voiceId"]),
            modelId: stringValue(json, keys: ["model", "model_id", "modelId"]),
            speed: doubleValue(json, keys: ["speed"]),
            rateWPM: intValue(json, keys: ["rate", "wpm"]),
            stability: doubleValue(json, keys: ["stability"]),
            similarity: doubleValue(json, keys: ["similarity", "similarity_boost", "similarityBoost"]),
            style: doubleValue(json, keys: ["style"]),
            speakerBoost: speakerBoost,
            seed: intValue(json, keys: ["seed"]),
            normalize: stringValue(json, keys: ["normalize", "apply_text_normalization"]),
            language: stringValue(json, keys: ["lang", "language_code", "language"]),
            outputFormat: stringValue(json, keys: ["output_format", "format"]),
            latencyTier: intValue(json, keys: ["latency", "latency_tier", "latencyTier"]),
            once: boolValue(json, keys: ["once"]))

        let hasDirective = [
            directive.voiceId,
            directive.modelId,
            directive.speed.map { "\($0)" },
            directive.rateWPM.map { "\($0)" },
            directive.stability.map { "\($0)" },
            directive.similarity.map { "\($0)" },
            directive.style.map { "\($0)" },
            directive.speakerBoost.map { "\($0)" },
            directive.seed.map { "\($0)" },
            directive.normalize,
            directive.language,
            directive.outputFormat,
            directive.latencyTier.map { "\($0)" },
            directive.once.map { "\($0)" },
        ].contains { $0 != nil }

        guard hasDirective else {
            return TalkDirectiveParseResult(directive: nil, stripped: text, unknownKeys: [])
        }

        let knownKeys = Set([
            "voice", "voice_id", "voiceid",
            "model", "model_id", "modelid",
            "speed", "rate", "wpm",
            "stability", "similarity", "similarity_boost", "similarityboost",
            "style",
            "speaker_boost", "speakerboost",
            "no_speaker_boost", "nospeakerboost",
            "seed",
            "normalize", "apply_text_normalization",
            "lang", "language_code", "language",
            "output_format", "format",
            "latency", "latency_tier", "latencytier",
            "once",
        ])
        let unknownKeys = json.keys.filter { !knownKeys.contains($0.lowercased()) }.sorted()

        lines.remove(at: firstNonEmpty)
        if firstNonEmpty < lines.count {
            let next = lines[firstNonEmpty].trimmingCharacters(in: .whitespacesAndNewlines)
            if next.isEmpty {
                lines.remove(at: firstNonEmpty)
            }
        }

        let stripped = lines.joined(separator: "\n")
        return TalkDirectiveParseResult(directive: directive, stripped: stripped, unknownKeys: unknownKeys)
    }

    private static func stringValue(_ dict: [String: Any], keys: [String]) -> String? {
        for key in keys {
            if let value = dict[key] as? String {
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty { return trimmed }
            }
        }
        return nil
    }

    private static func doubleValue(_ dict: [String: Any], keys: [String]) -> Double? {
        for key in keys {
            if let value = dict[key] as? Double { return value }
            if let value = dict[key] as? Int { return Double(value) }
            if let value = dict[key] as? String, let parsed = Double(value) { return parsed }
        }
        return nil
    }

    private static func intValue(_ dict: [String: Any], keys: [String]) -> Int? {
        for key in keys {
            if let value = dict[key] as? Int { return value }
            if let value = dict[key] as? Double { return Int(value) }
            if let value = dict[key] as? String, let parsed = Int(value) { return parsed }
        }
        return nil
    }

    private static func boolValue(_ dict: [String: Any], keys: [String]) -> Bool? {
        for key in keys {
            if let value = dict[key] as? Bool { return value }
            if let value = dict[key] as? String {
                let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                if ["true", "yes", "1"].contains(trimmed) { return true }
                if ["false", "no", "0"].contains(trimmed) { return false }
            }
        }
        return nil
    }
}
