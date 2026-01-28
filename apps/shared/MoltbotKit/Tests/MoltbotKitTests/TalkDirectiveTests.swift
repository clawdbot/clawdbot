import XCTest
@testable import MoltbotKit

final class TalkDirectiveTests: XCTestCase {
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
