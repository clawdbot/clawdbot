import Foundation
import SwiftUI

struct GatewayOnboardingView: View {
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Connect to your gateway to get started.")
                        .foregroundStyle(.secondary)
                }

                Section {
                    NavigationLink("Auto detect") {
                        AutoDetectStep()
                    }
                    NavigationLink("Manual entry") {
                        ManualEntryStep()
                    }
                }
            }
            .navigationTitle("Connect Gateway")
        }
        .gatewayTrustPromptAlert()
    }
}

private struct AutoDetectStep: View {
    @Environment(NodeAppModel.self) private var appModel: NodeAppModel
    @Environment(GatewayConnectionController.self) private var gatewayController: GatewayConnectionController
    @AppStorage("gateway.preferredStableID") private var preferredGatewayStableID: String = ""
    @AppStorage("gateway.lastDiscoveredStableID") private var lastDiscoveredGatewayStableID: String = ""

    @State private var connectingGatewayID: String?
    @State private var connectStatusText: String?

    var body: some View {
        Form {
            Section {
                Text("We’ll scan for gateways on your network and connect automatically when we find one.")
                    .foregroundStyle(.secondary)
            }

            gatewayConnectionStatusSection(
                appModel: self.appModel,
                gatewayController: self.gatewayController,
                secondaryLine: self.connectStatusText)

            Section {
                Button("Retry") {
                    resetGatewayConnectionState(
                        appModel: self.appModel,
                        connectStatusText: &self.connectStatusText,
                        connectingGatewayID: &self.connectingGatewayID)
                    self.triggerAutoConnect()
                }
                .disabled(self.connectingGatewayID != nil)
            }
        }
        .navigationTitle("Auto detect")
        .onAppear { self.triggerAutoConnect() }
        .onChange(of: self.gatewayController.gateways) { _, _ in
            self.triggerAutoConnect()
        }
    }

    private func triggerAutoConnect() {
        guard self.appModel.gatewayServerName == nil else { return }
        guard self.connectingGatewayID == nil else { return }
        guard let candidate = self.autoCandidate() else { return }

        self.connectingGatewayID = candidate.id
        Task {
            defer { self.connectingGatewayID = nil }
            await self.gatewayController.connect(candidate)
        }
    }

    private func autoCandidate() -> GatewayDiscoveryModel.DiscoveredGateway? {
        let preferred = self.preferredGatewayStableID.trimmingCharacters(in: .whitespacesAndNewlines)
        let lastDiscovered = self.lastDiscoveredGatewayStableID.trimmingCharacters(in: .whitespacesAndNewlines)

        if !preferred.isEmpty,
           let match = self.gatewayController.gateways.first(where: { $0.stableID == preferred })
        {
            return match
        }
        if !lastDiscovered.isEmpty,
           let match = self.gatewayController.gateways.first(where: { $0.stableID == lastDiscovered })
        {
            return match
        }
        if self.gatewayController.gateways.count == 1 {
            return self.gatewayController.gateways.first
        }
        return nil
    }
}

private struct ManualEntryStep: View {
    @Environment(NodeAppModel.self) private var appModel: NodeAppModel
    @Environment(GatewayConnectionController.self) private var gatewayController: GatewayConnectionController

    @State private var setupCode: String = ""
    @State private var setupStatusText: String?
    @State private var manualHost: String = ""
    @State private var manualPortText: String = ""
    @State private var manualUseTLS: Bool = true
    @State private var manualToken: String = ""
    @State private var manualPassword: String = ""

    @State private var connectingGatewayID: String?
    @State private var connectStatusText: String?

