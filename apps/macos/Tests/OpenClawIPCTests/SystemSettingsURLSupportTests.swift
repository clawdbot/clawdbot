import OpenClawIPC
import Testing
@testable import OpenClaw

struct SystemSettingsURLSupportTests {
    @Test(arguments: [
        (Capability.microphone, "Privacy_Microphone"),
        (.speechRecognition, "Privacy_SpeechRecognition"),
        (.camera, "Privacy_Camera"),
        (.location, "Privacy_LocationServices"),
        (.accessibility, "Privacy_Accessibility"),
        (.screenRecording, "Privacy_ScreenCapture"),
        (.appleScript, "Privacy_Automation"),
        (.notifications, "com.apple.Notifications-Settings.extension"),
    ])
    func `explicit settings links start at the capability pane`(capability: Capability, pane: String) throws {
        let candidates = SystemSettingsURLSupport.settingsCandidates(for: capability)
        #expect(try #require(candidates.first).contains(pane))
    }

    @Test(arguments: [Capability.microphone, .speechRecognition, .camera, .location])
    func `explicit links preserve privacy recovery candidates`(capability: Capability) {
        #expect(SystemSettingsURLSupport.settingsCandidates(for: capability) ==
            SystemSettingsURLSupport.privacySettingsCandidates(for: capability))
    }
}
