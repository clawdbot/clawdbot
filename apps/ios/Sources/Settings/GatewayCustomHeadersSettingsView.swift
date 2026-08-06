import OpenClawKit
import SwiftUI

/// Per-gateway custom header editor for gateways behind authenticating reverse proxies
/// (Cloudflare Access-style service tokens). Header values are credentials: they render
/// masked, persist in the Keychain, and must never appear in logs or diagnostics.
struct GatewayCustomHeadersSettingsView: View {
    let gatewayStableID: String

    @State private var entries: [HeaderEntry] = []
    @State private var newName = ""
    @State private var newValue = ""
    @State private var loaded = false

    private struct HeaderEntry: Identifiable, Equatable {
        let id = UUID()
        var name: String
        var value: String
    }

    var body: some View {
        Form {
            if !self.entries.isEmpty {
                Section {
                    ForEach(self.$entries) { $entry in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(entry.name)
                                .font(OpenClawType.subheadSemiBold)
                            self.headerValueField("Value", text: $entry.value)
                        }
                    }
                    .onDelete(perform: self.removeEntries)
                } header: {
                    Text("Headers")
                        .font(OpenClawType.captionSemiBold)
                } footer: {
                    // Keep the extraction key contiguous for the native localization inventory.
                    // swiftlint:disable line_length
                    Text(
                        String(
                            localized:
                            "Sent with foreground app connections to this gateway. Changes apply on the next reconnect; Share extension delivery is not yet supported."))
                        .font(OpenClawType.caption)
                    // swiftlint:enable line_length
                }
            }

            Section {
                TextField(text: self.$newName, prompt: Text("Header name").font(OpenClawType.subhead)) {
                    Text("Header name")
                        .font(OpenClawType.subhead)
                }
                .font(OpenClawType.subhead)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                self.headerValueField("Header value", text: self.$newValue)
                Button {
                    self.addEntry()
                } label: {
                    Label {
                        Text("Add Header")
                            .font(OpenClawType.subheadSemiBold)
                    } icon: {
                        Image(systemName: "plus")
                    }
                }
                .disabled(!self.canAddEntry)
            } header: {
                Text("Add Header")
                    .font(OpenClawType.captionSemiBold)
            } footer: {
                Text(self.addFooterText)
                    .font(OpenClawType.caption)
            }
        }
        .navigationTitle("Custom Headers")
        .toolbar {
            EditButton()
                .font(OpenClawType.subheadSemiBold)
        }
        .onAppear(perform: self.loadOnce)
        .onChange(of: self.entries) { _, _ in
            guard self.loaded else { return }
            self.persist()
        }
    }

    private var trimmedNewName: String {
        self.newName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var newNameIsReserved: Bool {
        GatewayCustomHeaders.isReservedName(self.trimmedNewName)
    }

    private var newNameIsDuplicate: Bool {
        let name = self.trimmedNewName
        return self.entries.contains { $0.name.caseInsensitiveCompare(name) == .orderedSame }
    }

    private var canAddEntry: Bool {
        !self.trimmedNewName.isEmpty && !self.newNameIsReserved && !self.newNameIsDuplicate
    }

    private var addFooterText: String {
        if self.newNameIsReserved {
            return "This header is managed by the connection and cannot be overridden."
        }
        if self.newNameIsDuplicate {
            return "A header with this name already exists."
        }
        return "For secure gateways behind an authenticating proxy, for example Cloudflare Access "
            + "service token headers. Values are stored securely and sent only over TLS to this gateway."
    }

    private func headerValueField(_ placeholder: String, text: Binding<String>) -> some View {
        ZStack(alignment: .leading) {
            SecureField("", text: text)
                .font(OpenClawType.subhead)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityLabel(placeholder)
            if text.wrappedValue.isEmpty {
                Text(placeholder)
                    .font(OpenClawType.subhead)
                    .foregroundStyle(.tertiary)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
    }

    private func loadOnce() {
        guard !self.loaded else { return }
        self.entries = GatewaySettingsStore.loadGatewayCustomHeaders(gatewayStableID: self.gatewayStableID)
            .sorted { $0.key.localizedCaseInsensitiveCompare($1.key) == .orderedAscending }
            .map { HeaderEntry(name: $0.key, value: $0.value) }
        self.loaded = true
    }

    private func addEntry() {
        guard self.canAddEntry else { return }
        self.entries.append(HeaderEntry(name: self.trimmedNewName, value: self.newValue))
        self.newName = ""
        self.newValue = ""
    }

    private func removeEntries(at offsets: IndexSet) {
        self.entries.remove(atOffsets: offsets)
    }

    private func persist() {
        var headers: [String: String] = [:]
        for entry in self.entries {
            let name = entry.name.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { continue }
            headers[name] = entry.value
        }
        GatewaySettingsStore.saveGatewayCustomHeaders(headers, gatewayStableID: self.gatewayStableID)
    }
}
