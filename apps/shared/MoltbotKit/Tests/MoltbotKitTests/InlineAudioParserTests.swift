import MoltbotChatUI
import Foundation
import Testing

@Suite struct InlineAudioParserTests {
    @Test func parsesEmptyText() {
        let result = InlineAudioParser.parse("")
        #expect(result.cleaned.isEmpty)
        #expect(result.audioFiles.isEmpty)
    }

    @Test func parsesTextWithoutMediaPaths() {
        let text = "Hello, this is a regular message without any media."
        let result = InlineAudioParser.parse(text)
        #expect(result.cleaned == text)
        #expect(result.audioFiles.isEmpty)
    }

    @Test func detectsMP3MediaPath() {
        let text = "Here is your audio: MEDIA:/tmp/voice-12345.mp3"
        let result = InlineAudioParser.parse(text)
        #expect(result.cleaned == "Here is your audio:")
        #expect(result.audioFiles.count == 1)
        #expect(result.audioFiles[0].path == "/tmp/voice-12345.mp3")
        #expect(result.audioFiles[0].displayName == "voice-12345.mp3")
    }

    @Test func detectsOpusMediaPath() {
        let text = "Voice message: MEDIA:/var/data/message.opus"
        let result = InlineAudioParser.parse(text)
        #expect(result.cleaned == "Voice message:")
        #expect(result.audioFiles.count == 1)
        #expect(result.audioFiles[0].path == "/var/data/message.opus")
    }

    @Test func detectsM4AMediaPath() {
        let text = "MEDIA:/path/to/audio.m4a is ready"
        let result = InlineAudioParser.parse(text)
        #expect(result.cleaned == "is ready")
        #expect(result.audioFiles.count == 1)
        #expect(result.audioFiles[0].path == "/path/to/audio.m4a")
    }

    @Test func detectsOGGMediaPath() {
        let text = "Listen: MEDIA:/files/sound.ogg"
        let result = InlineAudioParser.parse(text)
        #expect(result.audioFiles.count == 1)
        #expect(result.audioFiles[0].path == "/files/sound.ogg")
    }

    @Test func detectsWAVMediaPath() {
        let text = "Audio clip: MEDIA:/recordings/clip.wav"
        let result = InlineAudioParser.parse(text)
        #expect(result.audioFiles.count == 1)
        #expect(result.audioFiles[0].path == "/recordings/clip.wav")
    }

    @Test func detectsMultipleMediaPaths() {
        let text = """
        Here are two audio files:
        First: MEDIA:/tmp/voice1.mp3
        Second: MEDIA:/tmp/voice2.opus
        Enjoy!
        """
        let result = InlineAudioParser.parse(text)
        #expect(result.audioFiles.count == 2)
        #expect(result.audioFiles[0].path == "/tmp/voice1.mp3")
        #expect(result.audioFiles[1].path == "/tmp/voice2.opus")
        #expect(result.cleaned.contains("Here are two audio files:"))
        #expect(result.cleaned.contains("Enjoy!"))
        #expect(!result.cleaned.contains("MEDIA:"))
    }

    @Test func handlesMediaPathWithDashesAndUnderscores() {
        let text = "MEDIA:/path/to/voice-message_2024-01-15.mp3"
        let result = InlineAudioParser.parse(text)
        #expect(result.audioFiles.count == 1)
        #expect(result.audioFiles[0].path == "/path/to/voice-message_2024-01-15.mp3")
    }

    @Test func isCaseInsensitive() {
        let text1 = "media:/tmp/test.mp3"
        let text2 = "Media:/tmp/test.mp3"
        let text3 = "MEDIA:/tmp/test.mp3"

        let result1 = InlineAudioParser.parse(text1)
        let result2 = InlineAudioParser.parse(text2)
        let result3 = InlineAudioParser.parse(text3)

        #expect(result1.audioFiles.count == 1)
        #expect(result2.audioFiles.count == 1)
        #expect(result3.audioFiles.count == 1)
    }

    @Test func ignoresNonAudioMediaPaths() {
        // The parser should only detect audio extensions
        let text = "Image: MEDIA:/tmp/photo.jpg"
        let result = InlineAudioParser.parse(text)
        #expect(result.audioFiles.isEmpty)
        #expect(result.cleaned == text) // Text unchanged for non-audio
    }

    @Test func preservesTextAroundMediaPath() {
        let text = "Before MEDIA:/tmp/audio.mp3 After"
        let result = InlineAudioParser.parse(text)
        #expect(result.audioFiles.count == 1)
        #expect(result.cleaned == "Before  After" || result.cleaned == "Before After")
    }

    @Test func handlesMediaPathAtStartOfLine() {
        let text = "MEDIA:/tmp/audio.mp3\nSome text after"
        let result = InlineAudioParser.parse(text)
        #expect(result.audioFiles.count == 1)
        #expect(result.cleaned.contains("Some text after"))
    }

    @Test func handlesMediaPathAtEndOfLine() {
        let text = "Check this out: MEDIA:/tmp/audio.mp3"
        let result = InlineAudioParser.parse(text)
        #expect(result.audioFiles.count == 1)
        #expect(result.cleaned == "Check this out:")
    }
}