    var body: some View {
        Form {
            Section("Setup code") {
                Text("Use /pair in your bot to get a setup code.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                TextField("Paste setup code", text: self.$setupCode)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()

                Button("Apply setup code") {
                    self.applySetupCode()
                }
                .disabled(self.setupCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                if let setupStatusText, !setupStatusText.isEmpty {
                    Text(setupStatusText)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            Section {
                TextField("Host", text: self.$manualHost)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()

                TextField("Port", text: self.$manualPortText)
                    .keyboardType(.numberPad)

                Toggle("Use TLS", isOn: self.$manualUseTLS)

                TextField("Gateway token", text: self.$manualToken)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()

                SecureField("Gateway password", text: self.$manualPassword)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }

            gatewayConnectionStatusSection(
                appModel: self.appModel,
                gatewayController: self.gatewayController,
                secondaryLine: self.connectStatusText)

            Section {
                Button {
                    Task { await self.connectManual() }
                } label: {
                    if self.connectingGatewayID == "manual" {
                        HStack(spacing: 8) {
                            ProgressView()
                                .progressViewStyle(.circular)
                            Text("Connecting…")
                        }
                    } else {
                        Text("Connect")
                    }
                }
                .disabled(self.connectingGatewayID != nil)

                Button("Retry") {
                    resetGatewayConnectionState(
                        appModel: self.appModel,
                        connectStatusText: &self.connectStatusText,
                        connectingGatewayID: &self.connectingGatewayID)
                    self.resetManualForm()
                }
                .disabled(self.connectingGatewayID != nil)
            }
        }
        .navigationTitle("Manual entry")
    }

    private func connectManual() async {
        let host = self.manualHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty else {
            self.connectStatusText = "Failed: host required"
            return
        }

        if let port = self.manualPortValue(), !(1...65535).contains(port) {
            self.connectStatusText = "Failed: invalid port"
            return
        }

        let defaults = UserDefaults.standard
        defaults.set(true, forKey: "gateway.manual.enabled")
        defaults.set(host, forKey: "gateway.manual.host")
        defaults.set(self.manualPortValue() ?? 0, forKey: "gateway.manual.port")
        defaults.set(self.manualUseTLS, forKey: "gateway.manual.tls")

        if let instanceId = defaults.string(forKey: "node.instanceId")?.trimmingCharacters(in: .whitespacesAndNewlines),
           !instanceId.isEmpty
        {
            let trimmedToken = self.manualToken.trimmingCharacters(in: .whitespacesAndNewlines)
            let trimmedPassword = self.manualPassword.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedToken.isEmpty {
                GatewaySettingsStore.saveGatewayToken(trimmedToken, instanceId: instanceId)
            }
            GatewaySettingsStore.saveGatewayPassword(trimmedPassword, instanceId: instanceId)
        }

        self.connectingGatewayID = "manual"
        defer { self.connectingGatewayID = nil }
        await self.gatewayController.connectManual(
            host: host,
            port: self.manualPortValue() ?? 0,
            useTLS: self.manualUseTLS)
    }

    private func manualPortValue() -> Int? {
        let trimmed = self.manualPortText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return Int(trimmed.filter(\.isNumber))
    }

    private func resetManualForm() {
        self.setupCode = ""
        self.setupStatusText = nil
        self.manualHost = ""
        self.manualPortText = ""
        self.manualUseTLS = true
        self.manualToken = ""
        self.manualPassword = ""
    }

    private func applySetupCode() {
        let raw = self.setupCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else {
            self.setupStatusText = "Paste a setup code to continue."
            return
        }

        guard let payload = GatewaySetupCode.decode(raw: raw) else {
            self.setupStatusText = "Setup code not recognized."
            return
        }

        if let urlString = payload.url, let url = URL(string: urlString) {
            self.applyURL(url)
        } else if let host = payload.host, !host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            self.manualHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
            if let port = payload.port {
                self.manualPortText = String(port)
            } else {
                self.manualPortText = ""
            }
            if let tls = payload.tls {
                self.manualUseTLS = tls
            }
        } else if let url = URL(string: raw), url.scheme != nil {
            self.applyURL(url)
        } else {
            self.setupStatusText = "Setup code missing URL or host."
            return
        }

        if let token = payload.token, !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            self.manualToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        } else if payload.bootstrapToken?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
            self.manualToken = ""
        }
        if let password = payload.password, !password.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            self.manualPassword = password.trimmingCharacters(in: .whitespacesAndNewlines)
        } else if payload.bootstrapToken?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
            self.manualPassword = ""
        }

        let trimmedInstanceId = UserDefaults.standard.string(forKey: "node.instanceId")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedInstanceId.isEmpty {
            let trimmedBootstrapToken =
                payload.bootstrapToken?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            GatewaySettingsStore.saveGatewayBootstrapToken(trimmedBootstrapToken, instanceId: trimmedInstanceId)
        }

        self.setupStatusText = "Setup code applied."
    }

    private func applyURL(_ url: URL) {
        guard let host = url.host, !host.isEmpty else { return }
        self.manualHost = host
        if let port = url.port {
            self.manualPortText = String(port)
        } else {
            self.manualPortText = ""
        }
        let scheme = (url.scheme ?? "").lowercased()
        if scheme == "wss" || scheme == "https" {
            self.manualUseTLS = true
        } else if scheme == "ws" || scheme == "http" {
            self.manualUseTLS = false
        }
    }

    // (GatewaySetupCode) decode raw setup codes.
}

@MainActor
private func gatewayConnectionStatusLines(
    appModel: NodeAppModel,
    gatewayController: GatewayConnectionController) -> [String]
{
    ConnectionStatusBox.defaultLines(appModel: appModel, gatewayController: gatewayController)
}

@MainActor
private func resetGatewayConnectionState(
    appModel: NodeAppModel,
    connectStatusText: inout String?,
    connectingGatewayID: inout String?)
{
    appModel.disconnectGateway()
    connectStatusText = nil
    connectingGatewayID = nil
}

@MainActor
private func gatewayConnectionStatusSection(
    appModel: NodeAppModel,
    gatewayController: GatewayConnectionController,
    secondaryLine: String?) -> some View
{
    Section("Connection status") {
        ConnectionStatusBox(
            statusLines: gatewayConnectionStatusLines(
                appModel: appModel,
                gatewayController: gatewayController),
            secondaryLine: secondaryLine)
    }
}

private struct ConnectionStatusBox: View {
    let statusLines: [String]
    let secondaryLine: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(self.statusLines, id: \.self) { line in
                Text(line)
                    .font(.system(size: 12, weight: .regular, design: .monospaced))
                    .foregroundStyle(.secondary)
            }
            if let secondaryLine, !secondaryLine.isEmpty {
                Text(secondaryLine)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    static func defaultLines(
        appModel: NodeAppModel,
        gatewayController: GatewayConnectionController) -> [String]
    {
        var lines: [String] = [
            "gateway: \(appModel.gatewayDisplayStatusText)",
            "discovery: \(gatewayController.discoveryStatusText)",
        ]
        lines.append("server: \(appModel.gatewayServerName ?? "—")")
        lines.append("address: \(appModel.gatewayRemoteAddress ?? "—")")
        return lines
    }
}
