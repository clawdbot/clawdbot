import AVFoundation
import Foundation
import OpenClawKit

enum TalkSystemVoiceSelection {
    static let storageKey = "talk.systemVoiceSelection"

    /// A previously-picked voice the user later deletes must gracefully fall back to System
    /// Default rather than silently failing, since speechVoices() changes over time.
    static func resolvedOverride(
        _ raw: String?,
        isVoiceInstalled: (String) -> Bool = TalkSystemVoiceSelection.isInstalled) -> String?
    {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return isVoiceInstalled(trimmed) ? trimmed : nil
    }

    static func isInstalled(_ identifier: String) -> Bool {
        AVSpeechSynthesisVoice(identifier: identifier) != nil
    }

    /// The device-settings snapshot publishes voices filtered by the synthesis language, so
    /// isInstalled() alone isn't enough to validate an incoming pick: a voice that's still
    /// installed but no longer matches that language is absent from the published list and must
    /// resolve to System Default too. Validates membership in `allVoices` directly (rather than
    /// delegating to the installed-only overload) so callers can inject a fake catalog in tests
    /// without it being overridden by a real `AVSpeechSynthesisVoice` lookup.
    static func resolvedOverride(
        _ raw: String?,
        languageID: String?,
        allVoices: [TalkSystemVoiceCatalog.Voice] = TalkSystemVoiceCatalog.availableVoices()) -> String?
    {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let candidates = TalkSystemVoiceCatalog.voices(matchingLanguageID: languageID, in: allVoices)
        return TalkSystemVoiceCatalog.voice(identifier: trimmed, in: candidates) != nil ? trimmed : nil
    }

    static func label(
        for identifier: String,
        allVoices: [TalkSystemVoiceCatalog.Voice] = TalkSystemVoiceCatalog.availableVoices()) -> String?
    {
        TalkSystemVoiceCatalog.voice(identifier: identifier, in: allVoices).map(TalkSystemVoiceCatalog.label(for:))
    }
}
