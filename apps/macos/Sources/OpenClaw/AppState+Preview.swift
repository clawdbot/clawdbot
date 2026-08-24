import Foundation

extension AppState {
    static var preview: AppState {
        let state = AppState(preview: true)
        state.isPaused = false
        state.launchAtLogin = true
        state.onboardingSeen = true
        state.debugPaneEnabled = true
        state.nativeSettingsPanesEnabled = true
        state.swabbleEnabled = true
        state.swabbleTriggerWords = ["Claude", "Computer", "Jarvis"]
        state.voiceWakeTriggerChime = .system(name: "Glass")
        state.voiceWakeSendChime = .system(name: "Ping")
        state.iconAnimationsEnabled = true
        state.showDockIcon = true
        state.voiceWakeMicID = "BuiltInMic"
        state.voiceWakeMicName = "Built-in Microphone"
        state.voiceWakeLocaleID = Locale.current.identifier
        state.voiceWakeAdditionalLocaleIDs = ["en-US", "de-DE"]
        state.voicePushToTalkEnabled = false
        state.talkEnabled = false
        state.talkRealtimeRelayEnabled = false
        state.talkPhaseSoundsEnabled = true
        state.talkShiftToStopEnabled = true
        state.iconOverride = .system
        state.heartbeatsEnabled = true
        state.connectionMode = .local
        state.remoteTransport = .ssh
        state.canvasEnabled = true
        state.quickChatEnabled = true
        state.cookieSyncEnabled = false
        state.cookieSyncIntoProfile = "imported"
        state.cookieSyncDomains = []
        state.remoteTarget = "user@example.com"
        state.remoteUrl = "wss://gateway.example.ts.net"
        state.remoteToken = "example-token"
        state.remoteIdentity = "~/.ssh/id_ed25519"
        state.remoteProjectRoot = "~/Projects/openclaw"
        state.remoteCliPath = ""
        return state
    }
}
