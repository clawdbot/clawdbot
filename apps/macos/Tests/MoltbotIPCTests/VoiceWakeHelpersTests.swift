import Testing
@testable import Moltbot

struct VoiceWakeHelpersTests {
    @Test func sanitizeTriggersTrimsAndDropsEmpty() {
        let cleaned = sanitizeVoiceWakeTriggers(["  hi  ", " ", "\n", "there"])
        #expect(cleaned == ["hi", "there"])
    }

    @Test func sanitizeTriggersFallsBackToDefaults() {
        let cleaned = sanitizeVoiceWakeTriggers(["   ", ""])
        #expect(cleaned == defaultVoiceWakeTriggers)
    }

    @Test func sanitizeTriggersLimitsWordLength() {
        let long = String(repeating: "x", count: voiceWakeMaxWordLength + 5)
        let cleaned = sanitizeVoiceWakeTriggers(["ok", long])
        #expect(cleaned[1].count == voiceWakeMaxWordLength)
    }

    @Test func sanitizeTriggersLimitsWordCount() {
        let words = (1...voiceWakeMaxWords + 3).map { "w\($0)" }
        let cleaned = sanitizeVoiceWakeTriggers(words)
        #expect(cleaned.count == voiceWakeMaxWords)
    }

    @Test func normalizeLocaleStripsCollation() {
        #expect(normalizeLocaleIdentifier("en_US@collation=phonebook") == "en_US")
    }

    @Test func normalizeLocaleStripsUnicodeExtensions() {
        #expect(normalizeLocaleIdentifier("de-DE-u-co-phonebk") == "de-DE")
        #expect(normalizeLocaleIdentifier("ja-JP-t-ja") == "ja-JP")
    }
}
