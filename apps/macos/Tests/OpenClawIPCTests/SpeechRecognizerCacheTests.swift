import Speech
import Testing
@testable import OpenClaw

struct SpeechRecognizerCacheTests {
    private static func supportedLocaleIDs(_ count: Int) -> [String] {
        Array(SFSpeechRecognizer.supportedLocales().map(\.identifier).sorted().prefix(count))
    }

    @Test func `an unchanged locale reuses the same recognizer`() throws {
        let localeIDs = Self.supportedLocaleIDs(1)
        try #require(localeIDs.count == 1)
        var cache = SpeechRecognizerCache()

        let first = try #require(cache.recognizer(localeID: localeIDs[0]))
        let second = try #require(cache.recognizer(localeID: localeIDs[0]))

        #expect(first === second)
    }

    @Test func `a changed locale builds a new recognizer`() throws {
        let localeIDs = Self.supportedLocaleIDs(2)
        try #require(localeIDs.count == 2)
        var cache = SpeechRecognizerCache()

        let first = try #require(cache.recognizer(localeID: localeIDs[0]))
        let second = try #require(cache.recognizer(localeID: localeIDs[1]))

        #expect(first !== second)
    }

    @Test func `a nil locale resolves to the current locale and is reused`() throws {
        var cache = SpeechRecognizerCache()

        // Speech recognition need not support the host's current locale; when it
        // does not there is no instance to compare and the reuse claim is vacuous.
        guard let first = cache.recognizer(localeID: nil) else { return }
        let second = try #require(cache.recognizer(localeID: nil))

        #expect(first === second)
    }

    @Test func `an unsupported locale is not cached`() throws {
        let unsupportedID = "zz-ZZ"
        try #require(!SFSpeechRecognizer.supportedLocales().map(\.identifier).contains(unsupportedID))
        let localeIDs = Self.supportedLocaleIDs(1)
        try #require(localeIDs.count == 1)
        var cache = SpeechRecognizerCache()

        #expect(cache.recognizer(localeID: unsupportedID) == nil)
        // A failed construction must not poison the cache for a later valid locale.
        #expect(cache.recognizer(localeID: localeIDs[0]) != nil)
    }
}
