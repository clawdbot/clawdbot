import SwiftUI

@MainActor
struct ConfigSettings: View {
    private let isPreview = ProcessInfo.processInfo.isPreview
    private let isNixMode = ProcessInfo.processInfo.isNixMode
    @Bindable var store: ChannelsStore
    @State private var hasLoaded = false

    init(store: ChannelsStore = .shared) {
        self.store = store
    }

    var body: some View {
        ScrollView {
            self.content
        }
        .task {
            guard !self.hasLoaded else { return }
            guard !self.isPreview else { return }
            self.hasLoaded = true
            await self.store.loadConfigSchema()
            await self.store.loadConfig()
        }
    }
}

extension ConfigSettings {
    private var content: some View {
        VStack(alignment: .leading, spacing: 16) {
            self.header
            if let status = self.store.configStatus {
                Text(status)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            self.actionRow
            Group {
                if self.store.configSchemaLoading {
                    ProgressView().controlSize(.small)
                } else if let schema = self.store.configSchema {
                    ConfigSchemaForm(store: self.store, schema: schema, path: [])
                        .disabled(self.isNixMode)
                } else {
                    Text("Schema unavailable.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if self.store.configDirty, !self.isNixMode {
                Text("Unsaved changes")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 24)
        .padding(.vertical, 18)
        .groupBoxStyle(PlainSettingsGroupBoxStyle())
    }

    @ViewBuilder
    private var header: some View {
        Text("Config")
            .font(.title3.weight(.semibold))
        Text(self.isNixMode
            ? "This tab is read-only in Nix mode. Edit config via Nix and rebuild."
            : "Edit ~/.clawdbot/clawdbot.json using the schema-driven form.")
            .font(.callout)
            .foregroundStyle(.secondary)
    }

    private var actionRow: some View {
        HStack(spacing: 10) {
            Button("Reload") {
                Task { await self.store.reloadConfigDraft() }
            }
            .disabled(!self.store.configLoaded)

            Button(self.store.isSavingConfig ? "Saving…" : "Save") {
                Task { await self.store.saveConfigDraft() }
            }
            .disabled(self.isNixMode || self.store.isSavingConfig || !self.store.configDirty)
        }
        .buttonStyle(.bordered)
    }
}

struct ConfigSettings_Previews: PreviewProvider {
    static var previews: some View {
        ConfigSettings()
    }
}
