import OpenClawKit
import SwiftUI
import Testing
@testable import OpenClaw

struct AppCoverageTests {
    @Test @MainActor func `node app model updates backgrounded state`() {
        let appModel = NodeAppModel()

        appModel.setScenePhase(.background)
        #expect(appModel.isBackgrounded == true)

        appModel.setScenePhase(.inactive)
        #expect(appModel.isBackgrounded == true)

        appModel.setScenePhase(.active)
        #expect(appModel.isBackgrounded == false)
    }

    @Test @MainActor func `initial scene admission stays closed until active`() async {
        let talkMode = TalkModeManager(allowSimulatorCapture: true)
        let appModel = NodeAppModel(
            talkMode: talkMode,
            audioAdmissionInitiallyAllowed: false)
        talkMode.updateGatewayConnected(true)

        #expect(appModel.isBackgrounded)
        #expect(appModel.voiceWake._test_isSuppressedForBackground())
        let blocked = await appModel._test_handleInvoke(BridgeInvokeRequest(
            id: "initial-scene-blocked",
            command: OpenClawTalkCommand.pttStart.rawValue))
        #expect(!blocked.ok)

        appModel.setScenePhase(.active)

        #expect(!appModel.isBackgrounded)
        #expect(!appModel.voiceWake._test_isSuppressedForBackground())
        let admitted = await appModel._test_handleInvoke(BridgeInvokeRequest(
            id: "initial-scene-active",
            command: OpenClawTalkCommand.pttStart.rawValue))
        #expect(admitted.ok)
        _ = await appModel._test_handleInvoke(BridgeInvokeRequest(
            id: "initial-scene-cleanup",
            command: OpenClawTalkCommand.pttCancel.rawValue))
    }

    @Test @MainActor func `voice wake start reports unsupported on simulator`() async {
        let voiceWake = VoiceWakeManager()
        voiceWake.isEnabled = true

        await voiceWake.start()

        #expect(voiceWake.isListening == false)
        #expect(voiceWake.statusText.contains("Simulator"))

        voiceWake.stop()
        #expect(voiceWake.statusText == "Off")
    }
}
