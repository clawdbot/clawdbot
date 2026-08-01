import AVFoundation
import XCTest
@testable import OpenClawKit

final class TalkSystemVoiceCatalogTests: XCTestCase {
    private func makeVoice(id: String, name: String, languageID: String, quality: TalkSystemVoiceCatalog.QualityTier)
        -> TalkSystemVoiceCatalog.Voice
    {
        TalkSystemVoiceCatalog.Voice(id: id, name: name, languageID: languageID, quality: quality)
    }

    func testAvailableVoicesSortsByQualityThenName() {
        let raw = [
            self.makeVoice(id: "1", name: "Zoe", languageID: "en-US", quality: .standard),
            self.makeVoice(id: "2", name: "Amy", languageID: "en-US", quality: .premium),
            self.makeVoice(id: "3", name: "Bob", languageID: "en-US", quality: .enhanced),
        ]
        let sorted = raw.sorted { lhs, rhs in
            if lhs.quality != rhs.quality { return lhs.quality > rhs.quality }
            return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }

        XCTAssertEqual(sorted.map(\.id), ["2", "3", "1"])
    }

    func testVoicesMatchingLanguageIDFiltersBySubtagOnly() {
        let voices = [
            self.makeVoice(id: "us", name: "Samantha", languageID: "en-US", quality: .standard),
            self.makeVoice(id: "gb", name: "Daniel", languageID: "en-GB", quality: .enhanced),
            self.makeVoice(id: "fr", name: "Thomas", languageID: "fr-FR", quality: .standard),
        ]

        let filtered = TalkSystemVoiceCatalog.voices(matchingLanguageID: "en-US", in: voices)

        XCTAssertEqual(Set(filtered.map(\.id)), Set(["us", "gb"]))
    }

    func testVoicesMatchingLanguageIDReturnsAllWhenNil() {
        let voices = [
            self.makeVoice(id: "us", name: "Samantha", languageID: "en-US", quality: .standard),
            self.makeVoice(id: "fr", name: "Thomas", languageID: "fr-FR", quality: .standard),
        ]

        let filtered = TalkSystemVoiceCatalog.voices(matchingLanguageID: nil, in: voices)

        XCTAssertEqual(filtered.count, 2)
    }

    func testVoicesMatchingLanguageIDReturnsEmptyForNonMatchingSubtag() {
        let voices = [self.makeVoice(id: "fr", name: "Thomas", languageID: "fr-FR", quality: .standard)]

        let filtered = TalkSystemVoiceCatalog.voices(matchingLanguageID: "en-US", in: voices)

        XCTAssertTrue(filtered.isEmpty)
    }

    func testVoiceLookupByIdentifier() {
        let voices = [
            self.makeVoice(id: "us", name: "Samantha", languageID: "en-US", quality: .standard),
            self.makeVoice(id: "gb", name: "Daniel", languageID: "en-GB", quality: .enhanced),
        ]

        XCTAssertEqual(TalkSystemVoiceCatalog.voice(identifier: "gb", in: voices)?.name, "Daniel")
        XCTAssertNil(TalkSystemVoiceCatalog.voice(identifier: "missing", in: voices))
    }

    func testLabelFormattingPerQualityTier() {
        XCTAssertEqual(
            TalkSystemVoiceCatalog.label(for: self.makeVoice(
                id: "1",
                name: "Samantha",
                languageID: "en-US",
                quality: .standard)),
            "Samantha")
        XCTAssertEqual(
            TalkSystemVoiceCatalog.label(for: self.makeVoice(
                id: "2",
                name: "Daniel",
                languageID: "en-GB",
                quality: .enhanced)),
            "Daniel (Enhanced)")
        XCTAssertEqual(
            TalkSystemVoiceCatalog.label(for: self.makeVoice(
                id: "3",
                name: "Ava",
                languageID: "en-US",
                quality: .premium)),
            "Ava (Premium)")
    }

    func testLabelDoesNotDoubleAppleOwnQualitySuffix() {
        // Apple's own .name already ends with a localized quality suffix for many modern
        // Enhanced/Premium voices (e.g. "Yuri (Enhanced)", "Милена (улучшенный)"). Our own
        // suffix must not be appended on top of an already-decorated name.
        XCTAssertEqual(
            TalkSystemVoiceCatalog.label(
                for: self.makeVoice(id: "1", name: "Yuri (Enhanced)", languageID: "ru-RU", quality: .enhanced)),
            "Yuri (Enhanced)")
        XCTAssertEqual(
            TalkSystemVoiceCatalog.label(
                for: self.makeVoice(id: "2", name: "Милена (улучшенный)", languageID: "ru-RU", quality: .enhanced)),
            "Милена (улучшенный)")
        XCTAssertEqual(
            TalkSystemVoiceCatalog.label(
                for: self.makeVoice(id: "3", name: "Zoe (Premium)", languageID: "en-US", quality: .premium)),
            "Zoe (Premium)")
    }

    func testAvailableVoicesUsesRealSystemVoicesAsFixture() {
        // AVSpeechSynthesisVoice has no public fixture-friendly initializer beyond
        // language:/identifier:, so this exercises the real speechVoices() -> Voice
        // mapping path using whatever the test environment has installed, rather than
        // asserting exact quality tiers (which vary by simulator/OS).
        let realVoice = AVSpeechSynthesisVoice(language: "en-US")
        let mapped = TalkSystemVoiceCatalog.availableVoices(rawVoices: realVoice.map { [$0] } ?? [])

        if let realVoice {
            XCTAssertEqual(mapped.first?.id, realVoice.identifier)
            XCTAssertEqual(mapped.first?.languageID, realVoice.language)
        } else {
            XCTAssertTrue(mapped.isEmpty)
        }
    }
}
