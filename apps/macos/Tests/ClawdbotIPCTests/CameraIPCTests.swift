import MoltbotIPC
import Foundation
import Testing

@Suite struct CameraIPCTests {
    @Test func cameraSnapCodableRoundtrip() throws {
        let req: Request = .cameraSnap(
            facing: .front,
            maxWidth: 640,
            quality: 0.85,
            outPath: "/tmp/test.jpg")

        let data = try JSONEncoder().encode(req)
        let decoded = try JSONDecoder().decode(Request.self, from: data)

        switch decoded {
        case let .cameraSnap(facing, maxWidth, quality, outPath):
            #expect(facing == .front)
            #expect(maxWidth == 640)
            #expect(quality == 0.85)
            #expect(outPath == "/tmp/test.jpg")
        default:
            Issue.record("expected cameraSnap, got \(decoded)")
        }
    }

    @Test func cameraClipCodableRoundtrip() throws {
        let req: Request = .cameraClip(
            facing: .back,
            durationMs: 3000,
            includeAudio: false,
            outPath: "/tmp/test.mp4")

        let data = try JSONEncoder().encode(req)
        let decoded = try JSONDecoder().decode(Request.self, from: data)

        switch decoded {
        case let .cameraClip(facing, durationMs, includeAudio, outPath):
            #expect(facing == .back)
            #expect(durationMs == 3000)
            #expect(includeAudio == false)
            #expect(outPath == "/tmp/test.mp4")
        default:
            Issue.record("expected cameraClip, got \(decoded)")
        }
    }

    @Test func cameraClipDefaultsIncludeAudioToTrueWhenMissing() throws {
        let json = """
        {"type":"cameraClip","durationMs":1234}
        """
        let decoded = try JSONDecoder().decode(Request.self, from: Data(json.utf8))
        switch decoded {
        case let .cameraClip(_, durationMs, includeAudio, _):
            #expect(durationMs == 1234)
            #expect(includeAudio == true)
        default:
            Issue.record("expected cameraClip, got \(decoded)")
        }
    }
}
