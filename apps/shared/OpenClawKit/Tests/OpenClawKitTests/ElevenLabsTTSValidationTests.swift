#if Talk
import XCTest
@testable import OpenClawKit

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

    func testBuildsElevenLabsRequestFromResolvedOptions() {
        let directive = TalkDirective(
            modelId: "eleven_multilingual_v2",
            speed: 1.5,
            rateWPM: 175,
            stability: 0.7,
            similarity: -0.1,
            style: 1.1,
            speakerBoost: false,
            seed: -1,
            normalize: "invalid",
            language: "fr",
            outputFormat: "pcm_44100",
            latencyTier: 5)
        let request = ElevenLabsTTSRequest(
            text: "Resolved speech",
            directive: directive,
            modelId: "eleven_v3",
            outputFormat: "mp3_44100_128",
            language: "en")

        XCTAssertEqual(request.text, "Resolved speech")
        XCTAssertEqual(request.modelId, "eleven_v3")
        XCTAssertEqual(request.outputFormat, "mp3_44100_128")
        XCTAssertEqual(request.language, "en")
        XCTAssertEqual(request.speed, 1)
        XCTAssertNil(request.stability)
        XCTAssertNil(request.similarity)
        XCTAssertNil(request.style)
        XCTAssertEqual(request.speakerBoost, false)
        XCTAssertNil(request.seed)
        XCTAssertNil(request.normalize)
        XCTAssertNil(request.latencyTier)
    }
}
#endif
