import AVFoundation
import Foundation
import Observation
import SwiftUI
import UniformTypeIdentifiers

@MainActor
struct ChatMediaAudioAttachment: View {
    private enum LoadState {
        case loading
        case loaded(ChatMediaAudioPlayer)
        case unavailable
    }

    let artifactId: String
    let label: String
    let durationSeconds: Double?
    let resolverReady: Bool
    let playbackAllowed: @MainActor @Sendable () -> Bool
    let load: @MainActor @Sendable (String) async throws -> OpenClawChatLoadedMedia?

    @State private var state: LoadState = .loading
    @State private var retryGeneration = 0

    var body: some View {
        Group {
            switch self.state {
            case .loading:
                self.loadingRow
            case let .loaded(player):
                self.playerRow(player)
            case .unavailable:
                self.unavailableRow
            }
        }
        .task(id: "\(self.artifactId):\(self.resolverReady):\(self.retryGeneration)") {
            await self.loadAudio()
        }
        .onDisappear {
            if case let .loaded(player) = self.state {
                player.stop()
            }
        }
    }

    private var loadingRow: some View {
        HStack(spacing: 8) {
            ProgressView()
            Text(String(localized: "Loading audio…"))
                .font(OpenClawChatTypography.footnote)
                .foregroundStyle(.secondary)
            Spacer()
            if let durationSeconds {
                Text(openClawVoiceNoteDurationLabel(durationSeconds))
                    .font(OpenClawChatTypography.mono(size: 12, relativeTo: .footnote))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(minHeight: 52)
        .padding(.horizontal, 10)
    }

    @ViewBuilder
    private func playerRow(_ player: ChatMediaAudioPlayer) -> some View {
        if player.isUnavailable {
            self.unavailableRow
        } else {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Image(systemName: "waveform")
                    Text(String(localized: "Voice note"))
                        .font(OpenClawChatTypography.footnote)
                    Text(verbatim: self.label)
                        .font(OpenClawChatTypography.footnote)
                        .lineLimit(1)
                        .foregroundStyle(.secondary)
                    Spacer()
                }

                HStack(spacing: 10) {
                    Button {
                        player.toggle()
                    } label: {
                        Image(systemName: player.isPlaying ? "pause.fill" : "play.fill")
                            .frame(width: 18, height: 18)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(player.isPlaying ? String(localized: "Pause") : String(localized: "Play"))

                    Slider(
                        value: Binding(
                            get: { player.currentTime },
                            set: { player.seek(to: $0) }),
                        in: 0...max(player.duration, 0.001))
                        .accessibilityLabel(String(localized: "Audio position"))

                    Text(verbatim: self.playbackPositionLabel(player))
                        .font(OpenClawChatTypography.mono(size: 11, relativeTo: .caption))
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }

                if player.isPlaybackBlocked {
                    Text(String(localized: "Pause Talk mode before playing this attachment."))
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(10)
            .background(Color.black.opacity(0.04))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    private var unavailableRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "waveform.badge.exclamationmark")
            Text(String(localized: "Audio unavailable"))
                .font(OpenClawChatTypography.footnote)
            Spacer()
            Button {
                self.retryGeneration &+= 1
            } label: {
                Text(String(localized: "Retry"))
                    .font(OpenClawChatTypography.footnote)
            }
            .buttonStyle(.plain)
        }
        .foregroundStyle(.secondary)
        .padding(10)
        .background(Color.black.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func playbackPositionLabel(_ player: ChatMediaAudioPlayer) -> String {
        let elapsed = openClawVoiceNoteDurationLabel(player.currentTime)
        let total = openClawVoiceNoteDurationLabel(player.duration)
        return "\(elapsed) / \(total)"
    }

    private func loadAudio() async {
        if case let .loaded(player) = self.state {
            player.stop()
        }
        guard self.resolverReady else {
            self.state = .unavailable
            return
        }
        self.state = .loading
        do {
            guard let loaded = try await self.load(self.artifactId), !Task.isCancelled else {
                if !Task.isCancelled { self.state = .unavailable }
                return
            }
            guard case let .data(media) = loaded,
                  media.mimeType.lowercased().hasPrefix("audio/")
            else {
                self.state = .unavailable
                return
            }
            self.state = try .loaded(ChatMediaAudioPlayer(
                media: media,
                fallbackDuration: self.durationSeconds,
                playbackAllowed: self.playbackAllowed))
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else { return }
            self.state = .unavailable
        }
    }
}

@MainActor
@Observable
final class ChatMediaAudioPlayer: NSObject, ChatMediaPlaybackOwner {
    private(set) var isPlaying = false
    private(set) var isPlaybackBlocked = false
    private(set) var isUnavailable = false
    private(set) var currentTime: TimeInterval = 0
    let duration: TimeInterval

    @ObservationIgnored private let player: AVAudioPlayer
    @ObservationIgnored private let playbackAllowed: @MainActor @Sendable () -> Bool
    @ObservationIgnored private var progressTask: Task<Void, Never>?
    @ObservationIgnored private var ownsAudioSession = false

    init(
        media: OpenClawChatMediaData,
        fallbackDuration: TimeInterval?,
        playbackAllowed: @escaping @MainActor @Sendable () -> Bool) throws
    {
        let typeHint = UTType(mimeType: media.mimeType)?.identifier
        self.player = try AVAudioPlayer(data: media.data, fileTypeHint: typeHint)
        self.duration = self.player.duration.isFinite && self.player.duration > 0
            ? self.player.duration
            : max(0, fallbackDuration ?? 0)
        self.playbackAllowed = playbackAllowed
        super.init()
        self.player.delegate = self
        self.player.prepareToPlay()
    }

    func toggle() {
        if self.isPlaying {
            self.pause()
        } else {
            self.play()
        }
    }

    func seek(to time: TimeInterval) {
        let upperBound = self.duration > 0 ? self.duration : self.player.duration
        let target = min(max(0, time), max(0, upperBound))
        self.player.currentTime = target
        self.currentTime = target
    }

    func stop() {
        self.progressTask?.cancel()
        self.progressTask = nil
        self.player.stop()
        self.player.currentTime = 0
        self.currentTime = 0
        self.isPlaying = false
        self.deactivateAudioSession()
        ChatMediaPlaybackCoordinator.shared.release(self)
    }

    func stopForMediaPlaybackInterruption() {
        self.pause()
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully _: Bool) {
        guard player === self.player else { return }
        self.progressTask?.cancel()
        self.progressTask = nil
        self.currentTime = self.duration
        self.isPlaying = false
        self.deactivateAudioSession()
        ChatMediaPlaybackCoordinator.shared.release(self)
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error _: (any Error)?) {
        guard player === self.player else { return }
        self.fail()
    }

    private func play() {
        guard self.playbackAllowed() else {
            self.isPlaybackBlocked = true
            return
        }
        self.isPlaybackBlocked = false
        self.rewindIfFinished()
        ChatMediaPlaybackCoordinator.shared.activate(self)
        guard self.activateAudioSession() else {
            self.isUnavailable = true
            ChatMediaPlaybackCoordinator.shared.release(self)
            return
        }
        guard self.player.play() else {
            self.fail()
            return
        }
        self.isPlaying = true
        self.startProgressUpdates()
    }

    private func pause() {
        self.progressTask?.cancel()
        self.progressTask = nil
        self.player.pause()
        self.currentTime = self.player.currentTime
        self.isPlaying = false
        self.deactivateAudioSession()
        ChatMediaPlaybackCoordinator.shared.release(self)
    }

    private func rewindIfFinished() {
        let duration = self.player.duration
        guard duration.isFinite, duration > 0,
              self.player.currentTime >= duration - 0.05
        else { return }
        self.player.currentTime = 0
        self.currentTime = 0
    }

    private func fail() {
        self.stop()
        self.isUnavailable = true
    }

    private func startProgressUpdates() {
        self.progressTask?.cancel()
        self.progressTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(200))
                guard let self, !Task.isCancelled else { return }
                guard self.playbackAllowed() else {
                    self.isPlaybackBlocked = true
                    self.pause()
                    return
                }
                self.currentTime = self.player.currentTime
            }
        }
    }

    private func activateAudioSession() -> Bool {
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
            try session.setActive(true)
            self.ownsAudioSession = true
        } catch {
            return false
        }
        #endif
        return true
    }

    private func deactivateAudioSession() {
        #if os(iOS)
        guard self.ownsAudioSession else { return }
        self.ownsAudioSession = false
        try? AVAudioSession.sharedInstance().setActive(
            false,
            options: [.notifyOthersOnDeactivation])
        #endif
    }
}

// SDK 27 imports AVAudioPlayerDelegate with compatible isolation. Older SDKs
// still need the preconcurrency bridge for this main-actor implementation.
#if compiler(>=6.4)
extension ChatMediaAudioPlayer: AVAudioPlayerDelegate {}
#else
extension ChatMediaAudioPlayer: @preconcurrency AVAudioPlayerDelegate {}
#endif
