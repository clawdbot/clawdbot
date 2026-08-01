import Foundation
import OpenClawKit

extension AppState {
    /// Keeps a non-empty identifier only if it's installed and still matches `languageID`,
    /// otherwise System Default — the picker's own option list is locale-filtered too.
    static func resolvedSystemVoiceID(_ voiceID: String, matchingLanguageID languageID: String) -> String {
        guard !voiceID.isEmpty else { return voiceID }
        let candidates = TalkSystemVoiceCatalog.voices(
            matchingLanguageID: languageID,
            in: TalkSystemVoiceCatalog.availableVoices())
        return TalkSystemVoiceCatalog.voice(identifier: voiceID, in: candidates) != nil ? voiceID : ""
    }

    /// Persists an explicit `true` default the first time a preference is read so its stored
    /// value stays authoritative even if the compiled-in default ever changes later.
    static func loadDefaultingToTrue(key: String) -> Bool {
        if let stored = AppDefaults.standard.object(forKey: key) as? Bool {
            return stored
        }
        AppDefaults.standard.set(true, forKey: key)
        return true
    }
}
