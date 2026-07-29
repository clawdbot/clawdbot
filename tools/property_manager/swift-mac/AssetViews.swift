import SwiftUI

struct MacAssetsPanel: View {
    @ObservedObject var store: MaintenanceStore
    @State private var selectedAssetId: UUID?

    var meteredAssets: [MacRanchAsset] {
        store.assets.filter { $0.meter?.hasMeter == true || $0.meterNeedsActivation }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Assets")
                    .font(.title2.bold())
                Spacer()
                Button {
                    Task { await store.refreshAssets() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
            }
            .padding()

            List(selection: $selectedAssetId) {
                ForEach(meteredAssets) { asset in
                    VStack(alignment: .leading) {
                        Text(asset.name).font(.headline)
                        if asset.meterNeedsActivation {
                            Text("Meter proposed — activate")
                                .font(.caption)
                                .foregroundStyle(.orange)
                        } else if let meter = asset.meter {
                            Text("\(format(meter.currentValue)) \(meter.unit)")
                                .foregroundStyle(.secondary)
                        }
                    }
                    .tag(asset.id as UUID?)
                }
            }

            if let asset = meteredAssets.first(where: { $0.id == selectedAssetId }) {
                Divider()
                MacAssetDetailPanel(asset: asset, store: store)
            }
        }
        .task { await store.refreshAssets() }
    }

    private func format(_ value: Double?) -> String {
        guard let value else { return "—" }
        return value.truncatingRemainder(dividingBy: 1) == 0 ? String(format: "%.0f", value) : String(format: "%.1f", value)
    }
}

struct MacAssetDetailPanel: View {
    let asset: MacRanchAsset
    @ObservedObject var store: MaintenanceStore
    @State private var valueText = ""
    @State private var note = ""
    @State private var pendingPreview: MacLowerReadingPreview?
    @State private var correctionReason = "correction"
    @State private var readings: [MacMeterReading] = []
    @State private var message: String?
    @State private var isActivating = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(asset.name).font(.title3.bold())

                if asset.meterNeedsActivation {
                    GroupBox("Proposed meter") {
                        if let proposed = asset.proposedMeter {
                            Text("Type: \(proposed.meterType ?? "none"), unit: \(proposed.unit ?? "—")")
                        }
                        Button("Activate meter") {
                            Task { await activateMeter() }
                        }
                        .disabled(isActivating)
                    }
                }

                if let meter = asset.meter, meter.hasMeter {
                    Text("\(format(meter.currentValue)) \(meter.unit)")
                        .font(.system(size: 36, weight: .bold))
                }

                GroupBox("New reading") {
                    TextField("Value", text: $valueText)
                    TextField("Note", text: $note)
                    if let preview = pendingPreview {
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
                    Button(pendingPreview == nil ? "Save reading" : "Confirm reading") {
                        Task { await saveReading() }
                    }
                    .disabled(valueText.isEmpty)
                }

                if let tasks = asset.tasks?.filter({ $0.remainingMeter != nil }), !tasks.isEmpty {
                    GroupBox("Upcoming service") {
                        ForEach(tasks) { task in
                            HStack {
                                Text(task.item)
                                Spacer()
                                if task.overdueMeter == true {
                                    Text("Overdue").foregroundStyle(.red)
                                } else if let r = task.remainingMeter {
                                    Text("\(format(r)) left").foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
                if let message {
                    Text(message).foregroundStyle(.secondary).font(.caption)
                }
            }
            .padding()
        }
        .task { await loadReadings() }
    }

    private func loadReadings() async {
        do {
            readings = try await store.apiClient.fetchMeterReadings(assetId: asset.id)
        } catch {
            message = error.localizedDescription
        }
    }

    private func saveReading() async {
        guard let value = Double(valueText.replacingOccurrences(of: ",", with: ".")) else { return }
        do {
            if let preview = pendingPreview {
                _ = try await store.apiClient.confirmMeterReading(
                    assetId: asset.id,
                    preview: preview,
                    correctionReason: correctionReason,
                    note: note.isEmpty ? nil : note
                )
                message = "Confirmed."
                pendingPreview = nil
            } else {
                _ = try await store.apiClient.submitMeterReading(
                    assetId: asset.id,
                    value: value,
                    note: note.isEmpty ? nil : note
                )
                message = "Saved."
            }
            await store.refreshAssets()
            await loadReadings()
        } catch MacMeterError.lowerReadingConfirmation(let preview) {
            pendingPreview = preview
            message = "Lower than current — choose reason and confirm."
        } catch {
            message = error.localizedDescription
        }
    }

    private func activateMeter() async {
        isActivating = true
        defer { isActivating = false }
        do {
            _ = try await store.apiClient.activateMeter(assetId: asset.id)
            message = "Meter activated."
            await store.refreshAssets()
        } catch {
            message = error.localizedDescription
        }
    }

    private func format(_ value: Double?) -> String {
        guard let value else { return "—" }
        return value.truncatingRemainder(dividingBy: 1) == 0 ? String(format: "%.0f", value) : String(format: "%.1f", value)
    }
}
