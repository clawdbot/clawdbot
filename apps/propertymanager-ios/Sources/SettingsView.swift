import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var store: PropertyStore

    var body: some View {
        Form {
            Section("API connection") {
                TextField("API base URL", text: $store.apiBaseURL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
            }
            Section("Authentication") {
                SecureField("API key (optional)", text: $store.apiKey)
                SecureField("Operator PIN (optional)", text: $store.operatorPIN)
                TextField("Operator identity", text: $store.operatorIdentity)
                    .textInputAutocapitalization(.never)
            }
            Section {
                Text("Asset and meter endpoints use /v1/. Task endpoints use the root API path. When auth is enabled on the server, provide an API key or operator PIN.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Section {
                Button("Refresh all data") {
                    Task {
                        await store.refresh()
                        await store.refreshAssets()
                    }
                }
            }
        }
        .navigationTitle("Settings")
    }
}
