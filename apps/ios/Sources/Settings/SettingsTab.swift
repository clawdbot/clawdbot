import Network
import Observation
import OpenClawKit
import os
import SwiftUI
import UIKit

// swiftlint:disable type_body_length
struct SettingsTab: View {
    private struct FeatureHelp: Identifiable {
        let id = UUID()
        let title: String
        let message: String
    }

    @Environment(NodeAppModel.self) private var appModel: NodeAppModel
    @Environment(VoiceWakeManager.self) private var voiceWake: VoiceWakeManager
    @Environment(GatewayConnectionController.self) private var gatewayController: GatewayConnectionController
    @Environment(\.dismiss) private var dismiss
    @AppStorage("node.displayName") private var displayName: String = "iOS Node"
    @AppStorage("node.instanceId") private var instanceId: String = UUID().uuidString
    @AppStorage("voiceWake.enabled") private var voiceWakeEnabled: Bool = false
    @AppStorage("talk.enabled") private var talkEnabled: Bool = false
    @AppStorage(TalkSpeechLocale.storageKey) private var talkSpeechLocale: String = TalkSpeechLocale.automaticID
    @AppStorage("talk.button.enabled") private var talkButtonEnabled: Bool = true
    @AppStorage("talk.background.enabled") private var talkBackgroundEnabled: Bool = false
    @AppStorage("camera.enabled") private var cameraEnabled: Bool = true
    @AppStorage("location.enabledMode") private var locationEnabledModeRaw: String = OpenClawLocationMode.off.rawValue
    @AppStorage("screen.preventSleep") private var preventSleep: Bool = true
    @AppStorage("gateway.preferredStableID") private var preferredGatewayStableID: String = ""
    @AppStorage("gateway.lastDiscoveredStableID") private var lastDiscoveredGatewayStableID: String = ""
    @AppStorage("gateway.autoconnect") private var gatewayAutoConnect: Bool = false
    @AppStorage("gateway.manual.enabled") private var manualGatewayEnabled: Bool = false
    @AppStorage("gateway.manual.host") private var manualGatewayHost: String = ""
    @AppStorage("gateway.manual.port") private var manualGatewayPort: Int = 18789
    @AppStorage("gateway.manual.tls") private var manualGatewayTLS: Bool = true
    @AppStorage("gateway.discovery.debugLogs") private var discoveryDebugLogsEnabled: Bool = false
    @AppStorage("canvas.debugStatusEnabled") private var canvasDebugStatusEnabled: Bool = false

    // Onboarding control (RootCanvas listens to onboarding.requestID and force-opens the wizard).
    @AppStorage("onboarding.requestID") private var onboardingRequestID: Int = 0
    @AppStorage("gateway.onboardingComplete") private var onboardingComplete: Bool = false
    @AppStorage("gateway.hasConnectedOnce") private var hasConnectedOnce: Bool = false

    @State private var connectingGatewayID: String?
    @State private var lastLocationModeRaw: String = OpenClawLocationMode.off.rawValue
    @State private var gatewayToken: String = ""
    @State private var gatewayPassword: String = ""
    @State private var defaultShareInstruction: String = ""
    @AppStorage("gateway.setupCode") private var setupCode: String = ""
    @State private var setupStatusText: String?
    @State private var showQRScanner: Bool = false
    @State private var scannerError: String?
    @State private var manualGatewayPortText: String = ""
    @State private var gatewayExpanded: Bool = true
    @State private var selectedAgentPickerId: String = ""

    @State private var showResetOnboardingAlert: Bool = false
    @State private var showGatewayProblemDetails: Bool = false
    @State private var activeFeatureHelp: FeatureHelp?
    @State private var suppressCredentialPersist: Bool = false

