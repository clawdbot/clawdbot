import AVFAudio
import Foundation
import Synchronization

enum WatchRealtimeSessionEvent: Sendable {
    case connected
    case inputLevel(Float)
    case ended(WatchRealtimeMediaFailure)
}

/// Audio and transport keep their own serial owners. No PCM or packet callbacks run on
/// the main actor; the call controller only receives connection state and metered levels.
final class WatchRealtimeMediaSession: Sendable {
    private enum Phase { case idle, starting, active, stopped }
    private final class Lifecycle: Sendable {
        let phase = Mutex(Phase.idle)

        func finish() -> Bool {
            self.phase.withLock { phase in
                guard phase != .stopped else { return false }
                phase = .stopped
                return true
            }
        }
    }

    private let audio: WatchRealtimeAudioIO
    private let transport: WatchRealtimeTransport
    private let onEvent: @Sendable (WatchRealtimeSessionEvent) -> Void
    private let lifecycle: Lifecycle

    init(onEvent: @escaping @Sendable (WatchRealtimeSessionEvent) -> Void) {
        self.onEvent = onEvent
        let lifecycle = Lifecycle()
        self.lifecycle = lifecycle
        let audio = WatchRealtimeAudioIO(onLevel: {
            if lifecycle.phase.withLock({ $0 == .active }) { onEvent(.inputLevel($0)) }
        })
        self.audio = audio
        self.transport = WatchRealtimeTransport { [weak audio] event in
            guard lifecycle.phase.withLock({ $0 != .stopped }) else { return }
            switch event {
            case .connected: onEvent(.connected)
            case let .audio(packet, _): audio?.play(packet)
            case let .ended(message):
                let shouldNotify = lifecycle.finish()
                audio?.cancel()
                if shouldNotify { onEvent(.ended(message)) }
            }
        }
    }

    deinit {
        self.cancel()
    }

    func startAudio() async throws {
        guard self.lifecycle.phase.withLock({ phase in
            guard phase == .idle else { return false }
            phase = .starting
            return true
        })
        else {
            throw WatchRealtimeMediaError
                .unavailable(String(localized: "This voice session has already started or stopped."))
        }
        do {
            let allowed = await PermissionRequestBridge.awaitRequest {
                AVAudioApplication.requestRecordPermission(completionHandler: $0)
            }
            try Task.checkCancellation()
            guard allowed else {
                throw WatchRealtimeMediaError
                    .unavailable(String(localized: "Allow microphone access in Settings to start voice."))
            }
            try await self.audio.start(
                onPacket: { [transport = self.transport] in transport.sendOpus($0, timestamp: $1) },
                onFailure: { [weak self] message in
                    guard let self else { return }
                    let shouldNotify = self.lifecycle.finish()
                    self.transport.cancel()
                    if shouldNotify { self.onEvent(.ended(WatchRealtimeMediaFailure(kind: .audio, message: message))) }
                })
            try Task.checkCancellation()
            guard self.lifecycle.phase.withLock({ phase in
                guard phase == .starting else { return false }
                phase = .active
                return true
            }) else { throw CancellationError() }
        } catch {
            await self.stop()
            throw error
        }
    }

    func makeOffer() async throws -> String {
        guard self.lifecycle.phase.withLock({ $0 == .active }) else {
            throw WatchRealtimeMediaError.unavailable(String(localized: "Activate voice audio before connecting."))
        }
        return try await self.transport.makeOffer()
    }

    func applyAnswer(_ sdp: String) async throws {
        try await self.transport.applyAnswer(sdp)
    }

    func setMuted(_ muted: Bool) {
        self.audio.setMuted(muted)
    }

    func cancel() {
        _ = self.lifecycle.finish()
        self.audio.cancel()
        self.transport.cancel()
    }

    func stop() async {
        self.cancel()
        await self.audio.stop()
        await self.transport.stop()
    }
}
