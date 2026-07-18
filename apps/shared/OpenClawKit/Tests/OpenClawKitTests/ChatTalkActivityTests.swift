import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatTalkControlTests {
    @Test func `legacy initializer shape receives additive feedback defaults`() {
        let control = OpenClawChatTalkControl(
            isEnabled: false,
            isListening: false,
            isSpeaking: false,
            isGatewayConnected: true,
            statusText: "Off",
            providerLabel: "",
            toggle: { _ in })

        #expect(control.level == 0)
        #expect(control.partialTranscript.isEmpty)
        #expect(control.recentTranscript.isEmpty)
        #expect(control.inputDevices.isEmpty)
        #expect(control.selectedInputDeviceID == nil)
        #expect(control.selectInputDevice == nil)
    }

    @Test func `feedback and input selection fields preserve supplied values`() {
        var selectedID: String? = "unchanged"
        let devices = [OpenClawChatAudioInputDevice(id: "mic-1", name: "Desk Mic")]
        let control = OpenClawChatTalkControl(
            isEnabled: true,
            isListening: true,
            isSpeaking: false,
            isGatewayConnected: true,
            statusText: "Listening",
            providerLabel: "",
            level: 0.6,
            partialTranscript: "hello",
            recentTranscript: ["earlier"],
            inputDevices: devices,
            selectedInputDeviceID: "mic-1",
            selectInputDevice: { selectedID = $0 },
            toggle: { _ in })

        control.selectInputDevice?(nil)

        #expect(control.level == 0.6)
        #expect(control.partialTranscript == "hello")
        #expect(control.recentTranscript == ["earlier"])
        #expect(control.inputDevices == devices)
        #expect(control.selectedInputDeviceID == "mic-1")
        #expect(selectedID == nil)
    }
}

struct ChatTalkTranscriptStripModelTests {
    @Test func `model trims blanks bounds finals and prefers partial preview`() {
        let model = ChatTalkTranscriptStripModel(
            recentTranscript: [" ", " first ", "second", "third"],
            partialTranscript: " live words ",
            limit: 2)

        #expect(model.recentTranscript == ["second", "third"])
        #expect(model.partialTranscript == "live words")
        #expect(model.collapsedText == "live words")
        #expect(model.hasTranscript)
    }

    @Test func `model falls back to latest final and hides empty transcript`() {
        let finalOnly = ChatTalkTranscriptStripModel(
            recentTranscript: ["first", "second"],
            partialTranscript: "")
        let empty = ChatTalkTranscriptStripModel(
            recentTranscript: ["  "],
            partialTranscript: "\n")

        #expect(finalOnly.collapsedText == "second")
        #expect(empty.collapsedText == nil)
        #expect(!empty.hasTranscript)
    }
}
