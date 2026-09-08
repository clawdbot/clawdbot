import AppKit
import Observation
import OpenClawDiscovery
import OpenClawKit
import SwiftUI

struct ConnectionSettingsView: View {
    static let fieldWidth: CGFloat = 250

    @Bindable var state: AppState
    let isActive: Bool
    private let healthStore = HealthStore.shared
    private let gatewayManager = GatewayProcessManager.shared
    @State private var gatewayDiscovery = GatewayDiscoveryModel(
        localDisplayName: InstanceIdentity.displayName)
    @State private var remoteStatus: RemoteStatus = .idle
    private let isPreview = ProcessInfo.processInfo.isPreview
    private var isNixMode: Bool {
        ProcessInfo.processInfo.isNixMode
    }

    private var gatewayStatus: GatewayEnvironmentStatus {
        self.gatewayManager.environmentStatus
    }

    init(state: AppState, isActive: Bool = true) {
        self.state = state
        self.isActive = isActive
    }

    var body: some View {
        Form {
            self.statusSection
            self.gatewayModeSection

            // The Remote section owns this banner in remote mode; Local and Not configured
            // still need to see conflicts and rejected saves.
            if self.state.connectionMode != .remote,
               self.state.gatewayConfigConflict != nil || self.state.gatewayConfigSyncFailure != nil
            {
                Section(self.state.gatewayConfigConflict != nil ? "Remote Access" : "Connection") {
                    GatewayConfigConflictRecoveryView(state: self.state)
                }
            }

            switch self.state.connectionMode {
            case .unconfigured:
                EmptyView()
            case .local:
                self.localGatewaySection
                TailscaleIntegrationSection(
                    connectionMode: self.state.connectionMode,
                    isPaused: self.state.isPaused,
                    isActive: self.isActive)
            case .remote:
                self.remoteAccessSection
                self.nearbyGatewaysSection
            }

            self.dashboardSettingsSection
        }
        .formStyle(.grouped)
        .onAppear { self.updateActiveWork(active: self.isActive) }
        .onChange(of: self.isActive) { _, active in
            self.updateActiveWork(active: active)
        }
        .onDisappear { self.gatewayDiscovery.stop() }
    }

    private func updateActiveWork(active: Bool) {
        guard !self.isPreview else { return }
        if active {
            self.refreshGatewayStatus()
            self.gatewayDiscovery.start()
        } else {
            self.gatewayDiscovery.stop()
        }
    }

    // MARK: - Status

