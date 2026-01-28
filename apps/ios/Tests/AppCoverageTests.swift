import SwiftUI
import Testing
@testable import Moltbot

@Suite struct AppCoverageTests {
    @Test @MainActor func nodeAppModelUpdatesBackgroundedState() {
        let appModel = NodeAppModel()

        appModel.setScenePhase(.background)
        #expect(appModel.isBackgrounded == true)

        appModel.setScenePhase(.inactive)
        #expect(appModel.isBackgrounded == false)

        appModel.setScenePhase(.active)
        #expect(appModel.isBackgrounded == false)
    }

    @Test @MainActor func voiceWakeStartReportsUnsupportedOnSimulator() async {
        let voiceWake = VoiceWakeManager()
        voiceWake.isEnabled = true

        await voiceWake.start()

        #expect(voiceWake.isListening == false)
        #expect(voiceWake.statusText.contains("Simulator"))

        voiceWake.stop()
        #expect(voiceWake.statusText == "Off")
    }
}
