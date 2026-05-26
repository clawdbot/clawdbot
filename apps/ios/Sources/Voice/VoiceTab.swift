import SwiftUI

struct VoiceTab: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(VoiceWakeManager.self) private var voiceWake
    @AppStorage("voiceWake.enabled") private var voiceWakeEnabled: Bool = false
    @AppStorage("talk.enabled") private var talkEnabled: Bool = false

    var body: some View {
        NavigationStack {
            List {
                if self.appModel.talkMode.gatewayTalkPermissionState.requiresTalkPermissionAction {
                    Section {
                        TalkPermissionPromptView(style: .card)
                            .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
                            .listRowBackground(Color.clear)
                    }
                }

                Section("Status") {
                    LabeledContent("Voice Wake", value: self.voiceWakeEnabled ? "Enabled" : "Disabled")
                    LabeledContent("Listener", value: self.voiceWake.isListening ? "Listening" : "Idle")
                    Text(self.voiceWake.statusText)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    LabeledContent("Talk Mode", value: self.talkEnabled ? "Enabled" : "Disabled")
                    LabeledContent(
                        "Talk Permission",
                        value: self.appModel.talkMode.gatewayTalkPermissionState.statusLabel)
                }

                Section("Notes") {
                    let triggers = self.voiceWake.activeTriggerWords
                    Group {
                        if triggers.isEmpty {
                            Text("Add wake words in Settings.")
                        } else if triggers.count == 1 {
                            Text("Say “\(triggers[0]) …” to trigger.")
                        } else if triggers.count == 2 {
                            Text("Say “\(triggers[0]) …” or “\(triggers[1]) …” to trigger.")
                        } else {
                            Text("Say “\(triggers.joined(separator: " …”, “")) …” to trigger.")
                        }
                    }
                    .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Voice")
            .onChange(of: self.voiceWakeEnabled) { _, newValue in
                self.appModel.setVoiceWakeEnabled(newValue)
            }
            .onChange(of: self.talkEnabled) { _, newValue in
                self.appModel.setTalkEnabled(newValue)
            }
        }
    }
}
