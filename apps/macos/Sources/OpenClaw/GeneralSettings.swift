import AppKit
import Observation
import OpenClawDiscovery
import OpenClawIPC
import OpenClawKit
import SwiftUI

struct GeneralSettings: View {
    enum Page {
        case general
        case connection
    }

    private static let remoteFieldWidth: CGFloat = 320
    private static let remoteSecretFieldWidth: CGFloat = 300

    @Bindable var state: AppState
    @AppStorage(cameraEnabledKey) private var cameraEnabled: Bool = false
    @AppStorage(computerControlEnabledKey) private var computerControlEnabled: Bool = false
    let page: Page
    let isActive: Bool
    private let healthStore = HealthStore.shared
    private let gatewayManager = GatewayProcessManager.shared
    @State private var gatewayDiscovery = GatewayDiscoveryModel(
        localDisplayName: InstanceIdentity.displayName)
    @State private var gatewayStatus: GatewayEnvironmentStatus = .checking
    @State private var remoteStatus: RemoteStatus = .idle
    @State private var showRemoteAdvanced = false
    private let isPreview = ProcessInfo.processInfo.isPreview
    private var isNixMode: Bool {
        ProcessInfo.processInfo.isNixMode
    }

    init(state: AppState, page: Page = .general, isActive: Bool = true) {
        self.state = state
        self.page = page
        self.isActive = isActive
    }

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 20) {
                switch self.page {
                case .general:
                    self.generalPage
                case .connection:
                    self.connectionPage
                }
            }
            .settingsDetailContent()
        }
        .onAppear {
            self.updateActiveWork(active: self.isActive)
        }
        .onChange(of: self.isActive) { _, active in
            self.updateActiveWork(active: active)
        }
        .onChange(of: self.state.canvasEnabled) { _, enabled in
            if !enabled {
                CanvasManager.shared.hideAll()
            }
        }
        .onDisappear { self.gatewayDiscovery.stop() }
    }

    private var generalPage: some View {
        VStack(alignment: .leading, spacing: 20) {
            SettingsPageHeader(
                title: "General",
                subtitle: "Everyday OpenClaw app behavior.")

            self.openClawStatusPanel

            SettingsCardGroup("App") {
                SettingsCardToggleRow(
                    title: "Launch at login",
                    subtitle: "Automatically start OpenClaw after you sign in.",
                    binding: self.$state.launchAtLogin)

                SettingsCardToggleRow(
                    title: "Show Dock icon",
                    subtitle: "Keep OpenClaw visible in the Dock. When off, windows still show the Dock icon while open.",
                    binding: self.$state.showDockIcon)

                SettingsCardToggleRow(
                    title: "Play menu bar icon animations",
                    subtitle: "Enable idle blinks and wiggles on the status icon.",
                    binding: self.$state.iconAnimationsEnabled,
                    showsDivider: false)
            }

            SettingsCardGroup("Capabilities") {
                SettingsCardToggleRow(
                    title: "Allow Canvas",
                    subtitle: "Allow the agent to show and control the Canvas panel.",
                    binding: self.$state.canvasEnabled)

                SettingsCardToggleRow(
                    title: "Allow Camera",
                    subtitle: "Allow the agent to capture a photo or short video via the built-in camera.",
                    binding: self.$cameraEnabled)

                SettingsCardToggleRow(
                    title: "Allow Computer Control",
                    subtitle: "Let the agent move the pointer, click, and type on this Mac. Requires Accessibility permission and stays disarmed until an operator arms it. High risk.",
                    binding: self.$computerControlEnabled)

                SettingsCardToggleRow(
                    title: "Enable Peekaboo Bridge",
                    subtitle: "Allow signed tools (e.g. `peekaboo`) to drive UI automation via PeekabooBridge.",
                    binding: self.$state.peekabooBridgeEnabled,
                    showsDivider: false)
            }

            SettingsCardGroup("Developer") {
                SettingsCardToggleRow(
                    title: "Enable debug tools",
                    subtitle: "Show the Debug page with development utilities.",
                    binding: self.$state.debugPaneEnabled,
                    showsDivider: false)
            }

            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("App session")
                        .font(.callout.weight(.medium))
                    Text("Quit only when you want to stop the menu bar app completely.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 18)
                Button("Quit") { NSApp.terminate(nil) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
            .padding(.top, 2)
        }
    }

    private var openClawStatusPanel: some View {
        HStack(alignment: .center, spacing: 14) {
            ZStack {
                Circle()
                    .fill(self.state.isPaused ? Color.orange.opacity(0.18) : Color.green.opacity(0.18))
                Image(systemName: self.state.isPaused ? "pause.fill" : "checkmark")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(self.state.isPaused ? .orange : .green)
            }
            .frame(width: 42, height: 42)

            VStack(alignment: .leading, spacing: 4) {
                Text(self.state.isPaused ? "OpenClaw paused" : "OpenClaw active")
                    .font(.headline)
                Text(self.generalStatusSubtitle)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 20)

            Toggle("OpenClaw active", isOn: self.activeBinding)
                .labelsHidden()
                .toggleStyle(.switch)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(.white.opacity(0.06))
        }
    }

    private var generalStatusSubtitle: String {
        if self.state.isPaused {
            return "Gateway work is paused; incoming messages will wait."
        }
        switch self.state.connectionMode {
        case .local:
            return "Processing messages through the local Gateway on this Mac."
        case .remote:
            return "Connected to a remote Gateway configuration."
        case .unconfigured:
            return "Ready to run after you choose a Gateway connection."
        }
    }

    private var connectionPage: some View {
        VStack(alignment: .leading, spacing: 20) {
            SettingsPageHeader(
                title: "Connection",
                subtitle: "Choose where the Gateway runs and how this Mac app reaches it.")

            self.connectionStatusPanel
            self.gatewayModeGroup

            switch self.state.connectionMode {
            case .unconfigured:
                EmptyView()
            case .local:
                self.localGatewayGroup
            case .remote:
                self.remoteCard
            }
        }
    }

    private var activeBinding: Binding<Bool> {
        Binding(
            get: { !self.state.isPaused },
            set: { self.state.isPaused = !$0 })
    }

    private func updateActiveWork(active: Bool) {
        guard !self.isPreview else { return }
        if active {
            self.refreshGatewayStatus()
            if self.page == .connection {
                self.gatewayDiscovery.start()
            }
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

            if let ping = ControlChannel.shared.lastPingMs {
                Text("\(Int(ping)) ms")
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
        switch ControlChannel.shared.state {
        case .connected: .green
        case .connecting, .disconnected, .degraded: .orange
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
        switch self.state.connectionMode {
        case .local:
            return "OpenClaw starts and monitors the Gateway on this Mac."
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
                    subtitle: "Local is best for this Mac. Remote is best when the Gateway already runs on a Mac Studio or server.",
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
                    self.gatewayInstallerCard
                }
                self.healthRow
                    .padding(.horizontal, 14)
                    .padding(.vertical, 11)
            }

            TailscaleIntegrationSection(
                connectionMode: self.state.connectionMode,
                isPaused: self.state.isPaused)
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
        SettingsCardRow(title: "Control channel", subtitle: self.controlChannelSubtitle) {
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
        if let hb = HeartbeatStore.shared.lastEvent {
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
            DisclosureGroup(isExpanded: self.$showRemoteAdvanced) {
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
                showsDivider: false)
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
        switch ControlChannel.shared.state {
        case .connected: "Connected"
        case .connecting: "Connecting…"
        case .disconnected: "Disconnected"
        case let .degraded(msg): msg
        }
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
                Text("Installed: \(gatewayVersion) · Required: \(required)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if let gatewayVersion = self.gatewayStatus.gatewayVersion {
                Text("Gateway \(gatewayVersion) detected")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let node = self.gatewayStatus.nodeVersion {
                Text("Node \(node)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if case let .attachedExisting(details) = self.gatewayManager.status {
                Text(details ?? "Using existing gateway instance")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let failure = self.gatewayManager.lastFailureReason {
                Text("Last failure: \(failure)")
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            Button("Recheck") { self.refreshGatewayStatus() }
                .buttonStyle(.bordered)

            Text("Gateway auto-starts in local mode via launchd (\(gatewayLaunchdLabel)).")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .padding(12)
        .background(Color.gray.opacity(0.08))
        .cornerRadius(10)
    }

    private func refreshGatewayStatus() {
        Task {
            let status = await Task.detached(priority: .utility) {
                GatewayEnvironment.check()
            }.value
            self.gatewayStatus = status
        }
    }

    private var gatewayStatusColor: Color {
        switch self.gatewayStatus.kind {
        case .ok: .green
        case .checking: .secondary
        case .missingNode, .missingGateway, .incompatible, .error: .orange
        }
    }
}

private enum RemoteStatus: Equatable {
    case idle
    case checking
    case ok(RemoteGatewayProbeSuccess)
    case failed(String)
}

extension GeneralSettings {
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
        MacNodeModeCoordinator.shared.setPreferredGatewayStableID(gateway.stableID)
        GatewayDiscoverySelectionSupport.applyRemoteSelection(gateway: gateway, state: self.state)
    }
}

#if DEBUG
struct GeneralSettings_Previews: PreviewProvider {
    static var previews: some View {
        GeneralSettings(state: .preview)
            .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
            .environment(TailscaleService.shared)
    }
}

@MainActor
extension GeneralSettings {
    static func exerciseForTesting() {
        let state = AppState(preview: true)
        state.connectionMode = .remote
        state.remoteTransport = .ssh
        state.remoteTarget = "user@host:2222"
        state.remoteUrl = "wss://gateway.example.ts.net"
        state.remoteToken = "example-token"
        state.remoteIdentity = "/tmp/id_ed25519"
        state.remoteProjectRoot = "/tmp/openclaw"
        state.remoteCliPath = "/tmp/openclaw"

        let view = GeneralSettings(state: state)
        view.gatewayStatus = GatewayEnvironmentStatus(
            kind: .ok,
            nodeVersion: "1.0.0",
            gatewayVersion: "1.0.0",
            requiredGateway: nil,
            message: "Gateway ready")
        view.remoteStatus = .failed("SSH failed")
        view.showRemoteAdvanced = true
        _ = view.body

        state.connectionMode = .unconfigured
        _ = view.body

        state.connectionMode = .local
        view.gatewayStatus = GatewayEnvironmentStatus(
            kind: .error("Gateway offline"),
            nodeVersion: nil,
            gatewayVersion: nil,
            requiredGateway: nil,
            message: "Gateway offline")
        _ = view.body
    }
}
#endif
