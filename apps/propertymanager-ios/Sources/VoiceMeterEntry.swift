import SwiftUI
import Speech
import AVFoundation

struct VoiceMeterEntrySheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: PropertyStore

    var onSaved: (RanchAsset) -> Void

    @State private var transcript = ""
    @State private var parseResult: MeterParseResult?
    @State private var isListening = false
    @State private var isSaving = false
    @State private var pendingPreview: LowerReadingPreview?
    @State private var correctionReason = "correction"
    @State private var errorMessage: String?
    @State private var speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    @State private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    @State private var recognitionTask: SFSpeechRecognitionTask?
    @State private var audioEngine = AVAudioEngine()

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text("Say something like:")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("\"The DR mower now has 127.4 hours.\"")
                    .font(.subheadline)

                TextEditor(text: $transcript)
                    .frame(minHeight: 100)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.3)))

                Button {
                    Task { await toggleListening() }
                } label: {
                    Label(isListening ? "Stop" : "Start voice", systemImage: isListening ? "stop.circle.fill" : "mic.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)

                if let parseResult {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Matched: \(parseResult.assetName ?? "Asset")")
                        Text("Value: \(parseResult.value, specifier: "%.1f") \(parseResult.unit ?? "")")
                    }
                    .font(.subheadline)
                }

                if pendingPreview != nil {
                    Picker("Correction reason", selection: $correctionReason) {
                        ForEach(pendingPreview?.options ?? ["correction"], id: \.self) { opt in
                            Text(opt.capitalized).tag(opt)
                        }
                    }
                }

                Spacer()
            }
            .padding()
            .navigationTitle("Voice entry")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(pendingPreview == nil ? "Use" : "Confirm") {
                        Task { await parseAndSubmit() }
                    }
                    .disabled(transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving)
                }
            }
            .alert("Error", isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(errorMessage ?? "")
            }
        }
        .onDisappear { stopListening() }
    }

    private func parseAndSubmit() async {
        isSaving = true
        defer { isSaving = false }
        do {
            let result = parseResult ?? (try await store.client.parseMeterText(transcript))
            parseResult = result

            if let preview = pendingPreview {
                let updated = try await store.client.confirmMeterReading(
                    assetId: result.assetId,
                    preview: preview,
                    correctionReason: correctionReason,
                    note: transcript
                )
                onSaved(updated)
                dismiss()
            } else {
                let updated = try await store.client.submitMeterReading(
                    assetId: result.assetId,
                    value: result.value,
                    note: transcript,
                    entryMethod: "voice"
                )
                onSaved(updated)
                dismiss()
            }
        } catch PropertyAPIError.lowerReadingConfirmation(let preview) {
            pendingPreview = preview
            if parseResult == nil, let result = try? await store.client.parseMeterText(transcript) {
                parseResult = result
            }
            errorMessage = "Reading is lower than current. Choose a reason and tap Confirm."
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func toggleListening() async {
        if isListening {
            stopListening()
            return
        }
        let auth = await withCheckedContinuation { (cont: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
            SFSpeechRecognizer.requestAuthorization { status in cont.resume(returning: status) }
        }
        guard auth == .authorized else {
            errorMessage = "Speech recognition permission denied."
            return
        }
        do {
            try startListening()
            isListening = true
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func startListening() throws {
        stopListening()
        recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        guard let recognitionRequest else { return }
        recognitionRequest.shouldReportPartialResults = true
        let inputNode = audioEngine.inputNode
        recognitionTask = speechRecognizer?.recognitionTask(with: recognitionRequest) { result, error in
            if let result {
                transcript = result.bestTranscription.formattedString
            }
            if error != nil {
                stopListening()
            }
        }
        let format = inputNode.outputFormat(forBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            recognitionRequest.append(buffer)
        }
        audioEngine.prepare()
        try audioEngine.start()
    }

    private func stopListening() {
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionRequest = nil
        recognitionTask = nil
        isListening = false
    }
}
