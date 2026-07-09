import AVFoundation
import Foundation
import OpenClawKit
import OpenClawProtocol
import OSLog

struct TalkGatewaySpeechAudio: Equatable {
    enum PlaybackMode: Equatable {
        case pcm(sampleRate: Double)
        case buffered
        case unsupportedRaw(codec: String)
    }

    let data: Data
    let provider: String
    let outputFormat: String?

    var playbackMode: PlaybackMode {
        if let sampleRate = TalkTTSValidation.pcmSampleRate(from: self.outputFormat) {
            return .pcm(sampleRate: sampleRate)
        }
        let outputFormat = self.outputFormat?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let isHeaderlessAudio = if let outputFormat {
            outputFormat.hasPrefix("raw-") ||
                outputFormat.hasPrefix("raw_") ||
                outputFormat == "pcm" ||
                outputFormat == "mulaw" ||
                outputFormat == "alaw" ||
                outputFormat.hasPrefix("mulaw_") ||
                outputFormat.hasPrefix("ulaw_") ||
                outputFormat.hasPrefix("alaw_")
        } else {
            false
        }
        if let outputFormat, isHeaderlessAudio {
            // talk.speak does not expose the sample rate needed to play headerless audio.
            // Keep these codecs out of AVAudioPlayer until that protocol metadata exists.
            return .unsupportedRaw(codec: outputFormat)
        }
        // Gateway providers return complete audio files (for example MP3, WAV, or FLAC).
        // AVAudioPlayer performs container detection; raw PCM keeps its sample-rate path above.
        return .buffered
    }
}

struct TalkGatewaySpeechRequest {
    let text: String
    // These are talk.speak protocol inputs; each Gateway speech provider owns which overrides it honors.
    let voiceId: String?
    let modelId: String?
    let outputFormat: String?
    let directive: TalkDirective?
}

@MainActor
protocol TalkGatewaySpeechSynthesizing {
    func synthesize(_ request: TalkGatewaySpeechRequest) async throws -> TalkGatewaySpeechAudio
}

@MainActor
final class TalkGatewaySpeechClient: TalkGatewaySpeechSynthesizing {
    typealias Request = (_ method: String, _ paramsJSON: String?, _ timeoutSeconds: Int) async throws -> Data
    private static let requestTimeoutSeconds = 125

    private let request: Request

    init(gateway: GatewayNodeSession) {
        self.request = { method, paramsJSON, timeoutSeconds in
            try await gateway.request(
                method: method,
                paramsJSON: paramsJSON,
                timeoutSeconds: timeoutSeconds)
        }
    }

    init(request: @escaping Request) {
        self.request = request
    }

    func synthesize(_ speechRequest: TalkGatewaySpeechRequest) async throws -> TalkGatewaySpeechAudio {
        let directive = speechRequest.directive
        let params = TalkSpeakParams(
            text: speechRequest.text,
            voiceid: speechRequest.voiceId,
            modelid: speechRequest.modelId,
            outputformat: speechRequest.outputFormat,
            speed: directive?.speed,
            ratewpm: directive?.rateWPM,
            stability: directive?.stability,
            similarity: directive?.similarity,
            style: directive?.style,
            speakerboost: directive?.speakerBoost,
            seed: directive?.seed,
            normalize: directive?.normalize,
            language: directive?.language,
            latencytier: directive?.latencyTier)
        let paramsData = try JSONEncoder().encode(params)
        guard let paramsJSON = String(data: paramsData, encoding: .utf8) else {
            throw TalkGatewaySpeechError.invalidRequest
        }
        let responseData = try await request(
            "talk.speak",
            paramsJSON,
            Self.requestTimeoutSeconds)
        let response = try JSONDecoder().decode(TalkSpeakResult.self, from: responseData)
        guard let audioData = Data(base64Encoded: response.audiobase64), !audioData.isEmpty else {
            throw TalkGatewaySpeechError.emptyAudio
        }
        return TalkGatewaySpeechAudio(
            data: audioData,
            provider: response.provider,
            outputFormat: response.outputformat)
    }
}

@MainActor
protocol TalkBufferedAudioPlaying {
    func play(data: Data) async -> StreamingPlaybackResult
    func stop() -> Double?
    func setLevelHandler(_ handler: (@MainActor (Double?) -> Void)?)
}

extension TalkBufferedAudioPlaying {
    /// Level metering is a UI nicety; test doubles and future players may skip it.
    func setLevelHandler(_: (@MainActor (Double?) -> Void)?) {}
}

@MainActor
final class TalkBufferedAudioPlayer: NSObject, TalkBufferedAudioPlaying, @preconcurrency AVAudioPlayerDelegate {
    static let shared = TalkBufferedAudioPlayer()

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

    func setLevelHandler(_ handler: (@MainActor (Double?) -> Void)?) {
        self.levelHandler = handler
    }

    func play(data: Data) async -> StreamingPlaybackResult {
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

    func stop() -> Double? {
        guard let player else { return nil }
        let interruptedAt = player.currentTime
        self.finish(
            playback: self.playback,
            result: .init(finished: false, interruptedAt: interruptedAt))
        return interruptedAt
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        self.finish(
            playback: self.activePlayback(for: player),
            result: .init(finished: flag, interruptedAt: nil))
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: (any Error)?) {
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

private enum TalkGatewaySpeechError: LocalizedError {
    case invalidRequest
    case emptyAudio

    var errorDescription: String? {
        switch self {
        case .invalidRequest:
            "Failed to encode talk.speak request"
        case .emptyAudio:
            "Gateway talk.speak returned empty audio"
        }
    }
}
