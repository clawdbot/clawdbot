import AppKit
import QuartzCore

extension VoiceWakeOverlayController {
    @discardableResult
    func startSession(
        token: UUID = UUID(),
        source: Source,
        transcript: String,
        attributed: NSAttributedString? = nil,
        forwardEnabled: Bool = false,
        isFinal: Bool = false) -> UUID
    {
        let message = """
        overlay session_start source=\(source.rawValue) \
        len=\(transcript.count)
        """
        self.logger.log(level: .info, "\(message)")
        self.activeToken = token
        self.activeSource = source
        self.autoSendTask?.cancel(); self.autoSendTask = nil; self.autoSendToken = nil
        self.model.text = transcript
        self.model.isFinal = isFinal
        self.model.forwardEnabled = forwardEnabled
        self.model.isSending = false
        self.model.isEditing = false
        self.model.attributed = attributed ?? self.makeAttributed(from: transcript)
        self.model.level = 0
        self.lastLevelUpdate = 0
        self.present()
        self.updateWindowFrame(animate: true)
        return token
    }

    func snapshot() -> (token: UUID?, source: Source?, text: String, isVisible: Bool) {
        (self.activeToken, self.activeSource, self.model.text, self.model.isVisible)
    }

    func updatePartial(token: UUID, transcript: String, attributed: NSAttributedString? = nil) {
        guard self.guardToken(token, context: "partial") else { return }
        guard !self.model.isFinal else { return }
        let message = """
        overlay partial token=\(token.uuidString) \
        len=\(transcript.count)
        """
        self.logger.log(level: .info, "\(message)")
        self.autoSendTask?.cancel(); self.autoSendTask = nil; self.autoSendToken = nil
        self.model.text = transcript
        self.model.isFinal = false
        self.model.forwardEnabled = false
        self.model.isSending = false
        self.model.isEditing = false
        self.model.attributed = attributed ?? self.makeAttributed(from: transcript)
        self.model.level = 0
        self.present()
        self.updateWindowFrame(animate: true)
    }

    func presentFinal(
        token: UUID,
        transcript: String,
        autoSendAfter delay: TimeInterval?,
        sendChime: VoiceWakeChime = .none,
        attributed: NSAttributedString? = nil)
    {
        guard self.guardToken(token, context: "final") else { return }
        let message = """
        overlay presentFinal token=\(token.uuidString) \
        len=\(transcript.count) \
        autoSendAfter=\(delay ?? -1) \
        forwardEnabled=\(!transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        """
        self.logger.log(level: .info, "\(message)")
        self.autoSendTask?.cancel()
        self.autoSendToken = token
        self.model.text = transcript
        self.model.isFinal = true
        self.model.forwardEnabled = !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        self.model.isSending = false
        self.model.isEditing = false
        self.model.attributed = attributed ?? self.makeAttributed(from: transcript)
        self.model.level = 0
        self.present()
        if let delay {
            if delay <= 0 {
                self.logger.log(level: .info, "overlay autoSend immediate token=\(token.uuidString)")
                VoiceSessionCoordinator.shared.sendNow(token: token, reason: "autoSendImmediate")
            } else {
                self.scheduleAutoSend(token: token, after: delay)
            }
        }
    }

    func userBeganEditing() {
        self.autoSendTask?.cancel()
        self.model.isSending = false
        self.model.isEditing = true
    }

    func cancelEditingAndDismiss() {
        self.autoSendTask?.cancel()
        self.model.isSending = false
        self.model.isEditing = false
        self.dismiss(reason: .explicit)
    }

    func endEditing() {
        self.model.isEditing = false
    }

    func updateText(_ text: String) {
        self.model.text = text
        self.model.isSending = false
        self.model.attributed = self.makeAttributed(from: text)
        self.updateWindowFrame(animate: true)
    }

