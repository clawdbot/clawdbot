import AVFoundation
import SwiftUI

/// Detects and extracts `MEDIA:` prefixed audio file paths from message text.
/// Supports common audio extensions: .mp3, .opus, .m4a, .ogg, .oga, .wav
public enum InlineAudioParser {
    /// Represents an inline audio reference found in text
    public struct InlineAudio: Identifiable, Equatable {
        public let id = UUID()
        public let path: String
        public let displayName: String

        public init(path: String) {
            self.path = path
            self.displayName = (path as NSString).lastPathComponent
        }
    }

    /// Result of parsing text for inline audio
    public struct Result: Equatable {
        public let cleaned: String
        public let audioFiles: [InlineAudio]
    }

    /// Regex pattern to detect MEDIA:/path/to/file.ext references
    /// Matches MEDIA: followed by a file path ending in a supported audio extension
    private static let audioExtensions = ["mp3", "opus", "m4a", "ogg", "oga", "wav", "aac", "flac"]
    private static var pattern: String {
        let extPattern = audioExtensions.joined(separator: "|")
        // Match MEDIA: followed by a path, then a supported audio extension
        // The path can contain alphanumeric chars, slashes, dashes, underscores, dots, and spaces
        return #"MEDIA:([^\s<>\"]+\.(?:"# + extPattern + #"))"#
    }

    /// Parses the given text and extracts any MEDIA: audio references
    /// - Parameter text: The raw message text
    /// - Returns: A Result containing the cleaned text and extracted audio files
    public static func parse(_ text: String) -> Result {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) else {
            return Result(cleaned: text, audioFiles: [])
        }

        let nsString = text as NSString
        let matches = regex.matches(in: text, range: NSRange(location: 0, length: nsString.length))

        if matches.isEmpty {
            return Result(cleaned: text, audioFiles: [])
        }

        var audioFiles: [InlineAudio] = []
        var cleaned = text

        // Process matches in reverse order to preserve indices
        for match in matches.reversed() {
            guard match.numberOfRanges >= 2 else { continue }

            let fullRange = match.range
            let pathRange = match.range(at: 1)

            let path = nsString.substring(with: pathRange)
            audioFiles.insert(InlineAudio(path: path), at: 0)

            // Remove the MEDIA:path from the text
            let start = cleaned.index(cleaned.startIndex, offsetBy: fullRange.location)
            let end = cleaned.index(start, offsetBy: fullRange.length)
            cleaned.replaceSubrange(start..<end, with: "")
        }

        // Clean up any extra whitespace
        let normalized = cleaned
            .replacingOccurrences(of: "\n\n\n", with: "\n\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        return Result(cleaned: normalized, audioFiles: audioFiles)
    }
}

// MARK: - Audio Player View

/// A SwiftUI view that renders an inline audio player for a single audio file.
/// Shows a play/pause button and the audio file name.
@MainActor
public struct InlineAudioPlayerView: View {
    let audioPath: String
    let displayName: String

    @State private var isPlaying = false
    @State private var player: AVAudioPlayer?
    @State private var progress: Double = 0
    @State private var duration: Double = 0
    @State private var loadError: Bool = false
    @State private var timer: Timer?

    public init(audioPath: String, displayName: String? = nil) {
        self.audioPath = audioPath
        self.displayName = displayName ?? (audioPath as NSString).lastPathComponent
    }

    public var body: some View {
        HStack(spacing: 12) {
            // Play/Pause Button
            Button(action: togglePlayback) {
                Image(systemName: isPlaying ? "pause.circle.fill" : "play.circle.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(loadError ? .secondary : .accentColor)
            }
            .buttonStyle(.plain)
            .disabled(loadError)

            VStack(alignment: .leading, spacing: 4) {
                // File name
                Text(displayName)
                    .font(.footnote.weight(.medium))
                    .lineLimit(1)
                    .foregroundStyle(.primary)

                // Progress bar
                if duration > 0 {
                    HStack(spacing: 6) {
                        GeometryReader { geo in
                            ZStack(alignment: .leading) {
                                Capsule()
                                    .fill(Color.secondary.opacity(0.2))
                                    .frame(height: 4)

                                Capsule()
                                    .fill(Color.accentColor)
                                    .frame(width: geo.size.width * min(progress / duration, 1.0), height: 4)
                            }
                        }
                        .frame(height: 4)

                        Text(formatTime(isPlaying ? progress : duration))
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(.secondary)
                            .frame(minWidth: 36, alignment: .trailing)
                    }
                } else if loadError {
                    Text("Unable to load audio")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.secondary.opacity(0.1))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.secondary.opacity(0.15), lineWidth: 1)
        )
        .onAppear {
            loadAudio()
        }
        .onDisappear {
            stopPlayback()
        }
    }

    private func loadAudio() {
        let url = URL(fileURLWithPath: audioPath)

        guard FileManager.default.fileExists(atPath: audioPath) else {
            loadError = true
            return
        }

        do {
            let audioPlayer = try AVAudioPlayer(contentsOf: url)
            audioPlayer.prepareToPlay()
            player = audioPlayer
            duration = audioPlayer.duration
            loadError = false
        } catch {
            loadError = true
        }
    }

    private func togglePlayback() {
        guard let player = player else {
            loadAudio()
            return
        }

        if isPlaying {
            pausePlayback()
        } else {
            startPlayback(player)
        }
    }

    private func startPlayback(_ player: AVAudioPlayer) {
        player.play()
        isPlaying = true

        // Update progress periodically
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak player] _ in
            guard let player = player else {
                stopPlayback()
                return
            }

            Task { @MainActor in
                progress = player.currentTime

                // Check if playback finished
                if !player.isPlaying && progress >= duration - 0.1 {
                    stopPlayback()
                    progress = 0
                    player.currentTime = 0
                }
            }
        }
    }

    private func pausePlayback() {
        player?.pause()
        isPlaying = false
        timer?.invalidate()
        timer = nil
    }

    private func stopPlayback() {
        player?.stop()
        isPlaying = false
        timer?.invalidate()
        timer = nil
    }

    private func formatTime(_ time: Double) -> String {
        let minutes = Int(time) / 60
        let seconds = Int(time) % 60
        return String(format: "%d:%02d", minutes, seconds)
    }
}

// MARK: - Audio Player List View

/// A view that displays a list of inline audio players
@MainActor
public struct InlineAudioList: View {
    let audioFiles: [InlineAudioParser.InlineAudio]

    public init(audioFiles: [InlineAudioParser.InlineAudio]) {
        self.audioFiles = audioFiles
    }

    public var body: some View {
        ForEach(audioFiles) { audio in
            InlineAudioPlayerView(audioPath: audio.path, displayName: audio.displayName)
        }
    }
}

// MARK: - Preview

#if DEBUG
struct InlineAudioPlayerView_Previews: PreviewProvider {
    static var previews: some View {
        VStack(spacing: 16) {
            InlineAudioPlayerView(
                audioPath: "/tmp/test.mp3",
                displayName: "voice-message.mp3"
            )

            InlineAudioPlayerView(
                audioPath: "/nonexistent/path.opus",
                displayName: "missing-file.opus"
            )
        }
        .padding()
        .frame(width: 320)
    }
}
#endif
