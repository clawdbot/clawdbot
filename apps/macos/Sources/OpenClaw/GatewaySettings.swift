import SwiftUI

@MainActor
struct GatewaySettings: View {
    @State private var profiles: [MacGatewayProfile]
    @State private var hasLoaded: Bool
    @State private var isLoading = false
    @State private var isRemoving = false
    @State private var showsAddGateway = false
    @State private var pendingRemoval: MacGatewayProfile?
    @State private var errorMessage: String?
    private let isPreview: Bool

    init(
        profiles: [MacGatewayProfile]? = nil,
        isPreview: Bool = ProcessInfo.processInfo.isPreview)
    {
        _profiles = State(initialValue: profiles ?? [])
        _hasLoaded = State(initialValue: profiles != nil)
        self.isPreview = isPreview
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            self.header
            self.content
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .settingsDetailContent()
        .task {
            guard !self.hasLoaded, !self.isPreview else { return }
            self.hasLoaded = true
            await self.refresh()
        }
        .sheet(isPresented: self.$showsAddGateway) {
            GatewayProfileEditor { profile in
                self.profiles.removeAll { $0.id == profile.id }
                self.profiles.append(profile)
                self.profiles = MacGatewayProfileStore.sortedProfiles(self.profiles)
            }
        }
        .alert("Remove Gateway?", isPresented: Binding(
            get: { self.pendingRemoval != nil },
            set: {
                if !$0 {
                    self.pendingRemoval = nil
                }
            })) {
                Button("Cancel", role: .cancel) {
                    self.pendingRemoval = nil
                }
                Button("Remove", role: .destructive) {
                    guard let profile = self.pendingRemoval else { return }
                    self.pendingRemoval = nil
                    // Serialize profile mutations across the Keychain and
                    // connection-shutdown awaits so a same-ID re-add cannot race.
                    self.isRemoving = true
                    Task { await self.remove(profile) }
                }
        } message: {
            if let profile = self.pendingRemoval {
                Text("\(profile.name) and its saved credentials will be removed. Its open windows will close.")
            }
        }
        .alert("Gateway Error", isPresented: Binding(
            get: { self.errorMessage != nil },
            set: {
                if !$0 {
                    self.errorMessage = nil
                }
            })) {
                Button("OK") {
                    self.errorMessage = nil
                }
        } message: {
            Text(self.errorMessage ?? "")
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 16) {
            SettingsPageHeader(
                title: "Gateways",
                subtitle: """
                Save Gateway connections for chat windows. The primary Gateway under \
                Connection still owns Mac integrations and Talk Mode.
                """)
            Spacer(minLength: 16)
            Button {
                guard !self.isRemoving else { return }
                self.showsAddGateway = true
            } label: {
                Label("Add Gateway", systemImage: "plus")
            }
            .buttonStyle(.borderedProminent)
            .disabled(self.isRemoving)
        }
    }

    @ViewBuilder
    private var content: some View {
        if self.isLoading, self.profiles.isEmpty {
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("Loading Gateways…")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .padding(.top, 8)
        } else if self.profiles.isEmpty {
            SettingsCardGroup("Saved Gateways") {
                VStack(alignment: .leading, spacing: 8) {
                    Text("No Gateways saved")
                        .font(.callout.weight(.medium))
                    Text(
                        """
                        Add a Gateway here, then use File → New Gateway Window… (⌘N) whenever \
                        you want another window for it.
                        """)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 13)
            }
        } else {
            ScrollView(.vertical) {
                SettingsCardGroup("Saved Gateways") {
                    ForEach(Array(self.profiles.enumerated()), id: \.element.id) { index, profile in
                        SettingsCardRow(
                            title: .verbatim(profile.name),
                            subtitle: .verbatim(profile.url.absoluteString),
                            showsDivider: index != self.profiles.count - 1)
                        {
                            HStack(spacing: 8) {
                                Button("Open Window") {
                                    guard !self.isRemoving else { return }
                                    WebChatManager.shared.openGatewayWindow(profile: profile)
                                }
                                .disabled(self.isRemoving)
                                Button(role: .destructive) {
                                    guard !self.isRemoving else { return }
                                    self.pendingRemoval = profile
                                } label: {
                                    Image(systemName: "trash")
                                }
                                .accessibilityLabel("Remove \(profile.name)")
                                .help("Remove \(profile.name)")
                                .disabled(self.isRemoving)
                            }
                        }
                    }
                }
            }
        }
    }

    private func refresh() async {
        self.isLoading = true
        defer { self.isLoading = false }
        do {
            self.profiles = try await MacGatewayProfileStore.shared.profiles()
        } catch {
            self.errorMessage = error.localizedDescription
        }
    }

    private func remove(_ profile: MacGatewayProfile) async {
        defer { self.isRemoving = false }
        do {
            try await MacGatewayProfileStore.shared.remove(profileID: profile.id)
            // Reflect the durable removal before connection shutdown suspends;
            // a same-endpoint re-add during shutdown must remain visible.
            self.profiles.removeAll { $0.id == profile.id }
            await WebChatManager.shared.closeGatewayWindows(profileID: profile.id)
        } catch {
            self.errorMessage = error.localizedDescription
        }
    }
}

@MainActor
private struct GatewayProfileEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var url = "wss://"
    @State private var token = ""
    @State private var password = ""
    @State private var isSaving = false
    @State private var errorMessage: String?

    let onSaved: (MacGatewayProfile) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            SettingsPageHeader(
                title: "Add Gateway",
                subtitle: "Credentials are stored with this profile in your Mac Keychain.")

            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 14, verticalSpacing: 12) {
                GridRow {
                    Text("Name")
                    TextField("Studio", text: self.$name)
                        .textFieldStyle(.roundedBorder)
                }
                GridRow {
                    Text("Gateway URL")
                    TextField("wss://gateway.example.com", text: self.$url)
                        .textFieldStyle(.roundedBorder)
                }
                GridRow {
                    Text("Token")
                    SecureField("Optional", text: self.$token)
                        .textFieldStyle(.roundedBorder)
                }
                GridRow {
                    Text("Password")
                    SecureField("Optional", text: self.$password)
                        .textFieldStyle(.roundedBorder)
                }
            }
            .gridColumnAlignment(.leading)

            if let errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Divider()

            HStack {
                Spacer()
                Button("Cancel", role: .cancel) {
                    self.dismiss()
                }
                .keyboardShortcut(.cancelAction)
                Button("Add Gateway") {
                    Task { await self.save() }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(self.isSaving || self.url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(24)
        .frame(width: 540)
    }

    private func save() async {
        self.isSaving = true
        self.errorMessage = nil
        defer { self.isSaving = false }
        do {
            let rawURL = self.url.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let url = URL(string: rawURL) else {
                throw MacGatewayProfileError.invalidURL
            }
            let profile = try await MacGatewayProfileStore.shared.upsert(
                name: self.name,
                url: url,
                token: self.token,
                password: self.password)
            WebChatManager.shared.gatewayProfileDidSave(profileID: profile.id)
            self.onSaved(profile)
            self.dismiss()
        } catch {
            self.errorMessage = error.localizedDescription
        }
    }
}

#if DEBUG
struct GatewaySettings_Previews: PreviewProvider {
    static var previews: some View {
        GatewaySettings(profiles: [
            MacGatewayProfile(
                id: "studio",
                name: "Studio",
                url: URL(string: "wss://studio.example:443/")!),
            MacGatewayProfile(
                id: "production",
                name: "Production",
                url: URL(string: "wss://gateway.example:443/")!),
        ])
        .frame(width: 840, height: 620)
    }
}
#endif
