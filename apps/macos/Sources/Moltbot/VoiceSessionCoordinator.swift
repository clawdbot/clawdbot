import AppKit
import Foundation
import Observation

@MainActor
@Observable
final class VoiceSessionCoordinator {
    static let shared = VoiceSessionCoordinator()

    enum Source: String { case wakeWord, pushToTalk }

    struct Session {
        let token: UUID
        let source: Source
        var text: String
        var attributed: NSAttributedString?
        var isFinal: Bool
        var sendChime: VoiceWakeChime
        var autoSendDelay: TimeInterval?
    }

    private let logger = Logger(subsystem: "bot.molt", category: "voicewake.coordinator")
    private var session: Session?

    // MARK: - API

    func startSession(
        source: Source,
        text: String,
        attributed: NSAttributedString? = nil,
        forwardEnabled: Bool = false) -> UUID
    {
        let token = UUID()
        self.logger.info("coordinator start token=\(token.uuidString) source=\(source.rawValue) len=\(text.count)")
        let attributedText = attributed ?? VoiceWakeOverlayController.shared.makeAttributed(from: text)
        let session = Session(
            token: token,
            source: source,
            text: text,
            attributed: attributedText,
            isFinal: false,
            sendChime: .none,
            autoSendDelay: nil)
        self.session = session
        VoiceWakeOverlayController.shared.startSession(
            token: token,
            source: VoiceWakeOverlayController.Source(rawValue: source.rawValue) ?? .wakeWord,
            transcript: text,
            attributed: attributedText,
            forwardEnabled: forwardEnabled,
            isFinal: false)
        return token
    }

    func updatePartial(token: UUID, text: String, attributed: NSAttributedString? = nil) {
        guard let session, session.token == token else { return }
        self.session?.text = text
        self.session?.attributed = attributed
        VoiceWakeOverlayController.shared.updatePartial(token: token, transcript: text, attributed: attributed)
    }

    func finalize(
        token: UUID,
        text: String,
        sendChime: VoiceWakeChime,
        autoSendAfter: TimeInterval?)
    {
        guard let session, session.token == token else { return }
        self.logger
            .info(
                "coordinator finalize token=\(token.uuidString) len=\(text.count) autoSendAfter=\(autoSendAfter ?? -1)")
        self.session?.text = text
        self.session?.isFinal = true
        self.session?.sendChime = sendChime
        self.session?.autoSendDelay = autoSendAfter

        let attributed = VoiceWakeOverlayController.shared.makeAttributed(from: text)
        VoiceWakeOverlayController.shared.presentFinal(
            token: token,
            transcript: text,
            autoSendAfter: autoSendAfter,
            sendChime: sendChime,
            attributed: attributed)
    }

    func sendNow(token: UUID, reason: String = "explicit") {
        guard let session, session.token == token else { return }
        let text = session.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            self.logger.info("coordinator sendNow \(reason) empty -> dismiss")
            VoiceWakeOverlayController.shared.dismiss(token: token, reason: .empty, outcome: .empty)
            self.clearSession()
            return
        }
        VoiceWakeOverlayController.shared.beginSendUI(token: token, sendChime: session.sendChime)
        Task.detached {
            _ = await VoiceWakeForwarder.forward(transcript: text)
        }
    }

    func dismiss(
        token: UUID,
        reason: VoiceWakeOverlayController.DismissReason,
        outcome: VoiceWakeOverlayController.SendOutcome)
    {
        guard let session, session.token == token else { return }
        VoiceWakeOverlayController.shared.dismiss(token: token, reason: reason, outcome: outcome)
        self.clearSession()
    }

    func updateLevel(token: UUID, _ level: Double) {
        guard let session, session.token == token else { return }
        VoiceWakeOverlayController.shared.updateLevel(token: token, level)
    }

    func snapshot() -> (token: UUID?, text: String, visible: Bool) {
        (self.session?.token, self.session?.text ?? "", VoiceWakeOverlayController.shared.isVisible)
    }

    // MARK: - Private

    private func clearSession() {
        self.session = nil
    }

    /// Overlay dismiss completion callback (manual X, empty, auto-dismiss after send).
    /// Ensures the wake-word recognizer is resumed if Voice Wake is enabled.
    func overlayDidDismiss(token: UUID?) {
        if let token, self.session?.token == token {
            self.clearSession()
        }
        Task { await VoiceWakeRuntime.shared.refresh(state: AppStateStore.shared) }
    }
}
