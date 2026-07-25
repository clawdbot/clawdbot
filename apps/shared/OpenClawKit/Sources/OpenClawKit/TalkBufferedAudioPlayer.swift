// canImport mirrors ElevenLabsKitShim: StreamingPlaybackResult only exists on
// platforms ElevenLabsKit builds for (iOS/macOS); the watch build compiles this out.
#if Talk && canImport(ElevenLabsKit)
import AVFoundation
import Foundation
import OSLog

/// Plays one complete TTS clip (MP3/WAV/FLAC container) at a time via
/// AVAudioPlayer, with live level metering and a watchdog so a stalled or
/// silently failing playback can never hang the talk loop. Shared by the iOS
/// and macOS talk runtimes.
@MainActor
public final class TalkBufferedAudioPlayer: NSObject {
    public static let shared = TalkBufferedAudioPlayer()

    override public init() {
        super.init()
    }

    private final class Playback: @unchecked Sendable {
        private let lock = NSLock()
        private var finished = false
        private var continuation: CheckedContinuation<StreamingPlaybackResult, Never>?
        private var watchdog: Task<Void, Never>?

        func setContinuation(_ continuation: CheckedContinuation<StreamingPlaybackResult, Never>) {
            self.lock.lock()
            defer { self.lock.unlock() }
            self.continuation = continuation
        }

        func setWatchdog(_ task: Task<Void, Never>?) {
            self.lock.lock()
            let old = self.watchdog
            self.watchdog = task
            self.lock.unlock()
            old?.cancel()
        }

        func finish(_ result: StreamingPlaybackResult) {
            let continuation: CheckedContinuation<StreamingPlaybackResult, Never>?
            self.lock.lock()
            if self.finished {
                continuation = nil
            } else {
                self.finished = true
                continuation = self.continuation
                self.continuation = nil
            }
            self.lock.unlock()
            continuation?.resume(returning: result)
        }
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "talk.tts")
    private var player: AVAudioPlayer?
    private var playback: Playback?
    private var levelHandler: (@MainActor (Double?) -> Void)?
    private var levelMeter: AudioPlayerLevelMeter?

    public func setLevelHandler(_ handler: (@MainActor (Double?) -> Void)?) {
        self.levelHandler = handler
    }

    public func play(data: Data) async -> StreamingPlaybackResult {
        self.stopInternal()

        let playback = Playback()
        self.playback = playback
        return await withCheckedContinuation { continuation in
            playback.setContinuation(continuation)
            do {
                let player = try AVAudioPlayer(data: data)
                self.player = player
                player.delegate = self
                player.prepareToPlay()
                if let levelHandler {
                    let meter = AudioPlayerLevelMeter(onLevel: levelHandler)
                    meter.attach(player)
                    self.levelMeter = meter
                }
                self.armWatchdog(playback: playback)
                if !player.play() {
                    self.logger.error("talk buffered audio player refused to play")
                    self.finish(playback: playback, result: .init(finished: false, interruptedAt: nil))
                }
            } catch {
                self.logger.error("talk buffered audio player failed: \(error.localizedDescription, privacy: .public)")
                self.finish(playback: playback, result: .init(finished: false, interruptedAt: nil))
            }
        }
    }

    public func stop() -> Double? {
        guard let player else { return nil }
        let interruptedAt = player.currentTime
        self.finish(
            playback: self.playback,
            result: .init(finished: false, interruptedAt: interruptedAt))
        return interruptedAt
    }

    public func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        self.finish(
            playback: self.activePlayback(for: player),
            result: .init(finished: flag, interruptedAt: nil))
    }

    public func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: (any Error)?) {
        let message = error?.localizedDescription ?? "unknown decode error"
        self.logger.error("talk buffered audio decode failed: \(message, privacy: .public)")
        self.finish(
            playback: self.activePlayback(for: player),
            result: .init(finished: false, interruptedAt: nil))
    }

    private func activePlayback(for player: AVAudioPlayer) -> Playback? {
        // AVAudioPlayer can deliver callbacks after stop/replacement. Keep a stale
        // player from completing the current reply's continuation.
        guard self.player === player else { return nil }
        return self.playback
    }

    private func stopInternal() {
        if let player, let playback {
            self.finish(
                playback: playback,
                result: .init(finished: false, interruptedAt: player.currentTime))
            return
        }
        self.player?.stop()
        self.player = nil
    }

    private func finish(playback: Playback?, result: StreamingPlaybackResult) {
        guard let playback else { return }
        playback.setWatchdog(nil)
        playback.finish(result)

        guard self.playback === playback else { return }
        self.playback = nil
        self.levelMeter?.detach()
        self.levelMeter = nil
        self.player?.stop()
        self.player = nil
    }

    private func armWatchdog(playback: Playback) {
        playback.setWatchdog(Task { @MainActor [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: 650_000_000)
            guard !Task.isCancelled, self.playback === playback else { return }
            guard self.player?.isPlaying == true else {
                self.finish(
                    playback: playback,
                    result: .init(finished: false, interruptedAt: nil))
                return
            }

            let duration = self.player?.duration ?? 0
            let timeoutSeconds = min(max(2.0, duration + 2.0), 5 * 60.0)
            try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
            guard !Task.isCancelled, self.playback === playback else { return }
            self.logger.error("talk buffered audio player watchdog completed unresolved playback")
            self.finish(
                playback: playback,
                result: .init(finished: false, interruptedAt: nil))
        })
    }
}

// SDK 27 imports AVAudioPlayerDelegate with compatible isolation. Older SDKs
// still need the preconcurrency bridge for this main-actor implementation.
#if compiler(>=6.4)
extension TalkBufferedAudioPlayer: AVAudioPlayerDelegate {}
#else
extension TalkBufferedAudioPlayer: @preconcurrency AVAudioPlayerDelegate {}
#endif
#endif
