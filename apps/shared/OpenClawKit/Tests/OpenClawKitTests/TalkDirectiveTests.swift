import Foundation
import XCTest
@testable import OpenClawKit

final class TalkDirectiveTests: XCTestCase {
    func testResolvesNormalizedVoiceAliases() {
        let aliases = TalkVoiceAliases.normalizedMap(AnyCodable([
            " Reader ": " Short-ID ", "longalias1": "mapped", "zero": "0",
            "blank": " ", " ": "ignored", "bool": false,
            "number": NSNumber(value: 0), "null": NSNull(),
        ]))

        XCTAssertEqual(aliases, ["reader": "Short-ID", "longalias1": "mapped", "zero": "0"])
        XCTAssertEqual(TalkVoiceAliases.resolve(" READER ", aliases: aliases), "Short-ID")
        XCTAssertEqual(TalkVoiceAliases.resolve("short-id", aliases: aliases), "short-id")
        XCTAssertEqual(TalkVoiceAliases.resolve("longalias1", aliases: aliases), "mapped")
        XCTAssertEqual(TalkVoiceAliases.resolve("abcdefghij", aliases: aliases), "abcdefghij")
        XCTAssertNil(TalkVoiceAliases.resolve("unknown", aliases: aliases))
        XCTAssertNil(TalkVoiceAliases.resolve(nil, aliases: aliases))
    }

    func testVoiceIDsPreserveUnicodeCharacterSemantics() {
        for voice in [
            "声声声声声声声声声声", "١٢٣٤٥٦٧٨٩٠", "abc_def-01",
            String(repeating: "e\u{301}", count: 10),
        ] {
            XCTAssertEqual(TalkVoiceAliases.resolve(voice, aliases: [:]), voice)
        }
        for voice in ["abcdefghi", String(repeating: "e\u{301}", count: 9), "abc def012", "😀😀😀😀😀😀😀😀😀😀"] {
            XCTAssertNil(TalkVoiceAliases.resolve(voice, aliases: [:]))
        }
    }

    func testParsesDirectiveAndStripsLine() {
        let text = """
        {"voice":"abc123","once":true}
        Hello there.
        """
        let result = TalkDirectiveParser.parse(text)
        XCTAssertEqual(result.directive?.voiceId, "abc123")
        XCTAssertEqual(result.directive?.once, true)
        XCTAssertEqual(result.stripped, "Hello there.")
    }

    func testIgnoresNonDirective() {
        let text = "Hello world."
        let result = TalkDirectiveParser.parse(text)
        XCTAssertNil(result.directive)
        XCTAssertEqual(result.stripped, text)
    }

    func testKeepsDirectiveLineIfNoRecognizedFields() {
        let text = """
        {"unknown":"value"}
        Hello.
        """
        let result = TalkDirectiveParser.parse(text)
        XCTAssertNil(result.directive)
        XCTAssertEqual(result.stripped, text)
    }

    func testParsesExtendedOptions() {
        let text = """
        {"voice_id":"v1","model_id":"m1","rate":200,"stability":0.5,"similarity":0.8,"style":0.2,"speaker_boost":true,"seed":1234,"normalize":"auto","lang":"en","output_format":"mp3_44100_128"}
        Hello.
        """
        let result = TalkDirectiveParser.parse(text)
        XCTAssertEqual(result.directive?.voiceId, "v1")
        XCTAssertEqual(result.directive?.modelId, "m1")
        XCTAssertEqual(result.directive?.rateWPM, 200)
        XCTAssertEqual(result.directive?.stability, 0.5)
        XCTAssertEqual(result.directive?.similarity, 0.8)
        XCTAssertEqual(result.directive?.style, 0.2)
        XCTAssertEqual(result.directive?.speakerBoost, true)
        XCTAssertEqual(result.directive?.seed, 1234)
        XCTAssertEqual(result.directive?.normalize, "auto")
        XCTAssertEqual(result.directive?.language, "en")
        XCTAssertEqual(result.directive?.outputFormat, "mp3_44100_128")
        XCTAssertEqual(result.stripped, "Hello.")
    }

    func testSkipsLeadingEmptyLinesWhenParsingDirective() {
        let text = """


        {"voice":"abc123"}
        Hello there.
        """
        let result = TalkDirectiveParser.parse(text)
        XCTAssertEqual(result.directive?.voiceId, "abc123")
        XCTAssertEqual(result.stripped, "Hello there.")
    }

    func testTracksUnknownKeys() {
        let text = """
        {"voice":"abc","mystery":"value","extra":1}
        Hi.
        """
        let result = TalkDirectiveParser.parse(text)
        XCTAssertEqual(result.directive?.voiceId, "abc")
        XCTAssertEqual(result.unknownKeys, ["extra", "mystery"])
    }
}
