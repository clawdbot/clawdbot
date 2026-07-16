import AVFoundation
import Foundation
import Observation
import UniformTypeIdentifiers

/// Gateway-rendered audio for one transcript message.
public struct OpenClawChatSpeechClip: Equatable, Sendable {
    public let data: Data
    public let outputFormat: String?
    public let mimeType: String?
    public let fileExtension: String?

    public init(
        data: Data,
        outputFormat: String? = nil,
        mimeType: String? = nil,
        fileExtension: String? = nil)
    {
        self.data = data
        self.outputFormat = outputFormat
        self.mimeType = mimeType
        self.fileExtension = fileExtension
    }

    /// Raw formats need sample-rate/channel metadata that `tts.speak` does not
    /// currently expose. Reject them explicitly so Listen uses its local voice
    /// instead of asking AVAudioPlayer to guess at headerless bytes.
    var isHeaderlessAudio: Bool {
        let extensionName = self.normalizedFileExtension
        if ["pcm", "raw", "mulaw", "ulaw", "alaw"].contains(extensionName) {
            return true
        }
        let mimeType = self.mimeType?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if let mimeType,
           ["audio/pcm", "audio/l16", "audio/pcmu", "audio/pcma", "audio/x-raw"].contains(mimeType)
        {
            return true
        }
        let outputFormat = self.outputFormat?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard let outputFormat else { return false }
        return outputFormat.hasPrefix("raw-") ||
            outputFormat.hasPrefix("raw_") ||
            ["pcm", "mulaw", "ulaw", "alaw"].contains(outputFormat) ||
            ["pcm_", "mulaw_", "ulaw_", "alaw_"].contains { outputFormat.hasPrefix($0) }
    }

    var fileTypeHint: String? {
        if let mimeType,
           let type = UTType(
               mimeType: mimeType.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
        {
            return type.identifier
        }
        guard !self.normalizedFileExtension.isEmpty else { return nil }
        return UTType(filenameExtension: self.normalizedFileExtension)?.identifier
    }

    private var normalizedFileExtension: String {
        self.fileExtension?
            .trimmingCharacters(in: CharacterSet(charactersIn: ". "))
            .lowercased() ?? ""
    }
}

/// Renders message text to a playable clip; host apps back this with the
/// gateway `tts.speak` method. Any failure falls back to on-device speech.
public typealias OpenClawChatSpeechSynthesis =
    @Sendable (_ text: String) async throws -> OpenClawChatSpeechClip

@MainActor
protocol ChatSpeechClipPlaying: AnyObject {
    /// Resolves when playback ends; false when stopped early or undecodable.
    func play(clip: OpenClawChatSpeechClip) async -> Bool
    func stop()
}

@MainActor
protocol ChatSpeechLocalSpeaking: AnyObject {
    /// Resolves when the utterance ends; false when cancelled.
    func speak(text: String) async -> Bool
    func stop()
}

/// Drives the transcript "Listen" action: one message speaks at a time,
/// gateway audio first, on-device synthesis as the fallback voice.
@MainActor
@Observable
public final class OpenClawChatSpeechController {
    public enum Phase: Equatable {
        case idle
        case preparing(UUID)
        case speaking(UUID)
    }

    public private(set) var phase: Phase = .idle

    private let synthesize: OpenClawChatSpeechSynthesis
    private let clipPlayer: any ChatSpeechClipPlaying
    private let localSpeech: any ChatSpeechLocalSpeaking
    @ObservationIgnored private var playbackTask: Task<Void, Never>?
    /// Monotonic token: completions from a superseded playback must not
    /// clear the phase owned by a newer one.
    @ObservationIgnored private var generation: UInt64 = 0

    public convenience init(synthesize: @escaping OpenClawChatSpeechSynthesis) {
        self.init(
            synthesize: synthesize,
            clipPlayer: ChatSpeechClipPlayer(),
            localSpeech: ChatSpeechLocalSpeaker())
    }

    init(
        synthesize: @escaping OpenClawChatSpeechSynthesis,
        clipPlayer: any ChatSpeechClipPlaying,
        localSpeech: any ChatSpeechLocalSpeaking)
    {
        self.synthesize = synthesize
        self.clipPlayer = clipPlayer
        self.localSpeech = localSpeech
    }

    public var activeMessageID: UUID? {
        switch self.phase {
        case .idle:
            nil
        case let .preparing(id):
            id
        case let .speaking(id):
            id
        }
    }

    public func isActive(_ messageID: UUID) -> Bool {
        self.activeMessageID == messageID
    }

    /// Starts speaking the message, or stops if it is already active.
    public func toggle(messageID: UUID, text: String) {
        if self.isActive(messageID) {
            self.stop()
            return
        }
        self.start(messageID: messageID, text: text)
    }

    public func stop() {
        self.generation &+= 1
        self.playbackTask?.cancel()
        self.playbackTask = nil
        self.clipPlayer.stop()
        self.localSpeech.stop()
        guard self.phase != .idle else { return }
        self.phase = .idle
        self.deactivateAudioSession()
    }

