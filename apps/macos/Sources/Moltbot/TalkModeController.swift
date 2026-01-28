import Observation

@MainActor
@Observable
final class TalkModeController {
    static let shared = TalkModeController()

    private let logger = Logger(subsystem: "bot.molt", category: "talk.controller")

    private(set) var phase: TalkModePhase = .idle
    private(set) var isPaused: Bool = false

    func setEnabled(_ enabled: Bool) async {
        self.logger.info("talk enabled=\(enabled)")
        if enabled {
            TalkOverlayController.shared.present()
        } else {
            TalkOverlayController.shared.dismiss()
        }
        await TalkModeRuntime.shared.setEnabled(enabled)
    }

    func updatePhase(_ phase: TalkModePhase) {
        self.phase = phase
        TalkOverlayController.shared.updatePhase(phase)
        let effectivePhase = self.isPaused ? "paused" : phase.rawValue
        Task {
            await GatewayConnection.shared.talkMode(
                enabled: AppStateStore.shared.talkEnabled,
                phase: effectivePhase)
        }
    }

    func updateLevel(_ level: Double) {
        TalkOverlayController.shared.updateLevel(level)
    }

    func setPaused(_ paused: Bool) {
        guard self.isPaused != paused else { return }
        self.logger.info("talk paused=\(paused)")
        self.isPaused = paused
        TalkOverlayController.shared.updatePaused(paused)
        let effectivePhase = paused ? "paused" : self.phase.rawValue
        Task {
            await GatewayConnection.shared.talkMode(
                enabled: AppStateStore.shared.talkEnabled,
                phase: effectivePhase)
        }
        Task { await TalkModeRuntime.shared.setPaused(paused) }
    }

    func togglePaused() {
        self.setPaused(!self.isPaused)
    }

    func stopSpeaking(reason: TalkStopReason = .userTap) {
        Task { await TalkModeRuntime.shared.stopSpeaking(reason: reason) }
    }

    func exitTalkMode() {
        Task { await AppStateStore.shared.setTalkEnabled(false) }
    }
}

enum TalkStopReason {
    case userTap
    case speech
    case manual
}
