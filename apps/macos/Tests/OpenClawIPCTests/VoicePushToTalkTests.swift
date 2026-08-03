import AVFoundation
import Testing
@testable import OpenClaw

struct VoicePushToTalkTests {
    @Test func `speech normalizer passes through mono buffers`() throws {
        let format = try #require(AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16_000,
            channels: 1,
            interleaved: false))
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4))
        buffer.frameLength = 4

        let normalized = SpeechAudioBufferNormalizer.speechCompatibleBuffer(from: buffer)

        #expect(normalized === buffer)
    }

    @Test func `speech normalizer downmixes multichannel float buffers to mono`() throws {
        var layout = AudioChannelLayout()
        layout.mChannelLayoutTag = kAudioChannelLayoutTag_Quadraphonic
        let channelLayout = AVAudioChannelLayout(layout: &layout)
        let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: 16_000,
            interleaved: false,
            channelLayout: channelLayout)
        let buffer = try #require(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 2))
        buffer.frameLength = 2
        let channels = try #require(buffer.floatChannelData)
        for frame in 0..<2 {
            channels[0][frame] = 1
            channels[1][frame] = 3
            channels[2][frame] = 5
            channels[3][frame] = 7
        }

        let normalized = SpeechAudioBufferNormalizer.speechCompatibleBuffer(from: buffer)

        #expect(normalized.format.channelCount == 1)
        #expect(normalized.frameLength == 2)
        let output = try #require(normalized.floatChannelData?[0])
        #expect(output[0] == 4)
        #expect(output[1] == 4)
    }

    @Test func `delta trims committed prefix`() {
        let delta = VoicePushToTalk._testDelta(committed: "hello ", current: "hello world again")
        #expect(delta == "world again")
    }

    @Test func `delta falls back when prefix differs`() {
        let delta = VoicePushToTalk._testDelta(committed: "goodbye", current: "hello world")
        #expect(delta == "hello world")
    }

    @Test func `attributed colors differ when not final`() {
        let colors = VoicePushToTalk._testAttributedColors(isFinal: false)
        #expect(colors.0 != colors.1)
    }

    @Test func `attributed colors match when final`() {
        let colors = VoicePushToTalk._testAttributedColors(isFinal: true)
        #expect(colors.0 == colors.1)
    }
}
