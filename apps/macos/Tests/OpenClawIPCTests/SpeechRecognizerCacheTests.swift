import Speech
import Testing
@testable import OpenClaw

struct SpeechRecognizerCacheTests {
    @Test func `repeated captures reuse one recognizer for the requested locale`() throws {
        let localeID = try #require(SFSpeechRecognizer.supportedLocales().first?.identifier)
        var cache = SpeechRecognizerCache()
        let initial = cache.recognizer(localeID: localeID)
        let first = try #require(initial)

        for _ in 0..<40 {
            #expect(cache.recognizer(localeID: localeID) === first)
        }
    }

    @Test func `changing language replaces the recognizer and retains the new selection`() throws {
        let localeIDs = SFSpeechRecognizer.supportedLocales().map(\.identifier).sorted()
        try #require(localeIDs.count >= 2)
        var cache = SpeechRecognizerCache()
        let initial = cache.recognizer(localeID: localeIDs[0])
        let first = try #require(initial)
        let changed = cache.recognizer(localeID: localeIDs[1])
        let second = try #require(changed)

        #expect(first !== second)
        #expect(second.locale.identifier == localeIDs[1])
        #expect(cache.recognizer(localeID: localeIDs[1]) === second)
    }

    @Test func `automatic selection is resolved afresh for each capture`() throws {
        let defaultRecognizer = try #require(SFSpeechRecognizer())
        var cache = SpeechRecognizerCache()
        let selected = cache.recognizer(localeID: defaultRecognizer.locale.identifier)
        let explicit = try #require(selected)
        let selectedDefault = cache.recognizer(localeID: nil)
        let automatic = try #require(selectedDefault)

        #expect(automatic !== explicit)
        #expect(automatic.locale == defaultRecognizer.locale)
        #expect(cache.recognizer(localeID: nil) !== automatic)
    }
}
