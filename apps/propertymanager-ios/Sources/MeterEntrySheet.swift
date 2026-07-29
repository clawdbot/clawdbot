import SwiftUI

struct MeterEntrySheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var store: PropertyStore

    let asset: RanchAsset
    var onSaved: (RanchAsset) -> Void

    @State private var valueText = ""
    @State private var note = ""
    @State private var isSaving = false
    @State private var pendingPreview: LowerReadingPreview?
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
                if let preview = pendingPreview {
                    Section("Lower reading confirmation") {
                        if let prev = preview.previousValue, let proposed = preview.proposedValue {
                            Text("Previous: \(prev) → Proposed: \(proposed)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Picker("Reason", selection: $correctionReason) {
                            ForEach(preview.options ?? ["correction", "replacement", "rollover"], id: \.self) { opt in
                                Text(opt.capitalized).tag(opt)
                            }
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
                    Button(pendingPreview == nil ? "Save" : "Confirm") {
                        Task { await save() }
                    }
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
            if let preview = pendingPreview {
                let updated = try await store.client.confirmMeterReading(
                    assetId: asset.id,
                    preview: preview,
                    correctionReason: correctionReason,
                    note: note.isEmpty ? nil : note
                )
                onSaved(updated)
                dismiss()
            } else {
                let updated = try await store.client.submitMeterReading(
                    assetId: asset.id,
                    value: value,
                    note: note.isEmpty ? nil : note,
                    entryMethod: "manual"
                )
                onSaved(updated)
                dismiss()
            }
        } catch PropertyAPIError.lowerReadingConfirmation(let preview) {
            pendingPreview = preview
            errorMessage = "Reading is lower than current. Choose a reason and tap Confirm."
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
