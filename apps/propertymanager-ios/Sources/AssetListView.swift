import SwiftUI

struct AssetListView: View {
    @EnvironmentObject private var store: PropertyStore
    @State private var selectedAsset: RanchAsset?

    var meteredAssets: [RanchAsset] {
        store.assets.filter { $0.meter?.hasMeter == true }
    }

    var body: some View {
        List {
            if store.isLoadingAssets {
                ProgressView("Loading assets…")
            }
            ForEach(meteredAssets) { asset in
                NavigationLink(value: asset.id) {
                    AssetRowView(asset: asset)
                }
            }
        }
        .navigationTitle("Assets")
        .navigationDestination(for: UUID.self) { assetId in
            AssetDetailView(assetId: assetId)
        }
        .refreshable {
            await store.refreshAssets()
        }
        .task {
            await store.refreshAssets()
        }
    }
}

struct AssetRowView: View {
    let asset: RanchAsset

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(asset.name)
                .font(.headline)
            if let meter = asset.meter, meter.hasMeter {
                Text("\(formatValue(meter.currentValue)) \(meter.unit)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            if let overdue = asset.pmSummary?.overdueMeterCount, overdue > 0 {
                Text("\(overdue) overdue service\(overdue == 1 ? "" : "s")")
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
        .padding(.vertical, 4)
    }

    private func formatValue(_ value: Double?) -> String {
        guard let value else { return "—" }
        return value.truncatingRemainder(dividingBy: 1) == 0 ? String(format: "%.0f", value) : String(format: "%.1f", value)
    }
}
