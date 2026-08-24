import Foundation

extension AppState {
    func persistTalkRealtimeRelayPreference(previousValue: Bool) {
        guard !self.isPreview else { return }
        AppDefaults.standard.set(self.talkRealtimeRelayEnabled, forKey: talkRealtimeRelayEnabledKey)
        guard self.talkEnabled, self.talkRealtimeRelayEnabled != previousValue else { return }
        Task { await TalkModeRuntime.shared.realtimeRelayPreferenceDidChange() }
    }
}