    private let gatewayLogger = Logger(subsystem: "ai.openclaw.ios", category: "GatewaySettings")

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DisclosureGroup(isExpanded: self.$gatewayExpanded) {
                        if let gatewayProblem = self.appModel.lastGatewayProblem,
                           !self.isGatewayConnected
                        {
                            GatewayProblemBanner(
                                problem: gatewayProblem,
                                primaryActionTitle: self.gatewayProblemPrimaryActionTitle(gatewayProblem),
                                onPrimaryAction: {
                                    Task { await self.handleGatewayProblemPrimaryAction(gatewayProblem) }
                                },
                                onShowDetails: {
                                    self.showGatewayProblemDetails = true
                                })
                        }

                        if !self.isGatewayConnected {
                            Text(
                                "1. Open a chat with your OpenClaw agent and send /pair\n"
                                    + "2. Copy the setup code it returns\n"
                                    + "3. Paste here and tap Connect\n"
                                    + "4. Back in that chat, run /pair approve")
                                .font(.footnote)
                                .foregroundStyle(.secondary)

                            if let warning = self.tailnetWarningText {
                                Text(warning)
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(.orange)
                            }

                            TextField("Paste setup code", text: self.$setupCode)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()

                            Button {
                                self.openGatewayQRScanner()
                            } label: {
                                Label("Scan QR Code", systemImage: "qrcode.viewfinder")
                            }
                            .disabled(self.connectingGatewayID != nil)

                            Button {
                                Task { await self.applySetupCodeAndConnect() }
                            } label: {
                                if self.connectingGatewayID == "manual" {
                                    HStack(spacing: 8) {
                                        ProgressView()
                                            .progressViewStyle(.circular)
                                        Text("Connecting…")
                                    }
                                } else {
                                    Text("Connect with setup code")
                                }
                            }
                            .disabled(self.connectingGatewayID != nil
                                || self.setupCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                            if let status = self.setupStatusLine {
                                Text(status)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }

                        if self.isGatewayConnected {
                            Picker("Bot", selection: self.$selectedAgentPickerId) {
                                Text("Default").tag("")
                                let defaultId = (self.appModel.gatewayDefaultAgentId ?? "")
                                    .trimmingCharacters(in: .whitespacesAndNewlines)
                                ForEach(self.appModel.gatewayAgents.filter { $0.id != defaultId }, id: \.id) { agent in
                                    let name = (agent.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                                    Text(name.isEmpty ? agent.id : name).tag(agent.id)
                                }
                            }
                            Text("Controls which bot Chat and Talk speak to.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }

                        if self.appModel.gatewayServerName == nil {
                            LabeledContent("Discovery", value: self.gatewayController.discoveryStatusText)
                        }
                        LabeledContent("Status", value: self.appModel.gatewayDisplayStatusText)
                        Toggle("Auto-connect on launch", isOn: self.$gatewayAutoConnect)

                        if let serverName = self.appModel.gatewayServerName {
                            LabeledContent("Server", value: serverName)
                            if let addr = self.appModel.gatewayRemoteAddress {
                                let parts = Self.parseHostPort(from: addr)
                                let urlString = Self.httpURLString(host: parts?.host, port: parts?.port, fallback: addr)
                                LabeledContent("Address") {
                                    Text(urlString)
                                }
                                .contextMenu {
                                    Button {
                                        UIPasteboard.general.string = urlString
                                    } label: {
                                        Label("Copy URL", systemImage: "doc.on.doc")
                                    }

                                    if let parts {
                                        Button {
                                            UIPasteboard.general.string = parts.host
                                        } label: {
                                            Label("Copy Host", systemImage: "doc.on.doc")
                                        }

                                        Button {
                                            UIPasteboard.general.string = "\(parts.port)"
                                        } label: {
                                            Label("Copy Port", systemImage: "doc.on.doc")
                                        }
                                    }
                                }
                            }

                            Button("Disconnect", role: .destructive) {
                                self.appModel.disconnectGateway()
                            }
                        } else {
                            self.gatewayList(showing: .all)
                        }

                        DisclosureGroup("Advanced") {
                            Toggle("Use Manual Gateway", isOn: self.$manualGatewayEnabled)

                            TextField("Host", text: self.$manualGatewayHost)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()

                            TextField("Port (optional)", text: self.manualPortBinding)
                                .keyboardType(.numberPad)

                            Toggle("Use TLS", isOn: self.$manualGatewayTLS)

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
                                    Text("Connect (Manual)")
                                }
                            }
                            .disabled(self.connectingGatewayID != nil || self.manualGatewayHost
                                .trimmingCharacters(in: .whitespacesAndNewlines)
                                .isEmpty || !self.manualPortIsValid)

                            Text(
                                "Use this when mDNS/Bonjour discovery is blocked. "
                                    + "Leave port empty for 443 on tailnet DNS (TLS) or 18789 otherwise.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)

                            Toggle("Discovery Debug Logs", isOn: self.$discoveryDebugLogsEnabled)
                                .onChange(of: self.discoveryDebugLogsEnabled) { _, newValue in
                                    self.gatewayController.setDiscoveryDebugLoggingEnabled(newValue)
                                }

                            NavigationLink("Discovery Logs") {
                                GatewayDiscoveryDebugLogView()
                            }

                            Toggle("Debug Canvas Status", isOn: self.$canvasDebugStatusEnabled)

                            TextField("Gateway Auth Token", text: self.$gatewayToken)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()

                            SecureField("Gateway Password", text: self.$gatewayPassword)

                            Button("Reset Onboarding", role: .destructive) {
                                self.showResetOnboardingAlert = true
                            }

                            VStack(alignment: .leading, spacing: 6) {
                                Text("Debug")
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                Text(self.gatewayDebugText())
                                    .font(.system(size: 12, weight: .regular, design: .monospaced))
                                    .foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(10)
                                    .background(
                                        .thinMaterial,
                                        in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            }
                        }
                    } label: {
                        HStack(spacing: 10) {
                            Circle()
                                .fill(self.isGatewayConnected ? Color.green : Color.secondary.opacity(0.35))
                                .frame(width: 10, height: 10)
                            Text("Gateway")
                            Spacer()
                            Text(self.gatewaySummaryText)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Section("Device") {
                    DisclosureGroup("Features") {
                        self.featureToggle(
                            "Voice Wake",
                            isOn: self.$voiceWakeEnabled,
                            help: "Enables wake-word activation to start a hands-free session.")
                        { newValue in
                            self.appModel.setVoiceWakeEnabled(newValue)
                        }
                        self.featureToggle(
                            "Talk Mode",
                            isOn: self.$talkEnabled,
                            help: "Enables voice conversation mode with your connected OpenClaw agent.")
                        { newValue in
                            self.appModel.setTalkEnabled(newValue)
                        }
                        Picker("Speech Language", selection: self.$talkSpeechLocale) {
                            ForEach(TalkSpeechLocale.supportedOptions()) { option in
                                Text(option.label).tag(option.id)
                            }
                        }
                        self.featureToggle(
                            "Background Listening",
                            isOn: self.$talkBackgroundEnabled,
                            help: "Keeps listening while the app is backgrounded. Uses more battery.")

                        NavigationLink {
                            VoiceWakeWordsSettingsView()
                        } label: {
                            LabeledContent(
                                "Wake Words",
                                value: VoiceWakePreferences.displayString(for: self.voiceWake.triggerWords))
                        }

                        self.featureToggle(
                            "Allow Camera",
                            isOn: self.$cameraEnabled,
                            help: "Allows the gateway to request photos or short video clips "
                                + "while OpenClaw is foregrounded.")

                        HStack(spacing: 8) {
                            Text("Location Access")
                            Spacer()
                            Button {
                                self.activeFeatureHelp = FeatureHelp(
                                    title: "Location Access",
                                    message: "Controls location permissions for OpenClaw. "
                                        + "Off disables location tools, While Using enables "
                                        + "foreground location, and Always enables "
                                        + "background location.")
                            } label: {
                                Image(systemName: "info.circle")
                                    .foregroundStyle(.secondary)
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Location Access info")
                        }
                        Picker("Location Access", selection: self.$locationEnabledModeRaw) {
                            Text("Off").tag(OpenClawLocationMode.off.rawValue)
                            Text("While Using").tag(OpenClawLocationMode.whileUsing.rawValue)
                            Text("Always").tag(OpenClawLocationMode.always.rawValue)
                        }
                        .labelsHidden()
                        .pickerStyle(.segmented)

                        self.featureToggle(
                            "Prevent Sleep",
                            isOn: self.$preventSleep,
                            help: "Keeps the screen awake while OpenClaw is open.")

                        DisclosureGroup("Advanced") {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Talk Voice (Gateway)")
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                LabeledContent("Provider", value: "ElevenLabs")
                                LabeledContent(
                                    "API Key",
                                    value: self.appModel.talkMode.gatewayTalkConfigLoaded
                                        ? (
                                            self.appModel.talkMode.gatewayTalkApiKeyConfigured
                                                ? "Configured"
                                                : "Not configured")
                                        : "Not loaded")
                                LabeledContent(
                                    "Default Model",
                                    value: self.appModel.talkMode.gatewayTalkDefaultModelId ?? "eleven_v3 (fallback)")
                                LabeledContent(
                                    "Default Voice",
                                    value: self.appModel.talkMode.gatewayTalkDefaultVoiceId ?? "auto (first available)")
                                Text("Configured on gateway via talk.apiKey, talk.modelId, and talk.voiceId.")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                            self.featureToggle(
                                "Show Talk Control",
                                isOn: self.$talkButtonEnabled,
                                help: "Shows the Talk control in the main toolbar.")
                            TextField("Default Share Instruction", text: self.$defaultShareInstruction, axis: .vertical)
                                .lineLimit(2...6)
                                .textInputAutocapitalization(.sentences)
                            HStack(spacing: 8) {
                                Text("Default Share Instruction")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Button {
                                    self.activeFeatureHelp = FeatureHelp(
                                        title: "Default Share Instruction",
                                        message: "Appends this instruction when sharing content "
                                            + "into OpenClaw from iOS.")
                                } label: {
                                    Image(systemName: "info.circle")
                                        .foregroundStyle(.secondary)
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel("Default Share Instruction info")
                            }

                            VStack(alignment: .leading, spacing: 8) {
                                Button {
                                    Task { await self.appModel.runSharePipelineSelfTest() }
                                } label: {
                                    Label("Run Share Self-Test", systemImage: "checkmark.seal")
                                }
                                Text(self.appModel.lastShareEventText)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }

                    DisclosureGroup("Device Info") {
                        TextField("Name", text: self.$displayName)
                        Text(self.instanceId)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        LabeledContent("Device", value: DeviceInfoHelper.deviceFamily())
                        LabeledContent("Platform", value: DeviceInfoHelper.platformStringForDisplay())
                        LabeledContent("OpenClaw", value: DeviceInfoHelper.openClawVersionString())
                    }
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        self.dismiss()
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .accessibilityLabel("Close")
                }
            }
            .sheet(isPresented: self.$showGatewayProblemDetails) {
                if let gatewayProblem = self.appModel.lastGatewayProblem {
                    GatewayProblemDetailsSheet(
                        problem: gatewayProblem,
                        primaryActionTitle: self.gatewayProblemPrimaryActionTitle(gatewayProblem),
                        onPrimaryAction: {
                            Task { await self.handleGatewayProblemPrimaryAction(gatewayProblem) }
                        })
                }
            }
            .sheet(isPresented: self.$showQRScanner) {
                NavigationStack {
                    QRScannerView(
                        onGatewayLink: { link in
                            self.handleScannedGatewayLink(link)
                        },
                        onError: { error in
                            self.showQRScanner = false
                            self.setupStatusText = "Scanner error: \(error)"
                            self.scannerError = error
                        },
                        onDismiss: {
                            self.showQRScanner = false
                        })
                        .ignoresSafeArea()
                        .navigationTitle("Scan QR Code")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar {
                            ToolbarItem(placement: .topBarLeading) {
                                Button("Cancel") { self.showQRScanner = false }
                            }
                        }
                }
            }
            .alert("Reset Onboarding?", isPresented: self.$showResetOnboardingAlert) {
                Button("Reset", role: .destructive) {
                    self.resetOnboarding()
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(
                    "This will disconnect, clear saved gateway connection + credentials, "
                        + "and reopen the onboarding wizard.")
            }
            .alert(item: self.$activeFeatureHelp) { help in
                Alert(
                    title: Text(help.title),
                    message: Text(help.message),
                    dismissButton: .default(Text("OK")))
            }
            .alert("QR Scanner Unavailable", isPresented: Binding(
                get: { self.scannerError != nil },
                set: { if !$0 { self.scannerError = nil } }))
            {
                Button("OK", role: .cancel) {}
            } message: {
                Text(self.scannerError ?? "")
            }
            .onAppear {
                self.lastLocationModeRaw = self.locationEnabledModeRaw
                self.syncManualPortText()
                let trimmedInstanceId = self.instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmedInstanceId.isEmpty {
                    self.gatewayToken = GatewaySettingsStore.loadGatewayToken(instanceId: trimmedInstanceId) ?? ""
                    self.gatewayPassword = GatewaySettingsStore.loadGatewayPassword(instanceId: trimmedInstanceId) ?? ""
                }
                self.defaultShareInstruction = ShareToAgentSettings.loadDefaultInstruction()
                self.appModel.refreshLastShareEventFromRelay()
                // Keep setup front-and-center when disconnected; keep things compact once connected.
                self.gatewayExpanded = !self.isGatewayConnected
                self.selectedAgentPickerId = self.appModel.selectedAgentId ?? ""
                if self.isGatewayConnected {
                    self.appModel.reloadTalkConfig()
                }
            }
            .onChange(of: self.selectedAgentPickerId) { _, newValue in
                let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
                self.appModel.setSelectedAgentId(trimmed.isEmpty ? nil : trimmed)
            }
            .onChange(of: self.appModel.selectedAgentId ?? "") { _, newValue in
                if newValue != self.selectedAgentPickerId {
                    self.selectedAgentPickerId = newValue
                }
            }
            .onChange(of: self.preferredGatewayStableID) { _, newValue in
                let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { return }
                GatewaySettingsStore.savePreferredGatewayStableID(trimmed)
            }
            .onChange(of: self.gatewayToken) { _, newValue in
                guard !self.suppressCredentialPersist else { return }
                let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
                let instanceId = self.instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !instanceId.isEmpty else { return }
                GatewaySettingsStore.saveGatewayToken(trimmed, instanceId: instanceId)
            }
            .onChange(of: self.gatewayPassword) { _, newValue in
                guard !self.suppressCredentialPersist else { return }
                let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
                let instanceId = self.instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !instanceId.isEmpty else { return }
                GatewaySettingsStore.saveGatewayPassword(trimmed, instanceId: instanceId)
            }
            .onChange(of: self.defaultShareInstruction) { _, newValue in
                ShareToAgentSettings.saveDefaultInstruction(newValue)
            }
            .onChange(of: self.manualGatewayPort) { _, _ in
                self.syncManualPortText()
            }
            .onChange(of: self.appModel.gatewayServerName) { _, newValue in
                if newValue != nil {
                    self.setupCode = ""
                    self.setupStatusText = nil
                    return
                }
                if self.manualGatewayEnabled {
                    self.setupStatusText = self.appModel.gatewayStatusText
                }
            }
            .onChange(of: self.appModel.gatewayStatusText) { _, newValue in
                guard self.manualGatewayEnabled || self.connectingGatewayID == "manual" else { return }
                let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { return }
                self.setupStatusText = trimmed
            }
            .onChange(of: self.locationEnabledModeRaw) { _, newValue in
                let previous = self.lastLocationModeRaw
                self.lastLocationModeRaw = newValue
                guard let mode = OpenClawLocationMode(rawValue: newValue) else { return }
                Task {
                    let granted = await self.appModel.requestLocationPermissions(mode: mode)
                    if !granted {
                        await MainActor.run {
                            self.locationEnabledModeRaw = previous
                            self.lastLocationModeRaw = previous
                        }
                        return
                    }
                    await MainActor.run {
                        self.gatewayController.refreshActiveGatewayRegistrationFromSettings()
                    }
                }
            }
        }
        .gatewayTrustPromptAlert()
    }

    @ViewBuilder
    private func gatewayList(showing: GatewayListMode) -> some View {
        if self.gatewayController.gateways.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text("No gateways found yet.")
                    .foregroundStyle(.secondary)
                Text("If your gateway is on another network, connect it and ensure DNS is working.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                if let lastKnown = GatewaySettingsStore.loadLastGatewayConnection(),
                   case let .manual(host, port, _, _) = lastKnown
                {
                    Button {
                        Task { await self.connectLastKnown() }
                    } label: {
                        self.lastKnownButtonLabel(host: host, port: port)
                    }
                    .disabled(self.connectingGatewayID != nil)
                    .buttonStyle(.borderedProminent)
                    .tint(self.appModel.seamColor)
                }
            }
        } else {
            let connectedID = self.appModel.connectedGatewayID
            let rows = self.gatewayController.gateways.filter { gateway in
                let isConnected = gateway.stableID == connectedID
                switch showing {
                case .all:
                    return true
                case .availableOnly:
                    return !isConnected
                }
            }

            if rows.isEmpty, showing == .availableOnly {
                Text("No other gateways found.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(rows) { gateway in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            // Avoid localized-string formatting edge cases from Bonjour-advertised names.
                            Text(verbatim: gateway.name)
                            let detailLines = self.gatewayDetailLines(gateway)
                            ForEach(detailLines, id: \.self) { line in
                                Text(verbatim: line)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer()

                        Button {
                            Task { await self.connect(gateway) }
                        } label: {
                            if self.connectingGatewayID == gateway.id {
                                ProgressView()
                                    .progressViewStyle(.circular)
                            } else {
                                Text("Connect")
                            }
                        }
                        .disabled(self.connectingGatewayID != nil)
                    }
                }
            }
        }
    }

    private enum GatewayListMode: Equatable {
        case all
        case availableOnly
    }

    private var isGatewayConnected: Bool {
        let status = self.appModel.gatewayStatusText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if status.contains("connected") { return true }
        return self.appModel.gatewayServerName != nil && !status.contains("offline")
    }

    private var gatewaySummaryText: String {
        if let server = self.appModel.gatewayServerName, self.isGatewayConnected {
            return server
        }
        if let problem = self.appModel.lastGatewayProblem {
            return problem.statusText
        }
        let trimmed = self.appModel.gatewayStatusText.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "Not connected" : trimmed
    }

    private func featureToggle(
        _ title: String,
        isOn: Binding<Bool>,
        help: String,
        onChange: ((Bool) -> Void)? = nil) -> some View
    {
        HStack(spacing: 8) {
            Toggle(title, isOn: isOn)
            Button {
                self.activeFeatureHelp = FeatureHelp(title: title, message: help)
            } label: {
                Image(systemName: "info.circle")
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(title) info")
        }
        .onChange(of: isOn.wrappedValue) { _, newValue in
            onChange?(newValue)
        }
    }

    private func connect(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) async {
        self.connectingGatewayID = gateway.id
        self.manualGatewayEnabled = false
        self.preferredGatewayStableID = gateway.stableID
        GatewaySettingsStore.savePreferredGatewayStableID(gateway.stableID)
        self.lastDiscoveredGatewayStableID = gateway.stableID
        GatewaySettingsStore.saveLastDiscoveredGatewayStableID(gateway.stableID)
        defer { self.connectingGatewayID = nil }

        let err = await self.gatewayController.connectWithDiagnostics(gateway)
        if let err {
            self.setupStatusText = err
        }
    }

    private func connectLastKnown() async {
        self.connectingGatewayID = "last-known"
        defer { self.connectingGatewayID = nil }
        await self.gatewayController.connectLastKnown()
    }

    private func gatewayDebugText() -> String {
        var lines: [String] = [
            "gateway: \(self.appModel.gatewayDisplayStatusText)",
            "discovery: \(self.gatewayController.discoveryStatusText)",
        ]
        lines.append("server: \(self.appModel.gatewayServerName ?? "—")")
        lines.append("address: \(self.appModel.gatewayRemoteAddress ?? "—")")
        if let last = self.gatewayController.discoveryDebugLog.last?.message {
            lines.append("discovery log: \(last)")
        }
        return lines.joined(separator: "\n")
    }

    @ViewBuilder
    private func lastKnownButtonLabel(host: String, port: Int) -> some View {
        if self.connectingGatewayID == "last-known" {
            HStack(spacing: 8) {
                ProgressView()
                    .progressViewStyle(.circular)
                Text("Connecting…")
            }
            .frame(maxWidth: .infinity)
        } else {
            HStack(spacing: 8) {
                Image(systemName: "bolt.horizontal.circle.fill")
                VStack(alignment: .leading, spacing: 2) {
                    Text("Connect last known")
                    Text("\(host):\(port)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .frame(maxWidth: .infinity)
        }
    }

    private var manualPortBinding: Binding<String> {
        Binding(
            get: { self.manualGatewayPortText },
            set: { newValue in
                let filtered = newValue.filter(\.isNumber)
                if self.manualGatewayPortText != filtered {
                    self.manualGatewayPortText = filtered
                }
                if filtered.isEmpty {
                    if self.manualGatewayPort != 0 {
                        self.manualGatewayPort = 0
                    }
                } else if let port = Int(filtered), self.manualGatewayPort != port {
                    self.manualGatewayPort = port
                }
            })
    }

    private var manualPortIsValid: Bool {
        if self.manualGatewayPortText.isEmpty { return true }
        return self.manualGatewayPort >= 1 && self.manualGatewayPort <= 65535
    }

    private func syncManualPortText() {
        if self.manualGatewayPort > 0 {
            let next = String(self.manualGatewayPort)
            if self.manualGatewayPortText != next {
                self.manualGatewayPortText = next
            }
        } else if !self.manualGatewayPortText.isEmpty {
            self.manualGatewayPortText = ""
        }
    }

    private func applySetupCodeAndConnect() async {
        self.setupStatusText = nil
        guard self.applySetupCode() else { return }
        let host = self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedPort = self.resolvedManualPort(host: host)
        let hasToken = !self.gatewayToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let hasPassword = !self.gatewayPassword.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        GatewayDiagnostics.log(
            "setup code applied host=\(host) port=\(resolvedPort ?? -1) "
                + "tls=\(self.manualGatewayTLS) token=\(hasToken) password=\(hasPassword)")
        guard let port = resolvedPort else {
            self.setupStatusText = "Failed: invalid port"
            return
        }
        let ok = await self.preflightGateway(host: host, port: port, useTLS: self.manualGatewayTLS)
        guard ok else { return }
        self.setupStatusText = "Setup code applied. Connecting…"
        await self.connectManual()
    }

    @discardableResult
    private func applySetupCode() -> Bool {
        let raw = self.setupCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else {
            self.setupStatusText = "Paste a setup code to continue."
            return false
        }

        guard let link = GatewayConnectDeepLink.fromSetupInput(raw) else {
            self.setupStatusText = "Setup code not recognized or uses an insecure ws:// gateway URL."
            return false
        }

        self.applyGatewayLink(link)
        return true
    }

    private func applyGatewayLink(_ link: GatewayConnectDeepLink) {
        self.manualGatewayHost = link.host
        self.manualGatewayPort = link.port
        self.manualGatewayPortText = String(link.port)
        self.manualGatewayTLS = link.tls

        let trimmedInstanceId = self.instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedBootstrapToken =
            link.bootstrapToken?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedInstanceId.isEmpty {
            GatewaySettingsStore.saveGatewayBootstrapToken(trimmedBootstrapToken, instanceId: trimmedInstanceId)
        }
        if let token = link.token, !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
            self.gatewayToken = trimmedToken
            if !trimmedInstanceId.isEmpty {
                GatewaySettingsStore.saveGatewayToken(trimmedToken, instanceId: trimmedInstanceId)
            }
        } else if !trimmedBootstrapToken.isEmpty {
            self.gatewayToken = ""
            if !trimmedInstanceId.isEmpty {
                GatewaySettingsStore.saveGatewayToken("", instanceId: trimmedInstanceId)
            }
        }
        if let password = link.password, !password.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let trimmedPassword = password.trimmingCharacters(in: .whitespacesAndNewlines)
            self.gatewayPassword = trimmedPassword
            if !trimmedInstanceId.isEmpty {
                GatewaySettingsStore.saveGatewayPassword(trimmedPassword, instanceId: trimmedInstanceId)
            }
        } else if !trimmedBootstrapToken.isEmpty {
            self.gatewayPassword = ""
            if !trimmedInstanceId.isEmpty {
                GatewaySettingsStore.saveGatewayPassword("", instanceId: trimmedInstanceId)
            }
        }
    }

    private func openGatewayQRScanner() {
        self.appModel.disconnectGateway()
        self.connectingGatewayID = nil
        self.setupStatusText = "Opening QR scanner…"
        self.showQRScanner = true
    }

    private func handleScannedGatewayLink(_ link: GatewayConnectDeepLink) {
        self.showQRScanner = false
        self.setupCode = ""
        self.applyGatewayLink(link)
        self.setupStatusText = "QR loaded. Connecting to \(link.host):\(link.port)…"
        Task { await self.connectAfterScannedGatewayLink() }
    }

    private func connectAfterScannedGatewayLink() async {
        let host = self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedPort = self.resolvedManualPort(host: host)
        guard let port = resolvedPort else {
            self.setupStatusText = "Failed: invalid port"
            return
        }
        let ok = await self.preflightGateway(host: host, port: port, useTLS: self.manualGatewayTLS)
        guard ok else { return }
        await self.connectManual()
    }

    private func resolvedManualPort(host: String) -> Int? {
        if self.manualGatewayPort > 0 {
            return self.manualGatewayPort <= 65535 ? self.manualGatewayPort : nil
        }
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if self.manualGatewayTLS, trimmed.lowercased().hasSuffix(".ts.net") {
            return 443
        }
        return 18789
    }

    private func preflightGateway(host: String, port: Int, useTLS: Bool) async -> Bool {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }

        if Self.isTailnetHostOrIP(trimmed), !Self.hasTailnetIPv4() {
            let msg = "Tailscale is off on this iPhone. Turn it on, then try again."
            self.setupStatusText = msg
            GatewayDiagnostics.log("preflight fail: tailnet missing host=\(trimmed)")
            self.gatewayLogger.warning("\(msg, privacy: .public)")
            return false
        }

        self.setupStatusText = "Checking gateway reachability…"
        let ok = await Self.probeTCP(host: trimmed, port: port, timeoutSeconds: 3)
        if !ok {
            let msg = "Can't reach gateway at \(trimmed):\(port). Check Tailscale or LAN."
            self.setupStatusText = msg
            GatewayDiagnostics.log("preflight fail: unreachable host=\(trimmed) port=\(port)")
            self.gatewayLogger.warning("\(msg, privacy: .public)")
            return false
        }
        GatewayDiagnostics.log("preflight ok host=\(trimmed) port=\(port) tls=\(useTLS)")
        return true
    }

    private static func probeTCP(host: String, port: Int, timeoutSeconds: Double) async -> Bool {
        await TCPProbe.probe(
            host: host,
            port: port,
            timeoutSeconds: timeoutSeconds,
            queueLabel: "gateway.preflight")
    }

    private func connectManual() async {
        let host = self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty else {
            self.setupStatusText = "Failed: host required"
            return
        }
        guard self.manualPortIsValid else {
            self.setupStatusText = "Failed: invalid port"
            return
        }

        self.connectingGatewayID = "manual"
        self.manualGatewayEnabled = true
        defer { self.connectingGatewayID = nil }

        GatewayDiagnostics.log(
            "connect manual host=\(host) port=\(self.manualGatewayPort) tls=\(self.manualGatewayTLS)")
        await self.gatewayController.connectManual(
            host: host,
            port: self.manualGatewayPort,
            useTLS: self.manualGatewayTLS)
    }

    private var setupStatusLine: String? {
        if let problem = self.appModel.lastGatewayProblem {
            return problem.message
        }
        let trimmedSetup = self.setupStatusText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let gatewayStatus = self.appModel.gatewayStatusText.trimmingCharacters(in: .whitespacesAndNewlines)
        if let friendly = self.friendlyGatewayMessage(from: gatewayStatus) { return friendly }
        if let friendly = self.friendlyGatewayMessage(from: trimmedSetup) { return friendly }
        if !trimmedSetup.isEmpty { return trimmedSetup }
        if gatewayStatus.isEmpty || gatewayStatus == "Offline" { return nil }
        return gatewayStatus
    }

    private var tailnetWarningText: String? {
        let host = self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty else { return nil }
        guard Self.isTailnetHostOrIP(host) else { return nil }
        guard !Self.hasTailnetIPv4() else { return nil }
        return "This gateway is on your tailnet. Turn on Tailscale on this iPhone, then tap Connect."
    }

    private func friendlyGatewayMessage(from raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let lower = trimmed.lowercased()
        if lower.contains("pairing required") {
            return "Pairing required. Go back to your OpenClaw chat and run /pair approve, then tap Connect again."
        }
        if lower.contains("device nonce required") || lower.contains("device nonce mismatch") {
            return "Secure handshake failed. Make sure Tailscale is connected, then tap Connect again."
        }
        if lower.contains("device signature expired") || lower.contains("device signature invalid") {
            return "Secure handshake failed. Check that your iPhone time is correct, then tap Connect again."
        }
        if lower.contains("connect timed out") || lower.contains("timed out") {
            return "Connection timed out. Make sure Tailscale is connected, then try again."
        }
        if lower.contains("unauthorized role") {
            return "Connected, but some controls are restricted for nodes. This is expected."
        }
        return nil
    }

    private static func hasTailnetIPv4() -> Bool {
        var addrList: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&addrList) == 0, let first = addrList else { return false }
        defer { freeifaddrs(addrList) }

        for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(ptr.pointee.ifa_flags)
            let isUp = (flags & IFF_UP) != 0
            let isLoopback = (flags & IFF_LOOPBACK) != 0
            let family = ptr.pointee.ifa_addr.pointee.sa_family
            if !isUp || isLoopback || family != UInt8(AF_INET) { continue }

            var addr = ptr.pointee.ifa_addr.pointee
            var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let result = getnameinfo(
                &addr,
                socklen_t(ptr.pointee.ifa_addr.pointee.sa_len),
                &buffer,
                socklen_t(buffer.count),
                nil,
                0,
                NI_NUMERICHOST)
            guard result == 0 else { continue }
            let len = buffer.prefix { $0 != 0 }
            let bytes = len.map { UInt8(bitPattern: $0) }
            guard let ip = String(bytes: bytes, encoding: .utf8) else { continue }
            if self.isTailnetIPv4(ip) { return true }
        }

        return false
    }

    private static func isTailnetHostOrIP(_ host: String) -> Bool {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if trimmed.hasSuffix(".ts.net") || trimmed.hasSuffix(".ts.net.") {
            return true
        }
        return self.isTailnetIPv4(trimmed)
    }

    private static func isTailnetIPv4(_ ip: String) -> Bool {
        let parts = ip.split(separator: ".")
        guard parts.count == 4 else { return false }
        let octets = parts.compactMap { Int($0) }
        guard octets.count == 4 else { return false }
        let a = octets[0]
        let b = octets[1]
        guard (0...255).contains(a), (0...255).contains(b) else { return false }
        return a == 100 && b >= 64 && b <= 127
    }

    private static func parseHostPort(from address: String) -> SettingsHostPort? {
        SettingsNetworkingHelpers.parseHostPort(from: address)
    }

    private static func httpURLString(host: String?, port: Int?, fallback: String) -> String {
        SettingsNetworkingHelpers.httpURLString(host: host, port: port, fallback: fallback)
    }

    private func retryGatewayConnectionFromProblem() async {
        if self.manualGatewayEnabled || self.connectingGatewayID == "manual" {
            await self.connectManual()
            return
        }
        await self.connectLastKnown()
    }

    private func gatewayProblemPrimaryActionTitle(_ problem: GatewayConnectionProblem) -> String {
        problem.canTrustRotatedCertificate ? "Trust certificate" : "Retry connection"
    }

    private func handleGatewayProblemPrimaryAction(_ problem: GatewayConnectionProblem) async {
        if problem.canTrustRotatedCertificate {
            _ = await self.gatewayController.trustRotatedGatewayCertificate(from: problem)
            return
        }
        await self.retryGatewayConnectionFromProblem()
    }

    private func resetOnboarding() {
        // Disconnect first so RootCanvas doesn't instantly mark onboarding complete again.
        self.appModel.disconnectGateway()
        self.connectingGatewayID = nil
        self.setupStatusText = nil
        self.setupCode = ""
        self.gatewayAutoConnect = false

        self.suppressCredentialPersist = true
        defer { self.suppressCredentialPersist = false }

        self.gatewayToken = ""
        self.gatewayPassword = ""

        let trimmedInstanceId = self.instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedInstanceId.isEmpty {
            GatewaySettingsStore.deleteGatewayCredentials(instanceId: trimmedInstanceId)
        }

        // Reset onboarding state + clear saved gateway connection (the two things RootCanvas checks).
        GatewaySettingsStore.clearLastGatewayConnection()
        GatewaySettingsStore.clearPreferredGatewayStableID()
        GatewaySettingsStore.clearLastDiscoveredGatewayStableID()
        // Resetting onboarding should also forget trusted gateway TLS fingerprints.
        // Otherwise a restarted dev gateway can stay stuck in a local TLS cancel loop.
        GatewayTLSStore.clearAllFingerprints()
        OnboardingStateStore.reset()

        // RootCanvas also short-circuits onboarding when these are true.
        self.onboardingComplete = false
        self.hasConnectedOnce = false

        // Clear manual override so it doesn't count as an existing gateway config.
        self.manualGatewayEnabled = false
        self.manualGatewayHost = ""

        // Force re-present even without app restart.
        self.onboardingRequestID += 1

        // The onboarding wizard is presented from RootCanvas; dismiss Settings so it can show.
        self.dismiss()
    }

    private func gatewayDetailLines(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) -> [String] {
        var lines: [String] = []
        if let lanHost = gateway.lanHost { lines.append("LAN: \(lanHost)") }
        if let tailnet = gateway.tailnetDns { lines.append("Tailnet: \(tailnet)") }

        let gatewayPort = gateway.gatewayPort
        let canvasPort = gateway.canvasPort
        if gatewayPort != nil || canvasPort != nil {
            let gw = gatewayPort.map(String.init) ?? "—"
            let canvas = canvasPort.map(String.init) ?? "—"
            lines.append("Ports: gateway \(gw) · canvas \(canvas)")
        }

        if lines.isEmpty {
            lines.append(gateway.debugID)
        }

        return lines
    }
}

// swiftlint:enable type_body_length
