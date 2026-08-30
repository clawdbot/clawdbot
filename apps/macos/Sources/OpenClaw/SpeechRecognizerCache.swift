import Foundation
import Speech

/// Reuses one `SFSpeechRecognizer` per locale instead of constructing a new one
/// for every recognition session.
///
/// Each `SFSpeechRecognizer` opens its own XPC connection to the shared
/// `localspeechrecognition` service and subscribes that service to the
/// on-device speech assets. The service releases those subscriptions only when
/// its own max-interval cleanup timer fires, so constructing a recognizer per
/// session lets connections and asset subscriptions accumulate in a single
/// long-lived service process.
///
/// Deliberately not `Sendable`: `SFSpeechRecognizer` is not `Sendable`, so each
/// actor keeps its own cache rather than sharing a global instance.
struct SpeechRecognizerCache {
    private var recognizer: SFSpeechRecognizer?
    private var cachedLocaleID: String?

    /// Returns a recognizer for `localeID`, reusing the previous instance while
    /// the locale is unchanged. A `nil` `localeID` resolves to the current locale.
    ///
    /// A failed construction is not cached, so the next call retries.
    mutating func recognizer(localeID: String?) -> SFSpeechRecognizer? {
        let resolvedID = localeID ?? Locale.current.identifier
        if let recognizer = self.recognizer, self.cachedLocaleID == resolvedID {
            return recognizer
        }
        let created = SFSpeechRecognizer(locale: Locale(identifier: resolvedID))
        self.recognizer = created
        self.cachedLocaleID = created == nil ? nil : resolvedID
        return created
    }
}
