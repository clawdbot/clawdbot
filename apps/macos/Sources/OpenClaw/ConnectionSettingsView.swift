import AppKit
import Observation
import OpenClawDiscovery
import OpenClawKit
import SwiftUI

struct ConnectionSettingsView: View {
    private static let remoteFieldWidth: CGFloat = 320
    private static let remoteSecretFieldWidth: CGFloat = 300

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
        ScrollView(.vertical) {
            self.connectionPage
                .settingsDetailContent()
        }
        .onAppear { self.updateActiveWork(active: self.isActive) }
        .onChange(of: self.isActive) { _, active in
            self.updateActiveWork(active: active)
        }
        .onDisappear { self.gatewayDiscovery.stop() }
    }

    private var connectionPage: some View {
        VStack(alignment: .leading, spacing: 20) {
            SettingsPageHeader(
                title: "Connection",
                subtitle: "Choose where the Gateway runs and how this Mac app reaches it.")

            self.connectionStatusPanel
            self.gatewayModeGroup

            if self.state.connectionMode != .remote,
               self.state.gatewayConfigConflict != nil
            {
                SettingsCardGroup("Remote Access") {
                    GatewayConfigConflictRecoveryView(state: self.state)
                }
            }

            switch self.state.connectionMode {
            case .unconfigured:
                EmptyView()
            case .local:
                self.localGatewayGroup
            case .remote:
                self.remoteCard
            }

            HStack(spacing: 12) {
                Text("""
                App-local settings (permissions, Quick Chat, voice, updates) live in \
                Dashboard → Settings → This Mac and require a Gateway release that includes those pages.
                """)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                Button("Open Dashboard Settings") { AppNavigationActions.openSettings() }
                    .controlSize(.small)
                    .fixedSize()
            }
        }
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

    private var connectionStatusPanel: some View {
        HStack(alignment: .center, spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(self.connectionStatusTint.opacity(0.18))
                Image(systemName: self.connectionStatusIcon)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(self.connectionStatusTint)
            }
            .frame(width: 46, height: 46)

            VStack(alignment: .leading, spacing: 4) {
                Text(self.connectionStatusTitle)
                    .font(.headline)
                Text(self.connectionStatusSubtitle)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 18)

            if ControlChannel.shared.state == .connected,
               self.localGatewayFailure == nil,
               let ping = ControlChannel.shared.lastPingMs
            {
                Text(String(format: String(localized: "%lld ms"), Int(ping)))
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(.green.opacity(0.16), in: Capsule())
                    .foregroundStyle(.green)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(.white.opacity(0.06))
        }
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
            return "\(self.controlStatusLine) · \(trimmed)"
        case .unconfigured:
            return "Choose local or remote before the app can attach to a Gateway."
        }
    }

    private var localGatewayFailure: String? {
        self.state.connectionMode == .local ? self.gatewayManager.lastFailureReason : nil
    }

    private var gatewayModeGroup: some View {
        SettingsCardGroup("Gateway") {
            SettingsCardRow(
                title: "OpenClaw runs",
                subtitle: "Pick whether this app owns a local Gateway or attaches to another host.",
                showsDivider: self.state.connectionMode == .unconfigured)
            {
                Picker("Gateway location", selection: self.$state.connectionMode) {
                    Text("Not configured").tag(AppState.ConnectionMode.unconfigured)
                    Text("Local (this Mac)").tag(AppState.ConnectionMode.local)
                    Text("Remote (another host)").tag(AppState.ConnectionMode.remote)
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .frame(width: 260, alignment: .trailing)
            }

            if self.state.connectionMode == .unconfigured {
                SettingsCardRow(
                    title: "Setup needed",
                    subtitle: """
                    Local is best for this Mac. Remote is best when the Gateway already runs on a Mac Studio or server.
                    """,
                    showsDivider: false)
                {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
            }
        }
    }

    private var localGatewayGroup: some View {
        VStack(alignment: .leading, spacing: 20) {
            SettingsCardGroup("Local Gateway") {
                if !self.isNixMode {
                    switch self.gatewayManager.installation {
                    case .managed:
                        self.gatewayInstallerCard
                    case .external:
                        SettingsCardRow(
                            title: "Independently managed Gateway",
                            subtitle: "This app connects without installing or updating its CLI runtime.")
                        {
                            Text(self.gatewayManager.status.label).font(.caption)
                        }
                    case .unreadable:
                        Text(GatewayProcessManager.Installation.ownershipFailure)
                            .foregroundStyle(.orange)
                            .padding(14)
                    }
                }
                self.healthRow
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
            }

            TailscaleIntegrationSection(
                connectionMode: self.state.connectionMode,
                isPaused: self.state.isPaused,
                isActive: self.isActive)
        }
    }

    private var remoteCard: some View {
        VStack(alignment: .leading, spacing: 20) {
            SettingsCardGroup("Remote Access") {
                self.remoteTransportRow

                if self.state.remoteTransport == .ssh {
                    self.remoteSshRow
                } else {
                    self.remoteDirectRow
                }
                self.remoteTokenRow
                GatewayConfigConflictRecoveryView(state: self.state)
            }

            SettingsCardGroup("Discovery & Status") {
                self.remoteDiscoveryRow
                self.remoteStatusRow
                self.controlChannelRow
                self.remoteTipRow
            }

            if self.state.remoteTransport == .ssh {
                self.remoteAdvancedGroup
            }
        }
        .transition(.opacity)
    }

    private var remoteDiscoveryRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Nearby gateways")
                .font(.callout.weight(.medium))
            GatewayDiscoveryInlineList(
                discovery: self.gatewayDiscovery,
                currentTarget: self.state.remoteTarget,
                currentUrl: self.state.remoteUrl,
                transport: self.state.remoteTransport)
            { gateway in
                self.applyDiscoveredGateway(gateway)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .overlay(alignment: .bottom) {
            Divider()
                .padding(.leading, 14)
        }
    }

    @ViewBuilder
    private var remoteStatusRow: some View {
        if self.remoteStatus != .idle {
            SettingsCardRow(title: "Remote test") {
                self.remoteStatusView
            }
        }
    }

    private var controlChannelRow: some View {
        SettingsCardRow(
            title: "Control channel",
            subtitle: self.controlChannelSubtitle.map(SettingsTextValue.verbatim))
        {
            Text(self.controlStatusLine)
                .font(.caption.weight(.semibold))
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(self.connectionStatusTint.opacity(0.16), in: Capsule())
                .foregroundStyle(self.connectionStatusTint)
        }
    }

    private var controlChannelSubtitle: String? {
        var parts: [String] = []
        if let ping = ControlChannel.shared.lastPingMs {
            parts.append("Ping \(Int(ping)) ms")
        }
        if let hb = ControlChannel.shared.lastHeartbeatEvent {
            let ageText = age(from: Date(timeIntervalSince1970: hb.ts / 1000))
            parts.append("Last heartbeat \(hb.status) · \(ageText)")
        }
        if let authLabel = ControlChannel.shared.authSourceLabel {
            parts.append(authLabel)
        }
        return parts.isEmpty ? nil : parts.joined(separator: "\n")
    }

    private var remoteTipRow: some View {
        SettingsCardRow(
            title: "Recommended setup",
            subtitle: self.state.remoteTransport == .ssh
                ? "Use Tailscale plus an SSH tunnel for stable private access."
                : "Use Tailscale Serve so the gateway has a valid HTTPS certificate.",
            showsDivider: false)
        {
            Image(systemName: "lightbulb.fill")
                .foregroundStyle(.yellow)
        }
    }

    private var remoteAdvancedGroup: some View {
        SettingsCardGroup("Advanced") {
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 12) {
                    self.advancedTextField(
                        "Identity file",
                        placeholder: "/Users/you/.ssh/id_ed25519",
                        text: self.$state.remoteIdentity)
                    self.advancedTextField(
                        "Project root",
                        placeholder: "/home/you/Projects/openclaw",
                        text: self.$state.remoteProjectRoot)
                    self.advancedTextField(
                        "CLI path",
                        placeholder: "/Applications/OpenClaw.app/.../openclaw",
                        text: self.$state.remoteCliPath)
                }
                .padding(.top, 10)
            } label: {
                Text("SSH command details")
                    .font(.callout.weight(.medium))
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
        }
    }

    private func advancedTextField(_ title: String, placeholder: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            TextField(placeholder, text: text)
                .textFieldStyle(.roundedBorder)
        }
    }

    private var remoteTransportRow: some View {
        SettingsCardRow(
            title: "Transport",
            subtitle: "SSH keeps the Gateway private; direct is best for HTTPS or Tailscale Serve.")
        {
            Picker("Transport", selection: self.$state.remoteTransport) {
                Text("SSH tunnel").tag(AppState.RemoteTransport.ssh)
                Text("Direct (ws/wss)").tag(AppState.RemoteTransport.direct)
            }
            .pickerStyle(.segmented)
            .frame(width: 320)
        }
    }

    private var remoteSshRow: some View {
        let trimmedTarget = self.state.remoteTarget.trimmingCharacters(in: .whitespacesAndNewlines)
        let validationMessage = CommandResolver.sshTargetValidationMessage(trimmedTarget)
        let canTest = !trimmedTarget.isEmpty && validationMessage == nil

        return VStack(alignment: .leading, spacing: 0) {
            SettingsCardRow(title: "SSH target", subtitle: "User and host for the remote Gateway machine.") {
                TextField("user@host[:22]", text: self.$state.remoteTarget)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: Self.remoteFieldWidth)
                self.remoteTestButton(disabled: !canTest)
            }
            if let validationMessage {
                Text(validationMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 10)
            }
        }
    }

    private var remoteDirectRow: some View {
        SettingsCardRow(title: "Gateway URL", subtitle: "The WebSocket URL exposed by the remote Gateway.") {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    TextField("wss://gateway.example.ts.net", text: self.$state.remoteUrl)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: Self.remoteFieldWidth)
                    self.remoteTestButton(
                        disabled: self.state.remoteUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                Text("Use wss:// for public hosts. ws:// is allowed for localhost, LAN, .local, and Tailnet hosts.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var remoteTokenRow: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsCardRow(
                title: "Gateway token",
                subtitle: "Used when the remote gateway requires token auth.",
                showsDivider: self.state.gatewayConfigConflict != nil)
            {
                SecureField("remote gateway auth token (gateway.remote.token)", text: self.$state.remoteToken)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: Self.remoteSecretFieldWidth)
            }
            if self.state.remoteTokenUnsupported {
                Text(
                    "The current gateway.remote.token value is not plain text. "
                        + "OpenClaw for macOS cannot use it directly; "
                        + "enter a plaintext token here to replace it.")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 10)
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
                Text("Test remote")
            }
        }
        .buttonStyle(.borderedProminent)
        .frame(minWidth: 116)
        .disabled(self.remoteStatus == .checking || disabled)
    }

    private var controlStatusLine: String {
        GatewayConnectionPresentation(state: ControlChannel.shared.state).statusLine
    }

    @ViewBuilder
    private var remoteStatusView: some View {
        switch self.remoteStatus {
        case .idle:
            EmptyView()
        case .checking:
            Text("Testing…")
                .font(.caption)
                .foregroundStyle(.secondary)
        case let .ok(success):
            VStack(alignment: .leading, spacing: 2) {
                Label(success.title, systemImage: "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.green)
                if let detail = success.detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        case let .failed(message):
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
    }

    private var gatewayInstallerCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Circle()
                    .fill(self.gatewayStatusColor)
                    .frame(width: 10, height: 10)
                Text(self.gatewayStatus.message)
                    .font(.callout)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if let gatewayVersion = self.gatewayStatus.gatewayVersion,
               let required = self.gatewayStatus.requiredGateway,
               gatewayVersion != required
            {
                Text(String(
                    format: String(localized: "Installed: %@ · Required: %@"), gatewayVersion, required))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if let gatewayVersion = self.gatewayStatus.gatewayVersion {
                Text(String(format: String(localized: "Gateway %@ detected"), gatewayVersion))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let node = self.gatewayStatus.nodeVersion {
                Text(verbatim: "Node \(node)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if case let .attachedExisting(details) = self.gatewayManager.status {
                Text(details ?? "Using existing gateway instance")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let failure = self.gatewayManager.lastFailureReason {
                Text(String(format: String(localized: "Last failure: %@"), failure))
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            Button("Recheck") { self.refreshGatewayStatus() }
                .buttonStyle(.bordered)

            Text(String(
                format: String(localized: "Gateway auto-starts in local mode via launchd (%@)."),
                gatewayLaunchdLabel))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .padding(12)
        .background(Color.gray.opacity(0.08))
        .cornerRadius(10)
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
}

private enum RemoteStatus: Equatable {
    case idle
    case checking
    case ok(RemoteGatewayProbeSuccess)
    case failed(String)
}

extension ConnectionSettingsView {
    private var healthRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Circle()
                    .fill(self.healthStore.state.tint)
                    .frame(width: 10, height: 10)
                Text(self.healthStore.summaryLine)
                    .font(.callout)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if let detail = self.healthStore.detailLine {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(spacing: 10) {
                Button("Retry now") {
                    Task { await HealthStore.shared.refresh(onDemand: true) }
                }
                .disabled(self.healthStore.isRefreshing)

                Button("Open logs") { self.revealLogs() }
                    .buttonStyle(.link)
                    .foregroundStyle(.secondary)
            }
            .font(.caption)
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
            .frame(width: ConnectionWindow.width, height: ConnectionWindow.height)
            .environment(TailscaleService.shared)
    }
}
#endif
