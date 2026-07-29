import SwiftUI

struct TaskListView: View {
    @EnvironmentObject private var store: PropertyStore
    @State private var completingTask: MaintenanceTask?
    @State private var completionNote = ""
    @State private var meterConfirmValue = ""
    @State private var confirmCurrentMeter = false
    @State private var linkedAsset: RanchAsset?

    var body: some View {
        List {
            if store.isLoading {
                ProgressView("Loading tasks…")
            }
            ForEach(store.filteredTasks) { task in
                TaskRowView(task: task) {
                    completingTask = task
                    completionNote = ""
                    meterConfirmValue = ""
                    confirmCurrentMeter = false
                    if task.requiresMeterOnComplete, let assetId = task.assetId {
                        Task { await loadAssetForCompletion(assetId) }
                    }
                }
            }
        }
        .navigationTitle("Tasks")
        .searchable(text: $store.searchText)
        .refreshable { await store.refresh() }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Picker("Filter", selection: $store.filter) {
                    ForEach(TaskFilter.allCases) { filter in
                        Text(filter.rawValue).tag(filter)
                    }
                }
                .pickerStyle(.menu)
            }
        }
        .sheet(item: $completingTask) { task in
            completionSheet(task)
        }
    }

    @ViewBuilder
    private func completionSheet(_ task: MaintenanceTask) -> some View {
        NavigationStack {
            Form {
                Section("Task") {
                    Text("\(task.area) / \(task.item)")
                }
                Section("Note") {
                    TextField("Completion note", text: $completionNote)
                }
                if task.requiresMeterOnComplete {
                    Section("Meter at completion") {
                        if let asset = linkedAsset, let meter = asset.meter {
                            Text("Current: \(formatValue(meter.currentValue)) \(meter.unit)")
                                .foregroundStyle(.secondary)
                        }
                        Toggle("Confirm current meter reading", isOn: $confirmCurrentMeter)
                            .onChange(of: confirmCurrentMeter) { _, on in
                                if on { meterConfirmValue = "" }
                            }
                        if !confirmCurrentMeter {
                            TextField("Enter new meter value", text: $meterConfirmValue)
                                .keyboardType(.decimalPad)
                        }
                    }
                }
            }
            .navigationTitle("Complete task")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { completingTask = nil }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        Task { await complete(task) }
                    }
                    .disabled(store.isCompleting || !meterInputValid(task))
                }
            }
        }
    }

    private func meterInputValid(_ task: MaintenanceTask) -> Bool {
        guard task.requiresMeterOnComplete else { return true }
        if confirmCurrentMeter { return true }
        return Double(meterConfirmValue.replacingOccurrences(of: ",", with: ".")) != nil
    }

    private func complete(_ task: MaintenanceTask) async {
        var meterValue: Double?
        if task.requiresMeterOnComplete, !confirmCurrentMeter {
            meterValue = Double(meterConfirmValue.replacingOccurrences(of: ",", with: "."))
        }
        let ok = await store.complete(
            task: task,
            note: completionNote.isEmpty ? nil : completionNote,
            meterValue: meterValue,
            confirmCurrentMeter: confirmCurrentMeter
        )
        if ok { completingTask = nil }
    }

    private func loadAssetForCompletion(_ assetId: UUID) async {
        do {
            linkedAsset = try await store.client.fetchAsset(id: assetId)
            if let current = linkedAsset?.meter?.currentValue {
                meterConfirmValue = formatValue(current)
            }
        } catch {
            store.errorMessage = error.localizedDescription
        }
    }

    private func formatValue(_ value: Double?) -> String {
        guard let value else { return "" }
        return value.truncatingRemainder(dividingBy: 1) == 0 ? String(format: "%.0f", value) : String(format: "%.1f", value)
    }
}

struct TaskRowView: View {
    let task: MaintenanceTask
    let onComplete: () -> Void

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(task.item).font(.headline)
                Text("\(task.area) · \(task.categoryName)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if task.requiresMeterOnComplete {
                    Label("Meter schedule", systemImage: "gauge.with.dots.needle.67percent")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
            }
            Spacer()
            Button("Done", action: onComplete)
                .buttonStyle(.bordered)
                .controlSize(.small)
        }
        .padding(.vertical, 4)
    }
}