    private func start(messageID: UUID, text: String) {
        self.stop()
        let spoken = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !spoken.isEmpty else { return }
        self.generation &+= 1
        let generation = self.generation
        self.phase = .preparing(messageID)
        self.playbackTask = Task { [weak self] in
            await self?.run(messageID: messageID, text: spoken, generation: generation)
        }
    }

    private func run(messageID: UUID, text: String, generation: UInt64) async {
        let clip: OpenClawChatSpeechClip? = await {
            do {
                return try await self.synthesize(text)
            } catch {
                return nil
            }
        }()
        guard self.generation == generation, !Task.isCancelled else { return }

        self.activateAudioSession()
        self.phase = .speaking(messageID)
        if let clip, !clip.data.isEmpty {
            let finished = await self.clipPlayer.play(clip: clip)
            // stop() bumps the generation, so reaching this guard with a
            // false result means the clip failed to decode/start, not that
            // the user cancelled — fall through to the on-device voice.
            guard self.generation == generation else { return }
            if finished {
                self.finish(generation: generation)
                return
            }
        }
        // Gateway clip unavailable or unplayable: on-device synthesis keeps
        // Listen working when no TTS provider is configured.
        _ = await self.localSpeech.speak(text: text)
        self.finish(generation: generation)
    }

    private func finish(generation: UInt64) {
        guard self.generation == generation else { return }
        self.playbackTask = nil
        self.phase = .idle
        self.deactivateAudioSession()
    }

    private func activateAudioSession() {
        #if os(iOS)
        // Deliberate .playback: Listen is an explicit user action, so it stays
        // audible like other tap-to-play media while ducking (not stopping)
        // whatever else is playing.
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
        try? session.setActive(true)
        #endif
    }

    private func deactivateAudioSession() {
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(
            false,
            options: [.notifyOthersOnDeactivation])
        #endif
    }
}

/// Whole-clip playback for gateway-rendered container audio. File metadata
/// helps AVAudioPlayer parse clips whose type is not obvious from the bytes.
@MainActor
final class ChatSpeechClipPlayer: NSObject, ChatSpeechClipPlaying {
    private var player: AVAudioPlayer?
    private var continuation: CheckedContinuation<Bool, Never>?

    func play(clip: OpenClawChatSpeechClip) async -> Bool {
        self.stop()
        guard !clip.isHeaderlessAudio else { return false }
        return await withCheckedContinuation { continuation in
            self.continuation = continuation
            do {
                let player = try AVAudioPlayer(data: clip.data, fileTypeHint: clip.fileTypeHint)
                self.player = player
                player.delegate = self
                player.prepareToPlay()
                if !player.play() {
                    self.finish(false)
                }
            } catch {
                self.finish(false)
            }
        }
    }

    func stop() {
        self.finish(false)
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        // AVAudioPlayer can deliver callbacks after stop/replacement; a stale
        // player must not resolve the current clip's continuation.
        guard player === self.player else { return }
        self.finish(flag)
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: (any Error)?) {
        guard player === self.player else { return }
        self.finish(false)
    }

    private func finish(_ finished: Bool) {
        let continuation = self.continuation
        self.continuation = nil
        self.player?.stop()
        self.player?.delegate = nil
        self.player = nil
        continuation?.resume(returning: finished)
    }
}

// SDK 27 imports AVAudioPlayerDelegate with compatible isolation. Older SDKs
// still need the preconcurrency bridge for this main-actor implementation.
#if compiler(>=6.4)
extension ChatSpeechClipPlayer: AVAudioPlayerDelegate {}
#else
extension ChatSpeechClipPlayer: @preconcurrency AVAudioPlayerDelegate {}
#endif

/// On-device fallback voice via AVSpeechSynthesizer.
@MainActor
final class ChatSpeechLocalSpeaker: NSObject, ChatSpeechLocalSpeaking,
    @preconcurrency AVSpeechSynthesizerDelegate
{
    private let synthesizer = AVSpeechSynthesizer()
    private var continuation: CheckedContinuation<Bool, Never>?
    private var utterance: AVSpeechUtterance?

    override init() {
        super.init()
        self.synthesizer.delegate = self
    }

    func speak(text: String) async -> Bool {
        self.stop()
        return await withCheckedContinuation { continuation in
            let utterance = AVSpeechUtterance(string: text)
            self.continuation = continuation
            self.utterance = utterance
            self.synthesizer.speak(utterance)
        }
    }

    func stop() {
        let continuation = self.continuation
        self.continuation = nil
        self.utterance = nil
        self.synthesizer.stopSpeaking(at: .immediate)
        continuation?.resume(returning: false)
    }

    func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didFinish utterance: AVSpeechUtterance)
    {
        guard utterance === self.utterance else { return }
        self.resume(true)
    }

    func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didCancel utterance: AVSpeechUtterance)
    {
        guard utterance === self.utterance else { return }
        self.resume(false)
    }

    private func resume(_ finished: Bool) {
        let continuation = self.continuation
        self.continuation = nil
        self.utterance = nil
        continuation?.resume(returning: finished)
    }
}
