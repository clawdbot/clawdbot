import Foundation
import Speech

struct SpeechRecognizerCache {
    private var cached: SFSpeechRecognizer?

    mutating func recognizer(localeID: String?) -> SFSpeechRecognizer? {
        // Reuse explicit locale matches only: automatic or fallback dictation languages can change.
        guard let localeID else { return SFSpeechRecognizer() }
        let locale = Locale(identifier: localeID)
        if self.cached?.locale != locale {
            self.cached = SFSpeechRecognizer(locale: locale)
        }
        return self.cached
    }
}
