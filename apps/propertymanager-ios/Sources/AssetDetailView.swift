import SwiftUI

struct AssetDetailView: View {
    @EnvironmentObject private var store: PropertyStore
    let assetId: UUID

    @State private var asset: RanchAsset?
    @State private var readings: [MeterReading] = []
    @State private var showMeterSheet = false
    @State private var showVoiceSheet = false
    @State private var isActivating = false
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let asset {
                    if asset.meterNeedsActivation {
                        proposedMeterBanner(asset)
                    }
                    meterCard(asset)
                    serviceCard(asset)
                    historyCard
                } else {
                    ProgressView()
                }
            }
            .padding()
        }
        .navigationTitle(asset?.name ?? "Asset")
        .toolbar {
            if asset?.meter?.hasMeter == true {
                ToolbarItemGroup(placement: .primaryAction) {
                    Button {
                        showVoiceSheet = true
                    } label: {
                        Image(systemName: "mic.fill")
                    }
                    Button(asset?.meter?.updateButtonTitle ?? "Update Meter") {
                        showMeterSheet = true
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
        }
        .sheet(isPresented: $showMeterSheet) {
            if let asset {
                MeterEntrySheet(asset: asset) { updated in
                    self.asset = updated
                    Task { await loadReadings() }
                }
            }
        }
        .sheet(isPresented: $showVoiceSheet) {
            VoiceMeterEntrySheet { updated in
                self.asset = updated
                Task { await loadReadings() }
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
        .task {
            await loadAsset()
        }
    }

    @ViewBuilder
    private func proposedMeterBanner(_ asset: RanchAsset) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Meter proposed — review and activate")
                .font(.headline)
            if let proposed = asset.proposedMeter {
                Text("Type: \(proposed.meterType ?? "none"), unit: \(proposed.unit ?? "—")")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Button {
                Task { await activateMeter() }
            } label: {
                if isActivating {
                    ProgressView()
                } else {
                    Text("Activate meter")
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(isActivating)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color.orange.opacity(0.15))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder
    private func meterCard(_ asset: RanchAsset) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Current reading")
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline) {
                Text(formatValue(asset.meter?.currentValue))
                    .font(.system(size: 44, weight: .bold))
                Text(asset.meter?.unit ?? "")
                    .font(.title2)
                    .foregroundStyle(.secondary)
            }
            if asset.meter?.hasMeter == true {
                Button(asset.meter?.updateButtonTitle ?? "Update Meter") {
                    showMeterSheet = true
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .frame(maxWidth: .infinity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder
    private func serviceCard(_ asset: RanchAsset) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Upcoming service")
                .font(.headline)
            if let tasks = asset.tasks?.filter({ $0.remainingMeter != nil }), !tasks.isEmpty {
                ForEach(tasks) { task in
                    HStack {
                        Text(task.item)
                        Spacer()
                        if task.overdueMeter == true {
                            Text("Overdue")
                                .foregroundStyle(.red)
                        } else if let remaining = task.remainingMeter {
                            Text("\(formatValue(remaining)) \(asset.meter?.unit ?? "") left")
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } else {
                Text("No meter-based tasks linked yet.")
                    .foregroundStyle(.secondary)
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder
    private var historyCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Reading history")
                .font(.headline)
            if readings.isEmpty {
                Text("No readings yet.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(readings.prefix(10)) { reading in
                    HStack {
                        Text(formatValue(reading.value))
                        Spacer()
                        Text(reading.readingAt, style: .date)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let usage = reading.usageSincePrevious {
                        Text("+\(formatValue(usage)) since previous")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding()
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func loadAsset() async {
        do {
            asset = try await store.client.fetchAsset(id: assetId)
            await loadReadings()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func loadReadings() async {
        do {
            readings = try await store.client.fetchMeterReadings(assetId: assetId)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func activateMeter() async {
        isActivating = true
        defer { isActivating = false }
        do {
            let updated = try await store.client.activateMeter(assetId: assetId)
            asset = updated
            await store.refreshAssets()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func formatValue(_ value: Double?) -> String {
        guard let value else { return "—" }
        return value.truncatingRemainder(dividingBy: 1) == 0 ? String(format: "%.0f", value) : String(format: "%.1f", value)
    }
}
