import AppIntents

struct StartLiveVoiceIntent: AppIntent {
    static let title: LocalizedStringResource = "Start Live Voice"
    // periphery:ignore - App Intents consumes this metadata for Siri and Shortcuts.
    static let description: IntentDescription? = IntentDescription(
        "Open the current chat in OpenClaw and start a voice conversation.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        OpenClawAppModelRegistry.requestLiveVoiceStart()
        return .result()
    }
}

struct OpenClawShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartLiveVoiceIntent(),
            phrases: ["Start live voice with \(.applicationName)"],
            shortTitle: "Start Live Voice",
            systemImageName: "waveform")
    }
}
