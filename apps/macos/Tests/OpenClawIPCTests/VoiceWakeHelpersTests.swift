import Testing
@testable import OpenClaw

struct VoiceWakeHelpersTests {
    @Test func `sanitize triggers trims and drops empty`() {
        let cleaned = sanitizeVoiceWakeTriggers(["  hi  ", " ", "\n", "there"])
        #expect(cleaned == ["hi", "there"])
    }

    @Test func `sanitize triggers falls back to defaults`() {
        let cleaned = sanitizeVoiceWakeTriggers(["   ", ""])
        #expect(cleaned == defaultVoiceWakeTriggers)
    }

    @Test func `sanitize triggers limits word length`() {
        let long = String(repeating: "x", count: voiceWakeMaxWordLength + 5)
        let cleaned = sanitizeVoiceWakeTriggers(["ok", long])
        #expect(cleaned[1].count == voiceWakeMaxWordLength)
    }

    @Test func `sanitize triggers limits word count`() {
        let words = (1...voiceWakeMaxWords + 3).map { "w\($0)" }
        let cleaned = sanitizeVoiceWakeTriggers(words)
        #expect(cleaned.count == voiceWakeMaxWords)
    }

    @Test func `normalize locale strips collation`() {
        #expect(normalizeLocaleIdentifier("en_US@collation=phonebook") == "en_US")
    }

    @Test func `normalize locale strips unicode extensions`() {
        #expect(normalizeLocaleIdentifier("de-DE-u-co-phonebk") == "de-DE")
        #expect(normalizeLocaleIdentifier("ja-JP-t-ja") == "ja-JP")
    }
}
