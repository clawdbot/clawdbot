import AVFoundation
import Foundation

/// Enumerates and filters on-device AVSpeechSynthesisVoice entries so both platform apps
/// can offer a specific-voice picker instead of only a language lookup that always resolves
/// to Apple's undocumented per-language default and ignores downloaded Enhanced/Premium voices.
public enum TalkSystemVoiceCatalog {
    public enum QualityTier: Int, Comparable {
        case standard = 0
        case enhanced = 1
        case premium = 2

        public static func < (lhs: QualityTier, rhs: QualityTier) -> Bool {
            lhs.rawValue < rhs.rawValue
        }

        init(_ quality: AVSpeechSynthesisVoiceQuality) {
            switch quality {
            case .premium:
                self = .premium
            case .enhanced:
                self = .enhanced
            default:
                self = .standard
            }
        }
    }

    public struct Voice: Identifiable, Equatable {
        public let id: String
        public let name: String
        public let languageID: String
        public let quality: QualityTier

        public init(id: String, name: String, languageID: String, quality: QualityTier) {
            self.id = id
            self.name = name
            self.languageID = languageID
            self.quality = quality
        }
    }

    /// Voices actually installed on-device. There is no public API to enumerate voices that
    /// are downloadable but not yet installed; System Settings > Accessibility > Spoken Content
    /// > Voices is the only place to discover and download more.
    public static func availableVoices(
        rawVoices: [AVSpeechSynthesisVoice] = AVSpeechSynthesisVoice.speechVoices()) -> [Voice]
    {
        rawVoices
            .map { Voice(id: $0.identifier, name: $0.name, languageID: $0.language, quality: QualityTier($0.quality)) }
            .sorted { lhs, rhs in
                if lhs.quality != rhs.quality { return lhs.quality > rhs.quality }
                return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            }
    }

    /// Matches on language subtag only (e.g. "en-GB" selection still surfaces "en-US" voices),
    /// since Enhanced/Premium availability varies by region and a strict match would hide voices
    /// the user clearly wants to see. A nil languageID returns every voice.
    public static func voices(matchingLanguageID languageID: String?, in voices: [Voice]) -> [Voice] {
        guard let languageID else { return voices }
        let targetLanguage = Locale(identifier: languageID).language.languageCode?.identifier
        return voices.filter { voice in
            Locale(identifier: voice.languageID).language.languageCode?.identifier == targetLanguage
        }
    }

    public static func voice(identifier: String, in voices: [Voice]) -> Voice? {
        voices.first { $0.id == identifier }
    }

    /// Apple's own `.name` already ends with a localized quality suffix for most modern
    /// Enhanced/Premium voices (e.g. "Yuri (Enhanced)", "Милена (улучшенный)"), so appending
    /// our own suffix unconditionally would double it. Detect any trailing parenthetical
    /// rather than matching our own suffix text exactly, since Apple's wording varies by
    /// locale and doesn't necessarily match our (possibly untranslated) template.
    public static func label(for voice: Voice) -> String {
        switch voice.quality {
        case .premium where !self.hasTrailingParenthetical(voice.name):
            String(format: String(localized: "%@ (Premium)"), voice.name)
        case .enhanced where !self.hasTrailingParenthetical(voice.name):
            String(format: String(localized: "%@ (Enhanced)"), voice.name)
        default:
            voice.name
        }
    }

    private static func hasTrailingParenthetical(_ name: String) -> Bool {
        name.hasSuffix(")") && name.contains("(")
    }
}