    /// UI-only path: show sending state and dismiss; actual forwarding is handled by the coordinator.
    func beginSendUI(token: UUID, sendChime: VoiceWakeChime = .none) {
        guard self.guardToken(token, context: "beginSendUI") else { return }
        self.autoSendTask?.cancel(); self.autoSendToken = nil
        let message = """
        overlay beginSendUI token=\(token.uuidString) \
        isSending=\(self.model.isSending) \
        forwardEnabled=\(self.model.forwardEnabled) \
        textLen=\(self.model.text.count)
        """
        self.logger.log(level: .info, "\(message)")
        if self.model.isSending { return }
        self.model.isEditing = false

        if sendChime != .none {
            let message = "overlay beginSendUI playing sendChime=\(String(describing: sendChime))"
            self.logger.log(level: .info, "\(message)")
            VoiceWakeChimePlayer.play(sendChime, reason: "overlay.send")
        }

        self.model.isSending = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.28) {
            self.logger.log(
                level: .info,
                "overlay beginSendUI dismiss ticking token=\(self.activeToken?.uuidString ?? "nil")")
            self.dismiss(token: token, reason: .explicit, outcome: .sent)
        }
    }

    func requestSend(token: UUID? = nil, reason: String = "overlay_request") {
        guard self.guardToken(token, context: "requestSend") else { return }
        guard let active = token ?? self.activeToken else { return }
        VoiceSessionCoordinator.shared.sendNow(token: active, reason: reason)
    }

    func dismiss(token: UUID? = nil, reason: DismissReason = .explicit, outcome: SendOutcome = .empty) {
        guard self.guardToken(token, context: "dismiss") else { return }
        let message = """
        overlay dismiss token=\(self.activeToken?.uuidString ?? "nil") \
        reason=\(String(describing: reason)) \
        outcome=\(String(describing: outcome)) \
        visible=\(self.model.isVisible) \
        sending=\(self.model.isSending)
        """
        self.logger.log(level: .info, "\(message)")
        self.autoSendTask?.cancel(); self.autoSendToken = nil
        self.model.isSending = false
        self.model.isEditing = false

        if !self.enableUI {
            self.model.isVisible = false
            self.model.level = 0
            self.lastLevelUpdate = 0
            self.activeToken = nil
            self.activeSource = nil
            return
        }
        guard let window else {
            if ProcessInfo.processInfo.isRunningTests {
                self.model.isVisible = false
                self.model.level = 0
                self.activeToken = nil
                self.activeSource = nil
            }
            return
        }
        let target = self.dismissTargetFrame(for: window.frame, reason: reason, outcome: outcome)
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.18
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            if let target {
                window.animator().setFrame(target, display: true)
            }
            window.animator().alphaValue = 0
        } completionHandler: {
            Task { @MainActor in
                let dismissedToken = self.activeToken
                window.orderOut(nil)
                self.model.isVisible = false
                self.model.level = 0
                self.lastLevelUpdate = 0
                self.activeToken = nil
                self.activeSource = nil
                if outcome == .empty {
                    AppStateStore.shared.blinkOnce()
                } else if outcome == .sent {
                    AppStateStore.shared.celebrateSend()
                }
                AppStateStore.shared.stopVoiceEars()
                VoiceSessionCoordinator.shared.overlayDidDismiss(token: dismissedToken)
            }
        }
    }

    func updateLevel(token: UUID, _ level: Double) {
        guard self.guardToken(token, context: "level") else { return }
        guard self.model.isVisible else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if level != 0, now - self.lastLevelUpdate < self.levelUpdateInterval {
            return
        }
        self.lastLevelUpdate = now
        self.model.level = max(0, min(1, level))
    }

    private func guardToken(_ token: UUID?, context: String) -> Bool {
        switch Self.evaluateToken(active: self.activeToken, incoming: token) {
        case .accept:
            return true
        case .dropMismatch:
            self.logger.log(
                level: .info,
                """
                overlay drop \(context, privacy: .public) token_mismatch \
                active=\(self.activeToken?.uuidString ?? "nil", privacy: .public) \
                got=\(token?.uuidString ?? "nil", privacy: .public)
                """)
            return false
        case .dropNoActive:
            self.logger.log(level: .info, "overlay drop \(context, privacy: .public) no_active")
            return false
        }
    }

    nonisolated static func evaluateToken(active: UUID?, incoming: UUID?) -> GuardOutcome {
        guard let active else { return .dropNoActive }
        if let incoming, incoming != active { return .dropMismatch }
        return .accept
    }

    func scheduleAutoSend(token: UUID, after delay: TimeInterval) {
        self.logger.log(
            level: .info,
            """
            overlay scheduleAutoSend token=\(token.uuidString) \
            after=\(delay)
            """)
        self.autoSendTask?.cancel()
        self.autoSendToken = token
        self.autoSendTask = Task<Void, Never> { [weak self, token] in
            let nanos = UInt64(max(0, delay) * 1_000_000_000)
            try? await Task.sleep(nanoseconds: nanos)
            guard !Task.isCancelled else { return }
            await MainActor.run {
                guard let self else { return }
                guard self.guardToken(token, context: "autoSend") else { return }
                self.logger.log(
                    level: .info,
                    "overlay autoSend firing token=\(token.uuidString, privacy: .public)")
                VoiceSessionCoordinator.shared.sendNow(token: token, reason: "autoSendDelay")
                self.autoSendTask = nil
            }
        }
    }

    func makeAttributed(from text: String) -> NSAttributedString {
        NSAttributedString(
            string: text,
            attributes: [
                .foregroundColor: NSColor.labelColor,
                .font: NSFont.systemFont(ofSize: 13, weight: .regular),
            ])
    }
}