    private var statusSection: some View {
        Section {
            HStack(spacing: 12) {
                Image(systemName: self.connectionStatusIcon)
                    .font(.system(size: 22, weight: .medium))
                    .foregroundStyle(self.connectionStatusTint)
                    .frame(width: 32, height: 32)

                VStack(alignment: .leading, spacing: 2) {
                    Text(self.connectionStatusTitle)
                        .font(.headline)
                    Text(self.connectionStatusSubtitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 12)

                if let latency = self.latencyText {
                    Text(latency)
                        .font(.callout.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 4)
        }
    }

    private var latencyText: String? {
        guard ControlChannel.shared.state == .connected,
              self.localGatewayFailure == nil,
              let ping = ControlChannel.shared.lastPingMs
        else { return nil }
        return String(format: String(localized: "%lld ms"), Int(ping))
    }

    private var connectionStatusIcon: String {
        switch self.state.connectionMode {
        case .local: "desktopcomputer"
        case .remote: self.state.remoteTransport == .ssh ? "point.3.connected.trianglepath.dotted" : "network"
        case .unconfigured: "questionmark.circle"
        }
    }

    private var connectionStatusTint: Color {
        if self.localGatewayFailure != nil { return .red }
        switch ControlChannel.shared.state {
        case .connected: return .green
        case .connecting, .disconnected, .degraded: return .orange
        }
    }

    private var connectionStatusTitle: String {
        switch self.state.connectionMode {
        case .local: "Local Gateway"
        case .remote: self.state.remoteTransport == .ssh ? "Remote Gateway via SSH" : "Remote Gateway direct"
        case .unconfigured: "Gateway not configured"
        }
    }

    private var connectionStatusSubtitle: String {
        if let failure = self.localGatewayFailure { return failure }
        switch self.state.connectionMode {
        case .local:
            return self.gatewayManager.installation == .external
                ? "OpenClaw connects to an independently managed Gateway on this Mac."
                : "OpenClaw starts and monitors the Gateway on this Mac."
        case .remote:
            let target = self.state.remoteTransport == .ssh ? self.state.remoteTarget : self.state.remoteUrl
            let trimmed = target.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                return "Enter a remote endpoint so this Mac app can attach cleanly."
            }
            // Disconnected status lines already name the endpoint; avoid printing it twice.
            let statusLine = self.controlStatusLine
            let endpoint = trimmed.replacingOccurrences(of: #"^[a-z]+://"#, with: "", options: .regularExpression)
            var parts = statusLine.contains(endpoint) ? [statusLine] : [statusLine, trimmed]
            if let authLabel = ControlChannel.shared.authSourceLabel {
                parts.append(authLabel)
            }
            return parts.joined(separator: " · ")
        case .unconfigured:
            return "Choose local or remote before the app can attach to a Gateway."
        }
    }

    private var localGatewayFailure: String? {
        self.state.connectionMode == .local ? self.gatewayManager.lastFailureReason : nil
    }

    private var controlStatusLine: String {
        GatewayConnectionPresentation(state: ControlChannel.shared.state).statusLine
    }

    // MARK: - Gateway

    private var gatewayModeSection: some View {
        Section {
            LabeledContent {
                Picker("Gateway location", selection: self.$state.connectionMode) {
                    Text("Not configured").tag(AppState.ConnectionMode.unconfigured)
                    Text("Local (this Mac)").tag(AppState.ConnectionMode.local)
                    Text("Remote (another host)").tag(AppState.ConnectionMode.remote)
                }
                .labelsHidden()
                .fixedSize()
            } label: {
                Text("OpenClaw runs")
                Text("Own a Gateway on this Mac, or attach to one on another host.")
            }
        } header: {
            Text("Gateway")
        } footer: {
            if self.state.connectionMode == .unconfigured {
                Text("""
                Local is best for this Mac. Remote is best when the Gateway already runs on a Mac Studio or server.
                """)
            }
        }
    }

    // MARK: - Local

    private var localGatewaySection: some View {
        Section {
            if !self.isNixMode {
                switch self.gatewayManager.installation {
                case .managed:
                    self.gatewayInstallerRow
                case .external:
                    LabeledContent {
                        Text(self.gatewayManager.status.label)
                            .foregroundStyle(.secondary)
                    } label: {
                        Text("Independently managed Gateway")
                        Text("This app connects without installing or updating its CLI runtime.")
                    }
                case .unreadable:
                    Text(GatewayProcessManager.Installation.ownershipFailure)
                        .foregroundStyle(.orange)
                }
            }
            self.healthRow
        } header: {
            Text("Local Gateway")
        } footer: {
            if !self.isNixMode, self.gatewayManager.installation == .managed {
                Text(String(
                    format: String(localized: "Gateway auto-starts in local mode via launchd (%@)."),
                    gatewayLaunchdLabel))
            }
        }
    }

    private var gatewayInstallerRow: some View {
        LabeledContent {
            Button("Recheck") { self.refreshGatewayStatus() }
        } label: {
            HStack(spacing: 8) {
                Circle()
                    .fill(self.gatewayStatusColor)
                    .frame(width: 8, height: 8)
                Text(self.gatewayStatus.message)
            }
            if let detail = self.gatewayInstallerDetail {
                Text(detail)
            }
            if let failure = self.gatewayManager.lastFailureReason {
                Text(String(format: String(localized: "Last failure: %@"), failure))
                    .foregroundStyle(.red)
            }
        }
    }

    private var gatewayInstallerDetail: String? {
        var parts: [String] = []
        if let gatewayVersion = self.gatewayStatus.gatewayVersion,
           let required = self.gatewayStatus.requiredGateway,
           gatewayVersion != required
        {
            parts.append(String(
                format: String(localized: "Installed: %@ · Required: %@"), gatewayVersion, required))
        } else if let gatewayVersion = self.gatewayStatus.gatewayVersion {
            parts.append(String(format: String(localized: "Gateway %@ detected"), gatewayVersion))
        }
        if let node = self.gatewayStatus.nodeVersion {
            parts.append("Node \(node)")
        }
        if case let .attachedExisting(details) = self.gatewayManager.status {
            parts.append(details ?? String(localized: "Using existing gateway instance"))
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func refreshGatewayStatus() {
        guard self.state.connectionMode == .local, self.gatewayManager.installation == .managed else { return }
        self.gatewayManager.refreshEnvironmentStatus(force: true)
    }

    private var gatewayStatusColor: Color {
        if self.localGatewayFailure != nil { return .red }
        switch self.gatewayStatus.kind {
        case .ok: return .green
        case .checking: return .secondary
        case .missingNode, .missingGateway, .incompatible, .error: return .orange
        }
    }

    // MARK: - Remote

    private var remoteAccessSection: some View {
        Section {
            LabeledContent("Transport") {
                Picker("Transport", selection: self.$state.remoteTransport) {
                    Text("SSH tunnel").tag(AppState.RemoteTransport.ssh)
                    Text("Direct (ws/wss)").tag(AppState.RemoteTransport.direct)
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .fixedSize()
            }

            if self.state.remoteTransport == .ssh {
                self.remoteSshRow
            } else {
                self.remoteDirectRow
            }

            LabeledContent {
                SecureField("Gateway token", text: self.$state.remoteToken, prompt: Text("gateway.remote.token"))
                    .labelsHidden()
                    .multilineTextAlignment(.leading)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: Self.fieldWidth)
            } label: {
                Text("Gateway token")
                Text("Used when the remote Gateway requires token auth.")
            }

            if self.state.remoteTokenUnsupported {
                Text(
                    "The current gateway.remote.token value is not plain text. "
                        + "OpenClaw for macOS cannot use it directly; "
                        + "enter a plaintext token here to replace it.")
                    .font(.callout)
                    .foregroundStyle(.orange)
            }

            GatewayConfigConflictRecoveryView(state: self.state)

            if self.state.remoteTransport == .ssh {
                self.sshCommandDetails
            }
        } header: {
            Text("Remote Access")
        } footer: {
            self.remoteAccessFooter
        }
    }

    private var sshValidationMessage: String? {
        let trimmed = self.state.remoteTarget.trimmingCharacters(in: .whitespacesAndNewlines)
        return CommandResolver.sshTargetValidationMessage(trimmed)
    }

    private var remoteSshRow: some View {
        let trimmedTarget = self.state.remoteTarget.trimmingCharacters(in: .whitespacesAndNewlines)
        let canTest = !trimmedTarget.isEmpty && self.sshValidationMessage == nil

        return LabeledContent("SSH target") {
            HStack(spacing: 8) {
                TextField("SSH target", text: self.$state.remoteTarget, prompt: Text("user@host[:22]"))
                    .labelsHidden()
                    .multilineTextAlignment(.leading)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: Self.fieldWidth)
                self.remoteTestButton(disabled: !canTest)
            }
        }
    }

    private var remoteDirectRow: some View {
        LabeledContent("Gateway URL") {
            HStack(spacing: 8) {
                TextField(
                    "Gateway URL",
                    text: self.$state.remoteUrl,
                    prompt: Text(verbatim: "wss://gateway.example.ts.net"))
                    .labelsHidden()
                    .multilineTextAlignment(.leading)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: Self.fieldWidth)
                self.remoteTestButton(
                    disabled: self.state.remoteUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }

    private func remoteTestButton(disabled: Bool) -> some View {
        Button {
            Task { await self.testRemote() }
        } label: {
            if self.remoteStatus == .checking {
                ProgressView().controlSize(.small)
            } else {
                Text("Test")
            }
        }
        .frame(minWidth: 48)
        .disabled(self.remoteStatus == .checking || disabled)
    }

    @ViewBuilder
    private var remoteAccessFooter: some View {
        if self.state.remoteTransport == .ssh, let validationMessage = self.sshValidationMessage {
            Text(validationMessage)
                .foregroundStyle(.red)
        } else {
            switch self.remoteStatus {
            case .idle:
                Text(self.state.remoteTransport == .ssh
                    ? "SSH keeps the Gateway private. Tailscale plus an SSH tunnel gives stable private access."
                    : "Use wss:// for public hosts; ws:// is allowed for localhost, LAN, .local, and Tailnet hosts. "
                    + "Tailscale Serve provides a valid HTTPS certificate.")
            case .checking:
                Text("Testing the remote Gateway…")
            case let .ok(success):
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(success.title)
                        if let detail = success.detail {
                            Text(detail)
                        }
                    }
                }
            case let .failed(message):
                Text(message)
                    .foregroundStyle(.red)
            }
        }
    }

    private var nearbyGatewaysSection: some View {
        Section {
            GatewayDiscoveryInlineList(
                discovery: self.gatewayDiscovery,
                currentTarget: self.state.remoteTarget,
                currentUrl: self.state.remoteUrl,
                transport: self.state.remoteTransport)
            { gateway in
                self.applyDiscoveredGateway(gateway)
            }
        } header: {
            Text("Nearby Gateways")
        } footer: {
            Text(self.gatewayDiscovery.statusText)
        }
    }

    private var sshCommandDetails: some View {
        DisclosureGroup("SSH command details") {
            TextField(
                "Identity file",
                text: self.$state.remoteIdentity,
                prompt: Text(verbatim: "/Users/you/.ssh/id_ed25519"))
            TextField(
                "Project root",
                text: self.$state.remoteProjectRoot,
                prompt: Text(verbatim: "/home/you/Projects/openclaw"))
            TextField(
                "CLI path",
                text: self.$state.remoteCliPath,
                prompt: Text(verbatim: "/Applications/OpenClaw.app/.../openclaw"))
        }
        .multilineTextAlignment(.leading)
        .textFieldStyle(.roundedBorder)
    }

    // MARK: - Dashboard handoff

    private var dashboardSettingsSection: some View {
        Section {
            LabeledContent {
                Button("Open Dashboard Settings…") { AppNavigationActions.openSettings() }
            } label: {
                Text("App settings")
                Text("""
                Permissions, Quick Chat, voice, and updates live in Dashboard → Settings → This Mac \
                and need a Gateway release that includes those pages.
                """)
            }
        }
    }
}

private enum RemoteStatus: Equatable {
    case idle
    case checking
    case ok(RemoteGatewayProbeSuccess)
    case failed(String)
}

extension ConnectionSettingsView {
    private var healthRow: some View {
        LabeledContent {
            HStack(spacing: 8) {
                Button("Retry now") {
                    Task { await HealthStore.shared.refresh(onDemand: true) }
                }
                .disabled(self.healthStore.isRefreshing)
                Button("Open logs") { self.revealLogs() }
            }
        } label: {
            HStack(spacing: 8) {
                Circle()
                    .fill(self.healthStore.state.tint)
                    .frame(width: 8, height: 8)
                Text(self.healthStore.summaryLine)
            }
            if let detail = self.healthStore.detailLine {
                Text(detail)
            }
        }
    }

    @MainActor
    func testRemote() async {
        self.remoteStatus = .checking
        switch await RemoteGatewayProbe.run() {
        case let .ready(success):
            self.remoteStatus = .ok(success)
        case let .authIssue(issue):
            self.remoteStatus = .failed(issue.statusMessage)
        case let .failed(message):
            self.remoteStatus = .failed(message)
        }
    }

    private func revealLogs() {
        let target = LogLocator.bestLogFile()

        if let target {
            NSWorkspace.shared.selectFile(
                target.path,
                inFileViewerRootedAtPath: target.deletingLastPathComponent().path)
            return
        }

        let alert = NSAlert()
        alert.messageText = "Log file not found"
        alert.informativeText = """
        Looked for openclaw logs in /tmp/openclaw/.
        Run a health check or send a message to generate activity, then try again.
        """
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.runModal()
    }

    private func applyDiscoveredGateway(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) {
        GatewayDiscoverySelectionSupport.applyRemoteSelection(gateway: gateway, state: self.state)
        MacNodeModeCoordinator.shared.setPreferredGatewayStableID(gateway.stableID, state: self.state)
    }
}

#if DEBUG
struct ConnectionSettingsView_Previews: PreviewProvider {
    static var previews: some View {
        ConnectionSettingsView(state: .preview)
            .frame(width: ConnectionWindow.width, height: 700)
            .environment(TailscaleService.shared)
    }
}
#endif
