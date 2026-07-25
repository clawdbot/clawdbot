import Foundation
import OpenClawMLXTTSProtocol
import XCTest

final class MLXTTSProtocolTests: XCTestCase {
    func testRequestRoundTrip() throws {
        let request = MLXTTSRequest.synthesize(MLXTTSSynthesizeRequest(
            id: "request-1",
            text: "hello",
            modelRepo: "mlx-community/Soprano-80M-bf16",
            language: "en",
            voice: nil))

        var decoder = MLXTTSFrameDecoder()
        let payloads = try decoder.append(MLXTTSFrameCodec.encode(request))

        XCTAssertEqual(payloads.count, 1)
        XCTAssertEqual(try MLXTTSFrameCodec.decode(MLXTTSRequest.self, payload: payloads[0]), request)
    }

    func testDecoderAcceptsFragmentedAndCoalescedFrames() throws {
        let first = try MLXTTSFrameCodec.encode(MLXTTSRequest.cancel(id: "one"))
        let second = try MLXTTSFrameCodec.encode(MLXTTSRequest.shutdown)
        let combined = first + second
        let split = combined.count / 2

        var decoder = MLXTTSFrameDecoder()
        XCTAssertTrue(try decoder.append(combined.prefix(split)).isEmpty)
        let payloads = try decoder.append(combined.suffix(from: split))

        XCTAssertEqual(payloads.count, 2)
        XCTAssertEqual(
            try MLXTTSFrameCodec.decode(MLXTTSRequest.self, payload: payloads[0]),
            .cancel(id: "one"))
        XCTAssertEqual(
            try MLXTTSFrameCodec.decode(MLXTTSRequest.self, payload: payloads[1]),
            .shutdown)
    }

    func testAudioEventCarriesExplicitPCMFormat() throws {
        let event = MLXTTSEvent.audio(MLXTTSAudio(
            id: "request-2",
            sampleRate: 32000,
            pcm: Data([0x00, 0x00, 0xFF, 0x7F])))
        let frame = try MLXTTSFrameCodec.encode(event)

        var decoder = MLXTTSFrameDecoder()
        let payload = try XCTUnwrap(decoder.append(frame).first)
        let decoded = try MLXTTSFrameCodec.decode(MLXTTSEvent.self, payload: payload)

        XCTAssertEqual(decoded, event)
    }

    func testDecoderRejectsEmptyAndOversizedFrames() {
        var emptyDecoder = MLXTTSFrameDecoder()
        XCTAssertThrowsError(try emptyDecoder.append(Data(repeating: 0, count: 4))) { error in
            XCTAssertEqual(error as? MLXTTSFrameError, .emptyFrame)
        }

        let oversized = UInt32(MLXTTSFrameCodec.maximumPayloadSize + 1).bigEndian
        var length = oversized
        let header = Data(bytes: &length, count: MemoryLayout<UInt32>.size)
        var oversizedDecoder = MLXTTSFrameDecoder()
        XCTAssertThrowsError(try oversizedDecoder.append(header)) { error in
            XCTAssertEqual(
                error as? MLXTTSFrameError,
                .frameTooLarge(MLXTTSFrameCodec.maximumPayloadSize + 1))
        }
    }

    func testCodecRejectsMalformedJSONPayload() {
        XCTAssertThrowsError(
            try MLXTTSFrameCodec.decode(MLXTTSRequest.self, payload: Data("not-json".utf8)))
    }
}
