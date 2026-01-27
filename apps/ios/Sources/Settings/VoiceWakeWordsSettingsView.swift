import SwiftUI
import Combine

struct VoiceWakeWordsSettingsView: View {
    @Environment(NodeAppModel.self) private var appModel
    @State private var triggerWords: [String] = VoiceWakePreferences.loadTriggerWords()
    @FocusState private var focusedTriggerIndex: Int?
    @State private var syncTask: Task<Void, Never>?

    var body: some View {
        Form {
            Section {
                ForEach(self.triggerWords.indices, id: \.self) { index in
                    TextField("Wake word", text: self.binding(for: index))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .focused(self.$focusedTriggerIndex, equals: index)
                        .onSubmit {
                            self.commitTriggerWords()
                        }
                }
                .onDelete(perform: self.removeWords)

                Button {
                    self.addWord()
                } label: {
                    Label("Add word", systemImage: "plus")
                }
                .disabled(self.triggerWords
                    .contains(where: { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }))

                Button("Reset defaults") {
                    self.triggerWords = VoiceWakePreferences.defaultTriggerWords
                }
            } header: {
                Text("Wake Words")
            } footer: {
                Text(
                    "Moltbot reacts when any trigger appears in a transcription. "
                        + "Keep them short to avoid false positives.")
            }
        }
        .navigationTitle("Wake Words")
        .toolbar { EditButton() }
        .onAppear {
            if self.triggerWords.isEmpty {
                self.triggerWords = VoiceWakePreferences.defaultTriggerWords
                self.commitTriggerWords()
            }
        }
        .onChange(of: self.focusedTriggerIndex) { oldValue, newValue in
            guard oldValue != nil, oldValue != newValue else { return }
            self.commitTriggerWords()
        }
        .onReceive(NotificationCenter.default.publisher(for: UserDefaults.didChangeNotification)) { _ in
            guard self.focusedTriggerIndex == nil else { return }
            let updated = VoiceWakePreferences.loadTriggerWords()
            if updated != self.triggerWords {
                self.triggerWords = updated
            }
        }
    }

    private func addWord() {
        self.triggerWords.append("")
    }

    private func removeWords(at offsets: IndexSet) {
        self.triggerWords.remove(atOffsets: offsets)
        if self.triggerWords.isEmpty {
            self.triggerWords = VoiceWakePreferences.defaultTriggerWords
        }
        self.commitTriggerWords()
    }

    private func binding(for index: Int) -> Binding<String> {
        Binding(
            get: {
                guard self.triggerWords.indices.contains(index) else { return "" }
                return self.triggerWords[index]
            },
            set: { newValue in
                guard self.triggerWords.indices.contains(index) else { return }
                self.triggerWords[index] = newValue
            })
    }

    private func commitTriggerWords() {
        VoiceWakePreferences.saveTriggerWords(self.triggerWords)

        let snapshot = VoiceWakePreferences.sanitizeTriggerWords(self.triggerWords)
        self.syncTask?.cancel()
        self.syncTask = Task { [snapshot, weak appModel = self.appModel] in
            try? await Task.sleep(nanoseconds: 650_000_000)
            await appModel?.setGlobalWakeWords(snapshot)
        }
    }
}
