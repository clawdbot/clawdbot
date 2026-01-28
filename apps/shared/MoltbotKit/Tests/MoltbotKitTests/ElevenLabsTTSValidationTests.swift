import XCTest
@testable import MoltbotKit

final class ElevenLabsTTSValidationTests: XCTestCase {
    func testValidatedOutputFormatAllowsOnlyMp3Presets() {
        XCTAssertEqual(ElevenLabsTTSClient.validatedOutputFormat("mp3_44100_128"), "mp3_44100_128")
        XCTAssertEqual(ElevenLabsTTSClient.validatedOutputFormat("pcm_16000"), "pcm_16000")
    }

    func testValidatedLanguageAcceptsTwoLetterCodes() {
        XCTAssertEqual(ElevenLabsTTSClient.validatedLanguage("EN"), "en")
        XCTAssertNil(ElevenLabsTTSClient.validatedLanguage("eng"))
    }

    func testValidatedNormalizeAcceptsKnownValues() {
        XCTAssertEqual(ElevenLabsTTSClient.validatedNormalize("AUTO"), "auto")
        XCTAssertNil(ElevenLabsTTSClient.validatedNormalize("maybe"))
    }
}
