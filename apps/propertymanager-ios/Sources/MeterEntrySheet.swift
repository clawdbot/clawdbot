import SwiftUI

struct MeterEntrySheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: PropertyStore

    let asset: RanchAsset
    var onSaved: (RanchAsset) -> Void

    @State private var valueText = ""
    @State private var note = ""
    @State private var isSaving = false
    @State private var showLowerConfirm = false
    @State private var correctionReason = "correction"
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Reading") {
                    TextField("Value (\(asset.meter?.unit ?? ""))", text: $valueText)
                        .keyboardType(.decimalPad)
                    TextField("Note (optional)", text: $note)
                }
                if showLowerConfirm {
                    Section("Lower reading") {
                        Picker("Reason", selection: $correctionReason) {
                            Text("Correction").tag("correction")
                            Text("Meter replacement").tag("replacement")
                            Text("Rollover").tag("rollover")
                        }
                    }
                }
            }
            .navigationTitle(asset.meter?.updateButtonTitle ?? "Update Meter")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(isSaving || valueText.isEmpty)
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
    }

    private func save() async {
        guard let value = Double(valueText.replacingOccurrences(of: ",", with: ".")) else {
            errorMessage = "Enter a valid number."
            return
        }
        isSaving = true
        defer { isSaving = false }
        do {
            let updated = try await store.client.submitMeterReading(
                assetId: asset.id,
                value: value,
                note: note.isEmpty ? nil : note,
                entryMethod: "manual",
                correctionReason: showLowerConfirm ? correctionReason : nil
            )
            onSaved(updated)
            dismiss()
        } catch PropertyAPIError.serverMessage(let message) where message == "lower_reading" {
            showLowerConfirm = true
            errorMessage = "Reading is lower than current. Choose a reason and save again."
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
