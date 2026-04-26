import AppKit
import Observation

@MainActor
@Observable
final class TalkModeController {
    static let shared = TalkModeController()

    private let logger = Logger(subsystem: "ai.openclaw", category: "talk.controller")

    private(set) var phase: TalkModePhase = .idle
    private(set) var isPaused: Bool = false

    func setEnabled(_ enabled: Bool) async {
        self.logger.info("talk enabled=\(enabled)")
        if enabled {
            TalkOverlayController.shared.present()
        } else {
            TalkOverlayController.shared.dismiss()
        }
        TalkSpeechInterruptMonitor.shared.setEnabled(enabled && AppStateStore.shared.talkShiftToStopEnabled)
        // Talk Mode and Push-to-Talk share the right Option key — disable PTT while Talk Mode is active.
        let pttEnabled = !enabled && AppStateStore.shared.voicePushToTalkEnabled
        VoicePushToTalkHotkey.shared.setEnabled(pttEnabled)
        await TalkModeRuntime.shared.setEnabled(enabled)
        // Resume voice wake listener *after* TalkMode audio is fully torn down.
        // Check swabbleEnabled (not voiceWakeTriggersTalkMode) so the paused wake listener
        // resumes even if the user toggled "Trigger Talk Mode" off during the session.
        if !enabled, AppStateStore.shared.swabbleEnabled {
            Task { await VoiceWakeRuntime.shared.refresh(state: AppStateStore.shared) }
        }
    }

    func updatePhase(_ phase: TalkModePhase) {
        let previousPhase = self.phase
        self.phase = phase
        TalkOverlayController.shared.updatePhase(phase)

        // Play distinct system sounds for each phase transition.
        if phase != previousPhase {
            Self.playPhaseSound(phase, previousPhase: previousPhase)
        }

        let effectivePhase = self.isPaused ? "paused" : phase.rawValue
        Task {
            await GatewayConnection.shared.talkMode(
                enabled: AppStateStore.shared.talkEnabled,
                phase: effectivePhase)
        }
    }

    private static func playPhaseSound(_ phase: TalkModePhase, previousPhase: TalkModePhase) {
        guard AppStateStore.shared.talkPhaseSoundsEnabled else { return }
        let soundName: String? = switch phase {
        case .thinking:
            "Tink" // 생각 중: 짧고 가벼운 소리
        case .speaking:
            "Pop" // 대답 시작: 톡 소리
        case .listening:
            // 대답 중단(speaking→listening): 부드러운 종료음
            // 듣기 시작(thinking→listening 등): 잠수함 소리
            previousPhase == .speaking ? "Bottle" : "Submarine"
        case .idle:
            nil
        }
        if let soundName {
            NSSound(named: NSSound.Name(soundName))?.play()
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
