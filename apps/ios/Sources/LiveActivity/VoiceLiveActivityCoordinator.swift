import Observation

/// Keeps Talk's ActivityKit presentation alive independently of whichever app
/// surface is mounted. Chat, Control, and iPad can all start Talk, so no view
/// may own this lifecycle.
@MainActor
final class VoiceLiveActivityCoordinator {
    private weak var appModel: NodeAppModel?

    func start(appModel: NodeAppModel) {
        guard self.appModel == nil else { return }
        self.appModel = appModel
        self.syncPresentation()
        self.observePresentationState()
        self.observeAudioLevel()
    }

    private func observePresentationState() {
        guard let appModel else { return }
        withObservationTracking {
            _ = appModel.talkMode.isEnabled
            _ = appModel.talkMode.statusText
            _ = appModel.talkMode.isSpeaking
            _ = appModel.talkMode.isListening
            _ = appModel.chatSessionKey
            _ = appModel.chatAgentName
            _ = appModel.chatAgentAvatarText
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.syncPresentation()
                self.observePresentationState()
            }
        }
    }

    private func observeAudioLevel() {
        guard let appModel else { return }
        withObservationTracking {
            _ = appModel.talkMode.isSpeaking
            _ = appModel.talkMode.isListening
            _ = appModel.talkMode.playbackLevel
            _ = appModel.talkMode.micLevel
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.syncAudioLevel()
                self.observeAudioLevel()
            }
        }
    }

    private func syncPresentation() {
        guard let appModel else { return }
        guard appModel.talkMode.isEnabled else {
            LiveActivityManager.shared.endVoice()
            return
        }
        LiveActivityManager.shared.showVoice(
            statusText: appModel.talkMode.statusText,
            isListening: appModel.talkMode.isListening,
            isSpeaking: appModel.talkMode.isSpeaking,
            audioLevel: Self.currentAudioLevel(appModel: appModel),
            agentName: appModel.chatAgentName,
            agentBadge: AgentIdentityPresentation.badge(
                avatarText: appModel.chatAgentAvatarText,
                displayName: appModel.chatAgentName),
            sessionKey: appModel.chatSessionKey)
    }

    private func syncAudioLevel() {
        guard let appModel else { return }
        LiveActivityManager.shared.updateVoiceLevel(Self.currentAudioLevel(appModel: appModel))
    }

    private static func currentAudioLevel(appModel: NodeAppModel) -> Double? {
        if appModel.talkMode.isSpeaking {
            return appModel.talkMode.playbackLevel
        }
        if appModel.talkMode.isListening {
            return appModel.talkMode.micLevel
        }
        return nil
    }
}
